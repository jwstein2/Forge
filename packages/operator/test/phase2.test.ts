import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { operatorRoutes } from "../src/routes.ts";
import { enqueue } from "../../../services/api/src/orchestration/engine.ts";
import { policyFor } from "../src/handlers/content.ts";
import { recommend, type NicheFacts } from "../src/handlers/optimize.ts";
import type { MailerLiteReader } from "../src/handlers/lifecycle.ts";
import { HEARTBEAT_PLAN } from "../src/heartbeat-plan.ts";
import { PROPOSAL_VERSION } from "../src/proposal.ts";
import { OPERATOR_SCHEDULES, OPERATOR_REGISTRY_ENTRIES } from "../src/index.ts";
import { handlersWith, makeEnv, run } from "./helpers.ts";

const PAST = "2000-01-01T00:00:00.000Z";
const q = async (db: D1Database, sql: string) => (await db.prepare(sql).all<Record<string, any>>()).results;
function app(role: string | null) {
  const a = new Hono<any>();
  a.use("*", async (c, next) => { if (role) c.set("me", { email: "owner@forge.test", role }); await next(); });
  a.route("/operator", operatorRoutes());
  return (env: any, method: string, path: string, body?: unknown) =>
    Promise.resolve(a.fetch(new Request(`http://t/operator${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env))
      .then(async (r: Response) => ({ status: r.status, json: (await r.json()) as any }));
}
const ml = (o: Partial<{ groups: any[]; forms: any[]; automations: any[]; fail: boolean }>): (() => MailerLiteReader) => () => ({
  mode: "live",
  groups: async () => { if (o.fail) throw new Error("MailerLite /groups HTTP 401"); return o.groups ?? []; },
  forms: async () => o.forms ?? [], automations: async () => o.automations ?? [],
});
const group = (id: string, name: string, active: number, extra: object = {}) => ({ id, name, active_count: active, unconfirmed_count: 0, unsubscribed_count: 0, bounced_count: 0, junk_count: 0, ...extra });

describe("lifecycle watch", () => {
  it("records unconnected (not zero) without an API key and raises nothing", async () => {
    const { env, db } = await makeEnv();
    const h = handlersWith({});
    await enqueue(db, h, { runAt: PAST, kind: "ops.lifecycle_watch", createdBy: "t" });
    expect((await run(env, h))[0]!.outcome).toBe("succeeded");
    expect(await q(db, `SELECT state, source FROM op_lifecycle_snapshots`)).toEqual([{ state: "unconnected", source: "none" }]);
    expect(await q(db, `SELECT * FROM alerts WHERE source='ops.lifecycle_watch'`)).toHaveLength(0);
  });

  it("flags signups waiting on a welcome sequence that is off, and a broken automation", async () => {
    const { env, db } = await makeEnv();
    const h = handlersWith({ mailerlite: ml({
      groups: [group("203436416693176152", "Quilt Math Cheat Sheet", 4), group("203717192087242239", "Bidline - Estimate Template", 0, { unconfirmed_count: 12, active_count: 3 })],
      automations: [{ id: "203721958159811713", name: "FORGE · Quilt Plan Kit · Welcome", enabled: false }, { id: "203722971884292051", name: "FORGE · Bidline · Welcome", enabled: true, broken: true }],
    }) });
    await enqueue(db, h, { runAt: PAST, kind: "ops.lifecycle_watch", createdBy: "t" });
    await run(env, h);
    const alerts = await q(db, `SELECT dedupe_key, severity, needs_owner FROM alerts WHERE source='ops.lifecycle_watch' ORDER BY dedupe_key`);
    expect(alerts).toEqual([
      { dedupe_key: "ops:lifecycle:broken:LC-BID-WELCOME", severity: "critical", needs_owner: 0 },
      { dedupe_key: "ops:lifecycle:unconfirmed:203717192087242239", severity: "warning", needs_owner: 0 },
      { dedupe_key: "ops:lifecycle:welcome_off:LC-BID-WELCOME", severity: "warning", needs_owner: 1 },
      { dedupe_key: "ops:lifecycle:welcome_off:LC-QPK-WELCOME", severity: "warning", needs_owner: 1 },
    ]);
    const snap = (await q(db, `SELECT automations_json FROM op_lifecycle_snapshots WHERE state='live'`))[0]!;
    expect(JSON.parse(snap.automations_json).map((a: any) => [a.sequence, a.status])).toEqual([["LC-QPK-WELCOME", "off"], ["LC-BID-WELCOME", "broken"], ["LC-LOAF-WELCOME", "missing"]]);
  });

  it("records an error snapshot, not zeros, when MailerLite refuses, and warns after 3 in a row (QA-011 P2-2)", async () => {
    const { env, db } = await makeEnv();
    const h = handlersWith({ mailerlite: ml({ fail: true }) });
    await enqueue(db, h, { runAt: PAST, kind: "ops.lifecycle_watch", createdBy: "t" });
    await run(env, h);
    expect(await q(db, `SELECT state, error FROM op_lifecycle_snapshots`)).toEqual([{ state: "error", error: "MailerLite /groups HTTP 401" }]);
    for (const k of ["t2", "t3"]) { await enqueue(db, h, { runAt: PAST, kind: "ops.lifecycle_watch", createdBy: k }); await run(env, h); }
    expect((await q(db, `SELECT state FROM alerts WHERE dedupe_key='ops:lifecycle:read_error'`))[0]!.state).toBe("open");
    const ok = handlersWith({ mailerlite: ml({}) });
    await enqueue(db, ok, { runAt: PAST, kind: "ops.lifecycle_watch", createdBy: "t4" }); await run(env, ok);
    expect((await q(db, `SELECT state FROM alerts WHERE dedupe_key='ops:lifecycle:read_error'`))[0]!.state).toBe("resolved");
  });
});

describe("optimization loop", () => {
  const base: NicheFacts = { nicheId: "bidline", name: "Bidline", funnelSource: "snapshot", period: { start: "2026-10-13T00:00:00Z", end: "2026-11-10T00:00:00Z" }, dataAsOf: "2026-11-10T00:00:00Z",
    pageViews: 0, calcUses: 0, checkoutClicks: 0, signups: 0, pinterestVisits: 0, liveSales: 0, platformPins28d: 0, welcomeStatus: null, draftedAwaiting: 0, overduePlanned: 0, checkoutLiveSince: null };
  it("says nothing without a minimum sample", () => expect(recommend({ ...base, calcUses: 49, checkoutClicks: 0, pageViews: 299 })).toEqual([]));
  it("proposes from real thresholds and cites its numbers", () => {
    const r = recommend({ ...base, calcUses: 80, checkoutClicks: 25, signups: 3, welcomeStatus: "off" });
    expect(r.map((x) => x.rule).sort()).toEqual(["checkout_no_sale", "welcome_not_live"]);
    expect(r.find((x) => x.rule === "welcome_not_live")!.evidence).toMatchObject({ signups: 3, welcomeStatus: "off" });
  });
  it("does not run funnel rules when the funnel source is unconnected", () =>
    expect(recommend({ ...base, funnelSource: "unconnected", calcUses: 500, checkoutClicks: 0 })).toEqual([]));
  it("does not claim an absence from a snapshot that stops before the period ends (QA-011 P2-3)", () => {
    const stale = { ...base, dataAsOf: "2026-11-01T00:00:00Z", calcUses: 80, checkoutClicks: 25, pageViews: 400, checkoutLiveSince: "2026-10-20T00:00:00Z" };
    expect(recommend(stale).map((x) => x.rule)).toEqual([]);
    const r = recommend({ ...stale, checkoutClicks: 0 });
    expect(r.map((x) => [x.rule, x.label])).toEqual([["calculator_no_checkout", "INFERRED"]]);
    expect(r[0]!.evidence).toMatchObject({ dataAsOf: "2026-11-01T00:00:00Z", partial: true });
  });
  it("treats a live ledger synced within a day as complete (QA-011 R1-1)", () => {
    const live = { ...base, funnelSource: "live" as const, checkoutClicks: 30, pageViews: 500, checkoutLiveSince: "2026-10-20T00:00:00Z" };
    expect(recommend({ ...live, dataAsOf: "2026-11-09T23:59:59Z" }).map((x) => [x.rule, x.label]).sort()).toEqual([["checkout_no_sale", "VERIFIED"], ["kill_rule", "VERIFIED"]]);
    expect(recommend({ ...live, dataAsOf: "2026-11-08T00:00:00Z" })).toEqual([]); // stale live sync: no absence claims
    expect(recommend({ ...base, checkoutClicks: 30, dataAsOf: "2026-11-09T23:59:59Z" })).toEqual([]); // dated snapshot stays strict
  });
  it("fires the kill rule only inside 60 days of checkout going live", () => {
    expect(recommend({ ...base, pageViews: 320, checkoutLiveSince: "2026-10-01T00:00:00Z" }).map((x) => x.rule)).toEqual(["kill_rule"]);
    expect(recommend({ ...base, pageViews: 320, checkoutLiveSince: "2026-08-01T00:00:00Z" })).toEqual([]);
  });

  it("writes proposals once per week and expires them when the condition clears", async () => {
    const { env, db } = await makeEnv();
    await db.prepare(`INSERT INTO op_lifecycle_snapshots (id,taken_at,state,source,automations_json) VALUES ('s1',?,'live','mailerlite.api',?)`).bind(new Date(Date.now() - 3600000).toISOString(), JSON.stringify([{ nicheId: "quilt-plan-kit", status: "off" }])).run();
    const day = new Date().toISOString().slice(0, 10);
    await db.prepare(`INSERT INTO funnel_daily (day,niche_id,event,path,source,count,is_test,imported_at) VALUES (?, 'quilt-plan-kit','signup_submit','/','direct',2,0,?)`).bind(day, day).run();
    const h = handlersWith({});
    for (const k of ["a", "b"]) { await enqueue(db, h, { runAt: PAST, kind: "ops.optimize_weekly", createdBy: k }); await run(env, h); }
    const recs = await q(db, `SELECT rule, status, niche_id FROM op_recommendations`);
    expect(recs.filter((r) => r.status === "proposed").map((r) => `${r.niche_id}:${r.rule}`)).toContain("quilt-plan-kit:welcome_not_live");
    expect(recs.filter((r) => r.rule === "welcome_not_live")).toHaveLength(1); // same week, same rule: one row
    await db.prepare(`INSERT INTO op_lifecycle_snapshots (id,taken_at,state,source,automations_json) VALUES ('s2',?,'live','mailerlite.api',?)`).bind(new Date().toISOString(), JSON.stringify([{ nicheId: "quilt-plan-kit", status: "active" }])).run();
    await enqueue(db, h, { runAt: PAST, kind: "ops.optimize_weekly", createdBy: "c" }); await run(env, h);
    expect((await q(db, `SELECT status FROM op_recommendations WHERE rule='welcome_not_live'`))[0]!.status).toBe("expired");
  });
});

describe("one-decision publishing proposal", () => {
  it("proposes a boundary per channel and applies all of them with one owner approval", async () => {
    const { env, db } = await makeEnv();
    const call = app("owner");
    const p = (await call(env, "GET", "/policies/proposal")).json.data;
    expect(p.version).toMatch(new RegExp(`^${PROPOSAL_VERSION.replace(/\./g, "\\.")}\\+[0-9a-f]{8}$`));
    expect(Object.fromEntries(p.channels.map((c: any) => [c.channelId, `${c.mode}/${c.dailyCap}/${c.publisher}`]))).toEqual({
      ch_bidline_seo: "approval_each/1/manual", ch_loaf_seo: "approval_each/1/manual", ch_qpk_email: "approval_each/1/dry_run", ch_qpk_pinterest: "standing/1/dry_run", ch_qpk_seo: "approval_each/1/manual" });
    expect((await app(null)(env, "POST", "/policies/proposal/apply", { version: p.version })).status).toBe(403);
    expect((await call(env, "POST", "/policies/proposal/apply", { version: PROPOSAL_VERSION })).status).toBe(409); // no hash: refused
    // A channel added after the owner looked changes the version, so the old one is refused (QA-011 P2-4).
    await db.prepare(`INSERT INTO channels (id,niche_id,platform,status,updated_at) VALUES ('ch_bid_email','bidline','email','configured','2026-11-10')`).run();
    expect((await call(env, "POST", "/policies/proposal/apply", { version: p.version })).status).toBe(409);
    await db.prepare(`DELETE FROM channels WHERE id='ch_bid_email'`).run();
    const r = await call(env, "POST", "/policies/proposal/apply", { version: p.version, sourceRef: "decision-card" });
    expect(r.status).toBe(200);
    expect(await q(db, `SELECT status, decided_by, source_ref FROM approvals WHERE scope LIKE 'channels:proposal:%'`)).toEqual([{ status: "approved", decided_by: "owner", source_ref: "decision-card" }]);
    const pol = await policyFor(db, "ch_qpk_pinterest", new Date());
    expect(pol).toMatchObject({ mode: "standing", publisher: "dry_run", dailyCap: 1 });
    expect((await policyFor(db, "ch_qpk_email", new Date())).mode).toBe("approval_each");
    // The window ends after 90 days: standing falls back to draft_only.
    expect((await policyFor(db, "ch_qpk_pinterest", new Date(Date.now() + 91 * 86400000))).mode).toBe("draft_only");
  });

  it("lets the owner accept or dismiss recommendations in one batch", async () => {
    const { env, db } = await makeEnv();
    await db.prepare(`INSERT INTO op_recommendations (id,niche_id,rule,dedupe_key,title,detail,action,evidence_json,evidence_label,impact,created_at) VALUES ('r1','bidline','x','x:b:w','t','d','a','{}','VERIFIED','high','2026-11-10')`).run();
    const r = await app("owner")(env, "POST", "/recommendations/decide", { ids: ["r1"], status: "dismissed" });
    expect(r.json.data.updated).toBe(1);
    expect((await q(db, `SELECT status, decided_by FROM op_recommendations`))[0]).toEqual({ status: "dismissed", decided_by: "owner@forge.test" });
    // Already decided or expired rows are not re-decided, and the count says so (QA-012).
    expect((await app("owner")(env, "POST", "/recommendations/decide", { ids: ["r1", "nope"], status: "accepted" })).json.data.updated).toBe(0);
    expect((await app("owner")(env, "GET", "/recommendations?status=all")).json.data).toHaveLength(1);
  });

  it("serves the lifecycle sequences with a clean claims check", async () => {
    const { env } = await makeEnv();
    const d = (await app("owner")(env, "GET", "/lifecycle")).json.data;
    expect(d.snapshot.state).toBe("unconnected");
    expect(d.sequences).toHaveLength(6);
    expect(d.sequences.every((s: any) => s.lint.length === 0)).toBe(true);
  });
});

describe("wiring", () => {
  it("schedules and registers every new job, and maps every FORGE n8n workflow for heartbeats", () => {
    for (const id of ["OPS-LIFECYCLE-WATCH", "OPS-OPTIMIZE-WEEKLY"]) {
      expect(OPERATOR_SCHEDULES.some((s) => s.id === id)).toBe(true);
      expect(OPERATOR_REGISTRY_ENTRIES.some((r) => r.id === id)).toBe(true);
    }
    expect(HEARTBEAT_PLAN.targets.map((t) => t.registryId)).toEqual(["N8N-01", "N8N-02", "N8N-03", "N8N-04", "N8N-05"]);
  });
});
