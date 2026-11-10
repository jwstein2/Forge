import { Link, useParams } from 'react-router-dom';
import { useResource } from '../data/DataContext';
import type { Job, Niche, PortfolioSummary, Product } from '../data/types';
import { AlertList, ChannelRow } from '../components/blocks';
import { Icon } from '../components/Icon';
import {
  EmptyState,
  ErrorNote,
  ExternalLink,
  HealthBadge,
  Loading,
  NicheDot,
  PageHeader,
  Section,
  Stat,
  StateChip,
  StatusTag,
} from '../components/primitives';
import { Statement } from '../components/Statement';
import { channelCounts, sellable, sortAlerts } from '../lib/derive';
import { formatDateTime, formatValue } from '../lib/format';
import { JobTable } from './Operations';

export function NichesIndex() {
  const [res] = useResource((s) => s.getPortfolio(), []);
  if (res.status === 'loading') return <Loading />;
  if (res.status === 'error') return <ErrorNote error={res.error} />;
  const p = res.data;
  return (
    <div className="page">
      <PageHeader
        kicker="Executed niches"
        title="Every business FORGE operates"
        lede="Open a business to see its products, money, channels, scheduled work and integrations."
      />
      <ul className="niche-list">
        {p.niches.map((n) => {
          const ch = channelCounts(n.channels);
          const s = sellable(n);
          return (
            <li key={n.id}>
              <Link to={`/niches/${n.id}`} className="niche-row" style={{ ['--accent' as string]: `var(${n.accent})` }}>
                <span className="niche-row__name">
                  <NicheDot accent={n.accent} />
                  <span>
                    <strong>{n.name}</strong>
                    <span className="niche-row__tag">{n.tagline}</span>
                  </span>
                </span>
                <HealthBadge health={n.health} />
                <span className="niche-row__fact">
                  <span className="niche-row__k">Revenue</span>
                  {formatValue(n.financials.grossRevenue)}
                </span>
                <span className="niche-row__fact">
                  <span className="niche-row__k">Channels</span>
                  {ch.verified}/{ch.total} verified
                </span>
                <span className="niche-row__fact">
                  <span className="niche-row__k">Buyable</span>
                  {s.total ? `${s.live}/${s.total}` : 'No paid product'}
                </span>
                <Icon name="arrow" size={16} />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function NicheDetailScreen() {
  const { id = '' } = useParams();
  const [res, setRes] = useResource((s) => s.getPortfolio(), []);
  if (res.status === 'loading') return <Loading />;
  if (res.status === 'error') return <ErrorNote error={res.error} />;
  const n = res.data.niches.find((x) => x.id === id);
  if (!n)
    return (
      <div className="page">
        <PageHeader kicker="Executed niches" title="No business with that name" />
        <EmptyState icon="question" title="Check the address" level={2}>
          <p>
            <Link to="/niches">Back to executed niches</Link>
          </p>
        </EmptyState>
      </div>
    );
  return (
    <NicheDetail
      n={n}
      p={res.data}
      onJobChange={(j) => setRes({ ...res.data, jobs: res.data.jobs.map((x) => (x.id === j.id ? j : x)) })}
    />
  );
}

export function NicheDetail({ n, p, onJobChange }: { n: Niche; p: PortfolioSummary; onJobChange: (j: Job) => void }) {
  const jobs = p.jobs.filter((j) => j.nicheId === n.id);
  const sharedJobs = p.jobs.filter((j) => j.nicheId === 'portfolio');
  const alerts = sortAlerts(p.alerts.filter((a) => a.nicheId === n.id && a.state !== 'resolved'));
  const integrations = p.integrations.filter((i) => i.nicheIds.includes(n.id));
  return (
    <div className="page" style={{ ['--accent' as string]: `var(${n.accent})` }}>
      <p className="crumb">
        <Link to="/niches">
          <Icon name="back" size={14} /> Executed niches
        </Link>
      </p>
      <PageHeader
        kicker={n.stage}
        title={
          <span className="niche-title">
            <NicheDot accent={n.accent} />
            {n.name}
          </span>
        }
        lede={n.positioning}
        aside={
          <div className="niche-aside">
            <HealthBadge health={n.health} />
            <p className="niche-aside__reason">{n.healthReason}</p>
            <ExternalLink href={n.siteUrl}>{n.siteUrl.replace('https://', '').replace(/\/$/, '')}</ExternalLink>
          </div>
        }
      />

      <dl className="brief">
        <div>
          <dt>Audience</dt>
          <dd>{n.audience}</dd>
        </div>
        <div>
          <dt>Audience & Market Brief</dt>
          <dd>{n.briefVersion ? `v${n.briefVersion}` : <span className="muted">Not written yet</span>}</dd>
        </div>
        <div>
          <dt>Hosting</dt>
          <dd>{n.hosting}</dd>
        </div>
      </dl>

      <div className="stat-row">
        <Stat label="Verified revenue" metric={n.financials.grossRevenue} />
        <Stat label="Test-mode orders" metric={n.financials.testOrders} />
        <Stat label="Page views" metric={n.traffic.pageViews} />
        <Stat label="Conversion" metric={n.traffic.conversionRate} />
      </div>

      <Section title="Products" kicker="Catalogue and fulfilment" id="products">
        <ProductTable products={n.products} />
      </Section>

      <div className="grid-2">
        <Section title="Money" kicker="Contribution" id="money">
          <Statement fs={n.financials} title={n.name} />
        </Section>
        <Section title="Alerts" kicker={`${alerts.length} open`} id="alerts">
          {alerts.length ? (
            <AlertList alerts={alerts} niches={p.niches} />
          ) : (
            <EmptyState icon="check-circle" title="No open alerts">
              <p>Nothing for this business needs attention.</p>
            </EmptyState>
          )}
        </Section>
      </div>

      <Section title="Marketing channels" kicker="Verified publication only counts" id="channels">
        <ul className="channel-grid">
          {n.channels.map((c) => (
            <ChannelRow key={c.id} c={c} />
          ))}
        </ul>
      </Section>

      <Section title="Scheduled work" kicker="Jobs for this business" id="jobs">
        {jobs.length ? (
          <JobTable jobs={jobs} onChange={onJobChange} />
        ) : (
          <EmptyState icon="pulse" title="No jobs dedicated to this business">
            <p>
              {sharedJobs.length} portfolio-wide jobs also cover it, such as the site health check. See{' '}
              <Link to="/operations">Operations</Link>.
            </p>
          </EmptyState>
        )}
      </Section>

      <div className="grid-2">
        <Section title="Integrations" kicker="Health and native links" id="integrations">
          <ul className="int-list">
            {integrations.map((i) => (
              <li key={i.id} className="int">
                <div className="int__head">
                  <span className="int__name">{i.name}</span>
                  <HealthBadge health={i.health} />
                </div>
                <p className="int__detail">{i.detail}</p>
                <p className="int__meta">
                  <StatusTag status={i.status} /> Checked {formatDateTime(i.lastCheckedAt)}
                  {i.consoleUrl && (
                    <>
                      {' · '}
                      <ExternalLink href={i.consoleUrl}>Open</ExternalLink>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Experiments and opportunities" kicker="Optimisation" id="experiments">
          {n.experiments.length ? (
            <ul className="int-list">
              {n.experiments.map((e) => (
                <li key={e.id} className="int">
                  <div className="int__head">
                    <span className="int__name">{e.title}</span>
                    <StatusTag status={e.status} />
                  </div>
                  <p className="int__detail">{e.detail}</p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="compass" title="No experiments running">
              <p>Experiments start once there is enough traffic to measure a change.</p>
            </EmptyState>
          )}
        </Section>
      </div>
    </div>
  );
}

const CHECKOUT_LABEL: Record<Product['checkout'], string> = {
  live: 'Live',
  test_mode: 'Test mode',
  not_configured: 'Not configured',
  not_applicable: '—',
};
const FULFIL_LABEL: Record<Product['fulfillment'], string> = {
  verified: 'Verified',
  test_verified: 'Verified in test',
  unverified: 'Unverified',
  not_applicable: '—',
};

function ProductTable({ products }: { products: Product[] }) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Products table, scrollable">
      <table className="table">
        <caption className="sr-only">Products</caption>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">Site price</th>
            <th scope="col" className="num">Store price</th>
            <th scope="col">Checkout</th>
            <th scope="col">Delivery</th>
          </tr>
        </thead>
        <tbody>
          {products.map((pr) => (
            <tr key={pr.id} className={pr.status === 'failed' ? 'is-failed' : undefined}>
              <th scope="row">
                <span className="product__name">{pr.name}</span>
                {pr.issue && <span className="product__issue">{pr.issue}</span>}
              </th>
              <td>
                <StatusTag status={pr.status} />
              </td>
              <td className="num">{pr.listedPrice ? formatValue(pr.listedPrice, { cents: true }) : '—'}</td>
              <td className="num">
                {pr.storePrice ? (
                  <span className="cell-metric">
                    {formatValue(pr.storePrice, { cents: true })} <StateChip state={pr.storePrice.state} compact />
                  </span>
                ) : (
                  '—'
                )}
              </td>
              <td>{CHECKOUT_LABEL[pr.checkout]}</td>
              <td>{FULFIL_LABEL[pr.fulfillment]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
