/**
 * FORGE durable job engine.
 *
 * Why: the owner wants work that continues without an open conversation. State therefore lives in the
 * database, not in a process: any worker (Cloudflare cron tick, local dev loop, a future queue consumer)
 * can claim a job, and a crashed worker's job is recovered when its lease expires.
 *
 * Guarantees:
 *  - Idempotent enqueue (idempotency_key).
 *  - Atomic claim with a lease; expired leases are reclaimable (crash recovery).
 *  - Per-step checkpoints: on retry/resume, succeeded steps are replayed from their checkpoint, not re-executed.
 *  - Bounded retries with exponential backoff; terminal failure raises a deduplicated alert.
 *  - Cost cap per job; exceeding it fails the job without retry.
 *  - Kill switches checked before claiming and between steps: global pause, niche pause, registry-entry pause.
 *  - Consequential work waits for an owner approval record before it runs.
 *  - Dependencies: a job runs only after every job it depends on has succeeded.
 */
import type { Env } from "../lib/env.ts";
import { newId, nowIso, parseJson } from "../lib/util.ts";
import { API_ENVELOPE_BUDGET_ID, authorizeSpend, defaultCapFor, isMissingTable, monthWindow, resolveJobPolicy } from "@forge/controls/engine";

export interface StepContext {
  db: D1Database; env: Env; jobId: string; input: Record<string, unknown>;
  outputs: Record<string, unknown>;     // checkpoints of earlier steps, by step name
  now: Date;
}
export interface StepResult { output?: unknown; costCents?: number }
export interface StepDef { name: string; run(ctx: StepContext): Promise<StepResult | void> }
export interface HandlerDef {
  kind: string;
  steps: StepDef[];
  /** Return an approval scope when this input needs the owner's explicit approval before running. */
  requiresApproval?(input: Record<string, unknown>): string | null;
  /** Registry entry that this handler's runs are recorded against (heartbeat evidence). */
  registryId?: string;
  /** Cost policy (@forge/controls): run type sets the default cost cap; usesModel puts the job under the monthly model envelope. */
  runType?: string;
  usesModel?: boolean;
}
export class NonRetryableError extends Error {}
export class EnqueueError extends Error {}

export interface EnqueueOptions {
  kind: string; input?: Record<string, unknown>; nicheId?: string | null; registryId?: string | null;
  idempotencyKey?: string; maxAttempts?: number; costCapCents?: number | null; runAt?: string;
  priority?: number; dependsOn?: string[]; parentId?: string; createdBy: string;
}

export async function event(db: D1Database, jobId: string, type: string, detail?: unknown): Promise<void> {
  await db.prepare(`INSERT INTO job_events (id,job_id,at,type,detail) VALUES (?,?,?,?,?)`)
    .bind(newId("jev"), jobId, nowIso(), type, detail === undefined ? null : JSON.stringify(detail)).run();
}

/** Default priority by kind (lower runs first). Time-sensitive monitors must not queue behind batch work (QA-008 ST4). */
export const KIND_PRIORITY: Record<string, number> = { "heartbeat.watchdog": 10, "ops.site_health": 20, "ledger.sync": 30, "n8n.sync": 30 };

export async function enqueue(db: D1Database, handlers: Map<string, HandlerDef>, o: EnqueueOptions): Promise<{ id: string; created: boolean }> {
  const h = handlers.get(o.kind);
  if (!h) throw new Error(`unknown job kind: ${o.kind}`);
  if (o.idempotencyKey) {
    const existing = await db.prepare(`SELECT id FROM jobs WHERE idempotency_key = ?`).bind(o.idempotencyKey).first<{ id: string }>();
    if (existing) return { id: existing.id, created: false };
  }
  const registryId = o.registryId ?? h.registryId ?? null;
  if (registryId && !(await db.prepare(`SELECT 1 AS x FROM registry_entries WHERE id = ?`).bind(registryId).first())) {
    throw new EnqueueError(`registry entry ${registryId} is not loaded; run the registry.seed job first`);
  }
  const id = newId("job"); const at = nowIso();
  const costCap = defaultCapFor(o.kind, o.costCapCents, { runType: h.runType, usesModel: h.usesModel });
  const stmts = [db.prepare(`INSERT INTO jobs (id,kind,niche_id,registry_id,status,priority,idempotency_key,input_json,max_attempts,next_run_at,cost_cap_cents,parent_id,created_by,created_at,updated_at)
    VALUES (?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?)`).bind(id, o.kind, o.nicheId ?? null, registryId, o.priority ?? KIND_PRIORITY[o.kind] ?? 100,
    o.idempotencyKey ?? null, JSON.stringify(o.input ?? {}), o.maxAttempts ?? 3, o.runAt ?? at, costCap, o.parentId ?? null, o.createdBy, at, at)];
  h.steps.forEach((s, i) => stmts.push(db.prepare(`INSERT INTO job_steps (job_id,seq,name,status) VALUES (?,?,?,'pending')`).bind(id, i, s.name)));
  for (const d of o.dependsOn ?? []) stmts.push(db.prepare(`INSERT INTO job_dependencies (job_id,depends_on_id) VALUES (?,?)`).bind(id, d));
  await db.batch(stmts);
  await event(db, id, "enqueued", { kind: o.kind, by: o.createdBy });
  return { id, created: true };
}

export async function globalPaused(db: D1Database): Promise<boolean> {
  const r = await db.prepare(`SELECT value_json FROM system_controls WHERE key = 'global_pause'`).first<{ value_json: string }>();
  return parseJson<{ paused?: boolean }>(r?.value_json, {}).paused === true;
}

interface JobRow { id: string; kind: string; niche_id: string | null; registry_id: string | null; status: string; input_json: string; attempts: number; max_attempts: number; cost_cap_cents: number | null; cost_cents: number; approval_id: string | null }

/** Claim the next runnable job. Returns null when nothing is runnable or the system is paused. */
export async function claimNext(db: D1Database, workerId: string, now: Date, leaseMs = 5 * 60000): Promise<JobRow | null> {
  if (await globalPaused(db)) return null;
  const t = now.toISOString();
  const candidates = (await db.prepare(`
    SELECT j.* FROM jobs j
    LEFT JOIN niches n ON n.id = j.niche_id
    LEFT JOIN registry_entries r ON r.id = j.registry_id
    WHERE ((j.status = 'queued' AND j.next_run_at <= ?) OR (j.status = 'running' AND j.lease_expires_at < ?))
      AND COALESCE(n.paused, 0) = 0 AND COALESCE(r.paused, 0) = 0
      AND NOT EXISTS (SELECT 1 FROM job_dependencies d JOIN jobs dj ON dj.id = d.depends_on_id WHERE d.job_id = j.id AND dj.status <> 'succeeded')
    ORDER BY j.priority ASC, j.next_run_at ASC LIMIT 5`).bind(t, t).all<JobRow>()).results;
  for (const c of candidates) {
    const recovered = c.status === "running";
    const res = await db.prepare(`UPDATE jobs SET status='running', lease_owner=?, lease_expires_at=?, attempts=attempts+1, updated_at=?
      WHERE id=? AND ((status='queued' AND next_run_at <= ?) OR (status='running' AND lease_expires_at < ?))`)
      .bind(workerId, new Date(now.getTime() + leaseMs).toISOString(), t, c.id, t, t).run();
    if (Number(res.meta.changes) === 1) {
      await event(db, c.id, recovered ? "lease_expired_reclaimed" : "claimed", { workerId });
      return { ...c, status: "running", attempts: c.attempts + 1 };
    }
  }
  return null;
}

export const backoffMs = (attempt: number): number => Math.min(3600000, 30000 * 2 ** Math.max(0, attempt - 1));

async function raiseJobAlert(db: D1Database, job: JobRow, message: string): Promise<void> {
  const at = nowIso();
  await db.prepare(`INSERT INTO alerts (id,severity,niche_id,source,title,detail,state,dedupe_key,first_seen,last_seen,next_action)
    VALUES (?,?,?,?,?,?,'open',?,?,?,?) ON CONFLICT(dedupe_key) DO UPDATE SET last_seen=excluded.last_seen, detail=excluded.detail, state='open'`)
    .bind(newId("al"), "warning", job.niche_id, "orchestration", `Job ${job.kind} failed after ${job.attempts} attempt(s)`, message.slice(0, 500), `job:${job.kind}:${job.registry_id ?? job.id}`, at, at, "Check job events; the next scheduled run will retry.").run();
}

async function recordRun(db: D1Database, job: JobRow, startedAt: string, status: "success" | "failed", error: string | null, costCents: number): Promise<void> {
  if (!job.registry_id) return;
  await db.prepare(`INSERT INTO runs (id,registry_id,started_at,finished_at,status,evidence_url,model_cost_cents,error,source,external_id) VALUES (?,?,?,?,?,?,?,?,'forge',?)`)
    .bind(newId("run"), job.registry_id, startedAt, nowIso(), status, `forge://jobs/${job.id}`, Math.round(costCents), error, `${job.id}:${job.attempts}`).run();
}

export async function runJob(db: D1Database, env: Env, handlers: Map<string, HandlerDef>, job: JobRow, now = new Date()): Promise<string> {
  const h = handlers.get(job.kind);
  const startedAt = nowIso();
  if (!h) { await finish(db, job, "failed", `no handler for ${job.kind}`); return "failed"; }

  const scope = h.requiresApproval?.(parseJson(job.input_json, {}));
  if (scope) {
    const ap = job.approval_id ? await db.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(job.approval_id).first<{ status: string }>() : null;
    if (ap?.status !== "approved") {
      let approvalId = job.approval_id;
      if (!approvalId) {
        approvalId = newId("apr");
        await db.prepare(`INSERT INTO approvals (id,scope,action,status,requested_by,boundary_json,created_at) VALUES (?,?,?,'pending',?,?,?)`)
          .bind(approvalId, scope, job.kind, `job:${job.id}`, job.input_json, nowIso()).run();
      }
      await db.prepare(`UPDATE jobs SET status='waiting_approval', approval_id=?, attempts=attempts-1, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`).bind(approvalId, nowIso(), job.id).run();
      await event(db, job.id, "waiting_approval", { scope, approvalId });
      return "waiting_approval";
    }
  }

  // Spend guard (@forge/controls): a job that calls a model runs only if its cost cap fits the remaining monthly
  // model envelope (budget bud_api_month), measured from op_llm_calls. Checked once, before the first step runs.
  const policy = resolveJobPolicy(job.kind, { runType: h.runType, usesModel: h.usesModel });
  if (policy?.usesModel) {
    const started = await db.prepare(`SELECT COUNT(*) AS n FROM job_steps WHERE job_id = ? AND status = 'succeeded'`).bind(job.id).first<{ n: number }>();
    if (Number(started?.n ?? 0) === 0) {
      const verdict = await modelSpendCheck(db, job, now);
      if (verdict !== "ok") return verdict;
    }
  }

  const steps = (await db.prepare(`SELECT seq, name, status, checkpoint_json FROM job_steps WHERE job_id = ? ORDER BY seq`).bind(job.id).all<{ seq: number; name: string; status: string; checkpoint_json: string | null }>()).results;
  const outputs: Record<string, unknown> = {};
  let cost = Number(job.cost_cents || 0);
  try {
    for (const s of steps) {
      if (s.status === "succeeded") { outputs[s.name] = parseJson(s.checkpoint_json, null); continue; }
      if (await globalPaused(db)) {
        await db.prepare(`UPDATE jobs SET status='paused', attempts=attempts-1, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`).bind(nowIso(), job.id).run();
        await event(db, job.id, "paused", { beforeStep: s.name });
        return "paused";
      }
      const def = h.steps.find((d) => d.name === s.name);
      if (!def) throw new NonRetryableError(`step ${s.name} no longer defined`);
      await db.prepare(`UPDATE job_steps SET status='running', attempts=attempts+1, started_at=?, error=NULL WHERE job_id=? AND seq=?`).bind(nowIso(), job.id, s.seq).run();
      try {
        const res = (await def.run({ db, env, jobId: job.id, input: parseJson(job.input_json, {}), outputs, now })) || {};
        cost += res.costCents ?? 0;
        outputs[s.name] = res.output ?? null;
        await db.prepare(`UPDATE job_steps SET status='succeeded', finished_at=?, checkpoint_json=? WHERE job_id=? AND seq=?`).bind(nowIso(), JSON.stringify(res.output ?? null), job.id, s.seq).run();
        await db.prepare(`UPDATE jobs SET cost_cents=?, updated_at=? WHERE id=?`).bind(cost, nowIso(), job.id).run();
        await event(db, job.id, "step_succeeded", { step: s.name });
        if (job.cost_cap_cents != null && cost > job.cost_cap_cents) throw new NonRetryableError(`cost cap exceeded: ${cost} > ${job.cost_cap_cents} cents`);
      } catch (e) {
        await db.prepare(`UPDATE job_steps SET status='failed', finished_at=?, error=? WHERE job_id=? AND seq=?`).bind(nowIso(), String((e as Error).message).slice(0, 500), job.id, s.seq).run();
        throw e;
      }
    }
    await db.prepare(`UPDATE jobs SET output_json=? WHERE id=?`).bind(JSON.stringify(outputs), job.id).run();
    await finish(db, job, "succeeded", null);
    await recordRun(db, job, startedAt, "success", null, cost - Number(job.cost_cents || 0));
    return "succeeded";
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    const retryable = !(e instanceof NonRetryableError) && job.attempts < job.max_attempts;
    await recordRun(db, job, startedAt, "failed", msg.slice(0, 500), cost - Number(job.cost_cents || 0));
    if (retryable) {
      const next = new Date(now.getTime() + backoffMs(job.attempts)).toISOString();
      await db.prepare(`UPDATE jobs SET status='queued', next_run_at=?, error=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`).bind(next, msg.slice(0, 500), nowIso(), job.id).run();
      await event(db, job.id, "retry_scheduled", { attempt: job.attempts, next, error: msg.slice(0, 200) });
      return "retry_scheduled";
    }
    await finish(db, job, "failed", msg);
    await raiseJobAlert(db, job, msg);
    return "failed";
  }
}

interface BudgetRow { id: string; scope: string; ceiling_cents: number; approved_cents: number; spent_cents: number; evidence: string; notes: string | null }

/** Returns "ok", or the outcome after deferring/failing the job. Envelope exhaustion defers to next month; anything unprovable fails. */
/**
 * Month-to-date model spend from op_llm_calls. A missing table (operator migration not applied) means no recorded
 * usage yet; any other read error is thrown so callers fail closed (QA-006 R1).
 */
export async function modelUsageMonthToDate(db: D1Database, now: Date): Promise<number> {
  const w = monthWindow(now);
  try {
    return Math.ceil(Number((await db.prepare(`SELECT COALESCE(SUM(cost_cents),0) AS c FROM op_llm_calls WHERE at >= ? AND at < ?`).bind(w.start, w.end).first<{ c: number }>())?.c ?? 0));
  } catch (e) { if (isMissingTable(e)) return 0; throw e; }
}

/**
 * Cents still reserved by other model jobs that passed the spend guard and have not finished: their cap minus what
 * they have already recorded in op_llm_calls. Without this, jobs authorised together could jointly exceed the envelope.
 */
export async function reservedModelCents(db: D1Database, excludeJobId: string): Promise<number> {
  const unfinished = `j.status IN ('queued','running','waiting_approval') AND j.id <> ? AND j.cost_cap_cents IS NOT NULL
    AND EXISTS (SELECT 1 FROM job_events e WHERE e.job_id = j.id AND e.type = 'spend_authorized')`;
  try {
    return Math.ceil(Number((await db.prepare(`SELECT COALESCE(SUM(MAX(0, j.cost_cap_cents - COALESCE((SELECT SUM(c.cost_cents) FROM op_llm_calls c WHERE c.job_id = j.id), 0))), 0) AS r
      FROM jobs j WHERE ${unfinished}`).bind(excludeJobId).first<{ r: number }>())?.r ?? 0));
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    return Math.ceil(Number((await db.prepare(`SELECT COALESCE(SUM(j.cost_cap_cents), 0) AS r FROM jobs j WHERE ${unfinished}`).bind(excludeJobId).first<{ r: number }>())?.r ?? 0));
  }
}

async function modelSpendCheck(db: D1Database, job: JobRow, now: Date): Promise<"ok" | "deferred_budget" | "spend_unverified" | "failed"> {
  const b = await db.prepare(`SELECT * FROM budgets WHERE id = ?`).bind(API_ENVELOPE_BUDGET_ID).first<BudgetRow>();
  const budgets = b ? [{ id: b.id, scope: b.scope, ceilingCents: b.ceiling_cents, approvedCents: b.approved_cents, spentCents: b.spent_cents, evidence: b.evidence as "VERIFIED", notes: b.notes }] : [];
  const w = monthWindow(now);
  let mtd: number;
  try {
    mtd = (await modelUsageMonthToDate(db, now)) + (await reservedModelCents(db, job.id));
  } catch (e) {
    // Usage could not be read: do not run (fail closed); try again in 5 minutes without spending an attempt.
    const retryAt = new Date(now.getTime() + 5 * 60_000).toISOString(); const msg = `spend guard: model usage unreadable (${String((e as Error)?.message ?? e).slice(0, 120)})`;
    await db.prepare(`UPDATE jobs SET status='queued', next_run_at=?, attempts=attempts-1, lease_owner=NULL, lease_expires_at=NULL, error=?, updated_at=? WHERE id=?`).bind(retryAt, msg, nowIso(), job.id).run();
    await event(db, job.id, "spend_unverified", { until: retryAt, error: msg });
    // After 3 failed reads (about 15 minutes) say so, once, instead of retrying silently (QA-006 R2 note).
    const n = Number((await db.prepare(`SELECT COUNT(*) AS n FROM job_events WHERE job_id = ? AND type = 'spend_unverified'`).bind(job.id).first<{ n: number }>())?.n ?? 0);
    if (n >= 3) {
      const at = nowIso();
      await db.prepare(`INSERT INTO alerts (id,severity,niche_id,source,title,detail,state,dedupe_key,first_seen,last_seen,next_action,needs_owner)
        VALUES (?,?,?,?,?,?,'open',?,?,?,?,0) ON CONFLICT(dedupe_key) DO UPDATE SET last_seen=excluded.last_seen, detail=excluded.detail, state=CASE WHEN alerts.state='acknowledged' THEN 'acknowledged' ELSE 'open' END`)
        .bind(newId("al"), "warning", job.niche_id, "controls:FIN-SPEND", "Model jobs are paused: model usage cannot be read", msg, "fin:spend:unverified", at, at, "Check the op_llm_calls table in the platform database; jobs resume once it reads.").run();
    }
    return "spend_unverified";
  }
  await db.prepare(`UPDATE alerts SET state='resolved', last_seen=? WHERE dedupe_key='fin:spend:unverified' AND state<>'resolved'`).bind(nowIso()).run();
  const d = authorizeSpend({ kind: "model_usage", budgetId: API_ENVELOPE_BUDGET_ID, vendor: "model", amountCents: job.cost_cap_cents, jobId: job.id }, budgets, [], now, mtd);
  if (d.allowed) { await event(db, job.id, "spend_authorized", { code: d.code, remainingCents: d.remainingCents }); return "ok"; }
  const at = nowIso();
  if (d.code === "envelope_exceeded") {
    await db.prepare(`UPDATE jobs SET status='queued', next_run_at=?, attempts=attempts-1, lease_owner=NULL, lease_expires_at=NULL, error=?, updated_at=? WHERE id=?`).bind(w.end, d.reason, at, job.id).run();
    await event(db, job.id, "deferred_budget", { code: d.code, until: w.end, reason: d.reason });
    await db.prepare(`INSERT INTO alerts (id,severity,niche_id,source,title,detail,state,dedupe_key,first_seen,last_seen,next_action,needs_owner)
      VALUES (?,?,?,?,?,?,'open',?,?,?,?,1) ON CONFLICT(dedupe_key) DO UPDATE SET last_seen=excluded.last_seen, detail=excluded.detail, state='open'`)
      .bind(newId("al"), "warning", job.niche_id, "controls:FIN-SPEND", `Model budget for ${w.label} is used up; model jobs wait until next month`, d.reason, `fin:spend:envelope:${w.label}`, at, at, "Raise the monthly model budget (owner decision) or let jobs resume next month.").run();
    return "deferred_budget";
  }
  await finish(db, job, "failed", `spend guard: ${d.reason}`);
  await raiseJobAlert(db, job, `spend guard (${d.code}): ${d.reason}`);
  return "failed";
}

async function finish(db: D1Database, job: JobRow, status: "succeeded" | "failed", error: string | null): Promise<void> {
  await db.prepare(`UPDATE jobs SET status=?, error=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`).bind(status, error, nowIso(), job.id).run();
  await event(db, job.id, status, error ? { error: error.slice(0, 200) } : undefined);
}

/** One scheduler tick: run up to maxJobs runnable jobs. Safe to call from cron, a dev loop, or tests. */
export async function tick(db: D1Database, env: Env, handlers: Map<string, HandlerDef>, opts: { workerId?: string; maxJobs?: number; now?: Date } = {}): Promise<{ jobId: string; outcome: string }[]> {
  const workerId = opts.workerId ?? newId("wkr");
  const out: { jobId: string; outcome: string }[] = [];
  for (let i = 0; i < (opts.maxJobs ?? 10); i++) {
    const job = await claimNext(db, workerId, opts.now ?? new Date());
    if (!job) break;
    out.push({ jobId: job.id, outcome: await runJob(db, env, handlers, job, opts.now ?? new Date()) });
  }
  return out;
}

/** Owner decision on an approval; approved jobs return to the queue. */
export async function decideApproval(db: D1Database, approvalId: string, approve: boolean): Promise<void> {
  const at = nowIso();
  await db.prepare(`UPDATE approvals SET status=?, decided_by='owner', decided_at=? WHERE id=? AND status='pending'`).bind(approve ? "approved" : "denied", at, approvalId).run();
  await db.prepare(`UPDATE jobs SET status=?, next_run_at=?, updated_at=? WHERE approval_id=? AND status='waiting_approval'`).bind(approve ? "queued" : "cancelled", at, at, approvalId).run();
}

export async function getJob(db: D1Database, id: string) {
  const j = await db.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(id).first<Record<string, any>>();
  if (!j) return null;
  const steps = (await db.prepare(`SELECT * FROM job_steps WHERE job_id = ? ORDER BY seq`).bind(id).all<Record<string, any>>()).results;
  return {
    id: j.id, kind: j.kind, nicheId: j.niche_id, status: j.status, priority: j.priority, idempotencyKey: j.idempotency_key,
    attempts: j.attempts, maxAttempts: j.max_attempts, nextRunAt: j.next_run_at, costCapCents: j.cost_cap_cents, costCents: j.cost_cents,
    parentId: j.parent_id, createdBy: j.created_by, createdAt: j.created_at, updatedAt: j.updated_at,
    output: parseJson(j.output_json, null), error: j.error,
    steps: steps.map((s) => ({ name: s.name, seq: s.seq, status: s.status, attempts: s.attempts, startedAt: s.started_at, finishedAt: s.finished_at, checkpoint: parseJson(s.checkpoint_json, null), error: s.error })),
  };
}
