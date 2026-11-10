import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { enqueue } from "../../../services/api/src/orchestration/engine.ts";
import { opportunityBoard, listBriefs } from "../../../services/api/src/domain/intelligence.ts";
import { intelligenceRoutes, storePack } from "../src/index.ts";
import { drain, fakeFetcher, fixture, handlersWith, listingPage, makeEnv, pageviewsJson, testPack } from "./helpers.ts";

const NOW = new Date("2026-11-10T06:00:00Z");
const WIKI = /wikimedia\.org\/api\/rest_v1\/metrics\/pageviews/;

function packWithBrief() {
  const p = testPack();
  const b = fixture("quilt-plan-kit.brief.json");
  b.brief_id = "brief_alpha-kit_v1-0-0"; b.niche = "alpha-kit"; b.version = "1.0.0"; b.display_name = "Alpha Kit"; b.supersedes = null;
  p.candidates[0]!.brief = b;
  return p;
}
const allListings = () => Object.fromEntries(["alpha-kit", "beta-kit", "gamma-kit", "delta-kit"].map((k) => [`https://shop.example/${k}`, listingPage]));

async function scout(fetcher: ReturnType<typeof fakeFetcher>, pack = packWithBrief()) {
  const { env, db } = await makeEnv();
  const handlers = handlersWith(fetcher);
  const packId = await storePack(db, pack, "owner@forge.test");
  await enqueue(db, handlers, { kind: "intel.scout.run", input: { packId }, idempotencyKey: `scout:${packId}`, createdBy: "test" });
  await drain(env, handlers, NOW);
  const run = (await db.prepare(`SELECT * FROM research_runs WHERE kind='scout'`).first<Record<string, any>>())!;
  const report = JSON.parse((await db.prepare(`SELECT report_json FROM research_run_reports WHERE run_id=?`).bind(run.id).first<{ report_json: string }>())!.report_json);
  const jobs = (await db.prepare(`SELECT kind, status, error FROM jobs`).all<Record<string, any>>()).results;
  return { env, db, run, report, jobs, handlers };
}

describe("Opportunity Scout run on the job engine", () => {
  it("re-checks sources, collects signals, scores, and stores opportunities and a draft brief", async () => {
    const f = fakeFetcher(allListings(), [[WIKI, pageviewsJson()]]);
    const { db, run, report, jobs } = await scout(f);
    expect(jobs.filter((j) => j.status !== "succeeded")).toEqual([]);
    expect(jobs.map((j) => j.kind).sort()).toEqual(["intel.scout.finalize", "intel.scout.run", "intel.signal.collect", "intel.source.check"]);
    expect(run.status).toBe("succeeded");
    expect(JSON.parse(run.sources_unconnected_json).length).toBeGreaterThan(3);
    expect(report.sources).toMatchObject({ checked: 4, confirmed: 4, failed: 0, unreachable: 0 });
    // delta-kit fails ip_clean and must never appear (pipeline acceptance test 4)
    expect(report.ranking.map((r: any) => r.key)).not.toContain("delta-kit");
    expect(report.ranking[0]).toMatchObject({ key: "alpha-kit", rank: 1, recommended: true });

    const board = await opportunityBoard(db);
    expect(board.state).toBe("ready");
    expect(board.opportunities.map((o) => o.opportunityKey)).toEqual(["alpha-kit", "beta-kit", "gamma-kit"]);
    expect(board.opportunities[0]!.status).toBe("recommended");
    expect(board.opportunities[1]!.status).toBe("candidate");
    expect(board.opportunities[0]!.scoringModelVersion).toBe("1.0.0");
    expect(board.opportunities[0]!.briefRef).toBe("brief_alpha-kit_v1-0-0");

    const brief = (await listBriefs(db, "alpha-kit"))[0]!;
    expect(brief.status).toBe("draft");
    const content = brief.content as any;
    expect(content.sources.some((s: any) => s.id === "src_wikipedia_alpha")).toBe(true);
    expect(content.summary.key_findings.some((c: any) => c.method === "public_dataset" && c.evidence === "VERIFIED")).toBe(true);
    expect(content.data_connectors.some((c: any) => c.status === "requires_paid_access")).toBe(true);
    // the Scout added the seasonality claim as INFERRED, never VERIFIED
    const opp = board.opportunities[0]!.content as any;
    expect(opp.unconnected_sources.length).toBeGreaterThan(3);
  });

  it("downgrades evidence when a cited listing no longer shows the figure, and the run is honest about it", async () => {
    const routes = allListings(); routes["https://shop.example/alpha-kit"] = "<p>Price $24.00</p>";
    const { report } = await scout(fakeFetcher(routes, [[WIKI, pageviewsJson()]]));
    expect(report.sources.failed).toBe(1);
    expect(report.downgrades["alpha-kit"].map((d: any) => d.rule)).toEqual(expect.arrayContaining(["R1", "R2"]));
    expect(report.ranking[0].key).toBe("beta-kit"); // alpha's VERIFIED demand and price fell to INFERRED
  });

  it("marks the run partial when a source is unreachable or a signal could not be collected, without inventing numbers", async () => {
    const routes = allListings(); routes["https://shop.example/beta-kit"] = { ok: false, status: 403, text: "" } as any;
    const { run, report, db } = await scout(fakeFetcher(routes)); // no Wikimedia route -> 404
    expect(run.status).toBe("partial");
    expect(report.sources.unreachable).toBe(1);
    expect(report.signalsMissing).toBe(1);
    expect(report.downgrades["beta-kit"]).toEqual([]);
    const sig = await db.prepare(`SELECT status, points_json FROM research_signals`).first<Record<string, any>>();
    expect(sig!.status).not.toBe("collected");
    expect(JSON.parse(sig!.points_json)).toEqual([]);
  });

  it("does not spend: every Scout job is deterministic and uses no model", async () => {
    const { db } = await scout(fakeFetcher(allListings(), [[WIKI, pageviewsJson()]]));
    const spend = await db.prepare(`SELECT COALESCE(SUM(cost_cents),0) AS c FROM research_runs`).first<{ c: number }>();
    expect(spend!.c).toBe(0);
    for (const h of handlersWith(fakeFetcher({})).values()) if (h.kind.startsWith("intel.")) expect(h.usesModel ?? false).toBe(false);
  });
});

describe("brief publish and weekly source re-check", () => {
  it("publishes a draft brief idempotently, then re-checks its sources and raises an info alert on a dead one", async () => {
    const { env, db } = await makeEnv();
    const b = fixture("quilt-plan-kit.brief.json");
    const urls = b.sources.map((s: any) => s.url).filter((u: string) => /^https?:/.test(u));
    const routes = Object.fromEntries(urls.map((u: string) => [u, "<html>ok</html>"]));
    routes[urls[0]] = { ok: false, status: 404, text: "" } as any;
    const handlers = handlersWith(fakeFetcher(routes));
    await enqueue(db, handlers, { kind: "intel.brief.publish", input: { brief: b }, createdBy: "test" });
    await enqueue(db, handlers, { kind: "intel.brief.publish", input: { brief: b }, idempotencyKey: "second", createdBy: "test" });
    await drain(env, handlers, NOW);
    expect((await listBriefs(db, "quilt-plan-kit")).length).toBe(1);
    await enqueue(db, handlers, { kind: "intel.source.recheck", input: {}, createdBy: "test" });
    await drain(env, handlers, NOW);
    const alert = await db.prepare(`SELECT severity, state FROM alerts WHERE dedupe_key = 'intel:sources:dead'`).first<Record<string, any>>();
    expect(alert).toMatchObject({ severity: "info" });
    const runRow = await db.prepare(`SELECT status FROM research_runs WHERE kind='source_recheck'`).first<Record<string, any>>();
    expect(["succeeded", "partial"]).toContain(runRow!.status);
  });
});

describe("routes", () => {
  const app = async (role: string) => {
    const { env } = await makeEnv();
    const handlers = handlersWith(fakeFetcher({}));
    const a = new Hono<any>();
    a.use("*", async (c, next) => { c.set("me", { email: "owner@forge.test", role }); await next(); });
    a.route("/intelligence", intelligenceRoutes(() => handlers));
    return { a, env };
  };
  it("only the owner can start a Scout run; bad packs get 422; connectors are listed", async () => {
    const v = await app("viewer");
    expect((await v.a.request("/intelligence/scout-runs", { method: "POST", body: JSON.stringify({ pack: testPack() }), headers: { "content-type": "application/json" } }, v.env)).status).toBe(403);
    const o = await app("owner");
    const bad = await o.a.request("/intelligence/scout-runs", { method: "POST", body: JSON.stringify({ pack: { schema: "nope" } }), headers: { "content-type": "application/json" } }, o.env);
    expect(bad.status).toBe(422);
    const ok = await o.a.request("/intelligence/scout-runs", { method: "POST", body: JSON.stringify({ pack: testPack() }), headers: { "content-type": "application/json" } }, o.env);
    const body = await ok.json() as any;
    expect(body.ok).toBe(true);
    const again = await (await o.a.request("/intelligence/scout-runs", { method: "POST", body: JSON.stringify({ pack: testPack() }), headers: { "content-type": "application/json" } }, o.env)).json() as any;
    expect(again.data.jobId).toBe(body.data.jobId);
    const conn = await (await o.a.request("/intelligence/connectors", {}, o.env)).json() as any;
    expect(conn.data.length).toBeGreaterThan(5);
  });
});

describe("schedule", () => {
  it("the weekly re-check schedule seeds against its registry entry", async () => {
    const { seedSchedules } = await import("../../operator/src/schedule.ts");
    const { INTEL_SCHEDULES } = await import("../src/index.ts");
    const { db } = await makeEnv();
    expect(await seedSchedules(db, INTEL_SCHEDULES as never)).toBe(1);
  });
});
