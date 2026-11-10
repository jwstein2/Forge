/**
 * @forge/operator — FORGE Operator (workstream E, Milestone 3): the autonomous operations engine.
 *
 * Integration points used by services/api (owned by the platform workstream):
 *   defaultHandlers():   ...operatorHandlers()
 *   scheduledTick():     await seedSchedules(db, OPERATOR_SCHEDULES); await enqueueDue(db, handlers, now)
 *   seedRegistry():      also loads OPERATOR_REGISTRY_ENTRIES
 *   app:                 app.route("/operator", operatorRoutes())   (behind the same owner auth)
 *   migrations:          packages/operator/migrations/01xx_*.sql copied into services/api/migrations
 */
import type { HandlerDef } from "../../../services/api/src/orchestration/engine.ts";
import { defaultFetcher, type Fetcher } from "./lib.ts";
import { providerFromEnv, type LlmProvider } from "./llm.ts";
import type { ScheduleDef } from "./schedule.ts";
import { siteHealth } from "./handlers/site-health.ts";
import { pinRunway } from "./handlers/pinterest.ts";
import { seoAudit, seoBatch, seoFinalize } from "./handlers/seo.ts";
import { contentDraft, contentPlan, contentPublish, contentVerify, dryRunPublisher, type Publisher } from "./handlers/content.ts";
import { weeklySummary } from "./handlers/summary.ts";

export { enqueueDue, seedSchedules, latestSlot, slotKey, type ScheduleDef, type ScheduleSpec } from "./schedule.ts";
export { operatorRoutes } from "./routes.ts";
export { providerFromEnv, boundedJsonCall, type LlmProvider } from "./llm.ts";
export type { Fetcher } from "./lib.ts";

export interface OperatorDeps { fetcher?: Fetcher; provider?: (env: Record<string, unknown>) => LlmProvider | null; publishers?: Publisher[] }

/** Manual publisher: the owner posts by hand and records the URL; FORGE then verifies it. Never auto-publishes. */
export const manualPublisher: Publisher = { id: "manual", live: false, async publish() { return { published: false, note: "manual channel: waiting for the owner to post and record the URL" }; } };

export function operatorHandlers(deps: OperatorDeps = {}): HandlerDef[] {
  const fetcher = deps.fetcher ?? defaultFetcher;
  const provider = deps.provider ?? providerFromEnv; // reads ANTHROPIC_API_KEY from the Worker env at run time
  const publishers = new Map([dryRunPublisher, manualPublisher, ...(deps.publishers ?? [])].map((p) => [p.id, p]));
  // The SEO planner enqueues its batch and finalize jobs, so it needs the handler map it belongs to.
  const list: HandlerDef[] = [];
  const map = () => new Map(list.map((h) => [h.kind, h]));
  list.push(siteHealth(fetcher), pinRunway(fetcher), seoAudit(fetcher, map), seoBatch(fetcher), seoFinalize(), contentPlan(), contentDraft(provider), contentPublish(publishers), contentVerify(fetcher), weeklySummary());
  return list;
}

/** Git is the source of truth for schedules. All times UTC. */
export const OPERATOR_SCHEDULES: ScheduleDef[] = [
  { id: "OPS-SITE-HEALTH", kind: "ops.site_health", spec: { every: 60 }, maxAttempts: 2 },
  { id: "OPS-PIN-RUNWAY", kind: "ops.pin_runway", spec: { every: 360 }, nicheId: "quilt-plan-kit", input: { channelId: "ch_qpk_pinterest", minRunwayDays: 5 } },
  { id: "OPS-SEO-AUDIT", kind: "ops.seo_audit", spec: { weekly: { day: 1, at: "06:00" } }, input: { maxPages: 60 } },
  { id: "OPS-CONTENT-PLAN", kind: "ops.content_plan", spec: { weekly: { day: 1, at: "07:00" } }, input: { horizonDays: 120 } },
  { id: "OPS-CONTENT-DRAFT", kind: "ops.content_draft", spec: { daily: "08:00" }, input: { limit: 4, costCapCentsPerItem: 10 }, costCapCents: 40, maxAttempts: 1 },
  { id: "OPS-CONTENT-PUBLISH", kind: "ops.content_publish", spec: { daily: "15:00" }, maxAttempts: 1 },
  { id: "OPS-CONTENT-VERIFY", kind: "ops.content_verify", spec: { every: 360 } },
  { id: "OPS-WEEKLY-SUMMARY", kind: "ops.weekly_summary", spec: { weekly: { day: 1, at: "12:00" } } },
];

const base = { kind: "workflow", department: "Marketing, Distribution & Sales", owner: "workstream E (FORGE Operator)", runner: "forge", trigger: "schedule", model: null, costCapCents: null, retryBudget: 3, status: "BUILT", pausable: true, defects: [] as string[], definedIn: "packages/operator" };
/** RegistryEntry-shaped rows (same shape as registry/registry.json entries). Status BUILT until QA evidence promotes them. */
export const OPERATOR_REGISTRY_ENTRIES = [
  { ...base, id: "OPS-SITE-HEALTH", name: "Operator · Site health and content assertions", nicheId: null, department: "Operations, Finance & Infrastructure", externalRef: "ops.site_health", cadence: "Every 60 min", intervalMinutes: 60, retryBudget: 2, notes: "Home, robots, sitemap per site; QPK pin feed; sales Worker /health. Successor to N8N-02 with FORGE heartbeats." },
  { ...base, id: "OPS-PIN-RUNWAY", name: "Operator · Pinterest queue runway and receipts", nicheId: "quilt-plan-kit", externalRef: "ops.pin_runway", cadence: "Every 6 h", intervalMinutes: 360, notes: "Alerts before the RSS drip runs dry; verifies pins from the public Pinterest profile feed when the profile URL is recorded." },
  { ...base, id: "OPS-SEO-AUDIT", name: "Operator · Weekly technical SEO crawl", nicheId: null, externalRef: "ops.seo_audit", cadence: "Weekly Mon 06:00 UTC", intervalMinutes: 10080, notes: "Sitemap-driven crawl; Search Console data stays UNKNOWN until connected." },
  { ...base, id: "OPS-CONTENT-PLAN", name: "Operator · Seasonal content planner", nicheId: null, externalRef: "ops.content_plan", cadence: "Weekly Mon 07:00 UTC", intervalMinutes: 10080, notes: "Plans dated items from each Audience & Market Brief's seasonality and channel fit." },
  { ...base, id: "OPS-CONTENT-DRAFT", name: "Operator · Copy drafting (bounded model step)", nicheId: null, externalRef: "ops.content_draft", cadence: "Daily 08:00 UTC", intervalMinutes: 1440, model: "claude-opus-5-5 (configurable)", costCapCents: 40, retryBudget: 1, notes: "JSON-validated, claims-linted, one retry, cost recorded. Idle until a model API key is approved." },
  { ...base, id: "OPS-CONTENT-PUBLISH", name: "Operator · Policy-gated publishing", nicheId: null, externalRef: "ops.content_publish", cadence: "Daily 15:00 UTC", intervalMinutes: 1440, retryBudget: 1, notes: "Default draft_only. Standing publishing only inside an owner-approved boundary. Only dry_run and manual publishers exist." },
  { ...base, id: "OPS-CONTENT-VERIFY", name: "Operator · Publication receipt verification", nicheId: null, externalRef: "ops.content_verify", cadence: "Every 6 h", intervalMinutes: 360, notes: "Marks content and channels verified only from the platform URL." },
  { ...base, id: "OPS-WEEKLY-SUMMARY", name: "Operator · Weekly in-app summary", nicheId: null, department: "Operations, Finance & Infrastructure", externalRef: "ops.weekly_summary", cadence: "Weekly Mon 12:00 UTC", intervalMinutes: 10080, notes: "Stored for FORGE Command; never emailed." },
];

/** Insert the Operator registry rows (idempotent; never overwrites runtime state such as pauses). */
export async function seedOperatorRegistry(db: D1Database, at = new Date().toISOString()): Promise<number> {
  const stmts = OPERATOR_REGISTRY_ENTRIES.map((r) => db.prepare(`INSERT INTO registry_entries (id,kind,name,niche_id,department,owner,runner,external_ref,trigger_desc,cadence,interval_minutes,model,cost_cap_cents,retry_budget,status,pausable,defects_json,defined_in,notes,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(r.id, r.kind, r.name, r.nicheId, r.department, r.owner, r.runner, r.externalRef, r.trigger, r.cadence, r.intervalMinutes, r.model, r.costCapCents, r.retryBudget, r.status, r.pausable ? 1 : 0, JSON.stringify(r.defects), r.definedIn, r.notes, at));
  await db.batch(stmts);
  return stmts.length;
}
