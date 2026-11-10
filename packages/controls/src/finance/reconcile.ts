/**
 * Monthly payout reconciliation (gate G6: ledger vs Lemon Squeezy within $0.01).
 * Input is the provider's order export for the month; until the Lemon Squeezy API is connected this
 * runs on a CSV the owner downloads, so the result is labelled with its source.
 */
import type { Finding } from "../findings.ts";
import type { RawSale } from "./ledger.ts";
import { fmtUsd } from "./money.ts";

export interface ProviderOrder { orderId: string; totalCents: number; taxCents: number; refundedCents: number; feeCents: number | null; testMode: boolean }
export interface Reconciliation {
  status: "matched" | "mismatched";
  ledgerNetCents: number; providerNetCents: number; differenceCents: number;
  providerFeesCents: number | null;
  missingInLedger: string[]; missingAtProvider: string[]; amountMismatches: { orderId: string; ledgerCents: number; providerCents: number }[];
  findings: Finding[];
}

export function reconcile(ledger: RawSale[], provider: ProviderOrder[], toleranceCents = 1): Reconciliation {
  const live = ledger.filter((s) => s.test_mode === 0 || (s.test_mode as unknown) === "0");
  const lSales = new Map(live.filter((s) => s.event === "order_created").map((s) => [s.order_id, s]));
  const lRefunds = new Map<string, number>();
  for (const s of live.filter((x) => x.event === "order_refunded")) lRefunds.set(s.order_id, (lRefunds.get(s.order_id) ?? 0) + Number(s.refunded_cents));
  const pLive = provider.filter((p) => !p.testMode);
  const pMap = new Map(pLive.map((p) => [p.orderId, p]));

  const missingInLedger = pLive.filter((p) => !lSales.has(p.orderId)).map((p) => p.orderId);
  const missingAtProvider = [...lSales.keys()].filter((id) => !pMap.has(id));
  const amountMismatches: Reconciliation["amountMismatches"] = [];
  for (const [id, s] of lSales) {
    const p = pMap.get(id); if (!p) continue;
    const l = Number(s.total_cents) - (lRefunds.get(id) ?? 0);
    const r = p.totalCents - p.refundedCents;
    if (Math.abs(l - r) > toleranceCents) amountMismatches.push({ orderId: id, ledgerCents: l, providerCents: r });
  }
  const ledgerNet = [...lSales.values()].reduce((a, s) => a + Number(s.total_cents), 0) - [...lRefunds.values()].reduce((a, b) => a + b, 0);
  const providerNet = pLive.reduce((a, p) => a + p.totalCents - p.refundedCents, 0);
  const fees = pLive.some((p) => p.feeCents == null) ? null : pLive.reduce((a, p) => a + (p.feeCents ?? 0), 0);
  const diff = ledgerNet - providerNet;
  const ok = Math.abs(diff) <= toleranceCents && !missingInLedger.length && !missingAtProvider.length && !amountMismatches.length;

  const findings: Finding[] = [];
  if (!ok) findings.push({ code: "FIN-RC-01", gate: "G6", severity: "critical", nicheId: null, needsOwner: false,
    title: `Ledger and payouts differ by ${fmtUsd(diff)}`,
    detail: `${missingInLedger.length} order(s) missing in ledger (webhook missed), ${missingAtProvider.length} missing at provider, ${amountMismatches.length} amount mismatch(es).`,
    dedupeKey: "fin:reconcile:month", evidence: { missingInLedger, missingAtProvider, amountMismatches } });
  return { status: ok ? "matched" : "mismatched", ledgerNetCents: ledgerNet, providerNetCents: providerNet, differenceCents: diff,
    providerFeesCents: fees, missingInLedger, missingAtProvider, amountMismatches, findings };
}

/** Parse a Lemon Squeezy orders CSV export (header names matched case-insensitively). Amounts in dollars → cents. */
export function parseProviderCsv(csv: string): ProviderOrder[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (l: string) => { const out: string[] = []; let cur = "", q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch; }
    out.push(cur); return out.map((x) => x.trim()); };
  const head = split(lines[0]!).map((h) => h.toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iId = col("order id", "id", "order_id", "identifier"), iTot = col("total", "total (usd)", "total_usd");
  const iTax = col("tax", "tax (usd)"), iRef = col("refunded amount", "refunded_amount", "refunded"), iFee = col("fee", "fees", "processing fee");
  const iTest = col("test mode", "test_mode");
  if (iId < 0 || iTot < 0) throw new Error("CSV needs at least 'order id' and 'total' columns");
  const cents = (v: string | undefined) => v == null || v === "" ? 0 : Math.round(Number(v.replace(/[$,]/g, "")) * 100);
  return lines.slice(1).map(split).map((r) => ({
    orderId: r[iId]!, totalCents: cents(r[iTot]), taxCents: iTax >= 0 ? cents(r[iTax]) : 0,
    refundedCents: iRef >= 0 ? cents(r[iRef]) : 0, feeCents: iFee >= 0 ? cents(r[iFee]) : null,
    testMode: iTest >= 0 ? /^(1|true|yes)$/i.test(r[iTest] ?? "") : false,
  }));
}
