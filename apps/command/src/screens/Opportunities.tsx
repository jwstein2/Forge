import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useResource } from '../data/DataContext';
import type { EvidenceLabel, Opportunity, OpportunityBoard } from '../data/types';
import { Meter, SeasonBars } from '../components/charts';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorNote, Loading, PageHeader, SampleBanner, StateChip } from '../components/primitives';
import { formatValue } from '../lib/format';

export function OpportunitiesScreen() {
  const [params] = useSearchParams();
  const sample = params.get('preview') === 'sample';
  const [res] = useResource((s) => s.getOpportunities({ sample }), [sample]);
  if (res.status === 'loading') return <Loading />;
  if (res.status === 'error') return <ErrorNote error={res.error} />;
  return <OpportunitiesView board={res.data} />;
}

const VERDICT = { go: 'Go', hold: 'Hold', no_go: 'No-go' } as const;
const EVIDENCE: Record<EvidenceLabel, string> = { verified: 'Verified', estimated: 'Estimated', inferred: 'Inferred', unknown: 'Unknown' };

export function OpportunitiesView({ board }: { board: OpportunityBoard }) {
  const ranked = [...board.opportunities].sort((a, b) => a.rank - b.rank);
  const [selectedId, setSelectedId] = useState(ranked.find((o) => o.recommended)?.id ?? ranked[0]?.id);
  const selected = ranked.find((o) => o.id === selectedId);

  if (board.state === 'not_run') {
    return (
      <div className="page">
        <PageHeader kicker="Opportunity intelligence" title="The Opportunity Scout has not run yet" lede={board.note} />
        <EmptyState icon="compass" title="What will appear here" level={2}>
          <p>
            Three to five ranked opportunities, one marked as the strongest recommendation, each with its customer, demand evidence, up to
            20 competitors, seasonality, modelled economics, risks, information gaps and a go or no-go call. Every claim carries a source
            and a Verified, Estimated, Inferred or Unknown label.
          </p>
          <p>
            <Link className="btn btn--quiet" to="/opportunities?preview=sample">
              Preview the layout with sample data
            </Link>
          </p>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        kicker="Opportunity intelligence"
        title={selected?.recommended ? `Strongest recommendation: ${selected.name}` : 'Ranked opportunities'}
        lede={board.runAt ? `Scout run ${board.runAt}` : undefined}
      />
      {board.state === 'sample' && (
        <SampleBanner>
          {board.note} Names, scores and figures are placeholders for design review. <Link to="/opportunities">Show the real state</Link>
        </SampleBanner>
      )}
      <div className="opp-layout">
        <nav aria-label="Ranked opportunities">
          <ol className="opp-rank">
            {ranked.map((o) => (
              <li key={o.id}>
                <button
                  className={`opp-pick${o.id === selectedId ? ' is-selected' : ''}`}
                  aria-current={o.id === selectedId ? 'true' : undefined}
                  onClick={() => setSelectedId(o.id)}
                >
                  <span className="opp-pick__rank">{o.rank}</span>
                  <span className="opp-pick__body">
                    <span className="opp-pick__name">
                      {o.name}
                      {o.recommended && (
                        <span className="tag tag--brass">
                          <Icon name="star" size={12} /> Recommended
                        </span>
                      )}
                    </span>
                    <span className="opp-pick__meta">
                      Score {o.score.total} · {VERDICT[o.verdict]} · {o.confidence} confidence
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
        {selected && <OpportunityDetail o={selected} sample={board.state === 'sample'} />}
      </div>
    </div>
  );
}

function Claims({ items }: { items: Opportunity['demand'] }) {
  if (!items.length) return <p className="muted small">Not covered in this run.</p>;
  return (
    <ul className="claims">
      {items.map((c, i) => (
        <li key={i}>
          <span className={`evidence evidence--${c.label}`}>{EVIDENCE[c.label]}</span>
          <span>{c.claim}</span>
          {c.source && <span className="claims__src">{c.source}</span>}
        </li>
      ))}
    </ul>
  );
}

function OpportunityDetail({ o, sample }: { o: Opportunity; sample: boolean }) {
  return (
    <article className="opp" aria-labelledby={`opp-${o.id}`}>
      <header className="opp__head">
        <div>
          <p className="kicker">Rank {o.rank} · {o.complexity} launch complexity</p>
          <h2 id={`opp-${o.id}`} className="opp__name">
            {o.name}
          </h2>
          <p className="opp__segment">{o.segment}</p>
        </div>
        <div className={`verdict verdict--${o.verdict}`}>
          <span className="verdict__label">Recommendation</span>
          <span className="verdict__value">{VERDICT[o.verdict]}</span>
          <span className="verdict__conf">{o.confidence} confidence</span>
        </div>
      </header>

      <blockquote className="hunch">
        <p className="hunch__label">The hunch</p>
        <p>{o.hunch}</p>
        <p className="hunch__reason">{o.verdictReason}</p>
      </blockquote>

      <div className="opp__grid">
        <section aria-label="Problem">
          <h3>Problem</h3>
          <p>{o.problem}</p>
        </section>
        <section aria-label="Score">
          <h3>Score {o.score.total}/100</h3>
          {o.score.components.map((c) => (
            <Meter key={c.label} label={c.label} value={c.value} weight={c.weight} />
          ))}
        </section>
        <section aria-label="Demand evidence">
          <h3>Demand evidence</h3>
          <Claims items={o.demand} />
        </section>
        <section aria-label="Audience">
          <h3>Audience and geography</h3>
          <Claims items={o.demographics} />
        </section>
        <section aria-label="Seasonality" className="span-2">
          <h3>Seasonality and timing</h3>
          {o.seasonality.months ? (
            <SeasonBars months={o.seasonality.months} peak={o.seasonality.peak} launchBy={o.seasonality.launchBy} source={o.seasonality.source} />
          ) : o.seasonality.windows?.length ? (
            <ul className="claims">
              {o.seasonality.windows.map((w) => (
                <li key={w.event}>
                  <span className={`evidence evidence--${w.evidence}`}>{EVIDENCE[w.evidence]}</span>
                  <span>
                    {w.event}: demand {w.demandWindow}, publish by {w.publishBy}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No seasonal data in this run.</p>
          )}
        </section>
        <section aria-label="Product and offer">
          <h3>Product and offer</h3>
          <p>{o.productModel}</p>
          <p className="muted">
            {o.offer.price} · {o.offer.monetization}
          </p>
        </section>
        <section aria-label="Distribution">
          <h3>Distribution</h3>
          {o.distribution.length ? (
            <ul className="pill-list">
              {o.distribution.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Not covered in this run.</p>
          )}
        </section>
        <section aria-label="Economics" className="span-2">
          <h3>Modelled economics</h3>
          <div className="scenarios">
            {(
              [
                ['Downside', o.economics.downside],
                ['Base', o.economics.base],
                ['Upside', o.economics.upside],
                ['Launch cost', o.economics.launchCost],
              ] as const
            ).map(([label, m]) => (
              <div key={label} className="scenario">
                <span className="scenario__label">{label}</span>
                <span className="scenario__value">{formatValue(m)}</span>
                <StateChip state={m.state} />
              </div>
            ))}
          </div>
          <p className="muted small">{o.economics.downside.period.label} contribution. Assumptions: {o.economics.assumptions.join('; ')}.</p>
        </section>
        <section aria-label="Competitors" className="span-2">
          <h3>Competitor landscape</h3>
          {o.competitors.length === 0 ? (
            <Claims items={o.competitorClaims ?? []} />
          ) : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Competitors table, scrollable">
            <table className="table table--compact">
              <caption className="sr-only">Competitors</caption>
              <thead>
                <tr>
                  <th scope="col">Competitor</th>
                  <th scope="col">Scope</th>
                  <th scope="col">Offer</th>
                  <th scope="col">Price</th>
                </tr>
              </thead>
              <tbody>
                {o.competitors.map((c) => (
                  <tr key={c.name}>
                    <th scope="row">{c.name}</th>
                    <td>{c.scope === 'local' ? 'Local' : 'National'}</td>
                    <td>{c.offer}</td>
                    <td>{c.price}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </section>
        <section aria-label="Risks">
          <h3>Risks</h3>
          {o.risks.length ? <ul className="bullets">{o.risks.map((r) => <li key={r}>{r}</li>)}</ul> : <p className="muted small">None recorded.</p>}
        </section>
        <section aria-label="Information gaps">
          <h3>Information gaps</h3>
          {o.gaps.length ? <ul className="bullets">{o.gaps.map((r) => <li key={r}>{r}</li>)}</ul> : <p className="muted small">None recorded.</p>}
        </section>
        <section aria-label="Reusable FORGE components" className="span-2">
          <h3>Reusable FORGE components</h3>
          {o.reuse.length ? <ul className="pill-list">{o.reuse.map((r) => <li key={r}>{r}</li>)}</ul> : <p className="muted small">Not assessed in this run.</p>}
        </section>
      </div>

      <footer className="opp__foot">
        <button className="btn btn--primary" disabled aria-describedby={`commission-${o.id}`}>
          Commission a Launch Blueprint
          <Icon name="arrow" size={14} />
        </button>
        <p id={`commission-${o.id}`} className="muted small">
          {sample
            ? 'Disabled for sample data.'
            : 'Opens budget and authorisation boundaries for your approval before any build starts.'}{' '}
          Launching a business always needs your explicit approval.
        </p>
      </footer>
    </article>
  );
}
