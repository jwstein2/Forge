/**
 * Free public signals. Wikimedia pageviews is a documented, keyless API that allows automated access with a descriptive
 * User-Agent. Views are an interest proxy for a topic, never search volume or purchases.
 */
import type { Fetcher } from "./fetch.ts";

export interface Point { period: string; value: number }
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function pageviewsUrl(article: string, end: Date): string {
  const e = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)); // first of the current (incomplete) month
  const last = new Date(e.getTime() - 86400000);                             // last full month
  const start = new Date(Date.UTC(last.getUTCFullYear() - 5, last.getUTCMonth() + 1, 1));
  const f = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}0100`;
  return `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(article.replace(/ /g, "_"))}/monthly/${f(start)}/${f(last)}`;
}

export function parsePageviews(json: string): Point[] {
  const items = (JSON.parse(json) as { items?: { timestamp: string; views: number }[] }).items ?? [];
  return items.map((i) => ({ period: `${i.timestamp.slice(0, 4)}-${i.timestamp.slice(4, 6)}`, value: Number(i.views) }));
}

export interface SeasonSummary {
  months: number; average: number; lastTwelve: number | null; priorTwelve: number | null; yoyChangePct: number | null;
  monthIndex: { month: string; index: number }[]; peakMonths: string[]; troughMonths: string[]; amplitude: number | null;
}

/** Calendar-month index = mean views in that month / mean of all months. Peaks are months >= 1.15, troughs <= 0.87. */
export function summarize(points: Point[]): SeasonSummary {
  const n = points.length;
  const avg = n ? points.reduce((a, p) => a + p.value, 0) / n : 0;
  const by = new Map<number, number[]>();
  for (const p of points) { const m = Number(p.period.slice(5, 7)) - 1; by.set(m, [...(by.get(m) ?? []), p.value]); }
  const monthIndex = MONTHS.map((month, i) => {
    const v = by.get(i) ?? [];
    return { month, index: v.length && avg ? Math.round((v.reduce((a, b) => a + b, 0) / v.length / avg) * 100) / 100 : 0 };
  });
  const sum = (xs: Point[]) => xs.reduce((a, p) => a + p.value, 0);
  const lastTwelve = n >= 12 ? sum(points.slice(-12)) : null;
  const priorTwelve = n >= 24 ? sum(points.slice(-24, -12)) : null;
  const known = monthIndex.filter((m) => m.index > 0);
  return {
    months: n, average: Math.round(avg), lastTwelve, priorTwelve,
    yoyChangePct: lastTwelve !== null && priorTwelve ? Math.round(((lastTwelve - priorTwelve) / priorTwelve) * 1000) / 10 : null,
    monthIndex, peakMonths: known.filter((m) => m.index >= 1.15).map((m) => m.month), troughMonths: known.filter((m) => m.index <= 0.87).map((m) => m.month),
    amplitude: known.length ? Math.round((Math.max(...known.map((m) => m.index)) - Math.min(...known.map((m) => m.index))) * 100) / 100 : null,
  };
}

export async function collectPageviews(fetcher: Fetcher, article: string, now: Date): Promise<{ status: "collected" | "unavailable"; url: string; points: Point[]; summary: SeasonSummary | null; error?: string }> {
  const url = pageviewsUrl(article, now);
  const r = await fetcher(url, { accept: "application/json", maxBytes: 200_000, timeoutMs: 10000 });
  if (!r.ok) return { status: "unavailable", url, points: [], summary: null, error: r.error ?? `HTTP ${r.status}` };
  try {
    const points = parsePageviews(r.text);
    return points.length ? { status: "collected", url, points, summary: summarize(points) } : { status: "unavailable", url, points: [], summary: null, error: "no data points" };
  } catch (e) { return { status: "unavailable", url, points: [], summary: null, error: String((e as Error).message).slice(0, 200) }; }
}
