import type { ActivityItem, FunnelRow, Health, Metric, NicheDetail, NicheSummary, Period, PortfolioSummary, SourceFreshness } from "@forge/contracts";
import { financials } from "./finance.ts";
import { listRegistry } from "./registry.ts";
import { evidenceFor, listAlerts, listBudgets, listChannels, listCosts, listIntegrations, listProducts } from "./records.ts";
import { metric, usd } from "../lib/metric.ts";

type R = Record<string, any>;
export interface Sources { ledger: SourceFreshness; n8n: SourceFreshness; all: SourceFreshness[] }

async function pageViews(db: D1Database, niche: R | null, period: Period, ledger: SourceFreshness): Promise<Metric> {
  const src = "D1 events (anonymous daily counters, QA traffic excluded)";
  if (ledger.mode === "unconnected") return metric(null, "count", "unconnected", period, null, src);
  const day0 = period.start.slice(0, 10); const day1 = period.end.slice(0, 10);
  if (niche && niche.beacon === "none") {
    return metric(null, "count", "unconnected", period, null, src, { note: "This site has no funnel beacon." });
  }
  if (niche && !niche.event_path_prefix) {
    return metric(null, "count", "unknown", period, ledger.asOf, src, { note: "This site's beacon writes root paths shared with other sites; events have no site column yet." });
  }
  const r = await db.prepare(`SELECT COALESCE(SUM(count),0) AS n FROM funnel_daily WHERE event='page_view' AND is_test=0 AND day >= ? AND day <= ? ${niche ? "AND niche_id = ?" : ""}`)
    .bind(...(niche ? [day0, day1, niche.id] : [day0, day1])).first<{ n: number }>();
  return metric(Number(r?.n ?? 0), "count", "verified", period, ledger.asOf, src,
    niche ? { note: `Attributed by path prefix ${niche.event_path_prefix}; earlier views were unattributable.` } : {});
}

async function channelMetric(db: D1Database, nicheId: string | null, period: Period): Promise<Metric> {
  const r = await db.prepare(`SELECT COUNT(*) AS n, MAX(last_verified_at) AS at FROM channels WHERE status='verified' ${nicheId ? "AND niche_id = ?" : ""}`)
    .bind(...(nicheId ? [nicheId] : [])).first<{ n: number; at: string | null }>();
  return metric(Number(r?.n ?? 0), "count", "verified", period, r?.at ?? null, "Channel register (verified = publication receipt on record)");
}

async function nicheSummary(db: D1Database, n: R, period: Period, s: Sources): Promise<NicheSummary> {
  const fin = await financials(db, n.id, period, s.ledger);
  const products = await listProducts(db, n.id);
  const alerts = await listAlerts(db, { state: "open", nicheId: n.id });
  const jobs = await listRegistry(db, { nicheId: n.id, includeShared: false, n8n: s.n8n });
  const canTakePayment = products.some((p) => p.tier === "paid" && p.checkoutStatus === "live" && p.status === "LIVE");
  const reasons: string[] = [];
  let health: Health = "healthy";
  if (!canTakePayment) { health = "blocked"; reasons.push("No paid product can be purchased live."); }
  const own = alerts.filter((a) => a.nicheId === n.id);
  if (own.some((a) => a.severity === "critical")) { health = "blocked"; reasons.push(...own.filter((a) => a.severity === "critical").map((a) => a.title)); }
  const late = jobs.filter((j) => j.heartbeat === "late");
  if (late.length) { if (health === "healthy") health = "degraded"; reasons.push(...late.map((j) => `${j.name} is late`)); }
  if (health === "healthy" && own.some((a) => a.severity === "warning")) { health = "degraded"; reasons.push(...own.filter((a) => a.severity === "warning").map((a) => a.title)); }
  return {
    id: n.id, name: n.name, tagline: n.tagline, lifecycle: n.lifecycle, health, healthReasons: [...new Set(reasons)],
    siteUrl: n.site_url, canTakePayment,
    revenue: fin.grossSales, orders: fin.orders, testOrders: fin.testOrders, contribution: fin.contribution,
    pageViews: await pageViews(db, n, period, s.ledger), activeVerifiedChannels: await channelMetric(db, n.id, period),
    openAlerts: alerts.length,
  };
}

export async function portfolioSummary(db: D1Database, period: Period, s: Sources): Promise<PortfolioSummary> {
  const niches = (await db.prepare(`SELECT * FROM niches WHERE lifecycle <> 'retired' ORDER BY name`).all<R>()).results;
  const summaries = await Promise.all(niches.map((n) => nicheSummary(db, n, period, s)));
  const fin = await financials(db, null, period, s.ledger);
  const alerts = await listAlerts(db, { state: "open" });
  const budgets = await listBudgets(db);
  const b = budgets.find((x) => x.id === "bud_forge"); const api = budgets.find((x) => x.id === "bud_api_month");
  const budgetMetric = (cents: number | undefined, label: string, state: "verified" | "estimated") =>
    cents == null ? metric(null, "usd", "unknown", period, null, label) : metric(usd(cents), "usd", state, period, null, label);
  const unknowns = [
    ...fin.missingLines,
    ...(s.all.filter((x) => x.mode === "unconnected").map((x) => `${x.label} is not connected`)),
  ];
  return {
    period, niches: summaries,
    totals: {
      revenue: fin.grossSales, refunds: fin.refunds, paymentFees: fin.paymentFees,
      knownCosts: metric(null, "usd", "unknown", period, null, "FORGE cost register", { note: "See financials.missingLines." }),
      contribution: fin.contribution, orders: fin.orders, testOrders: fin.testOrders,
      pageViews: await pageViews(db, null, period, s.ledger), activeVerifiedChannels: await channelMetric(db, null, period),
    },
    financials: fin,
    budget: {
      ceiling: budgetMetric(b?.ceilingCents, "BUDGET_LEDGER.md (cumulative ceiling)", "verified"),
      approvedEnvelopes: budgetMetric(b?.approvedCents, "BUDGET_LEDGER.md (approved envelopes)", "verified"),
      spentToDate: budgetMetric(b?.spentCents, "BUDGET_LEDGER.md (spent)", "verified"),
      monthlyApiCap: budgetMetric(api?.ceilingCents, "Proposed monthly API cap (envelope E4)", "estimated"),
    },
    openAlerts: { critical: alerts.filter((a) => a.severity === "critical").length, warning: alerts.filter((a) => a.severity === "warning").length, info: alerts.filter((a) => a.severity === "info").length },
    recentActivity: await recentActivity(db, 20),
    unknowns: [...new Set(unknowns)],
  };
}

export async function recentActivity(db: D1Database, limit: number, nicheId?: string): Promise<ActivityItem[]> {
  const runs = (await db.prepare(`SELECT r.started_at AS at, e.niche_id, e.name, r.status, r.evidence_url FROM runs r JOIN registry_entries e ON e.id = r.registry_id
    ${nicheId ? "WHERE e.niche_id = ? OR e.niche_id IS NULL" : ""} ORDER BY r.started_at DESC LIMIT ?`).bind(...(nicheId ? [nicheId, limit] : [limit])).all<R>()).results
    .map((r): ActivityItem => ({ at: r.at, nicheId: r.niche_id, kind: "job_run", title: r.name, status: r.status, evidenceUrl: r.evidence_url ?? undefined }));
  const sales = (await db.prepare(`SELECT occurred_at AS at, niche_id, kind, amount_cents, product_name, test_mode FROM financial_events WHERE kind IN ('sale','refund')
    ${nicheId ? "AND niche_id = ?" : ""} ORDER BY occurred_at DESC LIMIT ?`).bind(...(nicheId ? [nicheId, limit] : [limit])).all<R>()).results
    .map((r): ActivityItem => ({ at: r.at, nicheId: r.niche_id, kind: "sale", title: `${r.kind === "sale" ? "Order" : "Refund"} $${usd(r.amount_cents).toFixed(2)} · ${r.product_name}`, status: r.test_mode ? "test_mode" : "live" }));
  return [...runs, ...sales].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

export async function nicheDetail(db: D1Database, id: string, period: Period, s: Sources): Promise<NicheDetail | null> {
  const n = await db.prepare(`SELECT * FROM niches WHERE id = ?`).bind(id).first<R>();
  if (!n) return null;
  const summary = await nicheSummary(db, n, period, s);
  const funnelRows = (await db.prepare(`SELECT event, SUM(count) AS c FROM funnel_daily WHERE niche_id = ? AND is_test = 0 AND day >= ? AND day <= ? GROUP BY event ORDER BY event`)
    .bind(id, period.start.slice(0, 10), period.end.slice(0, 10)).all<R>()).results;
  const funnel: FunnelRow[] = n.event_path_prefix
    ? funnelRows.map((r) => ({ event: r.event, count: Number(r.c), state: "verified", period, source: "D1 events" }))
    : [];
  return {
    ...summary, positioning: n.positioning,
    products: await listProducts(db, id), channels: await listChannels(db, id),
    jobs: await listRegistry(db, { nicheId: id, includeShared: true, n8n: s.n8n }),
    integrations: await listIntegrations(db, id), costs: await listCosts(db, id),
    alerts: await listAlerts(db, { nicheId: id }), financials: await financials(db, id, period, s.ledger),
    funnel, evidence: await evidenceFor(db, "niche", id),
  };
}
