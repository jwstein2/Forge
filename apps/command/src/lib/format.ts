import type { Metric, MetricState } from '../data/types';

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const num = new Intl.NumberFormat('en-US');

export const STATE_LABEL: Record<MetricState, string> = {
  verified: 'Verified',
  estimated: 'Estimated',
  inferred: 'Inferred',
  unknown: 'Unknown',
  unconnected: 'Not connected',
  test_only: 'Test mode only',
  sample: 'Sample',
};

/** Format a metric's value. Null values render as an em dash; the state chip says why. */
export function formatValue(m: Metric, opts: { cents?: boolean } = {}): string {
  if (m.value === null) return '—';
  const prefix = m.state === 'estimated' || m.state === 'inferred' ? '~' : '';
  if (m.unit === 'usd') {
    const whole = Number.isInteger(m.value) && !opts.cents;
    return prefix + (whole ? usd0 : usd2).format(m.value);
  }
  if (m.unit === 'pct') return `${prefix}${(m.value * 100).toFixed(1)}%`;
  return prefix + num.format(m.value);
}

export function formatMoney(v: number): string {
  return Number.isInteger(v) ? usd0.format(v) : usd2.format(v);
}

/** Relative freshness against a reference "now" (fixtures pin it for stable rendering). */
export function freshness(asOf: string | null, now: Date = new Date()): string {
  if (!asOf) return 'Never read';
  const diff = Math.max(0, now.getTime() - new Date(asOf).getTime());
  const min = Math.round(diff / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Contribution is only computable when every cost line is established. */
export function contributionOf(lines: Metric[], revenue: Metric): number | null {
  if (revenue.value === null) return null;
  let total = revenue.value;
  for (const l of lines) {
    if (l.value === null || l.state === 'unknown' || l.state === 'unconnected') return null;
    if (l.state === 'test_only' || l.state === 'sample') continue;
    total -= l.value;
  }
  return total;
}

/** Sum only verified values; anything else makes the total incomplete. */
export function sumVerified(ms: Metric[]): { value: number; complete: boolean } {
  let value = 0;
  let complete = true;
  for (const m of ms) {
    if (m.state === 'verified' && m.value !== null) value += m.value;
    else if (m.state !== 'test_only' && m.state !== 'sample') complete = false;
  }
  return { value, complete };
}
