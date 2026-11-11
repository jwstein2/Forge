/**
 * Mapping from @forge/contracts (API v1) to FORGE Command view models.
 * Follows CONTRACTS.md §6. Pure functions: easy to test, no fetching here.
 * Where the API has no equivalent field, the UI value says so explicitly; nothing is invented.
 */
import type * as C from './contracts';
import type {
  Account,
  ActivityEvent,
  Alert,
  Build,
  BuildBoard,
  BuildStage,
  BuildStatus,
  Channel,
  EvidenceLabel,
  FinancialStatement,
  Integration,
  Job,
  Metric,
  Niche,
  Opportunity,
  OpportunityBoard,
  Product,
  TrendSeries,
  ScoutRunInfo,
} from './types';

const NICHE_ACCENT: Record<string, string> = {
  'quilt-plan-kit': '--niche-qpk',
  bidline: '--niche-bid',
  'loaf-ledger': '--niche-loaf',
};
/** Future niches beyond the three validated identity slots share a neutral mark (never a generated hue). */
export const accentFor = (id: string) => NICHE_ACCENT[id] ?? '--neutral';

const usdFromCents = (c: number | null) => (c === null ? null : c / 100);

function unconnectedMetric(period: C.Period, source: string, unit: Metric['unit'] = 'count'): Metric {
  return { value: null, unit, state: 'unconnected', period, asOf: null, source };
}

export const lowerStatus = (s: C.ImplStatus) => s.toLowerCase() as BuildStatus;

export function mapFinancials(f: C.FinancialBreakdown): FinancialStatement {
  return {
    period: f.period,
    grossRevenue: f.grossSales,
    refunds: f.refunds,
    paymentFees: f.paymentFees,
    productCosts: f.productCosts,
    softwareAndHosting: f.hostingAndSoftware,
    aiUsage: f.aiUsage,
    marketingSpend: f.marketingSpend,
    allocatedShared: f.allocatedShared,
    contribution: f.contribution,
    orders: f.orders,
    testOrders: f.testOrders,
    missingLines: f.missingLines,
  };
}

const PLATFORM_LABEL: Record<string, string> = {
  seo: 'Search (SEO)',
  pinterest: 'Pinterest',
  email: 'Email (MailerLite)',
  instagram: 'Instagram',
  facebook: 'Facebook',
  youtube: 'YouTube',
};

export function mapChannel(c: C.Channel): Channel {
  return {
    id: c.id,
    nicheId: c.nicheId,
    platform: PLATFORM_LABEL[c.platform.toLowerCase()] ?? c.platform,
    state: c.status === 'unconnected' ? 'not_connected' : c.status,
    cadence: c.cadence,
    lastVerifiedAt: c.lastVerifiedAt,
    lastVerifiedUrl: c.lastVerifiedUrl ?? undefined,
    accountUrl: c.accountUrl ?? undefined,
    owner: c.jobId,
    detail: c.notes ?? '',
  };
}

export function mapProduct(p: C.Product, period: C.Period, asOf: string | null): Product {
  const kind: Product['kind'] =
    p.tier === 'free' ? (p.kind === 'calculator' ? 'calculator' : 'free_resource') : p.kind === 'book' ? 'book' : 'paid_download';
  const price = (cents: number | null, state: Metric['state'], source: string): Metric | null =>
    cents === null ? null : { value: usdFromCents(cents), unit: 'usd', state, period: { ...period, label: 'Current' }, asOf, source };
  const issues = [p.notes, p.priceMismatch ? 'Site and checkout prices differ.' : null].filter(Boolean);
  return {
    id: p.id,
    nicheId: p.nicheId,
    name: p.name,
    kind,
    // Site price counts as verified only when the product carries supporting evidence.
    listedPrice: price(p.sitePriceCents, p.evidence.length ? 'verified' : 'estimated', p.evidence.length ? 'Site source (evidence on file)' : 'Platform record; not independently verified'),
    storePrice: price(p.checkoutPriceCents, p.checkoutStatus === 'live' ? 'verified' : 'test_only', 'Checkout platform'),
    status: lowerStatus(p.status),
    checkout:
      p.tier === 'free' ? 'not_applicable' : p.checkoutStatus === 'live' ? 'live' : p.checkoutStatus === 'test_mode' ? 'test_mode' : 'not_configured',
    fulfillment: p.deliveryStatus === 'verified' ? 'verified' : p.deliveryStatus === 'n/a' ? 'not_applicable' : 'unverified',
    issue: issues.length ? issues.join(' ') : undefined,
  };
}

const RUNNER: Record<C.Runner, Job['runner']> = {
  n8n: 'n8n',
  claude: 'claude_scheduled',
  cloudflare: 'cloudflare',
  github_actions: 'github_actions',
  forge: 'forge',
  manual: 'manual',
};

export function mapJob(r: C.RegistryEntry): Job {
  const last = r.lastRun?.status;
  return {
    id: r.id,
    name: r.name,
    nicheId: r.nicheId ?? 'portfolio',
    runner: RUNNER[r.runner] ?? 'manual',
    cadence: r.cadence ?? r.trigger ?? 'Not scheduled',
    status: lowerStatus(r.status),
    paused: r.paused,
    pausable: r.pausable,
    lastRunAt: r.lastRun?.startedAt ?? null,
    lastSuccessAt: r.lastSuccess ? r.lastSuccess.finishedAt ?? r.lastSuccess.startedAt : null,
    lastResult: last === 'success' ? 'success' : last === 'failed' || last === 'timeout' ? 'failure' : 'none',
    heartbeatOk: r.heartbeat === 'ok' ? true : r.heartbeat === 'late' ? false : null,
    heartbeat: r.heartbeat,
    lastSuccessSource: r.lastSuccess?.source,
    evidenceUrl: r.lastSuccess?.evidenceUrl ?? undefined,
    defects: r.defects,
    monthlyRuns: r.runsLast30d,
  };
}

const INT_HEALTH: Record<C.IntegrationStatus, Integration['health']> = {
  connected: 'healthy',
  degraded: 'degraded',
  failed: 'blocked',
  unconnected: 'unknown',
  unknown: 'unknown',
};
const INT_STATUS: Record<C.IntegrationStatus, BuildStatus> = {
  connected: 'live',
  degraded: 'live',
  failed: 'failed',
  unconnected: 'proposed',
  unknown: 'unverified',
};

export function mapIntegration(i: C.Integration, allNiches: string[]): Integration {
  const detail = [i.purpose, i.detail, i.blocker ? `Blocker: ${i.blocker}` : null].filter(Boolean).join(' ');
  return {
    id: i.id,
    name: i.service,
    nicheIds: i.nicheId ? [i.nicheId] : allNiches,
    health: INT_HEALTH[i.status],
    status: INT_STATUS[i.status],
    detail: i.status === 'unconnected' ? `Not connected. ${detail}` : detail,
    lastCheckedAt: i.lastCheckedAt,
  };
}

/** Fallback for pre-1.1.0 APIs without Alert.needsOwner: infer from the next action naming the owner. */
export const needsOwner = (nextAction: string | null) => !!nextAction && /\b(owner|james|you)\b/i.test(nextAction);

export function mapAlert(a: C.Alert): Alert {
  return {
    id: a.id,
    severity: a.severity,
    nicheId: a.nicheId ?? 'portfolio',
    title: a.title,
    detail: a.detail ?? '',
    source: a.source,
    firstSeen: a.firstSeen,
    lastSeen: a.lastSeen,
    state: a.state,
    nextAction: a.nextAction ?? 'Not yet assigned.',
    needsOwner: typeof a.needsOwner === 'boolean' ? a.needsOwner : needsOwner(a.nextAction),
  };
}

export function mapSeries(t: C.TrendSeries): TrendSeries {
  return {
    id: t.id,
    label: t.label,
    nicheId: t.nicheId === 'portfolio' ? undefined : t.nicheId,
    unit: t.unit,
    state: t.state,
    period: t.period,
    asOf: t.asOf,
    source: t.source,
    points: t.points,
  };
}

export function mapActivity(a: C.ActivityItem, i: number): ActivityEvent {
  return {
    id: `${a.at}-${i}`,
    at: a.at,
    nicheId: a.nicheId ?? 'portfolio',
    actor: a.kind.replace('_', ' '),
    summary: a.title,
    verified: ['success', 'verified', 'pass', 'recorded'].includes(a.status.toLowerCase()),
    evidenceUrl: a.evidenceUrl,
  };
}

export function mapNiche(d: C.NicheDetail, briefVersion: string | null): Niche {
  const period = d.financials.period;
  const stage = `${d.lifecycle[0].toUpperCase()}${d.lifecycle.slice(1)} · ${d.canTakePayment ? 'taking payments' : 'cannot take payment yet'}`;
  return {
    id: d.id,
    name: d.name,
    tagline: d.tagline ?? '',
    audience: 'Defined in the Audience & Market Brief.',
    positioning: d.positioning ?? 'Positioning not recorded in the platform yet.',
    siteUrl: d.siteUrl ?? '',
    hosting: 'Cloudflare Pages',
    health: d.health,
    healthReason: d.healthReasons.join(' ') || 'No reasons recorded.',
    stage,
    accent: accentFor(d.id),
    financials: mapFinancials(d.financials),
    traffic: {
      pageViews: d.pageViews,
      visitors: unconnectedMetric(period, 'Visitor analytics not connected'),
      conversionRate: { value: null, unit: 'pct', state: 'unknown', period, asOf: null, source: 'Needs live orders and visitor counts' },
    },
    products: d.products.map((p) => mapProduct(p, period, d.financials.grossSales.asOf)),
    channels: d.channels.map(mapChannel),
    experiments: [],
    briefVersion,
  };
}

export function mapAccount(a: C.Account): Account {
  return {
    id: a.id,
    service: a.service,
    nicheIds: [a.nicheId ?? 'portfolio'],
    identifier: a.identifier ?? 'Not recorded',
    status: a.status,
    owner: a.owner,
    consoleUrl: a.url ?? undefined,
    passwordManagerRef: a.passwordManagerRef,
    authMethod: 'unknown',
    note: a.notes ?? undefined,
  };
}

/* ---------------------------------------------------------------- opportunities */

type Claim = { statement: string; evidence: C.EvidenceLabel; source_ids?: string[]; observed_at?: string };
type Scenario = { monthly_gross: number; monthly_contribution?: number | null; assumptions: string[] };
type OppContent = {
  customer_segment?: string;
  problem?: string;
  proposed_offer?: { model?: string; description?: string; price?: { value: number | string | null; evidence?: C.EvidenceLabel; currency?: string } };
  demand_summary?: Claim[] | null;
  competitor_summary?: Claim[] | null;
  seasonality?: { event: string; demand_window: string; publish_by: string; evidence: Claim }[] | null;
  economics?: { downside?: Scenario; base?: Scenario; upside?: Scenario } | null;
  launch_effort?: string | null;
  criterion_scores?: { key: string; score: number | null; evidence: C.EvidenceLabel; rationale?: string }[];
  adjusted_score?: number;
  raw_score?: number | null;
  evidence_coverage?: number | null;
  support_load?: string | null;
  hypothesis?: string | null;
  why_beats_alternatives?: string | null;
  falsifying_test?: string | null;
  confidence?: 'high' | 'medium' | 'low';
  recommendation_strength?: 'clear' | 'narrow' | 'none';
  gates?: { key: string; passed: boolean; note?: string }[];
  unconnected_sources?: { name: string; would_add: string }[];
};

const ev = (e: C.EvidenceLabel) => e.toLowerCase() as EvidenceLabel;
const claims = (cs: Claim[] | null | undefined) =>
  (cs ?? []).map((c) => ({ claim: c.statement, label: ev(c.evidence), source: c.source_ids?.join(', '), accessed: c.observed_at }));
const titleCase = (k: string) => k.replace(/_/g, ' ').replace(/^\w/, (m) => m.toUpperCase());

export function mapOpportunity(o: C.OpportunityEnvelope, runAt: string | null): Opportunity {
  const c = (o.content ?? {}) as OppContent;
  const period = { start: runAt ?? '', end: runAt ?? '', label: 'Modelled month' };
  const scen = (s?: Scenario): Metric => ({
    value: s?.monthly_contribution ?? null,
    unit: 'usd',
    state: s?.monthly_contribution != null ? 'inferred' : 'unknown',
    period,
    asOf: runAt,
    source: 'Scout model hypothesis',
    note: s ? `Gross ~$${s.monthly_gross}/month` : undefined,
  });
  const failedGates = (c.gates ?? []).filter((g) => !g.passed);
  const verdict: Opportunity['verdict'] = failedGates.length ? 'no_go' : o.recommended ? 'go' : 'hold';
  const effort = (c.launch_effort ?? '').toLowerCase();
  return {
    id: o.id,
    rank: o.rank ?? 99,
    name: o.title,
    recommended: o.recommended,
    segment: c.customer_segment ?? 'Not recorded',
    problem: c.problem ?? 'Not recorded',
    hunch: c.hypothesis ?? 'No hypothesis recorded in this run.',
    score: {
      total: Math.round(o.score ?? c.adjusted_score ?? 0),
      raw: c.raw_score ?? null,
      coverage: c.evidence_coverage ?? null,
      components: (c.criterion_scores ?? []).map((s) => ({
        label: `${titleCase(s.key)} (${s.evidence.toLowerCase()})`,
        value: s.score === null ? 0 : Math.round(s.score * 20), // criteria are scored 0–5
        display: s.score === null ? 'unknown' : `${s.score}/5`,
        rationale: s.rationale,
      })),
    },
    confidence: c.confidence ?? 'low',
    demand: claims(c.demand_summary),
    competitors: [],
    competitorClaims: claims(c.competitor_summary),
    demographics: [],
    productModel: [c.proposed_offer?.model && titleCase(c.proposed_offer.model), c.proposed_offer?.description].filter(Boolean).join(': ') || 'Not recorded',
    offer: {
      price: priceText(c.proposed_offer?.price),
      monetization: c.proposed_offer?.model ? titleCase(c.proposed_offer.model) : 'Not recorded',
    },
    seasonality: {
      months: null,
      peak: c.seasonality?.[0]?.event ?? 'Unknown',
      launchBy: c.seasonality?.[0]?.publish_by ?? 'Unknown',
      source: 'Audience & Market Brief seasonal windows',
      windows: (c.seasonality ?? []).map((w) => ({ event: w.event, demandWindow: w.demand_window, publishBy: w.publish_by, evidence: ev(w.evidence.evidence) })),
    },
    distribution: [],
    economics: {
      downside: scen(c.economics?.downside),
      base: scen(c.economics?.base),
      upside: scen(c.economics?.upside),
      launchCost: { value: null, unit: 'usd', state: 'unknown', period, asOf: runAt, source: 'Not modelled in this run' },
      assumptions: c.economics?.base?.assumptions ?? ['No economics modelled in this run'],
    },
    risks: failedGates.map((g) => `${titleCase(g.key)} gate failed${g.note ? `: ${g.note}` : ''}`),
    gaps: (c.unconnected_sources ?? []).map((u) => `${u.name} not connected (would add ${u.would_add})`),
    reuse: [],
    complexity: effort.includes('high') ? 'high' : effort.includes('low') ? 'low' : 'medium',
    verdict,
    verdictReason: c.why_beats_alternatives ?? `Recommendation strength: ${c.recommendation_strength ?? 'none'}.`,
    unconnected: (c.unconnected_sources ?? []).map((u) => ({ name: u.name, wouldAdd: u.would_add })),
    effort: c.launch_effort ?? undefined,
    supportLoad: c.support_load ?? undefined,
    falsifyingTest: c.falsifying_test ?? undefined,
    strength: c.recommendation_strength,
    priceEvidence: c.proposed_offer?.price?.evidence ? ev(c.proposed_offer.price.evidence) : undefined,
  };
}

function priceText(p?: { value: number | string | null; currency?: string }): string {
  if (!p || p.value == null || p.value === '') return 'Price unknown';
  const n = typeof p.value === 'number' ? p.value : Number(p.value);
  if (!Number.isFinite(n)) return String(p.value);
  return !p.currency || p.currency === 'USD' ? `$${Number.isInteger(n) ? n : n.toFixed(2)}` : `${n} ${p.currency}`;
}

type RawRun = { id: string; kind: string; status: string; startedAt: string; finishedAt: string | null; unconnected?: string[]; report?: { sources?: ScoutRunInfo['sources'] } | null };

/** Latest Scout run from GET /intelligence/runs (report.sources counts how its cited sources re-checked). */
export function mapScoutRun(runs: RawRun[]): ScoutRunInfo | null {
  const r = runs.filter((x) => x.kind === 'scout').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!r) return null;
  return { id: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, sources: r.report?.sources ?? null, unconnected: r.unconnected ?? [] };
}

export function mapOpportunityBoard(b: C.OpportunityBoard): OpportunityBoard {
  return {
    state: b.state,
    runAt: b.runAt,
    scoutVersion: b.scoringModelVersion,
    note: b.note,
    opportunities: b.opportunities.map((o) => mapOpportunity(o, b.runAt)),
  };
}

/* ---------------------------------------------------------------- builds */

const STAGE_LABEL: Record<C.BuildStage, string> = {
  research: 'Research',
  blueprint: 'Blueprint',
  products: 'Products',
  brand: 'Brand',
  website: 'Website',
  integrations: 'Integrations',
  marketing: 'Marketing',
  testing: 'Testing',
  launch_readiness: 'Launch readiness',
};

export function mapBuild(b: C.Build, asOf: string | null): Build {
  const period = { start: b.createdAt, end: asOf ?? b.createdAt, label: 'Build to date' };
  const money = (cents: number | null, source: string): Metric => ({
    value: cents === null ? null : usdFromCents(cents),
    unit: 'usd',
    state: cents === null ? 'unknown' : 'verified',
    period,
    asOf: cents === null ? null : asOf,
    source,
  });
  return {
    id: b.id,
    nicheName: b.title,
    state: b.status === 'complete' ? 'complete' : b.status === 'cancelled' ? 'paused' : 'active',
    commissionedAt: b.createdAt,
    budget: money(b.budgetCents, 'Owner-approved build budget'),
    spent: money(b.spentCents, 'Job cost records'),
    blueprintVersion: b.blueprintRef,
    stages: b.stages.map((s, i): BuildStage => {
      // A PASS needs a reviewer on record; a "passed" stage with no evidence is shown as awaiting review.
      const reviewer = s.evidence[0]?.collectedBy ?? null;
      const unproven = s.status === 'passed' && !reviewer;
      return {
      id: s.stage,
      label: STAGE_LABEL[s.stage],
      status: s.status === 'running' ? 'in_progress' : unproven ? 'review' : s.status,
      dependsOn: i === 0 ? [] : [b.stages[i - 1].stage],
      outputs: s.evidence.map((e) => ({ label: e.claim, url: e.url ?? undefined, status: (e.label.toLowerCase() as BuildStatus) })),
      cost: money(s.costCents, 'Job cost records'),
      gate: {
        result: s.status === 'passed' && reviewer ? 'PASS' : s.status === 'failed' ? 'FAIL' : s.status === 'blocked' ? 'BLOCKED' : 'NOT RUN',
        reviewer,
      },
      blocker: s.status === 'blocked' ? s.notes ?? 'Blocked' : unproven ? 'Marked passed without gate evidence.' : undefined,
      };
    }),
  };
}

export const mapBuildBoard = (b: C.BuildBoard, asOf: string | null = null): BuildBoard => ({
  state: b.state,
  note: b.note,
  builds: b.builds.map((x) => mapBuild(x, asOf)),
});
