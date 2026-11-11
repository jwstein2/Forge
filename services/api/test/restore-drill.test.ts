import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain ESM script without types
import { drill } from "../../../scripts/restore-drill.mjs";

const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
const names = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const exportSql = (migs: string[]) => [
  "PRAGMA defer_foreign_keys=TRUE;",
  "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
  ...migs.map((n, i) => `INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(${i + 1},'${n}','2026-11-10 03:00:00');`),
  "CREATE TABLE niches (id TEXT PRIMARY KEY, name TEXT NOT NULL);",
  `INSERT INTO "niches" VALUES('bidline','Bidline');`,
  `INSERT INTO "niches" VALUES('quilt-plan-kit','Quilt Plan Kit');`,
].join("\n");

describe("restore drill (G13)", () => {
  it("passes a complete export whose hash matches the manifest and counts match live", () => {
    const sql = exportSql(names);
    const sha = createHash("sha256").update(sql).digest("hex");
    const r = drill({ sql, fileName: "forge-staging-x.sql", migrationsDir: dir, manifest: [{ file: "C:\\b\\forge-staging-x.sql", ok: true, sha256: sha }], expect: { niches: 2, d1_migrations: names.length } });
    expect(r.result).toBe("PASS");
    expect(r.counts.niches).toBe(2);
  });
  it("fails on a tampered file, a missing migration, a count mismatch or SQL that does not restore", () => {
    const sql = exportSql(names.slice(0, -1));
    const r = drill({ sql, fileName: "a.sql", migrationsDir: dir, manifest: [{ file: "a.sql", ok: true, sha256: "0".repeat(64) }], expect: { niches: 3 } });
    expect(r.result).toBe("FAIL");
    expect(r.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { name: string }) => c.name)).toEqual(["manifest sha256 matches", "all migrations recorded", "row counts match live"]);
    expect(drill({ sql: "CREATE TABLE x(", fileName: "b.sql" }).result).toBe("FAIL");
  });
});
