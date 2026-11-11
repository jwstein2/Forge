/**
 * CLI: generate, validate and render a Launch Blueprint from a brief file. Writes local files only.
 *   npm run blueprint -w @forge/builder -- <brief.json> [--out dir] [--version 1.0.0] [--registry ../../registry/products.json] [--budget-cents N] [--new-business]
 *   npm run blueprint -w @forge/builder -- --validate <blueprint.json> [--brief brief.json]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateBlueprint, type RegistryProduct } from "../src/generate.ts";
import { renderMarkdown } from "../src/render.ts";
import { validateBlueprint } from "../src/validate.ts";
import type { Brief } from "../src/brief.ts";

const args = process.argv.slice(2);
/** Committed blueprint history: what changed in each generated version. */
const CHANGELOG: Record<string, string> = {
  "1.0.1": "Picture no longer repeats the promise when the brief has a single desired outcome (left as a copy gap).",
  "garden-planner@1.0.1": "Regenerated from brief v1.0.1: frost dates from NOAA 1991-2020 Climate Normals (CC0), station name and distance shown.",
  "garden-planner@1.0.2": "Regenerated from brief v1.0.2: Almanac competitor shows three plans (software band $35-$168/yr); USDA zone claim split into fact and inference. Offer, must-includes and price unchanged.",
  "garden-planner@1.0.3": "Regenerated from brief v1.0.3: break-even sales counts and off-Etsy price sources added. Positioning, offer and prices unchanged.",
  "garden-planner@1.0.7": "Regenerated from brief v1.0.7: the owner named the core product Frost Date Garden Planner on 2026-11-11. Not launched.",
  "garden-planner@1.0.6": "Regenerated from brief v1.0.6: the owner named the business Frost Date Planting (domain frostdateplanting.com) on 2026-11-11; niche id stays garden-planner. Not launched.",
  "garden-planner@1.0.5": "Regenerated from brief v1.0.5: the calendar must-include names 30 common vegetables and herbs (QA-021 B3-3).",
  "garden-planner@1.0.4": "Regenerated from brief v1.0.4: c_g_obj_cheap now records planners from $1.99 off Etsy and a free 41-page planner (QA-021).",
  "bidline@1.0.5": "Regenerated from brief v1.0.3: the worked-example must-include no longer names a deck or a 10-minute claim (QA-022).",
  "1.0.4": "Regenerated from the latest briefs (Bidline v1.0.2, Quilt Plan Kit v1.0.3, Loaf Ledger v1.0.4): break-even sales counts and off-Etsy price sources; Loaf Ledger adds competitors and leads its must-includes with the market-day loop.",
  "1.0.3": "Existing products use their registry name (what the live site and file call them) instead of the brief's working name; any difference is listed as an unknown (QA-014 B7-1).",
  "1.0.2": "Offer items that name alternatives (\"A or B\") stay undecided instead of becoming products (QA-009 S3).",
};
function previousId(niche: string, version: string): string | null {
  const [a, b, c] = version.split(".").map(Number);
  return c! > 0 ? `bp_${niche}_v${a}-${b}-${c! - 1}` : null;
}
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const readJson = (p: string) => JSON.parse(readFileSync(resolve(p), "utf8"));

if (args.includes("--validate")) {
  const bp = readJson(flag("--validate")!);
  const briefPath = flag("--brief");
  if (!briefPath) { console.error("--validate needs --brief <brief.json>: blueprints are traced to their brief"); process.exit(2); }
  const r = validateBlueprint(bp, readJson(briefPath) as Brief);
  console.log(r.ok ? "valid" : `INVALID\n${r.errors.join("\n")}`);
  process.exit(r.ok ? 0 : 1);
}

const valued = new Set(["--out", "--version", "--registry", "--budget-cents", "--brief"].map((f) => flag(f)).filter(Boolean));
const briefPath = args.find((a) => !a.startsWith("--") && !valued.has(a));
if (!briefPath) { console.error("usage: blueprint <brief.json> [--out dir] [--version x.y.z] [--registry products.json] [--budget-cents N] [--new-business]"); process.exit(2); }
const brief = readJson(briefPath) as Brief;
const registryPath = flag("--registry");
const rawRegistry = registryPath ? readJson(registryPath) : [];
const registryProducts: RegistryProduct[] = Array.isArray(rawRegistry) ? rawRegistry : (rawRegistry.products ?? rawRegistry.items ?? []);
const budget = flag("--budget-cents");
const bp = await generateBlueprint(brief, {
  version: flag("--version"), registryProducts,
  supersedes: args.includes("--supersedes-previous") && flag("--version") ? previousId(brief.niche, flag("--version")!) : null,
  changelog: args.includes("--supersedes-previous") ? (CHANGELOG[`${brief.niche}@${flag("--version")}`] ?? CHANGELOG[flag("--version") ?? ""]) : undefined, budgetCeilingCents: budget ? Number(budget) : null,
  businessKind: args.includes("--new-business") ? "new_business" : "existing_niche",
});
const v = validateBlueprint(bp, brief);
if (!v.ok) { console.error(`generated blueprint is INVALID:\n${v.errors.join("\n")}`); process.exit(1); }
const out = resolve(flag("--out") ?? join("blueprints", bp.niche));
mkdirSync(out, { recursive: true });
const base = join(out, `launch-blueprint.v${bp.version}`);
writeFileSync(`${base}.json`, JSON.stringify(bp, null, 2) + "\n");
writeFileSync(`${base}.md`, renderMarkdown(bp));
console.log(`${bp.blueprint_id}: ${bp.products.length} products, ${bp.page_map.length} pages, ${bp.channel_plan.length} channels, ${bp.unknowns.length} unknowns -> ${base}.{json,md}`);
