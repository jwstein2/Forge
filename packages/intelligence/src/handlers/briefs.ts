/**
 *   intel.brief.publish    validate an Audience & Market Brief against brief.schema.json and store it as a draft
 *   intel.source.recheck   weekly: re-check every source cited by the latest brief of each niche; alert on dead pages
 */
import { enqueue, NonRetryableError, type HandlerDef } from "../../../../services/api/src/orchestration/engine.ts";
import { storeBrief, validateBrief } from "../../../../services/api/src/domain/intelligence.ts";
import { newId, nowIso, parseJson } from "../../../../services/api/src/lib/util.ts";
import { SOURCE_BATCH } from "./scout.ts";

export function briefHandlers(handlers: () => Map<string, HandlerDef>): HandlerDef[] {
  const publish: HandlerDef = {
    kind: "intel.brief.publish", registryId: "FORGE-INTEL-BRIEF", runType: "deterministic", usesModel: false,
    steps: [{
      name: "store",
      async run({ db, input }) {
        const doc = input.brief as Record<string, any> | undefined;
        if (!doc) throw new NonRetryableError("input.brief required");
        const errs = validateBrief(doc);
        if (errs.length) throw new NonRetryableError(`brief invalid: ${errs.slice(0, 5).join("; ")}`);
        const dup = await db.prepare(`SELECT id, content_hash FROM market_briefs WHERE niche_id = ? AND version = ?`).bind(doc.niche, doc.version).first<{ id: string }>();
        if (dup) return { output: { briefId: dup.id, created: false, note: "this niche and version is already stored; bump the semver to change it" } };
        const b = await storeBrief(db, doc);
        return { output: { briefId: b.id, created: true, contentHash: b.contentHash } };
      },
    }],
  };

  const recheck: HandlerDef = {
    kind: "intel.source.recheck", registryId: "FORGE-INTEL-RECHECK", runType: "deterministic", usesModel: false,
    steps: [{
      name: "plan",
      async run({ db, jobId }) {
        const rows = (await db.prepare(`SELECT b.id, b.niche_id, b.content_json FROM market_briefs b
          WHERE b.status <> 'superseded' AND b.created_at = (SELECT MAX(created_at) FROM market_briefs x WHERE x.niche_id = b.niche_id)`).all<Record<string, any>>()).results;
        const seen = new Set<string>(); const sources: { id: string; url: string }[] = [];
        for (const r of rows) for (const s of parseJson<any>(r.content_json, {}).sources ?? []) {
          if (!/^https?:\/\//.test(s.url ?? "") || seen.has(s.url)) continue;
          seen.add(s.url); sources.push({ id: `${s.id}__${r.niche_id}`.slice(0, 120), url: s.url });
        }
        const runId = newId("run");
        await db.prepare(`INSERT INTO research_runs (id,kind,started_at,status,sources_unconnected_json,job_id,cost_cents) VALUES (?,?,?,'running','[]',?,0)`).bind(runId, "source_recheck", nowIso(), jobId).run();
        const h = handlers(); const deps: string[] = [];
        for (let i = 0; i < sources.length; i += SOURCE_BATCH) {
          deps.push((await enqueue(db, h, { kind: "intel.source.check", parentId: jobId, idempotencyKey: `${jobId}:src:${i}`, input: { runId, sources: sources.slice(i, i + SOURCE_BATCH) }, createdBy: `job:${jobId}`, maxAttempts: 2 })).id);
        }
        await enqueue(db, h, { kind: "intel.recheck.report", parentId: jobId, idempotencyKey: `${jobId}:report`, dependsOn: deps, input: { runId }, createdBy: `job:${jobId}`, maxAttempts: 2 });
        return { output: { runId, briefs: rows.length, sources: sources.length, batches: deps.length } };
      },
    }],
  };

  const report: HandlerDef = {
    kind: "intel.recheck.report", runType: "deterministic", usesModel: false,
    steps: [{
      name: "report",
      async run({ db, input }) {
        const runId = String(input.runId);
        const rows = (await db.prepare(`SELECT source_id, url, outcome FROM research_source_checks WHERE run_id = ?`).bind(runId).all<Record<string, any>>()).results;
        const dead = rows.filter((r) => r.outcome === "dead");
        const at = nowIso();
        const key = "intel:sources:dead";
        if (dead.length) {
          await db.prepare(`INSERT INTO alerts (id,severity,niche_id,source,title,detail,state,dedupe_key,first_seen,last_seen,next_action) VALUES (?,?,?,?,?,?,'open',?,?,?,?)
            ON CONFLICT(dedupe_key) DO UPDATE SET last_seen=excluded.last_seen, detail=excluded.detail, state=CASE WHEN alerts.state='resolved' THEN 'open' ELSE alerts.state END`)
            .bind(newId("al"), "info", null, "intel.source.recheck", `${dead.length} research source(s) cited in briefs no longer exist`,
              dead.slice(0, 20).map((d) => `${d.source_id}: ${d.url}`).join("\n"), key, at, at, "Bump the affected brief: replace or downgrade the claims that cite these sources.").run();
        } else {
          await db.prepare(`UPDATE alerts SET state='resolved', last_seen=? WHERE dedupe_key=? AND state<>'resolved'`).bind(at, key).run();
        }
        const status = rows.some((r) => r.outcome === "unreachable") ? "partial" : "succeeded";
        await db.prepare(`UPDATE research_runs SET status=?, finished_at=? WHERE id=?`).bind(status, at, runId).run();
        const counts: Record<string, number> = {};
        for (const r of rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
        return { output: { runId, status, counts } };
      },
    }],
  };
  return [publish, recheck, report];
}
