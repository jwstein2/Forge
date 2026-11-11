#!/usr/bin/env node
/**
 * D1 backup (read-only export) for FORGE and the sales ledger. Runbook: docs/controls/BACKUP_AND_RESTORE.md.
 *
 * Default is PLAN mode: prints the exact commands and changes nothing.
 *   npm run backup:plan -w @forge/controls
 * Execute mode runs `wrangler d1 export --remote` (read-only on the database) on the owner's machine,
 * using the owner's existing wrangler login, then writes a sha256 manifest next to the files:
 *   npm run backup:plan -w @forge/controls -- --execute --out "C:\Users\...\FORGE_BACKUPS"
 * It never deletes anything. Backups older than the retention count are listed as prunable for the owner.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BackupTarget { database: string; why: string; remote: boolean }
export const TARGETS: BackupTarget[] = [
  { database: "quiltplankit-sales", why: "Live sales ledger (all three niches). Also covered by D1 Time Travel (30 days), but an offline copy survives account loss.", remote: true },
  { database: "forge-staging", why: "FORGE platform DB. Only exists after the owner approves staging; skipped if absent.", remote: true },
];
export const RETAIN = 12;

export function plan(outDir: string, stamp: string, targets = TARGETS): { file: string; args: string[] }[] {
  return targets.map((t) => {
    const file = join(outDir, `${t.database}-${stamp}.sql`);
    return { file, args: ["wrangler", "d1", "export", t.database, ...(t.remote ? ["--remote"] : ["--local"]), "--output", file] };
  });
}

export function prunable(files: string[], database: string, retain = RETAIN): string[] {
  const mine = files.filter((f) => f.startsWith(`${database}-`) && f.endsWith(".sql")).sort();
  return mine.slice(0, Math.max(0, mine.length - retain));
}

function main() {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const outIdx = argv.indexOf("--out");
  const outDir = outIdx >= 0 ? argv[outIdx + 1]! : join(process.cwd(), "backups");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null; // e.g. --only forge-staging (restore drills need no production data)
  const targets = only ? TARGETS.filter((t) => t.database === only) : TARGETS;
  if (only && !targets.length) { console.error(`unknown database for --only: ${only}`); process.exit(2); }
  const steps = plan(outDir, stamp, targets);
  console.log(`${execute ? "EXECUTE" : "PLAN (nothing will run)"}: ${steps.length} database export(s) to ${outDir}`);
  for (const s of steps) console.log(`  npx ${s.args.join(" ")}`);
  if (!execute) { console.log("Re-run with --execute on the owner's machine to export. Exports are read-only."); return; }
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const manifest: { database: string; file: string; bytes: number; sha256: string; at: string; ok: boolean; error?: string }[] = [];
  for (const [i, s] of steps.entries()) {
    const t = targets[i]!;
    try {
      execFileSync("npx", s.args, { stdio: "inherit", shell: process.platform === "win32" });
      const buf = readFileSync(s.file);
      manifest.push({ database: t.database, file: s.file, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), at: new Date().toISOString(), ok: true });
    } catch (e) {
      manifest.push({ database: t.database, file: s.file, bytes: 0, sha256: "", at: new Date().toISOString(), ok: false, error: String((e as Error).message).slice(0, 200) });
    }
  }
  writeFileSync(join(outDir, `manifest-${stamp}.json`), JSON.stringify(manifest, null, 2));
  const files = readdirSync(outDir).filter((f) => statSync(join(outDir, f)).isFile());
  for (const t of targets) {
    const old = prunable(files, t.database);
    if (old.length) console.log(`Prunable (older than the newest ${RETAIN}; delete by hand if you want): ${old.join(", ")}`);
  }
  const failed = manifest.filter((m) => !m.ok);
  console.log(`Backup ${failed.length ? "PARTIAL" : "OK"}: ${manifest.length - failed.length}/${manifest.length} exported; manifest-${stamp}.json written.`);
  process.exit(failed.length && failed.length === manifest.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("backup-d1.ts")) main();
