import { describe, expect, it } from 'vitest';
import { ApiError, UNREACHABLE, createApiSource } from './apiSource';
import { cadenceOf, mapSummary, rollupChecks, sourceLabel, type RawCheck } from './operatorMap';

const meta = { apiVersion: '1.2.0', environment: 'staging', generatedAt: '2026-11-10T04:10:00Z', sources: [] };
const okJson = (data: unknown, status = 200) => new Response(JSON.stringify({ ok: true, data, meta }), { status, headers: { 'content-type': 'application/json' } });

/** Shapes copied from staging D1 rows read on 2026-11-10 (read-only). */
const schedules = [
  { id: 'OPS-SITE-HEALTH', kind: 'ops.site_health', nicheId: null, spec: { every: 60 }, enabled: true, lastSlot: '2026-11-10T04:00Z', lastJobId: 'j1', lastJobStatus: 'queued', lastJobUpdatedAt: null },
  { id: 'OPS-SEO-AUDIT', kind: 'ops.seo_audit', nicheId: null, spec: { weekly: { day: 1, at: '06:00' } }, enabled: true, lastSlot: '2026-11-09T06:00Z', lastJobId: 'j2', lastJobStatus: 'succeeded', lastJobUpdatedAt: null },
];
const check = (o: Partial<RawCheck>): RawCheck => ({ id: 'c', kind: 'site_health', nicheId: 'bidline', target: 'https://bidline.pages.dev/', ok: false, statusCode: null, latencyMs: null, findings: [], checkedAt: '2026-11-10T03:46:00Z', ...o });
const subreq = { code: 'unreachable', severity: 'critical', message: 'No response: Too many subrequests by single Worker invocation.' };
const summaryRow = {
  id: 'sum_1', periodStart: '2026-11-02T00:00:00.000Z', periodEnd: '2026-11-09T00:00:00.000Z', generatedAt: '2026-11-10T04:00:14.152Z',
  body: { period: { start: '2026-11-02T00:00:00.000Z', end: '2026-11-09T00:00:00.000Z', label: 'Week of 2026-11-02' }, headline: ['Revenue: $0.00 gross from 0 live order(s).'], unknowns: ['Lemon Squeezy (unconnected)'] },
};

describe('operator mapping', () => {
  it('describes schedule cadences and admits unknown shapes', () => {
    expect(cadenceOf({ every: 60 })).toBe('Every hour');
    expect(cadenceOf({ every: 360 })).toBe('Every 6 hours');
    expect(cadenceOf({ every: 15 })).toBe('Every 15 min');
    expect(cadenceOf({ daily: '08:00' })).toBe('Daily 08:00 UTC');
    expect(cadenceOf({ weekly: { day: 1, at: '06:00' } })).toBe('Mondays 06:00 UTC');
    expect(cadenceOf({ cron: '* * * * *' })).toBe('Cadence unknown');
  });

  it('rolls checks up from the latest result per target only', () => {
    const rows = [
      check({ checkedAt: '2026-11-10T03:00:00Z', ok: false, findings: [subreq] }),
      check({ checkedAt: '2026-11-10T04:00:00Z', ok: true }), // newer pass supersedes the older failure
      check({ target: 'https://bidline.pages.dev/robots.txt', ok: false, findings: [subreq] }),
      check({ target: 'https://bidline.pages.dev/sitemap.xml', ok: false, findings: [subreq] }),
    ];
    const [g] = rollupChecks(rows);
    expect(g).toMatchObject({ kind: 'site_health', nicheId: 'bidline', targets: 3, passing: 1, lastCheckedAt: '2026-11-10T04:00:00Z' });
    expect(g.findings).toHaveLength(1); // identical messages are not repeated
    expect(g.findings[0].message).toContain('Too many subrequests'); // shown as recorded
  });

  it('counts checks FORGE could not run as unknown, not failing (checker_error)', () => {
    const [g] = rollupChecks([
      check({ ok: null, unknown: true, findings: [{ code: 'checker_error', severity: 'info', message: 'FORGE could not run this check. Site state UNKNOWN; no alert raised or cleared.' }] }),
      check({ target: 'https://bidline.pages.dev/robots.txt', ok: true }),
    ]);
    expect(g).toMatchObject({ targets: 2, passing: 1, unknown: 1 });
    expect(g.findings[0]).toMatchObject({ code: 'checker_error', severity: 'info' });
  });

  it('labels controls and Operator alert sources', () => {
    expect(sourceLabel('controls:FIN-PR-01')).toBe('Controls · FIN-PR-01');
    expect(sourceLabel('ops.site_health')).toBe('Operator · site health');
    expect(sourceLabel('audit.ws3')).toBe('Nov 10 audit');
    expect(sourceLabel('ledger.d1')).toBe('ledger.d1');
  });

  it('maps the generated weekly summary and tolerates a missing body', () => {
    expect(mapSummary(summaryRow)).toMatchObject({ period: { label: 'Week of 2026-11-02' }, headline: [expect.stringContaining('$0.00')], unknowns: ['Lemon Squeezy (unconnected)'] });
    expect(mapSummary(null)).toBeNull();
    expect(mapSummary({ ...summaryRow, body: null })).toBeNull();
  });
});

describe('api source: operator and access', () => {
  const routes: Record<string, unknown> = {
    '/control': { globalPause: false, pausedAt: null, pausedBy: null, reason: null },
    '/operator/summaries/latest': summaryRow,
    '/operator/schedules': schedules,
    '/operator/checks?limit=500': [check({ findings: [subreq] })],
    '/operator/content': [],
    '/operator/policies': [{ channelId: 'ch_qpk_pinterest', nicheId: 'quilt-plan-kit', platform: 'pinterest', channelStatus: 'verified', mode: 'draft_only', publisher: 'dry_run', dailyCap: 0, approvalId: null, windowEnd: null, updatedAt: null }],
  };
  const fetcher = (fail: string[] = []) =>
    (async (url: string) => {
      const path = String(url).replace('/api/v1', '');
      if (fail.includes(path)) return new Response(JSON.stringify({ ok: false, error: { code: 'internal', message: 'boom' } }), { status: 500 });
      return path in routes ? okJson(routes[path]) : new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

  it('assembles the operator board from the six endpoints', async () => {
    const b = await createApiSource('/api/v1', { fetcher: fetcher() }).getOperator();
    expect(b.state).toBe('ready');
    expect(b.note).toBe('');
    expect(b.control?.globalPause).toBe(false);
    expect(b.schedules.map((s) => s.cadence)).toEqual(['Every hour', 'Mondays 06:00 UTC']);
    expect(b.checks[0]).toMatchObject({ targets: 1, passing: 0 });
    expect(b.content).toEqual([]);
    expect(b.policies[0]).toMatchObject({ mode: 'draft_only', publisher: 'dry_run' });
    expect(b.summary?.headline[0]).toContain('$0.00');
  });

  it('leaves a failed part empty and says so, instead of guessing', async () => {
    const b = await createApiSource('/api/v1', { fetcher: fetcher(['/operator/checks?limit=500', '/control']) }).getOperator();
    expect(b.checks).toEqual([]);
    expect(b.control).toBeNull();
    expect(b.note).toMatch(/Could not load: emergency-stop state, site checks/);
  });

  it('explains an expired Access sign-in (redirect or HTML 401/403) and a network failure', async () => {
    const redirect = (async () => ({ type: 'opaqueredirect', status: 0, ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(createApiSource('/api/v1', { fetcher: redirect }).getAccounts()).rejects.toMatchObject({ status: 401, message: UNREACHABLE });
    const html403 = (async () => new Response('<html>Access</html>', { status: 403 })) as unknown as typeof fetch;
    await expect(createApiSource('/api/v1', { fetcher: html403 }).getAccounts()).rejects.toMatchObject({ status: 403, message: UNREACHABLE });
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const e = await createApiSource('/api/v1', { fetcher: offline }).getAccounts().catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('unreachable');
  });

  it('lists stored market briefs with the opportunity board, and says nothing when /briefs fails', async () => {
    const brief = { id: 'b1', nicheId: 'bidline', version: '1.0.0', schemaVersion: '1', status: 'draft', contentHash: 'h', createdAt: '2026-11-10T03:00:00Z', approvedBy: null, content: {} };
    const board = { state: 'not_run', runAt: null, scoringModelVersion: null, note: 'Scout not run.', opportunities: [] };
    const f = (briefsOk: boolean) =>
      (async (url: string) =>
        String(url).endsWith('/opportunities') ? okJson(board) : briefsOk ? okJson([brief]) : new Response('x', { status: 500 })) as unknown as typeof fetch;
    expect((await createApiSource('/api/v1', { fetcher: f(true) }).getOpportunities()).briefs).toEqual([
      { id: 'b1', nicheId: 'bidline', version: '1.0.0', status: 'draft', createdAt: '2026-11-10T03:00:00Z', approvedBy: null },
    ]);
    expect((await createApiSource('/api/v1', { fetcher: f(false) }).getOpportunities()).briefs).toBeUndefined();
  });
});
