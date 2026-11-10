import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BlueprintRefused, generateBlueprint } from "../src/generate.ts";
import { contentHash } from "../src/hash.ts";
import { classifyPlaybook } from "../src/playbooks.ts";
import { validateBlueprint } from "../src/validate.ts";
import { NICHES, clone, loadBrief, registryProducts, syntheticNewBusinessBrief } from "./helpers.ts";

describe("blueprint generator on the three real v1 briefs", () => {
  for (const niche of NICHES) {
    it(`${niche}: valid against schema, semantics and the brief`, async () => {
      const brief = loadBrief(niche);
      const bp = await generateBlueprint(brief, { registryProducts: registryProducts() });
      const v = validateBlueprint(bp, brief);
      expect(v.errors).toEqual([]);
      expect(bp.launch_policy.auto_launch).toBe(false);
      expect(bp.budget.spend_authorized).toBe(false);
      expect(bp.implementation_status).toBe("PROPOSED");
      expect(bp.products.every((p) => p.status === "PROPOSED")).toBe(true);
      expect(bp.measurement.kpis.every((k) => k.target === null && k.state === "unknown")).toBe(true);
    });

    it(`${niche}: deterministic (same input, same hash)`, async () => {
      const a = await generateBlueprint(loadBrief(niche), { registryProducts: registryProducts() });
      const b = await generateBlueprint(loadBrief(niche), { registryProducts: registryProducts() });
      expect(await contentHash(a)).toBe(await contentHash(b));
    });

    it(`${niche}: committed blueprint matches a fresh generation (no drift)`, async () => {
      const committed = JSON.parse(readFileSync(join(import.meta.dirname, "..", "blueprints", niche, "launch-blueprint.v1.0.2.json"), "utf8"));
      const fresh = await generateBlueprint(loadBrief(niche), {
        registryProducts: registryProducts(), version: "1.0.2", supersedes: `bp_${niche}_v1-0-1`,
        changelog: "Offer items that name alternatives (\"A or B\") stay undecided instead of becoming products (QA-009 S3).",
      });
      expect(await contentHash(committed)).toBe(await contentHash(fresh));
    });
  }

  it("classifies the real offer ladders into the right playbooks", async () => {
    const pb = async (n: string) => (await generateBlueprint(loadBrief(n))).offer_ladder.map((t) => `${t.tier}:${t.playbook}`);
    expect(await pb("bidline")).toEqual(["free:free-resource", "core:spreadsheet-template", "premium:unsupported"]);
    expect(await pb("quilt-plan-kit")).toEqual(["free:free-resource", "entry:printable-pdf", "core:bundle", "premium:kdp-book"]);
    expect(await pb("loaf-ledger")).toEqual(["free:free-resource", "core:spreadsheet-template", "bundle:bundle"]);
  });

  it("QA-009 S3: an offer item naming alternatives is undecided, not a product", async () => {
    const bp = await generateBlueprint(loadBrief("bidline"));
    const premium = bp.offer_ladder.find((t) => t.tier === "premium")!;
    expect(premium.product_id).toBeNull();
    expect(bp.products.map((p) => p.tier)).toEqual(["core"]);
    expect(bp.page_map.some((p) => /trade/i.test(p.path))).toBe(false);
    expect(bp.unknowns.some((u) => u.field === "offer_ladder.premium.item")).toBe(true);
  });

  it("links existing registry products instead of inventing parallel ones", async () => {
    const bp = await generateBlueprint(loadBrief("quilt-plan-kit"), { registryProducts: registryProducts() });
    const byTier = Object.fromEntries(bp.products.map((p) => [p.tier, p.registry_product_id]));
    expect(byTier).toEqual({ entry: "prd_qpk_planner", core: null, premium: "prd_qpk_paperback" });
    expect(bp.unknowns.some((u) => u.statement.includes("already exists as prd_qpk_planner"))).toBe(true);
  });

  it("carries the core product spec, price evidence and falsifying test from the brief", async () => {
    const brief = loadBrief("bidline");
    const bp = await generateBlueprint(brief);
    const core = bp.products.find((p) => p.tier === "core")!;
    expect(core.must_include).toEqual(brief.premium_product_recommendation.must_include);
    expect(core.price).toMatchObject({ value: 19, evidence: "INFERRED" });
    expect(core.falsifying_test).toBe(brief.premium_product_recommendation.falsifying_test);
    expect(bp.unknowns.some((u) => u.field === "offer_ladder.core.price")).toBe(true);
  });

  it("never invents proof: only VERIFIED claims, and a fixed no-testimonial rule", async () => {
    for (const n of NICHES) {
      const bp = await generateBlueprint(loadBrief(n));
      expect(bp.sales_framework.proof.items.every((c) => c.evidence === "VERIFIED")).toBe(true);
      expect(bp.sales_framework.proof.rule).toMatch(/No testimonials/);
    }
  });

  it("a missing price becomes UNKNOWN, never zero or a guess", async () => {
    const brief = clone(loadBrief("loaf-ledger"));
    delete (brief.premium_product_recommendation.offer_ladder[1]!.price as { value?: number }).value;
    const bp = await generateBlueprint(brief);
    expect(bp.offer_ladder[1]!.price).toMatchObject({ value: null, evidence: "UNKNOWN" });
    expect(validateBlueprint(bp, brief).errors).toEqual([]);
  });

  it("refuses briefs that say hold or stop unless explicitly overridden", async () => {
    for (const call of ["hold", "stop"] as const) {
      const brief = clone(loadBrief("bidline")); brief.summary.go_hold.call = call;
      await expect(generateBlueprint(brief)).rejects.toBeInstanceOf(BlueprintRefused);
      const bp = await generateBlueprint(brief, { allowHold: true });
      expect(bp.go_hold.call).toBe(call);
    }
  });

  it("a new business needs the owner to select it and approve budget and boundaries", async () => {
    const brief = syntheticNewBusinessBrief();
    const bp = await generateBlueprint(brief, { businessKind: "new_business" });
    expect(validateBlueprint(bp, brief).errors).toEqual([]);
    expect(bp.stages.find((s) => s.stage === "research")!.owner_approvals).toEqual(["Select this opportunity for a build"]);
    expect(bp.stages.find((s) => s.stage === "blueprint")!.owner_approvals[0]).toMatch(/budget ceiling/);
    expect(bp.launch_policy.owner_approval_required_for).toContain("Selecting this opportunity");
  });

  it("every blueprint keeps the nine platform stages and ends on an owner launch decision", async () => {
    const bp = await generateBlueprint(loadBrief("quilt-plan-kit"));
    expect(bp.stages.map((s) => s.stage)).toEqual(["research", "blueprint", "products", "brand", "website", "integrations", "marketing", "testing", "launch_readiness"]);
    const last = bp.stages.at(-1)!;
    expect(last.gates).toHaveLength(15);
    expect(last.owner_approvals).toEqual(["Production deploy and launch"]);
  });

  it("classifier never guesses an unknown format", () => {
    expect(classifyPlaybook("Mystery thing", "core", 20)).toBe("unsupported");
    expect(classifyPlaybook("Anything", "free", 0)).toBe("free-resource");
    expect(classifyPlaybook("Some Kit", "core", 19, { formatHint: "Excel workbook + quick-start PDF" })).toBe("spreadsheet-template");
  });
});
