/**
 * Storage for FORGE Intelligence documents. Content schemas are owned by the Intelligence workstream
 * (packages/contracts/schemas/intelligence). The API validates whole documents against those schemas
 * and stores them versioned with a canonical content hash.
 */
import { Validator } from "@cfworker/json-schema";
import type { Build, BuildBoard, MarketBriefEnvelope, OpportunityBoard, OpportunityEnvelope } from "@forge/contracts";
import { BUILD_STAGES } from "@forge/contracts";
import briefSchema from "../../../../packages/contracts/schemas/intelligence/brief.schema.json" with { type: "json" };
import opportunitySchema from "../../../../packages/contracts/schemas/intelligence/opportunity.schema.json" with { type: "json" };
import { canonicalJson, newId, nowIso, parseJson, sha256Hex } from "../lib/util.ts";

type R = Record<string, any>;

function validator(schema: object, extra: object[] = []) {
  const v = new Validator(schema as any, "2020-12", false);
  for (const s of extra) v.addSchema(s as any);
  return v;
}
const briefValidator = validator(briefSchema);
const opportunityValidator = validator(opportunitySchema, [briefSchema]);

export function validateBrief(doc: unknown): string[] {
  const r = briefValidator.validate(doc);
  return r.valid ? [] : r.errors.slice(0, 20).map((e) => `${e.instanceLocation}: ${e.error}`);
}
export function validateOpportunity(doc: unknown): string[] {
  const r = opportunityValidator.validate(doc);
  return r.valid ? [] : r.errors.slice(0, 20).map((e) => `${e.instanceLocation}: ${e.error}`);
}

const mapBrief = (r: R): MarketBriefEnvelope => ({ id: r.id, nicheId: r.niche_id, version: r.version, schemaVersion: r.schema_version, status: r.status, contentHash: r.content_hash, createdAt: r.created_at, approvedBy: r.approved_by, content: parseJson(r.content_json, null) });

export async function storeBrief(db: D1Database, doc: R): Promise<MarketBriefEnvelope> {
  const hash = await sha256Hex(canonicalJson(doc));
  const id = String(doc.brief_id ?? newId("brief"));
  // Only drafts are stored through the API; approval is an owner decision recorded separately.
  await db.prepare(`INSERT INTO market_briefs (id,niche_id,version,schema_version,status,content_json,content_hash,created_at) VALUES (?,?,?,?,'draft',?,?,?)`)
    .bind(id, doc.niche, doc.version, doc.schema_version, JSON.stringify(doc), hash, nowIso()).run();
  return mapBrief((await db.prepare(`SELECT * FROM market_briefs WHERE id = ?`).bind(id).first<R>())!);
}

export async function listBriefs(db: D1Database, nicheId?: string): Promise<MarketBriefEnvelope[]> {
  const st = nicheId ? db.prepare(`SELECT * FROM market_briefs WHERE niche_id = ? ORDER BY created_at DESC`).bind(nicheId) : db.prepare(`SELECT * FROM market_briefs ORDER BY niche_id, created_at DESC`);
  return (await st.all<R>()).results.map(mapBrief);
}

export async function opportunityBoard(db: D1Database): Promise<OpportunityBoard> {
  const run = await db.prepare(`SELECT * FROM research_runs WHERE kind = 'scout' AND status IN ('succeeded','partial') ORDER BY started_at DESC LIMIT 1`).first<R>();
  if (!run) return { state: "not_run", runAt: null, scoringModelVersion: null, note: "The Opportunity Scout has not produced a run yet. No opportunities are shown rather than placeholders.", opportunities: [] };
  const rows = (await db.prepare(`SELECT * FROM opportunities WHERE run_id = ? ORDER BY rank ASC`).bind(run.id).all<R>()).results;
  const opportunities: OpportunityEnvelope[] = rows.map((r) => ({ id: r.id, opportunityKey: r.opportunity_key, title: r.title, score: r.score, rank: r.rank, recommended: !!r.recommended, scoringModelVersion: r.scoring_model_version, briefRef: r.brief_ref, runId: r.run_id, status: r.status, content: parseJson(r.content_json, null) }));
  const unconnected = parseJson<string[]>(run.sources_unconnected_json, []);
  return { state: "ready", runAt: run.started_at, scoringModelVersion: rows[0]?.scoring_model_version ?? null,
    note: unconnected.length ? `Sources not connected for this run: ${unconnected.join(", ")}.` : "", opportunities };
}

export async function buildBoard(db: D1Database): Promise<BuildBoard> {
  const rows = (await db.prepare(`SELECT * FROM builds ORDER BY created_at DESC`).all<R>()).results;
  if (!rows.length) return { state: "none", note: "No business build has been commissioned yet.", builds: [] };
  return { state: "ready", note: "", builds: await Promise.all(rows.map((r) => buildDetail(db, r))) };
}

export async function buildDetail(db: D1Database, r: R): Promise<Build> {
  const stages = (await db.prepare(`SELECT * FROM build_stages WHERE build_id = ?`).bind(r.id).all<R>()).results;
  const byStage = new Map(stages.map((s) => [s.stage, s]));
  return {
    id: r.id, nicheId: r.niche_id, opportunityId: r.opportunity_id, title: r.title, status: r.status, blueprintRef: r.blueprint_ref,
    budgetCents: r.budget_cents, spentCents: stages.reduce((a, s) => a + Number(s.cost_cents || 0), 0), createdAt: r.created_at,
    stages: BUILD_STAGES.map((stage) => {
      const s = byStage.get(stage);
      return { stage, status: s?.status ?? "not_started", jobId: s?.job_id ?? null, costCents: Number(s?.cost_cents ?? 0), evidence: [], notes: s?.notes ?? null };
    }),
  };
}
