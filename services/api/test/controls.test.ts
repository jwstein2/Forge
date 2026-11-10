import { describe, expect, it } from "vitest";
import { makeEnv } from "./helpers.ts";
import { enqueue, getJob, tick, type HandlerDef } from "../src/orchestration/engine.ts";
import { defaultHandlers, runControlsOnDb } from "../src/orchestration/handlers.ts";
import { monthWindow } from "@forge/controls/engine";

const modelJob = (cap?: number): HandlerDef => ({
  kind: "test.model_job", registryId: "FORGE-WATCHDOG", runType: cap === undefined ? undefined : "specialist", usesModel: true,
  steps: [{ name: "call", run: async () => ({ output: "drafted", costCents: 5 }) }],
});
const usage = async (db: D1Database, at: string, cents: number) =>
  db.prepare(`INSERT INTO op_llm_calls (id,job_id,purpose,provider,model,attempt,cost_cents,valid,at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(`llm_${at}_${cents}`, null, "t", "anthropic", "m", 1, cents, 1, at).run();

describe("default cost caps (workstream F)", () => {
  it("applies the cost model's cap when none is given; explicit caps win; unknown kinds stay uncapped", async () => {
    const { env } = await makeEnv(); const hs = defaultHandlers();
    const cap = async (kind: string, costCapCents?: number) => (await getJob(env.DB, (await enqueue(env.DB, hs, { kind, costCapCents, registryId: "FORGE-WATCHDOG", createdBy: "t" })).id))!.costCapCents;
    expect(await cap("ledger.sync")).toBe(0);
    expect(await cap("ops.content_draft")).toBe(300);
    expect(await cap("ops.content_draft", 40)).toBe(40);
    const custom = new Map([["test.unknown", { kind: "test.unknown", steps: [] } as HandlerDef]]);
    expect((await getJob(env.DB, (await enqueue(env.DB, custom, { kind: "test.unknown", createdBy: "t" })).id))!.costCapCents).toBeNull();
  });
});

describe("model spend guard", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  it("runs a model job inside the $15 envelope and records the authorisation", async () => {
    const { env } = await makeEnv(); const hs = new Map([["test.model_job", modelJob(300)]]);
    await usage(env.DB, "2026-11-05T00:00:00Z", 1000);
    await usage(env.DB, "2026-10-30T00:00:00Z", 5000); // last month: not counted
    const { id } = await enqueue(env.DB, hs, { kind: "test.model_job", createdBy: "t", runAt: now.toISOString() });
    expect(await tick(env.DB, env, hs, { now })).toEqual([{ jobId: id, outcome: "succeeded" }]);
    const ev = await env.DB.prepare(`SELECT detail FROM job_events WHERE job_id=? AND type='spend_authorized'`).bind(id).first<{ detail: string }>();
    expect(JSON.parse(ev!.detail)).toMatchObject({ code: "within_envelope", remainingCents: 200 });
  });
  it("defers to next month and raises an owner alert when the envelope would be exceeded; no step runs", async () => {
    const { env } = await makeEnv(); let ran = 0;
    const h = { ...modelJob(300), steps: [{ name: "call", run: async () => { ran++; return {}; } }] };
    const hs = new Map([[h.kind, h]]);
    await usage(env.DB, "2026-11-05T00:00:00Z", 1300);
    const { id } = await enqueue(env.DB, hs, { kind: h.kind, createdBy: "t", runAt: now.toISOString() });
    expect((await tick(env.DB, env, hs, { now }))[0]!.outcome).toBe("deferred_budget");
    expect(ran).toBe(0);
    const job = await getJob(env.DB, id);
    expect(job).toMatchObject({ status: "queued", nextRunAt: monthWindow(now).end, attempts: 0 });
    const a = await env.DB.prepare(`SELECT severity, needs_owner, state FROM alerts WHERE dedupe_key='fin:spend:envelope:2026-11'`).first<any>();
    expect(a).toEqual({ severity: "warning", needs_owner: 1, state: "open" });
    expect(await tick(env.DB, env, hs, { now })).toEqual([]); // not runnable again this month
  });
  it("fails a model job with no cost cap: unknown spend cannot be shown to fit", async () => {
    const { env } = await makeEnv(); const hs = new Map([["test.model_job", modelJob()]]);
    const { id } = await enqueue(env.DB, hs, { kind: "test.model_job", createdBy: "t", runAt: now.toISOString() });
    expect((await tick(env.DB, env, hs, { now }))[0]!.outcome).toBe("failed");
    expect((await getJob(env.DB, id))!.error).toMatch(/spend guard/);
  });
});

describe("ledger.sync runs the data controls", () => {
  it("raises the Bidline price mismatch as an owner alert from the real registry, then resolves it once fixed", async () => {
    const { env } = await makeEnv(); const hs = defaultHandlers();
    const { id } = await enqueue(env.DB, hs, { kind: "ledger.sync", createdBy: "t" });
    await tick(env.DB, env, hs);
    const job = await getJob(env.DB, id);
    expect(job!.status).toBe("succeeded");
    expect((job!.output as any).controls.codes).toContain("FIN-PR-01");
    const a = await env.DB.prepare(`SELECT severity, needs_owner, state FROM alerts WHERE dedupe_key='fin:price:site_vs_checkout:prd_bidline_kit'`).first<any>();
    expect(a).toEqual({ severity: "critical", needs_owner: 1, state: "open" });
    await env.DB.prepare(`UPDATE products SET checkout_price_cents = site_price_cents WHERE id='prd_bidline_kit'`).run();
    await runControlsOnDb(env.DB, [], new Date());
    expect((await env.DB.prepare(`SELECT state FROM alerts WHERE dedupe_key='fin:price:site_vs_checkout:prd_bidline_kit'`).first<any>()).state).toBe("resolved");
  });
  it("flags an unattributed live order as critical and does not touch other sources' alerts", async () => {
    const { env } = await makeEnv();
    await env.DB.prepare(`INSERT INTO alerts (id,severity,source,title,state,dedupe_key,first_seen,last_seen) VALUES ('x','warning','heartbeat.watchdog','t','open','heartbeat:N8N-02','t','t')`).run();
    await runControlsOnDb(env.DB, [{ id: "order_created:1", event: "order_created", order_id: "1", test_mode: 0, owner_test: 0, currency: "USD", total_cents: 800, tax_cents: 0, refunded_cents: 0, product: "Mystery", created_at: "2026-11-10T00:00:00Z", vertical: "unknown" }], new Date());
    expect((await env.DB.prepare(`SELECT severity FROM alerts WHERE dedupe_key='fin:ledger:unattributed:1'`).first<any>()).severity).toBe("critical");
    expect((await env.DB.prepare(`SELECT state FROM alerts WHERE id='x'`).first<any>()).state).toBe("open");
  });
});
