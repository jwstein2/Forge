import { describe, expect, it } from "vitest";
import model from "../../contracts/schemas/intelligence/scoring-model.v1.json" with { type: "json" };
import { rank, scoreCandidate, type ScoringModel } from "../src/score.ts";
import { validatePack } from "../src/pack.ts";
import { classify, normalizeText } from "../src/verify.ts";
import { summarize, parsePageviews, pageviewsUrl } from "../src/signals.ts";
import { applyEvidenceRules } from "../src/apply.ts";
import { connectorStates, unconnectedNames } from "../src/connectors.ts";
import { fixture, pageviewsJson, testPack } from "./helpers.ts";

const M = model as unknown as ScoringModel;

describe("scorer (port of tools/score.py)", () => {
  it("reproduces the v2 portfolio scores from the Python scorer", () => {
    const ranked = rank(M, fixture("portfolio-v2.candidates.json"));
    const by = Object.fromEntries(ranked.map((r) => [r.opportunity_key, r]));
    expect(by["quilt-plan-kit"]!.adjusted_score).toBe(65.0);
    expect(by["quilt-plan-kit"]!.raw_score).toBe(78.0);
    expect(by["bidline"]!.adjusted_score).toBe(52.8);
    expect(by["loaf-ledger"]!.adjusted_score).toBe(51.5);
    expect(ranked.map((r) => r.opportunity_key)).toEqual(["quilt-plan-kit", "bidline", "loaf-ledger"]);
    expect(by["quilt-plan-kit"]!.recommended).toBe(true);
    expect(by["quilt-plan-kit"]!.recommendation_strength).toBe("clear");
    expect(by["bidline"]!.eligible_for_recommendation).toBe(false); // free-channel gate
  });

  it("an optimistic INFERRED 5/5 ranks below a VERIFIED 4.2/5", () => {
    const all = (score: number, evidence: string) => M.criteria.map((c) => ({ key: c.key, score, evidence: evidence as any, rationale: "" }));
    const r = rank(M, [{ opportunity_key: "hype", criterion_scores: all(5, "INFERRED") }, { opportunity_key: "proven", criterion_scores: all(4.2, "VERIFIED") }]);
    expect(r[0]!.opportunity_key).toBe("proven");
  });

  it("excludes a candidate failing an exclude gate and scores UNKNOWN as 1", () => {
    const s = scoreCandidate(M, { opportunity_key: "x", criterion_scores: [], gates: [{ key: "ip_clean", passed: false }] });
    expect(s.excluded).toBe(true);
    expect(s.raw_score).toBe(20.0);
    expect(s.evidence_coverage).toBe(0);
  });
});

describe("evidence pack validation", () => {
  it("accepts the test pack", () => expect(validatePack(testPack())).toEqual([]));
  it("rejects unknown sources, unsourced VERIFIED and UNKNOWN without to_resolve", () => {
    const p = testPack();
    p.candidates[0]!.claims.push({ id: "c_bad", statement: "x", evidence: "VERIFIED", confidence: "low", method: "analyst_inference", source_ids: [], observed_at: "2026-11-10" });
    p.candidates[0]!.claims.push({ id: "c_bad2", statement: "x", evidence: "UNKNOWN", confidence: "low", method: "analyst_inference", source_ids: ["src_nope"], observed_at: "2026-11-10" });
    const e = validatePack(p).join("\n");
    expect(e).toContain("c_bad is VERIFIED without a source");
    expect(e).toContain("unknown source src_nope");
    expect(e).toContain("c_bad2 is UNKNOWN without to_resolve");
  });
  it("bounds fan-out", () => {
    const p = testPack(); p.candidates = Array.from({ length: 9 }, (_, i) => ({ ...p.candidates[0]!, key: `k-${i}` }));
    expect(validatePack(p).join()).toContain("at most 8 candidates");
  });
});

describe("source re-check", () => {
  it("classifies outcomes", () => {
    expect(classify(404, false, "", ["$5"]).outcome).toBe("dead");
    expect(classify(403, false, "", ["$5"]).outcome).toBe("unreachable");
    expect(classify(null, false, "", ["$5"]).outcome).toBe("unreachable");
    expect(classify(200, true, "anything", undefined).outcome).toBe("reachable");
    expect(classify(200, true, normalizeText("<p>Price&nbsp;$18.00</p><script>var x='$99'</script>"), ["$18.00"]).outcome).toBe("confirmed");
    const m = classify(200, true, normalizeText("<p>Price $21.00</p>"), ["$18.00"]);
    expect(m.outcome).toBe("mismatch");
    expect(m.missing).toEqual(["$18.00"]);
  });
});

describe("Wikimedia signal summary", () => {
  it("builds the request window to the last full month and finds the December peak", () => {
    expect(pageviewsUrl("Bread", new Date("2026-11-10T00:00:00Z"))).toMatch(/Bread\/monthly\/2021110100\/2026100100$/);
    const s = summarize(parsePageviews(pageviewsJson()));
    expect(s.months).toBe(60);
    expect(s.peakMonths).toContain("Dec");
    expect(s.troughMonths).toContain("Jun");
    expect(s.yoyChangePct).not.toBeNull();
  });
});

describe("evidence rules", () => {
  const cand = () => testPack().candidates[0]!;
  it("R1 + R2: a dead source downgrades the claim and the criterion citing it", () => {
    const { candidate, downgrades } = applyEvidenceRules(cand(), [{ sourceId: "src_alpha_kit_listing", url: "u", outcome: "dead", httpStatus: 404, missing: [] }]);
    expect(candidate.claims.every((c) => c.evidence === "INFERRED")).toBe(true);
    expect(candidate.criterion_scores.find((c) => c.key === "demand_evidence")!.evidence).toBe("INFERRED");
    expect(downgrades.map((d) => d.rule)).toEqual(expect.arrayContaining(["R1", "R2"]));
  });
  it("unreachable sources do not downgrade", () => {
    const { downgrades } = applyEvidenceRules(cand(), [{ sourceId: "src_alpha_kit_listing", url: "u", outcome: "unreachable", httpStatus: 403, missing: [] }]);
    expect(downgrades).toEqual([]);
  });
  it("R3: VERIFIED demand needs a demand-measuring claim", () => {
    const c = cand();
    c.criterion_scores[0]!.claim_ids = ["c_alpha_kit_price"];
    const { candidate, downgrades } = applyEvidenceRules(c, []);
    expect(candidate.criterion_scores[0]!.evidence).toBe("INFERRED");
    expect(downgrades[0]!.rule).toBe("R3");
  });
});

describe("connectors", () => {
  it("never reports a credentialed source as connected without its secret", () => {
    const names = connectorStates({}).filter((c) => c.status !== "connected").map((c) => c.id);
    expect(unconnectedNames(connectorStates({})).length).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["google_trends", "keyword_planner", "search_console", "semrush_similarweb"]));
    expect(connectorStates({}).find((c) => c.id === "wikimedia_pageviews")?.status).toBe("connected");
  });
});
