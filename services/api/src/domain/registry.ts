import type { Period, RegistryEntry, RunSummary, SourceFreshness } from "@forge/contracts";
import { metric } from "../lib/metric.ts";
import { parseJson } from "../lib/util.ts";

interface EntryRow {
  id: string; kind: RegistryEntry["kind"]; name: string; niche_id: string | null; department: string | null; owner: string | null;
  runner: RegistryEntry["runner"]; external_ref: string | null; trigger_desc: string | null; cadence: string | null;
  interval_minutes: number | null; model: string | null; cost_cap_cents: number | null; retry_budget: number | null;
  status: RegistryEntry["status"]; paused: number; pausable: number; defects_json: string; notes: string | null;
}
interface RunRow { id: string; registry_id: string; started_at: string; finished_at: string | null; status: RunSummary["status"]; evidence_url: string | null; model_cost_cents: number | null; error: string | null; source: string }

const toRun = (r: RunRow): RunSummary => ({ id: r.id, registryId: r.registry_id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, evidenceUrl: r.evidence_url, modelCostCents: r.model_cost_cents, error: r.error, source: r.source });

/**
 * Heartbeat: a scheduled entry is 'late' when its last success is older than 2× its interval.
 * Runs imported from a snapshot are judged against the snapshot time. If the snapshot itself is
 * older than 2× the interval, current health cannot be known and the heartbeat is 'stale', never 'ok'.
 */
export function heartbeatOf(e: Pick<EntryRow, "paused" | "interval_minutes">, lastSuccess: RunSummary | null, reference: Date, now: Date = reference): RegistryEntry["heartbeat"] {
  if (e.paused) return "paused";
  if (!e.interval_minutes) return "not_scheduled";
  const limit = 2 * e.interval_minutes * 60000;
  if (now.getTime() - reference.getTime() > limit) return "stale";
  if (!lastSuccess) return "never_observed";
  const age = reference.getTime() - Date.parse(lastSuccess.finishedAt ?? lastSuccess.startedAt);
  return age > limit ? "late" : "ok";
}

export async function listRegistry(db: D1Database, opts: { nicheId?: string | null; includeShared?: boolean; n8n: SourceFreshness; now?: Date }): Promise<RegistryEntry[]> {
  const now = opts.now ?? new Date();
  const where = opts.nicheId ? (opts.includeShared ? "WHERE niche_id = ? OR niche_id IS NULL" : "WHERE niche_id = ?") : "";
  const stmt = db.prepare(`SELECT * FROM registry_entries ${where} ORDER BY id`);
  const rows = (await (opts.nicheId ? stmt.bind(opts.nicheId) : stmt).all<EntryRow>()).results;
  const period: Period = { start: new Date(now.getTime() - 30 * 86400000).toISOString(), end: now.toISOString(), label: "Last 30 days" };
  const out: RegistryEntry[] = [];
  for (const r of rows) {
    const last = await db.prepare(`SELECT * FROM runs WHERE registry_id = ? ORDER BY started_at DESC LIMIT 1`).bind(r.id).first<RunRow>();
    const ok = await db.prepare(`SELECT * FROM runs WHERE registry_id = ? AND status = 'success' ORDER BY started_at DESC LIMIT 1`).bind(r.id).first<RunRow>();
    const lastSuccess = ok ? toRun(ok) : null;
    const fromSnapshot = lastSuccess?.source.endsWith(".snapshot");
    const reference = fromSnapshot && opts.n8n.asOf ? new Date(opts.n8n.asOf) : now;
    let runs30;
    if (r.runner === "n8n" && opts.n8n.mode === "live") {
      const c = await db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE registry_id = ? AND started_at >= ?`).bind(r.id, period.start).first<{ n: number }>();
      runs30 = metric(Number(c?.n ?? 0), "count", "verified", period, opts.n8n.asOf, "n8n execution history");
    } else if (r.runner === "n8n" && opts.n8n.mode === "snapshot") {
      runs30 = metric(null, "count", "unknown", period, opts.n8n.asOf, "n8n snapshot", { note: "Snapshot holds only the latest executions per workflow." });
    } else if (r.runner === "forge") {
      const c = await db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE registry_id = ? AND started_at >= ?`).bind(r.id, period.start).first<{ n: number }>();
      runs30 = metric(Number(c?.n ?? 0), "count", "verified", period, now.toISOString(), "FORGE run ledger");
    } else {
      runs30 = metric(null, "count", "unconnected", period, null, `${r.runner} run history`, { note: "No run ledger for this runner yet." });
    }
    out.push({
      id: r.id, kind: r.kind, name: r.name, nicheId: r.niche_id, department: r.department, owner: r.owner, runner: r.runner,
      externalRef: r.external_ref, trigger: r.trigger_desc, cadence: r.cadence, intervalMinutes: r.interval_minutes, model: r.model,
      costCapCents: r.cost_cap_cents, retryBudget: r.retry_budget, status: r.status, paused: !!r.paused, pausable: !!r.pausable,
      lastRun: last ? toRun(last) : null, lastSuccess, heartbeat: heartbeatOf(r, lastSuccess, reference, now),
      runsLast30d: runs30, defects: parseJson<string[]>(r.defects_json, []), notes: r.notes,
    });
  }
  return out;
}

export async function listRuns(db: D1Database, registryId: string, limit = 50): Promise<RunSummary[]> {
  const rows = await db.prepare(`SELECT * FROM runs WHERE registry_id = ? ORDER BY started_at DESC LIMIT ?`).bind(registryId, limit).all<RunRow>();
  return rows.results.map(toRun);
}
