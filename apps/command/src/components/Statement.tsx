import type { FinancialStatement, Metric } from '../data/types';
import { formatValue } from '../lib/format';
import { Provenance, StateChip } from './primitives';

type Row = { label: string; metric: Metric; sign: '' | '−'; key: string };

/**
 * The contribution statement: gross revenue down to estimated contribution, line by line,
 * each with its evidence state. Test-mode orders are listed beside it, never inside it.
 */
export function Statement({ fs, title = 'Contribution statement' }: { fs: FinancialStatement; title?: string }) {
  const rows: Row[] = [
    { key: 'gross', label: 'Gross revenue', metric: fs.grossRevenue, sign: '' },
    { key: 'refunds', label: 'Refunds', metric: fs.refunds, sign: '−' },
    { key: 'fees', label: 'Payment fees', metric: fs.paymentFees, sign: '−' },
    { key: 'product', label: 'Product costs', metric: fs.productCosts, sign: '−' },
    { key: 'software', label: 'Software & hosting', metric: fs.softwareAndHosting, sign: '−' },
    { key: 'ai', label: 'AI & agent usage', metric: fs.aiUsage, sign: '−' },
    { key: 'marketing', label: 'Marketing spend', metric: fs.marketingSpend, sign: '−' },
    { key: 'shared', label: 'Allocated shared costs', metric: fs.allocatedShared, sign: '−' },
  ];
  return (
    <div className="statement">
      <table className="table statement__table">
        <caption className="statement__cap">
          <span>{title}</span>
          <span className="statement__period">{fs.period.label}</span>
        </caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Line</th>
            <th scope="col">Evidence</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.metric.value === null ? 'is-missing' : undefined}>
              <th scope="row">{r.label}</th>
              <td className="statement__state">
                <StateChip state={r.metric.state} compact />
              </td>
              <td className="num">
                {r.metric.value === null ? '—' : `${r.sign && r.metric.value !== 0 ? r.sign : ''}${formatValue(r.metric, { cents: true })}`}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="statement__total">
            <th scope="row">Estimated contribution</th>
            <td className="statement__state">
              <StateChip state={fs.contribution.state} compact />
            </td>
            <td className="num" data-testid="contribution-value">
              {fs.contribution.value === null ? 'Incomplete' : formatValue(fs.contribution, { cents: true })}
            </td>
          </tr>
        </tfoot>
      </table>
      {fs.missingLines.length > 0 && (
        <div className="statement__gap">
          <p className="statement__gap-title">Not yet established</p>
          <ul>
            {fs.missingLines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {fs.contribution.note && <p className="statement__gap-note">{fs.contribution.note}</p>}
        </div>
      )}
      <div className="statement__side">
        <div>
          <span className="statement__side-label">Live orders</span>
          <strong>{formatValue(fs.orders)}</strong>
        </div>
        <div>
          <span className="statement__side-label">
            Test-mode orders <StateChip state="test_only" compact />
          </span>
          <strong className="muted">{formatValue(fs.testOrders)}</strong>
        </div>
      </div>
      <Provenance metric={fs.grossRevenue} />
    </div>
  );
}
