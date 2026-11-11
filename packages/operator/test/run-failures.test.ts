import { describe, expect, it } from "vitest";
import { enqueue } from "../../../services/api/src/orchestration/engine.ts";
import { failureStates } from "../src/handlers/run-failures.ts";
import { OPERATOR_SCHEDULES, OPERATOR_REGISTRY_ENTRIES } from "../src/index.ts";
import { handlersWith, makeEnv, run } from "./helpers.ts";

const PAST = "2000-01-01T00:00:00.000Z";
const q = async (db: D1Database, sql: string) => (await db.prepare(sql).all<Record<string, any>>()).results;
const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();
let n = 0;
const addRun = (db: D1Database, reg: string, status: string, finished: string, error: string | null = null, source = "heartbeat") =>
  db.prepare(`INSERT INTO runs (id,registry_id,started_at,finished_at,status,error,source,external_id) VALUES (?,?,?,?,?,?,?,?)`).bind(`run_t${++n}`, reg, finished, finished, status, error, source, `x${n}`).run();
/** A FORGE run the way the engine records it: external_id '<job id>:<attempt>', the job carrying the kind. */
const addJobRun = async (db: D1Database, reg: string, kind: string, status: string, finished: string, error: string | null = null) => {
  const job = `job_t${++n}`;
  await db.prepare(`INSERT INTO jobs (id,kind,registry_id,status,next_run_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(job, kind, reg, status === "success" ? "succeeded" : "failed", finished, "t", finished, finished).run();
  await db.prepare(`INSERT INTO runs (id,registry_id,started_at,finished_at,status,error,source,external_id) VALUES (?,?,?,?,?,?,'forge',?)`).bind(`run_t${n}`, reg, finished, finished, status, error, `${job}:1`).run();
};

async function evaluate(env: any, db: D1Database) {
  const h = handlersWith({});
  await enqueue(db, h, { runAt: PAST, kind: "ops.run_failures", createdBy: `t${++n}` });
  const r = await run(env, h);
  expect(r.map((x) => x.outcome)).toContain("succeeded");
  return JSON.parse((await q(db, `SELECT output_json FROM jobs WHERE kind='ops.run_failures' ORDER BY created_at DESC, rowid DESC LIMIT 1`))[0]!.output_json).evaluate;
}

describe("failed-run alerts", () => {
  it("computes the latest outcome and failure streak", () => {
    const rows = [
      { registry_id: "A", name: "A", niche_id: null, status: "failed", finished: "3", error: "boom", source: "heartbeat", rn: 1 },
      { registry_id: "A", name: "A", niche_id: null, status: "timeout", finished: "2", error: null, source: "heartbeat", rn: 2 },
      { registry_id: "A", name: "A", niche_id: null, status: "success", finished: "1", error: null, source: "heartbeat", rn: 3 },
      { registry_id: "B", name: "B", niche_id: null, status: "success", finished: "2", error: null, source: "forge", rn: 1 },
      { registry_id: "B", name: "B", niche_id: null, status: "failed", finished: "1", error: "x", source: "forge", rn: 2 },
    ];
    expect(failureStates(rows)).toEqual([
      { registryId: "A", kind: null, name: "A", nicheId: null, latest: "failed", streak: 2, lastError: "boom", at: "3", source: "heartbeat" },
      { registryId: "B", kind: null, name: "B", nicheId: null, latest: "success", streak: 0, lastError: null, at: "2", source: "forge" },
    ]);
  });

  it("alerts on a failed n8n run with its error, escalates after 3, and clears on the next success", async () => {
    const { env, db } = await makeEnv();
    await addRun(db, "N8N-02", "success", ago(400));
    await addRun(db, "N8N-02", "failed", ago(200), "HTTP Request node: 503 from quiltplankit.pages.dev");
    let out = await evaluate(env, db);
    expect(out.failing).toEqual(["N8N-02"]);
    let [a] = await q(db, `SELECT severity, state, title, detail FROM alerts WHERE dedupe_key='ops:run_failed:N8N-02'`);
    expect(a).toMatchObject({ severity: "warning", state: "open" });
    expect(a!.title).toContain("failed its last run");
    expect(a!.detail).toContain("503 from quiltplankit.pages.dev");
    expect(a!.detail).toContain("in n8n");

    await addRun(db, "N8N-02", "failed", ago(100), "again");
    await addRun(db, "N8N-02", "timeout", ago(50));
    await evaluate(env, db);
    [a] = await q(db, `SELECT severity, title FROM alerts WHERE dedupe_key='ops:run_failed:N8N-02'`);
    expect(a).toMatchObject({ severity: "critical" });
    expect(a!.title).toContain("failed 3 runs in a row");

    await addRun(db, "N8N-02", "success", ago(10));
    out = await evaluate(env, db);
    expect(out.failing).toEqual([]);
    expect((await q(db, `SELECT state FROM alerts WHERE dedupe_key='ops:run_failed:N8N-02'`))[0]!.state).toBe("resolved");
  });

  it("clears the engine's stale job-failure alert once the job succeeds again, but not a newer one", async () => {
    const { env, db } = await makeEnv();
    const ins = (key: string, lastSeen: string) => db.prepare(`INSERT INTO alerts (id,severity,source,title,state,dedupe_key,first_seen,last_seen) VALUES (?,?,?,?,'open',?,?,?)`).bind(`al_${key}`, "warning", "orchestration", "Job failed", key, lastSeen, lastSeen).run();
    const failedAt = ago(120);
    await ins("job:ops.site_health:OPS-SITE-HEALTH", failedAt);
    await ins("job:ops.seo_audit:OPS-SEO-AUDIT", ago(5));
    await addJobRun(db, "OPS-SITE-HEALTH", "ops.site_health", "success", ago(30));
    await addJobRun(db, "OPS-SEO-AUDIT", "ops.seo_audit", "success", ago(60));
    const out = await evaluate(env, db);
    expect(out.staleJobAlertsCleared).toBe(1);
    const [cleared] = await q(db, `SELECT state, last_seen, detail FROM alerts WHERE dedupe_key='job:ops.site_health:OPS-SITE-HEALTH'`);
    expect(cleared!.state).toBe("resolved");
    expect(cleared!.last_seen).toBe(failedAt); // failure time kept (QA-018 R4-2)
    expect(cleared!.detail).toContain("a later run succeeded");
    expect((await q(db, `SELECT state FROM alerts WHERE dedupe_key='job:ops.seo_audit:OPS-SEO-AUDIT'`))[0]!.state).toBe("open");
  });

  it("keeps job kinds that share a registry entry apart (QA-018 R4-1)", async () => {
    const { env, db } = await makeEnv();
    const ins = (key: string, lastSeen: string) => db.prepare(`INSERT INTO alerts (id,severity,source,title,state,dedupe_key,first_seen,last_seen) VALUES (?,?,?,?,'open',?,?,?)`).bind(`al_${key}`, "warning", "orchestration", "Job failed", key, lastSeen, lastSeen).run();
    await addJobRun(db, "OPS-SEO-AUDIT", "ops.seo_batch", "failed", ago(40), "Too many subrequests");
    await ins("job:ops.seo_batch:OPS-SEO-AUDIT", ago(40));
    await addJobRun(db, "OPS-SEO-AUDIT", "ops.seo_finalize", "success", ago(20));
    const out = await evaluate(env, db);
    expect(out.failing).toEqual(["OPS-SEO-AUDIT:ops.seo_batch"]);
    expect(out.staleJobAlertsCleared).toBe(0);
    expect((await q(db, `SELECT state FROM alerts WHERE dedupe_key='job:ops.seo_batch:OPS-SEO-AUDIT'`))[0]!.state).toBe("open");
    const [a] = await q(db, `SELECT title, detail FROM alerts WHERE dedupe_key='ops:run_failed:OPS-SEO-AUDIT:ops.seo_batch'`);
    expect(a!.title).toContain("(ops.seo_batch) failed its last run");
    expect(a!.detail).toContain("in FORGE: Too many subrequests");
  });

  it("closes a failure alert, with a note, once its entry has no runs left in the window (QA-018 R4-2)", async () => {
    const { env, db } = await makeEnv();
    await db.prepare(`INSERT INTO alerts (id,severity,source,title,detail,state,dedupe_key,first_seen,last_seen) VALUES ('al_old','warning','ops.run_failures','N8N-05 failed its last run','Last run finished long ago.','open','ops:run_failed:N8N-05',?,?)`).bind(ago(30 * 1440), ago(20 * 1440)).run();
    await addRun(db, "N8N-05", "failed", ago(20 * 1440), "old");
    const out = await evaluate(env, db);
    expect(out.agedOut).toBe(1);
    const [a] = await q(db, `SELECT state, detail FROM alerts WHERE dedupe_key='ops:run_failed:N8N-05'`);
    expect(a).toMatchObject({ state: "resolved" });
    expect(a!.detail).toContain("no finished run in the last 14 days");
  });

  it("sorts runs reported with a local offset by their real time", async () => {
    const { env, db } = await makeEnv();
    const t = new Date(Date.now() - 60 * 60000);
    const local = new Date(t.getTime() - 6 * 3600000).toISOString().replace("Z", "-06:00"); // same instant as t, written in UTC-6
    await addRun(db, "N8N-03", "failed", new Date(t.getTime() - 30 * 60000).toISOString(), "older failure");
    await addRun(db, "N8N-03", "success", local);
    const out = await evaluate(env, db);
    expect(out.failing).toEqual([]);
  });

  it("is scheduled every 30 minutes and registered", () => {
    expect(OPERATOR_SCHEDULES.find((s) => s.id === "OPS-RUN-FAILURES")).toMatchObject({ kind: "ops.run_failures", spec: { every: 30 } });
    expect(OPERATOR_REGISTRY_ENTRIES.find((e) => e.id === "OPS-RUN-FAILURES")).toMatchObject({ externalRef: "ops.run_failures", intervalMinutes: 30 });
  });
});
