/**
 * A minimal D1Database implementation over Node's built-in node:sqlite.
 * Used by the test harness and the local Node dev server so FORGE runs on any machine with Node 22,
 * without Cloudflare credentials. Production/staging use real D1 bindings; the SQL is identical (SQLite).
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Bindable = string | number | bigint | null | Uint8Array;
const norm = (v: unknown): Bindable => {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint" || v instanceof Uint8Array) return v;
  return JSON.stringify(v);
};
const plain = (r: unknown) => (r ? { ...(r as object) } : null);

class NodeStatement {
  private db: DatabaseSync; private sql: string; private params: Bindable[];
  constructor(db: DatabaseSync, sql: string, params: Bindable[] = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...values: unknown[]) { return new NodeStatement(this.db, this.sql, values.map(norm)); }
  async all<T = Record<string, unknown>>() {
    const rows = this.db.prepare(this.sql).all(...this.params).map((r) => plain(r) as T);
    return { results: rows, success: true, meta: { changes: 0 } };
  }
  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = plain(this.db.prepare(this.sql).get(...this.params)) as Record<string, unknown> | null;
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }
  async run() {
    const res = this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: Number(res.changes), last_row_id: Number(res.lastInsertRowid) } };
  }
  async raw<T = unknown[]>() {
    const st = this.db.prepare(this.sql);
    return st.all(...this.params).map((r) => Object.values(r as object)) as T[];
  }
  _exec() { return this.db.prepare(this.sql).run(...this.params); }
}

export class NodeD1 {
  readonly db: DatabaseSync;
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON;");
  }
  prepare(sql: string) { return new NodeStatement(this.db, sql); }
  async batch(stmts: NodeStatement[]) {
    // D1 batches are atomic: emulate with a transaction.
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) { s._exec(); out.push({ results: [], success: true, meta: {} }); }
      this.db.exec("COMMIT");
      return out;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  async exec(sql: string) { this.db.exec(sql); return { count: 1, duration: 0 }; }
  asD1(): D1Database { return this as unknown as D1Database; }
}

/** Apply every migrations/*.sql file in order (local/test only). */
export function applyMigrations(d1: NodeD1, dir: string): string[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) d1.db.exec(readFileSync(join(dir, f), "utf8"));
  return files;
}
