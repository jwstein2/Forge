/**
 * Job handlers for the platform's durable engine (services/api/src/orchestration/engine.ts).
 * Typed structurally so this package does not depend on the API service. Register with:
 *
 *   import { builderHandlers } from "@forge/builder/handlers";
 *   ...builderHandlers({ NonRetryableError })
 *
 * All three are deterministic, spend nothing, and write only FORGE tables
 * (launch_blueprints, builds, build_stages, approvals, evidence). None deploys or launches.
 */
import { BUILD_STAGES, type BuildStage } from "@forge/contracts";
import type { Brief } from "./brief.ts";
import { generateBlueprint, type RegistryProduct } from "./generate.ts";
import { contentHash } from "./hash.ts";
import { approvalScope, evaluateBuild, parseReleaseId, type ApprovalLike, type ReceiptLike } from "./pipeline.ts";
import type { LaunchBlueprint } from "./types.ts";
import { validateBlueprint } from "./validate.ts";

interface StepContext { db: D1Database; input: Record<string, unknown>; outputs: Record<string, unknown>; now: Date; jobId: string }
interface StepDef { name: string; run(ctx: StepContext): Promise<{ output?: unknown; costCents?: number } | void> }
export interface BuilderHandlerDef { kind: string; steps: StepDef[]; requiresApproval?(input: Record<string, unknown>): string | null; registryId?: string }
type ErrCtor = new (message: string) => Error;

type Row = Record<string, any>;
const iso = () => new Date().toISOString();
const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const cmpSemver = (a: string, b: string) => {
  const x = SEMVER.exec(a)!.slice(1).map(Number), y = SEMVER.exec(b)!.slice(1).map(Number);
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
};
const bumpPatch = (v: string) => { const [a, b, c] = SEMVER.exec(v)!.slice(1).map(Number); return `${a}.${b}.${c! + 1}`; };

export function builderHandlers(deps: { NonRetryableError: ErrCtor }): BuilderHandlerDef[] {
  const Fatal = deps.NonRetryableError;

  // ---------------- builder.blueprint.generate ----------------
  const generate: BuilderHandlerDef = {
    kind: "builder.blueprint.generate",
    steps: [
      {
        name: "load_brief",
        async run({ db, input }) {
          const nicheId = String(input.nicheId ?? "");
          const briefId = input.briefId ? String(input.briefId) : null;
          const row = briefId
            ? await db.prepare(`SELECT * FROM market_briefs WHERE id = ?`).bind(briefId).first<Row>()
            : await db.prepare(`SELECT * FROM market_briefs WHERE niche_id = ? AND status <> 'superseded' ORDER BY created_at DESC LIMIT 1`).bind(nicheId).first<Row>();
          if (!row) throw new Fatal(`no market brief found for ${briefId ?? nicheId}`);
          const products = (await db.prepare(`SELECT id, niche_id, name, kind, tier FROM products WHERE niche_id = ?`).bind(row.niche_id).all<Row>()).results
            .map((p): RegistryProduct => ({ id: p.id, nicheId: p.niche_id, name: p.name, kind: p.kind, tier: p.tier }));
          const niche = await db.prepare(`SELECT id FROM niches WHERE id = ?`).bind(row.niche_id).first<Row>();
          return { output: { briefRowId: row.id, brief: JSON.parse(row.content_json), products, existingNiche: !!niche } };
        },
      },
      {
        name: "generate",
        async run({ db, input, outputs }) {
          const o = outputs.load_brief as { brief: Brief; products: RegistryProduct[]; existingNiche: boolean };
          const prev = (await db.prepare(`SELECT id, version FROM launch_blueprints WHERE niche_id = ?`).bind(o.brief.niche).all<Row>()).results
            .sort((a, b) => cmpSemver(b.version, a.version))[0];
          const version = input.version ? String(input.version) : prev ? bumpPatch(prev.version) : "1.0.0";
          if (!SEMVER.test(version)) throw new Fatal(`version must be semver: ${version}`);
          const bp = await generateBlueprint(o.brief, {
            version, supersedes: prev && prev.version !== version ? prev.id : null,
            businessKind: o.existingNiche ? "existing_niche" : "new_business",
            budgetCeilingCents: typeof input.budgetCeilingCents === "number" ? input.budgetCeilingCents : null,
            registryProducts: o.products, allowHold: input.allowHold === true,
          }).catch((e: Error) => { throw new Fatal(e.message); });
          const v = validateBlueprint(bp, o.brief);
          if (!v.ok) throw new Fatal(`blueprint failed validation: ${v.errors.slice(0, 5).join("; ")}`);
          return { output: { blueprint: bp } };
        },
      },
      {
        name: "store",
        async run({ db, outputs }) {
          const bp = (outputs.generate as { blueprint: LaunchBlueprint }).blueprint;
          const briefRowId = (outputs.load_brief as { briefRowId: string }).briefRowId;
          const hash = await contentHash(bp);
          const existing = await db.prepare(`SELECT id, content_hash FROM launch_blueprints WHERE niche_id = ? AND version = ?`).bind(bp.niche, bp.version).first<Row>();
          if (existing) {
            if (existing.content_hash === hash) return { output: { blueprintId: existing.id, version: bp.version, contentHash: hash, created: false } };
            throw new Fatal(`${bp.niche} blueprint ${bp.version} already exists with different content; request a new version`);
          }
          await db.prepare(`INSERT INTO launch_blueprints (id,niche_id,version,schema_version,status,brief_ref,content_json,content_hash,created_at) VALUES (?,?,?,?,'draft',?,?,?,?)`)
            .bind(bp.blueprint_id, bp.niche, bp.version, bp.schema_version, briefRowId, JSON.stringify(bp), hash, iso()).run();
          return { output: { blueprintId: bp.blueprint_id, version: bp.version, contentHash: hash, created: true, unknowns: bp.unknowns.length } };
        },
      },
    ],
  };

  // ---------------- builder.build.plan ----------------
  const plan: BuilderHandlerDef = {
    kind: "builder.build.plan",
    steps: [{
      name: "plan",
      async run({ db, input }) {
        const bpRow = await db.prepare(`SELECT * FROM launch_blueprints WHERE id = ?`).bind(String(input.blueprintId ?? "")).first<Row>();
        if (!bpRow) throw new Fatal(`blueprint ${input.blueprintId} not found`);
        if (bpRow.status === "superseded") throw new Fatal(`blueprint ${bpRow.id} is superseded`);
        const open = await db.prepare(`SELECT id FROM builds WHERE blueprint_ref = ? AND status NOT IN ('cancelled','complete')`).bind(bpRow.id).first<Row>();
        if (open) return { output: { buildId: open.id, created: false } };

        const bp = JSON.parse(bpRow.content_json) as LaunchBlueprint;
        const niche = await db.prepare(`SELECT id FROM niches WHERE id = ?`).bind(bp.niche).first<Row>();
        const newBusiness = bp.business_kind === "new_business" || !niche;
        const id = rid("bld"); const at = iso();
        const budget = typeof input.budgetCents === "number" ? input.budgetCents : bp.budget.ceiling_cents;
        const stmts: D1PreparedStatement[] = [];
        let approvalId: string | null = null;
        if (newBusiness) {
          // A new business never starts on FORGE's say-so: the build waits on the owner's selection and boundaries.
          approvalId = rid("apr");
          stmts.push(db.prepare(`INSERT INTO approvals (id,scope,action,status,requested_by,boundary_json,source_ref,created_at) VALUES (?,?,?,'pending',?,?,?,?)`)
            .bind(approvalId, approvalScope(id), "Select this opportunity for a build", "builder.build.plan", JSON.stringify({ budgetCents: budget, blueprint: bpRow.id }), bpRow.id, at));
        }
        stmts.push(db.prepare(`INSERT INTO builds (id,niche_id,opportunity_id,title,status,blueprint_ref,budget_cents,approval_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .bind(id, niche ? bp.niche : null, input.opportunityId ? String(input.opportunityId) : null, String(input.title ?? `${bp.display_name} build (blueprint ${bp.version})`),
            newBusiness ? "awaiting_approval" : "draft", bpRow.id, budget, approvalId, at, at));
        for (const st of BUILD_STAGES) {
          stmts.push(db.prepare(`INSERT INTO build_stages (build_id,stage,status,notes,updated_at) VALUES (?,?,'not_started',?,?)`)
            .bind(id, st, st === "research" ? "Gates outstanding: B0" : `Waiting on ${bp.stages.find((s) => s.stage === st)?.depends_on.join(", ")}`, at));
        }
        await db.batch(stmts);
        return { output: { buildId: id, created: true, status: newBusiness ? "awaiting_approval" : "draft", approvalId } };
      },
    }],
  };

  // ---------------- builder.build.evaluate ----------------
  const evaluate: BuilderHandlerDef = {
    kind: "builder.build.evaluate",
    steps: [{
      name: "evaluate",
      async run({ db, input }) {
        const b = await db.prepare(`SELECT * FROM builds WHERE id = ?`).bind(String(input.buildId ?? "")).first<Row>();
        if (!b) throw new Fatal(`build ${input.buildId} not found`);
        const bpRow = await db.prepare(`SELECT content_json FROM launch_blueprints WHERE id = ?`).bind(b.blueprint_ref).first<Row>();
        if (!bpRow) throw new Fatal(`build ${b.id} has no blueprint`);
        const bp = JSON.parse(bpRow.content_json) as LaunchBlueprint;
        const receipts: ReceiptLike[] = (await db.prepare(`SELECT * FROM gate_receipts WHERE release_id LIKE ?`).bind(`${b.id}:%`).all<Row>()).results
          .flatMap((r) => { const p = parseReleaseId(r.release_id); return p && p.buildId === b.id ? [{ stage: p.stage, gate: r.gate, result: r.result, reviewer: r.reviewer, producer: r.producer, createdAt: r.created_at }] : []; });
        const approvals: ApprovalLike[] = (await db.prepare(`SELECT action, status FROM approvals WHERE scope = ?`).bind(approvalScope(b.id)).all<Row>()).results.map((a) => ({ action: a.action, status: a.status }));
        const ev = evaluateBuild(bp, receipts, approvals, { cancelled: b.status === "cancelled" });
        const at = iso();
        const stmts = ev.stages.map((s) => db.prepare(`UPDATE build_stages SET status = ?, notes = ?, updated_at = ? WHERE build_id = ? AND stage = ?`).bind(s.status, s.notes || null, at, b.id, s.stage));
        stmts.push(db.prepare(`UPDATE builds SET status = ?, updated_at = ? WHERE id = ?`).bind(ev.status, at, b.id));
        await db.batch(stmts);
        return { output: { buildId: b.id, status: ev.status, launchReady: ev.launchReady, next: ev.next, stages: ev.stages.map((s) => ({ stage: s.stage, status: s.status })) } };
      },
    }],
  };

  return [generate, plan, evaluate];
}

export type { BuildStage };
