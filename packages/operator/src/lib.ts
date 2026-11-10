/** Shared helpers for Operator handlers: HTTP with timeouts, alerts, check rows, evidence. */
import { newId, nowIso } from "../../../services/api/src/lib/util.ts";

export { newId, nowIso };

/** probeError: the request failed inside FORGE's own runtime (subrequest limit, Worker internal error), so it says
 *  nothing about the target. Callers record UNKNOWN for it, never "down" (QA-008 ST1). */
export interface FetchResult { ok: boolean; status: number | null; text: string; latencyMs: number; error?: string; finalUrl?: string; probeError?: boolean }

const PROBE_ERROR = /too many subrequests|subrequest|exceeded (its |the )?(cpu|memory|time)? ?limit|worker (exceeded|threw)|internal error|script will never generate a response|network connection lost|TypeError: fetch failed/i;
export const isProbeError = (message: string) => PROBE_ERROR.test(message);
/** Injected HTTP reader. Read-only GETs only: Operator never POSTs to a site or platform without a publisher adapter. */
export type Fetcher = (url: string, opts?: { timeoutMs?: number; maxBytes?: number }) => Promise<FetchResult>;

export const UA = "FORGE-Operator/0.1 (+site health and SEO checks for the owner's own sites)";

export const defaultFetcher: Fetcher = async (url, opts = {}) => {
  const started = Date.now();
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", headers: { "user-agent": UA, accept: "text/html,application/xml,application/json;q=0.9,*/*;q=0.5" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) });
    // Stream and stop at maxBytes so a large page costs neither download nor decode time past the cap.
    const cap = opts.maxBytes ?? 2_000_000; const chunks: Uint8Array[] = []; let got = 0;
    const reader = res.body?.getReader();
    if (reader) {
      while (got < cap) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.byteLength; }
      if (got >= cap) await reader.cancel().catch(() => undefined);
    }
    const buf = new Uint8Array(Math.min(got, cap)); let off = 0;
    for (const c of chunks) { const n = Math.min(c.byteLength, buf.length - off); if (n <= 0) break; buf.set(c.subarray(0, n), off); off += n; }
    const text = new TextDecoder().decode(buf);
    return { ok: res.ok, status: res.status, text, latencyMs: Date.now() - started, finalUrl: res.url };
  } catch (e) {
    const error = String((e as Error).message ?? e).slice(0, 300);
    return { ok: false, status: null, text: "", latencyMs: Date.now() - started, error, probeError: isProbeError(error) };
  }
};

export type Severity = "critical" | "warning" | "info";
export interface Finding { code: string; severity: Severity; message: string }

export type AlertInput = { key: string; severity: Severity; nicheId?: string | null; source: string; title: string; detail?: string; nextAction?: string; evidenceUrl?: string | null; needsOwner?: boolean };

/** Statement builders, so a job can write all its rows in one db.batch() (one subrequest instead of one per row). */
export function alertStmt(db: D1Database, a: AlertInput): D1PreparedStatement {
  const at = nowIso();
  return db.prepare(`INSERT INTO alerts (id,severity,niche_id,source,title,detail,state,dedupe_key,first_seen,last_seen,next_action,evidence_url,needs_owner)
    VALUES (?,?,?,?,?,?,'open',?,?,?,?,?,?)
    ON CONFLICT(dedupe_key) DO UPDATE SET last_seen=excluded.last_seen, detail=excluded.detail, severity=excluded.severity, title=excluded.title,
      state=CASE WHEN alerts.state='resolved' THEN 'open' ELSE alerts.state END`)
    .bind(newId("al"), a.severity, a.nicheId ?? null, a.source, a.title, a.detail?.slice(0, 1000) ?? null, a.key, at, at, a.nextAction ?? null, a.evidenceUrl ?? null, a.needsOwner ? 1 : 0);
}
export const resolveStmt = (db: D1Database, key: string): D1PreparedStatement =>
  db.prepare(`UPDATE alerts SET state='resolved', last_seen=? WHERE dedupe_key=? AND state<>'resolved'`).bind(nowIso(), key);

export async function raiseAlert(db: D1Database, a: AlertInput): Promise<void> { await alertStmt(db, a).run(); }

export async function resolveAlert(db: D1Database, key: string): Promise<number> {
  const r = await resolveStmt(db, key).run();
  return Number(r.meta.changes ?? 0);
}

/** Runs collected statements in one batch; returns the total rows changed by the resolve statements given by index. */
export async function flush(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  return stmts.length ? db.batch(stmts) : [];
}

export async function resolveAlertsWithPrefix(db: D1Database, prefix: string, keep: Set<string>): Promise<number> {
  const open = (await db.prepare(`SELECT dedupe_key FROM alerts WHERE dedupe_key LIKE ? AND state<>'resolved'`).bind(`${prefix}%`).all<{ dedupe_key: string }>()).results;
  let n = 0;
  for (const o of open) if (!keep.has(o.dedupe_key)) n += await resolveAlert(db, o.dedupe_key);
  return n;
}

export type CheckInput = { kind: string; nicheId?: string | null; target: string; ok: boolean | null; status?: number | null; latencyMs?: number | null; findings?: Finding[]; jobId?: string; at?: string };
/** ok: null records UNKNOWN (the check could not run), which needs migration 0102. */
export function checkStmt(db: D1Database, c: CheckInput): D1PreparedStatement {
  return db.prepare(`INSERT INTO op_checks (id,check_kind,niche_id,target,ok,status_code,latency_ms,findings_json,job_id,checked_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(newId("chk"), c.kind, c.nicheId ?? null, c.target, c.ok === null ? null : c.ok ? 1 : 0, c.status ?? null, c.latencyMs ?? null, JSON.stringify(c.findings ?? []), c.jobId ?? null, c.at ?? nowIso());
}
export async function recordCheck(db: D1Database, c: CheckInput): Promise<void> { await checkStmt(db, c).run(); }

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
export function htmlFacts(fullHtml: string) {
  const html = fullHtml.length > 64_000 ? fullHtml.slice(0, 64_000) : fullHtml; // regex cost stays bounded
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
