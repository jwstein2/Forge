import { describe, expect, it } from "vitest";
import { makeEnv } from "./helpers.ts";
import { attributeEvent, importLedger, isTestEvent, snapshotLedger, unconnectedLedger, type LedgerSnapshot } from "../src/adapters/ledger.ts";
import { importN8n, liveN8n, snapshotN8n, unconnectedN8n, type N8nSnapshot } from "../src/adapters/n8n.ts";
import { listSources } from "../src/adapters/sources.ts";
import ledgerSnap from "../fixtures/ledger-snapshot-2026-11-10.json" with { type: "json" };
import n8nSnap from "../fixtures/n8n-snapshot-2026-11-10.json" with { type: "json" };

describe("ledger adapter (read-only)", () => {
  it("imports the real snapshot: 3 rows, all test mode, attributed per niche", async () => {
    const { env } = await makeEnv();
    const r = await importLedger(env.DB, snapshotLedger(ledgerSnap as LedgerSnapshot));
    expect(r.financialEvents).toBe(3);
    const rows = (await env.DB.prepare("SELECT niche_id, kind, amount_cents, test_mode FROM financial_events ORDER BY id").all<any>()).results;
    expect(rows.every((x) => x.test_mode === 1)).toBe(true);
    expect(rows.map((x) => x.niche_id).sort()).toEqual(["bidline", "quilt-plan-kit", "quilt-plan-kit"]);
    expect(rows.find((x) => x.kind === "refund")?.amount_cents).toBe(800);
  });

  it("is idempotent", async () => {
    const { env } = await makeEnv();
    const reader = snapshotLedger(ledgerSnap as LedgerSnapshot);
    await importLedger(env.DB, reader); await importLedger(env.DB, reader);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM financial_events").first<{ n: number }>();
    expect(n!.n).toBe(3);
  });

  it("separates QA traffic from real page views (37 real views, matching the audit)", async () => {
    const { env } = await makeEnv();
    await importLedger(env.DB, snapshotLedger(ledgerSnap as LedgerSnapshot));
    const real = await env.DB.prepare("SELECT SUM(count) AS n FROM funnel_daily WHERE event='page_view' AND is_test=0").first<{ n: number }>();
    expect(real!.n).toBe(37);
    expect(isTestEvent({ path: "/site/index", source: "direct" })).toBe(true);
    expect(isTestEvent({ path: "/calculators/binding", source: "pinterest" })).toBe(false);
  });

  it("attributes only paths with a known site prefix", () => {
    const p = [{ nicheId: "bidline", prefix: "/bidline/" }];
    expect(attributeEvent("/bidline/calculator", p)).toBe("bidline");
    expect(attributeEvent("/", p)).toBeNull();
  });

  it("records 'unconnected' rather than zero when no source exists", async () => {
    const { env } = await makeEnv();
    await importLedger(env.DB, unconnectedLedger);
    const s = (await listSources(env.DB)).find((x) => x.id === "ledger.d1")!;
    expect(s.mode).toBe("unconnected");
    expect(s.asOf).toBeNull();
  });
});

describe("n8n adapter (read-only)", () => {
  it("maps snapshot executions to registry runs with evidence links", async () => {
    const { env } = await makeEnv();
    const n = await importN8n(env.DB, snapshotN8n(n8nSnap as N8nSnapshot));
    expect(n).toBe(12);
    const run = await env.DB.prepare("SELECT * FROM runs WHERE registry_id='N8N-02' ORDER BY started_at DESC LIMIT 1").first<any>();
    expect(run.status).toBe("success");
    expect(run.evidence_url).toBe("https://james1854.app.n8n.cloud/workflow/iWvwx0VDj7cFzAYy/executions/552");
  });

  it("live reader calls the n8n public API with the scoped key and maps failures", async () => {
    const calls: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      expect((init?.headers as Record<string, string>)["X-N8N-API-KEY"]).toBe("k");
      return new Response(JSON.stringify({ data: [{ id: 9, workflowId: "iWvwx0VDj7cFzAYy", status: "error", mode: "trigger", startedAt: "2026-11-10T03:00:00Z", stoppedAt: "2026-11-10T03:00:02Z" }] }));
    }) as unknown as typeof fetch;
    const { env } = await makeEnv();
    await importN8n(env.DB, liveN8n("https://n8n.example", "k", fake));
    expect(calls.some((u) => u.includes("workflowId=iWvwx0VDj7cFzAYy"))).toBe(true);
    const run = await env.DB.prepare("SELECT status, source FROM runs WHERE external_id='9'").first<any>();
    expect(run).toEqual({ status: "failed", source: "n8n.live" });
  });

  it("unconnected n8n writes no runs", async () => {
    const { env } = await makeEnv();
    expect(await importN8n(env.DB, unconnectedN8n)).toBe(0);
  });
});
