import type { Metric, MetricState, Period } from "@forge/contracts";

export function periodFor(label: string, start: Date, end: Date): Period {
  return { start: start.toISOString(), end: end.toISOString(), label };
}

/** Parse ?period= : 'mtd' (default), 'last7', 'last30', 'all', or 'YYYY-MM'. */
export function parsePeriod(raw: string | undefined, now = new Date()): Period {
  const p = (raw ?? "mtd").toLowerCase();
  const utc = (y: number, m: number, d = 1) => new Date(Date.UTC(y, m, d));
  if (p === "last7" || p === "last30") {
    const days = p === "last7" ? 7 : 30;
    return periodFor(`Last ${days} days`, new Date(now.getTime() - days * 86400000), now);
  }
  if (p === "all") return periodFor("All time", new Date(Date.UTC(2026, 0, 1)), now);
  const m = /^(\d{4})-(\d{2})$/.exec(p);
  if (m) {
    const y = Number(m[1]); const mo = Number(m[2]) - 1;
    const start = utc(y, mo); const end = utc(y, mo + 1);
    return periodFor(start.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }), start, end < now ? end : now);
  }
  return periodFor("Month to date", utc(now.getUTCFullYear(), now.getUTCMonth()), now);
}

export function metric(value: number | null, unit: Metric["unit"], state: MetricState, period: Period, asOf: string | null, source: string, extra: Partial<Metric> = {}): Metric {
  if (value === null && (state === "verified" || state === "estimated")) {
    throw new Error(`metric invariant: a ${state} metric must have a value (${source})`);
  }
  return { value, unit, state, period, asOf, source, ...extra };
}

export const usd = (cents: number): number => Math.round(cents) / 100;
