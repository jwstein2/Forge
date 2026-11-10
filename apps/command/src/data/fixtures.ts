/**
 * Fixture data for FORGE Command.
 *
 * Every value here is taken from the 2026-11-10 audit (/mnt/project-files/audit/final/)
 * and keeps that audit's evidence state. Nothing is invented: where the audit could not
 * establish a number, the Metric is 'unknown' or 'unconnected' with value null.
 * Replace with the platform API (src/data/apiSource.ts) once services/api is running.
 */
import type {
  Account,
  Alert,
  ActivityEvent,
  Channel,
  FinancialStatement,
  Integration,
  Job,
  Metric,
  MetricState,
  MetricUnit,
  Niche,
  Period,
  PortfolioSummary,
  Product,
  TrendSeries,
} from './types';

export const AUDIT_AS_OF = '2026-11-10T02:05:00Z';
const AUDIT_DOC = 'FORGE audit 2026-11-10';

export const MTD: Period = { start: '2026-11-01', end: '2026-11-10', label: 'Nov 1–10, 2026' };
const SINCE_LAUNCH: Period = { start: '2026-11-06', end: '2026-11-10', label: 'Nov 6–10, 2026' };
/** Page-view counters cover Nov 7–10 per the audit (WS1/WS3). */
const TRACKED: Period = { start: '2026-11-07', end: '2026-11-10', label: 'Nov 7–10, 2026' };
const LIFETIME: Period = { start: '2026-11-01', end: '2026-11-10', label: 'To date' };

export function metric(
  value: number | null,
  unit: MetricUnit,
  state: MetricState,
  source: string,
  opts: Partial<Pick<Metric, 'period' | 'asOf' | 'evidenceUrl' | 'note'>> = {},
): Metric {
  return {
    value,
    unit,
    state,
    source,
    period: opts.period ?? MTD,
    asOf: opts.asOf === undefined ? (state === 'unconnected' ? null : AUDIT_AS_OF) : opts.asOf,
    evidenceUrl: opts.evidenceUrl,
    note: opts.note,
  };
}

const usd = (v: number | null, s: MetricState, src: string, o?: Parameters<typeof metric>[4]) =>
  metric(v, 'usd', s, src, o);
const count = (v: number | null, s: MetricState, src: string, o?: Parameters<typeof metric>[4]) =>
  metric(v, 'count', s, src, o);

const D1 = 'D1 sales ledger (quiltplankit-sales)';
const D1_EVENTS = 'D1 events counters';

function statement(nicheTest: { orders: number; note: string } | null, shared: boolean): FinancialStatement {
  const missing = ['Software & hosting (n8n plan unknown)', 'AI usage (not yet metered per niche)'];
  return {
    period: MTD,
    grossRevenue: usd(0, 'verified', D1, { note: 'No live orders. Store is in test mode.' }),
    refunds: usd(0, 'verified', D1),
    paymentFees: usd(0, 'verified', 'Lemon Squeezy (derived from ledger)'),
    productCosts: usd(0, 'verified', 'Digital products; no unit cost'),
    softwareAndHosting: usd(null, 'unknown', 'n8n Cloud plan tier not recorded', {
      note: 'Cloudflare free tier is $0 (verified); n8n €20 or €50/mo, shared with other businesses.',
    }),
    aiUsage: usd(null, 'unknown', 'Agent usage not metered per niche yet'),
    marketingSpend: usd(0, 'verified', 'BUDGET_LEDGER.md'),
    allocatedShared: usd(null, shared ? 'unknown' : 'unconnected', 'Allocation rules not built (ledger v2)'),
    contribution: usd(null, 'unknown', 'Cannot compute while cost lines are unknown', {
      note: 'Revenue is $0; contribution is at most $0 and is negative by an unknown amount.',
    }),
    orders: count(0, 'verified', D1),
    testOrders: count(nicheTest?.orders ?? 0, 'test_only', D1, { note: nicheTest?.note }),
    missingLines: missing,
  };
}

const portfolioStatement: FinancialStatement = {
  ...statement({ orders: 2, note: 'QPK $8 order + refund, Bidline $19.99 order (all test mode, Nov 7).' }, true),
};

/* ---------------------------------------------------------------- channels */

const channels: Channel[] = [
  {
    id: 'qpk-pinterest',
    nicheId: 'quilt-plan-kit',
    platform: 'Pinterest',
    state: 'verified',
    cadence: '1 pin/day via RSS drip',
    lastVerifiedAt: '2026-11-10T00:10:00Z',
    accountUrl: 'https://www.pinterest.com/',
    owner: 'N8N-03 pin tracker',
    detail: '3 pins verified on the public profile. Queue ends Nov 12; 7 pins scheduled in total.',
  },
  {
    id: 'qpk-email',
    nicheId: 'quilt-plan-kit',
    platform: 'Email (MailerLite)',
    state: 'configured',
    cadence: null,
    lastVerifiedAt: null,
    owner: null,
    detail: 'Signup form is built on the site but not wired to MailerLite. Account approved by owner.',
  },
  {
    id: 'qpk-seo',
    nicheId: 'quilt-plan-kit',
    platform: 'Search (SEO)',
    state: 'configured',
    cadence: 'Biweekly review (first real run Nov 15)',
    lastVerifiedAt: null,
    owner: 'SCH-02 SEO review',
    detail: 'Search Console verified and sitemap submitted per docs; impressions and clicks not connected.',
  },
  {
    id: 'bid-seo',
    nicheId: 'bidline',
    platform: 'Search (SEO)',
    state: 'configured',
    cadence: null,
    lastVerifiedAt: null,
    owner: null,
    detail: 'Verification file present; Search Console status unverified.',
  },
  {
    id: 'bid-email',
    nicheId: 'bidline',
    platform: 'Email (MailerLite)',
    state: 'not_connected',
    cadence: null,
    lastVerifiedAt: null,
    owner: null,
    detail: 'No signup form.',
  },
  {
    id: 'bid-pinterest',
    nicheId: 'bidline',
    platform: 'Pinterest',
    state: 'not_connected',
    cadence: null,
    lastVerifiedAt: null,
    owner: null,
    detail: 'No account or feed.',
  },
  {
    id: 'loaf-seo',
    nicheId: 'loaf-ledger',
    platform: 'Search (SEO)',
    state: 'configured',
    cadence: null,
    lastVerifiedAt: null,
    owner: null,
    detail: 'Verification file present; no structured data; status unverified.',
  },
  {
    id: 'loaf-email',
    nicheId: 'loaf-ledger',
    platform: 'Email (MailerLite)',
    state: 'not_connected',
    cadence: null,
    lastVerifiedAt: null,
    owner: null,
    detail: 'No signup form.',
  },
  {
    id: 'loaf-pinterest',
    nicheId: 'loaf-ledger',
    platform: 'Pinterest',
    state: 'not_connected',
    cadence: null,
    lastVerifiedAt: null,
    owner: null,
    detail: 'No account or feed.',
  },
];

/* ---------------------------------------------------------------- products */

const products: Product[] = [
  {
    id: 'bid-kit',
    nicheId: 'bidline',
    name: 'Bidline Estimating Kit (.xlsx)',
    kind: 'paid_download',
    listedPrice: usd(19, 'verified', 'Site source (bidline/v2-production)', { period: LIFETIME }),
    storePrice: usd(19.99, 'test_only', 'Lemon Squeezy test product', { period: LIFETIME }),
    status: 'failed',
    checkout: 'test_mode',
    fulfillment: 'unverified',
    issue: 'The paid file is byte-identical to the free template, and the site and store prices differ ($19 vs $19.99).',
  },
  {
    id: 'bid-free',
    nicheId: 'bidline',
    name: 'Free estimating template + calculators',
    kind: 'free_resource',
    listedPrice: null,
    storePrice: null,
    status: 'live',
    checkout: 'not_applicable',
    fulfillment: 'not_applicable',
  },
  {
    id: 'qpk-planner',
    nicheId: 'quilt-plan-kit',
    name: 'Quilt Planner (PDF)',
    kind: 'paid_download',
    listedPrice: usd(8, 'verified', 'Site source', { period: LIFETIME }),
    storePrice: usd(8, 'test_only', 'Lemon Squeezy test order Nov 7', { period: LIFETIME }),
    status: 'tested',
    checkout: 'test_mode',
    fulfillment: 'test_verified',
    issue: 'Site shows "Available soon" until the store is activated.',
  },
  {
    id: 'qpk-calcs',
    nicheId: 'quilt-plan-kit',
    name: 'Fabric, border and precut calculators',
    kind: 'calculator',
    listedPrice: null,
    storePrice: null,
    status: 'live',
    checkout: 'not_applicable',
    fulfillment: 'not_applicable',
  },
  {
    id: 'qpk-kdp',
    nicheId: 'quilt-plan-kit',
    name: 'Quilting paperback (KDP)',
    kind: 'book',
    listedPrice: null,
    storePrice: null,
    status: 'unverified',
    checkout: 'not_applicable',
    fulfillment: 'unverified',
    issue: 'Paperback status and royalties not visible to FORGE.',
  },
  {
    id: 'loaf-sheet',
    nicheId: 'loaf-ledger',
    name: 'Baking spreadsheet (paid)',
    kind: 'paid_download',
    listedPrice: null,
    storePrice: null,
    status: 'unverified',
    checkout: 'not_configured',
    fulfillment: 'not_applicable',
    issue: 'Not found on the PC or Drive. May never have been built.',
  },
  {
    id: 'loaf-guides',
    nicheId: 'loaf-ledger',
    name: 'Baking guides and calculators',
    kind: 'free_resource',
    listedPrice: null,
    storePrice: null,
    status: 'live',
    checkout: 'not_applicable',
    fulfillment: 'not_applicable',
  },
];

/* ---------------------------------------------------------------- jobs */

export const jobs: Job[] = [
  {
    id: 'N8N-01',
    name: 'QPK sales log and daily report',
    nicheId: 'quilt-plan-kit',
    runner: 'n8n',
    cadence: 'Per order + daily 08:00 CT',
    status: 'live',
    paused: false,
    pausable: true,
    lastRunAt: '2026-11-09T14:00:00Z',
    lastSuccessAt: '2026-11-09T14:00:00Z',
    lastResult: 'success',
    heartbeatOk: null,
    defects: ['Bidline test sale counted in qpk_sales', 'Webhook unauthenticated', 'Daily email always sends'],
    monthlyRuns: count(null, 'unknown', 'n8n execution history', { period: SINCE_LAUNCH }),
  },
  {
    id: 'N8N-02',
    name: 'Site health check (3 sites, 12 endpoints)',
    nicheId: 'portfolio',
    runner: 'n8n',
    cadence: 'Every 3 h',
    status: 'live',
    paused: false,
    pausable: true,
    lastRunAt: '2026-11-10T00:07:00Z',
    lastSuccessAt: '2026-11-10T00:07:00Z',
    lastResult: 'success',
    heartbeatOk: null,
    defects: ['No heartbeat: a stopped scheduler would look healthy'],
    monthlyRuns: count(80, 'estimated', '8 runs/day × 10 days', { period: MTD }),
  },
  {
    id: 'N8N-03',
    name: 'Pinterest pin tracker',
    nicheId: 'quilt-plan-kit',
    runner: 'n8n',
    cadence: 'Every 6 h',
    status: 'live',
    paused: false,
    pausable: true,
    lastRunAt: '2026-11-10T00:10:00Z',
    lastSuccessAt: '2026-11-10T00:10:00Z',
    lastResult: 'success',
    heartbeatOk: null,
    defects: [],
    monthlyRuns: count(40, 'estimated', '4 runs/day × 10 days'),
  },
  {
    id: 'N8N-04',
    name: 'Lemon Squeezy status watch',
    nicheId: 'portfolio',
    runner: 'n8n',
    cadence: 'Every 30 min',
    status: 'live',
    paused: false,
    pausable: true,
    lastRunAt: '2026-11-10T01:41:00Z',
    lastSuccessAt: '2026-11-10T01:41:00Z',
    lastResult: 'success',
    heartbeatOk: null,
    defects: ['Obsolete; ~69% of instance executions', 'Reads the whole mailbox'],
    monthlyRuns: count(480, 'estimated', '48 runs/day × 10 days'),
  },
  {
    id: 'N8N-05',
    name: 'Monthly brand and UX audit',
    nicheId: 'portfolio',
    runner: 'n8n',
    cadence: '1st of month 14:17 UTC',
    status: 'tested',
    paused: false,
    pausable: true,
    lastRunAt: '2026-11-07T15:00:00Z',
    lastSuccessAt: '2026-11-07T15:00:00Z',
    lastResult: 'success',
    heartbeatOk: null,
    defects: ['Covers Quilt Plan Kit only', 'First scheduled run Dec 1'],
    monthlyRuns: count(1, 'verified', 'Manual run Nov 7'),
  },
  {
    id: 'CF-01',
    name: 'Pinterest RSS drip',
    nicheId: 'quilt-plan-kit',
    runner: 'cloudflare',
    cadence: '1 pin/day',
    status: 'live',
    paused: false,
    pausable: false,
    lastRunAt: '2026-11-10T00:00:00Z',
    lastSuccessAt: '2026-11-10T00:00:00Z',
    lastResult: 'success',
    heartbeatOk: null,
    defects: ['Content runs out Nov 12'],
    monthlyRuns: count(null, 'unknown', 'Pinterest pulls the feed'),
  },
  {
    id: 'CF-02',
    name: 'Sales webhook Worker',
    nicheId: 'portfolio',
    runner: 'cloudflare',
    cadence: 'Per checkout event',
    status: 'live',
    paused: false,
    pausable: false,
    lastRunAt: '2026-11-07T18:00:00Z',
    lastSuccessAt: '2026-11-07T18:00:00Z',
    lastResult: 'success',
    heartbeatOk: null,
    defects: ['Forwarding errors swallowed'],
    monthlyRuns: count(3, 'test_only', D1),
  },
  {
    id: 'SCH-01',
    name: 'Portfolio daily sweep',
    nicheId: 'portfolio',
    runner: 'claude_scheduled',
    cadence: 'Daily 09:17 UTC',
    status: 'live',
    paused: false,
    pausable: false,
    lastRunAt: '2026-11-09T09:17:00Z',
    lastSuccessAt: '2026-11-09T09:17:00Z',
    lastResult: 'success',
    heartbeatOk: null,
    defects: ['Runs in the earlier project; state not readable from FORGE'],
    monthlyRuns: count(10, 'estimated', 'Daily × 10 days'),
  },
  {
    id: 'SCH-02',
    name: 'SEO biweekly review',
    nicheId: 'portfolio',
    runner: 'claude_scheduled',
    cadence: '1st and 15th, 14:17 UTC',
    status: 'tested',
    paused: false,
    pausable: false,
    lastRunAt: '2026-11-07T14:17:00Z',
    lastSuccessAt: '2026-11-07T14:17:00Z',
    lastResult: 'success',
    heartbeatOk: null,
    defects: ['First real run Nov 15'],
    monthlyRuns: count(1, 'verified', 'Test fire Nov 7'),
  },
  {
    id: 'SCH-04',
    name: 'Desktop weekly research',
    nicheId: 'portfolio',
    runner: 'claude_scheduled',
    cadence: 'Weekly',
    status: 'failed',
    paused: false,
    pausable: false,
    lastRunAt: '2026-11-07T12:00:00Z',
    lastSuccessAt: null,
    lastResult: 'failure',
    heartbeatOk: false,
    defects: ['Denied by the desktop permission classifier'],
    monthlyRuns: count(0, 'verified', 'Desktop app'),
  },
];

/* ---------------------------------------------------------------- alerts */

export const alerts: Alert[] = [
  {
    id: 'AL-001',
    severity: 'critical',
    nicheId: 'bidline',
    title: 'Paid kit is identical to the free template',
    detail: 'Downloads\\06 Bidline\\Bidline-Estimating-Kit.xlsx is byte-identical to the free file. Checkout must stay off until the real kit is built.',
    source: 'WS3 commercial audit',
    firstSeen: '2026-11-10T01:50:00Z',
    lastSeen: AUDIT_AS_OF,
    state: 'open',
    nextAction: 'Product thread is building the real workbook.',
    needsOwner: false,
  },
  {
    id: 'AL-002',
    severity: 'serious',
    nicheId: 'portfolio',
    title: 'Lemon Squeezy store not activated',
    detail: 'No site can take payment. Activation needs the owner’s identity verification.',
    source: 'D1 ledger + site checkout state',
    firstSeen: '2026-11-07T00:00:00Z',
    lastSeen: AUDIT_AS_OF,
    state: 'open',
    nextAction: 'Owner completes store activation in Lemon Squeezy.',
    needsOwner: true,
  },
  {
    id: 'AL-003',
    severity: 'serious',
    nicheId: 'quilt-plan-kit',
    title: 'Only live channel runs out of pins on Nov 12',
    detail: 'The Pinterest RSS drip has 7 pins in total. After Nov 12 nothing new publishes.',
    source: 'CF-01 pins.json',
    firstSeen: '2026-11-10T01:55:00Z',
    lastSeen: AUDIT_AS_OF,
    state: 'open',
    nextAction: 'Milestone thread refills the queue.',
    needsOwner: false,
  },
  {
    id: 'AL-004',
    severity: 'serious',
    nicheId: 'portfolio',
    title: 'Sale webhook into n8n is unauthenticated',
    detail: 'Anyone with the URL could inject a fake sale into qpk_sales, which the daily report reads.',
    source: 'Security review',
    firstSeen: '2026-11-10T01:58:00Z',
    lastSeen: AUDIT_AS_OF,
    state: 'open',
    nextAction: 'Add a shared-secret header, then read reports from D1 only.',
    needsOwner: false,
  },
  {
    id: 'AL-005',
    severity: 'warning',
    nicheId: 'bidline',
    title: 'Site and store prices disagree',
    detail: 'Site lists $19; the Lemon Squeezy product is $19.99.',
    source: 'WS3 commercial audit',
    firstSeen: '2026-11-10T01:50:00Z',
    lastSeen: AUDIT_AS_OF,
    state: 'open',
    nextAction: 'Owner picks one price; product thread aligns both.',
    needsOwner: true,
  },
  {
    id: 'AL-006',
    severity: 'warning',
    nicheId: 'portfolio',
    title: 'No job heartbeat ledger',
    detail: 'A scheduler that stops silently looks identical to a healthy one.',
    source: 'Orchestration audit (D3)',
    firstSeen: '2026-11-10T01:55:00Z',
    lastSeen: AUDIT_AS_OF,
    state: 'open',
    nextAction: 'Platform thread builds jobs and job_runs tables.',
    needsOwner: false,
  },
  {
    id: 'AL-007',
    severity: 'info',
    nicheId: 'portfolio',
    title: 'Obsolete mailbox watch uses most n8n executions',
    detail: 'N8N-04 polls Gmail every 30 minutes for a Lemon Squeezy email that never arrived.',
    source: 'Orchestration audit (D4)',
    firstSeen: '2026-11-10T01:55:00Z',
    lastSeen: AUDIT_AS_OF,
    state: 'open',
    nextAction: 'Retire after store activation.',
    needsOwner: false,
  },
];

/* ---------------------------------------------------------------- activity */

const activity: ActivityEvent[] = [
  { id: 'ac1', at: '2026-11-10T01:41:00Z', nicheId: 'portfolio', actor: 'N8N-04', summary: 'Checked mailbox for store activation email; none found.', verified: true },
  { id: 'ac2', at: '2026-11-10T00:10:00Z', nicheId: 'quilt-plan-kit', actor: 'N8N-03', summary: 'Recorded 3 published pins on the public Pinterest profile.', verified: true },
  { id: 'ac3', at: '2026-11-10T00:07:00Z', nicheId: 'portfolio', actor: 'N8N-02', summary: 'Health check passed on 12 endpoints across 3 sites.', verified: true },
  { id: 'ac4', at: '2026-11-09T21:26:00Z', nicheId: 'portfolio', actor: 'Portfolio director', summary: 'Deployed sales webhook Worker.', verified: true },
  { id: 'ac5', at: '2026-11-09T14:00:00Z', nicheId: 'quilt-plan-kit', actor: 'N8N-01', summary: 'Sent daily sales report (0 live orders).', verified: true },
  { id: 'ac6', at: '2026-11-09T09:17:00Z', nicheId: 'portfolio', actor: 'SCH-01', summary: 'Daily sweep woke the Quilt Plan Kit operator.', verified: false },
];

/* ---------------------------------------------------------------- integrations */

const integrations: Integration[] = [
  { id: 'cf-pages', name: 'Cloudflare Pages', nicheIds: ['bidline', 'quilt-plan-kit', 'loaf-ledger'], health: 'healthy', status: 'live', detail: '3 projects on *.pages.dev; deploys by hand from the PC.', lastCheckedAt: '2026-11-10T00:07:00Z', consoleUrl: 'https://dash.cloudflare.com/' },
  { id: 'cf-worker', name: 'Sales Worker + D1 ledger', nicheIds: ['bidline', 'quilt-plan-kit', 'loaf-ledger'], health: 'degraded', status: 'live', detail: 'HMAC-verified and idempotent. Public /stats endpoint; forward errors swallowed.', lastCheckedAt: '2026-11-10T01:30:00Z', consoleUrl: 'https://dash.cloudflare.com/' },
  { id: 'ls', name: 'Lemon Squeezy', nicheIds: ['bidline', 'quilt-plan-kit', 'loaf-ledger'], health: 'blocked', status: 'tested', detail: 'Test mode only. Store activation pending.', lastCheckedAt: AUDIT_AS_OF, consoleUrl: 'https://app.lemonsqueezy.com/' },
  { id: 'n8n', name: 'n8n Cloud', nicheIds: ['bidline', 'quilt-plan-kit', 'loaf-ledger'], health: 'degraded', status: 'live', detail: 'Running, but shared with Sandbox Coffee and Z3D on one account and one set of credentials.', lastCheckedAt: '2026-11-10T01:41:00Z', consoleUrl: 'https://app.n8n.cloud/' },
  { id: 'mailerlite', name: 'MailerLite', nicheIds: ['quilt-plan-kit'], health: 'unknown', status: 'proposed', detail: 'Account approved by owner; not wired to any site; no connector.', lastCheckedAt: null, consoleUrl: 'https://dashboard.mailerlite.com/' },
  { id: 'gsc', name: 'Google Search Console', nicheIds: ['bidline', 'quilt-plan-kit', 'loaf-ledger'], health: 'unknown', status: 'unverified', detail: 'Verification files on all sites; no read access for FORGE.', lastCheckedAt: null, consoleUrl: 'https://search.google.com/search-console' },
  { id: 'kdp', name: 'Amazon KDP', nicheIds: ['quilt-plan-kit'], health: 'unknown', status: 'unverified', detail: 'Owner-only; status and royalties not visible.', lastCheckedAt: null, consoleUrl: 'https://kdp.amazon.com/' },
];

/* ---------------------------------------------------------------- niches */

function traffic(pageViews: number | null, state: MetricState) {
  return {
    pageViews: count(pageViews, state, state === 'unconnected' ? 'No beacon on the site' : D1_EVENTS, {
      period: TRACKED,
      note: state === 'verified' ? 'Excludes 118 QA views identified by naming convention.' : undefined,
    }),
    visitors: count(null, 'unconnected', 'Cloudflare Web Analytics not connected', { period: TRACKED }),
    conversionRate: metric(null, 'pct', 'unknown', 'Needs live orders and visitor counts', { period: TRACKED }),
  };
}

export const niches: Niche[] = [
  {
    id: 'quilt-plan-kit',
    name: 'Quilt Plan Kit',
    tagline: 'Quilting calculators, guides and planners',
    audience: 'Home quilters planning a project, from beginners to experienced makers.',
    positioning: 'Accurate free calculators that earn trust, with a low-cost planner as the first paid step.',
    siteUrl: 'https://quiltplankit.pages.dev/',
    hosting: 'Cloudflare Pages',
    health: 'degraded',
    healthReason: 'Site healthy; checkout waiting on store activation; email not wired.',
    stage: 'Operating · pre-revenue',
    accent: '--niche-qpk',
    financials: statement({ orders: 1, note: '$8 order and refund, Nov 7, test mode.' }, true),
    traffic: traffic(35, 'verified'),
    products: products.filter((p) => p.nicheId === 'quilt-plan-kit'),
    channels: channels.filter((c) => c.nicheId === 'quilt-plan-kit'),
    experiments: [
      { id: 'qpk-redesign', title: 'Site redesign (staging-v2)', status: 'built', detail: 'Built locally, not deployed. Hero photo licence must be resolved first.' },
    ],
    briefVersion: null,
  },
  {
    id: 'bidline',
    name: 'Bidline',
    tagline: 'Estimating tools for contractors',
    audience: 'Small contractors and tradespeople who price jobs by hand.',
    positioning: 'Free estimating calculators with a professional spreadsheet kit as the paid upgrade.',
    siteUrl: 'https://bidline.pages.dev/',
    hosting: 'Cloudflare Pages',
    health: 'blocked',
    healthReason: 'Paid product is not built; prices disagree; no live channel.',
    stage: 'Operating · product blocked',
    accent: '--niche-bid',
    financials: statement({ orders: 1, note: '$19.99 order, Nov 7, test mode.' }, true),
    traffic: traffic(2, 'verified'),
    products: products.filter((p) => p.nicheId === 'bidline'),
    channels: channels.filter((c) => c.nicheId === 'bidline'),
    experiments: [],
    briefVersion: null,
  },
  {
    id: 'loaf-ledger',
    name: 'Loaf Ledger',
    tagline: 'Baking calculators and guides',
    audience: 'Home bakers who want reliable ratios, schedules and costings.',
    positioning: 'Friendly baking guides; a premium spreadsheet is planned but not found.',
    siteUrl: 'https://loaf-ledger.pages.dev/',
    hosting: 'Cloudflare Pages',
    health: 'degraded',
    healthReason: 'Site up; no beacon, no paid product, legal pages incomplete.',
    stage: 'Operating · no paid offer',
    accent: '--niche-loaf',
    financials: statement(null, true),
    traffic: traffic(null, 'unconnected'),
    products: products.filter((p) => p.nicheId === 'loaf-ledger'),
    channels: channels.filter((c) => c.nicheId === 'loaf-ledger'),
    experiments: [],
    briefVersion: null,
  },
];

/* ---------------------------------------------------------------- trends */

const days = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'];

export const trends: TrendSeries[] = [
  {
    id: 'revenue',
    label: 'Verified revenue',
    unit: 'usd',
    state: 'verified',
    period: { start: days[0], end: days[6], label: 'Last 7 days' },
    asOf: AUDIT_AS_OF,
    source: D1,
    points: days.map((d) => ({ date: d, value: 0 })),
  },
  {
    id: 'views-qpk',
    label: 'Quilt Plan Kit',
    nicheId: 'quilt-plan-kit',
    unit: 'count',
    state: 'verified',
    period: { start: days[0], end: days[6], label: 'Last 7 days' },
    asOf: AUDIT_AS_OF,
    source: D1_EVENTS,
    // The audit has only the Nov 6–10 total (~35). The daily split is not invented: points stay null
    // until the platform API returns daily rows from D1 events.
    points: days.map((d) => ({ date: d, value: null })),
  },
  {
    id: 'views-bid',
    label: 'Bidline',
    nicheId: 'bidline',
    unit: 'count',
    state: 'verified',
    period: { start: days[0], end: days[6], label: 'Last 7 days' },
    asOf: AUDIT_AS_OF,
    source: D1_EVENTS,
    points: days.map((d) => ({ date: d, value: null })),
  },
  {
    id: 'views-loaf',
    label: 'Loaf Ledger',
    nicheId: 'loaf-ledger',
    unit: 'count',
    state: 'unconnected',
    period: { start: days[0], end: days[6], label: 'Last 7 days' },
    asOf: null,
    source: 'No beacon on site',
    points: days.map((d) => ({ date: d, value: null })),
  },
];

/* ---------------------------------------------------------------- portfolio */

export const portfolio: PortfolioSummary = {
  generatedAt: AUDIT_AS_OF,
  period: MTD,
  financials: portfolioStatement,
  niches,
  trends,
  activity,
  alerts,
  jobs,
  integrations,
  budget: {
    ceiling: usd(1500, 'verified', 'BUDGET_LEDGER.md (cumulative)', { period: LIFETIME }),
    approvedEnvelopes: usd(106, 'verified', 'BUDGET_LEDGER.md: domain, KDP proofs, ads, API', { period: LIFETIME }),
    spentToDate: usd(0, 'verified', 'BUDGET_LEDGER.md (not reconciled to bank)', { period: LIFETIME }),
    monthlyApiCap: usd(15, 'verified', 'Envelope E4', { period: MTD }),
  },
};

/* ---------------------------------------------------------------- accounts */

export const accounts: Account[] = [
  { id: 'acc-cf', service: 'Cloudflare', nicheIds: ['portfolio'], identifier: 'Account with 3 Pages projects + Worker quiltplankit-sales', status: 'active', owner: 'James', consoleUrl: 'https://dash.cloudflare.com/', passwordManagerRef: null, authMethod: 'password', note: 'Deploys use a wrangler login on AuroraPC; a scoped API token is planned.' },
  { id: 'acc-ls', service: 'Lemon Squeezy', nicheIds: ['bidline', 'quilt-plan-kit', 'loaf-ledger'], identifier: '3 stores (QPK, Bidline, Loaf Ledger)', status: 'test_mode', owner: 'James', consoleUrl: 'https://app.lemonsqueezy.com/', passwordManagerRef: null, authMethod: 'password', note: 'Activation requires owner identity verification.' },
  { id: 'acc-n8n', service: 'n8n Cloud', nicheIds: ['portfolio'], identifier: 'james1854.app.n8n.cloud', status: 'active', owner: 'James', consoleUrl: 'https://james1854.app.n8n.cloud/', passwordManagerRef: null, authMethod: 'password', sharedWith: 'Sandbox Coffee Co., Z3D', note: 'Plan tier unknown.' },
  { id: 'acc-ml', service: 'MailerLite', nicheIds: ['quilt-plan-kit'], identifier: 'Account created (owner)', status: 'active', owner: 'James', consoleUrl: 'https://dashboard.mailerlite.com/', passwordManagerRef: null, authMethod: 'unknown', note: 'No site wired yet.' },
  { id: 'acc-pin', service: 'Pinterest', nicheIds: ['quilt-plan-kit'], identifier: 'Quilt Plan Kit profile', status: 'active', owner: 'James', consoleUrl: 'https://www.pinterest.com/', passwordManagerRef: null, authMethod: 'password' },
  { id: 'acc-gsc', service: 'Google Search Console', nicheIds: ['bidline', 'quilt-plan-kit', 'loaf-ledger'], identifier: '3 properties (*.pages.dev)', status: 'unknown', owner: 'James', consoleUrl: 'https://search.google.com/search-console', passwordManagerRef: null, authMethod: 'oauth' },
  { id: 'acc-kdp', service: 'Amazon KDP', nicheIds: ['quilt-plan-kit'], identifier: 'Owner account', status: 'unknown', owner: 'James', consoleUrl: 'https://kdp.amazon.com/', passwordManagerRef: null, authMethod: 'password' },
  { id: 'acc-gh', service: 'GitHub', nicheIds: ['portfolio'], identifier: 'jwstein2', status: 'active', owner: 'James', consoleUrl: 'https://github.com/jwstein2', passwordManagerRef: null, authMethod: 'oauth', note: 'No FORGE repository yet.' },
  { id: 'acc-anthropic', service: 'Anthropic API', nicheIds: ['portfolio'], identifier: 'Key stored in n8n credentials', status: 'active', owner: 'James', consoleUrl: 'https://console.anthropic.com/', passwordManagerRef: null, authMethod: 'api_token', sharedWith: 'Sandbox Coffee Co., Z3D', note: 'Cap $15/month (E4).' },
  { id: 'acc-domain', service: 'Domain registrar', nicheIds: ['portfolio'], identifier: 'None purchased', status: 'not_created', owner: 'James', passwordManagerRef: null, authMethod: 'unknown', note: '$11 envelope approved, unspent.' },
];

export { AUDIT_DOC };
