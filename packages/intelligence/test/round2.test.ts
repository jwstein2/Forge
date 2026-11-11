import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { enqueue } from "../../../services/api/src/orchestration/engine.ts";
import { opportunityBoard } from "../../../services/api/src/domain/intelligence.ts";
import { intelligenceRoutes, seedIntelligenceData, storeObservations, storePack, GIT_PACKS, GIT_BRIEFS, INTEL_SCHEDULES, seedBriefs, duplicateClaimIds } from "../src/index.ts";
import { etsyApiCheck, etsyListingId } from "../src/etsy.ts";
import { isAssisted } from "../src/observations.ts";
import { drain, fakeFetcher, fixture, handlersWith, listingPage, makeEnv, pageviewsJson, testPack } from "./helpers.ts";

const NOW = new Date("2026-11-11T06:00:00Z");
beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });
const WIKI = /wikimedia\.org\/api\/rest_v1\/metrics\/pageviews/;
const ETSY = "https://www.etsy.com/listing/975558000";

/** Test pack whose alpha-kit listing is on Etsy (assisted re-check). */
function etsyPack() {
  const p = testPack();
  p.sources[0]!.url = ETSY;
  return p;
}
const others = () => Object.fromEntries(["beta-kit", "gamma-kit", "delta-kit"].map((k) => [`https://shop.example/${k}`, listingPage]));

async function runPack(pack: ReturnType<typeof testPack>, fetcher: ReturnType<typeof fakeFetcher>, opts: { observations?: Parameters<typeof storeObservations>[1]; env?: Record<string, string> } = {}) {
  const { env, db } = await makeEnv(opts.env);
  const handlers = handlersWith(fetcher);
  if (opts.observations) await storeObservations(db, opts.observations);
  const packId = await storePack(db, pack, "test");
  await enqueue(db, handlers, { kind: "intel.scout.run", input: { packId }, idempotencyKey: `scout:${packId}`, createdBy: "test" });
  await drain(env, handlers, NOW);
  const run = (await db.prepare(`SELECT * FROM research_runs WHERE kind='scout'`).first<Record<string, any>>())!;
  const report = JSON.parse((await db.prepare(`SELECT report_json FROM research_run_reports WHERE run_id=?`).bind(run.id).first<{ report_json: string }>())!.report_json);
  return { db, run, report };
}
const obs = (outcome: "confirmed" | "dead" | "mismatch", observed_at = "2026-11-11T02:00:00Z") =>
  [{ url: ETSY, observed_at, observed_by: "test analyst", method: "assisted_fetch" as const, outcome, figures: { price: "7.05" } }];

describe("Etsy substitute: assisted re-check with dated observations", () => {
  it("never fetches a bot-walled host from the Worker", async () => {
    expect(isAssisted(ETSY)).toBe(true);
    expect(isAssisted("https://shop.example/x")).toBe(false);
    expect(isAssisted("https://shop.example/x", "assisted")).toBe(true);
    const f = fakeFetcher(others());
    const { run, report } = await runPack(etsyPack(), f);
    expect(f.calls.some((u) => u.includes("etsy.com"))).toBe(false);
    expect(run.status).toBe("partial"); // no observation yet: honest gap
    expect(report.sources.unreachable).toBe(1);
  });

  it("a fresh confirming observation stands in for the skipped check, and the run can succeed", async () => {
    const { run, report } = await runPack(etsyPack(), fakeFetcher(others(), [[WIKI, pageviewsJson()]]), { observations: obs("confirmed") });
    expect(report.sources).toMatchObject({ viaObservation: 1, unreachable: 0, failed: 0 });
    expect(report.observations[0]).toMatchObject({ sourceId: "src_alpha_kit_listing", outcome: "confirmed" });
    expect(run.status).toBe("succeeded");
  });

  it("a fresh observation that the listing is gone downgrades its claims (R1)", async () => {
    const { report } = await runPack(etsyPack(), fakeFetcher(others()), { observations: obs("dead") });
    expect(report.downgrades["alpha-kit"].map((d: any) => d.rule)).toContain("R1");
  });

  it("an observation older than 45 days is reported as stale and not used", async () => {
    const { run, report } = await runPack(etsyPack(), fakeFetcher(others()), { observations: obs("confirmed", "2026-09-01T00:00:00Z") });
    expect(report.sources.viaObservation).toBe(0);
    expect(report.staleObservations).toEqual(["src_alpha_kit_listing"]);
    expect(run.status).toBe("partial");
  });

  it("uses the official Etsy Open API when (and only when) a key is configured", async () => {
    expect(etsyListingId(ETSY)).toBe("975558000");
    const api = "https://openapi.etsy.com/v3/application/listings/975558000";
    const live = await etsyApiCheck(fakeFetcher({ [api]: JSON.stringify({ state: "active", price: { amount: 705, divisor: 100 } }) }), "k", { id: "s", url: ETSY, expect: ["7.05", "27 reviews"] });
    expect(live).toMatchObject({ outcome: "confirmed", via: "etsy_api" });
    expect(live.note).toContain("not checkable via API: 27 reviews");
    const gone = await etsyApiCheck(fakeFetcher({ [api]: JSON.stringify({ state: "removed" }) }), "k", { id: "s", url: ETSY, expect: ["7.05"] });
    expect(gone.outcome).toBe("dead");
    // QA-019 I2-1: a non-USD price is not compared with USD figures
    const cad = await etsyApiCheck(fakeFetcher({ [api]: JSON.stringify({ state: "active", price: { amount: 705, divisor: 100, currency_code: "CAD" } }) }), "k", { id: "s", url: ETSY, expect: ["7.05"] });
    expect(cad.outcome).toBe("reachable");
    expect(cad.note).toMatch(/CAD/);
    const moved = await etsyApiCheck(fakeFetcher({ [api]: JSON.stringify({ state: "active", price: { amount: 999, divisor: 100 } }) }), "k", { id: "s", url: ETSY, expect: ["7.05"] });
    expect(moved).toMatchObject({ outcome: "mismatch", missing: ["7.05"] });
    const f = fakeFetcher({ ...others(), [api]: JSON.stringify({ state: "active", price: { amount: 1800, divisor: 100 } }) });
    const p = etsyPack();
    await runPack(p, f, { env: { ETSY_API_KEY: "test-key" } });
    expect(f.calls).toContain(api);
  });
});

describe("periodic Scout for Command", () => {
  it("seeds the git pack once and the monthly cycle produces a ranked board with exactly one recommendation", async () => {
    const { env, db } = await makeEnv();
    const first = await seedIntelligenceData(db);
    const again = await seedIntelligenceData(db);
    expect(first.packs).toBe(GIT_PACKS.length);
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM research_packs`).first<{ n: number }>())!.n).toBe(GIT_PACKS.length);
    expect(again.observations.stored).toBe(0);
    expect(INTEL_SCHEDULES.find((s) => s.kind === "intel.scout.cycle")?.spec).toEqual({ monthly: { day: 2, at: "06:00" } });
    const handlers = handlersWith(fakeFetcher({}, [[WIKI, pageviewsJson()]]));
    await enqueue(db, handlers, { kind: "intel.scout.cycle", input: {}, idempotencyKey: "cycle:2026-11", createdBy: "test" });
    await drain(env, handlers, NOW, 60);
    const board = await opportunityBoard(db);
    expect(board.state).toBe("ready");
    expect(board.opportunities.length).toBeGreaterThanOrEqual(3);
    expect(board.opportunities.length).toBeLessThanOrEqual(5);
    expect(board.opportunities.filter((o) => o.recommended)).toHaveLength(1);
    expect(board.opportunities[0]!.opportunityKey).toBe("garden-planner");
    // a second cycle in the same month does not start a second run
    await enqueue(db, handlers, { kind: "intel.scout.cycle", input: {}, idempotencyKey: "cycle:2026-11:b", createdBy: "test" });
    await drain(env, handlers, NOW, 20);
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM research_runs WHERE kind='scout'`).first<{ n: number }>())!.n).toBe(1);
  });

  it("the weekly re-check also collects interest signals for each niche with a brief", async () => {
    const { env, db } = await makeEnv();
    const handlers = handlersWith(fakeFetcher({}, [[WIKI, pageviewsJson()]]));
    await enqueue(db, handlers, { kind: "intel.brief.publish", input: { brief: fixture("quilt-plan-kit.brief.json") }, createdBy: "test" });
    await drain(env, handlers, NOW);
    await enqueue(db, handlers, { kind: "intel.source.recheck", input: {}, createdBy: "test" });
    await drain(env, handlers, NOW);
    const sig = (await db.prepare(`SELECT candidate, subject, status FROM research_signals`).all<Record<string, any>>()).results;
    expect(sig.map((s) => s.subject).sort()).toEqual(["Quilt", "Quilting"]);
    expect(sig.every((s) => s.status === "collected")).toBe(true);
  });
});

describe("observation route", () => {
  it("is owner only and validates input", async () => {
    const { env } = await makeEnv();
    const handlers = handlersWith(fakeFetcher({}));
    const mk = (role: string) => { const a = new Hono<any>(); a.use("*", async (c, n) => { c.set("me", { email: "o@x", role }); await n(); }); a.route("/i", intelligenceRoutes(() => handlers)); return a; };
    const post = (a: Hono<any>, body: unknown) => a.request("/i/source-observations", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, env);
    expect((await post(mk("viewer"), { observations: obs("confirmed") })).status).toBe(403);
    expect((await post(mk("owner"), { observations: [{ url: "ftp://x" }] })).status).toBe(422);
    const ok = await (await post(mk("owner"), { observations: obs("confirmed") })).json() as any;
    expect(ok.data).toEqual({ stored: 1, duplicates: 0 });
  });
});

describe("git briefs seeded for staging planners", () => {
  it("stores every current brief once, as a draft, and never touches an existing version", async () => {
    const { db } = await makeEnv();
    expect(GIT_BRIEFS.map((b) => b.niche).sort()).toEqual(["bidline", "garden-planner", "loaf-ledger", "quilt-plan-kit"]);
    // an owner-approved row for one niche+version must survive seeding unchanged
    const qpk = GIT_BRIEFS.find((b) => b.niche === "quilt-plan-kit")!;
    await db.prepare(`INSERT INTO market_briefs (id,niche_id,version,schema_version,status,content_json,content_hash,created_at,approved_by) VALUES ('b_appr','quilt-plan-kit',?,?,'approved','{}','h','2026-11-01T00:00:00Z','owner')`).bind(qpk.version, qpk.schema_version).run();
    const first = await seedIntelligenceData(db);
    expect(first.briefs).toEqual({ stored: 3, existing: 1, invalid: [] });
    expect((await seedBriefs(db)).stored).toBe(0);
    const rows = (await db.prepare(`SELECT niche_id, status FROM market_briefs ORDER BY niche_id`).all<{ niche_id: string; status: string }>()).results;
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.niche_id === "quilt-plan-kit")!.status).toBe("approved");
    expect(rows.filter((r) => r.niche_id !== "quilt-plan-kit").every((r) => r.status === "draft")).toBe(true);
  });
  it("skips an invalid brief and reports it instead of storing it", async () => {
    const { db } = await makeEnv();
    const r = await seedBriefs(db, [{ niche: "x", version: "0.0.1" }]);
    expect(r.stored).toBe(0);
    expect(r.invalid).toHaveLength(1);
  });
});

describe("brief claim ids", () => {
  it("every git brief has unique claim ids, and a duplicate is refused", async () => {
    for (const b of GIT_BRIEFS) expect(duplicateClaimIds(b), b.niche).toEqual([]);
    const bad = structuredClone(GIT_BRIEFS[0]!);
    bad.version = "9.9.9";
    const claims: any[] = [];
    JSON.stringify(bad, (_k, v) => { if (v && typeof v === "object" && typeof v.statement === "string" && typeof v.id === "string") claims.push(v); return v; });
    claims[1].id = claims[0].id;
    expect(duplicateClaimIds(bad)).toEqual([claims[0].id]);
    const { db } = await makeEnv();
    const r = await seedBriefs(db, [bad]);
    expect(r.stored).toBe(0);
    expect(r.invalid[0]).toMatch(/duplicate claim ids/);
  });
});

describe("seeding never stops the scheduler (QA-019 I2-2)", () => {
  it("an invalid observation raises one alert and the rest still seeds; a clean seed resolves it", async () => {
    const mod = await import("../src/index.ts");
    const { db } = await makeEnv();
    const saved = [...mod.GIT_OBSERVATIONS];
    mod.GIT_OBSERVATIONS.push({ url: "not a url" } as any);
    try {
      const r = await mod.seedIntelligenceData(db);
      expect(r.errors.length).toBe(1);
      expect(r.packs).toBe(GIT_PACKS.length);
      expect(r.briefs.stored).toBe(GIT_BRIEFS.length);
      const a = await db.prepare(`SELECT state FROM alerts WHERE dedupe_key = 'intel:seed:failed'`).first<{ state: string }>();
      expect(a!.state).toBe("open");
    } finally { mod.GIT_OBSERVATIONS.length = 0; mod.GIT_OBSERVATIONS.push(...saved); }
    const ok = await mod.seedIntelligenceData(db);
    expect(ok.errors).toEqual([]);
    expect((await db.prepare(`SELECT state FROM alerts WHERE dedupe_key = 'intel:seed:failed'`).first<{ state: string }>())!.state).toBe("resolved");
  });
});
