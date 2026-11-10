/**
 * CLI: blueprint + brand + site config -> static staging site directory. Local files only; never deploys.
 *   npm run scaffold -w @forge/builder -- <blueprint.json> --brand brands/<niche>.brand.json --brief <brief.json> [--config site-config.json] --out <dir>
 * Site config (optional): { "operator": {name,state,contact} | null, "legalDate": "YYYY-MM-DD", "liveSiteUrl": "https://..." | null,
 *   "runtime": { "checkout": {"mode":"off"|"test","urls":{}}, "email": {"action": null}, "beacon": {"url": null, "hosts": [], "site": "<niche>"} } }
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scaffoldSite, type SiteConfig } from "../src/site/scaffold.ts";
import { validateBlueprint } from "../src/validate.ts";
import type { Brand } from "../src/site/brand.ts";
import type { LaunchBlueprint } from "../src/types.ts";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const readJson = (p: string) => JSON.parse(readFileSync(resolve(p), "utf8"));
const bpPath = args[0];
if (!bpPath || !flag("--brand") || !flag("--brief") || !flag("--out")) { console.error("usage: scaffold <blueprint.json> --brand <brand.json> --brief <brief.json> --out <dir> [--config site-config.json]"); process.exit(2); }
const bp = readJson(bpPath) as LaunchBlueprint;
const v = validateBlueprint(bp, readJson(flag("--brief")!));
if (!v.ok) { console.error(`blueprint is INVALID, refusing to scaffold:\n${v.errors.join("\n")}`); process.exit(1); }
const cfg: SiteConfig = flag("--config") ? readJson(flag("--config")!) : {
  operator: null, legalDate: bp.created_at.slice(0, 10), liveSiteUrl: null,
  runtime: { checkout: { mode: "off", urls: {} }, email: { action: null }, beacon: { url: null, hosts: [], site: bp.niche } },
};
const r = await scaffoldSite(bp, readJson(flag("--brand")!) as Brand, cfg);
const out = resolve(flag("--out")!);
for (const [p, content] of Object.entries(r.files)) { mkdirSync(dirname(join(out, p)), { recursive: true }); writeFileSync(join(out, p), content); }
console.log(`${bp.niche}: ${Object.keys(r.files).length} files, ${r.manifest.pages.length} pages, ${r.copyGaps.length} copy gaps -> ${out}`);
