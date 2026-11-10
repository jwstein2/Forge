/**
 * FORGE Command view models.
 *
 * These are the shapes the UI renders. They mirror the platform API agreed with the
 * foundation thread (packages/contracts, base path /api/v1, camelCase JSON, ISO 8601 UTC).
 * When @forge/contracts is published, the API adapter maps its responses onto these types;
 * the screens never read raw API payloads.
 *
 * Honesty rules encoded in the types:
 *  - Every number is a Metric. A Metric with value null must say why (state).
 *  - Every Metric carries its reporting period and data freshness (asOf).
 *  - 'test_only' and 'sample' values are never summed into verified totals.
 */

export type NicheId = 'bidline' | 'quilt-plan-kit' | 'loaf-ledger' | (string & {});

/** Evidence state of a single number. */
export type MetricState =
  | 'verified' // read from an authoritative record (ledger row, platform receipt)
  | 'estimated' // modelled or third-party estimate; shown with a tilde and label
  | 'inferred' // model hypothesis (e.g. Scout scenarios); UI-only, mapped from Intelligence INFERRED
  | 'unknown' // a source exists but the value has not been established
  | 'unconnected' // no integration feeds this number yet
  | 'test_only' // only test-mode records exist; never counted as revenue
  | 'sample'; // illustrative design data; only ever shown under a SAMPLE banner

export type MetricUnit = 'usd' | 'count' | 'pct';

export interface Period {
  start: string; // ISO date or timestamp
  end: string;
  label: string; // human label, e.g. "Nov 1–10, 2026" or "Month to date"
}

export interface Metric {
  value: number | null; // dollars for 'usd' (API stores integer cents)
  unit: MetricUnit;
  state: MetricState;
  period: Period;
  asOf: string | null; // when the source was last read; null = never
  source: string; // human-readable source, e.g. "D1 sales ledger"
  evidenceUrl?: string;
  note?: string;
}

/** Implementation status labels from the FORGE constitution. */
export type BuildStatus = 'proposed' | 'built' | 'tested' | 'live' | 'failed' | 'unverified';

/** Operating health of a niche or integration. */
export type Health = 'healthy' | 'degraded' | 'blocked' | 'unknown';

/** Channel lifecycle, per the handoff: configured ≠ running ≠ verified. */
export type ChannelState = 'verified' | 'running' | 'configured' | 'failing' | 'not_connected';

export type Severity = 'critical' | 'serious' | 'warning' | 'info';

export interface FinancialStatement {
  period: Period;
  grossRevenue: Metric;
  refunds: Metric;
  paymentFees: Metric;
  productCosts: Metric;
  softwareAndHosting: Metric;
  aiUsage: Metric;
  marketingSpend: Metric;
  allocatedShared: Metric;
  /** Estimated contribution. state is 'unknown' if any cost line is unknown/unconnected. */
  contribution: Metric;
  orders: Metric;
  testOrders: Metric;
  /** Cost lines whose value is not established, listed so the gap is explicit. */
  missingLines: string[];
}

export interface TrendPoint {
  date: string; // ISO date
  value: number | null;
}

export interface TrendSeries {
  id: string;
  label: string;
  nicheId?: NicheId;
  unit: MetricUnit;
  state: MetricState;
  period: Period;
  asOf: string | null;
  source: string;
  points: TrendPoint[];
}

export interface Product {
  id: string;
  nicheId: NicheId;
  name: string;
  kind: 'free_resource' | 'paid_download' | 'book' | 'calculator' | 'affiliate';
  listedPrice: Metric | null; // price on the site
  storePrice: Metric | null; // price in the checkout platform
  status: BuildStatus;
  checkout: 'live' | 'test_mode' | 'not_configured' | 'not_applicable';
  fulfillment: 'verified' | 'test_verified' | 'unverified' | 'not_applicable';
  issue?: string;
  url?: string;
}

export interface Channel {
  id: string;
  nicheId: NicheId;
  platform: string; // "Pinterest", "Email (MailerLite)", "Search (SEO)"
  state: ChannelState;
  cadence: string | null;
  lastVerifiedAt: string | null;
  lastVerifiedUrl?: string;
  accountUrl?: string;
  owner: string | null;
  detail: string;
}

export interface Job {
  id: string; // e.g. N8N-02
  name: string;
  nicheId: NicheId | 'portfolio';
  runner: 'n8n' | 'cloudflare' | 'claude_scheduled' | 'github_actions' | 'forge' | 'manual';
  cadence: string;
  status: BuildStatus;
  paused: boolean;
  pausable: boolean; // only approved automation can be paused from Command
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastResult: 'success' | 'failure' | 'none';
  /** Heartbeat check: is last success within 2x cadence? null = no heartbeat ledger yet. */
  heartbeatOk: boolean | null;
  evidenceUrl?: string;
  defects: string[];
  monthlyRuns: Metric;
}

export interface Integration {
  id: string;
  name: string;
  nicheIds: NicheId[];
  health: Health;
  status: BuildStatus;
  detail: string;
  lastCheckedAt: string | null;
  consoleUrl?: string;
}

export interface Alert {
  id: string;
  severity: Severity;
  nicheId: NicheId | 'portfolio';
  title: string;
  detail: string;
  source: string;
  firstSeen: string;
  lastSeen: string;
  state: 'open' | 'acknowledged' | 'resolved';
  /** What happens next and who owns it. Command reports; it does not queue tasks for the owner. */
  nextAction: string;
  needsOwner: boolean;
}

export interface ActivityEvent {
  id: string;
  at: string;
  nicheId: NicheId | 'portfolio';
  actor: string; // job id or agent role
  summary: string;
  verified: boolean;
  evidenceUrl?: string;
}

export interface Niche {
  id: NicheId;
  name: string;
  tagline: string;
  audience: string;
  positioning: string;
  siteUrl: string;
  hosting: string;
  health: Health;
  healthReason: string;
  stage: string; // e.g. "Operating · pre-revenue"
  accent: string; // CSS colour token name for identity only
  financials: FinancialStatement;
  traffic: { pageViews: Metric; visitors: Metric; conversionRate: Metric };
  products: Product[];
  channels: Channel[];
  experiments: { id: string; title: string; status: BuildStatus; detail: string }[];
  briefVersion: string | null;
}

export interface PortfolioSummary {
  generatedAt: string;
  period: Period;
  financials: FinancialStatement;
  niches: Niche[];
  trends: TrendSeries[];
  activity: ActivityEvent[];
  alerts: Alert[];
  jobs: Job[];
  integrations: Integration[];
  budget: {
    ceiling: Metric;
    approvedEnvelopes: Metric;
    spentToDate: Metric;
    monthlyApiCap: Metric;
  };
}

/** Opportunity Intelligence. */
export type EvidenceLabel = 'verified' | 'estimated' | 'inferred' | 'unknown';

export interface EvidenceClaim {
  claim: string;
  label: EvidenceLabel;
  source?: string;
  accessed?: string;
}

export interface Opportunity {
  id: string;
  rank: number;
  name: string;
  recommended: boolean;
  segment: string;
  problem: string;
  hunch: string;
  score: { total: number; components: { label: string; value: number; weight: number }[] };
  confidence: 'low' | 'medium' | 'high';
  demand: EvidenceClaim[];
  competitors: { name: string; scope: 'national' | 'local'; offer: string; price: string }[];
  /** Competitor findings as evidence claims (Scout output) when no structured table exists. */
  competitorClaims?: EvidenceClaim[];
  demographics: EvidenceClaim[];
  productModel: string;
  offer: { price: string; monetization: string };
  /** months: 12 relative-interest values (null when no Trends data); windows: dated demand windows from the brief. */
  seasonality: {
    months: (number | null)[] | null;
    peak: string;
    launchBy: string;
    source: string;
    windows?: { event: string; demandWindow: string; publishBy: string; evidence: EvidenceLabel }[];
  };
  distribution: string[];
  economics: { downside: Metric; base: Metric; upside: Metric; launchCost: Metric; assumptions: string[] };
  risks: string[];
  gaps: string[];
  reuse: string[];
  complexity: 'low' | 'medium' | 'high';
  verdict: 'go' | 'hold' | 'no_go';
  verdictReason: string;
  /** Sources the Scout could not reach, and what each would add. */
  unconnected?: { name: string; wouldAdd: string }[];
}

export interface OpportunityBoard {
  state: 'ready' | 'not_run' | 'sample';
  runAt: string | null;
  scoutVersion: string | null;
  note: string;
  opportunities: Opportunity[];
}

/** Builder Workspace. */
export type BuildStageId =
  | 'research'
  | 'blueprint'
  | 'products'
  | 'brand'
  | 'website'
  | 'integrations'
  | 'marketing'
  | 'testing'
  | 'launch_readiness';

export interface BuildStage {
  id: BuildStageId;
  label: string;
  status: 'not_started' | 'in_progress' | 'blocked' | 'review' | 'passed' | 'failed';
  dependsOn: BuildStageId[];
  outputs: { label: string; url?: string; status: BuildStatus }[];
  cost: Metric;
  gate: { result: 'PASS' | 'FAIL' | 'NOT RUN' | 'BLOCKED'; reviewer: string | null; evidenceUrl?: string };
  blocker?: string;
}

export interface Build {
  id: string;
  nicheName: string;
  state: 'sample' | 'active' | 'paused' | 'complete';
  commissionedAt: string | null;
  budget: Metric;
  spent: Metric;
  blueprintVersion: string | null;
  stages: BuildStage[];
}

export interface BuildBoard {
  state: 'ready' | 'none' | 'sample';
  note: string;
  builds: Build[];
}

/** Account Directory. Never contains secrets. */
export interface Account {
  id: string;
  service: string;
  nicheIds: (NicheId | 'portfolio')[];
  identifier: string; // account handle, store name or instance; never a password
  status: 'active' | 'test_mode' | 'pending' | 'not_created' | 'unknown';
  owner: string;
  consoleUrl?: string;
  /** Link to the 1Password item (https://start.1password.com/open/i?… or onepassword://…). null = not linked yet. */
  passwordManagerRef: string | null;
  authMethod: 'oauth' | 'password' | 'api_token' | 'unknown';
  note?: string;
  sharedWith?: string; // other businesses on the same account (blast-radius note)
}

export interface CommandDataSource {
  readonly kind: 'fixtures' | 'api';
  getPortfolio(): Promise<PortfolioSummary>;
  getNiche(id: NicheId): Promise<Niche | null>;
  getOpportunities(opts?: { sample?: boolean }): Promise<OpportunityBoard>;
  getBuilds(opts?: { sample?: boolean }): Promise<BuildBoard>;
  getAccounts(): Promise<Account[]>;
  setJobPaused(id: string, paused: boolean): Promise<Job>;
}
