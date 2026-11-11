import { Link } from 'react-router-dom';
import type { FinancialStatement, Metric, Niche } from '../data/types';
import { formatValue } from '../lib/format';
import { NicheDot, StateChip } from './primitives';

const COST_LINES: { key: keyof FinancialStatement; label: string }[] = [
  { key: 'refunds', label: 'Refunds' },
  { key: 'paymentFees', label: 'Payment fees' },
  { key: 'productCosts', label: 'Product costs' },
  { key: 'softwareAndHosting', label: 'Software & hosting' },
  { key: 'aiUsage', label: 'AI & agent usage' },
  { key: 'marketingSpend', label: 'Marketing spend' },
  { key: 'allocatedShared', label: 'Allocated shared costs' },
];

/** Costs that are established, summed; plus the lines that are not. Known costs never stand in for total costs. */
export function knownCosts(fs: FinancialStatement): { known: number; unknown: string[] } {
  let known = 0;
  const unknown: string[] = [];
  for (const l of COST_LINES) {
    const m = fs[l.key] as Metric;
    if (m.value === null) unknown.push(l.label);
    else known += Math.abs(m.value);
  }
  return { known, unknown };
}

const usd = (v: number) => `$${v.toFixed(2)}`;

/**
 * Revenue, known costs and contribution side by side for each business. Contribution reads "Incomplete" while any
 * cost line is unknown, and the unknown lines are named in the same row.
 */
export function BusinessMoney({ niches, total }: { niches: Niche[]; total: FinancialStatement }) {
  const rows = [...niches.map((n) => ({ id: n.id, name: n.name, fs: n.financials, niche: n })), { id: 'portfolio', name: 'All businesses', fs: total, niche: null }];
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Money by business table, scrollable">
      <table className="table money">
        <caption className="sr-only">Revenue, known costs and contribution by business, {total.period.label}</caption>
        <thead>
          <tr>
            <th scope="col">Business</th>
            <th scope="col" className="num">
              Verified revenue
            </th>
            <th scope="col" className="num">
              Known costs
            </th>
            <th scope="col" className="num">
              Contribution
            </th>
            <th scope="col">Not yet known</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const c = knownCosts(r.fs);
            return (
              <tr key={r.id} className={r.niche ? undefined : 'money__total'}>
                <th scope="row">
                  {r.niche ? (
                    <Link to={`/niches/${r.id}`} className="money__name">
                      <NicheDot accent={r.niche.accent} /> {r.name}
                    </Link>
                  ) : (
                    r.name
                  )}
                </th>
                <td className="num">
                  {r.fs.grossRevenue.value === null ? '—' : formatValue(r.fs.grossRevenue, { cents: true })} <StateChip state={r.fs.grossRevenue.state} compact />
                </td>
                <td className="num">{usd(c.known)}</td>
                <td className="num" data-testid={`contribution-${r.id}`}>
                  {r.fs.contribution.value === null ? <span className="muted">Incomplete</span> : formatValue(r.fs.contribution, { cents: true })}
                </td>
                <td className="wrap small">{c.unknown.length ? c.unknown.join(', ') : <span className="muted">Nothing</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
