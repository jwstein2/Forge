import type { SourceFreshness } from "@forge/contracts";
import { nowIso, parseJson } from "../lib/util.ts";

/** Record how fresh a data source is, so every API response can state it. */
export async function recordSource(db: D1Database, s: SourceFreshness): Promise<void> {
  await db.prepare(`INSERT INTO system_controls (key,value_json,updated_by,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
    .bind(`source:${s.id}`, JSON.stringify(s), "adapter", nowIso()).run();
}

export const KNOWN_SOURCES: SourceFreshness[] = [
  { id: "registry", label: "FORGE registry (git, audit 2026-11-10)", mode: "seed", asOf: null },
  { id: "ledger.d1", label: "D1 sales ledger", mode: "unconnected", asOf: null },
  { id: "n8n", label: "n8n execution history", mode: "unconnected", asOf: null },
  { id: "lemonsqueezy", label: "Lemon Squeezy", mode: "unconnected", asOf: null, note: "No API access; store in test mode." },
  { id: "search_console", label: "Google Search Console", mode: "unconnected", asOf: null },
  { id: "kdp", label: "Amazon KDP royalties", mode: "unconnected", asOf: null },
];

export async function listSources(db: D1Database): Promise<SourceFreshness[]> {
  const rows = await db.prepare(`SELECT key, value_json FROM system_controls WHERE key LIKE 'source:%'`).all<{ key: string; value_json: string }>();
  const stored = new Map(rows.results.map((r) => [r.key.slice(7), parseJson<SourceFreshness | null>(r.value_json, null)]));
  return KNOWN_SOURCES.map((k) => stored.get(k.id) ?? k);
}
