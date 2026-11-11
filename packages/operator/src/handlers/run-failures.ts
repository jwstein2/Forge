/**
 * ops.run_failures: turns failed runs into alerts in FORGE Command, and clears them when the next run succeeds.
 *
 * Covers both kinds of run FORGE records:
 *  - n8n workflows, which report each run as a signed heartbeat (a failed run arrives through "FORGE · Heartbeat on
 *    failure" with the error message);
 *  - FORGE's own jobs (runs.source = 'forge').
 * The heartbeat watchdog already raises "late" alerts after 2x the interval; this job reacts to the failure itself, on
 * the next 30-minute tick, and says what failed. Rules, per registry entry, on its latest finished run:
 *  - failed or timeout → warning `ops:run_failed:<registry_id>` (FORGE runs: `...:<registry_id>:<kind>`, since kinds
 *    can share an entry); critical after 3 failures in a row;
 *  - success → that alert is resolved, and so is the engine's own `job:<kind>:<registry_id>` failure alert if it was
 *    last seen before the success (the engine raises those but never clears them).
 * Read-only apart from alerts. Unknown stays unknown: entries with no runs are left to the watchdog, and an open
 * run_failed alert whose entry has no finished run in 14 days is closed with a note saying so.
 */
import type { HandlerDef } from "../../../../services/api/src/orchestration/engine.ts";
import { alertStmt, flush, resolveStmt } from "../lib.ts";

export interface RunRow { registry_id: string; kind?: string | null; name: string; niche_id: string | null; status: string; finished: string; error: string | null; source: string; rn: number }
export interface FailureState { registryId: string; kind: string | null; name: string; nicheId: string | null; latest: "success" | "failed"; streak: number; lastError: string | null; at: string; source: string }

/** Latest outcome and failure streak per entry, from its most recent finished runs (newest first). */
export function failureStates(rows: RunRow[]): FailureState[] {
  const by = new Map<string, RunRow[]>();
  // Several job kinds can share one registry entry (seo_audit, seo_batch, seo_finalize), so FORGE runs group by kind too.
  const groupKey = (r: RunRow) => r.kind ? `${r.registry_id}\u0000${r.kind}` : r.registry_id;
  for (const r of rows) { const k = groupKey(r); if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); }
  const out: FailureState[] = [];
  for (const rs of by.values()) {
    rs.sort((a, b) => a.rn - b.rn);
    const first = rs[0]!;
    const failed = (s: string) => s === "failed" || s === "timeout";
    let streak = 0; for (const r of rs) { if (failed(r.status)) streak++; else break; }
    out.push({ registryId: first.registry_id, kind: first.kind ?? null, name: first.name, nicheId: first.niche_id, latest: failed(first.status) ? "failed" : "success", streak, lastError: first.error, at: first.finished, source: first.source });
  }
  return out;
}

export function runFailures(): HandlerDef {
  return {
    kind: "ops.run_failures",
    registryId: "OPS-RUN-FAILURES",
    steps: [{
      name: "evaluate",
      async run({ db }) {
        // Finished runs from the last 14 days; normalise timestamps so a run reported with a local offset still sorts right.
        // FORGE runs carry external_id '<job id>:<attempt>'; the job gives the kind.
        const rows = (await db.prepare(`SELECT registry_id, kind, name, niche_id, status, finished, error, source, rn FROM (
            SELECT r.registry_id, j.kind, e.name, e.niche_id, r.status, r.error, r.source,
                   strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(r.finished_at, r.started_at)) AS finished,
                   ROW_NUMBER() OVER (PARTITION BY r.registry_id, j.kind ORDER BY julianday(COALESCE(r.finished_at, r.started_at)) DESC) AS rn
            FROM runs r JOIN registry_entries e ON e.id = r.registry_id
            LEFT JOIN jobs j ON r.source = 'forge' AND j.id = substr(r.external_id, 1, instr(r.external_id, ':') - 1)
            WHERE r.status IN ('success','failed','timeout') AND julianday(COALESCE(r.finished_at, r.started_at)) >= julianday('now','-14 days')
          ) WHERE rn <= 5`).all<RunRow>()).results;
        const jobAlerts = (await db.prepare(`SELECT dedupe_key, last_seen FROM alerts WHERE dedupe_key LIKE 'job:%' AND state <> 'resolved'`).all<{ dedupe_key: string; last_seen: string }>()).results;
        const ownOpen = (await db.prepare(`SELECT dedupe_key FROM alerts WHERE dedupe_key LIKE 'ops:run_failed:%' AND state <> 'resolved'`).all<{ dedupe_key: string }>()).results;
        const states = failureStates(rows);
        const stmts: D1PreparedStatement[] = [];
        const failing: string[] = []; let cleared = 0;
        const seen = new Set<string>();
        for (const s of states) {
          const key = s.kind ? `ops:run_failed:${s.registryId}:${s.kind}` : `ops:run_failed:${s.registryId}`;
          seen.add(key);
          if (s.latest === "failed") {
            failing.push(s.kind ? `${s.registryId}:${s.kind}` : s.registryId);
            const where = s.source === "heartbeat" ? "in n8n" : "in FORGE";
            stmts.push(alertStmt(db, { key, severity: s.streak >= 3 ? "critical" : "warning", nicheId: s.nicheId, source: "ops.run_failures",
              title: `${s.name}${s.kind ? ` (${s.kind})` : ""} ${s.streak >= 2 ? `failed ${s.streak} runs in a row` : "failed its last run"}`,
              detail: `Last run finished ${s.at} ${where}${s.lastError ? `: ${s.lastError.slice(0, 300)}` : " (no error message reported)"}.`,
              nextAction: s.source === "heartbeat" ? "Open the workflow's latest execution in n8n to see the failing node." : "Open the job's events in FORGE Command; the next scheduled run retries." }));
          } else {
            stmts.push(resolveStmt(db, key));
            // Only the engine alert for this exact kind; last_seen keeps the failure time, the detail records the clearing run.
            for (const a of jobAlerts) if (s.kind && a.dedupe_key === `job:${s.kind}:${s.registryId}` && a.last_seen < s.at) {
              stmts.push(db.prepare(`UPDATE alerts SET state='resolved', detail=COALESCE(detail,'') || ? WHERE dedupe_key=? AND state<>'resolved'`).bind(` [Cleared: a later run succeeded at ${s.at}.]`, a.dedupe_key));
              cleared++;
            }
          }
        }
        // An entry with no finished run left in the window: its failure is no longer current; the heartbeat watchdog owns silence.
        let aged = 0;
        for (const a of ownOpen) if (!seen.has(a.dedupe_key)) {
          stmts.push(db.prepare(`UPDATE alerts SET state='resolved', detail=COALESCE(detail,'') || ? WHERE dedupe_key=? AND state<>'resolved'`).bind(" [Cleared: no finished run in the last 14 days; lateness is left to the heartbeat watchdog.]", a.dedupe_key));
          aged++;
        }
        await flush(db, stmts);
        return { output: { evaluated: states.length, failing, staleJobAlertsCleared: cleared, agedOut: aged } };
      },
    }],
  };
}
