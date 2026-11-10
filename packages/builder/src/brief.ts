/**
 * The subset of the Intelligence brief (packages/contracts/schemas/intelligence/brief.schema.json, owned by workstream B)
 * that the Builder reads. Briefs are validated against the full schema by the platform on POST /briefs.
 */
export type Evidence = "VERIFIED" | "ESTIMATED" | "INFERRED" | "UNKNOWN";
export interface BriefClaim { id: string; statement: string; evidence: Evidence; confidence?: string; source_ids?: string[]; segment_id?: string }
export interface BriefMetric { value?: number | null; evidence: Evidence; currency?: string; unit?: string; to_resolve?: string }
export interface BriefDecision { date: string; call: "go" | "go_with_changes" | "hold" | "stop"; subject?: string; rationale: string; falsifying_test: string }
export interface Brief {
  schema_version: string; brief_id: string; niche: string; display_name?: string; version: string; status: string;
  created_at: string; updated_at: string;
  summary: { one_line: string; go_hold: BriefDecision; key_findings: BriefClaim[] };
  audience: {
    segments: { id: string; name: string; priority: string; description?: string; platforms?: string[] }[];
    customer_language?: { phrase: string; segment_id?: string }[];
    visual_and_trust_preferences?: BriefClaim[];
  };
  jobs_to_be_done: BriefClaim[]; pains: BriefClaim[]; desired_outcomes?: BriefClaim[];
  buying_triggers: BriefClaim[]; objections: BriefClaim[];
  monetization_options: { id: string; model: string; description: string; fit: string; price_hypothesis?: BriefMetric }[];
  premium_product_recommendation: {
    name: string; target_segment_id?: string; format: string; price: BriefMetric; must_include: string[]; must_not: string[];
    why_they_pay?: string; offer_ladder: { tier: string; item: string; price: BriefMetric }[]; falsifying_test?: string; evidence?: BriefClaim[];
  };
  economics?: { unit_economics?: BriefClaim[]; scenarios?: Record<string, unknown> };
  channel_fit?: { channel: string; fit: "strong" | "moderate" | "weak" | "unknown"; rationale: BriefClaim }[];
  open_questions: string[];
}
