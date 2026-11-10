import { describe, expect, it } from "vitest";
import { checkReceipt, REVIEWERS } from "../src/assurance/reviewers.ts";
import { defaultCapFor, resolveJobPolicy } from "../src/finance/job-policy.ts";
import { runDataControls } from "../src/controls-run.ts";

const base = { gate: "G4", result: "PASS", evidence: ["forge/assurance/QA-003.md"], at: "2026-11-10T03:30:00Z" };

describe("authorised QA reviewers for gate receipts", () => {
  it("accepts independent QA and the owner, by id or alias, for another workstream's work", () => {
    expect(checkReceipt({ ...base, reviewer: "Review FORGE builds independently", producer: "builder" })).toEqual({ ok: true, reviewerId: "qa-forge-builds" });
    expect(checkReceipt({ ...base, reviewer: "James", producer: "Reach first verified live dollar" })).toEqual({ ok: true, reviewerId: "owner" });
  });
  it.each([
    ["a producer signing", { reviewer: "builder", producer: "operator" }, "unknown_reviewer"],
    ["an unregistered name", { reviewer: "Some Agent", producer: "builder" }, "unknown_reviewer"],
    ["self-review by alias", { reviewer: "workstream-g", producer: "QA_FORGE builds" }, "same_workstream"],
    ["a PASS with no evidence", { reviewer: "qa-forge-builds", producer: "builder", evidence: [] }, "no_evidence"],
    ["an invalid result", { reviewer: "qa-forge-builds", producer: "builder", result: "OK" }, "bad_result"],
    ["before the reviewer was active", { reviewer: "qa-forge-builds", producer: "builder", at: "2026-11-01T00:00:00Z" }, "inactive"],
  ])("refuses %s", (_n, over, reason) => {
    expect(checkReceipt({ ...base, ...over } as any)).toEqual({ ok: false, reason });
  });
  it("FAIL receipts need no evidence (they block anyway) and gate scope is enforced", () => {
    expect(checkReceipt({ ...base, result: "FAIL", evidence: [], reviewer: "qa-forge-builds", producer: "builder" }).ok).toBe(true);
    const scoped = { ...REVIEWERS, reviewers: [{ ...REVIEWERS.reviewers[0]!, gates: ["G1"] }] };
    expect(checkReceipt({ ...base, reviewer: "qa-forge-builds", producer: "builder" }, scoped)).toEqual({ ok: false, reason: "gate_out_of_scope" });
  });
});

describe("job cost policy", () => {
  it("defaults caps by kind; handler declarations override the table", () => {
    expect(defaultCapFor("ops.content_draft", undefined)).toBe(300);
    expect(defaultCapFor("ledger.sync", null)).toBe(0);
    expect(defaultCapFor("x.unknown", undefined)).toBeNull();
    expect(defaultCapFor("x.unknown", undefined, { runType: "build" })).toBe(1500);
    expect(resolveJobPolicy("ops.content_draft", { usesModel: false })?.usesModel).toBe(false);
  });
  it("data controls run ledger, price and budget checks once", () => {
    const f = runDataControls({ sales: [], products: [{ id: "p", nicheId: "bidline", name: "Kit", tier: "paid", sitePriceCents: 1900, checkoutPriceCents: 1999, ledgerProductName: null }],
      budgets: [{ id: "bud_api_month", scope: "Monthly model API cap", ceilingCents: 1500, approvedCents: 1500, spentCents: 0, evidence: "ESTIMATED", notes: null }], modelUsageMonthToDateCents: 1300 });
    expect(f.map((x) => x.code).sort()).toEqual(["FIN-BG-01", "FIN-PR-01"]);
  });
});
