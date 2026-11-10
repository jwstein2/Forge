/**
 * Operator HTTP routes. Mounted by services/api under /api/v1/operator AFTER its owner-auth middleware,
 * so every handler here already has an authenticated owner in c.get("me"). Handlers refuse if it is missing.
 * Envelope matches the platform contract: { ok, data } / { ok:false, error:{code,message} }.
 */
import { Hono, type Context } from "hono";
import { newId, nowIso } from "./lib.ts";
import { lintDraft, nichePrices, receiptRule, type Draft } from "./handlers/content.ts";

type Env = { DB: D1Database };
type Vars = { me?: { email: string; role: string } };
type C = Context<{ Bindings: Env; Variables: Vars }>;

const fail = (c: C, status: 400 | 403 | 404 | 409 | 422, code: string, message: string) => c.json({ ok: false, error: { code, message } }, status);
const owner = (c: C) => (c.get("me")?.role === "owner" ? c.get("me")!.email : null);
const parse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export function operatorRoutes() {
  const r = new Hono<{ Bindings: Env; Variables: Vars }>();

  r.get("/summaries", async (c) => {
    const rows = (await c.env.DB.prepare(`SELECT id, period_start, period_end, generated_at, body_json FROM op_summaries ORDER BY period_start DESC LIMIT ?`).bind(Math.min(Number(c.req.query("limit") ?? 12), 52)).all<Record<string, any>>()).results;
    return c.json({ ok: true, data: rows.map((x) => ({ id: x.id, periodStart: x.period_start, periodEnd: x.period_end, generatedAt: x.generated_at, body: parse(x.body_json) })) });
  });
  r.get("/summaries/latest", async (c) => {
    const x = await c.env.DB.prepare(`SELECT * FROM op_summaries ORDER BY period_start DESC LIMIT 1`).first<Record<string, any>>();
    return c.json({ ok: true, data: x ? { id: x.id, periodStart: x.period_start, periodEnd: x.period_end, generatedAt: x.generated_at, body: parse(x.body_json) } : null });
  });

  r.get("/schedules", async (c) => {
    const rows = (await c.env.DB.prepare(`SELECT s.*, j.status AS last_job_status, j.updated_at AS last_job_updated FROM op_schedules s LEFT JOIN jobs j ON j.id = s.last_job_id ORDER BY s.id`).all<Record<string, any>>()).results;
    return c.json({ ok: true, data: rows.map((s) => ({ id: s.id, kind: s.kind, nicheId: s.niche_id, spec: parse(s.spec_json), enabled: !!s.enabled, lastSlot: s.last_slot, lastJobId: s.last_job_id, lastJobStatus: s.last_job_status ?? null, lastJobUpdatedAt: s.last_job_updated ?? null })) });
  });

  r.get("/checks", async (c) => {
    const kind = c.req.query("kind"); const niche = c.req.query("niche");
    const rows = (await c.env.DB.prepare(`SELECT * FROM op_checks WHERE (? IS NULL OR check_kind = ?) AND (? IS NULL OR niche_id = ?) ORDER BY checked_at DESC LIMIT ?`)
      .bind(kind ?? null, kind ?? null, niche ?? null, niche ?? null, Math.min(Number(c.req.query("limit") ?? 100), 500)).all<Record<string, any>>()).results;
    return c.json({ ok: true, data: rows.map((x) => ({ id: x.id, kind: x.check_kind, nicheId: x.niche_id, target: x.target, ok: !!x.ok, statusCode: x.status_code, latencyMs: x.latency_ms, findings: parse(x.findings_json) ?? [], checkedAt: x.checked_at })) });
  });

  r.get("/content", async (c) => {
    const st = c.req.query("status"); const niche = c.req.query("niche");
    const rows = (await c.env.DB.prepare(`SELECT * FROM op_content_items WHERE (? IS NULL OR status = ?) AND (? IS NULL OR niche_id = ?) ORDER BY publish_by ASC, created_at ASC LIMIT 200`)
      .bind(st ?? null, st ?? null, niche ?? null, niche ?? null).all<Record<string, any>>()).results;
    return c.json({ ok: true, data: rows.map((x) => ({ id: x.id, nicheId: x.niche_id, channelId: x.channel_id, platform: x.platform, title: x.title, seasonEvent: x.season_event, briefRef: x.brief_ref, evidence: x.evidence_label, publishBy: x.publish_by, window: { start: x.window_start, end: x.window_end }, late: !!x.late, status: x.status, draft: parse(x.body_json), lint: parse(x.lint_json) ?? [], publisher: x.publisher, externalUrl: x.external_url, publishedAt: x.published_at, verifiedAt: x.verified_at, note: x.note })) });
  });

  /** Owner approves or rejects drafted items in one call (batch, so there is never a daily one-by-one queue). */
  r.post("/content/decide", async (c) => {
    const who = owner(c); if (!who) return fail(c, 403, "forbidden", "owner only");
    const b = await c.req.json<{ ids?: string[]; approve?: boolean; note?: string }>().catch(() => ({} as { ids?: string[]; approve?: boolean; note?: string }));
    if (!Array.isArray(b.ids) || !b.ids.length || typeof b.approve !== "boolean") return fail(c, 400, "bad_request", "ids[] and approve required");
    const results: { id: string; status: string }[] = [];
    for (const id of b.ids.slice(0, 100)) {
      const it = await c.env.DB.prepare(`SELECT status, body_json, niche_id FROM op_content_items WHERE id = ?`).bind(id).first<{ status: string; body_json: string | null; niche_id: string }>();
      if (!it) { results.push({ id, status: "not_found" }); continue; }
      if (!["drafted", "needs_revision"].includes(it.status) || !it.body_json) { results.push({ id, status: `skipped (${it.status})` }); continue; }
      if (b.approve) {
        const d = parse(it.body_json) as Draft; const lint = lintDraft(d, await nichePrices(c.env.DB, it.niche_id));
        if (lint.length) { results.push({ id, status: `refused: ${lint.join(", ")}` }); continue; }
      }
      const ap = newId("apr"); const at = nowIso();
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO approvals (id,scope,action,status,requested_by,decided_by,decided_at,boundary_json,created_at) VALUES (?,?,?,?,?,'owner',?,?,?)`).bind(ap, `publish:${id}`, "ops.content_publish", b.approve ? "approved" : "denied", "ops.content_draft", at, JSON.stringify({ contentId: id, by: who }), at),
        c.env.DB.prepare(`UPDATE op_content_items SET status=?, approval_id=?, note=?, updated_at=? WHERE id=?`).bind(b.approve ? "approved" : "rejected", ap, b.note ?? null, at, id),
      ]);
      results.push({ id, status: b.approve ? "approved" : "rejected" });
    }
    return c.json({ ok: true, data: results });
  });

  /** Owner records the URL of an item they posted by hand; ops.content_verify then confirms it. */
  r.post("/content/:id/published", async (c) => {
    if (!owner(c)) return fail(c, 403, "forbidden", "owner only");
    const b = await c.req.json<{ externalUrl?: string }>().catch(() => ({} as { externalUrl?: string }));
    if (!b.externalUrl || !/^https:\/\/[^\s]+$/.test(b.externalUrl)) return fail(c, 400, "bad_request", "externalUrl (https) required");
    const item = await c.env.DB.prepare(`SELECT i.platform, n.site_url FROM op_content_items i JOIN niches n ON n.id = i.niche_id WHERE i.id = ?`).bind(c.req.param("id")).first<{ platform: string; site_url: string | null }>();
    if (!item) return fail(c, 404, "not_found", "no such item");
    const rule = receiptRule(item.platform, b.externalUrl, item.site_url);
    if (!rule.ok) return fail(c, 422, "evidence_required", rule.reason);
    const res = await c.env.DB.prepare(`UPDATE op_content_items SET status='published', publisher=COALESCE(publisher,'manual'), external_url=?, published_at=?, updated_at=? WHERE id=? AND status IN ('approved','drafted')`).bind(b.externalUrl, nowIso(), nowIso(), c.req.param("id")).run();
    if (!Number(res.meta.changes)) return fail(c, 409, "conflict", "item not found or not in a publishable state");
    return c.json({ ok: true, data: { id: c.req.param("id"), status: "published", note: "Will be marked verified only after FORGE confirms the URL." } });
  });

  r.get("/policies", async (c) => {
    const rows = (await c.env.DB.prepare(`SELECT c.id AS channel_id, c.niche_id, c.platform, c.status, p.mode, p.publisher, p.daily_cap, p.approval_id, p.window_end, p.updated_at FROM channels c LEFT JOIN op_channel_policies p ON p.channel_id = c.id ORDER BY c.niche_id, c.platform`).all<Record<string, any>>()).results;
    return c.json({ ok: true, data: rows.map((x) => ({ channelId: x.channel_id, nicheId: x.niche_id, platform: x.platform, channelStatus: x.status, mode: x.mode ?? "draft_only", publisher: x.publisher ?? "dry_run", dailyCap: x.daily_cap ?? 0, approvalId: x.approval_id, windowEnd: x.window_end, updatedAt: x.updated_at })) });
  });

  /** Owner sets a channel's publishing boundary. 'standing' records the owner's approval with the boundary itself. */
  r.put("/policies/:channelId", async (c) => {
    const who = owner(c); if (!who) return fail(c, 403, "forbidden", "owner only");
    const id = c.req.param("channelId");
    const b = await c.req.json<{ mode?: string; publisher?: string; dailyCap?: number; windowEnd?: string | null; notes?: string }>().catch(() => ({} as Record<string, any>));
    if (!["off", "draft_only", "approval_each", "standing"].includes(String(b.mode))) return fail(c, 400, "bad_request", "mode must be off|draft_only|approval_each|standing");
    const cap = Number(b.dailyCap ?? 1); if (!Number.isInteger(cap) || cap < 0 || cap > 50) return fail(c, 400, "bad_request", "dailyCap 0..50");
    if (b.windowEnd != null && Number.isNaN(Date.parse(b.windowEnd))) return fail(c, 400, "bad_request", "windowEnd must be ISO");
    if (b.mode === "standing") {
      const end = b.windowEnd ? Date.parse(b.windowEnd) : NaN;
      if (!Number.isFinite(end) || end <= Date.now() || end > Date.now() + 90 * 86400000) return fail(c, 400, "bad_request", "standing requires windowEnd in the future and at most 90 days away");
    }
    if (!(await c.env.DB.prepare(`SELECT 1 AS x FROM channels WHERE id = ?`).bind(id).first())) return fail(c, 404, "not_found", "no such channel");
    const at = nowIso(); let approvalId: string | null = null;
    const stmts = [];
    if (b.mode === "standing") {
      approvalId = newId("apr");
      stmts.push(c.env.DB.prepare(`INSERT INTO approvals (id,scope,action,status,requested_by,decided_by,decided_at,boundary_json,expires_at,created_at) VALUES (?,?,?,'approved','owner','owner',?,?,?,?)`)
        .bind(approvalId, `channel:${id}`, "ops.content_publish:standing", at, JSON.stringify({ channelId: id, publisher: b.publisher ?? "dry_run", dailyCap: cap, windowEnd: b.windowEnd ?? null, by: who }), b.windowEnd ?? null, at));
    }
    stmts.push(c.env.DB.prepare(`INSERT INTO op_channel_policies (channel_id,mode,publisher,daily_cap,approval_id,window_end,notes,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(channel_id) DO UPDATE SET mode=excluded.mode, publisher=excluded.publisher, daily_cap=excluded.daily_cap, approval_id=excluded.approval_id, window_end=excluded.window_end, notes=excluded.notes, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .bind(id, b.mode, b.publisher ?? "dry_run", cap, approvalId, b.windowEnd ?? null, b.notes ?? null, who, at));
    stmts.push(c.env.DB.prepare(`INSERT INTO audit_log (id,actor,action,subject,detail,at) VALUES (?,?,?,?,?,?)`).bind(newId("aud"), who, "operator.policy.set", id, JSON.stringify(b), at));
    await c.env.DB.batch(stmts);
    return c.json({ ok: true, data: { channelId: id, mode: b.mode, approvalId } });
  });

  return r;
}
