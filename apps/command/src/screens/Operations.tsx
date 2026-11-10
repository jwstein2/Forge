import { useMemo, useState } from 'react';
import { useResource, useSource } from '../data/DataContext';
import type { Job, PortfolioSummary, Severity } from '../data/types';
import { AlertList } from '../components/blocks';
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
  if (res.status === 'loading') return <Loading />;
  if (res.status === 'error') return <ErrorNote error={res.error} />;
  return <OperationsView p={res.data} onJobChange={(j) => setRes({ ...res.data, jobs: res.data.jobs.map((x) => (x.id === j.id ? j : x)) })} />;
}

export function OperationsView({ p, onJobChange }: { p: PortfolioSummary; onJobChange: (j: Job) => void }) {
  const [sev, setSev] = useState<Severity | 'all'>('all');
  const [scope, setScope] = useState<string>('all');
  const open = sortAlerts(p.alerts.filter((a) => a.state !== 'resolved'));
  const shown = open.filter((a) => (sev === 'all' || a.severity === sev) && (scope === 'all' || a.nicheId === scope));
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

      <WeeklySummary p={p} />

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
          <span className="filters__count" aria-live="polite">
            {shown.length} shown
          </span>
        </div>
        {shown.length ? (
          <AlertList alerts={shown} niches={p.niches} />
        ) : (
          <EmptyState icon="check-circle" title="No alerts match">
            <p>Try a different filter.</p>
          </EmptyState>
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
  const late = jobs.filter((j) => j.heartbeatOk === false).length;
  return `${lead} ${late ? `${late} running late.` : 'The rest are on schedule.'}`;
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

/** Deterministic in-app weekly summary built from the same records. No email is sent. */
function WeeklySummary({ p }: { p: PortfolioSummary }) {
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
  return (
    <section className="weekly" aria-labelledby="weekly-title">
      <div className="weekly__head">
        <Icon name="doc" size={18} />
        <h2 id="weekly-title">Weekly summary</h2>
        <span className="weekly__period">{p.period.label} · in-app only, no email</span>
      </div>
      <ul>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
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
