import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Alert } from "@forge/contracts";
import { checkWorkflow, scheduleMinutes, type N8nWorkflow } from "../src/reliability/n8n-policy.ts";
import { composeWeekly, shouldInterrupt } from "../src/reliability/weekly-summary.ts";
import { runProbe, type ProbeConfig } from "../src/reliability/pipeline-probe.ts";
import { plan, prunable } from "../scripts/backup-d1.ts";
import { verify } from "../src/security/signing.ts";

const load = (f: string): N8nWorkflow => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));

describe("n8n policy checks on the real workflows (read 2026-11-10)", () => {
  it("sales workflow: signature check present, daily report gated, but key reuse, re-serialised HMAC and no heartbeat", () => {
    const f = checkWorkflow(load("n8n-sales-report.json"));
    const codes = f.map((x) => `${x.code}:${x.severity}`);
    expect(codes).not.toContain("N8N-P1:critical");   // daily email is now gated (fixed by the live-dollar thread)
    expect(codes).not.toContain("N8N-P3:critical");   // webhook verifies an HMAC before side effects
    expect(codes).toContain("N8N-P4:warning");
    expect(codes).toContain("N8N-P5:warning");        // n8n_forward_secret is both HMAC key and /report bearer token
    expect(codes).toContain("N8N-P6:warning");
  });
  it("health check: failure-only email, but repeats every 3h during an outage and has no heartbeat", () => {
    const f = checkWorkflow(load("n8n-health-check.json"));
    expect(f.find((x) => x.code === "N8N-P2")?.title).toMatch(/8 times a day/);
    expect(f.some((x) => x.code === "N8N-P6")).toBe(true);
    expect(f.some((x) => x.code === "N8N-P1")).toBe(false);
  });
  it("catches the original always-send daily report and an open webhook", () => {
    const wf: N8nWorkflow = { id: "w", name: "Old daily report", nodes: [
      { name: "Daily", type: "n8n-nodes-base.scheduleTrigger", parameters: { rule: { interval: [{ triggerAtHour: 8 }] } } },
      { name: "Build", type: "n8n-nodes-base.code" }, { name: "Mail", type: "n8n-nodes-base.gmail" },
      { name: "Hook", type: "n8n-nodes-base.webhook", parameters: { path: "x" } }, { name: "Mail2", type: "n8n-nodes-base.gmail" },
    ], connections: { Daily: { main: [[{ node: "Build" }]] }, Build: { main: [[{ node: "Mail" }]] }, Hook: { main: [[{ node: "Mail2" }]] } } };
    const codes = checkWorkflow(wf).map((x) => x.code);
    expect(codes).toContain("N8N-P1");
    expect(codes).toContain("N8N-P3");
  });
  it("a workflow that posts a heartbeat is not flagged P6; weekly email is allowed", () => {
    const wf: N8nWorkflow = { id: "w2", name: "Weekly", nodes: [
      { name: "Mon", type: "n8n-nodes-base.scheduleTrigger", parameters: { rule: { interval: [{ field: "weeks", weeksInterval: 1 }] } } },
      { name: "Mail", type: "n8n-nodes-base.gmail" },
      { name: "HB", type: "n8n-nodes-base.httpRequest", parameters: { url: "https://forge-api-staging.example/api/v1/ingest/heartbeat" } },
    ], connections: { Mon: { main: [[{ node: "Mail" }, { node: "HB" }]] } } };
    expect(checkWorkflow(wf)).toEqual([]);
  });
  it("parses schedule cadences", () => {
    const s = (rule: any) => scheduleMinutes({ name: "s", type: "n8n-nodes-base.scheduleTrigger", parameters: { rule: { interval: [rule] } } });
    expect(s({ field: "minutes", minutesInterval: 30 })).toBe(30);
    expect(s({ field: "hours", hoursInterval: 6 })).toBe(360);
    expect(s({ triggerAtHour: 7, triggerAtMinute: 30 })).toBe(1440);
    expect(s({ field: "cronExpression", expression: "*/15 * * * *" })).toBe(15);
    expect(s({ field: "cronExpression", expression: "17 14 1 * *" })).toBe(43200);
  });
});

describe("weekly summary", () => {
  const al = (o: Partial<Alert>): Alert => ({ id: "a", severity: "warning", nicheId: null, source: "x", title: "t", detail: null, state: "open", firstSeen: "", lastSeen: "", nextAction: null, needsOwner: false, evidenceUrl: null, ...o });
  const now = new Date("2026-11-16T09:00:00Z");
  it("leads with owner decisions and failures; unknown money stays unknown", () => {
    const s = composeWeekly({ now, alerts: [al({ id: "1", severity: "critical", needsOwner: true, title: "Pick Bidline price" }), al({ id: "2", severity: "critical", title: "Ledger webhook failing", source: "controls:FIN-RC-01" }), al({ id: "3" })],
      runs: [{ registryId: "r1", name: "Health check", status: "failed", startedAt: "2026-11-15T00:00:00Z" }, { registryId: "r1", name: "Health check", status: "failed", startedAt: "2026-11-15T03:00:00Z" }, { registryId: "r1", name: "Health check", status: "failed", startedAt: "2026-11-01T00:00:00Z" }],
      jobs: [{ registryId: "j", name: "Pins", heartbeat: "never_observed", lastSuccessAt: null }],
      money: [{ nicheId: "bidline", label: "Bidline", grossCents: 0, refundsCents: 0, contributionCents: null, state: "unknown" }] });
    expect(s.headline).toBe("1 decision(s) for you, 1 critical alert(s), 1 job(s) failed.");
    expect(s.failedRuns[0]?.count).toBe(2);
    expect(s.markdown.indexOf("Needs your decision")).toBeLessThan(s.markdown.indexOf("Critical"));
    expect(s.markdown).toContain("unknown (unknown)");
    expect(s.markdown).toContain("Not yet observable");
  });
  it("a quiet week says so", () => {
    expect(composeWeekly({ now, alerts: [], runs: [], jobs: [], money: [] }).headline).toMatch(/^Quiet week/);
  });
  it("interrupts only for urgent money/customer criticals, once", () => {
    const a = [al({ id: "p", severity: "critical", title: "Checkout down" }), al({ id: "q", severity: "critical", title: "Brief is stale" }), al({ id: "r", severity: "warning", title: "Checkout slow" })];
    expect(shouldInterrupt(a, new Set()).map((x) => x.id)).toEqual(["p"]);
    expect(shouldInterrupt(a, new Set(["p"]))).toEqual([]);
  });
});

describe("pipeline probe", () => {
  const cfg: ProbeConfig = { environment: "development", workerUrl: "http://127.0.0.1:8788", productionHosts: [], signingSecret: "s".repeat(32), vertical: "quilt-plan-kit" };
  const noWait = async () => {};
  it("refuses the production sales Worker and production environment", async () => {
    const f = async () => { throw new Error("must not be called"); };
    expect((await runProbe({ ...cfg, workerUrl: "https://quiltplankit-sales.sales-webhook.workers.dev" }, { findOrder: async () => null }, f)).step).toBe("refused");
    expect((await runProbe({ ...cfg, environment: "production" }, { findOrder: async () => null }, f)).step).toBe("refused");
  });
  it("sends a correctly signed test-mode order and confirms the ledger row", async () => {
    const store = new Map<string, any>();
    const fetcher = async (_u: string, init: { headers: Record<string, string>; body: string }) => {
      const okSig = await verify({ secrets: [cfg.signingSecret], rawBody: init.body, signature: init.headers["x-signature"]!, timestamp: null, allowV1: true });
      if (!okSig.ok) return { status: 401 };
      const b = JSON.parse(init.body);
      store.set(b.data.id, { test_mode: b.data.attributes.test_mode ? 1 : 0, vertical: b.meta.custom_data.vertical, total_cents: b.data.attributes.total });
      return { status: 200 };
    };
    const r = await runProbe(cfg, { findOrder: async (id) => store.get(id) ?? null }, fetcher, new Date(), noWait);
    expect(r).toMatchObject({ ok: true, step: "done" });
  });
  it("fails loudly when a probe lands as live revenue or never lands", async () => {
    const live = await runProbe(cfg, { findOrder: async () => ({ test_mode: 0, vertical: "quilt-plan-kit", total_cents: 1 }) }, async () => ({ status: 200 }), new Date(), noWait);
    expect(live.detail).toMatch(/LIVE/);
    const lost = await runProbe(cfg, { findOrder: async () => null }, async () => ({ status: 200 }), new Date(), noWait);
    expect(lost).toMatchObject({ ok: false, step: "ledger" });
  });
});

describe("backup plan", () => {
  it("plans read-only remote exports and never deletes, only lists prunable", () => {
    const p = plan("/b", "2026-11-10T03-00-00Z");
    expect(p[0]?.args).toEqual(["wrangler", "d1", "export", "quiltplankit-sales", "--remote", "--output", "/b/quiltplankit-sales-2026-11-10T03-00-00Z.sql"]);
    const files = Array.from({ length: 14 }, (_, i) => `quiltplankit-sales-2026-11-${String(i + 1).padStart(2, "0")}.sql`);
    expect(prunable(files, "quiltplankit-sales", 12)).toEqual(files.slice(0, 2));
  });
});
