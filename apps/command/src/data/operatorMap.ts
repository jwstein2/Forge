/**
 * Pure mappers for the FORGE Operator API (packages/operator/src/routes.ts, mounted at /api/v1/operator).
 * These shapes are not in @forge/contracts yet, so the raw types are declared here from the route handlers.
 */
import type { ChannelPolicy, CheckFinding, CheckRollup, ContentItem, OperatorSchedule, OperatorSummary, Severity } from './types';

export interface RawSchedule {
  id: string; kind: string; nicheId: string | null; spec: unknown; enabled: boolean;
  lastSlot: string | null; lastJobId: string | null; lastJobStatus: string | null; lastJobUpdatedAt: string | null;
}
export interface RawCheck {
  /** ok null + unknown true (Operator eb84f4e): FORGE could not run the check, so the site's state is unknown. */
  id: string; kind: string; nicheId: string | null; target: string; ok: boolean | null; unknown?: boolean;
  statusCode: number | null; latencyMs: number | null; findings: { code?: string; severity?: string; message?: string }[]; checkedAt: string;
}
export interface RawContent {
  id: string; nicheId: string; channelId: string | null; platform: string; title: string; status: string;
  publishBy: string | null; late: boolean; evidence: string | null; externalUrl: string | null; verifiedAt: string | null;
}
export interface RawPolicy {
  channelId: string; nicheId: string; platform: string; channelStatus: string; mode: string;
  publisher: string; dailyCap: number; windowEnd: string | null;
}
export interface RawSummary {
  id: string; periodStart: string; periodEnd: string; generatedAt: string;
  body: { period?: { start: string; end: string; label: string }; headline?: string[]; unknowns?: string[] } | null;
}

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

/** Cadence text from a schedule spec: {every: minutes} | {daily: "HH:MM"} | {weekly: {day, at}}. Unknown shapes say so. */
export function cadenceOf(spec: unknown): string {
  const s = (spec ?? {}) as { every?: number; daily?: string; weekly?: { day?: number; at?: string } };
  if (typeof s.every === 'number') return s.every % 60 === 0 ? `Every ${s.every / 60 === 1 ? 'hour' : `${s.every / 60} hours`}` : `Every ${s.every} min`;
  if (typeof s.daily === 'string') return `Daily ${s.daily} UTC`;
  if (s.weekly && typeof s.weekly.day === 'number') return `${DAYS[s.weekly.day] ?? `Day ${s.weekly.day}`} ${s.weekly.at ?? ''} UTC`.replace('  ', ' ');
  return 'Cadence unknown';
}

export function mapSchedule(s: RawSchedule): OperatorSchedule {
  return {
    id: s.id, kind: s.kind, nicheId: s.nicheId, cadence: cadenceOf(s.spec), enabled: s.enabled,
    lastSlot: s.lastSlot, lastJobStatus: s.lastJobStatus, lastJobUpdatedAt: s.lastJobUpdatedAt,
  };
}

const sev = (x: string | undefined): Severity => (x === 'critical' || x === 'warning' || x === 'info' ? x : 'warning');

/** Latest result per (kind, business, target), rolled up per (kind, business). Findings come only from those latest results. */
export function rollupChecks(rows: RawCheck[]): CheckRollup[] {
  const latest = new Map<string, RawCheck>();
  for (const r of rows) {
    const k = `${r.kind}|${r.nicheId ?? ''}|${r.target}`;
    const prev = latest.get(k);
    if (!prev || r.checkedAt > prev.checkedAt) latest.set(k, r);
  }
  const groups = new Map<string, CheckRollup>();
  for (const r of latest.values()) {
    const k = `${r.kind}|${r.nicheId ?? ''}`;
    const g = groups.get(k) ?? { kind: r.kind, nicheId: r.nicheId, targets: 0, passing: 0, unknown: 0, lastCheckedAt: r.checkedAt, findings: [] };
    g.targets += 1;
    if (r.ok === null || r.unknown) g.unknown += 1;
    else if (r.ok) g.passing += 1;
    if (r.checkedAt > g.lastCheckedAt) g.lastCheckedAt = r.checkedAt;
    for (const f of r.findings ?? []) {
      const finding: CheckFinding = { code: f.code ?? 'unknown', severity: sev(f.severity), message: f.message ?? '', target: r.target };
      if (g.findings.length < 4 && !g.findings.some((x) => x.code === finding.code && x.message === finding.message)) g.findings.push(finding);
    }
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => a.kind.localeCompare(b.kind) || (a.nicheId ?? '').localeCompare(b.nicheId ?? ''));
}

export function mapContent(x: RawContent): ContentItem {
  return {
    id: x.id, nicheId: x.nicheId, platform: x.platform, title: x.title, status: x.status, publishBy: x.publishBy,
    late: !!x.late, evidence: x.evidence, externalUrl: x.externalUrl, verifiedAt: x.verifiedAt,
  };
}

export function mapPolicy(x: RawPolicy): ChannelPolicy {
  return { ...x, dailyCap: Number(x.dailyCap) || 0 };
}

export function mapSummary(x: RawSummary | null): OperatorSummary | null {
  if (!x || !x.body) return null;
  return {
    id: x.id,
    period: x.body.period ?? { start: x.periodStart, end: x.periodEnd, label: `Week of ${x.periodStart.slice(0, 10)}` },
    generatedAt: x.generatedAt,
    headline: Array.isArray(x.body.headline) ? x.body.headline : [],
    unknowns: Array.isArray(x.body.unknowns) ? x.body.unknowns : [],
  };
}

/** Human label for an alert's source, so controls and Operator findings are recognisable. */
export function sourceLabel(source: string): string {
  const ctl = /^controls:(.+)$/.exec(source);
  if (ctl) return `Controls · ${ctl[1]}`;
  const ops = /^ops\.(.+)$/.exec(source);
  if (ops) return `Operator · ${ops[1].replace(/_/g, ' ')}`;
  if (/^audit\./.test(source)) return 'Nov 10 audit';
  if (source === 'heartbeat.watchdog') return 'Heartbeat watchdog';
  return source;
}
