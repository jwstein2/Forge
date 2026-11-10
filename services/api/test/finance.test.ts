import { describe, expect, it } from "vitest";
import { makeEnv, collectMetrics } from "./helpers.ts";
import { financials } from "../src/domain/finance.ts";
import { importLedger, snapshotLedger, type LedgerSnapshot } from "../src/adapters/ledger.ts";
import { listSources } from "../src/adapters/sources.ts";
import { parsePeriod } from "../src/lib/metric.ts";
import ledgerSnap from "../fixtures/ledger-snapshot-2026-11-10.json" with { type: "json" };

const period = parsePeriod("all", new Date("2026-11-10T03:00:00Z"));
const ledgerOf = async (db: D1Database) => (await listSources(db)).find((s) => s.id === "ledger.d1")!;

describe("financials", () => {
  it("reports verified $0 revenue today and counts test orders separately", async () => {
    const { env } = await makeEnv();
    await importLedger(env.DB, snapshotLedger(ledgerSnap as LedgerSnapshot));
    const f = await financials(env.DB, null, period, await ledgerOf(env.DB));
    expect(f.grossSales).toMatchObject({ value: 0, state: "verified" });
    expect(f.testOrders).toMatchObject({ value: 2, state: "test_only" });
    expect(f.testModeGross.value).toBeCloseTo(27.99);
    expect(f.paymentFees).toMatchObject({ value: 0, state: "verified" });
  });

  it("never computes contribution while a cost line is unknown, and names the missing lines", async () => {
    const { env } = await makeEnv();
    await importLedger(env.DB, snapshotLedger(ledgerSnap as LedgerSnapshot));
    const f = await financials(env.DB, "quilt-plan-kit", period, await ledgerOf(env.DB));
    expect(f.contribution).toMatchObject({ value: null, state: "unknown" });
    expect(f.missingLines.join(" ")).toMatch(/n8n/);
    expect(f.missingLines.join(" ")).toMatch(/MailerLite/);
    expect(f.contributionKnownLinesOnly.state).toBe("estimated");
  });

  it("counts a live sale but marks fees unconnected (fees are not in the ledger)", async () => {
    const { env } = await makeEnv();
    await env.DB.prepare(`INSERT INTO financial_events (id,niche_id,kind,amount_cents,occurred_at,test_mode,source,source_ref,imported_at) VALUES ('x','bidline','sale',1900,'2026-11-09T00:00:00Z',0,'ledger.d1','x','t')`).run();
    await env.DB.prepare(`INSERT INTO financial_events (id,niche_id,kind,amount_cents,occurred_at,test_mode,owner_test,source,source_ref,imported_at) VALUES ('y','bidline','sale',1900,'2026-11-09T00:00:00Z',0,1,'ledger.d1','y','t')`).run();
    await importLedger(env.DB, snapshotLedger(ledgerSnap as LedgerSnapshot));
    const f = await financials(env.DB, "bidline", period, await ledgerOf(env.DB));
    expect(f.grossSales).toMatchObject({ value: 19, state: "verified" }); // owner test purchase excluded
    expect(f.orders.value).toBe(1);
    expect(f.paymentFees.state).toBe("unconnected");
    expect(f.missingLines).toContain("Payment processing fees");
  });

  it("imports the ledger's owner_test flag so an owner verification purchase is never revenue", async () => {
    const { env } = await makeEnv();
    const sale = (id: string, owner_test: number) => ({ id, event: "order_created", order_id: id, test_mode: 0, currency: "USD", total_cents: 1900, tax_cents: 0,
      refunded_cents: 0, product: "Bidline kit", created_at: "2026-11-09T00:00:00Z", received_at: "2026-11-09T00:00:00Z", source: null, campaign: null, vertical: "bidline", owner_test });
    await importLedger(env.DB, snapshotLedger({ _meta: { capturedAt: "2026-11-10T03:00:00Z" }, sales: [sale("live1", 0), sale("owner1", 1)], events: [] }));
    const f = await financials(env.DB, "bidline", period, await ledgerOf(env.DB));
    expect(f.grossSales).toMatchObject({ value: 19, state: "verified" });
    // a later re-import that flags the first sale as an owner test updates the stored row
    await importLedger(env.DB, snapshotLedger({ _meta: { capturedAt: "2026-11-10T03:05:00Z" }, sales: [sale("live1", 1)], events: [] }));
    const g = await financials(env.DB, "bidline", period, await ledgerOf(env.DB));
    expect(g.grossSales).toMatchObject({ value: 0, state: "verified" });
  });

  it("shows everything as unconnected when there is no ledger source", async () => {
    const { env } = await makeEnv();
    const f = await financials(env.DB, null, period, await ledgerOf(env.DB));
    expect(f.grossSales).toMatchObject({ value: null, state: "unconnected" });
    expect(f.contribution.value).toBeNull();
  });

  it("no metric is ever 'verified' or 'estimated' without a value, and every metric has period and asOf", async () => {
    const { env } = await makeEnv();
    await importLedger(env.DB, snapshotLedger(ledgerSnap as LedgerSnapshot));
    for (const m of collectMetrics(await financials(env.DB, null, period, await ledgerOf(env.DB)))) {
      expect(m.period.start && m.period.end && m.period.label).toBeTruthy();
      expect("asOf" in m).toBe(true);
      if (m.state === "verified" || m.state === "estimated") expect(m.value).not.toBeNull();
    }
  });
});
