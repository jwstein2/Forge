/**
 * Read-only adapter for the EXISTING sales ledger (Worker "quiltplankit-sales", D1 "quiltplankit-sales").
 * FORGE never writes to the ledger. Three modes:
 *   - live:        a read-only D1 binding (LEDGER_DB) — staging only, after owner approval
 *   - snapshot:    a dated JSON export taken read-only (fixtures/ledger-snapshot-*.json)
 *   - unconnected: nothing available → the API reports revenue as 'unconnected', never $0
 */
import { recordSource } from "./sources.ts";
import { nowIso } from "../lib/util.ts";

export interface LedgerSale {
  id: string; event: string; order_id: string; test_mode: number; currency: string;
  total_cents: number; tax_cents: number; refunded_cents: number; product: string;
  created_at: string; received_at: string; source: string | null; campaign: string | null; vertical: string;
  /** Added to the live ledger 2026-11-10; absent in older snapshots (treated as 0). */
  owner_test?: number | null;
}
export interface LedgerEvent { day: string; name: string; path: string; source: string; count: number }
export interface LedgerReader {
  mode: "live" | "snapshot" | "unconnected";
  asOf: string | null;
  readSales(): Promise<LedgerSale[]>;
  readEvents(): Promise<LedgerEvent[]>;
}
export interface LedgerSnapshot { _meta: { capturedAt: string }; sales: LedgerSale[]; events: LedgerEvent[] }

export function snapshotLedger(s: LedgerSnapshot): LedgerReader {
  return { mode: "snapshot", asOf: s._meta.capturedAt, readSales: async () => s.sales, readEvents: async () => s.events };
}

/** SELECT-only access to a D1 binding of the live ledger. */
export function d1Ledger(ledger: D1Database, at = nowIso()): LedgerReader {
  return {
    mode: "live", asOf: at,
    readSales: async () => (await ledger.prepare(`SELECT id,event,order_id,test_mode,currency,total_cents,tax_cents,refunded_cents,product,created_at,received_at,source,campaign,vertical,owner_test FROM sales`).all<LedgerSale>()).results,
    readEvents: async () => (await ledger.prepare(`SELECT day,name,path,source,count FROM events`).all<LedgerEvent>()).results,
  };
}

const SALES_SQL = `SELECT id,event,order_id,test_mode,currency,total_cents,tax_cents,refunded_cents,product,created_at,received_at,source,campaign,vertical,owner_test FROM sales`;
const EVENTS_SQL = `SELECT day,name,path,source,count FROM events`;

/**
 * Live ledger over the D1 REST API with a token that only has D1 Read permission, so FORGE
 * cannot write to the ledger even by mistake. Only the two fixed SELECTs above are ever sent.
 */
export function d1RestLedger(cfg: { accountId: string; databaseId: string; token: string }, fetcher: typeof fetch = fetch, at = nowIso()): LedgerReader {
  const query = async <T>(sql: string): Promise<T[]> => {
    if (!/^SELECT /.test(sql)) throw new Error("ledger reader only sends SELECT");
    const res = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`, {
      method: "POST", headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }, body: JSON.stringify({ sql }),
    });
    const body = (await res.json().catch(() => null)) as { success?: boolean; result?: { results?: T[] }[]; errors?: { code: number }[] } | null;
    if (!res.ok || !body?.success) throw new Error(`ledger REST query failed (${res.status}${body?.errors?.[0] ? `, code ${body.errors[0].code}` : ""})`);
    return body.result?.[0]?.results ?? [];
  };
  return { mode: "live", asOf: at, readSales: () => query<LedgerSale>(SALES_SQL), readEvents: () => query<LedgerEvent>(EVENTS_SQL) };
}

export const unconnectedLedger: LedgerReader = { mode: "unconnected", asOf: null, readSales: async () => [], readEvents: async () => [] };

/** Funnel rows produced by QA and local testing, identified by the naming conventions the sites use. */
export function isTestEvent(e: Pick<LedgerEvent, "path" | "source">): boolean {
  const src = e.source.toLowerCase(); const path = e.path.toLowerCase();
  return src === "qa-test" || src === "test" || src.startsWith("embed:127.0.0.1") || src.includes("localhost")
    || path.startsWith("/qa/") || path.startsWith("/site/") || path.startsWith("/site-launch/");
}

/** Attribute a funnel row to a niche by its beacon path prefix. Root paths are shared by several sites today → null. */
export function attributeEvent(path: string, prefixes: { nicheId: string; prefix: string }[]): string | null {
  for (const p of prefixes) if (path.startsWith(p.prefix)) return p.nicheId;
  return null;
}

export async function importLedger(db: D1Database, reader: LedgerReader, at = nowIso()): Promise<{ financialEvents: number; funnelRows: number }> {
  if (reader.mode === "unconnected") {
    await recordSource(db, { id: "ledger.d1", label: "D1 sales ledger", mode: "unconnected", asOf: null, note: "No ledger binding or snapshot configured." });
    return { financialEvents: 0, funnelRows: 0 };
  }
  const niches = (await db.prepare(`SELECT id, ledger_vertical, event_path_prefix FROM niches`).all<{ id: string; ledger_vertical: string | null; event_path_prefix: string | null }>()).results;
  const byVertical = new Map(niches.filter((n) => n.ledger_vertical).map((n) => [n.ledger_vertical!, n.id]));
  const prefixes = niches.filter((n) => n.event_path_prefix).map((n) => ({ nicheId: n.id, prefix: n.event_path_prefix! }));
  const sourceTag = reader.mode === "live" ? "ledger.d1" : "ledger.d1.snapshot";

  const stmts: D1PreparedStatement[] = [];
  const insFin = `INSERT INTO financial_events (id,niche_id,kind,amount_cents,currency,occurred_at,product_name,order_ref,test_mode,owner_test,source,source_ref,utm_source,utm_campaign,imported_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source, source_ref) DO UPDATE SET owner_test=excluded.owner_test, test_mode=excluded.test_mode`;
  for (const s of await reader.readSales()) {
    const niche = byVertical.get(s.vertical) ?? null;
    const base = [s.currency || "USD", s.created_at, s.product, s.order_id, s.test_mode ? 1 : 0, s.owner_test ? 1 : 0, "ledger.d1"] as const;
    if (s.event === "order_created") {
      const net = Number(s.total_cents) - Number(s.tax_cents || 0);
      stmts.push(db.prepare(insFin).bind(`fe_${s.id}`, niche, "sale", net, ...base, s.id, s.source || null, s.campaign || null, at));
      if (Number(s.tax_cents) > 0) stmts.push(db.prepare(insFin).bind(`fe_${s.id}:tax`, niche, "tax", Number(s.tax_cents), ...base, `${s.id}:tax`, s.source || null, s.campaign || null, at));
    } else if (s.event === "order_refunded") {
      stmts.push(db.prepare(insFin).bind(`fe_${s.id}`, niche, "refund", Number(s.refunded_cents), ...base, s.id, s.source || null, s.campaign || null, at));
    }
  }
  const events = await reader.readEvents();
  for (const e of events) {
    stmts.push(db.prepare(`INSERT INTO funnel_daily (day,niche_id,event,path,source,count,is_test,imported_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(day,event,path,source) DO UPDATE SET count=excluded.count, niche_id=excluded.niche_id, is_test=excluded.is_test, imported_at=excluded.imported_at`)
      .bind(e.day, attributeEvent(e.path, prefixes), e.name, e.path, e.source, Number(e.count), isTestEvent(e) ? 1 : 0, at));
  }
  if (stmts.length) await db.batch(stmts);
  await recordSource(db, { id: "ledger.d1", label: "D1 sales ledger", mode: reader.mode, asOf: reader.asOf,
    note: reader.mode === "snapshot" ? `Read-only snapshot (${sourceTag}); refresh by re-exporting or connecting a read-only binding.` : undefined });
  return { financialEvents: stmts.length - events.length, funnelRows: events.length };
}
