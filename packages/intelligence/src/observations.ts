/**
 * Dated source observations recorded outside the Worker (see migration 0201). They stand in for a Worker check only when
 * that check could not read the page (unreachable or skipped), and only while fresh. An observation never overrides a
 * Worker check that did read the page.
 */
import { canonicalJson, newId, nowIso, parseJson, sha256Hex } from "../../../services/api/src/lib/util.ts";
import type { SourceCheck } from "./types.ts";

export const OBS_MAX_AGE_DAYS = 45;
/** Hosts that answer automated fetches with a bot wall (403). The Worker does not GET them; observations stand in. */
export const ASSISTED_HOSTS = [/(^|\.)etsy\.com$/i];
export const isAssisted = (url: string, recheck?: string) => {
  if (recheck === "assisted") return true;
  if (recheck === "auto") return false;
  try { const h = new URL(url).hostname; return ASSISTED_HOSTS.some((re) => re.test(h)); } catch { return false; }
};

export interface Observation { url: string; observed_at: string; observed_by: string; method: "assisted_fetch" | "etsy_open_api" | "owner_check"; outcome: "confirmed" | "reachable" | "mismatch" | "dead"; figures?: Record<string, unknown>; missing?: string[]; note?: string }

export function validateObservation(o: Partial<Observation>): string[] {
  const e: string[] = [];
  if (!/^https?:\/\//.test(o.url ?? "")) e.push("url must be http(s)");
  if (!o.observed_at || Number.isNaN(Date.parse(o.observed_at))) e.push("observed_at must be an ISO time");
  if (!o.observed_by) e.push("observed_by required");
  if (!["assisted_fetch", "etsy_open_api", "owner_check"].includes(String(o.method))) e.push("method must be assisted_fetch, etsy_open_api or owner_check");
  if (!["confirmed", "reachable", "mismatch", "dead"].includes(String(o.outcome))) e.push("outcome must be confirmed, reachable, mismatch or dead");
  return e;
}

export async function storeObservations(db: D1Database, list: Observation[]): Promise<{ stored: number; duplicates: number }> {
  let stored = 0, duplicates = 0;
  for (const o of list) {
    const errs = validateObservation(o);
    if (errs.length) throw new Error(`invalid observation for ${o.url}: ${errs.join("; ")}`);
    const hash = await sha256Hex(canonicalJson(o));
    const r = await db.prepare(`INSERT INTO research_source_observations (id,url,observed_at,observed_by,method,outcome,figures_json,missing_json,note,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(content_hash) DO NOTHING`)
      .bind(newId("rso"), o.url, o.observed_at, o.observed_by, o.method, o.outcome, JSON.stringify(o.figures ?? {}), JSON.stringify(o.missing ?? []), o.note ?? null, hash, nowIso()).run();
    if ((r.meta?.changes ?? 0) > 0) stored++; else duplicates++;
  }
  return { stored, duplicates };
}

/** Replace unreachable/skipped checks with the latest fresh observation of the same URL. Stale observations are reported, not used. */
export async function effectiveChecks(db: D1Database, checks: SourceCheck[], now: Date): Promise<{ checks: SourceCheck[]; assisted: number; stale: string[] }> {
  const need = checks.filter((c) => c.outcome === "unreachable" || c.outcome === "skipped");
  if (!need.length) return { checks, assisted: 0, stale: [] };
  const urls = [...new Set(need.map((c) => c.url))];
  const latest = new Map<string, Record<string, any>>();
  for (let i = 0; i < urls.length; i += 50) {
    const part = urls.slice(i, i + 50);
    const rows = (await db.prepare(`SELECT url, observed_at, method, outcome, missing_json, note FROM research_source_observations WHERE url IN (${part.map(() => "?").join(",")}) ORDER BY observed_at DESC`).bind(...part).all<Record<string, any>>()).results;
    for (const r of rows) if (!latest.has(r.url)) latest.set(r.url, r);
  }
  const cutoff = now.getTime() - OBS_MAX_AGE_DAYS * 86_400_000;
  let assisted = 0; const stale: string[] = [];
  const out = checks.map((c) => {
    if (c.outcome !== "unreachable" && c.outcome !== "skipped") return c;
    const o = latest.get(c.url);
    if (!o) return c;
    if (Date.parse(o.observed_at) < cutoff) { stale.push(c.sourceId); return c; }
    assisted++;
    return { ...c, outcome: o.outcome, missing: parseJson<string[]>(o.missing_json, []), via: "observation" as const, observedAt: o.observed_at, note: `${o.method}${o.note ? `: ${o.note}` : ""}` };
  });
  return { checks: out, assisted, stale };
}
