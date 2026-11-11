/**
 * Intelligence routes, mounted by services/api under /api/v1/intelligence after owner auth (same pattern as /operator).
 * Read models for Command stay on the platform's /opportunities and /briefs; these add pack submission and run detail.
 */
import { Hono, type Context } from "hono";
import { enqueue, type HandlerDef } from "../../../services/api/src/orchestration/engine.ts";
import { parseJson } from "../../../services/api/src/lib/util.ts";
import { connectorStates } from "./connectors.ts";
import { storePack } from "./handlers/scout.ts";
import { validatePack } from "./pack.ts";
import { storeObservations, validateObservation, type Observation } from "./observations.ts";

type Env = { DB: D1Database };
type Vars = { me?: { email: string; role: string } };
type C = Context<{ Bindings: Env; Variables: Vars }>;
const fail = (c: C, status: 400 | 403 | 404 | 422, code: string, message: string, details?: unknown) => c.json({ ok: false, error: { code, message, ...(details ? { details } : {}) } }, status);
const owner = (c: C) => (c.get("me")?.role === "owner" ? c.get("me")!.email : null);

export function intelligenceRoutes(handlers: () => Map<string, HandlerDef>) {
  const r = new Hono<{ Bindings: Env; Variables: Vars }>();

  r.get("/connectors", (c) => c.json({ ok: true, data: connectorStates(c.env as unknown as Record<string, unknown>) }));

  /** Submit an evidence pack and start a Scout run. Owner only. Idempotent on pack content. */
  r.post("/scout-runs", async (c) => {
    const who = owner(c); if (!who) return fail(c, 403, "forbidden", "owner only");
    const body = await c.req.json<{ pack?: unknown }>().catch(() => ({} as { pack?: unknown }));
    const errors = validatePack(body.pack);
    if (errors.length) return fail(c, 422, "bad_request", "invalid evidence pack", errors);
    const packId = await storePack(c.env.DB, body.pack as any, who);
    const job = await enqueue(c.env.DB, handlers(), { kind: "intel.scout.run", input: { packId, requestedBy: who }, idempotencyKey: `scout:${packId}`, createdBy: who });
    return c.json({ ok: true, data: { packId, jobId: job.id, created: job.created } });
  });

  /** Record dated observations for pages that bot-wall the Worker (e.g. Etsy). Owner only; the Scout uses them for 45 days. */
  r.post("/source-observations", async (c) => {
    const who = owner(c); if (!who) return fail(c, 403, "forbidden", "owner only");
    const body = await c.req.json<{ observations?: Observation[] }>().catch(() => ({} as { observations?: Observation[] }));
    const list = Array.isArray(body.observations) ? body.observations.slice(0, 200) : [];
    if (!list.length) return fail(c, 422, "bad_request", "observations[] required");
    const errors = list.flatMap((o, i) => validateObservation(o).map((e) => `#${i}: ${e}`));
    if (errors.length) return fail(c, 422, "bad_request", "invalid observations", errors.slice(0, 20));
    return c.json({ ok: true, data: await storeObservations(c.env.DB, list) });
  });

  r.get("/runs", async (c) => {
    const rows = (await c.env.DB.prepare(`SELECT r.*, p.report_json FROM research_runs r LEFT JOIN research_run_reports p ON p.run_id = r.id ORDER BY r.started_at DESC LIMIT 20`).all<Record<string, any>>()).results;
    return c.json({ ok: true, data: rows.map((x) => ({ id: x.id, kind: x.kind, status: x.status, startedAt: x.started_at, finishedAt: x.finished_at, unconnected: parseJson(x.sources_unconnected_json, []), report: parseJson(x.report_json, null) })) });
  });

  r.get("/runs/:id", async (c) => {
    const id = c.req.param("id");
    const run = await c.env.DB.prepare(`SELECT * FROM research_runs WHERE id = ?`).bind(id).first<Record<string, any>>();
    if (!run) return fail(c, 404, "not_found", "no such run");
    const [checks, signals, report] = await Promise.all([
      c.env.DB.prepare(`SELECT source_id, url, outcome, http_status, missing_json, checked_at FROM research_source_checks WHERE run_id = ? ORDER BY source_id`).bind(id).all<Record<string, any>>(),
      c.env.DB.prepare(`SELECT candidate, connector, subject, status, summary_json FROM research_signals WHERE run_id = ?`).bind(id).all<Record<string, any>>(),
      c.env.DB.prepare(`SELECT report_json FROM research_run_reports WHERE run_id = ?`).bind(id).first<{ report_json: string }>(),
    ]);
    return c.json({ ok: true, data: {
      id: run.id, kind: run.kind, status: run.status, startedAt: run.started_at, finishedAt: run.finished_at, unconnected: parseJson(run.sources_unconnected_json, []),
      sourceChecks: checks.results.map((x) => ({ sourceId: x.source_id, url: x.url, outcome: x.outcome, httpStatus: x.http_status, missing: parseJson(x.missing_json, []), checkedAt: x.checked_at })),
      signals: signals.results.map((x) => ({ candidate: x.candidate, connector: x.connector, subject: x.subject, status: x.status, summary: parseJson(x.summary_json, null) })),
      report: parseJson(report?.report_json ?? null, null),
    } });
  });
  return r;
}
