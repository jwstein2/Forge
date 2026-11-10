import type { Alert, CheckRollup, Niche, OperatorBoard } from '../data/types';
import { formatDateTime, formatDateYear, freshness } from '../lib/format';
import { useNow } from '../lib/clock';
import { nicheName } from './blocks';
import { Icon } from './Icon';
import { EmptyState, ExternalLink, SeverityBadge } from './primitives';
import { LifecycleBlock, ProposalBlock, RecommendationsBlock } from './operatorDecisions';

const KIND: Record<string, string> = {
  'ops.site_health': 'Site health checks',
  'ops.pin_runway': 'Pinterest queue runway',
  'ops.seo_audit': 'SEO audit',
  'ops.content_plan': 'Content plan',
  'ops.content_draft': 'Content drafts',
  'ops.content_publish': 'Content publishing',
  'ops.content_verify': 'Publication check',
  'ops.weekly_summary': 'Weekly summary',
};
export const kindLabel = (k: string) => KIND[k] ?? k;

const CHECK: Record<string, string> = {
  site_health: 'Site health',
  seo_page: 'SEO, pages',
  seo_site: 'SEO, site level',
  pin_queue: 'Pinterest queue',
};

const JOB_TONE: Record<string, string> = { succeeded: 'good', failed: 'critical', dead: 'critical', running: 'info', queued: 'outline', paused: 'warn', blocked: 'warn' };

const MODE: Record<string, string> = {
  off: 'Off',
  draft_only: 'Drafts only',
  approval_each: 'Each post approved',
  standing: 'Standing approval',
};

function cap(s: string) {
  if (s === 'seo') return 'SEO';
  return s ? s[0].toUpperCase() + s.slice(1).replace(/_/g, ' ') : s;
}

/** Schedule slots are stored to the minute ("2026-11-09T08:00Z"); add seconds so every engine parses them. */
export function slotIso(slot: string): string {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/.test(slot) ? slot.replace(/Z$/, ':00Z') : slot;
}

/** FORGE Operator: what runs on its own, what it found, and what it may publish. */
export function OperatorPanel({ board, niches, onBoard = () => {} }: { board: OperatorBoard; niches: Niche[]; onBoard?: (b: OperatorBoard) => void }) {
  const now = useNow();
  if (board.state === 'unconnected') {
    return (
      <EmptyState icon="plug-off" title="Operator data is not connected in this view">
        <p>{board.note}</p>
      </EmptyState>
    );
  }
  const name = (id: string | null) => (id ? nicheName(niches, id) : 'All businesses');
  return (
    <div className="operator">
      {board.note && (
        <p className="operator__note" role="note">
          <Icon name="alert-triangle" size={14} /> {board.note}
        </p>
      )}
      <p className={`stop-line${board.control?.globalPause ? ' is-stopped' : ''}`} data-testid="emergency-stop">
        <Icon name={board.control?.globalPause ? 'stop' : 'check-circle'} size={16} />
        {board.control == null
          ? 'Emergency stop state unknown: the control endpoint did not answer.'
          : board.control.globalPause
            ? `Emergency stop is ON since ${formatDateTime(board.control.pausedAt ?? '')}${board.control.reason ? `: ${board.control.reason}` : ''}. No FORGE job runs until it is lifted.`
            : 'Emergency stop is off. FORGE jobs run on their schedules.'}
      </p>

      <RecommendationsBlock board={board} niches={niches} onBoard={onBoard} />

      <h3 className="subhead">Schedules</h3>
      {board.schedules.length ? (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Operator schedules table, scrollable">
          <table className="table">
            <caption className="sr-only">Operator schedules</caption>
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Scope</th>
                <th scope="col">Cadence</th>
                <th scope="col">Last slot</th>
                <th scope="col">Last run</th>
              </tr>
            </thead>
            <tbody>
              {board.schedules.map((s) => (
                <tr key={s.id} className={s.lastJobStatus === 'failed' ? 'is-failed' : undefined}>
                  <th scope="row">
                    <span className="mono job__id">{s.id}</span>
                    <span className="job__name">{kindLabel(s.kind)}</span>
                  </th>
                  <td>{name(s.nicheId)}</td>
                  <td className="nowrap">{s.enabled ? s.cadence : <span className="tag tag--outline">Disabled</span>}</td>
                  <td className="nowrap">{s.lastSlot ? <span title={s.lastSlot}>{freshness(slotIso(s.lastSlot), now)}</span> : <span className="muted">Never</span>}</td>
                  <td>
                    {s.lastJobStatus ? <span className={`tag tag--${JOB_TONE[s.lastJobStatus] ?? 'outline'}`}>{cap(s.lastJobStatus)}</span> : <span className="muted">No run yet</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">No Operator schedules are registered.</p>
      )}

      <h3 className="subhead">Site checks</h3>
      <p className="muted small">Latest result for each page or endpoint, read-only requests from FORGE. Messages are shown as recorded.</p>
      {board.checks.length ? <CheckTable checks={board.checks} name={name} now={now} /> : <p className="muted small">No checks have run yet.</p>}

      <h3 className="subhead">Content pipeline</h3>
      {board.content.length ? (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Content pipeline table, scrollable">
          <table className="table">
            <caption className="sr-only">Content pipeline</caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Business</th>
                <th scope="col">Platform</th>
                <th scope="col">Publish by</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {board.content.map((c) => (
                <tr key={c.id}>
                  <th scope="row" className="wrap">
                    {c.externalUrl ? <ExternalLink href={c.externalUrl}>{c.title}</ExternalLink> : c.title}
                  </th>
                  <td>{name(c.nicheId)}</td>
                  <td>{cap(c.platform)}</td>
                  <td className="nowrap">
                    {c.publishBy ? formatDateTime(c.publishBy) : '—'}
                    {c.late && <span className="tag tag--warn">Late</span>}
                  </td>
                  <td>
                    {c.verifiedAt ? <span className="tag tag--good">Verified</span> : <span className="tag tag--outline">{cap(c.status)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">Nothing planned or drafted yet. Items appear here after the weekly content plan runs against an approved brief.</p>
      )}

      <LifecycleBlock board={board} niches={niches} />

      <ProposalBlock board={board} niches={niches} onBoard={onBoard} />

      <h3 className="subhead">Publishing boundaries in force</h3>
      <p className="muted small">What the Operator may do on each channel. Nothing posts publicly outside these boundaries.</p>
      {board.policies.length ? (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Publishing boundaries table, scrollable">
          <table className="table">
            <caption className="sr-only">Publishing boundaries</caption>
            <thead>
              <tr>
                <th scope="col">Channel</th>
                <th scope="col">Business</th>
                <th scope="col">Mode</th>
                <th scope="col">Publisher</th>
                <th scope="col">Daily cap</th>
              </tr>
            </thead>
            <tbody>
              {board.policies.map((p) => (
                <tr key={p.channelId}>
                  <th scope="row">{cap(p.platform)}</th>
                  <td>{name(p.nicheId)}</td>
                  <td>
                    {MODE[p.mode] ?? cap(p.mode)}
                    {p.mode === 'standing' && p.windowEnd && <span className="muted small"> until {formatDateYear(p.windowEnd)}</span>}
                  </td>
                  <td>{p.publisher === 'dry_run' ? 'Dry run (posts nothing)' : cap(p.publisher)}</td>
                  <td>{p.dailyCap}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">No channels registered.</p>
      )}
    </div>
  );
}

function CheckTable({ checks, name, now }: { checks: CheckRollup[]; name: (id: string | null) => string; now: Date }) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Site checks table, scrollable">
      <table className="table">
        <caption className="sr-only">Site checks</caption>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Business</th>
            <th scope="col">Passing</th>
            <th scope="col">Findings</th>
            <th scope="col">Checked</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={`${c.kind}-${c.nicheId}`} className={c.passing + c.unknown < c.targets ? 'is-failed' : undefined}>
              <th scope="row">{CHECK[c.kind] ?? c.kind}</th>
              <td>{name(c.nicheId)}</td>
              <td className="nowrap">
                <span className={c.passing + c.unknown < c.targets ? 'text-critical' : undefined}>
                  {c.passing} of {c.targets}
                </span>
                {c.unknown > 0 && <span className="tag tag--outline">{c.unknown} unknown</span>}
              </td>
              <td className="wrap">
                {c.findings.length ? (
                  <ul className="findings">
                    {c.findings.map((f, i) => (
                      <li key={i}>
                        <SeverityBadge severity={f.severity} /> <span className="mono small">{f.code}</span> {f.message}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="muted">None</span>
                )}
              </td>
              <td className="nowrap" title={formatDateTime(c.lastCheckedAt)}>
                {freshness(c.lastCheckedAt, now)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Findings raised by @forge/controls (finance, ledger integrity, spend). They arrive as alerts with source controls:<CODE>. */
export function ControlsFindings({ alerts, niches }: { alerts: Alert[]; niches: Niche[] }) {
  const open = alerts.filter((a) => a.source.startsWith('controls:') && a.state !== 'resolved');
  if (!open.length) {
    return (
      <EmptyState icon="check-circle" title="No open controls findings">
        <p>Finance and ledger controls run with each ledger sync. Findings they raise appear here and in the alert list.</p>
      </EmptyState>
    );
  }
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Controls findings table, scrollable">
      <table className="table">
        <caption className="sr-only">Controls findings</caption>
        <thead>
          <tr>
            <th scope="col">Control</th>
            <th scope="col">Severity</th>
            <th scope="col">Finding</th>
            <th scope="col">Business</th>
            <th scope="col">Next</th>
          </tr>
        </thead>
        <tbody>
          {open.map((a) => (
            <tr key={a.id}>
              <th scope="row" className="mono nowrap">
                {a.source.slice('controls:'.length)}
              </th>
              <td>
                <SeverityBadge severity={a.severity} />
              </td>
              <td className="wrap">
                {a.title}
                {a.needsOwner && (
                  <span className="tag tag--owner">
                    <Icon name="star" size={12} /> Needs you
                  </span>
                )}
              </td>
              <td>{nicheName(niches, a.nicheId)}</td>
              <td className="wrap">{a.nextAction}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
