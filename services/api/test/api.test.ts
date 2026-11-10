import { describe, expect, it, vi } from "vitest";
import { makeApp, makeEnv, collectMetrics, DEV_TOKEN } from "./helpers.ts";
import { tick } from "../src/orchestration/engine.ts";
import { defaultHandlers } from "../src/orchestration/handlers.ts";
import { hmacSha256Hex } from "../src/lib/util.ts";
import { scheduledTick } from "../src/worker.ts";

async function synced() {
  const ctx = await makeEnv(); const api = makeApp();
  await api.call(ctx.env, "POST", "/orchestration/jobs", { kind: "ledger.sync" });
  await api.call(ctx.env, "POST", "/orchestration/jobs", { kind: "n8n.sync" });
  await tick(ctx.env.DB, ctx.env, defaultHandlers());
  return { ...ctx, ...api };
}

describe("API: authentication", () => {
  it("health is public, everything else requires the owner", async () => {
    const { env } = await makeEnv(); const { call } = makeApp();
    expect((await call(env, "GET", "/health", undefined, {})).status).toBe(200);
    const r = await call(env, "GET", "/portfolio/summary", undefined, {});
    expect(r.status).toBe(401);
    expect((await call(env, "GET", "/portfolio/summary", undefined, { "x-forge-dev-token": "wrong-token-wrong-token" })).status).toBe(401);
  });
});

describe("API: portfolio honesty (Milestone 1 acceptance)", () => {
  it("shows the genuine state: three niches, $0 verified revenue, test orders separate, all blocked from taking payment", async () => {
    const { env, call } = await synced();
    const { json } = await call(env, "GET", "/portfolio/summary?period=all");
    const d = json.data;
    expect(d.niches.map((n: any) => n.id).sort()).toEqual(["bidline", "loaf-ledger", "quilt-plan-kit"]);
    expect(d.totals.revenue).toMatchObject({ value: 0, state: "verified" });
    expect(d.totals.testOrders).toMatchObject({ value: 2, state: "test_only" });
    expect(d.totals.pageViews).toMatchObject({ value: 37, state: "verified" });
    expect(d.niches.every((n: any) => n.canTakePayment === false && n.health === "blocked")).toBe(true);
    expect(d.totals.activeVerifiedChannels.value).toBe(1); // QPK Pinterest only
  });

  it("names every missing integration instead of showing zeros", async () => {
    const { env, call } = await synced();
    const { json } = await call(env, "GET", "/portfolio/summary");
    const u = json.data.unknowns.join(" | ");
    for (const s of ["Lemon Squeezy", "Search Console", "KDP", "n8n"]) expect(u).toContain(s);
    const sources = json.meta.sources;
    expect(sources.find((s: any) => s.id === "ledger.d1")).toMatchObject({ mode: "snapshot", asOf: "2026-11-10T02:13:00Z" });
    expect(sources.find((s: any) => s.id === "lemonsqueezy").mode).toBe("unconnected");
  });

  it("every metric in every read endpoint carries period and freshness, and none is fabricated", async () => {
    const { env, call } = await synced();
    for (const path of ["/portfolio/summary", "/niches", "/niches/bidline", "/niches/quilt-plan-kit", "/niches/loaf-ledger", "/financials?niche=bidline", "/jobs"]) {
      const { status, json } = await call(env, "GET", path);
      expect(status, path).toBe(200);
      const ms = collectMetrics(json.data);
      expect(ms.length, path).toBeGreaterThan(0);
      for (const m of ms) {
        expect(m.period?.label, path).toBeTruthy();
        expect("asOf" in m && "source" in m, path).toBe(true);
        if (m.value === null) expect(["unknown", "unconnected"], `${path} ${m.source}`).toContain(m.state);
      }
    }
  });

  it("before any sync, revenue is 'unconnected', not $0", async () => {
    const { env } = await makeEnv(); const { call } = makeApp();
    const { json } = await call(env, "GET", "/portfolio/summary");
    expect(json.data.totals.revenue).toMatchObject({ value: null, state: "unconnected" });
  });

  it("niche detail shows the Bidline kit failure and price mismatch", async () => {
    const { env, call } = await synced();
    const { json } = await call(env, "GET", "/niches/bidline");
    const kit = json.data.products.find((p: any) => p.id === "prd_bidline_kit");
    expect(kit).toMatchObject({ status: "FAILED", priceMismatch: true, checkoutStatus: "test_mode" });
    expect(kit.evidence.length).toBeGreaterThan(0);
    expect((await call(env, "GET", "/niches/nope")).status).toBe(404);
  });

  it("job registry shows real last-success times from n8n and 'never_observed' where FORGE has no run record", async () => {
    const { env, call } = await synced();
    const jobs = (await call(env, "GET", "/jobs")).json.data;
    const health = jobs.find((j: any) => j.id === "N8N-02");
    expect(health.lastSuccess.startedAt).toBe("2026-11-10T00:07:21.126Z");
    expect(jobs.find((j: any) => j.id === "CF-01").heartbeat).toBe("never_observed");
  });

  it("judges snapshot runs at snapshot time while the snapshot is fresh, and says 'stale' once it is old (QA-002 R2)", async () => {
    const { env, call } = await synced();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-10T02:20:00Z"));
      expect((await call(env, "GET", "/jobs")).json.data.find((j: any) => j.id === "N8N-02").heartbeat).toBe("ok");
      vi.setSystemTime(new Date("2026-11-20T00:00:00Z"));
      const jobs = (await call(env, "GET", "/jobs")).json.data;
      expect(jobs.find((j: any) => j.id === "N8N-02").heartbeat).toBe("stale");
      expect(jobs.some((j: any) => j.runner === "n8n" && j.heartbeat === "ok")).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("shows Loaf Ledger page views as unconnected because the site has no beacon (QA-002 R7)", async () => {
    const { env, call } = await synced();
    const loaf = (await call(env, "GET", "/portfolio/summary?period=all")).json.data.niches.find((n: any) => n.id === "loaf-ledger");
    expect(loaf.pageViews).toMatchObject({ value: null, state: "unconnected" });
  });

  it("sets security headers on every response, including errors (QA-002 R6)", async () => {
    const { env } = await makeEnv(); const { call } = makeApp();
    for (const r of [await call(env, "GET", "/health", undefined, {}), await call(env, "GET", "/portfolio/summary", undefined, {}), await call(env, "GET", "/nope")]) {
      const h = (r as any).headers as Headers;
      expect(h.get("x-content-type-options")).toBe("nosniff");
      expect(h.get("x-frame-options")).toBe("DENY");
      expect(h.get("cache-control")).toBe("no-store");
    }
  });
});

describe("API: controls", () => {
  it("only pauses jobs FORGE can actually stop", async () => {
    const { env, call } = await synced();
    expect((await call(env, "POST", "/jobs/N8N-02/pause")).status).toBe(409);
    const r = await call(env, "POST", "/jobs/FORGE-WATCHDOG/pause");
    expect(r.json.data).toEqual({ id: "FORGE-WATCHDOG", paused: true });
    const job = (await call(env, "GET", "/jobs")).json.data.find((j: any) => j.id === "FORGE-WATCHDOG");
    expect(job.heartbeat).toBe("paused");
    const audit = await env.DB.prepare("SELECT action FROM audit_log WHERE subject='FORGE-WATCHDOG'").first<any>();
    expect(audit.action).toBe("job.pause");
  });

  it("refuses to promote a status to LIVE without evidence, accepts it with evidence and records history", async () => {
    const { env, call } = await synced();
    expect((await call(env, "POST", "/status", { subjectType: "product", subjectId: "prd_qpk_planner", toStatus: "LIVE" })).status).toBe(422);
    const ok = await call(env, "POST", "/status", { subjectType: "product", subjectId: "prd_qpk_planner", toStatus: "LIVE", evidence: { claim: "Live order 1 recorded and delivered", source: "ledger.d1", url: "https://example.test/order/1" } });
    expect(ok.status).toBe(200);
    const h = await env.DB.prepare("SELECT from_status, to_status, evidence_id FROM status_history").first<any>();
    expect(h.from_status).toBe("TESTED"); expect(h.to_status).toBe("LIVE"); expect(h.evidence_id).toBeTruthy();
  });

  it("emergency stop halts the scheduler; resume re-queues paused work", async () => {
    const { env, call } = await synced();
    await call(env, "POST", "/control/emergency-stop", { reason: "test" });
    expect((await call(env, "GET", "/control")).json.data.globalPause).toBe(true);
    await call(env, "POST", "/orchestration/jobs", { kind: "heartbeat.watchdog" });
    expect((await call(env, "POST", "/orchestration/tick")).json.data).toEqual([]);
    await call(env, "POST", "/control/resume");
    expect((await call(env, "POST", "/orchestration/tick")).json.data[0].outcome).toBe("succeeded");
  });

  it("manual tick is refused outside development", async () => {
    const { env } = await makeEnv({ environment: "staging" }); const { call } = makeApp();
    // dev token itself is refused in staging, so this is rejected at auth
    expect((await call(env, "POST", "/orchestration/tick")).status).toBe(401);
  });

  it("accepts only correctly signed heartbeats", async () => {
    const { env, call } = await synced();
    const body = JSON.stringify({ registryId: "N8N-02", startedAt: "2026-11-10T03:07:21Z", finishedAt: "2026-11-10T03:07:23Z", status: "success", externalId: "560" });
    const bad = await makeApp().app.fetch(new Request("http://t/api/v1/ingest/heartbeat", { method: "POST", body, headers: { "x-forge-signature": "0".repeat(64) } }), env);
    expect(bad.status).toBe(401);
    const sig = await hmacSha256Hex(env.HEARTBEAT_SECRET!, body);
    const good = await makeApp().app.fetch(new Request("http://t/api/v1/ingest/heartbeat", { method: "POST", body, headers: { "x-forge-signature": sig } }), env);
    expect(good.status).toBe(201);
    const runs = (await call(env, "GET", "/jobs/N8N-02/runs")).json.data;
    expect(runs[0]).toMatchObject({ startedAt: "2026-11-10T03:07:21Z", source: "heartbeat" });
  });

  it("account directory never returns secret-like fields", async () => {
    const { env, call } = await synced();
    const accts = (await call(env, "GET", "/accounts")).json.data;
    expect(accts.length).toBeGreaterThan(3);
    for (const a of accts) expect(Object.keys(a).sort()).toEqual(["id", "identifier", "nicheId", "notes", "owner", "passwordManagerRef", "service", "status", "url"]);
  });

  it("opportunity and build boards are honestly empty until real runs exist; briefs are schema-validated", async () => {
    const { env, call } = await synced();
    expect((await call(env, "GET", "/opportunities")).json.data).toMatchObject({ state: "not_run", opportunities: [] });
    expect((await call(env, "GET", "/builds")).json.data).toMatchObject({ state: "none", builds: [] });
    const bad = await call(env, "POST", "/briefs", { niche: "bidline" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.details.length).toBeGreaterThan(0);
  });
});

describe("API 1.1 additions", () => {
  it("alerts carry an explicit needsOwner flag", async () => {
    const { env, call } = await synced();
    const alerts = (await call(env, "GET", "/alerts?state=open")).json.data;
    expect(alerts.find((a: any) => a.id === "al_ls_test").needsOwner).toBe(true);
    expect(alerts.find((a: any) => a.id === "al_bidline_kit").needsOwner).toBe(false);
  });
  it("daily series: verified zeros where the ledger is connected, null after its asOf, unknown where unattributable", async () => {
    const { env, call } = await synced();
    const pv = (await call(env, "GET", "/series?metric=page_views&period=2026-11")).json.data;
    expect(pv.state).toBe("verified");
    expect(pv.points.reduce((a: number, p: any) => a + (p.value ?? 0), 0)).toBe(37);
    expect(pv.points.at(-1).date <= new Date().toISOString().slice(0, 10)).toBe(true); // never extends into the future
    const rev = (await call(env, "GET", "/series?metric=revenue&niche=bidline&period=2026-11")).json.data;
    expect(rev.points.find((p: any) => p.date === "2026-11-07").value).toBe(0); // test order excluded
    expect((await call(env, "GET", "/series?metric=page_views&niche=loaf-ledger")).json.data.state).toBe("unknown");
    expect((await call(env, "GET", "/series?metric=bogus")).status).toBe(400);
  });
});

describe("builder integration", () => {
  it("accepts the three builder job kinds and ties them to registry entries", async () => {
    const { env } = await makeEnv(); const { call } = makeApp();
    for (const kind of ["builder.blueprint.generate", "builder.build.plan", "builder.build.evaluate"]) {
      const r = await call(env, "POST", "/orchestration/jobs", { kind, input: {} });
      expect(r.status, kind).toBe(201);
    }
    const ids = (await env.DB.prepare(`SELECT registry_id FROM jobs ORDER BY registry_id`).all<{ registry_id: string }>()).results.map((r) => r.registry_id);
    expect(ids).toEqual(["FORGE-BUILDER-BLUEPRINT", "FORGE-BUILDER-EVALUATE", "FORGE-BUILDER-PLAN"]);
  });
});

describe("enqueue guards", () => {
  it("refuses a job whose registry entry is not loaded, with a clear message", async () => {
    const { env } = await makeEnv({ seed: false }); const { call } = makeApp();
    const r = await call(env, "POST", "/orchestration/jobs", { kind: "ledger.sync" });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/registry.seed/);
  });
});

describe("scheduler entry (cron)", () => {
  it("enqueues the recurring jobs idempotently per slot and runs them", async () => {
    const { env } = await makeEnv({ seed: false });
    const now = new Date();
    await scheduledTick(env, now); await scheduledTick(env, now);
    const jobs = (await env.DB.prepare("SELECT kind, status FROM jobs ORDER BY kind").all<any>()).results;
    expect(jobs).toEqual([{ kind: "heartbeat.watchdog", status: "succeeded" }, { kind: "ledger.sync", status: "succeeded" }, { kind: "n8n.sync", status: "succeeded" }]);
  });
});

describe("heartbeat watchdog", () => {
  it("raises an alert when a LIVE job stops succeeding, and resolves it on recovery", async () => {
    const { env, call } = await synced();
    // Pretend wall clock is 2 days after the snapshot by clearing snapshot provenance on N8N-02's runs.
    await env.DB.prepare("UPDATE runs SET source='n8n.live' WHERE registry_id='N8N-02'").run();
    await call(env, "POST", "/orchestration/jobs", { kind: "heartbeat.watchdog", idempotencyKey: "w1" });
    await tick(env.DB, env, defaultHandlers(), { now: new Date("2026-11-12T00:00:00Z") });
    let a = await env.DB.prepare("SELECT state, severity FROM alerts WHERE dedupe_key='heartbeat:N8N-02'").first<any>();
    expect(a).toEqual({ state: "open", severity: "warning" });
    await env.DB.prepare("INSERT INTO runs (id,registry_id,started_at,finished_at,status,source,external_id) VALUES ('r','N8N-02','2026-11-11T23:07:00Z','2026-11-11T23:07:02Z','success','n8n.live','999')").run();
    await call(env, "POST", "/orchestration/jobs", { kind: "heartbeat.watchdog", idempotencyKey: "w2" });
    await tick(env.DB, env, defaultHandlers(), { now: new Date("2026-11-12T00:00:00Z") });
    a = await env.DB.prepare("SELECT state FROM alerts WHERE dedupe_key='heartbeat:N8N-02'").first<any>();
    expect(a.state).toBe("resolved");
  });
});
