import type { Alert, Channel, Niche, PortfolioSummary, Severity } from '../data/types';

export const SEVERITY_ORDER: Severity[] = ['critical', 'serious', 'warning', 'info'];

export function sortAlerts(alerts: Alert[]): Alert[] {
  return [...alerts].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.lastSeen.localeCompare(a.lastSeen),
  );
}

export function channelCounts(channels: Channel[]) {
  return {
    verified: channels.filter((c) => c.state === 'verified').length,
    total: channels.length,
    failing: channels.filter((c) => c.state === 'failing').length,
  };
}

export function sellable(n: Niche) {
  const paid = n.products.filter((p) => p.kind === 'paid_download' || p.kind === 'book');
  return { live: paid.filter((p) => p.checkout === 'live').length, total: paid.length };
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const word = (n: number) => WORDS[n] ?? String(n);

/** The headline sentence for the portfolio: outcomes, in plain words, from data only. */
export function portfolioHeadline(p: PortfolioSummary): { title: string; lede: string } {
  const n = p.niches.length;
  const blocked = p.niches.filter((x) => x.health === 'blocked').length;
  const rev = p.financials.grossRevenue;
  const ch = channelCounts(p.niches.flatMap((x) => x.channels));
  const open = p.alerts.filter((a) => a.state !== 'resolved');
  const needs = open.filter((a) => a.needsOwner).length;

  let title: string;
  if (rev.state === 'verified' && rev.value === 0) {
    title = `${word(n)} businesses are running. None has taken a live payment yet.`;
  } else if (rev.state === 'verified' && rev.value !== null) {
    title = `${word(n)} businesses earned $${rev.value.toLocaleString('en-US')} this period.`;
  } else {
    title = `${word(n)} businesses are running. Revenue is not yet measured.`;
  }
  const parts = [
    `${ch.verified} of ${ch.total} marketing channels verified`,
    `${open.length} open ${open.length === 1 ? 'exception' : 'exceptions'}${needs ? `, ${needs} ${needs === 1 ? 'needs' : 'need'} you` : ''}`,
  ];
  if (blocked) parts.push(`${blocked} ${blocked === 1 ? 'business' : 'businesses'} blocked`);
  return { title, lede: parts.join(' · ') };
}

export const PLATFORMS = ['Search (SEO)', 'Pinterest', 'Email (MailerLite)', 'Instagram', 'Facebook', 'YouTube'];
