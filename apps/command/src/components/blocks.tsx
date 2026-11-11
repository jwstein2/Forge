import { Link } from 'react-router-dom';
import type { ActivityEvent, Alert, Channel, Niche } from '../data/types';
import { formatDateTime, freshness } from '../lib/format';
import { useNow } from '../lib/clock';
import { PLATFORMS } from '../lib/derive';
import { Icon } from './Icon';
import { sourceLabel } from '../data/operatorMap';
import { ChannelBadge, ExternalLink, NicheDot, SeverityBadge } from './primitives';

export function nicheName(niches: Niche[], id: string) {
  return id === 'portfolio' ? 'Portfolio' : niches.find((n) => n.id === id)?.name ?? id;
}

export function AlertList({ alerts, niches, limit }: { alerts: Alert[]; niches: Niche[]; limit?: number }) {
  const now = useNow();
  const shown = limit ? alerts.slice(0, limit) : alerts;
  return (
    <ul className="alert-list">
      {shown.map((a) => (
        <li key={a.id} className={`alert alert--${a.severity}`}>
          <div className="alert__head">
            <SeverityBadge severity={a.severity} />
            <span className="alert__scope">{nicheName(niches, a.nicheId)}</span>
            {a.needsOwner && (
              <span className="tag tag--owner">
                <Icon name="star" size={12} /> Needs you
              </span>
            )}
          </div>
          <p className="alert__title">{a.title}</p>
          <p className="alert__detail">{a.detail}</p>
          <p className="alert__meta">
            <span>
              <span className="alert__next-label">Next:</span> {a.nextAction}
            </span>
            <span className="alert__seen">
              Seen {freshness(a.lastSeen, now)} · <span title={a.source}>{sourceLabel(a.source)}</span>
            </span>
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Folds runs of the same job with the same outcome into one row ("×5, latest ..."), so routine ticks don't bury the rest. */
export function groupActivity(events: ActivityEvent[]): (ActivityEvent & { count: number; earliest: string })[] {
  const out: (ActivityEvent & { count: number; earliest: string })[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (prev && prev.summary === e.summary && prev.actor === e.actor && prev.nicheId === e.nicheId && prev.verified === e.verified) {
      prev.count += 1;
      prev.earliest = e.at < prev.earliest ? e.at : prev.earliest;
    } else out.push({ ...e, count: 1, earliest: e.at });
  }
  return out;
}

export function ActivityFeed({ events, niches, limit }: { events: ActivityEvent[]; niches: Niche[]; limit?: number }) {
  const rows = groupActivity(events).slice(0, limit);
  return (
    <ol className="feed">
      {rows.map((e) => (
        <li key={e.id} className="feed__item">
          <span className={`feed__mark${e.verified ? ' is-verified' : ''}`} aria-hidden="true">
            <Icon name={e.verified ? 'check-circle' : 'question'} size={14} />
          </span>
          <div>
            <p className="feed__text">
              {e.summary}
              {e.count > 1 && <span className="feed__count"> ×{e.count}</span>}
            </p>
            <p className="feed__meta">
              {e.count > 1 && 'latest '}
              <time dateTime={e.at}>{formatDateTime(e.at)}</time> · <span className="mono">{e.actor}</span> · {nicheName(niches, e.nicheId)}
              {!e.verified && <span className="feed__unv"> · outcome not verified</span>}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Niches × platforms. Unlisted cells are "not connected": planned channels never look active. */
export function ChannelMatrix({ niches }: { niches: Niche[] }) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Marketing channels by niche table, scrollable">
      <table className="table matrix">
        <caption className="sr-only">Marketing channels by niche</caption>
        <thead>
          <tr>
            <th scope="col">Niche</th>
            {PLATFORMS.map((p) => (
              <th key={p} scope="col">
                {p.replace(' (MailerLite)', '').replace(' (SEO)', '')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {niches.map((n) => (
            <tr key={n.id}>
              <th scope="row">
                <Link to={`/niches/${n.id}`} className="matrix__niche">
                  <NicheDot accent={n.accent} />
                  {n.name}
                </Link>
              </th>
              {PLATFORMS.map((p) => {
                const c = n.channels.find((x) => x.platform === p);
                return (
                  <td key={p}>
                    <ChannelBadge state={c?.state ?? 'not_connected'} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChannelRow({ c }: { c: Channel }) {
  return (
    <li className="channel">
      <div className="channel__head">
        <span className="channel__name">{c.platform}</span>
        <ChannelBadge state={c.state} />
      </div>
      <p className="channel__detail">{c.detail}</p>
      <dl className="kv">
        <div>
          <dt>Cadence</dt>
          <dd>{c.cadence ?? 'None set'}</dd>
        </div>
        <div>
          <dt>Last verified</dt>
          <dd>{formatDateTime(c.lastVerifiedAt)}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{c.owner ?? 'Unassigned'}</dd>
        </div>
      </dl>
      {(c.accountUrl || c.lastVerifiedUrl) && (
        <p className="channel__links">
          {c.accountUrl && <ExternalLink href={c.accountUrl}>Open account</ExternalLink>}
          {c.lastVerifiedUrl && <ExternalLink href={c.lastVerifiedUrl}>Last post</ExternalLink>}
        </p>
      )}
    </li>
  );
}
