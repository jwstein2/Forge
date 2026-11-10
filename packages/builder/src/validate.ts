/**
 * Blueprint validation = JSON Schema (structure) + semantic rules (honesty and safety) + traceability to the brief.
 */
import { Validator } from "@cfworker/json-schema";
import { BUILD_STAGES } from "@forge/contracts";
import schema from "../schemas/launch-blueprint.schema.json" with { type: "json" };
import type { Brief, BriefClaim } from "./brief.ts";
import type { ClaimRef, LaunchBlueprint } from "./types.ts";

export interface ValidationResult { ok: boolean; errors: string[] }

const validator = new Validator(schema as object, "2020-12", false);

export function validateSchema(doc: unknown): ValidationResult {
  const r = validator.validate(doc);
  const errors = r.errors.filter((e) => e.keyword !== "properties" && e.keyword !== "items" && e.keyword !== "$ref" && e.keyword !== "allOf")
    .map((e) => `${e.instanceLocation}: ${e.error}`);
  return { ok: r.valid, errors: r.valid ? [] : errors.length ? errors : r.errors.map((e) => `${e.instanceLocation}: ${e.error}`) };
}

/** Every claim id in the brief, wherever it appears. */
function briefClaims(brief: Brief): Map<string, BriefClaim> {
  const out = new Map<string, BriefClaim>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.id === "string" && typeof o.statement === "string" && typeof o.evidence === "string") out.set(o.id, o as unknown as BriefClaim);
      Object.values(o).forEach(walk);
    }
  };
  walk(brief);
  return out;
}

function allClaimRefs(bp: LaunchBlueprint): { path: string; ref: ClaimRef }[] {
  const out: { path: string; ref: ClaimRef }[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}/${i}`));
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.claim_id === "string" && typeof o.statement === "string") out.push({ path, ref: o as unknown as ClaimRef });
      for (const [k, x] of Object.entries(o)) walk(x, `${path}/${k}`);
    }
  };
  walk(bp, "");
  return out;
}

export function validateSemantics(bp: LaunchBlueprint, brief?: Brief): ValidationResult {
  const e: string[] = [];
  if (bp.launch_policy.auto_launch !== false) e.push("launch_policy.auto_launch must be false");
  if (bp.budget.spend_authorized !== false) e.push("budget.spend_authorized must be false: a ceiling is not purchase authorization");
  if (bp.implementation_status !== "PROPOSED") e.push("a blueprint is always PROPOSED; build progress belongs in build_stages");

  const stages = bp.stages.map((s) => s.stage);
  if (stages.join() !== BUILD_STAGES.join()) e.push(`stages must be exactly ${BUILD_STAGES.join(", ")} in order`);
  const launch = bp.stages.find((s) => s.stage === "launch_readiness");
  if (!launch?.owner_approvals.some((a) => /launch/i.test(a))) e.push("launch_readiness must require the owner's launch approval");
  if (bp.business_kind === "new_business") {
    for (const st of ["research", "blueprint"] as const) {
      if (!bp.stages.find((s) => s.stage === st)?.owner_approvals.length) e.push(`new business: ${st} stage must require an owner approval`);
    }
  }
  for (const s of bp.stages) for (const d of s.depends_on) {
    if (stages.indexOf(d) >= stages.indexOf(s.stage)) e.push(`stage ${s.stage} depends on later stage ${d}`);
  }

  const ids = new Set(bp.products.map((p) => p.product_id));
  if (ids.size !== bp.products.length) e.push("product ids must be unique");
  for (const t of bp.offer_ladder) {
    if (t.product_id && !ids.has(t.product_id)) e.push(`offer_ladder ${t.tier} points at missing product ${t.product_id}`);
    const p = bp.products.find((x) => x.product_id === t.product_id);
    if (p && p.price.value !== t.price.value) e.push(`price mismatch for ${p.product_id}: ladder ${t.price.value} vs product ${p.price.value}`);
  }
  for (const p of bp.products) {
    if (p.playbook !== "unsupported" && !p.gates.includes("G4")) e.push(`${p.product_id}: paid products need G4`);
    if (p.status !== "PROPOSED") e.push(`${p.product_id}: product status in a blueprint must be PROPOSED`);
  }
  if (bp.sales_framework.cta.product_id && !ids.has(bp.sales_framework.cta.product_id)) e.push("cta points at a missing product");
  for (const item of bp.sales_framework.proof.items) if (item.evidence !== "VERIFIED") e.push(`proof ${item.claim_id} is ${item.evidence}; only VERIFIED facts may be used as proof`);
  for (const k of bp.measurement.kpis) if (k.target !== null) e.push(`kpi ${k.id} has a target; targets come from the owner, not the generator`);

  const paths = bp.page_map.map((p) => p.path);
  if (new Set(paths).size !== paths.length) e.push("page paths must be unique");
  for (const legal of ["/privacy/", "/terms/", "/refunds/"]) if (!paths.includes(legal)) e.push(`page map is missing ${legal}`);

  if (brief) {
    if (bp.source_brief.brief_id !== brief.brief_id || bp.source_brief.version !== brief.version) e.push("source_brief does not match the brief supplied");
    const claims = briefClaims(brief);
    for (const { path, ref } of allClaimRefs(bp)) {
      const c = claims.get(ref.claim_id);
      if (!c) e.push(`${path}: claim ${ref.claim_id} is not in brief ${brief.brief_id}`);
      else if (c.statement !== ref.statement || c.evidence !== ref.evidence) e.push(`${path}: claim ${ref.claim_id} differs from the brief`);
    }
  }
  return { ok: e.length === 0, errors: e };
}

export function validateBlueprint(bp: unknown, brief?: Brief): ValidationResult {
  const s = validateSchema(bp);
  if (!s.ok) return s;
  return validateSemantics(bp as LaunchBlueprint, brief);
}
