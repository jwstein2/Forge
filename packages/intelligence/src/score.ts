/**
 * Deterministic opportunity scorer (TypeScript port of forge/intelligence/tools/score.py; same inputs, same ranking).
 * Score = 100 * sum(weight * score/5). Adjusted multiplies each criterion by its evidence multiplier; UNKNOWN is scored
 * as the pessimistic prior. Exclude gates drop a candidate; cannot_recommend gates keep its rank but block the recommendation.
 */
import type { CriterionInput, GateInput } from "./types.ts";

export interface ScoringModel {
  version: string; model_id: string;
  criteria: { key: string; weight: number; required_for_recommendation?: boolean }[];
  evidence_multipliers: Record<string, number>;
  unknown_policy: { score_as: number };
  gates: { key: string; on_fail: "exclude" | "cannot_recommend" | "flag" }[];
  recommendation_rules: { candidates_min: number; candidates_max: number; rank_by: "adjusted_score" | "raw_score"; min_evidence_coverage: number; min_margin_for_strong: number };
}
export interface ScoreInput { opportunity_key: string; criterion_scores: CriterionInput[]; gates?: GateInput[] }
export interface Scored extends ScoreInput {
  raw_score: number; adjusted_score: number; evidence_coverage: number; excluded: boolean;
  eligible_for_recommendation: boolean; missing_required: string[]; rank: number; recommended: boolean; recommendation_strength: "clear" | "narrow" | "none";
}

const r1 = (x: number) => Math.round(x * 10) / 10;

export function scoreCandidate(model: ScoringModel, cand: ScoreInput): Omit<Scored, "rank" | "recommended" | "recommendation_strength"> {
  const given = new Map(cand.criterion_scores.map((s) => [s.key, s]));
  let raw = 0, adj = 0, covered = 0; const missing: string[] = [];
  for (const c of model.criteria) {
    const s = given.get(c.key);
    const ev = s?.evidence ?? "UNKNOWN";
    const val = ev === "UNKNOWN" || s?.score == null ? model.unknown_policy.score_as : Number(s.score);
    if (ev === "UNKNOWN" && c.required_for_recommendation) missing.push(c.key);
    if (ev !== "UNKNOWN") covered += c.weight;
    raw += (c.weight * val) / 5;
    adj += ((c.weight * val) / 5) * (model.evidence_multipliers[ev] ?? 0);
  }
  const gates = new Map((cand.gates ?? []).map((g) => [g.key, g.passed]));
  const failed = (mode: string) => model.gates.some((g) => g.on_fail === mode && gates.get(g.key) === false);
  const excluded = failed("exclude"); const blocked = failed("cannot_recommend");
  const coverage = Math.round(covered * 100) / 100;
  return { ...cand, raw_score: r1(raw * 100), adjusted_score: r1(adj * 100), evidence_coverage: coverage, excluded,
    eligible_for_recommendation: !excluded && !blocked && !missing.length && covered + 1e-9 >= model.recommendation_rules.min_evidence_coverage, missing_required: missing };
}

export function rank(model: ScoringModel, cands: ScoreInput[]): Scored[] {
  const rr = model.recommendation_rules;
  const scored = cands.map((c) => scoreCandidate(model, c)).filter((s) => !s.excluded)
    .sort((a, b) => b[rr.rank_by] - a[rr.rank_by] || b.evidence_coverage - a.evidence_coverage || a.opportunity_key.localeCompare(b.opportunity_key))
    .map((s, i): Scored => ({ ...s, rank: i + 1, recommended: false, recommendation_strength: "none" }));
  const top = scored.find((s) => s.eligible_for_recommendation);
  if (top) {
    top.recommended = true;
    const next = scored.find((s) => s !== top);
    const lead = top[rr.rank_by] - (next ? next[rr.rank_by] : 0);
    top.recommendation_strength = lead >= rr.min_margin_for_strong ? "clear" : "narrow";
  }
  return scored.slice(0, rr.candidates_max);
}
