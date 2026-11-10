/** Shared helpers for Operator handlers: HTTP with timeouts, alerts, check rows, evidence. */
import { newId, nowIso } from "../../../services/api/src/lib/util.ts";

export { newId, nowIso };

export interface FetchResult { ok: boolean; status: number | null; text: string; latencyMs: number; error?: string; finalUrl?: string }
/** Injected HTTP reader. Read-only GETs only: Operator never POSTs to a site or platform without a publisher adapter. */
export type Fetcher = (url: string, opts?: { timeoutMs?: number; maxBytes?: number }) => Promise<FetchResult>;

export const UA = "FORGE-Operator/0.1 (+site health and SEO checks for the owner's own sites)";

export const defaultFetcher: Fetcher = async (url, opts = {}) => {
  const started = Date.now();
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", headers: { "user-agent": UA, accept: "text/html,application/xml,application/json;q=0.9,*/*;q=0.5" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) });
    const buf = await res.arrayBuffer();
    const text = new TextDecoder().decode(buf.slice(0, opts.maxBytes ?? 2_000_000));
    return { ok: res.ok, status: res.status, text, latencyMs: Date.now() - started, finalUrl: res.url };
  } catch (e) {
    return { ok: false, status: null, text: "", latencyMs: Date.now() - started, error: String((e as Error).message ?? e).slice(0, 300) };
  }
};

export type Severity = "critical" | "warning" | "info";
export interface Finding { code: string; severity: Severity; message: string }

export async function raiseAlert(db: D1Database, a: { key: string; severity: Severity; nicheId?: string | null; source: string; title: string; detail?: string; nextAction?: string; evidenceUrl?: string | null; needsOwner?: boolean }): Promise<void> {
  const at = nowIso();
  await db.prepare(`INSERT INTO alerts (id,severity,niche_id,source,title,detail,state,dedupe_key,first_seen,last_seen,next_action,evidence_url,needs_owner)
    VALUES (?,?,?,?,?,?,'open',?,?,?,?,?,?)
    ON CONFLICT(dedupe_key) DO UPDATE SET last_seen=excluded.last_seen, detail=excluded.detail, severity=excluded.severity, title=excluded.title,
      state=CASE WHEN alerts.state='resolved' THEN 'open' ELSE alerts.state END`)
    .bind(newId("al"), a.severity, a.nicheId ?? null, a.source, a.title, a.detail?.slice(0, 1000) ?? null, a.key, at, at, a.nextAction ?? null, a.evidenceUrl ?? null, a.needsOwner ? 1 : 0).run();
}

export async function resolveAlert(db: D1Database, key: string): Promise<number> {
  const r = await db.prepare(`UPDATE alerts SET state='resolved', last_seen=? WHERE dedupe_key=? AND state<>'resolved'`).bind(nowIso(), key).run();
  return Number(r.meta.changes ?? 0);
}

export async function resolveAlertsWithPrefix(db: D1Database, prefix: string, keep: Set<string>): Promise<number> {
  const open = (await db.prepare(`SELECT dedupe_key FROM alerts WHERE dedupe_key LIKE ? AND state<>'resolved'`).bind(`${prefix}%`).all<{ dedupe_key: string }>()).results;
  let n = 0;
  for (const o of open) if (!keep.has(o.dedupe_key)) n += await resolveAlert(db, o.dedupe_key);
  return n;
}

export async function recordCheck(db: D1Database, c: { kind: string; nicheId?: string | null; target: string; ok: boolean; status?: number | null; latencyMs?: number | null; findings?: Finding[]; jobId?: string; at?: string }): Promise<void> {
  await db.prepare(`INSERT INTO op_checks (id,check_kind,niche_id,target,ok,status_code,latency_ms,findings_json,job_id,checked_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(newId("chk"), c.kind, c.nicheId ?? null, c.target, c.ok ? 1 : 0, c.status ?? null, c.latencyMs ?? null, JSON.stringify(c.findings ?? []), c.jobId ?? null, c.at ?? nowIso()).run();
}

export async function addEvidence(db: D1Database, e: { subjectType: string; subjectId: string; claim: string; label: string; source: string; url?: string | null; collectedBy: string }): Promise<string> {
  const id = newId("ev");
  await db.prepare(`INSERT INTO evidence (id,subject_type,subject_id,claim,label,source,url,observed_at,collected_by) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(id, e.subjectType, e.subjectId, e.claim.slice(0, 500), e.label, e.source, e.url ?? null, nowIso(), e.collectedBy).run();
  return id;
}

export interface NicheRow { id: string; name: string; site_url: string | null; paused: number }
export async function activeNiches(db: D1Database, only?: string | null): Promise<NicheRow[]> {
  const rows = (await db.prepare(`SELECT id, name, site_url, paused FROM niches WHERE lifecycle IN ('live','building') ORDER BY id`).all<NicheRow>()).results;
  return rows.filter((n) => !n.paused && (!only || n.id === only));
}

export const joinUrl = (base: string, path: string): string => base.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);

/** Minimal tag/attribute extraction for our own static sites (no DOM in Workers). */
export function htmlFacts(html: string) {
  const one = (re: RegExp) => re.exec(html)?.[1]?.trim() ?? null;
  const attr = (tagRe: RegExp, name: string) => {
    const tag = tagRe.exec(html)?.[0];
    return tag ? new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] ?? null : null;
  };
  return {
    title: one(/<title[^>]*>([\s\S]*?)<\/title>/i),
    description: attr(/<meta[^>]+name\s*=\s*["']description["'][^>]*>/i, "content"),
    canonical: attr(/<link[^>]+rel\s*=\s*["']canonical["'][^>]*>/i, "href"),
    robots: attr(/<meta[^>]+name\s*=\s*["']robots["'][^>]*>/i, "content"),
    h1Count: (html.match(/<h1[\s>]/gi) ?? []).length,
    hasViewport: /<meta[^>]+name\s*=\s*["']viewport["']/i.test(html),
    lang: attr(/<html[^>]*>/i, "lang"),
  };
}

export const xmlTags = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))].map((m) => (m[1] ?? "").replace(/^<!\[CDATA\[|\]\]>$/g, "").trim());
