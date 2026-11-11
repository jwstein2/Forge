#!/usr/bin/env node
// FORGE restore drill: prove a D1 export can be restored and is complete. Local only; never touches a remote DB.
//
//   node scripts/restore-drill.mjs --file <export.sql> [--manifest <manifest.json>] [--expect <counts.json>] [--out <report.json>]
//
// 1. Checks the export's sha256 against the backup manifest (scripts in @forge/controls write it).
// 2. Restores it into a fresh in-memory SQLite (same engine as D1).
// 3. Runs PRAGMA integrity_check and foreign_key_check.
// 4. Confirms every migration in services/api/migrations is recorded in d1_migrations.
// 5. Compares row counts with counts read from the live DB at export time (--expect, {"table": n}).
// Exit 0 = PASS (all checks ran and passed), 1 = FAIL, 3 = PARTIAL (nothing failed, some checks not run). The JSON report is the G13 receipt.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export function drill({ sql, manifest = null, expect = null, migrationsDir, fileName = "export.sql" }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  const notRun = (name, why) => checks.push({ name, ok: null, not_run: why }); // QA-023 RD-1: a skipped check is recorded, never silently absent
  const sha256 = createHash("sha256").update(sql).digest("hex");
  if (manifest) {
    const entry = manifest.find((m) => m.ok && basename(String(m.file).replace(/\\/g, "/")) === fileName);
    add("manifest sha256 matches", !!entry && entry.sha256 === sha256, entry ? undefined : `no ok manifest entry for ${fileName}`);
  } else notRun("manifest sha256 matches", "no --manifest given");
  const db = new DatabaseSync(":memory:");
  let restored = true;
  try { db.exec(sql); } catch (e) { restored = false; add("export restores", false, String(e.message).slice(0, 300)); }
  if (restored) add("export restores", true);
  const tables = restored ? db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`).all().map((r) => r.name) : [];
  const counts = Object.fromEntries(tables.map((t) => [t, Number(db.prepare(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}"`).get().n)]));
  if (restored) {
    const ic = db.prepare("PRAGMA integrity_check").all().map((r) => Object.values(r)[0]);
    add("integrity_check", ic.length === 1 && ic[0] === "ok", ic.slice(0, 5));
    const fk = db.prepare("PRAGMA foreign_key_check").all();
    add("foreign_key_check", fk.length === 0, fk.length ? fk.slice(0, 5) : undefined);
    if (migrationsDir) {
      const want = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
      const have = tables.includes("d1_migrations") ? new Set(db.prepare("SELECT name FROM d1_migrations").all().map((r) => r.name)) : new Set();
      const missing = want.filter((f) => !have.has(f));
      add("all migrations recorded", missing.length === 0, missing.length ? missing : undefined);
    } else notRun("all migrations recorded", "no migrations directory");
  }
  if (expect) {
    const diff = Object.entries(expect).filter(([t, n]) => counts[t] !== n).map(([t, n]) => ({ table: t, live: n, restored: counts[t] ?? null }));
    add("row counts match live", diff.length === 0, diff.length ? diff : undefined);
  } else notRun("row counts match live", "no --expect given");
  db.close();
  // PASS only when every check ran and passed; PARTIAL when nothing failed but some did not run (not a G13 receipt).
  const failed = checks.some((c) => c.ok === false), skipped = checks.some((c) => c.ok === null);
  return { result: failed ? "FAIL" : skipped ? "PARTIAL" : "PASS", complete: !skipped, at: new Date().toISOString(), file: fileName, bytes: Buffer.byteLength(sql), sha256, tables: tables.length, rows: Object.values(counts).reduce((a, b) => a + b, 0), counts, checks };
}

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = arg("--file");
  if (!file) { console.error("usage: node scripts/restore-drill.mjs --file <export.sql> [--manifest m.json] [--expect counts.json] [--out report.json]"); process.exit(2); }
  const read = (p) => (p ? JSON.parse(readFileSync(p, "utf8")) : null);
  const report = drill({
    sql: readFileSync(file, "utf8"), manifest: read(arg("--manifest")), expect: read(arg("--expect")), fileName: basename(file),
    migrationsDir: fileURLToPath(new URL("../services/api/migrations/", import.meta.url)),
  });
  const out = arg("--out"); if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  for (const c of report.checks) console.log(c.ok === null ? `NOT RUN  ${c.name} (${c.not_run})` : `${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok || c.detail === undefined ? "" : `: ${JSON.stringify(c.detail)}`}`);
  console.log(`Restore drill ${report.result}: ${report.tables} tables, ${report.rows} rows, sha256 ${report.sha256.slice(0, 12)}…`);
  if (report.result === "PARTIAL") console.log("Not a G13 receipt: rerun with --manifest and --expect.");
  process.exit(report.result === "PASS" ? 0 : report.result === "PARTIAL" ? 3 : 1);
}
