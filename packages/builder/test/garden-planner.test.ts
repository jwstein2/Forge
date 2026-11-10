/** Fourth-business blueprint from the real Scout brief (garden-planner v1.0.0). Blueprint only: never launched. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateBlueprint } from "../src/generate.ts";
import { contentHash } from "../src/hash.ts";
import { evaluateBuild } from "../src/pipeline.ts";
import { scaffoldSite } from "../src/site/scaffold.ts";
import { checkBrand, type Brand } from "../src/site/brand.ts";
import { validateBlueprint } from "../src/validate.ts";
import { loadBrief, registryProducts } from "./helpers.ts";

const brief = loadBrief("garden-planner");
const opts = {
  businessKind: "new_business" as const, registryProducts: registryProducts(), version: "1.0.1", supersedes: "bp_garden-planner_v1-0-0",
  changelog: "Regenerated from brief v1.0.1: frost dates from NOAA 1991-2020 Climate Normals (CC0), station name and distance shown.",
};
const brand = JSON.parse(readFileSync(join(import.meta.dirname, "..", "brands", "garden-planner.brand.json"), "utf8")) as Brand;

describe("garden-planner (new business) blueprint", () => {
  it("is valid, traceable, and matches the committed file", async () => {
    const bp = await generateBlueprint(brief, opts);
    expect(validateBlueprint(bp, brief).errors).toEqual([]);
    const committed = JSON.parse(readFileSync(join(import.meta.dirname, "..", "blueprints", "garden-planner", "launch-blueprint.v1.0.1.json"), "utf8"));
    expect(await contentHash(committed)).toBe(await contentHash(bp));
  });

  it("needs the owner to select it, set a budget, approve every channel, and approve launch", async () => {
    const bp = await generateBlueprint(brief, opts);
    expect(bp.business_kind).toBe("new_business");
    expect(bp.channel_plan.every((c) => c.owner_approval_required)).toBe(true);
    expect(bp.integrations.find((i) => i.service === "Etsy")?.owner_approval_required).toBe(true);
    const ev = evaluateBuild(bp, [{ stage: "research", gate: "B0", result: "PASS", reviewer: "qa", producer: "builder", createdAt: "2026-11-10T05:00:00Z" }], []);
    expect(ev.status).toBe("awaiting_approval");
  });

  it("carries the frost-date honesty rule, the station disclosure and the ZIP-to-station question", async () => {
    const bp = await generateBlueprint(brief, opts);
    expect(bp.products[0]!.must_not.join(" ")).toMatch(/estimates with the source/);
    expect(bp.products[0]!.must_include.join(" ")).toMatch(/station/i);
    expect(bp.unknowns.some((u) => /ZIP|station/i.test(u.statement))).toBe(true);
    expect(bp.unknowns.some((u) => u.field === "offer_ladder.free.price")).toBe(false);
  });

  it("scaffolds without an operator: legal pages are gaps and no live site is linked", async () => {
    expect(checkBrand(brand)).toEqual([]);
    const bp = await generateBlueprint(brief, opts);
    const r = await scaffoldSite(bp, brand, { operator: null, legalDate: "2026-11-10", liveSiteUrl: null, runtime: { checkout: { mode: "off", urls: {} }, email: { action: null }, beacon: { url: null, hosts: [], site: "garden-planner" } } });
    expect(r.files["terms/index.html"]).toContain("required for G7");
    expect(r.files["tools/index.html"]).toContain("Free tools are not built yet");
    expect(r.manifest.deployable_to_production).toBe(false);
  });
});
