/** Re-check a cited source: does the page still exist, and does it still show the figures the claim quotes? */
import type { Fetcher } from "./fetch.ts";
import type { PackSource, SourceCheck } from "./types.ts";

const ENTITIES: Record<string, string> = { "&amp;": "&", "&#36;": "$", "&dollar;": "$", "&nbsp;": " ", "&#39;": "'", "&quot;": '"', "&lt;": "<", "&gt;": ">" };
/** Visible-ish text, lower-cased, whitespace collapsed. Bounded so regex cost stays small on the free plan. */
export function normalizeText(html: string): string {
  return html.slice(0, 1_500_000)
    .replace(/<script[\s\S]*?<\/script>/gi, (m) => (/application\/ld\+json/i.test(m) ? m.replace(/<[^>]+>/g, " ") : " "))
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ").toLowerCase();
}

export function classify(status: number | null, ok: boolean, text: string, expect: string[] = []): Omit<SourceCheck, "sourceId" | "url"> {
  if (status === 404 || status === 410) return { outcome: "dead", httpStatus: status, missing: expect };
  if (!ok || status === null) return { outcome: "unreachable", httpStatus: status, missing: [] };
  if (!expect.length) return { outcome: "reachable", httpStatus: status, missing: [] };
  const body = normalizeText(text);
  const missing = expect.filter((s) => !body.includes(s.toLowerCase().replace(/\s+/g, " ")));
  return { outcome: missing.length ? "mismatch" : "confirmed", httpStatus: status, missing };
}

export async function checkSource(fetcher: Fetcher, s: PackSource): Promise<SourceCheck> {
  if (!/^https?:\/\//.test(s.url)) return { sourceId: s.id, url: s.url, outcome: "skipped", httpStatus: null, missing: [] };
  const r = await fetcher(s.url, { maxBytes: 1_200_000, timeoutMs: 15000 });
  return { sourceId: s.id, url: s.url, ...classify(r.status, r.ok, r.text, s.expect ?? []) };
}

/** Outcomes that count as evidence that a cited figure is wrong or gone. Unreachable (bot walls, 403/429, network) is not. */
export const HARD_FAIL = new Set(["dead", "mismatch"]);
