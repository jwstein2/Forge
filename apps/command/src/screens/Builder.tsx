import { Link, useSearchParams } from 'react-router-dom';
import { useResource } from '../data/DataContext';
import type { Build, BuildBoard, BuildStage } from '../data/types';
import { Icon, type IconName } from '../components/Icon';
import { EmptyState, ErrorNote, Loading, PageHeader, SampleBanner, Stat, StatusTag } from '../components/primitives';
import { formatValue } from '../lib/format';
import { safeHref } from '../lib/safeUrl';

export function BuilderScreen() {
  const [params] = useSearchParams();
  const sample = params.get('preview') === 'sample';
  const [res] = useResource((s) => s.getBuilds({ sample }), [sample]);
  if (res.status === 'loading') return <Loading />;
  if (res.status === 'error') return <ErrorNote error={res.error} />;
  return <BuilderView board={res.data} />;
}

const STAGE_STATUS: Record<BuildStage['status'], { label: string; icon: IconName }> = {
  not_started: { label: 'Not started', icon: 'question' },
  in_progress: { label: 'In progress', icon: 'pulse' },
  blocked: { label: 'Blocked', icon: 'stop' },
  review: { label: 'In review', icon: 'doc' },
  passed: { label: 'Passed', icon: 'check-circle' },
  failed: { label: 'Failed', icon: 'alert-triangle' },
};

export function BuilderView({ board }: { board: BuildBoard }) {
  if (board.state === 'none') {
    return (
      <div className="page">
        <PageHeader kicker="Builder workspace" title="No business build is under way" lede={board.note} />
        <EmptyState icon="layers" title="How a build will appear" level={2}>
          <p>
            A commissioned build moves through nine milestones: research, blueprint, products, brand, website, integrations, marketing,
            testing and launch readiness. Each shows its outputs, cost against budget, blockers and an independent PASS, FAIL, NOT RUN or
            BLOCKED gate. Production launch always waits for your approval.
          </p>
          <p>
            <Link className="btn btn--quiet" to="/builder?preview=sample">
              Preview the layout with a sample build
            </Link>
          </p>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="page">
      <PageHeader kicker="Builder workspace" title={board.builds.length === 1 ? board.builds[0].nicheName : `${board.builds.length} builds`} />
      {board.state === 'sample' && (
        <SampleBanner>
          {board.note} <Link to="/builder">Show the real state</Link>
        </SampleBanner>
      )}
      {board.builds.map((b) => (
        <BuildView key={b.id} b={b} />
      ))}
    </div>
  );
}

function BuildView({ b }: { b: Build }) {
  const passed = b.stages.filter((s) => s.status === 'passed').length;
  const blocked = b.stages.filter((s) => s.status === 'blocked');
  return (
    <section className="build" aria-label={`Build: ${b.nicheName}`}>
      <div className="stat-row">
        <Stat label="Budget" metric={b.budget} />
        <Stat label="Spent" metric={b.spent} />
        <div className="stat">
          <div className="stat__head">
            <span className="stat__label">Milestones passed</span>
          </div>
          <p className="stat__value">
            {passed}/{b.stages.length}
          </p>
          <p className="provenance">Blueprint v{b.blueprintVersion ?? '—'}</p>
        </div>
        <div className="stat">
          <div className="stat__head">
            <span className="stat__label">Blocked</span>
          </div>
          <p className="stat__value">{blocked.length}</p>
          <p className="provenance">{blocked.map((s) => s.label).join(', ') || 'Nothing blocked'}</p>
        </div>
      </div>

      <h2 className="section__title">Milestones</h2>
      <ol className="track" aria-label="Build milestones">
        {b.stages.map((s, i) => {
          const st = STAGE_STATUS[s.status];
          return (
            <li key={s.id} className={`track__step track__step--${s.status}`}>
              <div className="track__rail" aria-hidden="true">
                <span className="track__node">
                  <Icon name={st.icon} size={14} />
                </span>
                {i < b.stages.length - 1 && <span className="track__line" />}
              </div>
              <div className="track__body">
                <div className="track__head">
                  <h3 className="track__title">{s.label}</h3>
                  <span className={`badge badge--stage-${s.status}`}>{st.label}</span>
                  <span className={`gate gate--${s.gate.result.replace(' ', '-').toLowerCase()}`}>Gate: {s.gate.result}</span>
                </div>
                {s.blocker && (
                  <p className="track__blocker">
                    <Icon name="stop" size={14} /> {s.blocker}
                  </p>
                )}
                <dl className="kv kv--inline">
                  {s.dependsOn.length > 0 && (
                    <div>
                      <dt>Depends on</dt>
                      <dd>{s.dependsOn.map((d) => b.stages.find((x) => x.id === d)?.label).join(', ')}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Cost</dt>
                    <dd>{formatValue(s.cost)}</dd>
                  </div>
                  <div>
                    <dt>Reviewer</dt>
                    <dd>{s.gate.reviewer ?? 'Not assigned'}</dd>
                  </div>
                </dl>
                {s.outputs.length > 0 && (
                  <ul className="outputs">
                    {s.outputs.map((o) => (
                      <li key={o.label}>
                        <Icon name="doc" size={14} /> {safeHref(o.url) ? <a href={safeHref(o.url)!}>{o.label}</a> : o.label} <StatusTag status={o.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
