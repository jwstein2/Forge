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

import { mapLifecycle } from './operatorMap';
import { proposalApplied } from '../components/operatorDecisions';

describe('operator phase 2 (proposal, recommendations, lifecycle)', () => {
  it('never turns an unconnected or failed MailerLite read into zero subscribers', () => {
    const groups = [{ id: 1, name: 'QPK', active: 0, unconfirmed: 0 }];
    for (const state of ['unconnected', 'error']) {
      const l = mapLifecycle({ snapshot: { state, groups }, sequences: [] });
      expect(l.snapshot.groups).toEqual([]);
    }
    const live = mapLifecycle({ snapshot: { state: 'live', takenAt: 't', groups: [{ id: 1, name: 'QPK', nicheId: 'quilt-plan-kit', active: 12, unconfirmed: 'x' }] }, sequences: [{ id: 'LC', nicheId: 'bidline', kind: 'welcome', name: 'W', status: 'draft', emails: [{}, {}], lint: [] }] });
    expect(live.snapshot.groups[0]).toEqual({ id: '1', name: 'QPK', nicheId: 'quilt-plan-kit', active: 12, unconfirmed: null });
    expect(live.sequences[0]).toMatchObject({ emails: 2, lint: [], mailerliteAutomationId: null });
  });

  it('knows when the proposal is already in force', () => {
    const p = { version: 'v', windowEnd: 'w', summary: '', channels: [{ channelId: 'a', nicheId: 'n', platform: 'pinterest', mode: 'standing', publisher: 'dry_run', dailyCap: 1, why: '', liveConnectionNeeded: '' }] };
    const pol = (approvalId: string | null, mode = 'standing') => [{ channelId: 'a', nicheId: 'n', platform: 'pinterest', channelStatus: 'verified', mode, publisher: 'dry_run', dailyCap: 1, windowEnd: null, approvalId }];
    expect(proposalApplied(p, pol('apr_1'))).toBe(true);
    expect(proposalApplied(p, pol(null))).toBe(false);
    expect(proposalApplied(p, pol('apr_1', 'draft_only'))).toBe(false);
  });

  it('treats missing phase 2 endpoints (404) as not offered, without a failure note', async () => {
    const base: Record<string, unknown> = { '/control': null, '/operator/summaries/latest': null, '/operator/schedules': [], '/operator/checks?limit=500': [], '/operator/content': [], '/operator/policies': [] };
    const f = (async (url: string) => {
      const p = String(url).replace('/api/v1', '');
      return p in base ? okJson(base[p]) : new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'no such route' } }), { status: 404 });
    }) as unknown as typeof fetch;
    const b = await createApiSource('/api/v1', { fetcher: f }).getOperator();
    expect(b.proposal).toBeNull();
    expect(b.recommendations).toBeNull();
    expect(b.lifecycle).toBeNull();
    expect(b.note).toBe('');
  });

  it('posts the proposal version once and explains a 409', async () => {
    const calls: { url: string; body: string }[] = [];
    const f = (status: number) =>
      (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: String(init.body) });
        return status === 200 ? okJson({ approvalId: 'apr_1', windowEnd: '2027-02-08T00:00:00Z' }) : new Response(JSON.stringify({ ok: false, error: { code: 'conflict', message: 'changed' } }), { status });
      }) as unknown as typeof fetch;
    expect(await createApiSource('/api/v1', { fetcher: f(200) }).applyPublishingProposal('2026-11-10.1')).toEqual({ approvalId: 'apr_1', windowEnd: '2027-02-08T00:00:00Z' });
    expect(calls[0].url).toBe('/api/v1/operator/policies/proposal/apply');
    expect(JSON.parse(calls[0].body)).toEqual({ version: '2026-11-10.1', sourceRef: 'command:operations' });
    await expect(createApiSource('/api/v1', { fetcher: f(409) }).applyPublishingProposal('old')).rejects.toThrow(/proposal changed/);
  });
});

import { slotIso } from '../components/operator';
describe('schedule slots', () => {
  it('parses minute-precision slots', () => {
    expect(Number.isNaN(Date.parse(slotIso('2026-11-09T08:00Z')))).toBe(false);
    expect(slotIso('2026-11-09T08:00Z')).toBe('2026-11-09T08:00:00Z');
    expect(slotIso('2026-11-09T08:00:00.000Z')).toBe('2026-11-09T08:00:00.000Z');
  });
});

import { mapScheduler, schedulerFact } from './operatorMap';
import { mapOpportunity, mapScoutRun } from './apiMap';
import { knownCosts } from '../components/BusinessMoney';
import { sourceText } from '../screens/Operations';
import { fixturesFinancials } from './__fixtures__/testFinancials';

describe('round 3: scheduler, scout run, money, heartbeat source', () => {
  const sched = (state: string, minutesSinceTick: number | null) => mapScheduler({ state, minutesSinceTick, lastTick: { at: '2026-11-11T01:00:00Z', queued: 2, failed24h: 0 }, queue: { backlogMinutes: 50 }, thresholds: { staleTickMinutes: 35, backlogMinutes: 45 } });
  it('makes a stopped scheduler a critical line and a backlog a warning', () => {
    expect(schedulerFact(sched('stale', 52))).toMatchObject({ value: 'Stopped', tone: 'critical', sub: expect.stringContaining('52 min ago') });
    expect(schedulerFact(sched('backlog', 3))).toMatchObject({ value: 'Ran 3 min ago', tone: 'warn', sub: expect.stringContaining('50 min') });
    expect(schedulerFact(sched('ok', 0.4)).value).toBe('Ran just now');
    expect(schedulerFact(sched('ok', 0.4)).tone).toBeUndefined();
    expect(schedulerFact(sched('never_observed', null)).value).toBe('Not seen yet');
  });

  it('takes the newest Scout run and its source re-check counts', () => {
    const r = mapScoutRun([
      { id: 'old', kind: 'scout', status: 'succeeded', startedAt: '2026-11-01T00:00:00Z', finishedAt: null },
      { id: 'rc', kind: 'source_recheck', status: 'succeeded', startedAt: '2026-11-12T00:00:00Z', finishedAt: null },
      { id: 'run_new', kind: 'scout', status: 'partial', startedAt: '2026-11-10T21:45:16Z', finishedAt: '2026-11-10T22:15:32Z', unconnected: ['Google Trends'], report: { sources: { checked: 26, confirmed: 14, reachable: 3, unreachable: 9, failed: 0 } } },
    ]);
    expect(r).toMatchObject({ id: 'run_new', status: 'partial', sources: { confirmed: 14, checked: 26 }, unconnected: ['Google Trends'] });
    expect(mapScoutRun([])).toBeNull();
  });

  it('maps live Scout fields: 0-5 criteria, raw vs adjusted, price with evidence, effort and falsifying test', () => {
    const o = mapOpportunity(
      { id: 'o1', opportunityKey: 'garden-planner', title: 'Garden Planner', score: 57, rank: 1, recommended: true, scoringModelVersion: '1.0.0', briefRef: null, runId: 'r', status: 'recommended',
        content: { raw_score: 70, evidence_coverage: 1, launch_effort: 'About 2 build weeks', support_load: 'Low', falsifying_test: 'Fewer than 1% of calculator users buy in 30 days.', recommendation_strength: 'narrow',
          proposed_offer: { model: 'one_time_digital', price: { value: 15, evidence: 'INFERRED', currency: 'USD' } },
          criterion_scores: [{ key: 'demand_evidence', score: 3, evidence: 'VERIFIED', rationale: 'Review counts show purchases.' }], gates: [] } },
      '2026-11-10T22:15:32Z',
    );
    expect(o.score).toMatchObject({ total: 57, raw: 70, coverage: 1 });
    expect(o.score.components[0]).toMatchObject({ value: 60, display: '3/5', rationale: 'Review counts show purchases.' });
    expect(o.score.components[0].weight).toBeUndefined();
    expect(o.offer.price).toBe('$15');
    expect(o).toMatchObject({ priceEvidence: 'inferred', effort: 'About 2 build weeks', falsifyingTest: expect.stringContaining('1%'), strength: 'narrow', verdict: 'go' });
    expect(o.economics.base.state).toBe('unknown'); // no economics in the run: never invented
  });

  it('sums only established cost lines and names the rest', () => {
    const c = knownCosts(fixturesFinancials);
    expect(c.unknown).toEqual(['Software & hosting', 'AI & agent usage']);
    expect(c.known).toBe(1.5);
  });

  it('says where a last success came from', () => {
    expect(sourceText('heartbeat')).toBe('reported by the runner');
    expect(sourceText('n8n.snapshot')).toBe('from a dated export');
  });
});
