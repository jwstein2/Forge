/**
 * @forge/intelligence — FORGE Intelligence (workstream B, Milestone 4): the Opportunity Scout and Audience & Market Briefs.
 *
 * Integration points used by services/api (owned by the platform workstream):
 *   defaultHandlers():   ...intelligenceHandlers()
 *   registry seed:       await seedIntelligenceRegistry(db)
 *   cron:                await seedSchedules(db, INTEL_SCHEDULES) alongside OPERATOR_SCHEDULES (weekly source re-check)
 *   app:                 app.route("/intelligence", intelligenceRoutes(() => handlers))   (behind owner auth)
 *   migrations:          packages/intelligence/migrations/02xx_*.sql copied into services/api/migrations
 */
import type { HandlerDef } from "../../../services/api/src/orchestration/engine.ts";
import { defaultFetcher, type Fetcher } from "./fetch.ts";
import { scoutHandlers } from "./handlers/scout.ts";
import { briefHandlers } from "./handlers/briefs.ts";
import { storePack } from "./handlers/scout.ts";
import { storeObservations, type Observation } from "./observations.ts";
import { storeBrief, validateBrief } from "../../../services/api/src/domain/intelligence.ts";
import type { EvidencePack } from "./types.ts";
// Evidence kept in git and seeded on deploy (same idea as the registry): packs feed the monthly Scout, observations stand in
// for pages that bot-wall the Worker. Adding a file here needs a matching import below.
import pack202611 from "../packs/2026-11-scout-01.json" with { type: "json" };
import obs20261111 from "../observations/2026-11-11.assisted.json" with { type: "json" };
// Current Audience & Market Briefs, seeded as drafts so staging planners (operator ops.content_plan, builder) can read them.
import briefBidline from "../briefs/bidline.brief.json" with { type: "json" };
import briefGarden from "../briefs/garden-planner.brief.json" with { type: "json" };
import briefLoaf from "../briefs/loaf-ledger.brief.json" with { type: "json" };
import briefQpk from "../briefs/quilt-plan-kit.brief.json" with { type: "json" };
export const GIT_PACKS = [pack202611 as unknown as EvidencePack];
export const GIT_OBSERVATIONS = [...(obs20261111 as unknown as Observation[])];
export const GIT_BRIEFS = [briefBidline, briefGarden, briefLoaf, briefQpk] as unknown as Record<string, any>[];

export { intelligenceRoutes } from "./routes.ts";
export { connectorStates, type ConnectorState } from "./connectors.ts";
export { rank, scoreCandidate, type ScoringModel } from "./score.ts";
export { validatePack } from "./pack.ts";
export { storePack, latestDiscoveryPack } from "./handlers/scout.ts";
export { storeObservations, effectiveChecks, OBS_MAX_AGE_DAYS } from "./observations.ts";
export { NICHE_SIGNAL_ARTICLES } from "./handlers/briefs.ts";
export type { EvidencePack, PackCandidate, Claim } from "./types.ts";
export type { Fetcher } from "./fetch.ts";

export interface IntelligenceDeps { fetcher?: Fetcher }

export function intelligenceHandlers(deps: IntelligenceDeps = {}): HandlerDef[] {
  const fetcher = deps.fetcher ?? defaultFetcher;
  const list: HandlerDef[] = [];
  const map = () => new Map(list.map((h) => [h.kind, h]));
  list.push(...scoutHandlers(fetcher, map), ...briefHandlers(map));
  return list;
}

/** Same shape as @forge/operator ScheduleDef. All times UTC. The Scout itself runs on demand (owner submits a pack). */
export const INTEL_SCHEDULES = [
  { id: "INTEL-SOURCE-RECHECK", kind: "intel.source.recheck", registryId: "FORGE-INTEL-RECHECK", spec: { weekly: { day: 3, at: "05:00" } }, maxAttempts: 2 },
  { id: "INTEL-SCOUT-MONTHLY", kind: "intel.scout.cycle", registryId: "FORGE-INTEL-SCOUT-CYCLE", spec: { monthly: { day: 2, at: "06:00" } }, maxAttempts: 2 },
];

const base = { kind: "workflow", department: "Market & Opportunity Intelligence", owner: "workstream B (FORGE Intelligence)", runner: "forge", model: null, costCapCents: null, retryBudget: 2, status: "BUILT", pausable: true, defects: [] as string[], definedIn: "packages/intelligence", nicheId: null };
export const INTEL_REGISTRY_ENTRIES = [
  { ...base, id: "FORGE-INTEL-SCOUT", name: "Intelligence · Opportunity Scout run", externalRef: "intel.scout.run", trigger: "on demand (owner submits an evidence pack)", cadence: "On demand; monthly target", intervalMinutes: null,
    notes: "Re-checks every cited source, collects free Wikimedia interest signals, applies evidence rules R1-R3, scores deterministically, stores 3-5 opportunities and draft briefs." },
  { ...base, id: "FORGE-INTEL-BRIEF", name: "Intelligence · Brief publish (validate + store draft)", externalRef: "intel.brief.publish", trigger: "on demand", cadence: "On demand", intervalMinutes: null, notes: "Drafts only; approval is an owner decision." },
  { ...base, id: "FORGE-INTEL-SCOUT-CYCLE", name: "Intelligence · Monthly Scout re-run", externalRef: "intel.scout.cycle", trigger: "schedule", cadence: "Monthly, 2nd at 06:00 UTC", intervalMinutes: 43200,
    notes: "Re-runs the newest discovery evidence pack: fresh source re-checks, Wikimedia signals and scores, so the opportunity board shows a current ranked list with one recommendation." },
  { ...base, id: "FORGE-INTEL-RECHECK", name: "Intelligence · Weekly cited-source re-check", externalRef: "intel.source.recheck", trigger: "schedule", cadence: "Weekly Wed 05:00 UTC", intervalMinutes: 10080, notes: "Alerts (info) when sources cited by current briefs return 404/410." },
];

/** Store the packs and observations kept in git. Idempotent (content-hash dedupe); safe on every seed. */
/** Briefs are stored as drafts only, once per niche+version; an existing version (any status) is never touched. */
export async function seedBriefs(db: D1Database, briefs: Record<string, any>[] = GIT_BRIEFS): Promise<{ stored: number; existing: number; invalid: string[] }> {
  let stored = 0, existing = 0; const invalid: string[] = [];
  for (const doc of briefs) {
    const errs = validateBrief(doc);
    if (errs.length) { invalid.push(`${doc.niche}@${doc.version}: ${errs[0]}`); continue; }
    const dup = await db.prepare(`SELECT id FROM market_briefs WHERE niche_id = ? AND version = ?`).bind(doc.niche, doc.version).first();
    if (dup) { existing++; continue; }
    await storeBrief(db, doc); stored++;
  }
  return { stored, existing, invalid };
}

export async function seedIntelligenceData(db: D1Database): Promise<{ packs: number; observations: { stored: number; duplicates: number }; briefs: { stored: number; existing: number; invalid: string[] } }> {
  for (const p of GIT_PACKS) await storePack(db, p, "git");
  const observations = await storeObservations(db, GIT_OBSERVATIONS);
  return { packs: GIT_PACKS.length, observations, briefs: await seedBriefs(db) };
}

export async function seedIntelligenceRegistry(db: D1Database, at = new Date().toISOString()): Promise<number> {
  const stmts = INTEL_REGISTRY_ENTRIES.map((r) => db.prepare(`INSERT INTO registry_entries (id,kind,name,niche_id,department,owner,runner,external_ref,trigger_desc,cadence,interval_minutes,model,cost_cap_cents,retry_budget,status,pausable,defects_json,defined_in,notes,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(r.id, r.kind, r.name, r.nicheId, r.department, r.owner, r.runner, r.externalRef, r.trigger, r.cadence, r.intervalMinutes, r.model, r.costCapCents, r.retryBudget, r.status, r.pausable ? 1 : 0, JSON.stringify(r.defects), r.definedIn, r.notes, at));
  await db.batch(stmts);
  return stmts.length;
}
