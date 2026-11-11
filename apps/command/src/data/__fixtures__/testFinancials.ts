import type { FinancialStatement, Metric } from '../types';
const period = { start: '2026-11-01T00:00:00Z', end: '2026-11-11T00:00:00Z', label: 'Nov 1–11, 2026' };
const m = (value: number | null, state: Metric['state'] = value === null ? 'unknown' : 'verified'): Metric => ({ value, unit: 'usd', state, period, asOf: null, source: 'test' });
export const fixturesFinancials: FinancialStatement = {
  period, grossRevenue: m(0), refunds: m(0), paymentFees: m(1.5), productCosts: m(-0), softwareAndHosting: m(null), aiUsage: m(null),
  marketingSpend: m(0), allocatedShared: m(0), contribution: m(null), orders: { ...m(0), unit: 'count' }, testOrders: { ...m(2, 'test_only'), unit: 'count' },
  missingLines: ['Software & hosting', 'AI & agent usage'],
};
