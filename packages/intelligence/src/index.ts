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

export { intelligenceRoutes } from "./routes.ts";
export { connectorStates, type ConnectorState } from "./connectors.ts";
export { rank, scoreCandidate, type ScoringModel } from "./score.ts";
export { validatePack } from "./pack.ts";
export { storePack } from "./handlers/scout.ts";
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
];

const base = { kind: "workflow", department: "Market & Opportunity Intelligence", owner: "workstream B (FORGE Intelligence)", runner: "forge", model: null, costCapCents: null, retryBudget: 2, status: "BUILT", pausable: true, defects: [] as string[], definedIn: "packages/intelligence", nicheId: null };
export const INTEL_REGISTRY_ENTRIES = [
  { ...base, id: "FORGE-INTEL-SCOUT", name: "Intelligence · Opportunity Scout run", externalRef: "intel.scout.run", trigger: "on demand (owner submits an evidence pack)", cadence: "On demand; monthly target", intervalMinutes: null,
    notes: "Re-checks every cited source, collects free Wikimedia interest signals, applies evidence rules R1-R3, scores deterministically, stores 3-5 opportunities and draft briefs." },
  { ...base, id: "FORGE-INTEL-BRIEF", name: "Intelligence · Brief publish (validate + store draft)", externalRef: "intel.brief.publish", trigger: "on demand", cadence: "On demand", intervalMinutes: null, notes: "Drafts only; approval is an owner decision." },
  { ...base, id: "FORGE-INTEL-RECHECK", name: "Intelligence · Weekly cited-source re-check", externalRef: "intel.source.recheck", trigger: "schedule", cadence: "Weekly Wed 05:00 UTC", intervalMinutes: 10080, notes: "Alerts (info) when sources cited by current briefs return 404/410." },
];

export async function seedIntelligenceRegistry(db: D1Database, at = new Date().toISOString()): Promise<number> {
  const stmts = INTEL_REGISTRY_ENTRIES.map((r) => db.prepare(`INSERT INTO registry_entries (id,kind,name,niche_id,department,owner,runner,external_ref,trigger_desc,cadence,interval_minutes,model,cost_cap_cents,retry_budget,status,pausable,defects_json,defined_in,notes,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(r.id, r.kind, r.name, r.nicheId, r.department, r.owner, r.runner, r.externalRef, r.trigger, r.cadence, r.intervalMinutes, r.model, r.costCapCents, r.retryBudget, r.status, r.pausable ? 1 : 0, JSON.stringify(r.defects), r.definedIn, r.notes, at));
  await db.batch(stmts);
  return stmts.length;
}
