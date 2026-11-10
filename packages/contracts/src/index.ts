/**
 * @forge/contracts — the shared API contract between the FORGE API (services/api)
 * and FORGE Command (apps/command). Version: see API_VERSION.
 *
 * Rules every consumer can rely on:
 *  - No number is ever invented. A value the platform cannot prove is `null` with
 *    state 'unknown' or 'unconnected'.
 *  - Every Metric carries its reporting period, data freshness (asOf) and source.
 *  - Test-mode money is never counted as revenue; it is reported separately as 'test_only'.
 *  - Timestamps are ISO 8601 UTC strings. Storage money is integer cents; Metric.value
 *    for unit 'usd' is dollars (cents / 100).
 */
export const API_VERSION = "1.3.0" as const;

export type NicheId = string; // 'bidline' | 'quilt-plan-kit' | 'loaf-ledger' | future kebab-case slugs
export type IsoTimestamp = string;

/** Implementation status (constitution §4). */
export type ImplStatus = "PROPOSED" | "BUILT" | "TESTED" | "LIVE" | "FAILED" | "UNVERIFIED";
/** Market / financial evidence label (constitution §4). */
export type EvidenceLabel = "VERIFIED" | "ESTIMATED" | "INFERRED" | "UNKNOWN";
/** QA gate result (constitution §12). */
export type GateResult = "PASS" | "FAIL" | "NOT_RUN" | "BLOCKED";

// ---------- Metric (shape agreed with the Command workstream) ----------
export type MetricState = "verified" | "estimated" | "unknown" | "unconnected" | "test_only";
export interface Period { start: IsoTimestamp; end: IsoTimestamp; label: string }
export interface Metric {
  value: number | null;
  unit: "usd" | "count" | "pct";
  state: MetricState;
  period: Period;
  asOf: IsoTimestamp | null;
  source: string;
  evidenceUrl?: string;
  note?: string;
}

// ---------- Envelope ----------
export interface ApiOk<T> { ok: true; data: T; meta: ResponseMeta }
export interface ApiErr { ok: false; error: { code: ErrorCode; message: string; details?: unknown } }
export type ApiResponse<T> = ApiOk<T> | ApiErr;
export type ErrorCode =
  | "unauthorized" | "forbidden" | "not_found" | "bad_request" | "conflict"
  | "evidence_required" | "system_paused" | "internal";
export interface ResponseMeta {
  apiVersion: string;
  environment: "development" | "staging" | "production" | "test";
  generatedAt: IsoTimestamp;
  /** Every data source that fed this response and how fresh it is. */
  sources: SourceFreshness[];
}
export interface SourceFreshness {
  id: string;            // e.g. 'ledger.d1', 'n8n', 'lemonsqueezy'
  label: string;
  mode: "live" | "snapshot" | "seed" | "unconnected";
  asOf: IsoTimestamp | null;
  note?: string;
}

// ---------- Niches / portfolio ----------
export type NicheLifecycle = "proposed" | "building" | "live" | "paused" | "retired";
export type Health = "healthy" | "degraded" | "blocked" | "unknown";
export interface NicheSummary {
  id: NicheId;
  name: string;
  tagline: string | null;
  lifecycle: NicheLifecycle;
  health: Health;
  healthReasons: string[];
  siteUrl: string | null;
  canTakePayment: boolean;
  revenue: Metric;          // verified gross sales, excludes test mode
  orders: Metric;
  testOrders: Metric;       // state 'test_only'
  contribution: Metric;     // estimated, never 'verified' while costs are unknown
  pageViews: Metric;
  activeVerifiedChannels: Metric;
  openAlerts: number;
}
export interface PortfolioSummary {
  period: Period;
  niches: NicheSummary[];
  totals: {
    revenue: Metric; refunds: Metric; paymentFees: Metric; knownCosts: Metric;
    contribution: Metric; orders: Metric; testOrders: Metric; pageViews: Metric;
    activeVerifiedChannels: Metric;
  };
  financials: FinancialBreakdown;
  budget: { ceiling: Metric; approvedEnvelopes: Metric; spentToDate: Metric; monthlyApiCap: Metric };
  openAlerts: { critical: number; warning: number; info: number };
  recentActivity: ActivityItem[];
  unknowns: string[];       // plain-language list of what the platform cannot see yet
}
export interface ActivityItem {
  at: IsoTimestamp;
  nicheId: NicheId | null;
  kind: "job_run" | "sale" | "alert" | "status_change" | "approval" | "gate";
  title: string;
  status: string;
  evidenceUrl?: string;
}

export interface Product {
  id: string;
  nicheId: NicheId;
  name: string;
  kind: "spreadsheet" | "pdf" | "calculator" | "guide" | "book" | "template" | "software" | "other";
  tier: "free" | "paid";
  sitePriceCents: number | null;
  checkoutPriceCents: number | null;
  priceMismatch: boolean;
  status: ImplStatus;
  checkoutStatus: "none" | "test_mode" | "live" | "unknown";
  deliveryStatus: "verified" | "unverified" | "failed" | "n/a";
  notes: string | null;
  evidence: EvidenceRef[];
}

export type ChannelStatus = "configured" | "running" | "verified" | "failing" | "unconnected";
export interface Channel {
  id: string;
  nicheId: NicheId;
  platform: string;               // 'pinterest' | 'email' | 'seo' | 'instagram' ...
  status: ChannelStatus;
  cadence: string | null;
  accountUrl: string | null;
  lastVerifiedAt: IsoTimestamp | null;
  lastVerifiedUrl: string | null;
  jobId: string | null;
  notes: string | null;
}

export interface FinancialBreakdown {
  nicheId: NicheId | "portfolio";
  period: Period;
  grossSales: Metric;
  refunds: Metric;
  discounts: Metric;
  paymentFees: Metric;
  productCosts: Metric;
  hostingAndSoftware: Metric;
  aiUsage: Metric;
  marketingSpend: Metric;
  allocatedShared: Metric;
  /** value null + state 'unknown' whenever any cost line is unknown/unconnected. */
  contribution: Metric;
  /** Gross minus only the cost lines that ARE known. Always state 'estimated'; never a profit claim. */
  contributionKnownLinesOnly: Metric;
  cashCollected: Metric;
  orders: Metric;
  testOrders: Metric;
  testModeGross: Metric;
  /** Cost lines whose value is not established, named so the gap is explicit. */
  missingLines: string[];
}

export interface NicheDetail extends NicheSummary {
  positioning: string | null;
  products: Product[];
  channels: Channel[];
  jobs: RegistryEntry[];
  integrations: Integration[];
  costs: CostItem[];
  alerts: Alert[];
  financials: FinancialBreakdown;
  funnel: FunnelRow[];
  evidence: EvidenceRef[];
}
export interface FunnelRow { event: string; count: number; state: MetricState; period: Period; source: string }

// ---------- Registry: agents, workflows, scheduled jobs ----------
export type RegistryKind = "agent" | "workflow" | "scheduled_task" | "worker" | "skill" | "manual_tool";
export type Runner = "n8n" | "claude" | "cloudflare" | "github_actions" | "forge" | "manual";
export interface RegistryEntry {
  id: string;                 // e.g. 'N8N-02', 'AG-03', 'CF-02'
  kind: RegistryKind;
  name: string;
  nicheId: NicheId | null;    // null = shared/portfolio
  department: string | null;
  owner: string | null;
  runner: Runner;
  externalRef: string | null; // n8n workflow id, scheduled task id ...
  trigger: string | null;
  cadence: string | null;     // human-readable
  intervalMinutes: number | null; // for heartbeat watchdog
  model: string | null;
  costCapCents: number | null;
  retryBudget: number | null;
  status: ImplStatus;
  paused: boolean;
  lastRun: RunSummary | null;
  lastSuccess: RunSummary | null;
  heartbeat: "ok" | "late" | "stale" | "never_observed" | "not_scheduled" | "paused"; // stale (1.2.0): judged from a snapshot older than 2x the interval, so current health is unknown
  /** Only approved automation with a FORGE-controlled kill switch can be paused from Command. */
  pausable: boolean;
  runsLast30d: Metric;
  defects: string[];
  notes: string | null;
}
export interface RunSummary {
  id: string;
  registryId: string;
  startedAt: IsoTimestamp;
  finishedAt: IsoTimestamp | null;
  status: "success" | "failed" | "running" | "timeout" | "skipped";
  evidenceUrl: string | null;
  modelCostCents: number | null;
  error: string | null;
  source: string;              // 'n8n.snapshot', 'n8n.live', 'heartbeat', ...
}

// ---------- Integrations & accounts ----------
export type IntegrationStatus = "connected" | "unconnected" | "degraded" | "failed" | "unknown";
export interface Integration {
  id: string;
  service: string;
  nicheId: NicheId | null;
  purpose: string;
  status: IntegrationStatus;
  accessMode: "read_only" | "test" | "write" | "none";
  lastCheckedAt: IsoTimestamp | null;
  lastOkAt: IsoTimestamp | null;
  detail: string | null;
  blocker: string | null;      // what must happen to connect it (owner action, approval)
}
export interface Account {
  id: string;
  service: string;
  nicheId: NicheId | null;
  identifier: string | null;   // safe display identifier only (store name, handle). Never a password.
  status: "active" | "pending" | "test_mode" | "unknown" | "not_created";
  url: string | null;
  passwordManagerRef: string | null; // e.g. 'bitwarden://item/<id>' — a link, never the secret
  owner: string;
  notes: string | null;
}

// ---------- Alerts ----------
export type Severity = "critical" | "warning" | "info";
export interface Alert {
  id: string;
  severity: Severity;
  nicheId: NicheId | null;
  source: string;
  title: string;
  detail: string | null;
  state: "open" | "acknowledged" | "resolved";
  firstSeen: IsoTimestamp;
  lastSeen: IsoTimestamp;
  nextAction: string | null;
  /** True only when resolving it needs an owner decision (spend, account, launch, pricing). */
  needsOwner: boolean;
  evidenceUrl: string | null;
}

// ---------- Costs & budgets ----------
export interface CostItem {
  id: string;
  nicheId: NicheId | null;     // null = shared
  vendor: string;
  item: string;
  amountCents: number | null;  // null = unknown
  cadence: "monthly" | "annual" | "one_time" | "usage";
  evidence: EvidenceLabel;
  allocationRule: string | null;
  notes: string | null;
}
export interface Budget {
  id: string;
  scope: string;
  ceilingCents: number;
  approvedCents: number;
  spentCents: number;
  evidence: EvidenceLabel;
  notes: string | null;
}

// ---------- Evidence & status ----------
export interface EvidenceRef {
  id: string;
  subjectType: string;
  subjectId: string;
  claim: string;
  label: ImplStatus | EvidenceLabel;
  source: string;
  url: string | null;
  observedAt: IsoTimestamp;
  collectedBy: string;
}

// ---------- Approvals ----------
export interface Approval {
  id: string;
  scope: string;
  action: string;
  status: "pending" | "approved" | "denied" | "expired";
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: IsoTimestamp | null;
  boundary: Record<string, unknown> | null;
  sourceRef: string | null;
  expiresAt: IsoTimestamp | null;
}

// ---------- Intelligence (content schemas owned by the Intelligence workstream) ----------
// Field-level content is defined by JSON Schemas in packages/contracts/schemas/intelligence/
// (brief.schema.json, scoring-model.schema.json, opportunity.schema.json). The API stores
// whole documents and exposes these envelopes.
export interface MarketBriefEnvelope {
  id: string; nicheId: NicheId; version: string; schemaVersion: string;
  status: "draft" | "approved" | "superseded"; contentHash: string;
  createdAt: IsoTimestamp; approvedBy: string | null; content: unknown;
}
export interface OpportunityEnvelope {
  id: string; opportunityKey: string; title: string; score: number | null; rank: number | null;
  recommended: boolean; scoringModelVersion: string | null; briefRef: string | null;
  runId: string | null; status: "candidate" | "recommended" | "selected" | "rejected" | "archived";
  content: unknown;
}
export interface OpportunityBoard {
  state: "ready" | "not_run"; runAt: IsoTimestamp | null; scoringModelVersion: string | null;
  note: string; opportunities: OpportunityEnvelope[];
}
export interface ResearchRun {
  id: string; kind: string; startedAt: IsoTimestamp; finishedAt: IsoTimestamp | null;
  status: "running" | "succeeded" | "failed" | "partial"; sourcesUnconnected: string[];
}

// ---------- Builder ----------
export const BUILD_STAGES = [
  "research", "blueprint", "products", "brand", "website",
  "integrations", "marketing", "testing", "launch_readiness",
] as const;
export type BuildStage = (typeof BUILD_STAGES)[number];
export interface Build {
  id: string; nicheId: NicheId | null; opportunityId: string | null; title: string;
  status: "draft" | "running" | "blocked" | "awaiting_approval" | "complete" | "cancelled";
  blueprintRef: string | null; budgetCents: number | null; spentCents: number;
  stages: BuildStageState[]; createdAt: IsoTimestamp;
}
export interface BuildBoard { state: "ready" | "none"; note: string; builds: Build[] }
export interface BuildStageState {
  stage: BuildStage; status: "not_started" | "running" | "blocked" | "failed" | "passed";
  jobId: string | null; costCents: number; evidence: EvidenceRef[]; notes: string | null;
}

// ---------- Orchestration (durable jobs) ----------
export type JobStatus =
  | "queued" | "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled" | "paused";
export interface Job {
  id: string; kind: string; nicheId: NicheId | null; status: JobStatus; priority: number;
  idempotencyKey: string | null; attempts: number; maxAttempts: number;
  nextRunAt: IsoTimestamp | null; costCapCents: number | null; costCents: number;
  parentId: string | null; createdBy: string; createdAt: IsoTimestamp; updatedAt: IsoTimestamp;
  steps: JobStep[]; output: unknown; error: string | null;
}
export interface JobStep {
  name: string; seq: number; status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  attempts: number; startedAt: IsoTimestamp | null; finishedAt: IsoTimestamp | null;
  checkpoint: unknown; error: string | null;
}

// ---------- Gate receipts ----------
export interface GateReceipt {
  id: string; releaseId: string; gate: string; result: GateResult; reviewer: string;
  producer: string; evidence: string[]; rollback: string | null; createdAt: IsoTimestamp;
}

// ---------- System control ----------
// ---------- Daily series (trend charts) ----------
export interface TrendPoint { date: string; value: number | null }
export interface TrendSeries {
  id: string; label: string; nicheId: NicheId | "portfolio"; unit: Metric["unit"]; state: MetricState;
  period: Period; asOf: IsoTimestamp | null; source: string; note?: string; points: TrendPoint[];
}

export interface SystemControl { globalPause: boolean; pausedAt: IsoTimestamp | null; pausedBy: string | null; reason: string | null }
export interface Me { email: string; role: "owner"; authMethod: "cloudflare_access" | "dev" }
