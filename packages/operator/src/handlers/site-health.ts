/**
 * ops.site_health — deterministic uptime + content assertions for every live niche site and shared endpoints.
 * Unlike the n8n health check it replaces over time (N8N-02), every run writes a FORGE run record, so a dead
 * scheduler shows up as a late heartbeat instead of silence.
 */
import type { HandlerDef } from "../../../../services/api/src/orchestration/engine.ts";
import { activeNiches, joinUrl, raiseAlert, recordCheck, resolveAlert, type Fetcher, type Finding } from "../lib.ts";

export interface HealthTarget { url: string; nicheId: string | null; label: string; critical: boolean; mustContain?: string[]; mustNotContain?: string[]; maxLatencyMs?: number }

/** Shared endpoints that are not tied to one site's base URL. */
export const SHARED_TARGETS: HealthTarget[] = [
  { url: "https://quiltplankit-sales.sales-webhook.workers.dev/health", nicheId: null, label: "Sales webhook Worker /health", critical: true },
];

/** Per-site paths every niche site must serve. Content assertions use the niche name from the database. */
export function siteTargets(n: { id: string; name: string; site_url: string }): HealthTarget[] {
  const t: HealthTarget[] = [
    { url: joinUrl(n.site_url, "/"), nicheId: n.id, label: `${n.name} home`, critical: true, mustContain: [n.name], mustNotContain: ["Error 1101", "Application error"], maxLatencyMs: 4000 },
    { url: joinUrl(n.site_url, "/robots.txt"), nicheId: n.id, label: `${n.name} robots.txt`, critical: false, mustContain: ["User-agent"] },
    { url: joinUrl(n.site_url, "/sitemap.xml"), nicheId: n.id, label: `${n.name} sitemap`, critical: false, mustContain: ["<urlset"] },
  ];
  if (n.id === "quilt-plan-kit") t.push({ url: joinUrl(n.site_url, "/pins.xml"), nicheId: n.id, label: "QPK Pinterest feed", critical: false, mustContain: ["<rss", "<item"] });
  return t;
}

export function evaluate(t: HealthTarget, r: { ok: boolean; status: number | null; text: string; latencyMs: number; error?: string }): Finding[] {
  const f: Finding[] = [];
  if (r.status === null) f.push({ code: "unreachable", severity: t.critical ? "critical" : "warning", message: `No response: ${r.error ?? "network error"}` });
  else if (!r.ok) f.push({ code: "http_status", severity: t.critical ? "critical" : "warning", message: `HTTP ${r.status}` });
  else {
    for (const s of t.mustContain ?? []) if (!r.text.includes(s)) f.push({ code: "content_missing", severity: "warning", message: `Expected text not found: "${s}"` });
    for (const s of t.mustNotContain ?? []) if (r.text.includes(s)) f.push({ code: "content_error", severity: t.critical ? "critical" : "warning", message: `Error text present: "${s}"` });
    if (t.maxLatencyMs && r.latencyMs > t.maxLatencyMs) f.push({ code: "slow", severity: "info", message: `Responded in ${r.latencyMs} ms (budget ${t.maxLatencyMs} ms)` });
  }
  return f;
}

const rank = { critical: 3, warning: 2, info: 1 } as const;

export function siteHealth(fetcher: Fetcher): HandlerDef {
  return {
    kind: "ops.site_health",
    registryId: "OPS-SITE-HEALTH",
    steps: [{
      name: "probe",
      async run({ db, jobId, input }) {
        const niches = await activeNiches(db, (input.nicheId as string) ?? null);
        const targets = [...niches.filter((n) => n.site_url).flatMap((n) => siteTargets(n as { id: string; name: string; site_url: string })), ...(input.nicheId ? [] : SHARED_TARGETS)];
        let failing = 0; let resolved = 0;
        for (const t of targets) {
          const r = await fetcher(t.url, { timeoutMs: 15000, maxBytes: 600_000 });
          const findings = evaluate(t, r);
          const blocking = findings.filter((x) => x.severity !== "info");
          await recordCheck(db, { kind: "site_health", nicheId: t.nicheId, target: t.url, ok: blocking.length === 0, status: r.status, latencyMs: r.latencyMs, findings, jobId });
          const key = `ops:health:${t.url}`;
          if (!blocking.length) resolved += await resolveAlert(db, key);
          else {
            failing++;
            const worst = blocking.reduce((a, b) => (rank[b.severity] > rank[a.severity] ? b : a));
            await raiseAlert(db, { key, severity: worst.severity, nicheId: t.nicheId, source: "ops.site_health", title: `${t.label} check failing`, detail: blocking.map((x) => x.message).join("; "), nextAction: "FORGE re-checks every hour; open the URL to confirm, then check the last deploy.", evidenceUrl: t.url });
          }
        }
        return { output: { checked: targets.length, failing, resolved } };
      },
    }],
  };
}
