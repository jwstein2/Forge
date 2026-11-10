/**
 * FORGE API (Hono). Mounted at /api/v1. Read-mostly: the only writes are owner controls
 * (pause/resume, emergency stop, approvals, status changes with evidence, enqueue) and signed heartbeats.
 */
import { Hono, type Context } from "hono";
import type { ApiErr, ErrorCode, Me, ResponseMeta, SourceFreshness } from "@forge/contracts";
import { API_VERSION } from "@forge/contracts";
import type { Env } from "./lib/env.ts";
import { AuthError, authenticate, type JwksFetcher } from "./lib/auth.ts";
import { parsePeriod } from "./lib/metric.ts";
import { hmacSha256Hex, newId, nowIso, parseJson, timingSafeEqualHex } from "./lib/util.ts";
import { listSources } from "./adapters/sources.ts";
import { nicheDetail, portfolioSummary, recentActivity, type Sources } from "./domain/portfolio.ts";
import { financials } from "./domain/finance.ts";
import { dailySeries } from "./domain/series.ts";
import { listRegistry, listRuns } from "./domain/registry.ts";
import { evidenceFor, listAccounts, listAlerts, listBudgets, listChannels, listCosts, listIntegrations, listProducts, mapEvidence } from "./domain/records.ts";
import { buildBoard, buildDetail, listBriefs, opportunityBoard, storeBrief, validateBrief } from "./domain/intelligence.ts";
import { decideApproval, enqueue, EnqueueError, getJob, tick, type HandlerDef } from "./orchestration/engine.ts";

type Vars = { me: Me };
type C = Context<{ Bindings: Env; Variables: Vars }>;

export interface AppDeps { handlers: Map<string, HandlerDef>; jwksFetcher?: JwksFetcher }

const STATUS = { unauthorized: 401, forbidden: 403, not_found: 404, bad_request: 400, conflict: 409, evidence_required: 422, system_paused: 423, internal: 500 } as const;

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>().basePath("/api/v1");

  const sources = async (c: C): Promise<Sources> => {
    const all = await listSources(c.env.DB);
    return { all, ledger: all.find((s) => s.id === "ledger.d1")!, n8n: all.find((s) => s.id === "n8n")! };
  };
  const meta = (c: C, src: SourceFreshness[]): ResponseMeta => ({ apiVersion: API_VERSION, environment: c.env.ENVIRONMENT, generatedAt: nowIso(), sources: src });
  const ok = async <T>(c: C, data: T, status: 200 | 201 = 200) => c.json({ ok: true, data, meta: meta(c, (await sources(c)).all) }, status);
  const err = (c: C, code: ErrorCode, message: string, details?: unknown) =>
    c.json({ ok: false, error: { code, message, ...(details ? { details } : {}) } } satisfies ApiErr, STATUS[code]);
  const audit = (c: C, action: string, subject: string, detail?: unknown) =>
    c.env.DB.prepare(`INSERT INTO audit_log (id,actor,action,subject,detail,at) VALUES (?,?,?,?,?,?)`)
      .bind(newId("aud"), c.get("me")?.email ?? "system", action, subject, detail ? JSON.stringify(detail) : null, nowIso()).run();

  app.onError((e, c) => {
    console.error("api error", (e as Error).message); // never log request bodies or secrets
    return err(c as C, "internal", "internal error");
  });
  app.notFound((c) => err(c as C, "not_found", "no such route"));

  // Security headers on every response (QA-002 R6). A JSON API: nothing may be framed, sniffed or cached.
  app.use("*", async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set("x-content-type-options", "nosniff");
    h.set("x-frame-options", "DENY");
    h.set("referrer-policy", "no-referrer");
    h.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    h.set("cache-control", "no-store");
    if (c.env.ENVIRONMENT !== "development" && c.env.ENVIRONMENT !== "test") h.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  });

  // ---------- public ----------
  app.get("/health", (c) => c.json({ ok: true, data: { status: "ok", environment: c.env.ENVIRONMENT, apiVersion: API_VERSION } }));

  // Signed heartbeat from an external runner (n8n): HMAC-SHA256 of the raw body in X-Forge-Signature.
  app.post("/ingest/heartbeat", async (c) => {
    const secret = c.env.HEARTBEAT_SECRET;
    if (!secret) return err(c, "forbidden", "heartbeat ingestion not configured");
    const raw = await c.req.text();
    const sig = (c.req.header("x-forge-signature") ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sig) || !timingSafeEqualHex(sig, await hmacSha256Hex(secret, raw))) return err(c, "unauthorized", "bad signature");
    const b = parseJson<Record<string, any>>(raw, {});
    if (!b.registryId || !b.startedAt || !["success", "failed", "running", "timeout", "skipped"].includes(b.status)) return err(c, "bad_request", "registryId, startedAt, status required");
    const entry = await c.env.DB.prepare(`SELECT id FROM registry_entries WHERE id = ?`).bind(b.registryId).first();
    if (!entry) return err(c, "not_found", "unknown registry entry");
    await c.env.DB.prepare(`INSERT INTO runs (id,registry_id,started_at,finished_at,status,evidence_url,model_cost_cents,error,source,external_id) VALUES (?,?,?,?,?,?,?,?,'heartbeat',?) ON CONFLICT(source, external_id) DO NOTHING`)
      .bind(newId("run"), b.registryId, b.startedAt, b.finishedAt ?? null, b.status, b.evidenceUrl ?? null, b.modelCostCents ?? null, b.error ? String(b.error).slice(0, 500) : null, String(b.externalId ?? newId("hb"))).run();
    return c.json({ ok: true, data: { recorded: true } }, 201);
  });

  // ---------- owner-authenticated ----------
  app.use("*", async (c, next) => {
    try { c.set("me", await authenticate(c.req.raw, c.env, deps.jwksFetcher)); }
    catch (e) {
      if (e instanceof AuthError) return err(c as C, e.status === 403 ? "forbidden" : "unauthorized", e.message);
      throw e;
    }
    await next();
  });

  app.get("/me", (c) => ok(c, c.get("me")));
  app.get("/sources", async (c) => ok(c, (await sources(c)).all));

  const portfolio = async (c: C) => ok(c, await portfolioSummary(c.env.DB, parsePeriod(c.req.query("period")), await sources(c)));
  app.get("/portfolio/summary", portfolio);
  app.get("/portfolio", portfolio); // alias used by apps/command
  app.get("/activity", async (c) => ok(c, await recentActivity(c.env.DB, Math.min(Number(c.req.query("limit") ?? 50) || 50, 200), c.req.query("niche"))));

  app.get("/niches", async (c) => {
    const s = await portfolioSummary(c.env.DB, parsePeriod(c.req.query("period")), await sources(c));
    return ok(c, s.niches);
  });
  app.get("/niches/:id", async (c) => {
    const d = await nicheDetail(c.env.DB, c.req.param("id"), parsePeriod(c.req.query("period")), await sources(c));
    return d ? ok(c, d) : err(c, "not_found", "unknown niche");
  });
  app.get("/financials", async (c) => {
    const niche = c.req.query("niche");
    return ok(c, await financials(c.env.DB, niche && niche !== "portfolio" ? niche : null, parsePeriod(c.req.query("period")), (await sources(c)).ledger));
  });
  app.get("/series", async (c) => {
    const metricName = c.req.query("metric");
    if (metricName !== "revenue" && metricName !== "page_views") return err(c, "bad_request", "metric must be revenue or page_views");
    const niche = c.req.query("niche");
    return ok(c, await dailySeries(c.env.DB, metricName, niche && niche !== "portfolio" ? niche : null, parsePeriod(c.req.query("period") ?? "last30"), (await sources(c)).ledger));
  });
  app.get("/products", async (c) => ok(c, await listProducts(c.env.DB, c.req.query("niche"))));
  app.get("/channels", async (c) => ok(c, await listChannels(c.env.DB, c.req.query("niche"))));
  app.get("/integrations", async (c) => ok(c, await listIntegrations(c.env.DB, c.req.query("niche"))));
  app.get("/accounts", async (c) => ok(c, await listAccounts(c.env.DB)));
  app.get("/costs", async (c) => ok(c, await listCosts(c.env.DB, c.req.query("niche"))));
  app.get("/budgets", async (c) => ok(c, await listBudgets(c.env.DB)));
  app.get("/alerts", async (c) => ok(c, await listAlerts(c.env.DB, { state: c.req.query("state"), nicheId: c.req.query("niche") })));
  app.post("/alerts/:id/acknowledge", async (c) => {
    const r = await c.env.DB.prepare(`UPDATE alerts SET state='acknowledged' WHERE id=? AND state='open'`).bind(c.req.param("id")).run();
    if (!Number(r.meta.changes)) return err(c, "not_found", "no open alert with that id");
    await audit(c, "alert.acknowledge", c.req.param("id"));
    return ok(c, { acknowledged: true });
  });

  app.get("/evidence", async (c) => {
    const t = c.req.query("subjectType"); const id = c.req.query("subjectId");
    if (t && id) return ok(c, await evidenceFor(c.env.DB, t, id));
    const rows = (await c.env.DB.prepare(`SELECT * FROM evidence ORDER BY observed_at DESC LIMIT 200`).all<Record<string, any>>()).results;
    return ok(c, rows.map(mapEvidence));
  });

  // ---------- registry (agents, workflows, scheduled jobs) ----------
  app.get("/jobs", async (c) => ok(c, await listRegistry(c.env.DB, { nicheId: c.req.query("niche") ?? null, includeShared: true, n8n: (await sources(c)).n8n })));
  app.get("/jobs/:id/runs", async (c) => ok(c, await listRuns(c.env.DB, c.req.param("id"))));
  const setPaused = (paused: boolean) => async (c: C) => {
    const id = c.req.param("id")!;
    const e = await c.env.DB.prepare(`SELECT pausable FROM registry_entries WHERE id = ?`).bind(id).first<{ pausable: number }>();
    if (!e) return err(c, "not_found", "unknown job");
    if (!e.pausable) return err(c, "conflict", "This job runs outside FORGE's control (for example in n8n); pause it in its own runner. FORGE will not claim a pause it cannot enforce.");
    await c.env.DB.prepare(`UPDATE registry_entries SET paused=?, updated_at=? WHERE id=?`).bind(paused ? 1 : 0, nowIso(), id).run();
    await audit(c, paused ? "job.pause" : "job.resume", id);
    return ok(c, { id, paused });
  };
  app.post("/jobs/:id/pause", setPaused(true));
  app.post("/jobs/:id/resume", setPaused(false));

  // Status changes: TESTED/LIVE require evidence. Nothing is silently relabelled.
  app.post("/status", async (c) => {
    const b = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>));
    const table = ({ product: "products", registry: "registry_entries" } as Record<string, string>)[b.subjectType];
    const allowed = ["PROPOSED", "BUILT", "TESTED", "LIVE", "FAILED", "UNVERIFIED"];
    if (!table || !b.subjectId || !allowed.includes(b.toStatus)) return err(c, "bad_request", "subjectType (product|registry), subjectId, toStatus required");
    const cur = await c.env.DB.prepare(`SELECT status FROM ${table} WHERE id = ?`).bind(b.subjectId).first<{ status: string }>();
    if (!cur) return err(c, "not_found", "unknown subject");
    let evidenceId: string | null = null;
    if (b.evidence) {
      if (!b.evidence.claim || !b.evidence.source) return err(c, "bad_request", "evidence.claim and evidence.source required");
      evidenceId = newId("ev");
      await c.env.DB.prepare(`INSERT INTO evidence (id,subject_type,subject_id,claim,label,source,url,observed_at,collected_by) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(evidenceId, b.subjectType, b.subjectId, b.evidence.claim, b.toStatus, b.evidence.source, b.evidence.url ?? null, nowIso(), c.get("me").email).run();
    }
    if ((b.toStatus === "TESTED" || b.toStatus === "LIVE") && !evidenceId) return err(c, "evidence_required", `${b.toStatus} requires evidence (claim, source, url).`);
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO status_history (id,subject_type,subject_id,from_status,to_status,evidence_id,changed_by,changed_at) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(newId("sh"), b.subjectType, b.subjectId, cur.status, b.toStatus, evidenceId, c.get("me").email, nowIso()),
      c.env.DB.prepare(`UPDATE ${table} SET status=?, updated_at=? WHERE id=?`).bind(b.toStatus, nowIso(), b.subjectId),
    ]);
    return ok(c, { subjectId: b.subjectId, from: cur.status, to: b.toStatus, evidenceId });
  });

  // ---------- intelligence & builder ----------
  app.get("/opportunities", async (c) => ok(c, await opportunityBoard(c.env.DB)));
  app.get("/briefs", async (c) => ok(c, await listBriefs(c.env.DB, c.req.query("niche"))));
  app.post("/briefs", async (c) => {
    const doc = await c.req.json().catch(() => null);
    const errors = validateBrief(doc);
    if (errors.length) return err(c, "bad_request", "brief does not match brief.schema.json", errors);
    try { return ok(c, await storeBrief(c.env.DB, doc as Record<string, any>), 201); }
    catch (e) { if (/UNIQUE/i.test(String((e as Error).message))) return err(c, "conflict", "this niche/version already exists; bump the version"); throw e; }
  });
  app.get("/builds", async (c) => ok(c, await buildBoard(c.env.DB)));
  app.get("/builds/:id", async (c) => {
    const r = await c.env.DB.prepare(`SELECT * FROM builds WHERE id = ?`).bind(c.req.param("id")).first<Record<string, any>>();
    return r ? ok(c, await buildDetail(c.env.DB, r)) : err(c, "not_found", "unknown build");
  });

  // ---------- orchestration ----------
  app.post("/orchestration/jobs", async (c) => {
    const b = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>));
    if (!b.kind || !deps.handlers.has(b.kind)) return err(c, "bad_request", `kind must be one of: ${[...deps.handlers.keys()].join(", ")}`);
    let r: { id: string; created: boolean };
    try { r = await enqueue(c.env.DB, deps.handlers, { kind: b.kind, input: b.input ?? {}, nicheId: b.nicheId ?? null, idempotencyKey: b.idempotencyKey, createdBy: c.get("me").email }); }
    catch (e) { if (e instanceof EnqueueError) return err(c, "conflict", e.message); throw e; }
    await audit(c, "job.enqueue", r.id, { kind: b.kind });
    return ok(c, r, r.created ? 201 : 200);
  });
  app.get("/orchestration/jobs", async (c) => {
    const rows = (await c.env.DB.prepare(`SELECT id FROM jobs ORDER BY created_at DESC LIMIT 50`).all<{ id: string }>()).results;
    return ok(c, await Promise.all(rows.map((r) => getJob(c.env.DB, r.id))));
  });
  app.get("/orchestration/jobs/:id", async (c) => {
    const j = await getJob(c.env.DB, c.req.param("id"));
    return j ? ok(c, j) : err(c, "not_found", "unknown job");
  });
  // Manual tick: development/test only. Staging/production run ticks from the cron trigger.
  app.post("/orchestration/tick", async (c) => {
    if (c.env.ENVIRONMENT !== "development" && c.env.ENVIRONMENT !== "test") return err(c, "forbidden", "manual tick is development-only");
    return ok(c, await tick(c.env.DB, c.env, deps.handlers, { workerId: "manual" }));
  });
  app.get("/approvals", async (c) => ok(c, (await c.env.DB.prepare(`SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100`).all()).results));
  app.post("/approvals/:id/decide", async (c) => {
    const b = await c.req.json<{ approve?: boolean }>().catch(() => ({} as { approve?: boolean }));
    if (typeof b.approve !== "boolean") return err(c, "bad_request", "approve: boolean required");
    await decideApproval(c.env.DB, c.req.param("id"), b.approve);
    await audit(c, b.approve ? "approval.approve" : "approval.deny", c.req.param("id"));
    return ok(c, { id: c.req.param("id"), approved: b.approve });
  });

  // ---------- emergency stop ----------
  app.get("/control", async (c) => {
    const r = await c.env.DB.prepare(`SELECT value_json, updated_by, updated_at FROM system_controls WHERE key='global_pause'`).first<Record<string, any>>();
    const v = parseJson<Record<string, any>>(r?.value_json, {});
    return ok(c, { globalPause: !!v.paused, pausedAt: v.paused ? r?.updated_at : null, pausedBy: v.paused ? r?.updated_by : null, reason: v.reason ?? null });
  });
  const setGlobal = (paused: boolean) => async (c: C) => {
    const b = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    await c.env.DB.prepare(`INSERT INTO system_controls (key,value_json,updated_by,updated_at) VALUES ('global_pause',?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .bind(JSON.stringify({ paused, reason: b.reason ?? null }), c.get("me").email, nowIso()).run();
    if (!paused) await c.env.DB.prepare(`UPDATE jobs SET status='queued', updated_at=? WHERE status='paused'`).bind(nowIso()).run();
    await audit(c, paused ? "system.emergency_stop" : "system.resume", "global_pause", b);
    return ok(c, { globalPause: paused });
  };
  app.post("/control/emergency-stop", setGlobal(true));
  app.post("/control/resume", setGlobal(false));

  return app;
}
