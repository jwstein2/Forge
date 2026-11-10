/**
 * Launch Blueprint v1 types. The JSON Schema in ../schemas/launch-blueprint.schema.json is authoritative;
 * these types mirror it. Field names are snake_case like the Intelligence documents the blueprint is built from.
 */
import type { BuildStage } from "@forge/contracts";

export const BLUEPRINT_SCHEMA_VERSION = "1.0.0";
export const GENERATOR_VERSION = "1.0.0";

export type Evidence = "VERIFIED" | "ESTIMATED" | "INFERRED" | "UNKNOWN";
export type ImplStatus = "PROPOSED" | "BUILT" | "TESTED" | "LIVE" | "FAILED" | "UNVERIFIED";
export type GateId =
  | "B0" | "B1"
  | "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8" | "G9" | "G10" | "G11" | "G12" | "G13" | "G14" | "G15";

export type PlaybookId =
  | "free-resource" | "spreadsheet-template" | "printable-pdf" | "bundle" | "kdp-book" | "affiliate-content" | "unsupported";

export interface Price { value: number | null; currency: "USD"; evidence: Evidence; note?: string }

/** A pointer back to the brief so every derived statement can be traced. */
export interface ClaimRef { claim_id: string; statement: string; evidence: Evidence }

export interface OfferTier {
  tier: string; item: string; price: Price; product_id: string | null; playbook: PlaybookId;
}

export interface Deliverable { kind: string; file_format: string; spec: string }

export interface ProductSpec {
  product_id: string; name: string; tier: string; playbook: PlaybookId; format: string; price: Price;
  target_segment_id: string | null; must_include: string[]; must_not: string[]; deliverables: Deliverable[];
  gates: GateId[]; status: ImplStatus; basis: ClaimRef[];
  falsifying_test: string | null;
  registry_product_id: string | null;
}

export interface PageSpec {
  path: string; purpose: string; template: string; sections: string[]; required_for_launch: boolean; gates: GateId[];
}

export interface ChannelPlan {
  channel: string; fit: "strong" | "moderate" | "weak" | "unknown"; priority: "launch" | "after_launch" | "hold";
  owner_role: string; integration_required: string | null; owner_approval_required: boolean; cadence: string | null;
  basis: ClaimRef | null;
}

export interface Integration {
  id: string; service: string; purpose: string; status: "unconnected" | "connected" | "not_applicable";
  owner_approval_required: boolean; shared_component: string | null; note: string;
}

export interface StageTask { id: string; title: string; role: string; kind: "deterministic" | "model" | "owner" }

export interface StagePlan {
  stage: BuildStage; goal: string; depends_on: BuildStage[]; inputs: string[]; tasks: StageTask[]; outputs: string[];
  gates: GateId[]; owner_approvals: string[];
}

export interface Unknown { field: string; statement: string; resolve_by: string }

export interface LaunchBlueprint {
  schema_version: string;
  blueprint_id: string;
  niche: string;
  display_name: string;
  version: string;
  supersedes: string | null;
  status: "draft" | "approved" | "superseded";
  implementation_status: "PROPOSED";
  created_at: string;
  approved_by: string | null;
  generated_by: { tool: "@forge/builder"; tool_version: string; deterministic: true };
  business_kind: "existing_niche" | "new_business";
  source_brief: { brief_id: string; version: string; status: string; content_hash: string };
  opportunity_ref: { opportunity_id: string; rank: number | null; recommended: boolean } | null;
  launch_policy: { auto_launch: false; owner_approval_required_for: string[] };
  go_hold: { call: string; subject: string | null; rationale: string; falsifying_test: string };
  positioning: {
    one_line: string; primary_segment_id: string | null;
    segments: { id: string; name: string; priority: string }[];
    desired_outcomes: ClaimRef[];
  };
  offer_ladder: OfferTier[];
  products: ProductSpec[];
  brand: { direction: ClaimRef[]; requirements: string[]; asset_rights_policy: string; status: ImplStatus };
  sales_framework: {
    promise: { draft: string; basis: ClaimRef[] };
    pain: ClaimRef[];
    proof: { allowed_kinds: string[]; items: ClaimRef[]; status: "needs_genuine_proof" | "has_candidates"; rule: string };
    plan: string[];
    picture: { draft: string; basis: ClaimRef[] };
    cta: { label: string; product_id: string | null };
    objections: { claim: ClaimRef; response: string | null }[];
    customer_language: string[];
  };
  page_map: PageSpec[];
  channel_plan: ChannelPlan[];
  integrations: Integration[];
  measurement: {
    ledger_vertical: string; beacon_path_prefix: string;
    kpis: { id: string; label: string; target: number | null; unit: string; state: "unknown" }[];
    falsifying_tests: string[];
  };
  economics: { note: string; scenarios: Record<string, unknown> | null };
  budget: { ceiling_cents: number | null; state: "owner_to_set" | "set"; spend_authorized: false };
  permissions: { allowed: string[]; requires_owner_approval: string[]; prohibited: string[] };
  stages: StagePlan[];
  done_criteria: string[];
  unknowns: Unknown[];
  changelog: { version: string; date: string; change: string }[];
}
