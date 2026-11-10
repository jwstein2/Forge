/**
 * ops.optimize_weekly — the optimization loop. Once a week (before the summary) it reads the last 28 days of the
 * funnel, sales, lifecycle and channel data FORGE already has and proposes changes as op_recommendations.
 *
 * It only proposes. Nothing is changed on a site, a channel or in MailerLite. Each rule needs a minimum sample before
 * it says anything, cites the numbers and their source, and expires its own proposal when the condition clears.
 * When the funnel source is unconnected, no rule that depends on it runs (unknown is not zero).
 */
import type { HandlerDef } from "../../../../services/api/src/orchestration/engine.ts";
import { listSources } from "../../../../services/api/src/adapters/sources.ts";
import { flush, newId, nowIso } from "../lib.ts";

const DAY = 86400000;

export interface NicheFacts {
  nicheId: string; name: string; funnelSource: "live" | "snapshot" | "unconnected"; period: { start: string; end: string };
  /** When the funnel/sales data runs to. Before period.end, later days are missing, not zero. */
  dataAsOf: string | null;
  pageViews: number; calcUses: number; checkoutClicks: number; signups: number; pinterestVisits: number;
  liveSales: number; platformPins28d: number; welcomeStatus: string | null; draftedAwaiting: number; overduePlanned: number;
  checkoutLiveSince: string | null;
}
export interface Reco { rule: string; title: string; detail: string; action: string; impact: "high" | "medium" | "low"; label: "VERIFIED" | "INFERRED" | "UNKNOWN"; needsOwner: boolean; evidence: Record<string, unknown> }

/** Pure rules: facts in, proposals out. Thresholds are the minimum sample each rule needs. */
export function recommend(f: NicheFacts): Reco[] {
  const funnel = f.funnelSource !== "unconnected";
  // Data that stops before the period ends (a dated snapshot) can't prove an absence: rules that need "no sales" are
  // skipped, and the rest are labelled INFERRED (QA-011 P2-3).
  // A live ledger is synced periodically, so a sync within 26 h of the period end counts as complete (QA-011 R1-1).
  const completeFrom = f.funnelSource === "live" ? new Date(Date.parse(f.period.end) - 26 * 3600000).toISOString() : f.period.end;
  const partial = funnel && (!f.dataAsOf || f.dataAsOf < completeFrom);
  const label = (l: Reco["label"]): Reco["label"] => (partial && l === "VERIFIED" ? "INFERRED" : l);
  const out: Reco[] = []; const src = { source: `funnel_daily + financial_events (${f.funnelSource})`, period: f.period, dataAsOf: f.dataAsOf, partial };
  if (f.signups > 0 && f.welcomeStatus !== null && f.welcomeStatus !== "active")
    out.push({ rule: "welcome_not_live", impact: "high", label: "VERIFIED", needsOwner: true, evidence: { ...src, signups: f.signups, welcomeStatus: f.welcomeStatus },
      title: `${f.name}: ${f.signups} signup(s) and no welcome emails going out`, detail: `The site recorded ${f.signups} email signup(s) in 28 days, but the welcome sequence in MailerLite is ${f.welcomeStatus}. New subscribers are not receiving what the form promised.`,
      action: "Review the draft welcome sequence in MailerLite and turn it on." });
  if (funnel && f.calcUses >= 50 && f.checkoutClicks === 0)
    out.push({ rule: "calculator_no_checkout", impact: "medium", label: label("VERIFIED"), needsOwner: false, evidence: { ...src, calcUses: f.calcUses, checkoutClicks: f.checkoutClicks },
      title: `${f.name}: calculators are used but nobody clicks through to buy`, detail: `${f.calcUses} calculator uses and 0 checkout clicks in 28 days.`,
      action: "Put a short, relevant product link directly under the calculator result (site change through the normal release gate)." });
  if (funnel && !partial && f.checkoutClicks >= 20 && f.liveSales === 0)
    out.push({ rule: "checkout_no_sale", impact: "high", label: "VERIFIED", needsOwner: true, evidence: { ...src, checkoutClicks: f.checkoutClicks, liveSales: f.liveSales },
      title: `${f.name}: ${f.checkoutClicks} checkout clicks and no sales`, detail: "People reach checkout and leave. Either checkout is broken or not live, or the price or page is putting them off.",
      action: "Run an owner test purchase end to end, then compare the checkout price with the site price." });
  if (funnel && f.platformPins28d >= 7 && f.pinterestVisits === 0)
    out.push({ rule: "pins_no_visits", impact: "medium", label: "INFERRED", needsOwner: false, evidence: { ...src, platformPins28d: f.platformPins28d, pinterestVisits: f.pinterestVisits },
      title: `${f.name}: ${f.platformPins28d} pins published and no visits from Pinterest`, detail: "Pins are confirmed on Pinterest but the site recorded no visits with a Pinterest source. Either the pins are not being shown, or the links are not tagged.",
      action: "Check that pin links carry the Pinterest source tag, then test new titles and images on the next batch." });
  if (funnel && !partial && f.checkoutLiveSince && f.liveSales === 0 && f.pageViews >= 300 && Date.parse(f.period.end) - Date.parse(f.checkoutLiveSince) <= 60 * DAY)
    out.push({ rule: "kill_rule", impact: "high", label: "VERIFIED", needsOwner: true, evidence: { ...src, pageViews: f.pageViews, liveSales: f.liveSales, checkoutLiveSince: f.checkoutLiveSince },
      title: `${f.name}: kill rule reached (300+ visits, no sale within 60 days of checkout going live)`, detail: "This is the owner-adjustable rule from the product findings. It is a prompt to decide, not an automatic action.",
      action: "Decide whether to put this product on hold, change the offer, or extend the test." });
  if (f.draftedAwaiting >= 10 || f.overduePlanned >= 3)
    out.push({ rule: "content_backlog", impact: "low", label: "VERIFIED", needsOwner: true, evidence: { draftedAwaiting: f.draftedAwaiting, overduePlanned: f.overduePlanned },
      title: `${f.name}: content is piling up`, detail: `${f.draftedAwaiting} drafted item(s) waiting for a decision and ${f.overduePlanned} planned item(s) past their publish-by date.`,
      action: "Approve or reject the drafted items in one batch, or set a standing publishing policy for the channel." });
  return out;
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3);
  const y = t.getUTCFullYear(); const w = 1 + Math.round((t.getTime() - Date.UTC(y, 0, 4)) / (7 * DAY) - 3 + ((new Date(Date.UTC(y, 0, 4)).getUTCDay() + 6) % 7) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

export function optimizeWeekly(): HandlerDef {
  return {
    kind: "ops.optimize_weekly",
    registryId: "OPS-OPTIMIZE-WEEKLY",
    steps: [{
      name: "propose",
      async run({ db, jobId, input, now }) {
        const end = now; const start = new Date(end.getTime() - 28 * DAY);
        const s = start.toISOString(); const e = end.toISOString(); const sd = s.slice(0, 10); const ed = e.slice(0, 10);
        const ledger = (await listSources(db)).find((x) => x.id === "ledger.d1");
        const funnelSource = (ledger?.mode ?? "unconnected") as NicheFacts["funnelSource"];
        const niches = (await db.prepare(`SELECT id, name FROM niches WHERE paused = 0 ORDER BY id`).all<{ id: string; name: string }>()).results;
        // Few, grouped reads (D1 calls count as subrequests): one per source, not one per niche.
        const funnel = (await db.prepare(`SELECT niche_id, event, source, SUM(count) AS n FROM funnel_daily WHERE is_test = 0 AND day >= ? AND day <= ? GROUP BY niche_id, event, source`).bind(sd, ed).all<{ niche_id: string | null; event: string; source: string; n: number }>()).results;
        const sales = (await db.prepare(`SELECT niche_id, COUNT(*) AS n FROM financial_events WHERE kind = 'sale' AND test_mode = 0 AND owner_test = 0 AND occurred_at >= ? AND occurred_at < ? GROUP BY niche_id`).bind(s, e).all<{ niche_id: string; n: number }>()).results;
        const pins = (await db.prepare(`SELECT niche_id, COUNT(*) AS n FROM op_publications WHERE source = 'platform_feed' AND observed_at >= ? GROUP BY niche_id`).bind(s).all<{ niche_id: string; n: number }>()).results;
        const content = (await db.prepare(`SELECT niche_id, SUM(CASE WHEN status='drafted' THEN 1 ELSE 0 END) AS drafted, SUM(CASE WHEN status IN ('planned','drafted') AND publish_by < ? THEN 1 ELSE 0 END) AS overdue FROM op_content_items GROUP BY niche_id`).bind(ed).all<{ niche_id: string; drafted: number; overdue: number }>()).results;
        // Only a recent lifecycle snapshot counts; an old one says nothing about today (QA-011 P2-3).
        const snap = await db.prepare(`SELECT automations_json FROM op_lifecycle_snapshots WHERE state = 'live' AND taken_at >= ? ORDER BY taken_at DESC LIMIT 1`).bind(new Date(end.getTime() - 2 * DAY).toISOString()).first<{ automations_json: string }>();
        const autos = snap ? (JSON.parse(snap.automations_json) as { nicheId: string; status: string }[]) : null;
        const sum = (n: string, ev: string, src?: RegExp) => funnel.filter((r) => r.niche_id === n && r.event === ev && (!src || src.test(r.source))).reduce((a, r) => a + Number(r.n), 0);
        const since = (input.checkoutLiveSince ?? {}) as Record<string, string>;

        const stmts: D1PreparedStatement[] = []; const proposed: Record<string, unknown>[] = []; const week = isoWeek(end);
        for (const n of niches) {
          const facts: NicheFacts = {
            nicheId: n.id, name: n.name, funnelSource, period: { start: s, end: e }, dataAsOf: ledger?.asOf ?? null,
            pageViews: sum(n.id, "page_view"), calcUses: sum(n.id, "calc_use"), checkoutClicks: sum(n.id, "checkout_click"), signups: sum(n.id, "signup_submit"),
            pinterestVisits: sum(n.id, "page_view", /pinterest/i), liveSales: Number(sales.find((r) => r.niche_id === n.id)?.n ?? 0),
            platformPins28d: Number(pins.find((r) => r.niche_id === n.id)?.n ?? 0),
            welcomeStatus: autos ? (autos.find((a) => a.nicheId === n.id)?.status ?? "missing") : null,
            draftedAwaiting: Number(content.find((r) => r.niche_id === n.id)?.drafted ?? 0), overduePlanned: Number(content.find((r) => r.niche_id === n.id)?.overdue ?? 0),
            checkoutLiveSince: since[n.id] ?? null,
          };
          const recos = recommend(facts);
          const fired = new Set(recos.map((r) => r.rule));
          // A rule that no longer fires expires its open proposal; a rule that fires again replaces last week's.
          stmts.push(db.prepare(`UPDATE op_recommendations SET status='expired' WHERE niche_id = ? AND status = 'proposed' AND (dedupe_key NOT LIKE ? OR rule NOT IN (${[...fired].map(() => "?").join(",") || "''"}))`)
            .bind(n.id, `%:${week}`, ...fired));
          for (const r of recos) {
            stmts.push(db.prepare(`INSERT INTO op_recommendations (id,niche_id,rule,dedupe_key,title,detail,action,evidence_json,evidence_label,impact,needs_owner,job_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(dedupe_key) DO UPDATE SET title=excluded.title, detail=excluded.detail, evidence_json=excluded.evidence_json, job_id=excluded.job_id`)
              .bind(newId("rec"), n.id, r.rule, `${r.rule}:${n.id}:${week}`, r.title, r.detail, r.action, JSON.stringify(r.evidence), r.label, r.impact, r.needsOwner ? 1 : 0, jobId, nowIso()));
            proposed.push({ nicheId: n.id, rule: r.rule, impact: r.impact });
          }
        }
        await flush(db, stmts);
        return { output: { week, funnelSource, proposed, note: funnelSource === "unconnected" ? "Funnel source unconnected: funnel rules did not run." : undefined } };
      },
    }],
  };
}
