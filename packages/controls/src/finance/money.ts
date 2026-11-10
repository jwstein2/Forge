/** Money helpers. Storage is integer cents everywhere (CONTRACTS.md §2). */

/** Lemon Squeezy published fee: 5% + $0.50 per order. ESTIMATED until reconciled with a payout report. */
export const LS_FEE = { pct: 0.05, fixedCents: 50, evidence: "ESTIMATED" as const, source: "Lemon Squeezy published rate (FORGE_COST_MODEL.md §6); recheck before relying on it" };

export function estimateLsFeeCents(orderTotalCents: number): number {
  if (!Number.isFinite(orderTotalCents) || orderTotalCents <= 0) return 0;
  return Math.round(orderTotalCents * LS_FEE.pct) + LS_FEE.fixedCents;
}

export const fmtUsd = (cents: number | null): string =>
  cents == null ? "unknown" : `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/** Calendar month [start, end) in UTC containing `now`. */
export function monthWindow(now: Date): { start: string; end: string; label: string } {
  const s = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const e = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: s.toISOString(), end: e.toISOString(), label: s.toISOString().slice(0, 7) };
}
