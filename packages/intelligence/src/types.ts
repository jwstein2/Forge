/** Evidence pack: the input to an Opportunity Scout run. Content shapes reuse the Intelligence JSON Schemas. */
export type EvidenceLabel = "VERIFIED" | "ESTIMATED" | "INFERRED" | "UNKNOWN";

export interface PackSource {
  id: string; title: string; url: string; kind: string; accessed_at: string;
  publisher?: string; published?: string | null; reliability_note?: string;
  /** Strings that must appear on the live page for the cited figure to count as re-confirmed (e.g. "$18.00", "1.8k sales"). */
  expect?: string[];
}

export interface Claim {
  id: string; statement: string; evidence: EvidenceLabel; confidence: "high" | "medium" | "low"; method: string;
  source_ids: string[]; observed_at: string; value?: number | string | null; unit?: string; to_resolve?: string; notes?: string; segment_id?: string;
}

export interface CriterionInput { key: string; score: number | null; evidence: EvidenceLabel; rationale: string; claim_ids?: string[] }
export interface GateInput { key: string; passed: boolean; note?: string }

export interface PackCandidate {
  key: string; title: string; customer_segment: string; problem: string;
  proposed_offer: { model: string; description: string; price: Record<string, unknown> };
  hypothesis?: string; why_beats_alternatives?: string; falsifying_test?: string; launch_effort?: string; support_load?: string;
  confidence: "high" | "medium" | "low";
  criterion_scores: CriterionInput[];
  gates: GateInput[];
  claims: Claim[];
  seasonality?: Record<string, unknown>[];
  economics?: Record<string, unknown>;
  /** Free public signal subjects collected by the run (no credentials). */
  signals?: { wikipedia_articles?: string[] };
  /** Full Audience & Market Brief (brief.schema.json) for candidates researched in depth. */
  brief?: Record<string, any>;
}

export interface EvidencePack {
  schema: "forge.evidence-pack/1";
  label: string; prepared_by: string; prepared_at: string;
  method_note?: string;
  sources: PackSource[];
  candidates: PackCandidate[];
}

export type SourceOutcome = "confirmed" | "reachable" | "mismatch" | "dead" | "unreachable" | "skipped";
export interface SourceCheck { sourceId: string; url: string; outcome: SourceOutcome; httpStatus: number | null; missing: string[] }
