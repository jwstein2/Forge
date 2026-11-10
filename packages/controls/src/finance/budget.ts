/**
 * Budget and spend guard (constitution §11; owner rule: a ceiling is NOT purchase authorization).
 *
 * Default is deny. Two classes of spend:
 *  - cash: purchases, subscriptions, domains, ads. Always need an owner approval record whose boundary covers
 *    the vendor and amount, AND must fit the budget ceiling. An approval never lifts the ceiling.
 *  - model_usage: metered model/API calls by FORGE jobs. Pre-approved only inside the monthly API envelope
 *    (bud_api_month, E4 = $15) and only while month-to-date + this estimate stays under it.
 * Unknown spend (no estimate) is denied: FORGE cannot prove it fits.
 */
import type { Budget } from "@forge/contracts";
import type { Finding } from "../findings.ts";
import { fmtUsd, monthWindow } from "./money.ts";

export interface ApprovalRecord {
  id: string; scope: string; status: "pending" | "approved" | "denied" | "expired";
  decidedBy: string | null; expiresAt: string | null;
  /** boundary_json: what the owner approved. */
  boundary: { budgetId?: string; vendor?: string; maxCents?: number; recurring?: boolean } | null;
}
export interface SpendRequest {
  kind: "cash" | "model_usage";
  budgetId: string;
  vendor: string;
  amountCents: number | null;       // null = unknown
  recurring?: boolean;
  approvalId?: string | null;
  jobId?: string;
}
export interface SpendDecision { allowed: boolean; reason: string; code: string; remainingCents: number | null }

export const ALERT_AT = 0.8;

export function utilisation(b: Pick<Budget, "ceilingCents" | "spentCents">): number {
  return b.ceilingCents > 0 ? b.spentCents / b.ceilingCents : 1;
}

export function authorizeSpend(req: SpendRequest, budgets: Budget[], approvals: ApprovalRecord[], now: Date, monthToDateUsageCents = 0): SpendDecision {
  const deny = (code: string, reason: string, remainingCents: number | null = null): SpendDecision => ({ allowed: false, code, reason, remainingCents });
  const b = budgets.find((x) => x.id === req.budgetId);
  if (!b) return deny("no_budget", `No budget ${req.budgetId}; spend must belong to a recorded budget.`);
  if (req.amountCents == null || !Number.isFinite(req.amountCents) || req.amountCents < 0) return deny("unknown_amount", "Spend without a known amount cannot be shown to fit the budget.");

  if (req.kind === "model_usage") {
    const remaining = b.ceilingCents - monthToDateUsageCents;
    if (monthToDateUsageCents + req.amountCents > b.ceilingCents)
      return deny("envelope_exceeded", `Model usage would reach ${fmtUsd(monthToDateUsageCents + req.amountCents)} against the ${fmtUsd(b.ceilingCents)} monthly envelope.`, remaining);
    return { allowed: true, code: "within_envelope", reason: `Inside the pre-approved monthly envelope (${fmtUsd(remaining - req.amountCents)} left).`, remainingCents: remaining - req.amountCents };
  }

  // cash
  const remaining = b.ceilingCents - b.spentCents;
  if (!req.approvalId) return deny("approval_required", "Cash spend needs an explicit owner approval. The budget ceiling is not purchase authorization.", remaining);
  const a = approvals.find((x) => x.id === req.approvalId);
  if (!a) return deny("approval_missing", `Approval ${req.approvalId} not found.`, remaining);
  if (a.status !== "approved" || a.decidedBy !== "owner") return deny("approval_not_granted", `Approval ${a.id} is ${a.status}.`, remaining);
  if (a.expiresAt && Date.parse(a.expiresAt) <= now.getTime()) return deny("approval_expired", `Approval ${a.id} expired ${a.expiresAt}.`, remaining);
  const bd = a.boundary ?? {};
  if (bd.budgetId && bd.budgetId !== b.id) return deny("approval_scope", `Approval ${a.id} covers budget ${bd.budgetId}, not ${b.id}.`, remaining);
  if (bd.vendor && bd.vendor.toLowerCase() !== req.vendor.toLowerCase()) return deny("approval_scope", `Approval ${a.id} covers ${bd.vendor}, not ${req.vendor}.`, remaining);
  if (bd.maxCents == null) return deny("approval_unbounded", `Approval ${a.id} has no amount limit; FORGE only acts on bounded approvals.`, remaining);
  if (req.amountCents > bd.maxCents) return deny("approval_amount", `${fmtUsd(req.amountCents)} exceeds the approved ${fmtUsd(bd.maxCents)}.`, remaining);
  if (req.recurring && !bd.recurring) return deny("approval_recurring", "This is a recurring charge but the approval was for a one-off purchase.", remaining);
  if (b.spentCents + req.amountCents > b.ceilingCents) return deny("ceiling", `Would take ${b.scope} to ${fmtUsd(b.spentCents + req.amountCents)}, over its ${fmtUsd(b.ceilingCents)} ceiling. An approval does not raise a ceiling.`, remaining);
  return { allowed: true, code: "approved", reason: `Owner approval ${a.id}; ${fmtUsd(remaining - req.amountCents)} left under the ceiling.`, remainingCents: remaining - req.amountCents };
}

export interface UsageRow { at: string; costCents: number | null; evidence: string }
/** Month-to-date model usage. Unknown-cost rows make the figure a lower bound and are counted. */
export function monthToDate(rows: UsageRow[], now: Date): { cents: number; unknownRows: number; window: ReturnType<typeof monthWindow> } {
  const w = monthWindow(now);
  let cents = 0, unknownRows = 0;
  for (const r of rows) {
    if (r.at < w.start || r.at >= w.end) continue;
    if (r.costCents == null) unknownRows++; else cents += r.costCents;
  }
  return { cents: Math.round(cents), unknownRows, window: w };
}

/** Budget health findings: 80% warning, 100% critical, approved > ceiling critical, unknown spend info. */
export function budgetFindings(budgets: Budget[], usage?: { budgetId: string; cents: number; unknownRows: number }): Finding[] {
  const out: Finding[] = [];
  for (const b0 of budgets) {
    const b = usage && usage.budgetId === b0.id ? { ...b0, spentCents: Math.max(b0.spentCents, usage.cents) } : b0;
    const u = utilisation(b);
    if (b.approvedCents > b.ceilingCents) out.push({ code: "FIN-BG-03", gate: "G14", severity: "critical", nicheId: null, needsOwner: true,
      title: `${b.scope}: approved ${fmtUsd(b.approvedCents)} exceeds ceiling ${fmtUsd(b.ceilingCents)}`, detail: "Approvals must fit under the ceiling.", dedupeKey: `fin:budget:approved_over:${b.id}` });
    if (u >= 1) out.push({ code: "FIN-BG-02", gate: "G14", severity: "critical", nicheId: null, needsOwner: true,
      title: `${b.scope} is at ${Math.round(u * 100)}% of its ceiling`, detail: `Spent ${fmtUsd(b.spentCents)} of ${fmtUsd(b.ceilingCents)}. New spend in this budget is blocked until the owner raises it.`, dedupeKey: `fin:budget:breach:${b.id}` });
    else if (u >= ALERT_AT) out.push({ code: "FIN-BG-01", gate: "G14", severity: "warning", nicheId: null, needsOwner: false,
      title: `${b.scope} is at ${Math.round(u * 100)}% of its ceiling`, detail: `Spent ${fmtUsd(b.spentCents)} of ${fmtUsd(b.ceilingCents)}.`, dedupeKey: `fin:budget:warn:${b.id}` });
    if (usage && usage.budgetId === b.id && usage.unknownRows > 0) out.push({ code: "FIN-BG-04", gate: "G16", severity: "info", nicheId: null, needsOwner: false,
      title: `${usage.unknownRows} usage record(s) have no cost`, detail: `${b.scope} month-to-date is a lower bound.`, dedupeKey: `fin:budget:unknown_usage:${b.id}` });
  }
  return out;
}

/**
 * Default per-run cost caps by run type, from FORGE_COST_MODEL.md §4 (upper end of each ESTIMATED range).
 * A job enqueued without an explicit cap gets one of these; long-lived Opus thread wakes get no default
 * because the cost model says not to use them for routine work.
 */
export const DEFAULT_RUN_CAPS_CENTS: Record<string, number> = {
  deterministic: 0,
  llm_step: 30,
  specialist: 300,
  build: 1500,
  judgment: 800,
};
export function capForRunType(t: keyof typeof DEFAULT_RUN_CAPS_CENTS | string): number | null {
  return t in DEFAULT_RUN_CAPS_CENTS ? DEFAULT_RUN_CAPS_CENTS[t]! : null;
}
