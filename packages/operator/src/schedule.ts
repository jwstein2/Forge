/**
 * Declarative schedules for FORGE Operator jobs.
 *
 * The Cloudflare cron fires every 15 minutes. On each tick `enqueueDue` asks, for every enabled schedule,
 * "what is the most recent slot at or before now?" and enqueues exactly one job for that slot, keyed
 * `sched:<id>:<slot>`. Consequences:
 *  - a duplicated or overlapping tick never double-runs (idempotency key + last_slot);
 *  - an outage never back-fills a storm of missed runs: only the latest missed slot runs, once;
 *  - pausing is the platform's registry/niche pause or the global emergency stop (checked by the engine at claim time),
 *    plus `enabled = 0` here for retiring a schedule.
 */
import type { EnqueueOptions, HandlerDef } from "../../../services/api/src/orchestration/engine.ts";
import { enqueue } from "../../../services/api/src/orchestration/engine.ts";

export type ScheduleSpec =
  | { every: number }                                   // minutes, 15..10080
  | { daily: string }                                   // "HH:MM" UTC
  | { weekly: { day: number; at: string } }             // day 0=Sunday..6, "HH:MM" UTC
  | { monthly: { day: number; at: string } };           // day 1..31 (clamped to month length), "HH:MM" UTC

export interface ScheduleDef {
  id: string; kind: string; spec: ScheduleSpec; registryId?: string; nicheId?: string | null;
  input?: Record<string, unknown>; maxAttempts?: number; costCapCents?: number | null; enabled?: boolean;
}

const MIN = 60000;
const hm = (at: string): [number, number] => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (!m) throw new Error(`invalid time "${at}" (want HH:MM UTC)`);
  return [Number(m[1]), Number(m[2])];
};

export function validateSpec(spec: ScheduleSpec): void {
  if ("every" in spec) {
    if (!Number.isInteger(spec.every) || spec.every < 15 || spec.every > 10080) throw new Error("every must be an integer 15..10080 minutes (the cron ticks every 15)");
  } else if ("daily" in spec) hm(spec.daily);
  else if ("weekly" in spec) { hm(spec.weekly.at); if (!Number.isInteger(spec.weekly.day) || spec.weekly.day < 0 || spec.weekly.day > 6) throw new Error("weekly.day must be 0..6"); }
  else if ("monthly" in spec) { hm(spec.monthly.at); if (!Number.isInteger(spec.monthly.day) || spec.monthly.day < 1 || spec.monthly.day > 31) throw new Error("monthly.day must be 1..31"); }
  else throw new Error("unknown schedule spec");
}

/** Most recent slot at or before `now`, as an ISO string truncated to the minute. */
export function latestSlot(spec: ScheduleSpec, now: Date): Date {
  validateSpec(spec);
  const t = now.getTime();
  if ("every" in spec) return new Date(Math.floor(t / (spec.every * MIN)) * spec.every * MIN);
  if ("daily" in spec) {
    const [h, m] = hm(spec.daily);
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
    if (d.getTime() > t) d.setUTCDate(d.getUTCDate() - 1);
    return d;
  }
  if ("weekly" in spec) {
    const [h, m] = hm(spec.weekly.at);
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - spec.weekly.day + 7) % 7));
    if (d.getTime() > t) d.setUTCDate(d.getUTCDate() - 7);
    return d;
  }
  const [h, m] = hm(spec.monthly.at);
  const at = (y: number, mo: number) => {
    const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, mo, Math.min(spec.monthly.day, last), h, m));
  };
  let d = at(now.getUTCFullYear(), now.getUTCMonth());
  if (d.getTime() > t) d = at(now.getUTCFullYear(), now.getUTCMonth() - 1);
  return d;
}

export const slotKey = (d: Date): string => d.toISOString().slice(0, 16) + "Z";

/** Upsert schedule definitions from code (git is the source of truth). Never re-enables a schedule disabled at runtime. */
export async function seedSchedules(db: D1Database, defs: ScheduleDef[], at = new Date().toISOString()): Promise<number> {
  const stmts = defs.map((s) => {
    validateSpec(s.spec);
    return db.prepare(`INSERT INTO op_schedules (id,kind,registry_id,niche_id,spec_json,input_json,enabled,max_attempts,cost_cap_cents,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, registry_id=excluded.registry_id, niche_id=excluded.niche_id, spec_json=excluded.spec_json,
        input_json=excluded.input_json, max_attempts=excluded.max_attempts, cost_cap_cents=excluded.cost_cap_cents, updated_at=excluded.updated_at`)
      .bind(s.id, s.kind, s.registryId ?? s.id, s.nicheId ?? null, JSON.stringify(s.spec), JSON.stringify(s.input ?? {}), s.enabled === false ? 0 : 1, s.maxAttempts ?? 3, s.costCapCents ?? null, at, at);
  });
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

interface ScheduleRow { id: string; kind: string; registry_id: string | null; niche_id: string | null; spec_json: string; input_json: string; max_attempts: number; cost_cap_cents: number | null; last_slot: string | null }

/** Enqueue every due schedule slot. Safe to call on every cron tick. */
export async function enqueueDue(db: D1Database, handlers: Map<string, HandlerDef>, now = new Date()): Promise<{ scheduleId: string; slot: string; jobId: string; created: boolean }[]> {
  const rows = (await db.prepare(`SELECT * FROM op_schedules WHERE enabled = 1 ORDER BY id`).all<ScheduleRow>()).results;
  const out: { scheduleId: string; slot: string; jobId: string; created: boolean }[] = [];
  for (const r of rows) {
    if (!handlers.has(r.kind)) continue;               // handler not registered in this build: skip, never crash the tick
    const slot = slotKey(latestSlot(JSON.parse(r.spec_json) as ScheduleSpec, now));
    if (r.last_slot && r.last_slot >= slot) continue;
    const opts: EnqueueOptions = {
      kind: r.kind, input: { ...JSON.parse(r.input_json), slot }, nicheId: r.niche_id, registryId: r.registry_id,
      idempotencyKey: `sched:${r.id}:${slot}`, maxAttempts: r.max_attempts, costCapCents: r.cost_cap_cents, runAt: now.toISOString(), createdBy: `schedule:${r.id}`,
    };
    const res = await enqueue(db, handlers, opts);
    await db.prepare(`UPDATE op_schedules SET last_slot=?, last_job_id=?, updated_at=? WHERE id=?`).bind(slot, res.id, now.toISOString(), r.id).run();
    out.push({ scheduleId: r.id, slot, jobId: res.id, created: res.created });
  }
  return out;
}
