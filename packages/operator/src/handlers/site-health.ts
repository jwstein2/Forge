/**
 * ops.site_health — deterministic uptime + content assertions for every live niche site and shared endpoints.
 * Unlike the n8n health check it replaces over time (N8N-02), every run writes a FORGE run record, so a dead
 * scheduler shows up as a late heartbeat instead of silence.
 */
import type { HandlerDef } from "../../../../services/api/src/orchestration/engine.ts";
import { activeNiches, alertStmt, checkStmt, flush, joinUrl, resolveStmt, type Fetcher, type Finding } from "../lib.ts";

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
        // Each fetch is a Worker subrequest, and staging counts D1 calls too (50 per invocation). Fetches are capped and all
        // rows are written in one batch, so a run costs about maxFetches + 2 subrequests plus the engine's own calls.
        const budget = Math.min(Math.max(Number(input.maxFetches ?? 18), 1), 30);
        let used = 0; let halted: string | null = null; let failing = 0; let unknown = 0; let retried = 0;
        const stmts: D1PreparedStatement[] = []; const resolveAt: number[] = []; // every row goes out in one batch at the end
        // Unknown never escalates by itself, so a target that stays unknown for 3 runs in a row gets a warning (QA-008 O1).
        const prior = new Map<string, (number | null)[]>();
        for (const r of (await db.prepare(`SELECT target, ok FROM (SELECT target, ok, ROW_NUMBER() OVER (PARTITION BY target ORDER BY checked_at DESC) AS rn FROM op_checks WHERE check_kind='site_health') WHERE rn <= 2`).all<{ target: string; ok: number | null }>()).results)
          prior.set(r.target, [...(prior.get(r.target) ?? []), r.ok]);
        const probe = async (url: string) => { used++; return fetcher(url, { timeoutMs: 15000, maxBytes: 256_000 }); };
        const unknownCheck = async (t: HealthTarget, why: string, r?: { status: number | null; latencyMs: number }) => {
          unknown++;
          const last = prior.get(t.url) ?? [];
          if (last.length === 2 && last.every((x) => x === null))
            stmts.push(alertStmt(db, { key: `ops:health:unknown:${t.url}`, severity: "warning", nicheId: t.nicheId, source: "ops.site_health", title: `${t.label}: health check has not run for 3 runs`,
              detail: `The last 3 checks could not run (${why}), so FORGE cannot tell whether this target is up.`, nextAction: "Open the URL to confirm it is up; then check the Worker's subrequest budget and the job logs.", evidenceUrl: t.url }));
          stmts.push(checkStmt(db, { kind: "site_health", nicheId: t.nicheId, target: t.url, ok: null, status: r?.status ?? null, latencyMs: r?.latencyMs ?? null, jobId,
            findings: [{ code: "checker_error", severity: "info", message: `FORGE could not run this check (${why}). Site state UNKNOWN; no alert raised or cleared.` }] }));
        };
        for (const t of targets) {
          if (halted || used >= budget) { await unknownCheck(t, halted ? `stopped after a runtime error: ${halted}` : "per-run fetch budget used"); continue; }
          let r = await probe(t.url);
          if (r.probeError) { halted = r.error ?? "runtime error"; await unknownCheck(t, halted, r); continue; }
          let findings = evaluate(t, r); let confirmed = false;
          // Re-check once before alerting, so one dropped request never raises a critical.
          if (findings.some((x) => x.severity !== "info") && used < budget && retried < 3) {
            retried++; const again = await probe(t.url);
            if (again.probeError) { halted = again.error ?? "runtime error"; await unknownCheck(t, halted, again); continue; }
            r = again; findings = evaluate(t, r); confirmed = true;
          }
          const blocking = findings.filter((x) => x.severity !== "info");
          stmts.push(checkStmt(db, { kind: "site_health", nicheId: t.nicheId, target: t.url, ok: blocking.length === 0, status: r.status, latencyMs: r.latencyMs, findings, jobId }));
          const key = `ops:health:${t.url}`;
          stmts.push(resolveStmt(db, `ops:health:unknown:${t.url}`)); // a real answer ends the unknown streak
          if (!blocking.length) { resolveAt.push(stmts.length); stmts.push(resolveStmt(db, key)); }
          else {
            failing++;
            const worst = blocking.reduce((a, b) => (rank[b.severity] > rank[a.severity] ? b : a));
            stmts.push(alertStmt(db, { key, severity: worst.severity, nicheId: t.nicheId, source: "ops.site_health", title: `${t.label} check failing`, detail: `${blocking.map((x) => x.message).join("; ")}${confirmed ? " (confirmed by a second request)" : ""}`, nextAction: "FORGE re-checks every hour; open the URL to confirm, then check the last deploy.", evidenceUrl: t.url }));
          }
        }
        const res = await flush(db, stmts);
        const resolved = resolveAt.reduce((a, i) => a + Number(res[i]?.meta?.changes ?? 0), 0);
        return { output: { targets: targets.length, fetches: used, failing, resolved, unknown } };
      },
    }],
  };
}
