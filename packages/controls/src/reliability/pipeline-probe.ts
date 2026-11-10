/**
 * Synthetic revenue-pipeline probe (gates G5/G11; audit S10 "pipeline monitoring").
 * Sends a signed, test-mode Lemon Squeezy-shaped order to a sales Worker and confirms the ledger recorded it
 * with test_mode=1 (so it is never revenue) and the right vertical. Refuses production targets: the
 * production sales Worker belongs to the live-dollar thread and a probe there needs owner approval.
 */
import { hmacHex } from "../security/signing.ts";

export interface ProbeConfig {
  environment: "development" | "test" | "staging" | "production";
  workerUrl: string;                 // e.g. http://127.0.0.1:8788 or a staging workers.dev host
  productionHosts: string[];         // hosts that must never be probed
  signingSecret: string;             // the target Worker's TEST store signing secret
  vertical: string;
}
export interface LedgerLookup { findOrder(orderId: string): Promise<{ test_mode: number; vertical: string; total_cents: number } | null> }
export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;
export interface ProbeResult { ok: boolean; step: "refused" | "post" | "ledger" | "done"; detail: string; orderId: string | null; latencyMs: number }

export const PRODUCTION_SALES_HOSTS = ["quiltplankit-sales.sales-webhook.workers.dev"];

export function probePayload(orderId: string, vertical: string, now: Date) {
  return {
    meta: { event_name: "order_created", custom_data: { vertical, utm_source: "forge-probe", owner_test: "1" } },
    data: { id: orderId, attributes: { test_mode: true, currency: "USD", total: 1, tax: 0, created_at: now.toISOString(),
      user_email: "probe@forge.invalid", first_order_item: { product_name: "FORGE pipeline probe" } } },
  };
}

export async function runProbe(cfg: ProbeConfig, ledger: LedgerLookup, fetcher: Fetcher, now = new Date(),
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<ProbeResult> {
  const t0 = Date.now();
  let host = "";
  try { host = new URL(cfg.workerUrl).host; } catch { host = ""; }
  if (cfg.environment === "production" || !host || cfg.productionHosts.includes(host) || PRODUCTION_SALES_HOSTS.includes(host)) {
    return { ok: false, step: "refused", detail: `Refusing to probe ${host || "an invalid URL"} from ${cfg.environment}; production probes need owner approval.`, orderId: null, latencyMs: 0 };
  }
  const orderId = `probe-${now.getTime()}`;
  const body = JSON.stringify(probePayload(orderId, cfg.vertical, now));
  const res = await fetcher(`${cfg.workerUrl.replace(/\/$/, "")}/lemonsqueezy`, {
    method: "POST", headers: { "content-type": "application/json", "x-signature": await hmacHex(cfg.signingSecret, body) }, body,
  });
  if (res.status < 200 || res.status >= 300) return { ok: false, step: "post", detail: `Worker returned HTTP ${res.status}`, orderId, latencyMs: Date.now() - t0 };
  for (let i = 0; i < 5; i++) {
    const row = await ledger.findOrder(orderId);
    if (row) {
      if (Number(row.test_mode) !== 1) return { ok: false, step: "ledger", detail: "Probe order was recorded as LIVE; test-mode flag lost. Revenue integrity failure.", orderId, latencyMs: Date.now() - t0 };
      if (row.vertical !== cfg.vertical) return { ok: false, step: "ledger", detail: `Probe recorded under "${row.vertical}", expected "${cfg.vertical}".`, orderId, latencyMs: Date.now() - t0 };
      return { ok: true, step: "done", detail: "Signed test order reached the ledger as test_mode=1 with the right niche.", orderId, latencyMs: Date.now() - t0 };
    }
    await wait(1000 * (i + 1));
  }
  return { ok: false, step: "ledger", detail: "Worker accepted the order but no ledger row appeared within about 15s.", orderId, latencyMs: Date.now() - t0 };
}
