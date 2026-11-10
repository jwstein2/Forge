#!/usr/bin/env node
// Fails if tracked files look like they contain credentials. Run by `npm run check` and CI (gate G12).
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
// `--history` (CI) also scans every commit's paths and patches, so a secret removed later still fails.
const history = process.argv.includes("--history");
const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean)
  .filter((f) => !f.startsWith("node_modules/") && !/\.(png|jpg|sqlite)$/.test(f));
// Paths that must never be committed, whatever they contain (QA-002 R4).
const forbiddenPath = [/(^|\/)\.data\//, /(^|\/)\.dev\.vars$/, /(^|\/)\.env(\.|$)/, /dev-token/i, /credential/i, /\.sqlite$/];
const patterns = [
  [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, "private key"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS key"],
  [/\bghp_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/\beyJhbGciOi[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, "JWT"],
  [/(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"'\s]{16,}["']/i, "assigned secret literal"],
  [/\b(xox[abp]-[A-Za-z0-9-]{20,}|github_pat_[A-Za-z0-9_]{40,}|sk_live_[A-Za-z0-9]{20,})/, "service token"],
  [/^\s*[A-Za-z0-9_\-]{32,}\s*$/, "bare token file"],
];
const allow = [/test\//, /check-secrets\.mjs$/];
let bad = 0;
for (const f of files) if (forbiddenPath.some((r) => r.test(f)) && !/check-secrets\.mjs$/.test(f)) { console.error(`forbidden path tracked: ${f}`); bad++; }
if (history) {
  const paths = new Set(execSync("git log --all --name-only --pretty=format:", { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n").filter(Boolean));
  for (const f of paths) if (forbiddenPath.some((r) => r.test(f)) && !/check-secrets\.mjs$/.test(f)) { console.error(`forbidden path in history: ${f}`); bad++; }
  const patch = execSync("git log --all -p --no-color -- . ':!**/test/**' ':!scripts/check-secrets.mjs' ':!**/package-lock.json'", { encoding: "utf8", maxBuffer: 1 << 28 });
  for (const [re, name] of patterns.slice(0, -1)) if (new RegExp(re.source, re.flags.includes("i") ? "im" : "m").test(patch)) { console.error(`possible ${name} in git history`); bad++; }
}
for (const f of files) {
  if (allow.some((a) => a.test(f))) continue;
  const text = readFileSync(f, "utf8");
  for (const [re, name] of patterns) {
    if (name === "bare token file" && (text.split("\n").filter(Boolean).length !== 1 || /\.(json|md|ts|js|mjs|toml|sql|yml|yaml|html|css)$/.test(f))) continue;
    if (re.test(text)) { console.error(`possible ${name} in ${f}`); bad++; }
  }
}
if (bad) { console.error(`${bad} possible secret(s) found`); process.exit(1); }
console.log(`secret scan: ${files.length} tracked files clean${history ? " (history included)" : ""}`);
