import { describe, expect, it } from "vitest";
import { enqueueDue, latestSlot, seedSchedules, slotKey } from "../src/schedule.ts";
import { OPERATOR_SCHEDULES } from "../src/index.ts";
import { claimsLint, nextWindow, planFromBrief, policyFor, type Publisher } from "../src/handlers/content.ts";
import { runway, profileFeed } from "../src/handlers/pinterest.ts";
import { auditPage } from "../src/handlers/seo.ts";
import { previousWeek } from "../src/handlers/summary.ts";
import { boundedJsonCall, costCents, extractJson, type LlmProvider } from "../src/llm.ts";
import { isProbeError, type Fetcher } from "../src/lib.ts";
import { brief, fakeFetcher, handlersWith, healthySites, makeEnv, page, run } from "./helpers.ts";
import { enqueue, tick } from "../../../services/api/src/orchestration/engine.ts";

const PAST = "2000-01-01T00:00:00.000Z";
const T = (s: string) => new Date(s);
const q = async <R = Record<string, any>>(db: D1Database, sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).all<R>()).results;

describe("schedules", () => {
  it("computes the latest slot for every spec type", () => {
    const now = T("2026-11-10T03:07:00Z"); // a Tuesday
    expect(slotKey(latestSlot({ every: 60 }, now))).toBe("2026-11-10T03:00Z");
    expect(slotKey(latestSlot({ every: 360 }, now))).toBe("2026-11-10T00:00Z");
    expect(slotKey(latestSlot({ daily: "08:00" }, now))).toBe("2026-11-09T08:00Z");
    expect(slotKey(latestSlot({ daily: "03:00" }, now))).toBe("2026-11-10T03:00Z");
    expect(slotKey(latestSlot({ weekly: { day: 1, at: "12:00" } }, now))).toBe("2026-11-09T12:00Z");
    expect(slotKey(latestSlot({ weekly: { day: 2, at: "04:00" } }, now))).toBe("2026-11-03T04:00Z");
    expect(slotKey(latestSlot({ monthly: { day: 1, at: "14:17" } }, now))).toBe("2026-11-01T14:17Z");
    expect(slotKey(latestSlot({ monthly: { day: 31, at: "00:00" } }, T("2026-11-15T00:00:00Z")))).toBe("2026-10-31T00:00Z");
    expect(slotKey(latestSlot({ monthly: { day: 31, at: "00:00" } }, T("2026-12-01T00:00:00Z")))).toBe("2026-11-30T00:00Z");
    expect(() => latestSlot({ every: 5 }, now)).toThrow();
    expect(() => latestSlot({ daily: "25:00" }, now)).toThrow();
  });

  it("enqueues each slot exactly once, skips disabled schedules, and never back-fills an outage", async () => {
    const { db } = await makeEnv();
    const h = handlersWith({ fetcher: fakeFetcher({}) });
    await seedSchedules(db, OPERATOR_SCHEDULES);
    const first = await enqueueDue(db, h, T("2026-11-10T03:07:00Z"));
    expect(first.map((x) => x.scheduleId).sort()).toEqual(OPERATOR_SCHEDULES.map((s) => s.id).sort());
    expect(await enqueueDue(db, h, T("2026-11-10T03:22:00Z"))).toEqual([]);          // same slots
    const next = await enqueueDue(db, h, T("2026-11-10T04:01:00Z"));
    expect(next.map((x) => x.scheduleId)).toEqual(["OPS-SITE-HEALTH"]);
    await db.prepare(`UPDATE op_schedules SET enabled=0 WHERE id='OPS-SITE-HEALTH'`).run();
    expect(await enqueueDue(db, h, T("2026-11-10T05:01:00Z"))).toEqual([]);
    // three days of downtime: one job per schedule for the latest slot, not 72 hourly jobs
    await db.prepare(`UPDATE op_schedules SET enabled=1`).run();
    const after = await enqueueDue(db, h, T("2026-11-13T05:01:00Z"));
    expect(after.filter((x) => x.scheduleId === "OPS-SITE-HEALTH")).toHaveLength(1);
    // re-seeding from git does not re-enable a runtime-disabled schedule
    await db.prepare(`UPDATE op_schedules SET enabled=0 WHERE id='OPS-SEO-AUDIT'`).run();
    await seedSchedules(db, OPERATOR_SCHEDULES);
    expect((await q(db, `SELECT enabled FROM op_schedules WHERE id='OPS-SEO-AUDIT'`))[0]!.enabled).toBe(0);
  });
});

describe("site health", () => {
  const LIMIT = "Too many subrequests by single Worker invocation";
  it("classifies Worker runtime and limit errors as probe errors, not site failures (QA-008)", () => {
    expect(isProbeError(LIMIT)).toBe(true);
    expect(isProbeError("Worker exceeded CPU time limit.")).toBe(true);
    expect(isProbeError("The operation was aborted due to timeout")).toBe(false);
    expect(isProbeError("getaddrinfo ENOTFOUND bidline.pages.dev")).toBe(false);
    expect(isProbeError("TypeError: fetch failed")).toBe(false); // real outages (DNS, TLS, refused) stay failures
    expect(isProbeError("Network connection lost.")).toBe(false);
  });

  it("records UNKNOWN and raises no alert when FORGE itself cannot make the request (QA-008)", async () => {
    const { env, db } = await makeEnv();
    await db.prepare(`INSERT INTO alerts (id,severity,source,title,state,dedupe_key,first_seen,last_seen) VALUES ('al_x','critical','ops.site_health','Bidline home check failing','open','ops:health:https://bidline.pages.dev/','2026-11-10T03:45:00Z','2026-11-10T03:45:00Z')`).run();
    const f = Object.assign(async () => ({ ok: false, status: null, text: "", latencyMs: 1, error: LIMIT, probeError: true }), { calls: [] as string[] }) as unknown as Fetcher;
    let calls = 0; const counting: Fetcher = async (u, o) => { calls++; return f(u, o); };
    const h = handlersWith({ fetcher: counting });
    await enqueue(db, h, { runAt: PAST, kind: "ops.site_health", createdBy: "t" });
    expect((await run(env, h))[0]!.outcome).toBe("succeeded");
    const checks = await q(db, `SELECT ok, findings_json FROM op_checks WHERE check_kind='site_health'`);
    expect(checks).toHaveLength(11);
    expect(checks.every((c) => c.ok === null && c.findings_json.includes("checker_error"))).toBe(true);
    expect(calls).toBe(1); // stops after the first runtime error instead of burning more subrequests
    expect(await q(db, `SELECT * FROM alerts WHERE source='ops.site_health' AND dedupe_key<>'ops:health:https://bidline.pages.dev/'`)).toHaveLength(0);
    expect((await q(db, `SELECT state FROM alerts WHERE id='al_x'`))[0]!.state).toBe("open"); // unknown neither raises nor clears
  });

  it("warns when a target has been unknown for 3 runs in a row, and clears it on a real answer (QA-008 O1)", async () => {
    const { env, db } = await makeEnv();
    const limited: Fetcher = async () => ({ ok: false, status: null, text: "", latencyMs: 1, error: LIMIT, probeError: true });
    const h = handlersWith({ fetcher: limited });
    for (let i = 0; i < 3; i++) { await enqueue(db, h, { runAt: PAST, kind: "ops.site_health", createdBy: `t${i}` }); await run(env, h); }
    const open = await q(db, `SELECT severity FROM alerts WHERE dedupe_key LIKE 'ops:health:unknown:%' AND state='open'`);
    expect(open).toHaveLength(11);
    expect(open.every((a) => a.severity === "warning")).toBe(true);
    const ok = handlersWith({ fetcher: fakeFetcher(healthySites()) });
    await enqueue(db, ok, { runAt: PAST, kind: "ops.site_health", createdBy: "t-ok" }); await run(env, ok);
    expect(await q(db, `SELECT * FROM alerts WHERE dedupe_key LIKE 'ops:health:unknown:%' AND state='open'`)).toHaveLength(0);
  });

  it("re-checks a failure once before alerting, so a single dropped request raises nothing", async () => {
    const { env, db } = await makeEnv();
    const healthy = fakeFetcher(healthySites()); let first = true;
    const flaky: Fetcher = async (u, o) => { if (u === "https://bidline.pages.dev/" && first) { first = false; return { ok: false, status: 503, text: "", latencyMs: 5 }; } return healthy(u, o); };
    const h = handlersWith({ fetcher: flaky });
    await enqueue(db, h, { runAt: PAST, kind: "ops.site_health", createdBy: "t" });
    await run(env, h);
    expect(await q(db, `SELECT * FROM alerts WHERE source='ops.site_health'`)).toHaveLength(0);
    expect((await q(db, `SELECT ok FROM op_checks WHERE target='https://bidline.pages.dev/'`))[0]!.ok).toBe(1);
  });

  it("caps fetches per run and records the rest as unknown", async () => {
    const { env, db } = await makeEnv();
    const f = fakeFetcher(healthySites());
    const h = handlersWith({ fetcher: f });
    await enqueue(db, h, { runAt: PAST, kind: "ops.site_health", createdBy: "t", input: { maxFetches: 4 } });
    await run(env, h);
    expect(f.calls).toHaveLength(4);
    expect(await q(db, `SELECT * FROM op_checks WHERE check_kind='site_health' AND ok IS NULL`)).toHaveLength(7);
  });

  it("records checks and a FORGE run when everything is up", async () => {
    const { env, db } = await makeEnv();
    const f = fakeFetcher(healthySites());
    const h = handlersWith({ fetcher: f });
    await enqueue(db, h, { runAt: PAST, kind: "ops.site_health", createdBy: "test" });
    expect((await run(env, h))[0]!.outcome).toBe("succeeded");
    const checks = await q(db, `SELECT ok FROM op_checks WHERE check_kind='site_health'`);
    expect(checks.length).toBe(11);
    expect(checks.every((c) => c.ok === 1)).toBe(true);
    expect(await q(db, `SELECT * FROM alerts WHERE source='ops.site_health'`)).toHaveLength(0);
    const runs = await q(db, `SELECT status, source FROM runs WHERE registry_id='OPS-SITE-HEALTH'`);
    expect(runs).toEqual([{ status: "success", source: "forge" }]);
  });

  it("raises a critical alert for a down home page and resolves it on recovery", async () => {
    const { env, db } = await makeEnv();
    const down = handlersWith({ fetcher: fakeFetcher(healthySites({ "https://bidline.pages.dev/": { ok: false, status: 503, text: "" } })) });
    await enqueue(db, down, { runAt: PAST, kind: "ops.site_health", createdBy: "test" });
    await run(env, down);
    const [a] = await q(db, `SELECT severity, state, title FROM alerts WHERE dedupe_key='ops:health:https://bidline.pages.dev/'`);
    expect(a).toMatchObject({ severity: "critical", state: "open" });
    const up = handlersWith({ fetcher: fakeFetcher(healthySites()) });
    await enqueue(db, up, { runAt: PAST, kind: "ops.site_health", createdBy: "test2" });
    await run(env, up);
    expect((await q(db, `SELECT state FROM alerts WHERE dedupe_key='ops:health:https://bidline.pages.dev/'`))[0]!.state).toBe("resolved");
  });

  it("flags error pages that return 200 and missing brand text", async () => {
    const { env, db } = await makeEnv();
    const h = handlersWith({ fetcher: fakeFetcher(healthySites({ "https://loaf-ledger.pages.dev/": "<html>Error 1101 Worker threw exception</html>" })) });
    await enqueue(db, h, { runAt: PAST, kind: "ops.site_health", createdBy: "test" });
    await run(env, h);
    const [c] = await q(db, `SELECT ok, findings_json FROM op_checks WHERE target='https://loaf-ledger.pages.dev/'`);
    expect(c!.ok).toBe(0);
    expect(JSON.parse(c!.findings_json).map((x: any) => x.code).sort()).toEqual(["content_error", "content_missing"]);
  });
});

describe("Pinterest runway and receipts", () => {
  const queue = (dates: string[]) => JSON.stringify(dates.map((d, i) => ({ slug: `p${i}`, publish: d })));
  it("computes runway", () => {
    const r = runway([{ publish: "2026-11-11T19:00:00Z" }, { publish: "2026-11-12T19:00:00Z" }, { publish: "bad" }], T("2026-11-10T03:00:00Z"));
    expect(r).toMatchObject({ future: 2, days: 2, lastPublish: "2026-11-12T19:00:00.000Z" });
    expect(profileFeed("https://www.pinterest.com/quiltplankit/")).toBe("https://www.pinterest.com/quiltplankit/feed.rss");
    expect(profileFeed("https://evil.example/pinterest.com/x")).toBeNull();
  });

  it("warns when the queue is about to end and says Pinterest publication is unverifiable without a profile URL", async () => {
    const { env, db } = await makeEnv();
    const h = handlersWith({ fetcher: fakeFetcher(healthySites({ "https://quiltplankit.pages.dev/pins.json": queue(["2026-11-08T19:00:00Z", "2026-11-11T19:00:00Z", "2026-11-12T19:00:00Z"]) })) });
    await enqueue(db, h, { runAt: PAST, kind: "ops.pin_runway", createdBy: "t", input: {} });
    const now = T("2026-11-10T03:00:00Z");
    await run(env, h, now);
    const [a] = await q(db, `SELECT severity, title FROM alerts WHERE dedupe_key='ops:pins:runway:ch_qpk_pinterest'`);
    expect(a!.severity).toBe("warning");
    expect(a!.title).toContain("runs out in 2 day");
    const job = (await q(db, `SELECT output_json FROM jobs WHERE kind='ops.pin_runway'`))[0]!;
    const out = JSON.parse(job.output_json).check;
    expect(out.platform.state).toBe("unconnected");
    expect((await q(db, `SELECT source FROM op_publications`)).map((x) => x.source)).toEqual(["site_feed"]);
  });

  it("reads the queue from /pins/pins.json, where the site worker serves it", async () => {
    const { env, db } = await makeEnv();
    const h = handlersWith({ fetcher: fakeFetcher(healthySites({ "https://quiltplankit.pages.dev/pins/pins.json": queue(["2026-11-12T19:00:00Z", "2026-12-13T19:00:00Z"]) })) });
    await enqueue(db, h, { runAt: PAST, kind: "ops.pin_runway", createdBy: "t", input: {} });
    await run(env, h, T("2026-11-10T03:00:00Z"));
    const out = JSON.parse((await q(db, `SELECT output_json FROM jobs WHERE kind='ops.pin_runway'`))[0]!.output_json).check;
    expect(out.runway).toMatchObject({ state: "known", future: 2 });
    expect(await q(db, `SELECT 1 FROM alerts WHERE dedupe_key='ops:pins:runway:ch_qpk_pinterest' AND state='open'`)).toHaveLength(0);
  });

  it("goes critical on an empty queue and unknown (not fine) when the queue cannot be read", async () => {
    const { env, db } = await makeEnv();
    let h = handlersWith({ fetcher: fakeFetcher(healthySites({ "https://quiltplankit.pages.dev/pins.json": queue(["2026-11-01T19:00:00Z"]) })) });
    await enqueue(db, h, { runAt: PAST, kind: "ops.pin_runway", createdBy: "a" });
    await run(env, h, T("2026-11-13T00:00:00Z"));
    expect((await q(db, `SELECT severity FROM alerts WHERE dedupe_key='ops:pins:runway:ch_qpk_pinterest'`))[0]!.severity).toBe("critical");
    h = handlersWith({ fetcher: fakeFetcher(healthySites()) });
    await enqueue(db, h, { runAt: PAST, kind: "ops.pin_runway", createdBy: "b" });
    await run(env, h, T("2026-11-13T06:00:00Z"));
    const [a] = await q(db, `SELECT severity, title FROM alerts WHERE dedupe_key='ops:pins:runway:ch_qpk_pinterest'`);
    expect(a).toMatchObject({ severity: "info" });
    expect(a!.title).toContain("unknown");
  });

  it("verifies the channel only from the platform's own feed", async () => {
    const { env, db } = await makeEnv();
    await db.prepare(`UPDATE channels SET account_url='https://www.pinterest.com/quiltplankit/' WHERE id='ch_qpk_pinterest'`).run();
    const feed = `<rss><channel><item><title>HST chart</title><link>https://www.pinterest.com/pin/123/</link><pubDate>Mon, 09 Nov 2026 19:05:00 GMT</pubDate></item></channel></rss>`;
    const h = handlersWith({ fetcher: fakeFetcher(healthySites({ "https://quiltplankit.pages.dev/pins.json": queue(["2026-11-30T19:00:00Z"]), "https://www.pinterest.com/quiltplankit/feed.rss": feed })) });
    await enqueue(db, h, { runAt: PAST, kind: "ops.pin_runway", createdBy: "t" });
    await run(env, h, T("2026-11-10T03:00:00Z"));
    const [ch] = await q(db, `SELECT status, last_verified_url FROM channels WHERE id='ch_qpk_pinterest'`);
    expect(ch).toEqual({ status: "verified", last_verified_url: "https://www.pinterest.com/pin/123/" });
    expect((await q(db, `SELECT label FROM evidence WHERE subject_id='ch_qpk_pinterest' AND collected_by='ops.pin_runway'`))[0]!.label).toBe("VERIFIED");
    expect(await q(db, `SELECT * FROM alerts WHERE dedupe_key LIKE 'ops:pins:%' AND state='open'`)).toHaveLength(0);
    // ten days later with no new pin: no longer "verified"
    await enqueue(db, h, { runAt: PAST, kind: "ops.pin_runway", createdBy: "t2" });
    await run(env, h, T("2026-11-19T12:00:00Z"));
    expect((await q(db, `SELECT status FROM channels WHERE id='ch_qpk_pinterest'`))[0]!.status).toBe("running");
  });

  it("drops a verified channel to running when the profile feed cannot be read", async () => {
    const { env, db } = await makeEnv();
    await db.prepare(`UPDATE channels SET account_url='https://www.pinterest.com/quiltplankit/' WHERE id='ch_qpk_pinterest'`).run();
    expect((await q(db, `SELECT status FROM channels WHERE id='ch_qpk_pinterest'`))[0]!.status).toBe("verified");
    const h = handlersWith({ fetcher: fakeFetcher(healthySites({ "https://www.pinterest.com/quiltplankit/feed.rss": { ok: false, status: 503 } })) });
    await enqueue(db, h, { runAt: PAST, kind: "ops.pin_runway", createdBy: "t" });
    await run(env, h, T("2026-11-10T03:00:00Z"));
    expect((await q(db, `SELECT status FROM channels WHERE id='ch_qpk_pinterest'`))[0]!.status).toBe("running");
    expect(await q(db, `SELECT * FROM alerts WHERE dedupe_key='ops:pins:stale:ch_qpk_pinterest' AND state='open'`)).toHaveLength(1);
  });
});

describe("SEO audit", () => {
  it("finds page-level issues", () => {
    const f = auditPage("https://x.dev/a", page({ title: "A", h1: false }), "https://x.dev").map((x) => x.code).sort();
    expect(f).toEqual(["canonical_missing", "description_missing", "h1_missing"]);
    expect(auditPage("https://x.dev/a", page({ title: "A", desc: "d", canonical: "https://other.dev/a" }), "https://x.dev").map((x) => x.code)).toEqual(["canonical_mismatch"]);
  });

  it("crawls the sitemap and alerts on broken pages", async () => {
    const { env, db } = await makeEnv();
    const base = "https://quiltplankit.pages.dev";
    const f = fakeFetcher(healthySites({
      [`${base}/sitemap.xml`]: `<urlset><url><loc>${base}/</loc></url><url><loc>${base}/gone</loc></url><url><loc>${base}/thin</loc></url></urlset>`,
      [`${base}/thin`]: page({ title: "Thin" }),
    }));
    const h = handlersWith({ fetcher: f });
    await enqueue(db, h, { runAt: PAST, kind: "ops.seo_audit", createdBy: "t", input: { nicheId: "quilt-plan-kit", batchSize: 2 } });
    // One job per tick, as on the CPU-limited cron: planner, then 2 batches, then finalize.
    const one = () => tick(env.DB, env, h, { workerId: "test", now: new Date(), maxJobs: 1 });
    await one();
    const kids = await q(db, `SELECT kind, status FROM jobs WHERE kind IN ('ops.seo_batch','ops.seo_finalize') ORDER BY kind`);
    expect(kids.map((k) => k.kind)).toEqual(["ops.seo_batch", "ops.seo_batch", "ops.seo_finalize"]);
    await one(); await one();
    expect((await q(db, `SELECT status FROM jobs WHERE kind='ops.seo_finalize'`))[0]!.status).not.toBe("succeeded");
    expect(await q(db, `SELECT * FROM alerts WHERE dedupe_key='ops:seo:quilt-plan-kit'`)).toHaveLength(0);
    await one();
    expect((await q(db, `SELECT status FROM jobs WHERE kind='ops.seo_finalize'`))[0]!.status).toBe("succeeded");
    const pages = await q(db, `SELECT target, ok, status_code FROM op_checks WHERE check_kind='seo_page' ORDER BY target`);
    expect(f.calls.filter((u) => u === `${base}/gone`)).toHaveLength(2); // a broken page is re-checked once
    expect(pages.map((p) => [p.target.replace(base, ""), p.ok])).toEqual([["/", 1], ["/gone", 0], ["/thin", 0]]);
    const [a] = await q(db, `SELECT severity, title FROM alerts WHERE dedupe_key='ops:seo:quilt-plan-kit'`);
    expect(a!.severity).toBe("critical");
    expect(a!.title).toContain("1 broken page");
  });

  it("fans the weekly crawl out to one planner per niche", async () => {
    const { env, db } = await makeEnv();
    const f = fakeFetcher(healthySites());
    const h = handlersWith({ fetcher: f });
    await enqueue(db, h, { runAt: PAST, kind: "ops.seo_audit", createdBy: "t", input: { maxPages: 60 } });
    await tick(env.DB, env, h, { workerId: "t", now: new Date(), maxJobs: 1 });
    expect(f.calls).toHaveLength(0); // the top-level planner fetches nothing
    expect((await q(db, `SELECT niche_id FROM jobs WHERE kind='ops.seo_audit' AND niche_id IS NOT NULL ORDER BY niche_id`)).map((r) => r.niche_id)).toEqual(["bidline", "loaf-ledger", "quilt-plan-kit"]);
    await run(env, h); await run(env, h); await run(env, h);
    expect(await q(db, `SELECT * FROM alerts WHERE source='ops.seo_audit' AND state='open'`)).toHaveLength(0);
    expect((await q(db, `SELECT COUNT(*) AS n FROM jobs WHERE kind='ops.seo_finalize' AND status='succeeded'`))[0]!.n).toBe(3);
  });

  it("does not call pages broken when the crawler hits a runtime limit", async () => {
    const { env, db } = await makeEnv();
    const base = "https://quiltplankit.pages.dev";
    const healthy = fakeFetcher(healthySites({ [`${base}/sitemap.xml`]: `<urlset><url><loc>${base}/</loc></url><url><loc>${base}/a</loc></url></urlset>` }));
    const limited: Fetcher = async (u, o) => (u === `${base}/` ? { ok: false, status: null, text: "", latencyMs: 1, error: "Too many subrequests by single Worker invocation", probeError: true } : healthy(u, o));
    const h = handlersWith({ fetcher: limited });
    await enqueue(db, h, { runAt: PAST, kind: "ops.seo_audit", createdBy: "t", input: { nicheId: "quilt-plan-kit" } });
    await run(env, h); await run(env, h); await run(env, h);
    expect(await q(db, `SELECT * FROM alerts WHERE dedupe_key='ops:seo:quilt-plan-kit' AND state='open'`)).toHaveLength(0);
    const out = JSON.parse((await q(db, `SELECT output_json FROM jobs WHERE kind='ops.seo_finalize'`))[0]!.output_json).summarize;
    expect(out).toMatchObject({ broken: 0, unknown: 2 });
  });
});

describe("content planning from the briefs", () => {
  it("computes seasonal windows across year boundaries", () => {
    const now = T("2026-11-10T00:00:00Z");
    const ny = nextWindow({ demand_window: "12-15/02-15", publish_by: "12-01" }, now);
    expect([ny.start, ny.end, ny.publishBy].map((d) => d.toISOString().slice(0, 10))).toEqual(["2026-12-15", "2027-02-15", "2026-12-01"]);
    const xmas = nextWindow({ demand_window: "09-01/12-15", publish_by: "08-15" }, now);
    expect(xmas.publishBy.toISOString().slice(0, 10)).toBe("2026-08-15");
    const spring = nextWindow({ demand_window: "03-01/03-31", publish_by: "02-15" }, now);
    expect(spring.start.toISOString().slice(0, 10)).toBe("2027-03-01");
  });

  it("plans only automatable channels the brief rates strong or moderate, flags late items", () => {
    const items = planFromBrief(brief("quilt-plan-kit"), T("2026-11-10T00:00:00Z"));
    expect(new Set(items.map((i) => i.platform))).toEqual(new Set(["pinterest", "seo", "email"])); // no Facebook groups
    const late = items.filter((i) => i.late);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((i) => i.event.startsWith("Christmas"))).toBe(true);
    expect(items.every((i) => i.evidence === "INFERRED")).toBe(true);
    const bid = planFromBrief(brief("bidline"), T("2026-11-10T00:00:00Z"));
    expect(bid.some((i) => i.platform === "pinterest")).toBe(false); // brief rates Pinterest weak for contractors
  });

  it("writes items idempotently and links existing channels", async () => {
    const { env, db } = await makeEnv();
    const h = handlersWith({ fetcher: fakeFetcher({}) });
    const briefs = [brief("quilt-plan-kit"), brief("bidline"), brief("loaf-ledger")];
    await enqueue(db, h, { runAt: PAST, kind: "ops.content_plan", createdBy: "a", input: { briefs } });
    await run(env, h, T("2026-11-10T00:00:00Z"));
    const n1 = (await q(db, `SELECT COUNT(*) AS n FROM op_content_items`))[0]!.n;
    expect(n1).toBeGreaterThan(5);
    await enqueue(db, h, { runAt: PAST, kind: "ops.content_plan", createdBy: "b", input: { briefs } });
    await run(env, h, T("2026-11-10T00:00:00Z"));
    expect((await q(db, `SELECT COUNT(*) AS n FROM op_content_items`))[0]!.n).toBe(n1);
    const pin = await q(db, `SELECT channel_id FROM op_content_items WHERE niche_id='quilt-plan-kit' AND platform='pinterest' LIMIT 1`);
    expect(pin[0]!.channel_id).toBe("ch_qpk_pinterest");
  });
});

describe("bounded model step and claims lint", () => {
  it("lints unsupported claims", () => {
    expect(claimsLint("Join 5,000 quilters who love it")).toContain("unsupported customer count");
    expect(claimsLint("Guaranteed to save you time")).toContain("guarantee claim");
    expect(claimsLint("Customers say it's the best")).toContain("rating or review FORGE cannot verify");
    expect(claimsLint("Work out how much binding fabric to buy before you cut.")).toEqual([]);
    expect(costCents("claude-opus-5-5", 1_000_000, 0)).toBe(400);
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("blocks every phrase QA-005 V2 got through, and allows real prices and measurements", () => {
    const bad = [
      "Loved by quilters everywhere", "Trusted by contractors", "4.9★ from our buyers", "★★★★★",
      "\u201cSaved my business\u201d \u2014 Mike R., roofer", "raise margins 23%", "Make an extra $1,000 a month",
      "The best estimating spreadsheet", "100% satisfaction or your money back",
    ];
    bad.push("Quilters can't stop raving", "Bakers swear by it", "5-star rated", "It pays for itself", "Over a thousand downloads",
      "Cut your quoting time in half", "10 times faster than pen and paper", "'Game changer' - Sarah");
    for (const b of bad) expect(claimsLint(b), b).not.toEqual([]);
    expect(claimsLint("Skipping the seam allowance, leading to short borders, is the most common mistake.")).toEqual([]);
    expect(claimsLint("The kit is $19.99 and includes a markup sheet.", [1999])).toEqual([]);
    expect(claimsLint("The kit is $9.99 today.", [1999])).toEqual(["price $9.99 is not a current product price"]);
    expect(claimsLint("Cut 2 1/2 in strips; a 60 x 72 in quilt needs 7 strips.")).toEqual([]);
  });

  const fake = (outs: string[]): LlmProvider & { prompts: string[] } => {
    const prompts: string[] = []; let i = 0;
    return { id: "fake", model: "claude-opus-5-5", prompts, async complete(r) { prompts.push(r.prompt); return { text: outs[Math.min(i++, outs.length - 1)]!, inputTokens: 1000, outputTokens: 200, costCents: 0.8 }; } };
  };
  const good = JSON.stringify({ headline: "How much binding do you need?", body: "Measure once, cut once. Enter your quilt size and get strips and yardage.", cta: "Open the free calculator", linkPath: "/calculators/binding" });
  const bad = JSON.stringify({ headline: "The #1 binding calculator", body: "Thousands of quilters trust it.", cta: "Go", linkPath: "/calculators/binding" });

  it("retries once with the validation error, records every attempt", async () => {
    const { db } = await makeEnv();
    const p = fake([bad, good]);
    const { draftValidator } = await import("../src/handlers/content.ts");
    const r = await boundedJsonCall(db, p, { purpose: "t", system: "s", prompt: "p", validate: draftValidator("pinterest"), costCapCents: 10 });
    expect(r.ok).toBe(true);
    expect(p.prompts[1]).toContain("rejected");
    const calls = await q(db, `SELECT attempt, valid FROM op_llm_calls ORDER BY attempt`);
    expect(calls).toEqual([{ attempt: 1, valid: 0 }, { attempt: 2, valid: 1 }]);
    expect(await boundedJsonCall(db, null, { purpose: "t", system: "s", prompt: "p", validate: draftValidator("pinterest"), costCapCents: 10 })).toMatchObject({ ok: false, reason: "no_provider" });
  });

  it("drafts planned items, leaves them visibly planned without a provider, and sends bad copy to revision", async () => {
    const { env, db } = await makeEnv();
    const plan = handlersWith({ fetcher: fakeFetcher({}) });
    await enqueue(db, plan, { runAt: PAST, kind: "ops.content_plan", createdBy: "a", input: { briefs: [brief("quilt-plan-kit")] } });
    await run(env, plan, T("2026-11-10T00:00:00Z"));
    // briefs must be in the DB for drafting
    await db.prepare(`INSERT INTO market_briefs (id,niche_id,version,schema_version,status,content_json,content_hash,created_at) VALUES ('b1','quilt-plan-kit','1.0.1','1.0','draft',?, 'h', ?)`).bind(JSON.stringify(brief("quilt-plan-kit")), new Date().toISOString()).run();
    const none = handlersWith({ fetcher: fakeFetcher({}), provider: () => null });
    await enqueue(db, none, { runAt: PAST, kind: "ops.content_draft", createdBy: "b", input: { limit: 2 } });
    await run(env, none);
    expect((await q(db, `SELECT COUNT(*) AS n FROM op_content_items WHERE status='drafted'`))[0]!.n).toBe(0);
    const h = handlersWith({ fetcher: fakeFetcher({}), provider: () => fake([good]) });
    await enqueue(db, h, { runAt: PAST, kind: "ops.content_draft", createdBy: "c", input: { limit: 2 } });
    await run(env, h);
    expect((await q(db, `SELECT COUNT(*) AS n FROM op_content_items WHERE status='drafted'`))[0]!.n).toBe(2);
    const hb = handlersWith({ fetcher: fakeFetcher({}), provider: () => fake([bad]) });
    await enqueue(db, hb, { runAt: PAST, kind: "ops.content_draft", createdBy: "d", input: { limit: 1 } });
    await run(env, hb);
    const [rev] = await q(db, `SELECT note FROM op_content_items WHERE status='needs_revision'`);
    expect(rev!.note).toContain("invalid_after_retry");
    const job = (await q(db, `SELECT cost_cents FROM jobs WHERE created_by='c'`))[0]!;
    expect(job.cost_cents).toBeCloseTo(1.6);
  });
});

describe("publishing and verification", () => {
  async function drafted() {
    const ctx = await makeEnv();
    const plan = handlersWith({ fetcher: fakeFetcher({}) });
    await enqueue(ctx.db, plan, { runAt: PAST, kind: "ops.content_plan", createdBy: "a", input: { briefs: [brief("quilt-plan-kit")] } });
    await run(ctx.env, plan, T("2026-11-10T00:00:00Z"));
    const draft = { headline: "Plan your new-year quilt", body: "A year-of-projects tracker for your fabric and finish dates.", cta: "Get the planner", linkPath: "/planner" };
    await ctx.db.prepare(`UPDATE op_content_items SET status='drafted', body_json=? WHERE channel_id='ch_qpk_pinterest'`).bind(JSON.stringify(draft)).run();
    return { ...ctx, draft };
  }
  const live = (url: string): Publisher => ({ id: "fake_live", live: true, async publish() { return { published: true, externalUrl: url, note: "ok" }; } });

  it("does nothing by default (draft_only), and never marks dry runs published", async () => {
    const { env, db } = await drafted();
    const h = handlersWith({ fetcher: fakeFetcher({}) });
    expect((await policyFor(db, "ch_qpk_pinterest", new Date())).mode).toBe("draft_only");
    await enqueue(db, h, { runAt: PAST, kind: "ops.content_publish", createdBy: "p1" });
    await run(env, h);
    expect((await q(db, `SELECT COUNT(*) AS n FROM op_content_items WHERE status='published'`))[0]!.n).toBe(0);
    await db.prepare(`INSERT INTO op_channel_policies (channel_id,mode,publisher,daily_cap,updated_by,updated_at) VALUES ('ch_qpk_pinterest','approval_each','dry_run',3,'owner',?)`).bind(new Date().toISOString()).run();
    await db.prepare(`UPDATE op_content_items SET status='approved' WHERE id IN (SELECT id FROM op_content_items WHERE channel_id='ch_qpk_pinterest' LIMIT 1)`).run();
    await enqueue(db, h, { runAt: PAST, kind: "ops.content_publish", createdBy: "p2" });
    await run(env, h);
    const out = JSON.parse((await q(db, `SELECT output_json FROM jobs WHERE created_by='p2'`))[0]!.output_json).publish;
    expect(out.channels[0].previews).toHaveLength(1);
    expect(out.channels[0].published).toBe(0);
    expect((await q(db, `SELECT COUNT(*) AS n FROM op_content_items WHERE status='published'`))[0]!.n).toBe(0);
  });

  it("refuses a standing policy without an owner approval", async () => {
    const { db } = await drafted();
    await expect(db.prepare(`INSERT INTO op_channel_policies (channel_id,mode,publisher,daily_cap,updated_by,updated_at) VALUES ('ch_qpk_pinterest','standing','fake_live',1,'x',?)`).bind(new Date().toISOString()).run()).rejects.toThrow();
    await db.prepare(`INSERT INTO approvals (id,scope,action,status,requested_by,created_at) VALUES ('apr_p','channel:ch_qpk_pinterest','x','pending','agent',?)`).bind(new Date().toISOString()).run();
    await db.prepare(`INSERT INTO op_channel_policies (channel_id,mode,publisher,daily_cap,approval_id,window_end,updated_by,updated_at) VALUES ('ch_qpk_pinterest','standing','fake_live',1,'apr_p','2099-01-01T00:00:00Z','x',?)`).bind(new Date().toISOString()).run();
    expect(await policyFor(db, "ch_qpk_pinterest", new Date())).toMatchObject({ mode: "draft_only", reason: "standing approval not approved by owner" });
  });

  it("publishes within a standing boundary and daily cap, then verifies from the platform URL", async () => {
    const { env, db, draft } = await drafted();
    const at = new Date().toISOString();
    await db.prepare(`INSERT INTO approvals (id,scope,action,status,requested_by,decided_by,decided_at,created_at) VALUES ('apr_s','channel:ch_qpk_pinterest','x','approved','owner','owner',?,?)`).bind(at, at).run();
    await db.prepare(`INSERT INTO op_channel_policies (channel_id,mode,publisher,daily_cap,approval_id,window_end,updated_by,updated_at) VALUES ('ch_qpk_pinterest','standing','fake_live',1,'apr_s','2099-01-01T00:00:00Z','owner',?)`).bind(at).run();
    const url = "https://www.pinterest.com/pin/4455667788/";
    const h = handlersWith({ fetcher: fakeFetcher({ [url]: `<html>${draft.headline}</html>` }), publishers: [live(url)] });
    await enqueue(db, h, { runAt: PAST, kind: "ops.content_publish", createdBy: "p" });
    await run(env, h);
    expect((await q(db, `SELECT COUNT(*) AS n FROM op_content_items WHERE status='published'`))[0]!.n).toBe(1); // cap 1
    await enqueue(db, h, { runAt: PAST, kind: "ops.content_verify", createdBy: "v" });
    await run(env, h);
    const [it] = await q(db, `SELECT status, verified_at FROM op_content_items WHERE external_url=?`, url);
    expect(it!.status).toBe("verified");
    expect((await q(db, `SELECT last_verified_url FROM channels WHERE id='ch_qpk_pinterest'`))[0]!.last_verified_url).toBe(url);
  });

  it("rejects the receipts QA-005 V1 got verified, and stale or open-ended standing policies", async () => {
    const { env, db, draft } = await drafted();
    const bogus = ["https://notpinterest.example.com/anything", "https://www.pinterest.com/", "https://quiltplankit.pages.dev/"];
    const ids = (await q(db, `SELECT id FROM op_content_items WHERE channel_id='ch_qpk_pinterest' LIMIT 3`)).map((r) => r.id);
    for (let i = 0; i < 3; i++) await db.prepare(`UPDATE op_content_items SET status='published', external_url=?, published_at=? WHERE id=?`).bind(bogus[i], new Date().toISOString(), ids[i]).run();
    const pages: Record<string, string> = Object.fromEntries(bogus.map((u) => [u, `<html>${draft.headline}</html>`]));
    const h = handlersWith({ fetcher: fakeFetcher(pages) });
    await enqueue(db, h, { runAt: PAST, kind: "ops.content_verify", createdBy: "v" });
    await run(env, h);
    expect((await q(db, `SELECT status FROM op_content_items WHERE external_url IN (?,?,?)`, ...bogus)).map((r) => r.status)).toEqual(["failed", "failed", "failed"]);
    const [ch] = await q(db, `SELECT last_verified_url FROM channels WHERE id='ch_qpk_pinterest'`);
    expect(bogus).not.toContain(ch!.last_verified_url);
    // a real pin URL whose page does not show the headline is not enough either
    const { receiptRule } = await import("../src/handlers/content.ts");
    expect(receiptRule("pinterest", "https://www.pinterest.com/pin/123/", "https://quiltplankit.pages.dev").ok).toBe(true);
    expect(receiptRule("seo", "https://quiltplankit.pages.dev/guides/borders", "https://quiltplankit.pages.dev").ok).toBe(true);
    expect(receiptRule("email", "https://quiltplankit.pages.dev/x", "https://quiltplankit.pages.dev").ok).toBe(false);
    expect(receiptRule("email", "https://www.mailerlite.com/pricing", null).ok).toBe(false);
    expect(receiptRule("email", "https://preview.mailerlite.io/webview/123abc", null).ok).toBe(true);
    // standing with no end date is treated as draft_only
    const at = new Date().toISOString();
    await db.prepare(`INSERT INTO approvals (id,scope,action,status,requested_by,decided_by,decided_at,created_at) VALUES ('apr_o','c','x','approved','owner','owner',?,?)`).bind(at, at).run();
    await expect(db.prepare(`INSERT INTO op_channel_policies (channel_id,mode,publisher,daily_cap,approval_id,updated_by,updated_at) VALUES ('ch_qpk_pinterest','standing','dry_run',1,'apr_o','owner',?)`).bind(at).run()).rejects.toThrow(/window_end/);
    await db.prepare(`INSERT INTO op_channel_policies (channel_id,mode,publisher,daily_cap,approval_id,window_end,updated_by,updated_at) VALUES ('ch_qpk_pinterest','standing','dry_run',1,'apr_o','2026-12-01T00:00:00Z','owner',?)`).bind(at).run();
    expect(await policyFor(db, "ch_qpk_pinterest", new Date("2030-01-01T00:00:00Z"))).toMatchObject({ mode: "draft_only", reason: "standing approval window ended" });
  });

  it("fails and alerts when a publication cannot be confirmed within 72 hours", async () => {
    const { env, db } = await drafted();
    const old = "2026-11-01T00:00:00Z";
    await db.prepare(`UPDATE op_content_items SET status='published', external_url='https://www.pinterest.com/pin/999000111/', published_at=? WHERE id IN (SELECT id FROM op_content_items WHERE channel_id='ch_qpk_pinterest' LIMIT 1)`).bind(old).run();
    const h = handlersWith({ fetcher: fakeFetcher({}) });
    await enqueue(db, h, { runAt: PAST, kind: "ops.content_verify", createdBy: "v" });
    await run(env, h, T("2026-11-10T00:00:00Z"));
    expect((await q(db, `SELECT status FROM op_content_items WHERE external_url='https://www.pinterest.com/pin/999000111/'`))[0]!.status).toBe("failed");
    expect(await q(db, `SELECT * FROM alerts WHERE source='ops.content_verify' AND state='open'`)).toHaveLength(1);
    expect((await q(db, `SELECT status FROM channels WHERE id='ch_qpk_pinterest'`))[0]!.status).not.toBe("failing"); // channel record untouched by a single failure
  });
});

describe("weekly summary", () => {
  it("summarizes the previous ISO week and states unknowns instead of zeros", async () => {
    expect(previousWeek(T("2026-11-16T12:00:00Z")).start.toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(previousWeek(T("2026-11-18T12:00:00Z")).end.toISOString()).toBe("2026-11-16T00:00:00.000Z");
    const { env, db } = await makeEnv();
    const h = handlersWith({ fetcher: fakeFetcher(healthySites()) });
    await enqueue(db, h, { runAt: PAST, kind: "ops.site_health", createdBy: "t" });
    await run(env, h, T("2026-11-11T10:00:00Z"));
    await enqueue(db, h, { runAt: PAST, kind: "ops.weekly_summary", createdBy: "s", input: { slot: "2026-11-16T12:00Z" } });
    await run(env, h, T("2026-11-16T12:00:00Z"));
    const [row] = await q(db, `SELECT period_start, body_json FROM op_summaries`);
    const body = JSON.parse(row!.body_json);
    expect(row!.period_start).toBe("2026-11-09T00:00:00.000Z");
    expect(body.headline[0]).toContain("unknown");
    expect(body.revenue).toMatchObject({ state: "unconnected", valueCents: null });
    expect(body.unknowns.length).toBeGreaterThan(0);
    expect(body.jobs.silentLive.length).toBeGreaterThan(0); // LIVE n8n/Claude jobs with no runs are named, not hidden
  });
});
