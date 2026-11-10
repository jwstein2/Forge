/**
 * Run an evidence pack through the real Scout jobs against an in-memory D1, locally.
 *   npm run scout:local -w @forge/intelligence -- packs/2026-11-scout-01.json [--out report.json] [--offline]
 * --offline treats every fetch as unreachable (no network): nothing is downgraded, the run is marked partial.
 * The same jobs run on the staging Worker once the platform mounts them; this script is for review and QA only.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { NodeD1, applyMigrations } from "../../../services/api/src/lib/node-d1.ts";
import type { Env } from "../../../services/api/src/lib/env.ts";
import { seedRegistry } from "../../../services/api/src/domain/seed.ts";
import { REGISTRY_DATA } from "../../../services/api/src/domain/registry-data.ts";
import { enqueue, tick } from "../../../services/api/src/orchestration/engine.ts";
import { defaultHandlers } from "../../../services/api/src/orchestration/handlers.ts";
import { opportunityBoard, listBriefs } from "../../../services/api/src/domain/intelligence.ts";
import { intelligenceHandlers, seedIntelligenceRegistry, storePack } from "../src/index.ts";
import { defaultFetcher, type Fetcher } from "../src/fetch.ts";

const args = process.argv.slice(2);
const packPath = args.find((a) => !a.startsWith("--"));
if (!packPath) { console.error("usage: scout-local <pack.json> [--out file] [--offline]"); process.exit(2); }
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
const offline = args.includes("--offline");
const fetcher: Fetcher = offline ? async () => ({ ok: false, status: null, text: "", error: "offline" }) : defaultFetcher;

const d1 = new NodeD1(":memory:");
const platformDir = join(import.meta.dirname, "..", "..", "..", "services", "api", "migrations");
applyMigrations(d1, platformDir);
const have = new Set(readdirSync(platformDir));
const mine = join(import.meta.dirname, "..", "migrations");
for (const f of readdirSync(mine).filter((f) => f.endsWith(".sql")).sort()) if (!have.has(f)) d1.db.exec(readFileSync(join(mine, f), "utf8"));
const env = { DB: d1.asD1(), ENVIRONMENT: "local" } as unknown as Env;
await seedRegistry(env.DB, REGISTRY_DATA);
await seedIntelligenceRegistry(env.DB);
const handlers = defaultHandlers();
for (const h of intelligenceHandlers({ fetcher })) handlers.set(h.kind, h);

const pack = JSON.parse(readFileSync(resolve(packPath), "utf8"));
const packId = await storePack(env.DB, pack, "local");
await enqueue(env.DB, handlers, { kind: "intel.scout.run", input: { packId, requestedBy: "local" }, idempotencyKey: `scout:${packId}`, createdBy: "local" });
for (let i = 0; i < 60; i++) {
  await tick(env.DB, env, handlers, { workerId: "local" });
  const open = await env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')`).first<{ n: number }>();
  if (!open?.n) break;
}
const jobs = (await env.DB.prepare(`SELECT kind, status, error FROM jobs ORDER BY created_at`).all()).results;
const run = await env.DB.prepare(`SELECT id, status FROM research_runs WHERE kind='scout'`).first<{ id: string; status: string }>();
const report = run ? JSON.parse((await env.DB.prepare(`SELECT report_json FROM research_run_reports WHERE run_id=?`).bind(run.id).first<{ report_json: string }>())?.report_json ?? "null") : null;
const checks = run ? (await env.DB.prepare(`SELECT source_id, url, outcome, http_status, missing_json FROM research_source_checks WHERE run_id=? ORDER BY source_id`).bind(run.id).all()).results : [];
const board = await opportunityBoard(env.DB);
const briefs = await listBriefs(env.DB);
const result = { generatedAt: new Date().toISOString(), offline, packLabel: pack.label, jobs, report, sourceChecks: checks, board, briefs: briefs.map((b) => ({ id: b.id, niche: b.nicheId, version: b.version, status: b.status, content: b.content })) };
if (out) writeFileSync(resolve(out), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ status: run?.status, ranking: report?.ranking, sources: report?.sources, downgrades: report?.downgrades, errors: report?.errors, jobs: jobs.map((j: any) => `${j.kind}:${j.status}`) }, null, 2));
