/**
 * ops.weekly_summary — the in-app weekly operational summary the constitution asks for (§10). Stored in op_summaries
 * and read by FORGE Command. Never emailed. Deterministic: every sentence is computed from rows, and anything FORGE
 * cannot see is stated as unknown/unconnected rather than omitted.
 */
import type { HandlerDef } from "../../../../services/api/src/orchestration/engine.ts";
import { listSources } from "../../../../services/api/src/adapters/sources.ts";
import { newId, nowIso } from "../lib.ts";

const DAY = 86400000;

/** The ISO week (Mon 00:00 UTC → next Mon 00:00) that ended at or before `at`. */
export function previousWeek(at: Date): { start: Date; end: Date } {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const end = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY);
  return { start: new Date(end.getTime() - 7 * DAY), end };
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export async function buildSummary(db: D1Database, start: Date, end: Date) {
  const s = start.toISOString(); const e = end.toISOString();
  const runs = (await db.prepare(`SELECT r.registry_id AS id, re.name, SUM(CASE WHEN r.status='success' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN r.status='failed' THEN 1 ELSE 0 END) AS failed, MAX(CASE WHEN r.status='success' THEN COALESCE(r.finished_at, r.started_at) END) AS last_success, SUM(COALESCE(r.model_cost_cents,0)) AS model_cost
    FROM runs r JOIN registry_entries re ON re.id = r.registry_id WHERE r.started_at >= ? AND r.started_at < ? GROUP BY r.registry_id ORDER BY r.registry_id`).bind(s, e).all<Record<string, any>>()).results;
  const silent = (await db.prepare(`SELECT id, name, runner FROM registry_entries WHERE status = 'LIVE' AND id NOT IN (SELECT DISTINCT registry_id FROM runs WHERE started_at >= ? AND started_at < ?)`).bind(s, e).all<Record<string, any>>()).results;
  const alertsOpened = (await db.prepare(`SELECT severity, COUNT(*) AS n FROM alerts WHERE first_seen >= ? AND first_seen < ? GROUP BY severity`).bind(s, e).all<{ severity: string; n: number }>()).results;
  const openNow = (await db.prepare(`SELECT id, severity, title, niche_id, needs_owner FROM alerts WHERE state = 'open' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, last_seen DESC`).all<Record<string, any>>()).results;
  const channels = (await db.prepare(`SELECT c.id, c.niche_id, c.platform, c.status, c.last_verified_at, c.last_verified_url,
      (SELECT COUNT(*) FROM op_publications p WHERE p.channel_id = c.id AND p.source <> 'site_feed' AND p.observed_at >= ? AND p.observed_at < ?) AS platform_receipts,
      (SELECT COUNT(*) FROM op_publications p WHERE p.channel_id = c.id AND p.source = 'site_feed' AND p.observed_at >= ? AND p.observed_at < ?) AS feed_items
    FROM channels c ORDER BY c.niche_id, c.platform`).bind(s, e, s, e).all<Record<string, any>>()).results;
  const pipeline = (await db.prepare(`SELECT status, COUNT(*) AS n, SUM(late) AS late FROM op_content_items GROUP BY status`).all<{ status: string; n: number; late: number }>()).results;
  const health = (await db.prepare(`SELECT target, niche_id, COUNT(*) AS checks, SUM(ok) AS ok FROM op_checks WHERE check_kind = 'site_health' AND checked_at >= ? AND checked_at < ? GROUP BY target ORDER BY target`).bind(s, e).all<Record<string, any>>()).results;
  const llm = await db.prepare(`SELECT COUNT(*) AS calls, SUM(cost_cents) AS cost FROM op_llm_calls WHERE at >= ? AND at < ?`).bind(s, e).first<{ calls: number; cost: number | null }>();

  const sources = await listSources(db);
  const ledger = sources.find((x) => x.id === "ledger.d1");
  let revenue: Record<string, unknown>;
  if (!ledger || ledger.mode === "unconnected") revenue = { state: "unconnected", valueCents: null, note: "Sales ledger not connected to FORGE." };
  else {
    const rows = (await db.prepare(`SELECT niche_id, kind, SUM(amount_cents) AS cents, COUNT(*) AS n FROM financial_events WHERE test_mode = 0 AND owner_test = 0 AND occurred_at >= ? AND occurred_at < ? AND kind IN ('sale','refund') GROUP BY niche_id, kind`).bind(s, e).all<Record<string, any>>()).results;
    const sales = rows.filter((r) => r.kind === "sale").reduce((a, r) => a + Number(r.cents), 0);
    const refunds = rows.filter((r) => r.kind === "refund").reduce((a, r) => a + Number(r.cents), 0);
    const covers = !!ledger.asOf && ledger.asOf >= e;
    revenue = { state: covers ? "verified" : "partial", grossCents: sales, refundCents: refunds, orders: rows.filter((r) => r.kind === "sale").reduce((a, r) => a + Number(r.n), 0), byNiche: rows, source: `${ledger.id} (${ledger.mode})`, asOf: ledger.asOf,
      note: covers ? "Live orders only (test and owner-test excluded)." : `Ledger data only runs to ${ledger.asOf ?? "unknown"}; later sales are not counted.` };
  }

  const okRuns = runs.reduce((a, r) => a + Number(r.ok), 0); const badRuns = runs.reduce((a, r) => a + Number(r.failed), 0);
  const verifiedCh = channels.filter((c) => c.status === "verified");
  const crit = openNow.filter((a) => a.severity === "critical");
  const headline: string[] = [];
  headline.push(revenue.state === "unconnected" ? "Revenue: unknown (ledger not connected)." : `Revenue: ${money(Number(revenue.grossCents))} gross from ${revenue.orders} live order(s)${revenue.state === "partial" ? " (partial week of data)" : ""}.`);
  headline.push(`Jobs: ${okRuns} successful and ${badRuns} failed run(s) reported to FORGE; ${silent.length} LIVE job(s) reported nothing.`);
  headline.push(`Channels: ${verifiedCh.length} of ${channels.length} verified; ${channels.reduce((a, c) => a + Number(c.platform_receipts), 0)} platform-confirmed publication(s) this week.`);
  headline.push(crit.length ? `${crit.length} critical alert(s) open: ${crit.slice(0, 3).map((a) => a.title).join("; ")}.` : `No critical alerts open; ${openNow.length} other alert(s) open.`);

  return {
    period: { start: s, end: e, label: `Week of ${s.slice(0, 10)}` }, generatedAt: nowIso(), headline,
    revenue, jobs: { runs, silentLive: silent }, alerts: { openedThisWeek: alertsOpened, openNow: openNow.slice(0, 25), openCount: openNow.length, needsOwner: openNow.filter((a) => a.needs_owner).length },
    channels, contentPipeline: pipeline,
    siteHealth: health.map((h) => ({ ...h, uptimePct: h.checks ? Math.round((Number(h.ok) / Number(h.checks)) * 1000) / 10 : null })),
    modelUsage: { calls: Number(llm?.calls ?? 0), costCents: Number(llm?.cost ?? 0) },
    unknowns: [
      ...(revenue.state === "unconnected" ? ["Revenue"] : []),
      ...sources.filter((x) => x.mode === "unconnected").map((x) => `${x.label} (unconnected)`),
      ...silent.map((x) => `${x.name}: no run reported (${x.runner})`),
    ],
  };
}

export function weeklySummary(): HandlerDef {
  return {
    kind: "ops.weekly_summary",
    registryId: "OPS-WEEKLY-SUMMARY",
    steps: [{
      name: "compile",
      async run({ db, jobId, input, now }) {
        const at = typeof input.slot === "string" ? new Date(input.slot) : now;
        const { start, end } = previousWeek(at);
        const body = await buildSummary(db, start, end);
        await db.prepare(`INSERT INTO op_summaries (id,period_start,period_end,generated_at,body_json,job_id) VALUES (?,?,?,?,?,?)
          ON CONFLICT(period_start, period_end) DO UPDATE SET generated_at=excluded.generated_at, body_json=excluded.body_json, job_id=excluded.job_id`)
          .bind(newId("sum"), start.toISOString(), end.toISOString(), body.generatedAt, JSON.stringify(body), jobId).run();
        return { output: { period: body.period, headline: body.headline } };
      },
    }],
  };
}
