/** Integration test against the platform's real migrations, SQLite D1 double and job engine. */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { NodeD1, applyMigrations } from "../../../services/api/src/lib/node-d1.ts";
import type { Env } from "../../../services/api/src/lib/env.ts";
import { seedRegistry } from "../../../services/api/src/domain/seed.ts";
import { REGISTRY_DATA } from "../../../services/api/src/domain/registry-data.ts";
import { NonRetryableError, enqueue, getJob, tick, type HandlerDef } from "../../../services/api/src/orchestration/engine.ts";
import { defaultHandlers } from "../../../services/api/src/orchestration/handlers.ts";
import { builderHandlers } from "../src/handlers.ts";
import { contentHash } from "../src/hash.ts";
import { releaseId, approvalScope } from "../src/pipeline.ts";
import type { LaunchBlueprint } from "../src/types.ts";
import { loadBrief, syntheticNewBusinessBrief } from "./helpers.ts";
import type { Brief } from "../src/brief.ts";

async function setup() {
  const d1 = new NodeD1(":memory:");
  applyMigrations(d1, join(import.meta.dirname, "..", "..", "..", "services", "api", "migrations"));
  const env = { DB: d1.asD1(), ENVIRONMENT: "test", OWNER_EMAILS: "owner@forge.test", DEV_AUTH_TOKEN: "t", HEARTBEAT_SECRET: "h" } as Env;
  await seedRegistry(env.DB, REGISTRY_DATA);
  const handlers = defaultHandlers();
  for (const h of builderHandlers({ NonRetryableError })) handlers.set(h.kind, h as unknown as HandlerDef);
  return { env, db: env.DB, handlers };
}
async function storeBrief(db: D1Database, b: Brief) {
  await db.prepare(`INSERT INTO market_briefs (id,niche_id,version,schema_version,status,content_json,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(b.brief_id, b.niche, b.version, b.schema_version, "draft", JSON.stringify(b), await contentHash(b), b.updated_at).run();
}
async function run(ctx: Awaited<ReturnType<typeof setup>>, kind: string, input: Record<string, unknown>) {
  const { id } = await enqueue(ctx.db, ctx.handlers as never, { kind, input, createdBy: "test" });
  await tick(ctx.db, ctx.env, ctx.handlers as never, { maxJobs: 5 });
  return (await getJob(ctx.db, id))!;
}

describe("builder job handlers on the platform engine", () => {
  it("generates and stores a draft blueprint from a stored brief, idempotently", async () => {
    const ctx = await setup();
    await storeBrief(ctx.db, loadBrief("quilt-plan-kit"));
    const job = await run(ctx, "builder.blueprint.generate", { nicheId: "quilt-plan-kit", version: "1.0.0" });
    expect(job.status).toBe("succeeded");
    const row = await ctx.db.prepare(`SELECT * FROM launch_blueprints WHERE niche_id='quilt-plan-kit'`).first<any>();
    expect(row).toMatchObject({ id: "bp_quilt-plan-kit_v1-0-0", status: "draft", version: "1.0.0", brief_ref: "brief_quilt-plan-kit_v1-0-1" });
    const bp = JSON.parse(row.content_json) as LaunchBlueprint;
    expect(bp.products.find((p) => p.tier === "entry")!.registry_product_id).toBe("prd_qpk_planner");
    expect(row.content_hash).toBe(await contentHash(bp));
    const again = await run(ctx, "builder.blueprint.generate", { nicheId: "quilt-plan-kit", version: "1.0.0" });
    expect((again.output as any).store.created).toBe(false);
  });

  it("auto-bumps the patch version and records what it supersedes", async () => {
    const ctx = await setup();
    await storeBrief(ctx.db, loadBrief("bidline"));
    await run(ctx, "builder.blueprint.generate", { nicheId: "bidline" });
    const second = await run(ctx, "builder.blueprint.generate", { nicheId: "bidline" });
    expect((second.output as any).store.version).toBe("1.0.1");
    const row = await ctx.db.prepare(`SELECT content_json FROM launch_blueprints WHERE version='1.0.1'`).first<any>();
    expect(JSON.parse(row.content_json).supersedes).toBe("bp_bidline_v1-0-0");
  });

  it("fails without retrying when there is no brief", async () => {
    const ctx = await setup();
    const job = await run(ctx, "builder.blueprint.generate", { nicheId: "loaf-ledger" });
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1);
  });

  it("plans a build for an existing niche, then advances it only on independent receipts", async () => {
    const ctx = await setup();
    await storeBrief(ctx.db, loadBrief("loaf-ledger"));
    await run(ctx, "builder.blueprint.generate", { nicheId: "loaf-ledger" });
    const planned = await run(ctx, "builder.build.plan", { blueprintId: "bp_loaf-ledger_v1-0-0" });
    const buildId = (planned.output as any).plan.buildId as string;
    expect((planned.output as any).plan.status).toBe("draft");
    const stages = (await ctx.db.prepare(`SELECT stage,status FROM build_stages WHERE build_id=?`).bind(buildId).all<any>()).results;
    expect(stages).toHaveLength(9);
    expect(stages.every((s: any) => s.status === "not_started")).toBe(true);

    // planning twice returns the open build
    const replan = await run(ctx, "builder.build.plan", { blueprintId: "bp_loaf-ledger_v1-0-0" });
    expect((replan.output as any).plan).toMatchObject({ buildId, created: false });

    // the database itself refuses a self-certified receipt
    await expect(ctx.db.prepare(`INSERT INTO gate_receipts (id,release_id,gate,result,reviewer,producer,created_at) VALUES ('g0',?,'B0','PASS','builder','builder','2026-11-10T05:00:00Z')`).bind(releaseId(buildId, "research")).run()).rejects.toThrow(/CHECK/);
    await ctx.db.prepare(`INSERT INTO gate_receipts (id,release_id,gate,result,reviewer,producer,created_at) VALUES ('g1',?,'B0','PASS','qa','builder','2026-11-10T05:00:00Z')`).bind(releaseId(buildId, "research")).run();
    const ev = await run(ctx, "builder.build.evaluate", { buildId });
    expect((ev.output as any).evaluate).toMatchObject({ status: "running", next: ["blueprint"], gatesReadyForLaunchDecision: false, launchApproved: false });
    const research = await ctx.db.prepare(`SELECT status FROM build_stages WHERE build_id=? AND stage='research'`).bind(buildId).first<any>();
    expect(research.status).toBe("passed");
  });

  it("a new business build waits on a pending owner approval and cannot be self-approved", async () => {
    const ctx = await setup();
    await storeBrief(ctx.db, syntheticNewBusinessBrief());
    const gen = await run(ctx, "builder.blueprint.generate", { nicheId: "test-new-business" });
    expect(gen.status).toBe("succeeded");
    const bpRow = await ctx.db.prepare(`SELECT content_json FROM launch_blueprints WHERE niche_id='test-new-business'`).first<any>();
    expect(JSON.parse(bpRow.content_json).business_kind).toBe("new_business");
    const planned = await run(ctx, "builder.build.plan", { blueprintId: "bp_test-new-business_v1-0-0" });
    const out = (planned.output as any).plan;
    expect(out.status).toBe("awaiting_approval");
    const ap = await ctx.db.prepare(`SELECT * FROM approvals WHERE id=?`).bind(out.approvalId).first<any>();
    expect(ap).toMatchObject({ status: "pending", scope: approvalScope(out.buildId), action: "Select this opportunity for a build" });
    await expect(ctx.db.prepare(`UPDATE approvals SET status='approved', decided_by='builder' WHERE id=?`).bind(out.approvalId).run()).rejects.toThrow(/CHECK/);
    await ctx.db.prepare(`INSERT INTO gate_receipts (id,release_id,gate,result,reviewer,producer,created_at) VALUES ('g1',?,'B0','PASS','qa','builder','2026-11-10T05:00:00Z')`).bind(releaseId(out.buildId, "research")).run();
    const ev = await run(ctx, "builder.build.evaluate", { buildId: out.buildId });
    expect((ev.output as any).evaluate.status).toBe("awaiting_approval");
  });
});
