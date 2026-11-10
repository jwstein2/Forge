import { describe, expect, it } from "vitest";
import { makeEnv } from "./helpers.ts";
import { claimNext, decideApproval, enqueue, getJob, runJob, tick, backoffMs, NonRetryableError, type HandlerDef } from "../src/orchestration/engine.ts";

function harness(over: Partial<Record<string, (n: number) => Promise<any>>> = {}) {
  const calls = { a: 0, b: 0 };
  const h: HandlerDef = {
    kind: "test.two_step", registryId: "FORGE-WATCHDOG",
    steps: [
      { name: "a", run: async () => { calls.a++; return over.a ? over.a(calls.a) : { output: { fromA: 42 }, costCents: 1 }; } },
      { name: "b", run: async (ctx) => { calls.b++; if (over.b) return over.b(calls.b); return { output: { sawA: (ctx.outputs.a as any)?.fromA } }; } },
    ],
  };
  return { calls, handlers: new Map([[h.kind, h]]), h };
}

describe("durable job engine", () => {
  it("enqueue is idempotent", async () => {
    const { env } = await makeEnv(); const { handlers } = harness();
    const a = await enqueue(env.DB, handlers, { kind: "test.two_step", idempotencyKey: "k", createdBy: "t" });
    const b = await enqueue(env.DB, handlers, { kind: "test.two_step", idempotencyKey: "k", createdBy: "t" });
    expect(b).toEqual({ id: a.id, created: false });
  });

  it("runs steps in order, passes checkpoints forward, and records a run as heartbeat evidence", async () => {
    const { env } = await makeEnv(); const { handlers } = harness();
    const { id } = await enqueue(env.DB, handlers, { kind: "test.two_step", createdBy: "t" });
    expect(await tick(env.DB, env, handlers)).toEqual([{ jobId: id, outcome: "succeeded" }]);
    const job = await getJob(env.DB, id);
    expect(job!.output).toEqual({ a: { fromA: 42 }, b: { sawA: 42 } });
    const run = await env.DB.prepare("SELECT status, evidence_url FROM runs WHERE source='forge'").first<any>();
    expect(run).toEqual({ status: "success", evidence_url: `forge://jobs/${id}` });
  });

  it("retries with backoff and does NOT re-execute a checkpointed step (survives interruption)", async () => {
    const { env } = await makeEnv();
    const { handlers, calls } = harness({ b: async (n) => { if (n === 1) throw new Error("transient 503"); return { output: "ok" }; } });
    const { id } = await enqueue(env.DB, handlers, { kind: "test.two_step", createdBy: "t" });
    const t0 = new Date("2026-11-10T03:00:00Z");
    await env.DB.prepare("UPDATE jobs SET next_run_at=? WHERE id=?").bind(t0.toISOString(), id).run();
    expect((await tick(env.DB, env, handlers, { now: t0 }))[0]!.outcome).toBe("retry_scheduled");
    let job = await getJob(env.DB, id);
    expect(job!.status).toBe("queued");
    expect(Date.parse(job!.nextRunAt!)).toBe(t0.getTime() + backoffMs(1));
    expect(await tick(env.DB, env, handlers, { now: t0 })).toEqual([]); // not yet due
    const t1 = new Date(t0.getTime() + backoffMs(1) + 1);
    expect((await tick(env.DB, env, handlers, { now: t1 }))[0]!.outcome).toBe("succeeded");
    expect(calls).toEqual({ a: 1, b: 2 });
    job = await getJob(env.DB, id);
    expect(job!.attempts).toBe(2);
  });

  it("fails terminally after max attempts and raises one deduplicated alert", async () => {
    const { env } = await makeEnv();
    const { handlers } = harness({ a: async () => { throw new Error("down"); } });
    const { id } = await enqueue(env.DB, handlers, { kind: "test.two_step", maxAttempts: 2, createdBy: "t" });
    const far = new Date("2030-01-01T00:00:00Z");
    await tick(env.DB, env, handlers, { now: far }); await tick(env.DB, env, handlers, { now: new Date(far.getTime() + 3600001) });
    expect((await getJob(env.DB, id))!.status).toBe("failed");
    const alerts = (await env.DB.prepare("SELECT * FROM alerts WHERE source='orchestration'").all()).results;
    expect(alerts).toHaveLength(1);
  });

  it("non-retryable errors and cost-cap breaches fail immediately", async () => {
    const { env } = await makeEnv();
    const { handlers } = harness({ a: async () => ({ output: 1, costCents: 500 }) });
    const { id } = await enqueue(env.DB, handlers, { kind: "test.two_step", costCapCents: 100, createdBy: "t" });
    await tick(env.DB, env, handlers);
    const job = await getJob(env.DB, id);
    expect(job!.status).toBe("failed");
    expect(job!.error).toMatch(/cost cap/);
    const { handlers: h2 } = harness({ a: async () => { throw new NonRetryableError("bad input"); } });
    const j2 = await enqueue(env.DB, h2, { kind: "test.two_step", createdBy: "t" });
    await tick(env.DB, env, h2);
    expect((await getJob(env.DB, j2.id))!.attempts).toBe(1);
  });

  it("recovers a job whose worker died (expired lease)", async () => {
    const { env } = await makeEnv(); const { handlers } = harness();
    const { id } = await enqueue(env.DB, handlers, { kind: "test.two_step", createdBy: "t" });
    const t0 = new Date();
    const claimed = await claimNext(env.DB, "worker-that-crashes", t0, 1000);
    expect(claimed!.id).toBe(id);
    expect(await claimNext(env.DB, "w2", new Date(t0.getTime() + 500))).toBeNull(); // lease still held
    const later = new Date(t0.getTime() + 5000);
    const out = await tick(env.DB, env, handlers, { now: later, workerId: "w2" });
    expect(out).toEqual([{ jobId: id, outcome: "succeeded" }]);
    const ev = (await env.DB.prepare("SELECT type FROM job_events WHERE job_id=? ORDER BY at").bind(id).all<any>()).results.map((e) => e.type);
    expect(ev).toContain("lease_expired_reclaimed");
  });

  it("consequential work waits for an owner approval", async () => {
    const { env } = await makeEnv();
    const h: HandlerDef = { kind: "test.spend", requiresApproval: () => "spend:domain", steps: [{ name: "buy", run: async () => ({ output: "bought" }) }] };
    const handlers = new Map([[h.kind, h]]);
    const { id } = await enqueue(env.DB, handlers, { kind: "test.spend", createdBy: "t" });
    expect((await tick(env.DB, env, handlers))[0]!.outcome).toBe("waiting_approval");
    expect(await tick(env.DB, env, handlers)).toEqual([]);
    const ap = await env.DB.prepare("SELECT id, status FROM approvals").first<any>();
    expect(ap.status).toBe("pending");
    await decideApproval(env.DB, ap.id, true);
    expect((await tick(env.DB, env, handlers))[0]!.outcome).toBe("succeeded");
    expect((await getJob(env.DB, id))!.attempts).toBe(1);
  });

  it("respects dependencies, the global emergency stop, and niche pauses", async () => {
    const { env } = await makeEnv(); const { handlers } = harness();
    const first = await enqueue(env.DB, handlers, { kind: "test.two_step", createdBy: "t", priority: 200 });
    const second = await enqueue(env.DB, handlers, { kind: "test.two_step", createdBy: "t", priority: 1, dependsOn: [first.id] });
    const order = (await tick(env.DB, env, handlers)).map((o) => o.jobId);
    expect(order).toEqual([first.id, second.id]);

    await env.DB.prepare("UPDATE system_controls SET value_json='{\"paused\":true}' WHERE key='global_pause'").run();
    await enqueue(env.DB, handlers, { kind: "test.two_step", createdBy: "t" });
    expect(await tick(env.DB, env, handlers)).toEqual([]);
    await env.DB.prepare("UPDATE system_controls SET value_json='{\"paused\":false}' WHERE key='global_pause'").run();

    await env.DB.prepare("UPDATE niches SET paused=1 WHERE id='bidline'").run();
    const nicheJob = await enqueue(env.DB, handlers, { kind: "test.two_step", nicheId: "bidline", createdBy: "t" });
    const ran = (await tick(env.DB, env, handlers)).map((o) => o.jobId);
    expect(ran).not.toContain(nicheJob.id);
  });
});
