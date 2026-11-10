import { useState } from 'react';
import { useSource } from '../data/DataContext';
import type { ChannelPolicy, Niche, OperatorBoard, PublishingProposal, Recommendation } from '../data/types';
import { formatDateTime, formatDateYear } from '../lib/format';
import { useNow } from '../lib/clock';
import { nicheName } from './blocks';
import { Icon } from './Icon';
import { EmptyState } from './primitives';

const MODE: Record<string, string> = { off: 'Off', draft_only: 'Drafts only', approval_each: 'Each post approved (weekly batch)', standing: 'Standing approval' };
const cap = (s: string) => (s === 'seo' ? 'SEO' : s ? s[0].toUpperCase() + s.slice(1).replace(/_/g, ' ') : s);
const publisherText = (p: string) => (p === 'dry_run' ? 'Dry run (posts nothing)' : p === 'manual' ? 'Manual (site release)' : cap(p));

/** True when every proposed channel already runs the proposed boundary under an approval. */
export function proposalApplied(p: PublishingProposal, policies: ChannelPolicy[]): boolean {
  return p.channels.every((c) => {
    const cur = policies.find((x) => x.channelId === c.channelId);
    return !!cur && !!cur.approvalId && cur.mode === c.mode && cur.publisher === c.publisher && cur.dailyCap === c.dailyCap;
  });
}

/** Latest window end among applied standing boundaries; null when none carries one. */
export function appliedUntil(policies: ChannelPolicy[]): string | null {
  const ends = policies.filter((x) => x.approvalId && x.windowEnd).map((x) => x.windowEnd as string).sort();
  return ends.length ? ends[ends.length - 1] : null;
}

/**
 * The one publishing decision: accept every channel's proposed boundary at once. Never a per-item queue.
 * Two steps (review, then confirm) because it records an owner approval; nothing goes live from it alone.
 */
export function ProposalBlock({ board, niches, onBoard }: { board: OperatorBoard; niches: Niche[]; onBoard: (b: OperatorBoard) => void }) {
  const source = useSource();
  const now = useNow();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const p = board.proposal;
  if (!p) return null;
  const until = appliedUntil(board.policies);
  const expired = !!until && Date.parse(until) <= now.getTime();
  const applied = proposalApplied(p, board.policies) && !expired;

  async function apply() {
    if (!p) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await source.applyPublishingProposal(p.version);
      setMsg({ tone: 'ok', text: `Applied. One approval (${r.approvalId}) covers ${p.channels.length} channels until ${formatDateYear(r.windowEnd)}. No live connection was made.` });
      setConfirming(false);
      onBoard(await source.getOperator());
    } catch (e) {
      setMsg({ tone: 'err', text: (e as Error).message });
      if ((e as { status?: number }).status === 409) onBoard(await source.getOperator());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="proposal" data-testid="publishing-proposal">
      <div className="proposal__head">
        <h3 className="subhead">Publishing proposal</h3>
        <span className="mono small muted">v{p.version}</span>
        {applied && <span className="tag tag--good">Applied{until ? ` until ${formatDateYear(until)}` : ''}</span>}
        {expired && <span className="tag tag--warn">Expired {formatDateYear(until!)}</span>}
      </div>
      <p>{p.summary}</p>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Proposed publishing boundaries table, scrollable">
        <table className="table">
          <caption className="sr-only">Proposed publishing boundaries</caption>
          <thead>
            <tr>
              <th scope="col">Channel</th>
              <th scope="col">Proposed</th>
              <th scope="col">Why</th>
              <th scope="col">Going live needs</th>
            </tr>
          </thead>
          <tbody>
            {p.channels.map((c) => (
              <tr key={c.channelId}>
                <th scope="row">
                  {cap(c.platform)}
                  <span className="job__name">{nicheName(niches, c.nicheId)}</span>
                </th>
                <td>
                  {MODE[c.mode] ?? cap(c.mode)}
                  <span className="job__name">
                    {publisherText(c.publisher)}, up to {c.dailyCap}/day
                  </span>
                </td>
                <td className="wrap">{c.why}</td>
                <td className="wrap">{c.liveConnectionNeeded}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!applied && (
        <div className="proposal__act">
          {!confirming ? (
            <button className="btn btn--primary" onClick={() => setConfirming(true)}>
              Apply all {p.channels.length} {p.channels.length === 1 ? "boundary" : "boundaries"}
            </button>
          ) : (
            <div className="confirm" role="group" aria-label="Confirm publishing proposal">
              <p>
                This records one owner approval covering all {p.channels.length} channels until {formatDateYear(p.windowEnd)}. Every channel stays on
                its current publisher (dry run or manual); each live connection is a separate decision.
              </p>
              <div className="confirm__buttons">
                <button className="btn btn--primary" onClick={apply} disabled={busy}>
                  {busy ? 'Applying…' : 'Confirm: apply all'}
                </button>
                <button className="btn btn--quiet" onClick={() => setConfirming(false)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {msg && (
        <p className={msg.tone === 'ok' ? 'job__msg' : 'error-note'} role="status">
          {msg.text}
        </p>
      )}
    </div>
  );
}

const IMPACT_TONE: Record<string, string> = { high: 'critical', medium: 'warn', low: 'outline' };

/** Optimization proposals from ops.optimize_weekly. Decided in one batch; deciding changes nothing on any site by itself. */
export function RecommendationsBlock({ board, niches, onBoard }: { board: OperatorBoard; niches: Niche[]; onBoard: (b: OperatorBoard) => void }) {
  const source = useSource();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const recos = board.recommendations;
  if (recos === null) return null;

  async function decide(status: 'accepted' | 'dismissed' | 'done') {
    setBusy(true);
    setMsg(null);
    try {
      const n = await source.decideRecommendations(picked, status);
      setMsg(`${n} proposal${n === 1 ? '' : 's'} marked ${status}. This records your decision; it doesn't change any site or channel.`);
      setPicked([]);
      onBoard(await source.getOperator());
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="recos">
      <h3 className="subhead">Optimization proposals</h3>
      {recos.length === 0 ? (
        <p className="muted small">No open proposals. The weekly optimization pass only proposes a change once it has enough data to cite.</p>
      ) : (
        <>
          <ul className="reco-list">
            {recos.map((r: Recommendation) => (
              <li key={r.id} className="reco">
                <label className="reco__pick">
                  <input
                    type="checkbox"
                    checked={picked.includes(r.id)}
                    onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))}
                    aria-label={`Select: ${r.title}`}
                  />
                </label>
                <div>
                  <p className="reco__head">
                    <span className={`tag tag--${IMPACT_TONE[r.impact] ?? 'outline'}`}>{cap(r.impact)} impact</span>
                    {r.evidenceLabel && <span className={`evidence evidence--${r.evidenceLabel.toLowerCase()}`}>{cap(r.evidenceLabel.toLowerCase())}</span>}
                    <span className="muted small">{r.nicheId ? nicheName(niches, r.nicheId) : 'Portfolio'}</span>
                    {r.needsOwner && (
                      <span className="tag tag--owner">
                        <Icon name="star" size={12} /> Needs you
                      </span>
                    )}
                  </p>
                  <p className="reco__title">{r.title}</p>
                  <p className="small">{r.detail}</p>
                  <p className="small">
                    <span className="alert__next-label">Proposed:</span> {r.action}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <div className="confirm__buttons" role="group" aria-label="Decide selected proposals">
            <span className="muted small" aria-live="polite">
              {picked.length} selected
            </span>
            <button className="btn btn--quiet" disabled={!picked.length || busy} onClick={() => decide('accepted')}>
              Accept selected
            </button>
            <button className="btn btn--quiet" disabled={!picked.length || busy} onClick={() => decide('dismissed')}>
              Dismiss selected
            </button>
            <button className="btn btn--quiet" disabled={!picked.length || busy} onClick={() => decide('done')}>
              Mark done
            </button>
          </div>
        </>
      )}
      {msg && (
        <p className="job__msg" role="status">
          {msg}
        </p>
      )}
    </div>
  );
}

/** Email lifecycle: MailerLite snapshot (read-only) and the sequences FORGE holds. Unconnected means UNKNOWN, never 0. */
export function LifecycleBlock({ board, niches }: { board: OperatorBoard; niches: Niche[] }) {
  const lc = board.lifecycle;
  if (!lc) return null;
  const { snapshot: s, sequences } = lc;
  const live = s.state === 'live';
  const num = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US'));
  return (
    <div className="lifecycle">
      <h3 className="subhead">Email lifecycle</h3>
      {!live ? (
        <EmptyState icon="plug-off" title={s.state === 'error' ? 'MailerLite could not be read' : 'Subscriber numbers are unknown'}>
          <p>
            {s.state === 'error'
              ? `The last read failed${s.note ? `: ${s.note}` : ''}. Counts are unknown until a read succeeds.`
              : 'FORGE is not yet reading MailerLite (its read-only key needs your approval), so subscriber and form numbers are UNKNOWN, not zero.'}
            {s.takenAt && ` Last attempt ${formatDateTime(s.takenAt)}.`}
          </p>
        </EmptyState>
      ) : (
        <>
        <p className="provenance">
          <span>MailerLite, read-only</span>
          <span aria-hidden="true">·</span>
          <span>read {s.takenAt ? formatDateTime(s.takenAt) : 'at an unknown time'}</span>
        </p>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Subscriber groups table, scrollable">
          <table className="table">
            <caption className="sr-only">Subscriber groups, read {s.takenAt ? formatDateTime(s.takenAt) : ''}</caption>
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">Business</th>
                <th scope="col">Active</th>
                <th scope="col">Unconfirmed</th>
              </tr>
            </thead>
            <tbody>
              {s.groups.map((g) => (
                <tr key={g.id}>
                  <th scope="row">{g.name}</th>
                  <td>{g.nicheId ? nicheName(niches, g.nicheId) : '—'}</td>
                  <td>{num(g.active)}</td>
                  <td>{num(g.unconfirmed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
      {sequences.length > 0 && (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Email sequences table, scrollable">
          <table className="table">
            <caption className="sr-only">Email sequences held by FORGE</caption>
            <thead>
              <tr>
                <th scope="col">Sequence</th>
                <th scope="col">Business</th>
                <th scope="col">Emails</th>
                <th scope="col">Status</th>
                <th scope="col">Claims check</th>
              </tr>
            </thead>
            <tbody>
              {sequences.map((q) => {
                const auto = live ? s.automations.find((a) => a.name === q.name) : undefined;
                return (
                  <tr key={q.id}>
                    <th scope="row" className="wrap">
                      {q.name}
                      <span className="job__name">{cap(q.kind)}</span>
                    </th>
                    <td>{nicheName(niches, q.nicheId)}</td>
                    <td>{q.emails}</td>
                    <td>
                      <span className="tag tag--outline">{cap(auto?.status ?? q.status)}</span>
                      {!q.mailerliteAutomationId && <span className="muted small"> not in MailerLite</span>}
                    </td>
                    <td className="wrap">
                      {q.lint.length ? <span className="text-critical">{q.lint.length} issue{q.lint.length === 1 ? '' : 's'}</span> : <span className="muted">Passes</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
