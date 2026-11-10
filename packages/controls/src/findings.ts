/**
 * Common shape for every control's output. A Finding maps 1:1 onto a FORGE alert
 * (dedupeKey -> alerts.dedupe_key) and onto a release-gate line (gate -> G1..G16).
 */
import type { GateResult, NicheId, Severity } from "@forge/contracts";

export interface Finding {
  code: string;                 // stable control code, e.g. "FIN-LI-01"
  gate: string;                 // release gate the finding blocks, e.g. "G6"
  severity: Severity;
  nicheId: NicheId | null;
  title: string;
  detail: string;
  dedupeKey: string;
  /** True only when fixing it needs an owner decision (spend, account, pricing, launch). */
  needsOwner: boolean;
  evidence?: Record<string, unknown>;
}

/** Gate result from a set of findings for that gate: any critical/warning blocks; info does not. */
export function gateResult(findings: Finding[], gate: string, ran = true): GateResult {
  if (!ran) return "NOT_RUN";
  return findings.some((f) => f.gate === gate && f.severity !== "info") ? "FAIL" : "PASS";
}

/** Row ready for the platform's alerts table (INSERT ... ON CONFLICT(dedupe_key)). */
export function toAlertRow(f: Finding, at: string, source = "controls") {
  return {
    severity: f.severity, niche_id: f.nicheId, source: `${source}:${f.code}`, title: f.title,
    detail: f.detail.slice(0, 500), state: "open" as const, dedupe_key: f.dedupeKey,
    first_seen: at, last_seen: at, needs_owner: f.needsOwner ? 1 : 0,
    next_action: f.needsOwner ? "Owner decision required; see the control's runbook entry." : "Fix and re-run the control.",
  };
}
