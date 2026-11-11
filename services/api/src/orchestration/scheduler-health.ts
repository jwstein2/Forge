/**
 * Scheduler health: is the cron ticking, and is the job queue draining? (QA-008 ST4 showed a backlog can starve
 * monitors silently.) The scheduled invocation records a snapshot after its fan-out; a backlog older than
 * BACKLOG_MINUTES raises one warning alert, cleared automatically when the queue drains. A cron that stops entirely
 * cannot alert from inside the Worker, so GET /system/scheduler reports `stale` for the dashboard to show.
 */
import { newId, nowIso, parseJson } from "../lib/util.ts";

export const BACKLOG_MINUTES = 45;
export const STALE_TICK_MINUTES = 35; // two missed */15 ticks plus slack
export const BACKLOG_ALERT_KEY = "system:scheduler:backlog";

export interface QueueSnapshot { at: string; queued: number; running: number; oldestQueuedAt: string | null; oldestQueuedKind: string | null; failed24h: number; ran: number }

export async function queueSnapshot(db: D1Database, now: Date, ran = 0): Promise<QueueSnapshot> {
  const t = now.toISOString();
  const r = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM jobs WHERE status='queued' AND next_run_at <= ?) AS queued,
      (SELECT COUNT(*) FROM jobs WHERE status='running') AS running,
      (SELECT next_run_at FROM jobs WHERE status='queued' AND next_run_at <= ? ORDER BY next_run_at LIMIT 1) AS oldest_at,
      (SELECT kind FROM jobs WHERE status='queued' AND next_run_at <= ? ORDER BY next_run_at LIMIT 1) AS oldest_kind,
      (SELECT COUNT(*) FROM jobs WHERE status='failed' AND updated_at >= ?) AS failed24h`)
    .bind(t, t, t, new Date(now.getTime() - 86400000).toISOString()).first<Record<string, number | string | null>>();
  return { at: t, queued: Number(r?.queued ?? 0), running: Number(r?.running ?? 0), oldestQueuedAt: (r?.oldest_at as string) ?? null, oldestQueuedKind: (r?.oldest_kind as string) ?? null, failed24h: Number(r?.failed24h ?? 0), ran };
}

export const backlogMinutes = (s: QueueSnapshot, now: Date) => (s.oldestQueuedAt ? Math.floor((now.getTime() - Date.parse(s.oldestQueuedAt)) / 60000) : 0);

/** One batch (one subrequest): record the snapshot, then raise or clear the backlog alert. */
export async function recordTick(db: D1Database, now: Date, ran: number): Promise<QueueSnapshot> {
  const s = await queueSnapshot(db, now, ran);
  const age = backlogMinutes(s, now);
  const at = nowIso();
  const stmts = [db.prepare(`INSERT INTO system_controls (key,value_json,updated_by,updated_at) VALUES ('cron:last_tick',?,'cron',?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`).bind(JSON.stringify(s), at)];
  if (age > BACKLOG_MINUTES) {
    stmts.push(db.prepare(`INSERT INTO alerts (id,severity,niche_id,source,title,detail,state,dedupe_key,first_seen,last_seen,next_action,evidence_url)
      VALUES (?,'warning',NULL,'system.scheduler',?,?,'open',?,?,?,?,NULL)
      ON CONFLICT(dedupe_key) DO UPDATE SET last_seen=excluded.last_seen, detail=excluded.detail, title=excluded.title,
        state=CASE WHEN alerts.state='resolved' THEN 'open' ELSE alerts.state END`)
      .bind(newId("al"), `Job queue backlog: oldest job waiting ${age} min`, `${s.queued} runnable job(s) queued; oldest is ${s.oldestQueuedKind} since ${s.oldestQueuedAt}. This tick ran ${ran}.`, BACKLOG_ALERT_KEY, at, at,
        "Platform: check the cron tail for failing child ticks, or raise CRON_MAX_JOBS."));
  } else {
    stmts.push(db.prepare(`UPDATE alerts SET state='resolved', last_seen=? WHERE dedupe_key=? AND state<>'resolved'`).bind(at, BACKLOG_ALERT_KEY));
  }
  await db.batch(stmts);
  return s;
}

/** For GET /system/scheduler. */
export async function schedulerStatus(db: D1Database, now = new Date()) {
  const row = await db.prepare(`SELECT value_json FROM system_controls WHERE key='cron:last_tick'`).first<{ value_json: string }>();
  const last = parseJson<QueueSnapshot | null>(row?.value_json, null);
  const current = await queueSnapshot(db, now);
  const sinceTick = last ? Math.floor((now.getTime() - Date.parse(last.at)) / 60000) : null;
  return {
    lastTick: last, minutesSinceTick: sinceTick,
    state: last === null ? "never_observed" : sinceTick! > STALE_TICK_MINUTES ? "stale" : backlogMinutes(current, now) > BACKLOG_MINUTES ? "backlog" : "ok",
    queue: { ...current, backlogMinutes: backlogMinutes(current, now) },
    thresholds: { staleTickMinutes: STALE_TICK_MINUTES, backlogMinutes: BACKLOG_MINUTES },
  };
}
