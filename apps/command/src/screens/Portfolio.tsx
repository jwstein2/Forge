import { Link } from 'react-router-dom';
import { useResource } from '../data/DataContext';
import type { Niche, OpportunityBoard, PortfolioSummary } from '../data/types';
import { BusinessMoney } from '../components/BusinessMoney';
import { ActivityFeed, AlertList, ChannelMatrix, groupActivity } from '../components/blocks';
import { TrendChart } from '../components/charts';
import { Icon } from '../components/Icon';
import {
  ErrorNote,
  HealthBadge,
  Loading,
  NicheDot,
  PageHeader,
  Provenance,
  Section,
  Stat,
  StateChip,
} from '../components/primitives';
import { Statement } from '../components/Statement';
import { channelCounts, portfolioHeadline, sellable, sortAlerts } from '../lib/derive';
import { formatDateTime, formatValue } from '../lib/format';
import type { Metric } from '../data/types';

export function PortfolioScreen() {
  const [res] = useResource((s) => s.getPortfolio(), []);
  const [opp] = useResource((s) => s.getOpportunities({ sample: false }), []);
  if (res.status === 'loading') return <Loading label="Loading portfolio" />;
  if (res.status === 'error') return <ErrorNote error={res.error} />;
  return <PortfolioView p={res.data} opportunities={opp.status === 'ready' ? opp.data : null} />;
}

const ACTIVITY_PREVIEW = 8;

export function PortfolioView({ p, opportunities = null }: { p: PortfolioSummary; opportunities?: OpportunityBoard | null }) {
  const head = portfolioHeadline(p);
  const allChannels = p.niches.flatMap((n) => n.channels);
  const ch = channelCounts(allChannels);
  const alerts = sortAlerts(p.alerts.filter((a) => a.state !== 'resolved'));
  const revenueTrend = p.trends.find((t) => t.id === 'revenue');
  const channelMetric: Metric = {
    value: ch.verified,
    unit: 'count',
    state: 'verified',
    source: 'Channel records (publication receipts)',
    period: { start: p.period.start, end: p.period.end, label: `of ${ch.total} tracked channels` },
    asOf: p.generatedAt,
  };

  return (
    <div className="page">
      <PageHeader
        kicker={`Portfolio · ${p.period.label}`}
        title={head.title}
        lede={head.lede}
        aside={
          <p className="as-of">
            <Icon name="lock" size={14} /> Read-only view · generated {formatDateTime(p.generatedAt)}
          </p>
        }
      />

      <div className="horizon" aria-label="Headline figures">
        <Stat label="Verified revenue" metric={p.financials.grossRevenue} size="lg" />
        <Stat label="Live orders" metric={p.financials.orders} size="lg" />
        <Stat label="Estimated contribution" metric={p.financials.contribution} size="lg" />
        <Stat label="Verified channels" metric={channelMetric} size="lg" />
      </div>

      <Section title="Businesses" kicker="Executed niches" id="niches">
        <ul className="territories">
          {p.niches.map((n) => (
            <li key={n.id}>
              <Territory n={n} />
            </li>
          ))}
        </ul>
      </Section>

      {opportunities && <NextBusiness board={opportunities} />}

      <Section title="Money by business" kicker={`${p.financials.period.label} · known costs only, never guessed`} id="money-by-business">
        <BusinessMoney niches={p.niches} total={p.financials} />
      </Section>

      <div className="grid-2">
        <Section title="Where the money stands" kicker="Contribution, all businesses" id="money">
          <Statement fs={p.financials} title="All businesses" />
        </Section>
        <Section
          title="Exceptions"
          kicker={`${alerts.length} open`}
          id="exceptions"
          actions={
            <Link className="text-link" to="/operations">
              All alerts <Icon name="arrow" size={14} />
            </Link>
          }
        >
          <AlertList alerts={alerts} niches={p.niches} limit={4} />
        </Section>
      </div>

      <div className="grid-2">
        <Section title="Trends" kicker="Last 7 days" id="trends">
          {revenueTrend && <TrendChart series={revenueTrend} />}
          <TrafficTable niches={p.niches} />
        </Section>
        <Section
          title="Recent verified activity"
          kicker="Autonomous work"
          id="activity"
          actions={
            groupActivity(p.activity).length > ACTIVITY_PREVIEW ? (
              <Link className="text-link" to="/operations#jobs">
                All jobs <Icon name="arrow" size={14} />
              </Link>
            ) : undefined
          }
        >
          <ActivityFeed events={p.activity} niches={p.niches} limit={ACTIVITY_PREVIEW} />
        </Section>
      </div>

      <Section title="Marketing channels" kicker="Configured is not active" id="channels">
        <ChannelMatrix niches={p.niches} />
      </Section>

      <Section title="Budget" kicker="Owner-approved limits" id="budget">
        <div className="stat-row">
          <Stat label="Cumulative ceiling" metric={p.budget.ceiling} />
          <Stat label="Approved envelopes" metric={p.budget.approvedEnvelopes} />
          <Stat label="Spent to date" metric={p.budget.spentToDate} />
          <Stat label="Monthly API cap" metric={p.budget.monthlyApiCap} />
        </div>
      </Section>
    </div>
  );
}

/** The Scout's strongest candidate for the next business, or an honest "not run". Sample data never appears here. */
function NextBusiness({ board }: { board: OpportunityBoard }) {
  if (board.state === 'sample') return null;
  const top = [...board.opportunities].sort((a, b) => a.rank - b.rank).find((o) => o.recommended);
  return (
    <section className="next-biz" aria-labelledby="next-biz-title">
      <div>
        <p className="kicker">Opportunity Scout</p>
        <h2 id="next-biz-title" className="next-biz__title">
          {board.state === 'not_run' ? 'The Scout has not run yet' : top ? `Strongest next business: ${top.name}` : 'No candidate cleared the bar in the last run'}
        </h2>
        <p className="muted small">
          {board.state === 'not_run'
            ? 'Ranked opportunities appear once it runs.'
            : `${board.opportunities.length} ranked${top ? ` · score ${top.score.total}/100 · ${top.confidence} confidence${top.strength && top.strength !== 'none' ? ` · ${top.strength} lead` : ''}` : ''}${board.run?.status === 'partial' ? ' · some sources unreachable' : ''}${board.runAt ? ` · run ${formatDateTime(board.runAt)}` : ''}. Launching always needs your approval.`}
        </p>
      </div>
      {board.state !== 'not_run' && (
        <Link className="btn btn--quiet" to="/opportunities">
          See the ranking <Icon name="arrow" size={14} />
        </Link>
      )}
    </section>
  );
}

function Territory({ n }: { n: Niche }) {
  const ch = channelCounts(n.channels);
  const s = sellable(n);
  return (
    <article className="territory" style={{ ['--accent' as string]: `var(${n.accent})` }}>
      <header className="territory__head">
        <h3 className="territory__name">
          <NicheDot accent={n.accent} />
          <Link to={`/niches/${n.id}`} className="territory__link">
            {n.name}
          </Link>
        </h3>
        <HealthBadge health={n.health} />
      </header>
      <p className="territory__stage">{n.stage}</p>
      <dl className="territory__facts">
        <div>
          <dt>Revenue</dt>
          <dd>
            {formatValue(n.financials.grossRevenue)} <StateChip state={n.financials.grossRevenue.state} compact />
          </dd>
        </div>
        <div>
          <dt>Channels verified</dt>
          <dd>
            {ch.verified}/{ch.total}
          </dd>
        </div>
        <div>
          <dt>Paid products buyable</dt>
          <dd>{s.total === 0 ? 'None listed' : `${s.live}/${s.total}`}</dd>
        </div>
      </dl>
      <p className="territory__reason">{n.healthReason}</p>
      <Provenance metric={n.financials.grossRevenue} hideSource />
      <Link to={`/niches/${n.id}`} className="territory__cta" aria-label={`Open ${n.name}`}>
        Open <Icon name="arrow" size={14} />
      </Link>
    </article>
  );
}

function TrafficTable({ niches }: { niches: Niche[] }) {
  return (
    <div className="table-wrap traffic" tabIndex={0} role="region" aria-label="Traffic and conversion table, scrollable">
      <table className="table">
        <caption className="table__cap">Traffic and conversion</caption>
        <thead>
          <tr>
            <th scope="col">Niche</th>
            <th scope="col" className="num">Page views</th>
            <th scope="col" className="num">Visitors</th>
            <th scope="col" className="num">Conversion</th>
          </tr>
        </thead>
        <tbody>
          {niches.map((n) => (
            <tr key={n.id}>
              <th scope="row">
                <NicheDot accent={n.accent} /> {n.name}
              </th>
              {[n.traffic.pageViews, n.traffic.visitors, n.traffic.conversionRate].map((m, i) => (
                <td key={i} className="num">
                  <span className="cell-metric">
                    {formatValue(m)} <StateChip state={m.state} compact />
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {niches[0] && <Provenance metric={niches[0].traffic.pageViews} />}
    </div>
  );
}
