import { useMemo, useState } from 'react';
import { useResource, useSource } from '../data/DataContext';
import type { Job, OperatorBoard, PortfolioSummary, Severity } from '../data/types';
import { AlertList } from '../components/blocks';
import { ControlsFindings, OperatorPanel } from '../components/operator';
import { Icon } from '../components/Icon';
import {
  EmptyState,
  ErrorNote,
  ExternalLink,
  HealthBadge,
  Loading,
  PageHeader,
  Section,
  StatusTag,
} from '../components/primitives';
import { SEVERITY_ORDER, sortAlerts } from '../lib/derive';
import { formatDateTime, freshness } from '../lib/format';
import { useNow } from '../lib/clock';

const RUNNER: Record<Job['runner'], string> = {
  n8n: 'n8n',
  cloudflare: 'Cloudflare',
  claude_scheduled: 'Claude schedule',
  github_actions: 'GitHub Actions',
  forge: 'FORGE',
  manual: 'Manual',
};

export function OperationsScreen() {
  const [res, setRes] = useResource((s) => s.getPortfolio(), []);
  const [ops] = useResource((s) => s.getOperator(), []);
  if (res.status === 'loading') return <Loading />;
  if (res.status === 'error') return <ErrorNote error={res.error} />;
  const operator: OperatorBoard | 'loading' | Error = ops.status === 'ready' ? ops.data : ops.status === 'error' ? ops.error : 'loading';
  return (
    <OperationsView
      p={res.data}
      operator={operator}
      onJobChange={(j) => setRes({ ...res.data, jobs: res.data.jobs.map((x) => (x.id === j.id ? j : x)) })}
    />
  );
}

const ALERT_PREVIEW = 8;
type SourceFilter = 'all' | 'controls' | 'operator' | 'audit' | 'other';
const sourceKind = (src: string): Exclude<SourceFilter, 'all'> =>
  src.startsWith('controls:') ? 'controls' : src.startsWith('ops.') ? 'operator' : src.startsWith('audit.') ? 'audit' : 'other';

export function OperationsView({
  p,
  operator,
  onJobChange,
}: {
  p: PortfolioSummary;
  operator?: OperatorBoard | 'loading' | Error;
  onJobChange: (j: Job) => void;
}) {
  const [sev, setSev] = useState<Severity | 'all'>('all');
  const [scope, setScope] = useState<string>('all');
  const [src, setSrc] = useState<SourceFilter>('all');
  const [showAll, setShowAll] = useState(false);
  const open = sortAlerts(p.alerts.filter((a) => a.state !== 'resolved'));
  const shown = open.filter(
    (a) => (sev === 'all' || a.severity === sev) && (scope === 'all' || a.nicheId === scope) && (src === 'all' || sourceKind(a.source) === src),
  );
  const board = operator && typeof operator === 'object' && !(operator instanceof Error) ? operator : null;
  const failing = p.jobs.filter((j) => j.lastResult === 'failure');
  const withDefects = p.jobs.filter((j) => j.defects.length > 0);
  const heartbeat = p.jobs.some((j) => j.heartbeatOk !== null && j.lastResult !== 'failure');

  return (
    <div className="page">
      <PageHeader
        kicker="Operations & alerts"
        title={opsHeadline(p.jobs, failing.length, heartbeat)}
        lede="Real failures, disconnected integrations and material exceptions. Routine work is not listed for approval."
      />

      <p className="provenance">
        <span>Job records</span>
        <span aria-hidden="true">·</span>
        <span>as of {formatDateTime(p.generatedAt)}</span>
        <span aria-hidden="true">·</span>
        <span>{p.period.label}</span>
      </p>
      <div className="ops-strip">
        <OpsFact label="Scheduled jobs" value={String(p.jobs.length)} sub={`${p.jobs.filter((j) => j.status === 'live').length} live`} />
        <OpsFact label="Failed last run" value={String(failing.length)} sub={failing.map((j) => j.id).join(', ') || 'None'} tone={failing.length ? 'critical' : undefined} />
        <OpsFact label="Jobs with known defects" value={String(withDefects.length)} sub="From the Nov 10 audit" tone={withDefects.length ? 'warn' : undefined} />
        <OpsFact
          label="Heartbeat watchdog"
          value={heartbeat ? 'On' : 'Not built'}
          sub={heartbeat ? 'Alerts at 2× interval' : 'A silently stopped job would look healthy'}
          tone={heartbeat ? undefined : 'warn'}
        />
      </div>

      <WeeklySummary p={p} board={board} />

      <Section title="Alerts" kicker={`${open.length} open`} id="alerts">
        <div className="filters" role="group" aria-label="Filter alerts">
          <label>
            <span>Severity</span>
            <select value={sev} onChange={(e) => setSev(e.target.value as Severity | 'all')}>
              <option value="all">All</option>
              {SEVERITY_ORDER.map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Business</span>
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">All</option>
              <option value="portfolio">Portfolio-wide</option>
              {p.niches.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Raised by</span>
            <select value={src} onChange={(e) => setSrc(e.target.value as SourceFilter)}>
              <option value="all">All</option>
              <option value="controls">Controls</option>
              <option value="operator">Operator checks</option>
              <option value="audit">Nov 10 audit</option>
              <option value="other">Other</option>
            </select>
          </label>
          <span className="filters__count" aria-live="polite">
            {shown.length} shown
          </span>
        </div>
        {shown.length ? (
          <>
            <AlertList alerts={shown} niches={p.niches} limit={showAll ? undefined : ALERT_PREVIEW} />
            {shown.length > ALERT_PREVIEW && (
              <button className="btn btn--quiet" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Show the most severe only' : `Show all ${shown.length} alerts`}
              </button>
            )}
          </>
        ) : (
          <EmptyState icon="check-circle" title="No alerts match">
            <p>Try a different filter.</p>
          </EmptyState>
        )}
      </Section>

      <Section title="Controls findings" kicker="Finance, ledger and spend checks" id="controls">
        <ControlsFindings alerts={p.alerts} niches={p.niches} />
      </Section>

      <Section title="Operator" kicker="What FORGE runs on its own" id="operator">
        {operator === 'loading' || operator === undefined ? (
          <Loading />
        ) : operator instanceof Error ? (
          <ErrorNote error={operator} />
        ) : (
          <OperatorPanel board={operator} niches={p.niches} />
        )}
      </Section>

      <Section title="Scheduled jobs" kicker="Last success, not just configuration" id="jobs">
        <JobTable jobs={p.jobs} onChange={onJobChange} />
      </Section>

      <Section title="Integrations" kicker="Connection health" id="integrations">
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Integrations table, scrollable">
          <table className="table">
            <caption className="sr-only">Integrations</caption>
            <thead>
              <tr>
                <th scope="col">Integration</th>
                <th scope="col">Health</th>
                <th scope="col">Status</th>
                <th scope="col">Detail</th>
                <th scope="col">Last checked</th>
              </tr>
            </thead>
            <tbody>
              {p.integrations.map((i) => (
                <tr key={i.id}>
                  <th scope="row">{i.consoleUrl ? <ExternalLink href={i.consoleUrl}>{i.name}</ExternalLink> : i.name}</th>
                  <td>
                    <HealthBadge health={i.health} />
                  </td>
                  <td>
                    <StatusTag status={i.status} />
                  </td>
                  <td className="wrap">{i.detail}</td>
                  <td className="nowrap">{formatDateTime(i.lastCheckedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

/** Headline claims only what the records support: without a heartbeat ledger, "on time" is unknowable. */
export function opsHeadline(jobs: Job[], failed: number, heartbeat: boolean): string {
  const lead = failed ? `${failed} scheduled ${failed === 1 ? 'job has' : 'jobs have'} failed.` : 'No scheduled job reported a failure.';
  const rest = jobs.length - failed;
  if (!heartbeat) return `${lead} ${rest} others last reported success, but nothing yet checks that they are still running.`;
  const live = jobs.filter((j) => j.lastResult !== 'failure');
  const late = live.filter((j) => j.heartbeatOk === false).length;
  const unseen = live.filter((j) => j.heartbeatOk === null).length;
  const onTime = live.length - late - unseen;
  const parts: string[] = [];
  if (late) parts.push(`${late} running late`);
  if (unseen) parts.push(`${unseen} with no heartbeat yet, so FORGE can't confirm they run`);
  if (!parts.length) return `${lead} The rest are on schedule.`;
  return `${lead} ${onTime} on schedule, ${parts.join(', ')}.`;
}

function OpsFact({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'critical' | 'warn' }) {
  return (
    <div className={`ops-fact${tone ? ` ops-fact--${tone}` : ''}`}>
      <span className="ops-fact__label">{label}</span>
      <span className="ops-fact__value">{value}</span>
      <span className="ops-fact__sub">{sub}</span>
    </div>
  );
}

/**
 * In-app weekly summary. Prefers the one the Operator generated (OPS-WEEKLY-SUMMARY); otherwise derives one
 * deterministically from the same records and says so. No email is sent either way.
 */
function WeeklySummary({ p, board }: { p: PortfolioSummary; board: OperatorBoard | null }) {
  const lines = useMemo(() => {
    const out: string[] = [];
    const rev = p.financials.grossRevenue;
    out.push(rev.value === 0 ? 'No live revenue; checkout is still in test mode on every site.' : `Verified revenue ${rev.value}.`);
    const verifiedCh = p.niches.flatMap((n) => n.channels).filter((c) => c.state === 'verified');
    out.push(`${verifiedCh.length} channel${verifiedCh.length === 1 ? '' : 's'} published with receipts: ${verifiedCh.map((c) => `${c.platform} (${p.niches.find((n) => n.id === c.nicheId)?.name})`).join(', ') || 'none'}.`);
    const crit = p.alerts.filter((a) => a.severity === 'critical' && a.state !== 'resolved');
    if (crit.length) out.push(`Critical: ${crit.map((a) => a.title.toLowerCase()).join('; ')}.`);
    const owner = p.alerts.filter((a) => a.needsOwner && a.state !== 'resolved');
    if (owner.length) out.push(`Waiting on you: ${owner.map((a) => a.nextAction.replace(/\.$/, '')).join('; ')}.`);
    return out;
  }, [p]);
  const gen = board?.summary;
  return (
    <section className="weekly" aria-labelledby="weekly-title">
      <div className="weekly__head">
        <Icon name="doc" size={18} />
        <h2 id="weekly-title">Weekly summary</h2>
        <span className="weekly__period">
          {gen
            ? `${gen.period.label} · generated ${formatDateTime(gen.generatedAt)} by the Operator · in-app only, no email`
            : `${p.period.label} · derived in Command from current records · in-app only, no email`}
        </span>
      </div>
      <ul>
        {(gen ? gen.headline : lines).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {gen && gen.unknowns.length > 0 && (
        <details className="weekly__unknowns">
          <summary>{gen.unknowns.length} things the summary could not see</summary>
          <ul>
            {gen.unknowns.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function JobTable({ jobs, onChange }: { jobs: Job[]; onChange: (j: Job) => void }) {
  const source = useSource();
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function toggle(j: Job) {
    setBusy(j.id);
    setMsg(null);
    try {
      const updated = await source.setJobPaused(j.id, !j.paused);
      onChange(updated);
      setMsg(
        `${j.id} ${updated.paused ? 'paused' : 'resumed'}.` +
          (source.kind === 'fixtures' ? ' Snapshot mode: this is simulated and does not reach n8n.' : ''),
      );
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Scheduled jobs table, scrollable">
        <table className="table jobs">
          <caption className="sr-only">Scheduled jobs</caption>
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">Runner</th>
              <th scope="col">Cadence</th>
              <th scope="col">Last success</th>
              <th scope="col">Status</th>
              <th scope="col">Known defects</th>
              <th scope="col">
                <span className="sr-only">Pause</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className={j.lastResult === 'failure' ? 'is-failed' : j.paused ? 'is-paused' : undefined}>
                <th scope="row">
                  <span className="mono job__id">{j.id}</span>
                  <span className="job__name">{j.name}</span>
                </th>
                <td>{RUNNER[j.runner]}</td>
                <td className="wrap">{j.cadence}</td>
                <td className="nowrap">
                  {j.lastSuccessAt ? (
                    <span title={formatDateTime(j.lastSuccessAt)}>{freshness(j.lastSuccessAt, now)}</span>
                  ) : (
                    <span className="text-critical">Never</span>
                  )}
                </td>
                <td>
                  {j.paused ? <span className="tag tag--outline">Paused</span> : <StatusTag status={j.status} />}
                </td>
                <td className="wrap job__defects">{j.defects.length ? j.defects.join('; ') : <span className="muted">None known</span>}</td>
                <td>
                  {j.pausable ? (
                    <button className="btn btn--quiet" onClick={() => toggle(j)} disabled={busy === j.id} aria-label={`${j.paused ? 'Resume' : 'Pause'} ${j.id} ${j.name}`}>
                      <Icon name={j.paused ? 'play' : 'pause'} size={14} />
                      {j.paused ? 'Resume' : 'Pause'}
                    </button>
                  ) : (
                    <span className="muted small" title="Not an approved pausable automation">
                      Not pausable here
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {msg && (
        <p className="job__msg" role="status">
          {msg}
        </p>
      )}
    </>
  );
}
