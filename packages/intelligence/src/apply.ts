/**
 * Evidence rules applied after sources are re-checked. These run before scoring, so a broken source can never
 * raise a score:
 *  R1  A VERIFIED or ESTIMATED claim whose every cited source is dead or no longer shows the quoted figure becomes INFERRED.
 *  R2  A VERIFIED or ESTIMATED criterion must cite at least one claim that is still VERIFIED/ESTIMATED; otherwise INFERRED.
 *  R3  demand_evidence may be VERIFIED only when a cited claim measures demand (marketplace sales or review counts,
 *      first-party analytics or sales, or keyword volume). Audience size and price points alone are INFERRED (QA-001 I1).
 *  Unreachable sources (bot walls, 403/429, timeouts) do not downgrade; they are reported so a person can re-check them.
 *  Claims with method listing_absence_observation ("this listing was removed") are exempt from R1: a dead page confirms them (QA-013 I4-4).
 */
import { HARD_FAIL } from "./verify.ts";
import type { Claim, CriterionInput, EvidenceLabel, PackCandidate, SourceCheck } from "./types.ts";

export const ABSENCE_METHOD = "listing_absence_observation";
export const DEMAND_METHODS = new Set(["marketplace_listing_observation", "first_party_analytics", "first_party_sales", "keyword_volume"]);

export interface Downgrade { target: string; from: EvidenceLabel; to: EvidenceLabel; rule: "R1" | "R2" | "R3"; reason: string }

export function failedSources(checks: SourceCheck[]): Set<string> {
  return new Set(checks.filter((c) => HARD_FAIL.has(c.outcome)).map((c) => c.sourceId));
}

export function applyClaimRule(claims: Claim[], failed: Set<string>, log: Downgrade[]): Claim[] {
  return claims.map((c) => {
    if (c.method !== ABSENCE_METHOD && (c.evidence === "VERIFIED" || c.evidence === "ESTIMATED") && c.source_ids.length && c.source_ids.every((s) => failed.has(s))) {
      log.push({ target: c.id, from: c.evidence, to: "INFERRED", rule: "R1", reason: `cited source(s) ${c.source_ids.join(", ")} failed re-check` });
      return { ...c, evidence: "INFERRED", notes: [c.notes, "Downgraded at Scout run: cited source failed re-check."].filter(Boolean).join(" ") };
    }
    return c;
  });
}

export function applyCriterionRules(scores: CriterionInput[], claims: Claim[], log: Downgrade[]): CriterionInput[] {
  const byId = new Map(claims.map((c) => [c.id, c]));
  return scores.map((s) => {
    if (s.evidence !== "VERIFIED" && s.evidence !== "ESTIMATED") return s;
    const cited = (s.claim_ids ?? []).map((id) => byId.get(id)).filter((c): c is Claim => !!c);
    const strong = cited.filter((c) => c.evidence === "VERIFIED" || c.evidence === "ESTIMATED");
    if (!strong.length) {
      log.push({ target: s.key, from: s.evidence, to: "INFERRED", rule: "R2", reason: cited.length ? "no cited claim is still VERIFIED/ESTIMATED" : "no claim cited" });
      return { ...s, evidence: "INFERRED", rationale: `${s.rationale} [R2: downgraded, no supporting claim]` };
    }
    if (s.key === "demand_evidence" && s.evidence === "VERIFIED" && !strong.some((c) => DEMAND_METHODS.has(c.method))) {
      log.push({ target: s.key, from: "VERIFIED", to: "INFERRED", rule: "R3", reason: "no cited claim measures demand" });
      return { ...s, evidence: "INFERRED", rationale: `${s.rationale} [R3: audience size or prices are not measured demand]` };
    }
    return s;
  });
}

/** Walk any document and apply R1 to every embedded claim-shaped object (used on full briefs). */
export function downgradeDocClaims<T>(doc: T, failed: Set<string>, log: Downgrade[]): T {
  const walk = (o: any): any => {
    if (Array.isArray(o)) return o.map(walk);
    if (o && typeof o === "object") {
      const out: any = {};
      for (const [k, v] of Object.entries(o)) out[k] = walk(v);
      if (typeof out.id === "string" && out.id.startsWith("c_") && Array.isArray(out.source_ids) && out.source_ids.length
        && out.method !== ABSENCE_METHOD && (out.evidence === "VERIFIED" || out.evidence === "ESTIMATED") && out.source_ids.every((s: string) => failed.has(s))) {
        log.push({ target: out.id, from: out.evidence, to: "INFERRED", rule: "R1", reason: "brief claim's cited source(s) failed re-check" });
        out.evidence = "INFERRED"; out.notes = [out.notes, "Downgraded at Scout run: cited source failed re-check."].filter(Boolean).join(" ");
      }
      return out;
    }
    return o;
  };
  return walk(doc);
}

export function applyEvidenceRules(c: PackCandidate, checks: SourceCheck[]) {
  const log: Downgrade[] = [];
  const failed = failedSources(checks);
  const claims = applyClaimRule(c.claims, failed, log);
  const criterion_scores = applyCriterionRules(c.criterion_scores, claims, log);
  const brief = c.brief ? downgradeDocClaims(c.brief, failed, log) : undefined;
  return { candidate: { ...c, claims, criterion_scores, ...(brief ? { brief } : {}) }, downgrades: log };
}
