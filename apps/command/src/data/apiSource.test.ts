import type * as C from './contracts';
import { ApiError, createApiSource } from './apiSource';
import { mapOpportunityBoard, needsOwner } from './apiMap';
import run from './__fixtures__/opportunity-run.fixture.json';

const period: C.Period = { start: '2026-11-01T00:00:00Z', end: '2026-11-10T23:59:59Z', label: 'Nov 1–10, 2026' };
const m = (value: number | null, state: C.MetricState, unit: C.Metric['unit'] = 'usd'): C.Metric => ({
  value,
  unit,
  state,
  period,
  asOf: value === null && state === 'unconnected' ? null : '2026-11-10T02:30:00Z',
  source: 'test',
});
const fin = (nicheId: string): C.FinancialBreakdown => ({
  nicheId,
  period,
  grossSales: m(0, 'verified'),
  refunds: m(0, 'verified'),
  discounts: m(0, 'verified'),
  paymentFees: m(0, 'verified'),
  productCosts: m(0, 'verified'),
  hostingAndSoftware: m(null, 'unknown'),
  aiUsage: m(null, 'unknown'),
  marketingSpend: m(0, 'verified'),
  allocatedShared: m(null, 'unknown'),
  contribution: m(null, 'unknown'),
  contributionKnownLinesOnly: m(0, 'estimated'),
  cashCollected: m(0, 'verified'),
  orders: m(0, 'verified', 'count'),
  testOrders: m(1, 'test_only', 'count'),
  testModeGross: m(19.99, 'test_only'),
  missingLines: ['hostingAndSoftware', 'aiUsage'],
});
const registry: C.RegistryEntry = {
  id: 'N8N-02', kind: 'workflow', name: 'Health check', nicheId: null, department: null, owner: null, runner: 'n8n',
  externalRef: 'x', trigger: null, cadence: 'Every 3 h', intervalMinutes: 180, model: null, costCapCents: null, retryBudget: null,
  status: 'LIVE', paused: false, pausable: false,
  lastRun: { id: 'r1', registryId: 'N8N-02', startedAt: '2026-11-10T00:07:00Z', finishedAt: '2026-11-10T00:08:00Z', status: 'success', evidenceUrl: null, modelCostCents: null, error: null, source: 'n8n.snapshot' },
  lastSuccess: { id: 'r1', registryId: 'N8N-02', startedAt: '2026-11-10T00:07:00Z', finishedAt: '2026-11-10T00:08:00Z', status: 'success', evidenceUrl: null, modelCostCents: null, error: null, source: 'n8n.snapshot' },
  heartbeat: 'late', runsLast30d: m(240, 'verified', 'count'), defects: [], notes: null,
};
const watchdog: C.RegistryEntry = { ...registry, id: 'FORGE-WATCHDOG', runner: 'forge', pausable: true, heartbeat: 'ok', name: 'Heartbeat watchdog' };
const detail: C.NicheDetail = {
  id: 'bidline', name: 'Bidline', tagline: 'Estimating tools', lifecycle: 'live', health: 'blocked', healthReasons: ['Paid kit not built.'],
  siteUrl: 'https://bidline.pages.dev/', canTakePayment: false, revenue: m(0, 'verified'), orders: m(0, 'verified', 'count'),
  testOrders: m(1, 'test_only', 'count'), contribution: m(null, 'unknown'), pageViews: m(2, 'verified', 'count'),
  activeVerifiedChannels: m(0, 'verified', 'count'), openAlerts: 2, positioning: 'Free calculators, paid kit.',
  products: [{ id: 'p1', nicheId: 'bidline', name: 'Kit', kind: 'spreadsheet', tier: 'paid', sitePriceCents: 1900, checkoutPriceCents: 1999,
    priceMismatch: true, status: 'FAILED', checkoutStatus: 'test_mode', deliveryStatus: 'unverified', notes: 'Identical to free template.', evidence: [] }],
  channels: [{ id: 'c1', nicheId: 'bidline', platform: 'pinterest', status: 'unconnected', cadence: null, accountUrl: null, lastVerifiedAt: null, lastVerifiedUrl: null, jobId: null, notes: null }],
  jobs: [], integrations: [], costs: [], alerts: [], financials: fin('bidline'), funnel: [], evidence: [],
};
const summary: C.PortfolioSummary = {
  period, niches: [detail], totals: {} as C.PortfolioSummary['totals'], financials: fin('portfolio'),
  budget: { ceiling: m(1500, 'verified'), approvedEnvelopes: m(106, 'verified'), spentToDate: m(0, 'verified'), monthlyApiCap: m(15, 'verified') },
  openAlerts: { critical: 1, warning: 1, info: 0 },
  recentActivity: [{ at: '2026-11-10T00:07:00Z', nicheId: null, kind: 'job_run', title: 'Health check passed', status: 'success' }],
  unknowns: [],
};
const alert: C.Alert = { id: 'a1', severity: 'warning', nicheId: 'bidline', source: 'audit', title: 'Prices differ', detail: null, state: 'open',
  firstSeen: '2026-11-10T01:00:00Z', lastSeen: '2026-11-10T02:00:00Z', nextAction: 'Platform thread aligns both prices.', evidenceUrl: null, needsOwner: true };
const revSeries: C.TrendSeries = { id: 'revenue-portfolio', label: 'Verified revenue', nicheId: 'portfolio', unit: 'usd', state: 'verified', period,
  asOf: '2026-11-10T02:30:00Z', source: 'D1 sales', points: [{ date: '2026-11-09', value: 0 }, { date: '2026-11-10', value: null }] };

const ok = <T,>(data: T) => ({ ok: true, data, meta: { apiVersion: '1.0.0', environment: 'development', generatedAt: '2026-11-10T02:31:00Z', sources: [] } });

function mockFetch(routes: Record<string, [number, unknown]>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const path = url.replace('http://api/api/v1', '');
    const key = `${init?.method ?? 'GET'} ${path}`;
    const hit = routes[key] ?? [404, { ok: false, error: { code: 'not_found', message: key } }];
    return new Response(JSON.stringify(hit[1]), { status: hit[0], headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const routes: Record<string, [number, unknown]> = {
  'GET /portfolio?period=mtd': [200, ok(summary)],
  'GET /niches/bidline': [200, ok(detail)],
  'GET /briefs?niche=bidline': [200, ok([{ id: 'b', nicheId: 'bidline', version: '1.0.0', schemaVersion: '1', status: 'draft', contentHash: 'h', createdAt: '2026-11-10T02:00:00Z', approvedBy: null, content: {} }])],
  'GET /jobs': [200, ok([registry, watchdog])],
  'GET /series?metric=revenue&niche=portfolio&period=last7': [200, ok(revSeries)],
  'GET /alerts': [200, ok([alert])],
  'GET /integrations': [200, ok([{ id: 'i1', service: 'Lemon Squeezy', nicheId: null, purpose: 'Checkout', status: 'unconnected', accessMode: 'none', lastCheckedAt: null, lastOkAt: null, detail: null, blocker: 'Owner activation' }])],
  'POST /jobs/FORGE-WATCHDOG/pause': [200, ok({ id: 'FORGE-WATCHDOG', paused: true })],
  'POST /jobs/N8N-02/pause': [409, { ok: false, error: { code: 'conflict', message: 'not FORGE-controlled' } }],
  'GET /opportunities': [200, ok({ state: 'not_run', runAt: null, scoringModelVersion: null, note: 'Scout not run', opportunities: [] })],
  'GET /builds': [200, ok({ state: 'none', note: 'No builds', builds: [] })],
  'GET /accounts': [200, ok([{ id: 'acc', service: 'n8n Cloud', nicheId: null, identifier: 'instance', status: 'active', url: null, passwordManagerRef: null, owner: 'James', notes: null }])],
};

describe('createApiSource', () => {
  it('sends the dev token and unwraps the envelope into view models', async () => {
    const { f, calls } = mockFetch(routes);
    const p = await createApiSource('http://api/api/v1', { devToken: 'tok', fetcher: f }).getPortfolio();
    expect((calls[0].init?.headers as Record<string, string>)['x-forge-dev-token']).toBe('tok');
    expect(p.generatedAt).toBe('2026-11-10T02:31:00Z');
    expect(p.financials.grossRevenue).toMatchObject({ value: 0, state: 'verified' });
    expect(p.financials.softwareAndHosting.state).toBe('unknown');
    expect(p.financials.contribution.value).toBeNull();
    expect(p.trends).toHaveLength(1);
    expect(p.trends[0]).toMatchObject({ id: 'revenue', state: 'verified' });
    expect(p.trends[0].points[1].value).toBeNull();
    const n = p.niches[0];
    expect(n.briefVersion).toBe('1.0.0 (draft)');
    expect(n.healthReason).toBe('Paid kit not built.');
    expect(n.products[0]).toMatchObject({ status: 'failed', checkout: 'test_mode', kind: 'paid_download' });
    expect(n.products[0].listedPrice?.value).toBe(19);
    expect(n.products[0].storePrice).toMatchObject({ value: 19.99, state: 'test_only' });
    expect(n.products[0].issue).toMatch(/prices differ/);
    expect(n.channels[0]).toMatchObject({ platform: 'Pinterest', state: 'not_connected' });
    expect(p.jobs.find((j) => j.id === 'N8N-02')).toMatchObject({ heartbeatOk: false, nicheId: 'portfolio', lastResult: 'success' });
    expect(p.jobs.find((j) => j.id === 'FORGE-WATCHDOG')).toMatchObject({ runner: 'forge', heartbeatOk: true, pausable: true });
    expect(p.alerts[0]).toMatchObject({ needsOwner: true, detail: '' });
    expect(p.integrations[0]).toMatchObject({ health: 'unknown', status: 'proposed', nicheIds: ['bidline'] });
    expect(p.integrations[0].detail).toMatch(/^Not connected\..*Owner activation/);
    expect(p.activity[0].verified).toBe(true);
  });

  it('pauses a FORGE-controlled job', async () => {
    const { f } = mockFetch(routes);
    const s = createApiSource('http://api/api/v1', { fetcher: f });
    await s.getPortfolio();
    expect(await s.setJobPaused('FORGE-WATCHDOG', true)).toMatchObject({ id: 'FORGE-WATCHDOG', paused: true });
  });

  it('explains a 409 for jobs outside FORGE control', async () => {
    const { f } = mockFetch(routes);
    const s = createApiSource('http://api/api/v1', { fetcher: f });
    await s.getPortfolio();
    await expect(s.setJobPaused('N8N-02', true)).rejects.toThrow(/outside FORGE's control/);
  });

  it('passes through the honest empty states', async () => {
    const { f } = mockFetch(routes);
    const s = createApiSource('http://api/api/v1', { fetcher: f });
    expect((await s.getOpportunities()).state).toBe('not_run');
    expect((await s.getBuilds()).state).toBe('none');
    expect((await s.getAccounts())[0]).toMatchObject({ passwordManagerRef: null, identifier: 'instance' });
  });

  it('returns null for an unknown niche and throws typed errors otherwise', async () => {
    const { f } = mockFetch({ ...routes, 'GET /accounts': [401, { ok: false, error: { code: 'unauthorized', message: 'no token' } }] });
    const s = createApiSource('http://api/api/v1', { fetcher: f });
    expect(await s.getNiche('nope')).toBeNull();
    await expect(s.getAccounts()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('opportunity mapping (Intelligence fixture)', () => {
  const board = mapOpportunityBoard({
    state: 'ready',
    runAt: '2026-11-10T03:00:00Z',
    scoringModelVersion: '1.0.0',
    note: 'fixture',
    opportunities: run.opportunities.map((o) => ({
      id: o.opportunity_id, opportunityKey: o.opportunity_key, title: o.title, score: o.adjusted_score, rank: o.rank,
      recommended: o.recommended, scoringModelVersion: o.scoring_model_version, briefRef: null, runId: o.run_id,
      status: 'candidate' as const, content: o,
    })),
  });
  it('keeps one recommendation and maps gate failures to no-go', () => {
    expect(board.opportunities.filter((o) => o.recommended)).toHaveLength(1);
    const blocked = board.opportunities.find((o) => o.name.includes('niche-c'))!;
    expect(blocked.verdict).toBe('no_go');
    expect(blocked.risks[0]).toMatch(/Evidence coverage gate failed/);
  });
  it('never fabricates economics or seasonality the run did not produce', () => {
    const top = board.opportunities.find((o) => o.recommended)!;
    expect(top.economics.base.value).toBeNull();
    expect(top.economics.base.state).toBe('unknown');
    expect(top.seasonality.months).toBeNull();
    expect(top.gaps.some((g) => g.includes('Google Trends'))).toBe(true);
    expect(top.score.components.every((c) => c.value >= 0 && c.value <= 100)).toBe(true);
  });
});

it('omits the trend chart when /series fails', async () => {
  const r = { ...routes };
  delete r['GET /series?metric=revenue&niche=portfolio&period=last7'];
  const { f } = mockFetch(r);
  expect((await createApiSource('http://api/api/v1', { fetcher: f }).getPortfolio()).trends).toEqual([]);
});

describe('QA-001 D10 mapping', () => {
  it('builds: no PASS without a reviewer, money carries asOf', async () => {
    const { mapBuildBoard } = await import('./apiMap');
    const board = mapBuildBoard({ state: 'ready', note: '', builds: [{ id: 'b1', nicheId: null, opportunityId: null, title: 'T', status: 'running',
      blueprintRef: null, budgetCents: 15000, spentCents: 1200, createdAt: '2026-11-10T00:00:00Z',
      stages: [{ stage: 'research', status: 'passed', jobId: null, costCents: 600, evidence: [], notes: null }] }] }, '2026-11-10T03:00:00Z');
    const b = board.builds[0];
    expect(b.budget.asOf).toBe('2026-11-10T03:00:00Z');
    expect(b.stages[0].gate.result).toBe('NOT RUN');
    expect(b.stages[0].status).toBe('review');
  });
  it('site price without evidence is estimated, not verified', async () => {
    const { mapProduct } = await import('./apiMap');
    const pr = mapProduct({ ...detail.products[0], evidence: [] }, period, null);
    expect(pr.listedPrice?.state).toBe('estimated');
  });
});

describe('API 1.2.0 heartbeat stale', () => {
  it('renders stale like unknown, never like ok', async () => {
    const { mapJob } = await import('./apiMap');
    expect(mapJob({ ...registry, heartbeat: 'stale' }).heartbeatOk).toBeNull();
    expect(mapJob({ ...registry, heartbeat: 'ok' }).heartbeatOk).toBe(true);
  });
});

describe('needsOwner', () => {
  it('flags actions naming the owner', () => {
    expect(needsOwner('Owner completes store activation.')).toBe(true);
    expect(needsOwner('Platform thread builds the table.')).toBe(false);
    expect(needsOwner(null)).toBe(false);
  });
});
