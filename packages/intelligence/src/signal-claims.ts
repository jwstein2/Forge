/** Turn collected signals into labelled claims: the measurement is VERIFIED, any seasonal reading of it is INFERRED. */
import type { SeasonSummary } from "./signals.ts";
import type { Claim } from "./types.ts";

export function pageviewClaims(candidate: string, article: string, sourceId: string, s: SeasonSummary, observedAt: string): Claim[] {
  const slug = `${candidate}_${article}`.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 60);
  const out: Claim[] = [{
    id: `c_sig_${slug}_avg`, statement: `The English Wikipedia article "${article}" averaged ${s.average.toLocaleString("en-US")} human views a month over ${s.months} months${s.yoyChangePct === null ? "" : `; the last 12 months were ${s.yoyChangePct >= 0 ? "+" : ""}${s.yoyChangePct}% versus the prior 12`}.`,
    evidence: "VERIFIED", confidence: "high", method: "public_dataset", source_ids: [sourceId], observed_at: observedAt, value: s.average, unit: "views/month",
    notes: "Wikimedia pageviews API, user agents only. Interest proxy, not search volume or purchases. Year-on-year change mostly tracks overall Wikipedia traffic, which fell across every article checked in 2026; it is not demand evidence.",
  }];
  if (s.months >= 24 && (s.peakMonths.length || s.troughMonths.length)) out.push({
    id: `c_sig_${slug}_season`, statement: `Interest in "${article}" peaks in ${s.peakMonths.join(", ") || "no month"} and is lowest in ${s.troughMonths.join(", ") || "no month"} (calendar-month index amplitude ${s.amplitude}).`,
    evidence: "INFERRED", confidence: "medium", method: "analyst_inference", source_ids: [sourceId], observed_at: observedAt,
    notes: "Seasonality read from a Wikipedia interest proxy; confirm with Google Trends when connected.",
  });
  return out;
}
