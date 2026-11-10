import { contributionOf, formatValue, freshness, sumVerified } from './format';
import { niceMax } from '../components/charts';
import { metric } from '../data/fixtures';

describe('formatValue', () => {
  it('renders null as an em dash, never zero', () => {
    expect(formatValue(metric(null, 'usd', 'unknown', 'x'))).toBe('—');
  });
  it('prefixes estimates with a tilde', () => {
    expect(formatValue(metric(240, 'count', 'estimated', 'x'))).toBe('~240');
  });
  it('formats money and percentages', () => {
    expect(formatValue(metric(1500, 'usd', 'verified', 'x'))).toBe('$1,500');
    expect(formatValue(metric(19.99, 'usd', 'test_only', 'x'), { cents: true })).toBe('$19.99');
    expect(formatValue(metric(0.034, 'pct', 'verified', 'x'))).toBe('3.4%');
  });
});

describe('freshness', () => {
  const now = new Date('2026-11-10T04:05:00Z');
  it('says never read when there is no timestamp', () => expect(freshness(null, now)).toBe('Never read'));
  it('reports minutes and hours', () => {
    expect(freshness('2026-11-10T03:45:00Z', now)).toBe('20 min ago');
    expect(freshness('2026-11-10T01:05:00Z', now)).toBe('3 h ago');
  });
});

describe('contributionOf', () => {
  const rev = metric(100, 'usd', 'verified', 'x');
  it('subtracts verified costs', () => {
    expect(contributionOf([metric(10, 'usd', 'verified', 'x'), metric(5, 'usd', 'estimated', 'x')], rev)).toBe(85);
  });
  it('is null (incomplete) when any cost line is unknown or unconnected', () => {
    expect(contributionOf([metric(null, 'usd', 'unknown', 'x')], rev)).toBeNull();
    expect(contributionOf([metric(null, 'usd', 'unconnected', 'x')], rev)).toBeNull();
  });
  it('ignores test-mode values', () => {
    expect(contributionOf([metric(19.99, 'usd', 'test_only', 'x')], rev)).toBe(100);
  });
});

describe('sumVerified', () => {
  it('never adds test-mode or sample values into a verified total', () => {
    const r = sumVerified([metric(8, 'usd', 'test_only', 'x'), metric(3, 'usd', 'sample', 'x'), metric(2, 'usd', 'verified', 'x')]);
    expect(r).toEqual({ value: 2, complete: true });
  });
  it('flags incomplete totals', () => {
    expect(sumVerified([metric(null, 'usd', 'unknown', 'x')]).complete).toBe(false);
  });
});

describe('niceMax', () => {
  it('rounds up to 1/2/5 steps', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(37)).toBe(50);
    expect(niceMax(120)).toBe(200);
  });
});
