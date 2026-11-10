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
    e.push(...traceText(bp, brief));
  }
  return { ok: e.length === 0, errors: e };
}

const NUM = /\d+(?:[.,]\d+)?/g;
const numbers = (s: string) => (s.match(NUM) ?? []).map((n) => n.replace(",", ""));

/**
 * QA-004 B1/B2: prices and free text must come from the brief.
 * Prices: value and evidence equal the brief's offer ladder. Drafts: equal a cited basis claim verbatim.
 * Plan and CTA: every figure must already appear in a product price, name or must_include line.
 * Positioning and the go/hold decision: verbatim from the brief. Objection responses: written later under G2, so null here.
 */
function traceText(bp: LaunchBlueprint, brief: Brief): string[] {
  const e: string[] = [];
  const ladder = brief.premium_product_recommendation.offer_ladder;
  for (const t of bp.offer_ladder) {
    const src = ladder.find((x) => x.tier === t.tier && x.item === t.item);
    if (!src) { e.push(`offer_ladder ${t.tier} "${t.item}" is not in the brief's offer ladder`); continue; }
    const v = src.price?.value ?? null;
    if (v === null) { if (t.price.value !== null || t.price.evidence !== "UNKNOWN") e.push(`offer_ladder ${t.tier}: the brief has no price, so it must be null/UNKNOWN`); }
    else if (t.price.value !== v || t.price.evidence !== src.price.evidence) e.push(`offer_ladder ${t.tier}: price ${t.price.value} (${t.price.evidence}) differs from the brief's ${v} (${src.price.evidence})`);
  }
  if (bp.offer_ladder.length !== ladder.length) e.push("offer ladder must contain exactly the brief's tiers");
  for (const p of bp.products) {
    const tier = bp.offer_ladder.find((t) => t.product_id === p.product_id);
    if (!tier) e.push(`${p.product_id} is not on the offer ladder`);
    else if (p.price.value !== tier.price.value || p.price.evidence !== tier.price.evidence) e.push(`${p.product_id}: price or evidence differs from its ladder tier`);
  }
  const sf = bp.sales_framework;
  for (const [name, d] of [["promise", sf.promise], ["picture", sf.picture]] as const) {
    if (d.draft !== "" && !d.basis.some((b) => b.statement === d.draft)) e.push(`sales_framework.${name}.draft must be empty or a cited basis claim verbatim; new copy is written and reviewed under G2`);
  }
  const allowed = new Set(bp.products.flatMap((p) => [String(p.price.value ?? ""), ...numbers(p.name), ...p.must_include.flatMap(numbers)]));
  for (const [where, text] of [...sf.plan.map((s, i) => [`plan[${i}]`, s] as const), ["cta.label", sf.cta.label] as const]) {
    for (const n of numbers(text)) if (!allowed.has(n)) e.push(`sales_framework.${where}: figure "${n}" is not a product price or spec in this blueprint`);
  }
  if (sf.objections.some((o) => o.response !== null)) e.push("objection responses are written at the website stage (G2), not in the blueprint");
  if (bp.positioning.one_line !== brief.summary.one_line) e.push("positioning.one_line must be the brief's summary verbatim");
  const g = brief.summary.go_hold;
  if (bp.go_hold.call !== g.call || bp.go_hold.rationale !== g.rationale || bp.go_hold.falsifying_test !== g.falsifying_test) e.push("go_hold must match the brief's decision verbatim");
  return e;
}

/** Full validation. The brief is required: without it claims, prices and copy cannot be traced (QA-004 B6). */
export function validateBlueprint(bp: unknown, brief: Brief): ValidationResult {
  if (!brief) return { ok: false, errors: ["a source brief is required to validate a blueprint (claims, prices and copy are traced to it)"] };
  const s = validateSchema(bp);
  if (!s.ok) return s;
  return validateSemantics(bp as LaunchBlueprint, brief);
}
