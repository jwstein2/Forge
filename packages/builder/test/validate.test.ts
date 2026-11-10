import { describe, expect, it } from "vitest";
import { generateBlueprint } from "../src/generate.ts";
import { validateBlueprint } from "../src/validate.ts";
import type { LaunchBlueprint } from "../src/types.ts";
import { clone, loadBrief } from "./helpers.ts";

const brief = loadBrief("quilt-plan-kit");
const base = await generateBlueprint(brief);
const tamper = (f: (bp: any) => void) => { const bp = clone(base) as any; f(bp); return validateBlueprint(bp as LaunchBlueprint, brief); };

describe("blueprint validation rejects unsafe or untraceable content", () => {
  it("accepts the untouched blueprint", () => expect(validateBlueprint(base, brief).ok).toBe(true));
  it("rejects auto-launch", () => expect(tamper((b) => { b.launch_policy.auto_launch = true; }).ok).toBe(false));
  it("rejects spend authorization", () => expect(tamper((b) => { b.budget.spend_authorized = true; }).ok).toBe(false));
  it("rejects a non-PROPOSED blueprint", () => expect(tamper((b) => { b.implementation_status = "LIVE"; }).ok).toBe(false));
  it("rejects a VERIFIED price with no value", () => expect(tamper((b) => { b.offer_ladder[1].price = { value: null, currency: "USD", evidence: "VERIFIED" }; }).ok).toBe(false));
  it("rejects unverified proof", () => {
    const r = tamper((b) => { b.sales_framework.proof.items.push({ claim_id: b.sales_framework.pain[0].claim_id, statement: b.sales_framework.pain[0].statement, evidence: "INFERRED" }); });
    expect(r.ok).toBe(false);
  });
  it("rejects a fabricated testimonial-style claim not in the brief", () => {
    const r = tamper((b) => { b.sales_framework.proof.items.push({ claim_id: "c_fake", statement: "Loved by 10,000 quilters", evidence: "VERIFIED" }); });
    expect(r.errors.join()).toMatch(/c_fake is not in brief/);
  });
  it("rejects a claim whose wording drifted from the brief", () => {
    const r = tamper((b) => { b.sales_framework.pain[0].statement += " (and much more)"; });
    expect(r.errors.join()).toMatch(/differs from the brief/);
  });
  it("rejects invented KPI targets", () => expect(tamper((b) => { b.measurement.kpis[0].target = 500; }).errors.join()).toMatch(/targets come from the owner/));
  it("rejects reordered stages", () => expect(tamper((b) => { b.stages.reverse(); }).ok).toBe(false));
  it("rejects a launch stage without the owner's launch approval", () => expect(tamper((b) => { b.stages[8].owner_approvals = []; }).ok).toBe(false));
  it("rejects a missing legal page", () => expect(tamper((b) => { b.page_map = b.page_map.filter((p: any) => p.path !== "/refunds/"); }).errors.join()).toMatch(/refunds/));
  it("rejects a price that differs between ladder and product", () => expect(tamper((b) => { b.products[0].price.value = 99; }).errors.join()).toMatch(/price mismatch/));
  it("rejects a blueprint checked against the wrong brief", () => {
    const r = validateBlueprint(base, loadBrief("bidline"));
    expect(r.errors.join()).toMatch(/source_brief does not match/);
  });
  it("QA-004 B1: rejects a price changed in both product and ladder", () => {
    const r = tamper((b) => { b.products[0].price.value = 29; b.offer_ladder[1].price.value = 29; });
    expect(r.errors.join()).toMatch(/differs from the brief/);
  });
  it("QA-004 B1: rejects a price relabelled VERIFIED", () => {
    const core = base.offer_ladder.findIndex((t) => t.tier === "core");
    const r = tamper((b) => { b.offer_ladder[core].price.evidence = "VERIFIED"; const p = b.products.find((x: any) => x.product_id === b.offer_ladder[core].product_id); p.price.evidence = "VERIFIED"; });
    expect(r.errors.join()).toMatch(/differs from the brief/);
  });
  it("QA-004 B1: rejects an invented offer tier", () => {
    const r = tamper((b) => { b.offer_ladder.push({ tier: "vip", item: "VIP coaching", price: { value: 499, currency: "USD", evidence: "INFERRED" }, product_id: null, playbook: "unsupported" }); });
    expect(r.errors.join()).toMatch(/not in the brief's offer ladder/);
  });
  it("QA-004 B2: rejects an invented result claim in the promise", () => {
    const r = tamper((b) => { b.sales_framework.promise.draft = "Quilters using QPK finish 23% more quilts in 30 days"; });
    expect(r.errors.join()).toMatch(/promise.draft must be empty or a cited basis claim/);
  });
  it("QA-004 B2: rejects invented figures in the plan or CTA", () => {
    expect(tamper((b) => { b.sales_framework.plan[1] = "Join 5,000 happy quilters"; }).errors.join()).toMatch(/figure "5000"/);
    expect(tamper((b) => { b.sales_framework.cta.label = "Save 40% today"; }).errors.join()).toMatch(/figure "40"/);
  });
  it("QA-004 B2: rejects rewritten positioning, decision or pre-written objection answers", () => {
    expect(tamper((b) => { b.positioning.one_line = "The #1 quilting brand"; }).ok).toBe(false);
    expect(tamper((b) => { b.go_hold.rationale = "Huge proven demand"; }).ok).toBe(false);
    expect(tamper((b) => { b.sales_framework.objections[0].response = "Everyone loves it"; }).ok).toBe(false);
  });
  it("QA-004 B6: refuses to validate without the source brief", () => {
    const r = validateBlueprint(base, undefined as never);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/source brief is required/);
  });
  it("rejects unknown fields (schema is closed)", () => expect(tamper((b) => { b.testimonials = ["great"]; }).ok).toBe(false));
});
