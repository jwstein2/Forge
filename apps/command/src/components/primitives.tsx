import type { ReactNode } from 'react';
import type {
  BuildStatus,
  ChannelState,
  Health,
  Metric,
  MetricState,
  Severity,
} from '../data/types';
import { STATE_LABEL, formatValue, freshness } from '../lib/format';
import { useNow } from '../lib/clock';
import { Icon, type IconName } from './Icon';
import { safeHref } from '../lib/safeUrl';

/* ------------------------------------------------------------ evidence state */

const STATE_ICON: Record<MetricState, IconName> = {
  verified: 'check-circle',
  estimated: 'tilde',
  inferred: 'tilde',
  unknown: 'question',
  unconnected: 'plug-off',
  test_only: 'flask',
  sample: 'sample',
};

export function StateChip({ state, compact = false }: { state: MetricState; compact?: boolean }) {
  return (
    <span className={`chip chip--${state}`} data-state={state}>
      <Icon name={STATE_ICON[state]} size={12} />
      {!compact && <span>{STATE_LABEL[state]}</span>}
      {compact && <span className="sr-only">{STATE_LABEL[state]}</span>}
    </span>
  );
}

/** One-line provenance: period · freshness · source. Required under every metric. */
export function Provenance({ metric, hideSource = false }: { metric: Metric; hideSource?: boolean }) {
  const now = useNow();
  return (
    <p className="provenance">
      <span>{metric.period.label}</span>
      <span aria-hidden="true">·</span>
      <span title={metric.asOf ?? undefined}>{metric.asOf ? `as of ${freshness(metric.asOf, now)}` : 'date not recorded'}</span>
      {!hideSource && (
        <>
          <span aria-hidden="true">·</span>
          {safeHref(metric.evidenceUrl) ? <a href={safeHref(metric.evidenceUrl)!}>{metric.source}</a> : <span>{metric.source}</span>}
        </>
      )}
    </p>
  );
}

/** A labelled number with its evidence state, period and freshness. */
export function Stat({
  label,
  metric,
  size = 'md',
  hint,
}: {
  label: string;
  metric: Metric;
  size?: 'md' | 'lg';
  hint?: ReactNode;
}) {
  const muted = metric.value === null || metric.state === 'test_only' || metric.state === 'sample';
  return (
    <div className={`stat stat--${size}`} data-testid={`stat-${label}`}>
      <div className="stat__head">
        <span className="stat__label">{label}</span>
        <StateChip state={metric.state} />
      </div>
      <p className={`stat__value${muted ? ' stat__value--muted' : ''}`}>
        {formatValue(metric, { cents: metric.value !== null && !Number.isInteger(metric.value) })}
        {metric.value === null && <span className="sr-only"> ({STATE_LABEL[metric.state]})</span>}
      </p>
      {metric.note && <p className="stat__note">{metric.note}</p>}
      {hint}
      <Provenance metric={metric} />
    </div>
  );
}

/* ------------------------------------------------------------ health / status */

const HEALTH: Record<Health, { label: string; icon: IconName; tone: string }> = {
  healthy: { label: 'Healthy', icon: 'check-circle', tone: 'good' },
  degraded: { label: 'Degraded', icon: 'alert-triangle', tone: 'warn' },
  blocked: { label: 'Blocked', icon: 'stop', tone: 'critical' },
  unknown: { label: 'Unknown', icon: 'question', tone: 'neutral' },
};

export function HealthBadge({ health }: { health: Health }) {
  const h = HEALTH[health];
  return (
    <span className={`badge badge--${h.tone}`} data-health={health}>
      <Icon name={h.icon} size={14} />
      {h.label}
    </span>
  );
}

const BUILD: Record<BuildStatus, { label: string; tone: string }> = {
  proposed: { label: 'Proposed', tone: 'neutral' },
  built: { label: 'Built', tone: 'neutral' },
  tested: { label: 'Tested', tone: 'info' },
  live: { label: 'Live', tone: 'good' },
  failed: { label: 'Failed', tone: 'critical' },
  unverified: { label: 'Unverified', tone: 'outline' },
};

export function StatusTag({ status }: { status: BuildStatus }) {
  const b = BUILD[status];
  return (
    <span className={`tag tag--${b.tone}`} data-status={status}>
      {b.label}
    </span>
  );
}

const CHANNEL: Record<ChannelState, { label: string; icon: IconName; tone: string }> = {
  verified: { label: 'Verified', icon: 'check-circle', tone: 'good' },
  running: { label: 'Running', icon: 'pulse', tone: 'info' },
  configured: { label: 'Configured', icon: 'gear', tone: 'neutral' },
  failing: { label: 'Failing', icon: 'alert-triangle', tone: 'critical' },
  not_connected: { label: 'Not connected', icon: 'plug-off', tone: 'outline' },
};

export function ChannelBadge({ state }: { state: ChannelState }) {
  const c = CHANNEL[state];
  return (
    <span className={`badge badge--${c.tone}`} data-channel={state}>
      <Icon name={c.icon} size={14} />
      {c.label}
    </span>
  );
}

const SEVERITY: Record<Severity, { label: string; icon: IconName }> = {
  critical: { label: 'Critical', icon: 'stop' },
  serious: { label: 'Serious', icon: 'alert-triangle' },
  warning: { label: 'Warning', icon: 'alert-circle' },
  info: { label: 'Info', icon: 'info' },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY[severity];
  return (
    <span className={`badge badge--sev-${severity}`} data-severity={severity}>
      <Icon name={s.icon} size={14} />
      {s.label}
    </span>
  );
}

/* ------------------------------------------------------------ layout */

export function Section({
  title,
  kicker,
  actions,
  children,
  id,
}: {
  title: string;
  kicker?: string;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  const hid = id ? `${id}-title` : undefined;
  return (
    <section className="section" aria-labelledby={hid} id={id}>
      <header className="section__head">
        <div>
          {kicker && <p className="kicker">{kicker}</p>}
          <h2 className="section__title" id={hid}>
            {title}
          </h2>
        </div>
        {actions && <div className="section__actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function PageHeader({ kicker, title, lede, aside }: { kicker: string; title: ReactNode; lede?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head__main">
        <p className="kicker">{kicker}</p>
        <h1 className="page-head__title">{title}</h1>
        {lede && <p className="page-head__lede">{lede}</p>}
      </div>
      {aside && <div className="page-head__aside">{aside}</div>}
    </header>
  );
}

export function EmptyState({ icon, title, children, level = 3 }: { icon: IconName; title: string; children: ReactNode; level?: 2 | 3 }) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className="empty">
      <span className="empty__icon" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <Heading className="empty__title">{title}</Heading>
      <div className="empty__body">{children}</div>
    </div>
  );
}

export function SampleBanner({ children }: { children: ReactNode }) {
  return (
    <div className="sample-banner" role="note" aria-label="Sample data">
      <Icon name="sample" size={16} />
      <div>
        <strong>Sample data, not research.</strong> {children}
      </div>
    </div>
  );
}

export function NicheDot({ accent, label }: { accent: string; label?: string }) {
  return <span className="niche-dot" style={{ background: `var(${accent})` }} aria-hidden={label ? undefined : true} aria-label={label} />;
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="loading__bar" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorNote({ error }: { error: Error }) {
  return (
    <div className="error-note" role="alert">
      <Icon name="alert-triangle" size={16} /> Could not load this view: {error.message}
    </div>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const safe = safeHref(href);
  if (!safe) return <span className="ext-link ext-link--blocked" title="Link hidden: only https links are allowed">{children}</span>;
  return (
    <a className="ext-link" href={safe} target="_blank" rel="noopener noreferrer">
      {children}
      <Icon name="external" size={12} />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
