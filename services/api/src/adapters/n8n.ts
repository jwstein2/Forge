/**
 * Read-only adapter for n8n execution history → FORGE `runs` (heartbeats with evidence links).
 * live: n8n public API with a FORGE-scoped read-only key (N8N_API_KEY). Unset → unconnected.
 * snapshot: dated export taken read-only through the n8n connector.
 */
import { recordSource } from "./sources.ts";
import { nowIso } from "../lib/util.ts";

export interface N8nExecution { workflowId: string; executionId: string; status: string; mode: string; startedAt: string; stoppedAt: string | null }
export interface N8nReader { mode: "live" | "snapshot" | "unconnected"; asOf: string | null; baseUrl: string | null; read(workflowIds: string[]): Promise<N8nExecution[]> }
export interface N8nSnapshot { _meta: { capturedAt: string; instance: string }; executions: N8nExecution[] }

export function snapshotN8n(s: N8nSnapshot): N8nReader {
  return { mode: "snapshot", asOf: s._meta.capturedAt, baseUrl: `https://${s._meta.instance}`, read: async (ids) => s.executions.filter((e) => ids.includes(e.workflowId)) };
}

export function liveN8n(baseUrl: string, apiKey: string, fetcher: typeof fetch = fetch, at = nowIso()): N8nReader {
  return {
    mode: "live", asOf: at, baseUrl,
    async read(ids) {
      const out: N8nExecution[] = [];
      for (const id of ids) {
        const res = await fetcher(`${baseUrl.replace(/\/$/, "")}/api/v1/executions?workflowId=${encodeURIComponent(id)}&limit=20`, { headers: { "X-N8N-API-KEY": apiKey, accept: "application/json" } });
        if (!res.ok) throw new Error(`n8n executions ${id}: HTTP ${res.status}`);
        const body = (await res.json()) as { data: { id: string | number; workflowId: string; status?: string; finished?: boolean; mode: string; startedAt: string; stoppedAt: string | null }[] };
        for (const e of body.data) out.push({ workflowId: e.workflowId, executionId: String(e.id), status: e.status ?? (e.finished ? "success" : "error"), mode: e.mode, startedAt: e.startedAt, stoppedAt: e.stoppedAt });
      }
      return out;
    },
  };
}

export const unconnectedN8n: N8nReader = { mode: "unconnected", asOf: null, baseUrl: null, read: async () => [] };

const mapStatus = (s: string): "success" | "failed" | "running" =>
  s === "success" ? "success" : s === "running" || s === "waiting" || s === "new" ? "running" : "failed";

export async function importN8n(db: D1Database, reader: N8nReader): Promise<number> {
  if (reader.mode === "unconnected") {
    await recordSource(db, { id: "n8n", label: "n8n execution history", mode: "unconnected", asOf: null, note: "No FORGE-scoped n8n API key or snapshot." });
    return 0;
  }
  const entries = (await db.prepare(`SELECT id, external_ref FROM registry_entries WHERE runner='n8n' AND external_ref IS NOT NULL`).all<{ id: string; external_ref: string }>()).results;
  const byWf = new Map(entries.map((e) => [e.external_ref, e.id]));
  const execs = await reader.read([...byWf.keys()]);
  const source = reader.mode === "live" ? "n8n.live" : "n8n.snapshot";
  const stmts = execs.filter((e) => byWf.has(e.workflowId)).map((e) => db.prepare(
    `INSERT INTO runs (id,registry_id,started_at,finished_at,status,evidence_url,source,external_id) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source, external_id) DO NOTHING`,
  ).bind(`run_n8n_${e.executionId}`, byWf.get(e.workflowId), e.startedAt, e.stoppedAt, mapStatus(e.status),
    reader.baseUrl ? `${reader.baseUrl}/workflow/${e.workflowId}/executions/${e.executionId}` : null, source, e.executionId));
  if (stmts.length) await db.batch(stmts);
  await recordSource(db, { id: "n8n", label: "n8n execution history", mode: reader.mode, asOf: reader.asOf });
  return stmts.length;
}
