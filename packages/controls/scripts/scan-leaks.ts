#!/usr/bin/env node
/**
 * FORGE secret scan (gate G12). Scans, from the repo root:
 *   1. tracked files, 2. untracked files that are not git-ignored, 3. every added line in git history (all refs).
 * Never prints a secret: only file, line, rule, a 4-char redacted preview and a fingerprint.
 * Allowlist known-safe matches (test fixtures) by fingerprint in .secretscan-allow at the repo root.
 * Usage: npm run scan-secrets -w @forge/controls [-- --no-history] [--json]
 * Exit 1 on any critical hit or tracked sensitive file; warnings print but do not fail.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanText, sensitiveFile, type SecretHit } from "../src/security/leak-scan.ts";

const args = new Set(process.argv.slice(2));
const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const root = git("rev-parse", "--show-toplevel").trim();
process.chdir(root);
const allow = new Set(existsSync(".secretscan-allow")
  ? readFileSync(".secretscan-allow", "utf8").split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean) : []);
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|xlsx|docx|zip|tgz|gz|woff2?|ttf|otf|sqlite|db|wasm)$/i;
const SKIP = (f: string) => f.startsWith("node_modules/") || f.includes("/node_modules/") || BINARY.test(f) || f.endsWith("package-lock.json");

const hits: SecretHit[] = [];
const files: { path: string; label: string }[] = [];
const scanFiles = (list: string[], tag: string) => {
  for (const f of list) {
    const s = sensitiveFile(f); if (s) files.push({ path: `${tag}${f}`, label: s });
    if (SKIP(f) || !existsSync(f) || statSync(f).size > 5 * 1024 * 1024) continue;
    hits.push(...scanText(`${tag}${f}`, readFileSync(f, "utf8"), allow));
  }
};
scanFiles(git("ls-files").split("\n").filter(Boolean), "");
scanFiles(git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean), "untracked:");

let historyCommits = 0;
if (!args.has("--no-history")) {
  const log = git("log", "--all", "-p", "--no-color", "--unified=0", "--format=__COMMIT__ %H");
  let commit = "", file = "", added: string[] = [];
  const flush = () => { if (file && added.length && !SKIP(file)) hits.push(...scanText(`history:${commit.slice(0, 8)}:${file}`, added.join("\n"), allow)); added = []; };
  for (const line of log.split("\n")) {
    if (line.startsWith("__COMMIT__ ")) { flush(); commit = line.slice(11); historyCommits++; continue; }
    if (line.startsWith("+++ ")) { flush(); file = line.startsWith("+++ b/") ? line.slice(6) : ""; if (file && sensitiveFile(file)) files.push({ path: `history:${commit.slice(0, 8)}:${file}`, label: sensitiveFile(file)! }); continue; }
    if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
  }
  flush();
}

// History hits that duplicate a current-file hit add noise; keep one per fingerprint+rule per location class.
const seen = new Set<string>();
const unique = hits.filter((h) => { const k = `${h.fingerprint}:${h.rule}:${h.file.startsWith("history:") ? "h" : h.file}`; if (seen.has(k)) return false; seen.add(k); return true; });
const critical = unique.filter((h) => h.severity === "critical");
const result = { root, historyCommits, sensitiveFiles: files, critical: critical.length, warnings: unique.length - critical.length, hits: unique };
if (args.has("--json")) console.log(JSON.stringify(result, null, 2));
else {
  for (const f of files) console.error(`SENSITIVE FILE  ${f.path}  (${f.label})`);
  for (const h of unique) console.error(`${h.severity.toUpperCase().padEnd(8)} ${h.file}:${h.line}  ${h.label}  ${h.preview}  fp=${h.fingerprint}`);
  console.log(`secret scan: ${critical.length} critical, ${unique.length - critical.length} warning(s), ${files.length} sensitive file(s); history ${args.has("--no-history") ? "skipped" : `${historyCommits} commits`}`);
}
process.exit(critical.length || files.length ? 1 : 0);
