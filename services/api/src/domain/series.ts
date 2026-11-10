import type { Period, SourceFreshness, TrendSeries } from "@forge/contracts";
import { usd } from "../lib/metric.ts";

/** Daily series for trend charts. Days with no records are a real 0 only when the source is connected. */
export async function dailySeries(db: D1Database, kind: "revenue" | "page_views", nicheId: string | null, period: Period, ledger: SourceFreshness): Promise<TrendSeries> {
  const days: string[] = [];
  for (let t = Date.parse(period.start.slice(0, 10)); t <= Date.parse(period.end); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
  const base = { id: `${kind}:${nicheId ?? "portfolio"}`, nicheId: nicheId ?? "portfolio", period, asOf: ledger.asOf } as const;
  const label = kind === "revenue" ? "Verified gross sales" : "Page views (QA excluded)";
  const unit = kind === "revenue" ? "usd" : "count";
  const source = kind === "revenue" ? "D1 sales ledger" : "D1 events";
  const empty = (state: "unconnected" | "unknown", note: string): TrendSeries => ({ ...base, label, unit, state, source, note, points: days.map((date) => ({ date, value: null })) });
  if (ledger.mode === "unconnected") return empty("unconnected", "Ledger not connected.");
  let rows: { d: string; v: number }[];
  if (kind === "revenue") {
    rows = (await db.prepare(`SELECT substr(occurred_at,1,10) AS d, SUM(amount_cents) AS v FROM financial_events WHERE kind='sale' AND test_mode=0 AND owner_test=0 AND occurred_at >= ? AND occurred_at < ? ${nicheId ? "AND niche_id = ?" : ""} GROUP BY d`)
      .bind(...(nicheId ? [period.start, period.end, nicheId] : [period.start, period.end])).all<{ d: string; v: number }>()).results;
  } else {
    if (nicheId) {
      const n = await db.prepare(`SELECT event_path_prefix FROM niches WHERE id = ?`).bind(nicheId).first<{ event_path_prefix: string | null }>();
      if (!n?.event_path_prefix) return empty("unknown", "This site's events cannot be attributed yet (no site column).");
    }
    rows = (await db.prepare(`SELECT day AS d, SUM(count) AS v FROM funnel_daily WHERE event='page_view' AND is_test=0 AND day >= ? AND day <= ? ${nicheId ? "AND niche_id = ?" : ""} GROUP BY day`)
      .bind(...(nicheId ? [days[0], days[days.length - 1], nicheId] : [days[0], days[days.length - 1]])).all<{ d: string; v: number }>()).results;
  }
  const byDay = new Map(rows.map((r) => [r.d, Number(r.v)]));
  // Days after the source's asOf are unknown, not zero.
  const cutoff = ledger.asOf ? ledger.asOf.slice(0, 10) : null;
  return { ...base, label, unit, state: "verified", source, points: days.map((date) => ({
    date, value: cutoff && date > cutoff ? null : kind === "revenue" ? usd(byDay.get(date) ?? 0) : byDay.get(date) ?? 0 })) };
}
