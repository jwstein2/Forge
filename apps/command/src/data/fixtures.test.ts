import { accounts, alerts, jobs, niches, portfolio } from './fixtures';
import { sampleBuild, sampleOpportunities } from './samples';
import type { Metric } from './types';

/** Walk any object and collect every Metric-shaped value. */
function metrics(v: unknown, out: Metric[] = []): Metric[] {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('state' in o && 'unit' in o && 'period' in o && 'value' in o) out.push(o as unknown as Metric);
    else Object.values(o).forEach((x) => metrics(x, out));
  }
  return out;
}

describe('fixture honesty invariants', () => {
  const all = metrics(portfolio);

  it('has metrics to check', () => expect(all.length).toBeGreaterThan(50));

  it('every metric has a reporting period and a source', () => {
    for (const m of all) {
      expect(m.period.label, JSON.stringify(m)).toBeTruthy();
      expect(m.source, JSON.stringify(m)).toBeTruthy();
    }
  });

  it('unknown and unconnected metrics carry no value', () => {
    for (const m of all.filter((x) => x.state === 'unknown' || x.state === 'unconnected')) expect(m.value).toBeNull();
  });

  it('unconnected metrics have never been read', () => {
    for (const m of all.filter((x) => x.state === 'unconnected')) expect(m.asOf).toBeNull();
  });

  it('real data contains no sample values', () => {
    expect(all.some((m) => m.state === 'sample')).toBe(false);
  });

  it('verified revenue is $0 on every niche, matching the audit', () => {
    expect(portfolio.financials.grossRevenue).toMatchObject({ value: 0, state: 'verified' });
    for (const n of niches) expect(n.financials.grossRevenue.value).toBe(0);
  });

  it('contribution is incomplete while cost lines are unknown', () => {
    for (const fs of [portfolio.financials, ...niches.map((n) => n.financials)]) {
      expect(fs.contribution.value).toBeNull();
      expect(fs.missingLines.length).toBeGreaterThan(0);
    }
  });

  it('test orders are only ever test_only', () => {
    for (const fs of [portfolio.financials, ...niches.map((n) => n.financials)]) expect(fs.testOrders.state).toBe('test_only');
  });

  it('no daily traffic split is invented', () => {
    for (const t of portfolio.trends.filter((x) => x.id.startsWith('views'))) expect(t.points.every((p) => p.value === null)).toBe(true);
  });

  it('D6: no job succeeded after its last run', () => {
    for (const j of jobs) if (j.lastRunAt && j.lastSuccessAt) expect(j.lastSuccessAt <= j.lastRunAt, j.id).toBe(true);
  });

  it('D6: run counts are estimated for the period shown, not a 30-day month', () => {
    for (const j of jobs) if (j.monthlyRuns.state === 'estimated') expect(j.monthlyRuns.source).not.toMatch(/× 30/);
  });

  it('every alert says what happens next', () => {
    for (const a of alerts) expect(a.nextAction.length).toBeGreaterThan(5);
  });

  it('a job that never succeeded is not shown as healthy', () => {
    for (const j of jobs.filter((x) => x.lastSuccessAt === null)) expect(j.lastResult).toBe('failure');
  });
});

describe('account directory holds no secrets', () => {
  const banned = /pass(word)?$|secret|token$|apikey|api_key|pwd/i;
  it('has no secret-named fields', () => {
    for (const a of accounts) for (const k of Object.keys(a)) if (k !== 'passwordManagerRef') expect(k).not.toMatch(banned);
  });
  it('vault references are links or null, never a credential', () => {
    for (const a of accounts) {
      if (a.passwordManagerRef !== null) expect(a.passwordManagerRef).toMatch(/^(onepassword:\/\/|https:\/\/start\.1password\.com\/|https:\/\/[a-z0-9-]+\.1password\.com\/)/);
    }
  });
  it('identifiers do not look like keys', () => {
    for (const a of accounts) expect(a.identifier).not.toMatch(/sk-|ghp_|[A-Za-z0-9]{32,}/);
  });
});

describe('sample data is always labelled', () => {
  it('every sample metric is state sample', () => {
    for (const m of metrics([sampleOpportunities, sampleBuild])) expect(m.state).toBe('sample');
  });
  it('exactly one opportunity is recommended', () => {
    expect(sampleOpportunities.filter((o) => o.recommended)).toHaveLength(1);
  });
  it('no sample claim is labelled verified', () => {
    for (const o of sampleOpportunities) for (const c of [...o.demand, ...o.demographics]) expect(c.label).not.toBe('verified');
  });
});
