import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Budget } from "@forge/contracts";
import { checkLedger, recomputeRevenue, type RawSale } from "../src/finance/ledger.ts";
import { parseProviderCsv, reconcile } from "../src/finance/reconcile.ts";
import { authorizeSpend, budgetFindings, capForRunType, monthToDate, type ApprovalRecord } from "../src/finance/budget.ts";
import { estimateLsFeeCents, monthWindow } from "../src/finance/money.ts";
import { gateResult } from "../src/findings.ts";

const snapshot = JSON.parse(readFileSync(new URL("../../../services/api/fixtures/ledger-snapshot-2026-11-10.json", import.meta.url), "utf8"));
const products = JSON.parse(readFileSync(new URL("../../../registry/products.json", import.meta.url), "utf8")).products;
const ALL = { start: "2000-01-01T00:00:00Z", end: "2100-01-01T00:00:00Z" };

const sale = (o: Partial<RawSale>): RawSale => ({ id: `order_created:${o.order_id ?? "1"}`, event: "order_created", order_id: "1", test_mode: 0, currency: "USD",
  total_cents: 800, tax_cents: 0, refunded_cents: 0, product: "The Quilt Planner — Printable PDF", created_at: "2026-11-10T12:00:00Z", vertical: "quilt-plan-kit", owner_test: 0, ...o });

describe("revenue recompute (independent of the platform import)", () => {
  it("real snapshot: $0 live revenue, test orders reported separately", () => {
    const r = recomputeRevenue(snapshot.sales, ALL);
    expect(r.liveTotal).toEqual({ orders: 0, grossCents: 0, refundsCents: 0, taxCents: 0 });
    expect(r.testMode.orders).toBe(2);
    expect(r.testMode.grossCents).toBe(800 + 1999);
    expect(r.ownerTestColumnPresent).toBe(false);
  });
  it("excludes test-mode and owner-test orders, nets tax, attributes by vertical", () => {
    const rows = [
      sale({ order_id: "a", total_cents: 1900, tax_cents: 100, vertical: "bidline" }),
      sale({ order_id: "b", owner_test: 1 }),
      sale({ order_id: "c", test_mode: 1 }),
      sale({ order_id: "d", vertical: "unknown" }),
      { ...sale({ order_id: "a", vertical: "bidline" }), id: "order_refunded:a", event: "order_refunded", refunded_cents: 1900 },
    ];
    const r = recomputeRevenue(rows, ALL);
    expect(r.live.bidline).toEqual({ orders: 1, grossCents: 1800, refundsCents: 1900, taxCents: 100 });
    expect(r.liveTotal.orders).toBe(2);
    expect(r.unattributed.orders).toBe(1);
    expect(r.ownerTest.orders).toBe(1);
    expect(r.testMode.orders).toBe(1);
  });
  it("respects the period window", () => {
    expect(recomputeRevenue([sale({ created_at: "2026-10-31T23:59:59Z" })], { start: "2026-11-01T00:00:00Z", end: "2026-12-01T00:00:00Z" }).liveTotal.orders).toBe(0);
  });
});

describe("ledger integrity checks", () => {
  it("real registry + snapshot: flags the Bidline $19 vs $19.99 mismatch as an owner decision, and missing owner_test", () => {
    const f = checkLedger(snapshot.sales, products);
    const price = f.find((x) => x.code === "FIN-PR-01");
    expect(price?.nicheId).toBe("bidline");
    expect(price?.needsOwner).toBe(true);
    expect(f.some((x) => x.code === "FIN-LI-06")).toBe(true);
    expect(gateResult(f, "G5")).toBe("FAIL");
  });
  it("flags unattributed live orders, duplicates, over-refunds, orphan refunds, non-USD", () => {
    const rows = [
      sale({ order_id: "u", vertical: "unknown" }),
      sale({ order_id: "x" }), sale({ order_id: "x" }),
      { ...sale({ order_id: "y" }), id: "r:y", event: "order_refunded", refunded_cents: 99999 },
      sale({ order_id: "y" }),
      { ...sale({ order_id: "z" }), id: "r:z", event: "order_refunded", refunded_cents: 100 },
      sale({ order_id: "e", currency: "EUR" }),
    ];
    const codes = checkLedger(rows, []).map((x) => x.code).sort();
    expect(codes).toEqual(["FIN-LI-01", "FIN-LI-02", "FIN-LI-03", "FIN-LI-04", "FIN-LI-05"]);
  });
  it("test-mode rows with no vertical are not a revenue integrity failure", () => {
    expect(checkLedger([sale({ test_mode: 1, vertical: "unknown" })], []).filter((x) => x.code === "FIN-LI-01")).toHaveLength(0);
  });
});

describe("payout reconciliation", () => {
  const ledger = [sale({ order_id: "1001", total_cents: 800 }), sale({ order_id: "1002", total_cents: 1900, vertical: "bidline" }), sale({ order_id: "t1", test_mode: 1 })];
  it("matches within one cent and reports provider fees", () => {
    const csv = `Order ID,Total,Tax,Refunded amount,Fee,Test mode\n1001,$8.00,0,0,0.90,false\n1002,"$19.00",0,0,1.45,false\nt9,8.00,0,0,0,true`;
    const r = reconcile(ledger, parseProviderCsv(csv));
    expect(r.status).toBe("matched");
    expect(r.providerFeesCents).toBe(235);
  });
  it("detects missed webhooks and amount differences", () => {
    const r = reconcile(ledger, [
      { orderId: "1001", totalCents: 800, taxCents: 0, refundedCents: 800, feeCents: 90, testMode: false },
      { orderId: "1003", totalCents: 800, taxCents: 0, refundedCents: 0, feeCents: 90, testMode: false },
    ]);
    expect(r.status).toBe("mismatched");
    expect(r.missingInLedger).toEqual(["1003"]);
    expect(r.missingAtProvider).toEqual(["1002"]);
    expect(r.amountMismatches[0]?.orderId).toBe("1001");
    expect(r.findings[0]?.severity).toBe("critical");
  });
  it("rejects a CSV without the needed columns", () => {
    expect(() => parseProviderCsv("a,b\n1,2")).toThrow();
  });
});

describe("spend guard: default deny, ceiling is not authorization", () => {
  const budgets: Budget[] = JSON.parse(readFileSync(new URL("../../../registry/budgets.json", import.meta.url), "utf8")).budgets;
  const now = new Date("2026-11-10T03:00:00Z");
  const appr = (o: Partial<ApprovalRecord>): ApprovalRecord => ({ id: "apr_1", scope: "spend", status: "approved", decidedBy: "owner", expiresAt: null, boundary: { budgetId: "bud_forge", vendor: "Cloudflare Registrar", maxCents: 1100 }, ...o });
  const cash = { kind: "cash" as const, budgetId: "bud_forge", vendor: "Cloudflare Registrar", amountCents: 1100 };

  it("denies cash spend with no approval even though the ceiling has room", () => {
    expect(authorizeSpend(cash, budgets, [], now)).toMatchObject({ allowed: false, code: "approval_required" });
  });
  it("allows bounded, matching, owner-decided approval", () => {
    expect(authorizeSpend({ ...cash, approvalId: "apr_1" }, budgets, [appr({})], now).allowed).toBe(true);
  });
  it.each([
    ["pending", appr({ status: "pending", decidedBy: null }), "approval_not_granted"],
    ["expired", appr({ expiresAt: "2026-11-01T00:00:00Z" }), "approval_expired"],
    ["other vendor", appr({ boundary: { budgetId: "bud_forge", vendor: "Namecheap", maxCents: 1100 } }), "approval_scope"],
    ["unbounded", appr({ boundary: { budgetId: "bud_forge" } }), "approval_unbounded"],
    ["too small", appr({ boundary: { budgetId: "bud_forge", maxCents: 1000 } }), "approval_amount"],
  ])("denies when approval is %s", (_n, a, code) => {
    expect(authorizeSpend({ ...cash, approvalId: "apr_1" }, budgets, [a], now).code).toBe(code);
  });
  it("an approval cannot lift the ceiling", () => {
    const big = { ...cash, amountCents: 200000, approvalId: "apr_1" };
    expect(authorizeSpend(big, budgets, [appr({ boundary: { maxCents: 300000 } })], now).code).toBe("ceiling");
  });
  it("recurring charges need a recurring approval; unknown amounts are denied", () => {
    expect(authorizeSpend({ ...cash, recurring: true, approvalId: "apr_1" }, budgets, [appr({})], now).code).toBe("approval_recurring");
    expect(authorizeSpend({ ...cash, amountCents: null, approvalId: "apr_1" }, budgets, [appr({})], now).code).toBe("unknown_amount");
  });
  it("model usage runs inside the $15 monthly envelope and stops at it", () => {
    const req = { kind: "model_usage" as const, budgetId: "bud_api_month", vendor: "Anthropic", amountCents: 300 };
    expect(authorizeSpend(req, budgets, [], now, 1100).allowed).toBe(true);
    expect(authorizeSpend(req, budgets, [], now, 1300)).toMatchObject({ allowed: false, code: "envelope_exceeded" });
  });
  it("budget findings warn at 80%, block at 100%, and count unknown usage", () => {
    const f = budgetFindings(budgets, { budgetId: "bud_api_month", cents: 1250, unknownRows: 2 });
    expect(f.map((x) => x.code).sort()).toEqual(["FIN-BG-01", "FIN-BG-04"]);
    expect(budgetFindings(budgets, { budgetId: "bud_api_month", cents: 1500, unknownRows: 0 })[0]).toMatchObject({ code: "FIN-BG-02", needsOwner: true });
  });
  it("month-to-date sums only this month and counts unknown-cost rows", () => {
    const m = monthToDate([{ at: "2026-11-02T00:00:00Z", costCents: 120.4, evidence: "VERIFIED" }, { at: "2026-10-31T23:00:00Z", costCents: 999, evidence: "VERIFIED" }, { at: "2026-11-05T00:00:00Z", costCents: null, evidence: "UNKNOWN" }], now);
    expect(m).toMatchObject({ cents: 120, unknownRows: 1 });
    expect(monthWindow(now).label).toBe("2026-11");
  });
  it("default run caps follow the cost model", () => {
    expect(capForRunType("specialist")).toBe(300);
    expect(capForRunType("opus_thread_wake")).toBeNull();
    expect(estimateLsFeeCents(800)).toBe(90);
    expect(estimateLsFeeCents(1900)).toBe(145);
  });
});
