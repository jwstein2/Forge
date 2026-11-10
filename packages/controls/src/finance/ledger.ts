/**
 * Independent ledger controls (gates G5, G6, G16).
 *
 * These recompute revenue straight from raw ledger rows, without using the platform's import code, so
 * the Command figures can be cross-checked by a second implementation (QA item: "prove grossSales
 * excludes test and owner-test orders"). They never write to the ledger.
 */
import type { Finding } from "../findings.ts";
import { fmtUsd } from "./money.ts";

/** Raw row of D1 `quiltplankit-sales`.sales. `owner_test` exists from 2026-11-10 02:17 UTC; older snapshots lack it. */
export interface RawSale {
  id: string; event: string; order_id: string; test_mode: number; currency: string;
  total_cents: number; tax_cents: number; refunded_cents: number; product: string;
  created_at: string; vertical: string; owner_test?: number | null;
}
export interface ProductPrice {
  id: string; nicheId: string; name: string; tier: string;
  sitePriceCents: number | null; checkoutPriceCents: number | null; ledgerProductName: string | null;
  checkoutStatus?: string;
}

export interface RevenueBucket { orders: number; grossCents: number; refundsCents: number; taxCents: number }
export interface RevenueRecompute {
  period: { start: string; end: string };
  ownerTestColumnPresent: boolean;
  /** Real customer revenue: test_mode=0 AND owner_test=0 (net of tax). */
  live: Record<string, RevenueBucket>;
  liveTotal: RevenueBucket;
  /** Excluded from revenue, reported separately. */
  testMode: RevenueBucket;
  ownerTest: RevenueBucket;
  unattributed: RevenueBucket;   // live rows with vertical 'unknown' (counted in liveTotal, not in any niche)
}

const empty = (): RevenueBucket => ({ orders: 0, grossCents: 0, refundsCents: 0, taxCents: 0 });
const inPeriod = (t: string, p: { start: string; end: string }) => {
  const x = Date.parse(t); return x >= Date.parse(p.start) && x < Date.parse(p.end);
};
function add(b: RevenueBucket, s: RawSale) {
  if (s.event === "order_created") { b.orders++; b.grossCents += Number(s.total_cents) - Number(s.tax_cents || 0); b.taxCents += Number(s.tax_cents || 0); }
  else if (s.event === "order_refunded") b.refundsCents += Number(s.refunded_cents || 0);
}

export function recomputeRevenue(sales: RawSale[], period: { start: string; end: string }): RevenueRecompute {
  const out: RevenueRecompute = {
    period, ownerTestColumnPresent: sales.length === 0 || sales.every((s) => s.owner_test !== undefined),
    live: {}, liveTotal: empty(), testMode: empty(), ownerTest: empty(), unattributed: empty(),
  };
  for (const s of sales) {
    if (!inPeriod(s.created_at, period)) continue;
    if (Number(s.test_mode) === 1) { add(out.testMode, s); continue; }
    if (Number(s.owner_test) === 1) { add(out.ownerTest, s); continue; }
    add(out.liveTotal, s);
    if (!s.vertical || s.vertical === "unknown") { add(out.unattributed, s); continue; }
    add((out.live[s.vertical] ??= empty()), s);
  }
  return out;
}

/** Integrity checks over raw ledger rows and the product price registry. */
export function checkLedger(sales: RawSale[], products: ProductPrice[]): Finding[] {
  const f: Finding[] = [];
  const created = new Map<string, RawSale>();
  const dupes = new Set<string>();

  if (sales.length && sales.some((s) => s.owner_test === undefined)) {
    f.push({ code: "FIN-LI-06", gate: "G6", severity: "warning", nicheId: null, needsOwner: false,
      title: "Ledger rows have no owner_test flag",
      detail: "Rows were read without an owner_test column, so the owner's own verification purchases cannot be excluded from revenue. Read sales.owner_test (added 2026-11-10 02:17 UTC).",
      dedupeKey: "fin:ledger:owner_test_missing" });
  }

  for (const s of sales) {
    if (s.event === "order_created") { if (created.has(s.order_id)) dupes.add(s.order_id); else created.set(s.order_id, s); }
    const live = Number(s.test_mode) === 0;
    if (live && (!s.vertical || s.vertical === "unknown")) {
      f.push({ code: "FIN-LI-01", gate: "G6", severity: "critical", nicheId: null, needsOwner: false,
        title: `Live order ${s.order_id} has no niche`,
        detail: `Product "${s.product}" did not map to a niche, so its ${fmtUsd(s.total_cents)} cannot be attributed. Add vertical to checkout custom data or the product map.`,
        dedupeKey: `fin:ledger:unattributed:${s.order_id}`, evidence: { rowId: s.id } });
    }
    if ((s.currency || "USD").toUpperCase() !== "USD") {
      f.push({ code: "FIN-LI-05", gate: "G6", severity: "warning", nicheId: s.vertical || null, needsOwner: false,
        title: `Order ${s.order_id} is in ${s.currency}`,
        detail: "FORGE sums cents as USD. A non-USD row would be added at face value; convert using the payout report before reporting.",
        dedupeKey: `fin:ledger:currency:${s.order_id}`, evidence: { rowId: s.id } });
    }
  }
  for (const id of dupes) {
    f.push({ code: "FIN-LI-04", gate: "G6", severity: "critical", nicheId: created.get(id)?.vertical ?? null, needsOwner: false,
      title: `Order ${id} recorded twice`, detail: "Two order_created rows share one order id; revenue would double count.",
      dedupeKey: `fin:ledger:dupe:${id}` });
  }
  for (const s of sales.filter((x) => x.event === "order_refunded")) {
    const sale = created.get(s.order_id);
    if (!sale) {
      f.push({ code: "FIN-LI-02", gate: "G6", severity: "warning", nicheId: s.vertical || null, needsOwner: false,
        title: `Refund for unknown order ${s.order_id}`, detail: "A refund row has no matching order_created row. The sale webhook may have been missed.",
        dedupeKey: `fin:ledger:orphan_refund:${s.order_id}` });
    } else if (Number(s.refunded_cents) > Number(sale.total_cents)) {
      f.push({ code: "FIN-LI-03", gate: "G6", severity: "critical", nicheId: sale.vertical || null, needsOwner: false,
        title: `Refund exceeds sale on order ${s.order_id}`, detail: `Refunded ${fmtUsd(s.refunded_cents)} against a ${fmtUsd(sale.total_cents)} sale.`,
        dedupeKey: `fin:ledger:over_refund:${s.order_id}` });
    }
  }

  // Price integrity (G5): site price = checkout price = ledger amount.
  for (const p of products.filter((x) => x.tier === "paid")) {
    if (p.sitePriceCents != null && p.checkoutPriceCents != null && p.sitePriceCents !== p.checkoutPriceCents) {
      f.push({ code: "FIN-PR-01", gate: "G5", severity: "critical", nicheId: p.nicheId, needsOwner: true,
        title: `${p.name}: site price ${fmtUsd(p.sitePriceCents)} ≠ checkout ${fmtUsd(p.checkoutPriceCents)}`,
        detail: "Customers would be charged a different amount than advertised. Pick one price (owner decision) and update both.",
        dedupeKey: `fin:price:site_vs_checkout:${p.id}` });
    }
    if (p.checkoutPriceCents == null) continue;
    const rows = sales.filter((s) => s.event === "order_created" && p.ledgerProductName && s.product === p.ledgerProductName);
    for (const s of rows) {
      const net = Number(s.total_cents) - Number(s.tax_cents || 0);
      if (net !== p.checkoutPriceCents) {
        const live = Number(s.test_mode) === 0;
        f.push({ code: "FIN-PR-02", gate: "G5", severity: live ? "warning" : "info", nicheId: p.nicheId, needsOwner: false,
          title: `${p.name}: ledger amount ${fmtUsd(net)} ≠ checkout ${fmtUsd(p.checkoutPriceCents)} (order ${s.order_id}${live ? "" : ", test"})`,
          detail: "Either a discount was applied, tax was not separated, or the checkout price changed. Confirm against the payout report.",
          dedupeKey: `fin:price:ledger_vs_checkout:${s.order_id}` });
      }
    }
  }
  return f;
}
