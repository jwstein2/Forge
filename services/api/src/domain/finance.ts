/**
 * Per-niche and portfolio financials (constitution §11). Honesty rules:
 *  - Revenue comes only from ledger financial_events with test_mode=0 and owner_test=0.
 *  - A cost line with any unknown component is 'unknown', never $0.
 *  - Contribution is null/'unknown' whenever any line is unknown or unconnected; the known-lines subtotal
 *    is reported separately and labelled 'estimated'.
 */
import type { FinancialBreakdown, Metric, Period, SourceFreshness } from "@forge/contracts";
import { metric, usd } from "../lib/metric.ts";

interface CostRow { niche_id: string | null; category: string; vendor: string; item: string; amount_cents: number | null; cadence: string; evidence: string; starts_on: string | null }

const DAY = 86400000;
function prorate(c: CostRow, period: Period): number | null {
  if (c.amount_cents == null) return null;
  const days = Math.max(0, (Date.parse(period.end) - Date.parse(period.start)) / DAY);
  switch (c.cadence) {
    case "monthly": case "usage": return (c.amount_cents * days) / 30.4375;
    case "annual": return (c.amount_cents * days) / 365.25;
    case "one_time": {
      if (!c.starts_on) return 0;
      const t = Date.parse(c.starts_on);
      return t >= Date.parse(period.start) && t < Date.parse(period.end) ? c.amount_cents : 0;
    }
    default: return null;
  }
}

export async function financials(db: D1Database, nicheId: string | null, period: Period, ledger: SourceFreshness): Promise<FinancialBreakdown> {
  const scope = nicheId ?? "portfolio";
  const src = "D1 sales ledger";
  const ledgerConnected = ledger.mode !== "unconnected";
  const nicheClause = nicheId ? "AND niche_id = ?" : "";
  const params = (extra: unknown[]) => (nicheId ? [...extra, nicheId] : extra);

  const sum = async (kind: string, test: 0 | 1) => {
    const r = await db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS c, COUNT(*) AS n FROM financial_events
      WHERE kind = ? AND test_mode = ? AND owner_test = 0 AND occurred_at >= ? AND occurred_at < ? ${nicheClause}`)
      .bind(...params([kind, test, period.start, period.end])).first<{ c: number; n: number }>();
    return { cents: Number(r?.c ?? 0), n: Number(r?.n ?? 0) };
  };
  const unconnected = (unit: Metric["unit"], source: string, note?: string) => metric(null, unit, "unconnected", period, null, source, note ? { note } : {});

  const missing: string[] = [];
  let gross: Metric, refunds: Metric, orders: Metric, testOrders: Metric, testGross: Metric, fees: Metric;
  let grossCents = 0, refundCents = 0, feeCents: number | null = 0;
  if (ledgerConnected) {
    const g = await sum("sale", 0); const r = await sum("refund", 0); const tg = await sum("sale", 1);
    grossCents = g.cents; refundCents = r.cents;
    const note = ledger.mode === "snapshot" ? "From a read-only ledger snapshot; see asOf." : undefined;
    gross = metric(usd(g.cents), "usd", "verified", period, ledger.asOf, src, note ? { note } : {});
    refunds = metric(usd(r.cents), "usd", "verified", period, ledger.asOf, src);
    orders = metric(g.n, "count", "verified", period, ledger.asOf, src);
    testOrders = metric(tg.n, "count", "test_only", period, ledger.asOf, src, { note: "Test-mode orders; never counted as revenue." });
    testGross = metric(usd(tg.cents), "usd", "test_only", period, ledger.asOf, src);
    const f = await sum("payment_fee", 0);
    if (g.n === 0) { feeCents = 0; fees = metric(0, "usd", "verified", period, ledger.asOf, src, { note: "No live orders, so no processing fees." }); }
    else if (f.n > 0) { feeCents = f.cents; fees = metric(usd(f.cents), "usd", "verified", period, ledger.asOf, src); }
    else { feeCents = null; fees = unconnected("usd", "Lemon Squeezy", "Fees are not in the ledger; needs Lemon Squeezy API."); missing.push("Payment processing fees"); }
  } else {
    gross = unconnected("usd", src); refunds = unconnected("usd", src); orders = unconnected("count", src);
    testOrders = unconnected("count", src); testGross = unconnected("usd", src);
    fees = unconnected("usd", "Lemon Squeezy"); feeCents = null;
    missing.push("Gross sales (ledger unconnected)", "Refunds (ledger unconnected)", "Payment processing fees");
  }

  // Cost lines from cost_items (+ usage_records for AI).
  const costs = (await db.prepare(`SELECT niche_id, category, vendor, item, amount_cents, cadence, evidence, starts_on FROM cost_items`).all<CostRow>()).results;
  const liveNiches = Number((await db.prepare(`SELECT COUNT(*) AS n FROM niches WHERE lifecycle = 'live'`).first<{ n: number }>())?.n ?? 1) || 1;
  const usage = await db.prepare(`SELECT COALESCE(SUM(cost_cents),0) AS c, COUNT(*) AS n FROM usage_records WHERE at >= ? AND at < ? ${nicheClause}`)
    .bind(...params([period.start, period.end])).first<{ c: number; n: number }>();

  const line = (label: string, cats: string[], opts: { direct: boolean; shared: boolean }): { m: Metric; cents: number | null } => {
    const rows = costs.filter((c) => cats.includes(c.category) && (
      (opts.direct && (nicheId ? c.niche_id === nicheId : c.niche_id !== null)) ||
      (opts.shared && c.niche_id === null)));
    const share = nicheId && opts.shared ? 1 / liveNiches : 1;
    if (rows.length === 0) {
      return { m: metric(0, "usd", "estimated", period, null, "FORGE cost register", { note: "No cost records in this category; budget ledger shows $0 spent." }), cents: 0 };
    }
    let total = 0; const unknown: string[] = [];
    for (const r of rows) { const v = prorate(r, period); if (v == null) unknown.push(`${r.vendor} ${r.item}`); else total += v * share; }
    if (unknown.length) {
      missing.push(`${label}: ${unknown.join(", ")}`);
      return { m: metric(null, "usd", "unknown", period, null, "FORGE cost register", { note: `Unknown: ${unknown.join(", ")}` }), cents: null };
    }
    const allVerified = rows.every((r) => r.evidence === "VERIFIED");
    return { m: metric(usd(total), "usd", allVerified ? "verified" : "estimated", period, null, "FORGE cost register"), cents: total };
  };

  const direct = { direct: true, shared: !nicheId };     // portfolio view: shared costs sit in their own lines
  const product = line("Product costs", ["product"], direct);
  const hosting = line("Hosting & software", ["hosting_software", "domain"], direct);
  const marketing = line("Marketing", ["marketing"], direct);
  const aiCost = line("AI usage", ["ai_usage"], direct);
  let ai = aiCost;
  if (Number(usage?.n ?? 0) > 0 && aiCost.cents != null) {
    const c = aiCost.cents + Number(usage!.c);
    ai = { m: metric(usd(c), "usd", "estimated", period, null, "usage_records + cost register"), cents: c };
  }
  const shared = nicheId
    ? line("Allocated shared costs", ["hosting_software", "domain", "ai_usage", "marketing", "product", "payment", "other"], { direct: false, shared: true })
    : { m: metric(0, "usd", "estimated", period, null, "FORGE cost register", { note: "Portfolio view: shared costs are included in the lines above." }), cents: 0 };
  const other = line("Other", ["other", "payment"], direct);

  const parts = [product, hosting, marketing, ai, shared, other];
  const known = parts.reduce((a, p) => a + (p.cents ?? 0), 0) + (feeCents ?? 0);
  const anyUnknown = !ledgerConnected || feeCents == null || parts.some((p) => p.cents == null);
  const subtotal = grossCents - refundCents - known;
  const contribution = anyUnknown
    ? metric(null, "usd", "unknown", period, ledger.asOf, "computed", { note: `Not computable: ${missing.length} cost line(s) unknown or unconnected.` })
    : metric(usd(subtotal), "usd", "estimated", period, ledger.asOf, "computed", { note: "Estimated contribution; not owner cash flow." });
  const knownOnly = ledgerConnected
    ? metric(usd(subtotal), "usd", "estimated", period, ledger.asOf, "computed", { note: "Gross minus refunds minus only the known cost lines. Not a profit figure." })
    : metric(null, "usd", "unconnected", period, null, "computed");

  return {
    nicheId: scope, period,
    grossSales: gross, refunds,
    discounts: ledgerConnected ? metric(null, "usd", "unknown", period, ledger.asOf, src, { note: "Ledger stores totals after discounts; discount detail needs Lemon Squeezy." }) : unconnected("usd", src),
    paymentFees: fees, productCosts: product.m, hostingAndSoftware: hosting.m, aiUsage: ai.m,
    marketingSpend: marketing.m, allocatedShared: shared.m,
    contribution, contributionKnownLinesOnly: knownOnly,
    cashCollected: unconnected("usd", "Lemon Squeezy payouts", "Payout reconciliation not connected."),
    orders, testOrders, testModeGross: testGross,
    missingLines: [...new Set(missing)],
  };
}
