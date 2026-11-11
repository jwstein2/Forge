/**
 * Opportunity Scout on the FORGE job engine. Work is split into small jobs so each fits the free-plan CPU budget:
 *
 *   intel.scout.run        planner: loads the stored evidence pack, opens a research_runs row, enqueues the jobs below
 *   intel.source.check     one batch of cited sources: HTTP GET, compare with the quoted figures, record the outcome
 *   intel.signal.collect   free public signals for one candidate (Wikimedia pageviews)
 *   intel.scout.finalize   depends on all of the above: evidence rules, deterministic scoring, then persists
 *                          opportunities, draft briefs and a run report
 *
 * Nothing here spends money, calls a model, creates an account or launches anything.
 */
import { enqueue, NonRetryableError, type HandlerDef } from "../../../../services/api/src/orchestration/engine.ts";
import { storeBrief, validateBrief, validateOpportunity } from "../../../../services/api/src/domain/intelligence.ts";
import { canonicalJson, newId, nowIso, parseJson, sha256Hex } from "../../../../services/api/src/lib/util.ts";
import scoringModelDoc from "../../../contracts/schemas/intelligence/scoring-model.v1.json" with { type: "json" };
import { applyEvidenceRules, type Downgrade } from "../apply.ts";
import { asBriefConnectors, connectorStates, unconnectedNames } from "../connectors.ts";
import type { Fetcher } from "../fetch.ts";
import { validatePack } from "../pack.ts";
import { rank, type ScoringModel } from "../score.ts";
import { pageviewClaims } from "../signal-claims.ts";
import { collectPageviews, type SeasonSummary } from "../signals.ts";
import { checkSource } from "../verify.ts";
import { etsyApiCheck, etsyListingId } from "../etsy.ts";
import { effectiveChecks, isAssisted } from "../observations.ts";
import type { Claim, EvidencePack, PackCandidate, SourceCheck } from "../types.ts";

export const SOURCE_BATCH = 6;
const MODEL = scoringModelDoc as unknown as ScoringModel;

export async function loadPack(db: D1Database, packId: string): Promise<EvidencePack> {
  const row = await db.prepare(`SELECT content_json FROM research_packs WHERE id = ?`).bind(packId).first<{ content_json: string }>();
  if (!row) throw new NonRetryableError(`evidence pack ${packId} not found`);
  return JSON.parse(row.content_json) as EvidencePack;
}

export async function storePack(db: D1Database, pack: EvidencePack, createdBy: string): Promise<string> {
  const errors = validatePack(pack);
  if (errors.length) throw new NonRetryableError(`invalid evidence pack: ${errors.join("; ")}`);
  const hash = await sha256Hex(canonicalJson(pack));
  const existing = await db.prepare(`SELECT id FROM research_packs WHERE content_hash = ?`).bind(hash).first<{ id: string }>();
  if (existing) return existing.id;
  const id = newId("pack");
  await db.prepare(`INSERT INTO research_packs (id,label,content_json,content_hash,created_by,created_at) VALUES (?,?,?,?,?,?)`)
    .bind(id, pack.label, JSON.stringify(pack), hash, createdBy, nowIso()).run();
  return id;
}

/** Newest discovery pack by its prepared_at (packs from git and from the owner both count). */
export async function latestDiscoveryPack(db: D1Database): Promise<string | null> {
  const rows = (await db.prepare(`SELECT id, content_json, created_at FROM research_packs ORDER BY created_at DESC LIMIT 20`).all<{ id: string; content_json: string; created_at: string }>()).results;
  const packs = rows.map((r) => ({ id: r.id, p: parseJson<Partial<EvidencePack>>(r.content_json, {}), at: r.created_at }))
    .filter((x) => (x.p.purpose ?? "discovery") === "discovery")
    .sort((a, b) => String(b.p.prepared_at ?? b.at).localeCompare(String(a.p.prepared_at ?? a.at)));
  return packs[0]?.id ?? null;
}

export function scoutHandlers(fetcher: Fetcher, handlers: () => Map<string, HandlerDef>): HandlerDef[] {
  const run: HandlerDef = {
    kind: "intel.scout.run", registryId: "FORGE-INTEL-SCOUT", runType: "deterministic", usesModel: false,
    steps: [{
      name: "register",
      async run({ db, env, input, jobId }) {
        const packId = String(input.packId ?? "");
        const pack = await loadPack(db, packId);
        const errors = validatePack(pack);
        if (errors.length) throw new NonRetryableError(`invalid evidence pack: ${errors.join("; ")}`);
        const runId = newId("run");
        const unconnected = unconnectedNames(connectorStates(env as unknown as Record<string, unknown>));
        await db.prepare(`INSERT INTO research_runs (id,kind,started_at,status,sources_unconnected_json,job_id,cost_cents) VALUES (?,?,?,'running',?,?,0)`)
          .bind(runId, "scout", nowIso(), JSON.stringify(unconnected), jobId).run();
        return { output: { runId, packId, sources: pack.sources.length, candidates: pack.candidates.length } };
      },
    }, {
      name: "fan_out",
      async run({ db, input, outputs, jobId }) {
        const { runId, packId } = outputs.register as { runId: string; packId: string };
        const pack = await loadPack(db, packId);
        const h = handlers(); const deps: string[] = [];
        const web = pack.sources.filter((s) => /^https?:\/\//.test(s.url)).map((s) => s.id);
        for (let i = 0; i < web.length; i += SOURCE_BATCH) {
          const j = await enqueue(db, h, { kind: "intel.source.check", parentId: jobId, idempotencyKey: `${jobId}:src:${i}`, input: { runId, packId, sourceIds: web.slice(i, i + SOURCE_BATCH) }, createdBy: `job:${jobId}`, maxAttempts: 2 });
          deps.push(j.id);
        }
        for (const c of pack.candidates) {
          const articles = c.signals?.wikipedia_articles ?? [];
          if (!articles.length) continue;
          const j = await enqueue(db, h, { kind: "intel.signal.collect", parentId: jobId, idempotencyKey: `${jobId}:sig:${c.key}`, input: { runId, candidate: c.key, articles: articles.slice(0, 3) }, createdBy: `job:${jobId}`, maxAttempts: 2 });
          deps.push(j.id);
        }
        const fin = await enqueue(db, h, { kind: "intel.scout.finalize", parentId: jobId, idempotencyKey: `${jobId}:final`, dependsOn: deps, input: { runId, packId, requestedBy: input.requestedBy ?? null }, createdBy: `job:${jobId}`, maxAttempts: 2 });
        return { output: { sourceJobs: Math.ceil(web.length / SOURCE_BATCH), signalJobs: deps.length - Math.ceil(web.length / SOURCE_BATCH), finalizeJob: fin.id } };
      },
    }],
  };

  const sourceCheck: HandlerDef = {
    kind: "intel.source.check", runType: "deterministic", usesModel: false,
    steps: [{
      name: "check",
      async run({ db, env, input, jobId }) {
        const ids = new Set((input.sourceIds as string[]) ?? []);
        const sources = input.sources as { id: string; url: string; expect?: string[]; recheck?: "auto" | "assisted" }[] | undefined
          ?? (await loadPack(db, String(input.packId))).sources.filter((s) => ids.has(s.id));
        const etsyKey = (env as unknown as Record<string, string | undefined>).ETSY_API_KEY;
        const counts: Record<string, number> = {};
        for (const s of sources.slice(0, SOURCE_BATCH * 2)) {
          // Official API when the owner has approved a key; otherwise sites that bot-wall the Worker are not fetched at all
          // (their dated observations stand in at finalize), and everything else gets a plain GET.
          const c = etsyKey && etsyListingId(s.url) ? await etsyApiCheck(fetcher, etsyKey, s)
            : isAssisted(s.url, s.recheck) ? { sourceId: s.id, url: s.url, outcome: "skipped" as const, httpStatus: null, missing: [], note: "assisted re-check: site blocks automated fetches" }
            : await checkSource(fetcher, { id: s.id, url: s.url, expect: s.expect, title: "", kind: "", accessed_at: "" });
          counts[c.outcome] = (counts[c.outcome] ?? 0) + 1;
          await db.prepare(`INSERT INTO research_source_checks (id,run_id,source_id,url,checked_at,http_status,outcome,matched_expectation,missing_json,job_id) VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(run_id, source_id) DO UPDATE SET checked_at=excluded.checked_at, http_status=excluded.http_status, outcome=excluded.outcome, matched_expectation=excluded.matched_expectation, missing_json=excluded.missing_json, job_id=excluded.job_id`)
            .bind(newId("rsc"), String(input.runId), c.sourceId, c.url, nowIso(), c.httpStatus, c.outcome,
              s.expect?.length ? (c.outcome === "confirmed" ? 1 : c.outcome === "mismatch" ? 0 : null) : null, JSON.stringify(c.missing), jobId).run();
        }
        return { output: counts };
      },
    }],
  };

  const signalCollect: HandlerDef = {
    kind: "intel.signal.collect", runType: "deterministic", usesModel: false,
    steps: [{
      name: "collect",
      async run({ db, input, now }) {
        const out: Record<string, string> = {};
        for (const article of ((input.articles as string[]) ?? []).slice(0, 3)) {
          const r = await collectPageviews(fetcher, article, now);
          out[article] = r.status;
          await db.prepare(`INSERT INTO research_signals (id,run_id,candidate,connector,subject,status,points_json,summary_json,collected_at) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(run_id, candidate, connector, subject) DO UPDATE SET status=excluded.status, points_json=excluded.points_json, summary_json=excluded.summary_json, collected_at=excluded.collected_at`)
            .bind(newId("sig"), String(input.runId), String(input.candidate), "wikimedia_pageviews", article, r.status, JSON.stringify(r.points),
              JSON.stringify(r.summary ? { ...r.summary, url: r.url } : { url: r.url, error: r.error }), nowIso()).run();
        }
        return { output: out };
      },
    }],
  };

  const finalize: HandlerDef = {
    kind: "intel.scout.finalize", runType: "deterministic", usesModel: false,
    steps: [{
      name: "evaluate",
      async run({ db, env, input, now }) {
        const runId = String(input.runId);
        const pack = await loadPack(db, String(input.packId));
        const rawChecks = (await db.prepare(`SELECT source_id, url, outcome, http_status, missing_json FROM research_source_checks WHERE run_id = ?`).bind(runId).all<Record<string, any>>()).results
          .map((r): SourceCheck => ({ sourceId: r.source_id, url: r.url, outcome: r.outcome, httpStatus: r.http_status, missing: parseJson(r.missing_json, []) }));
        const eff = await effectiveChecks(db, rawChecks, now);
        const checks = eff.checks;
        const signals = (await db.prepare(`SELECT candidate, subject, status, summary_json FROM research_signals WHERE run_id = ?`).bind(runId).all<Record<string, any>>()).results;
        const connectors = connectorStates(env as unknown as Record<string, unknown>);
        const day = now.toISOString().slice(0, 10);
        const downgrades: Record<string, Downgrade[]> = {};
        const evaluated: PackCandidate[] = [];
        for (const c0 of pack.candidates) {
          const { candidate, downgrades: d } = applyEvidenceRules(c0, checks);
          downgrades[c0.key] = d;
          const sig: Claim[] = []; const sigSources: Record<string, unknown>[] = [];
          for (const s of signals.filter((x) => x.candidate === c0.key && x.status === "collected")) {
            const summary = parseJson<SeasonSummary & { url: string }>(s.summary_json, null as any);
            const srcId = `src_wikipedia_${String(s.subject).toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
            sigSources.push({ id: srcId, title: `Wikimedia pageviews: ${s.subject}`, url: summary.url, publisher: "Wikimedia Foundation", accessed_at: day, kind: "survey_or_report", reliability_note: "Interest proxy (Wikipedia article views), not search volume." });
            sig.push(...pageviewClaims(c0.key, s.subject, srcId, summary, day));
          }
          candidate.claims = [...candidate.claims, ...sig];
          if (candidate.brief) {
            const b = candidate.brief;
            b.data_connectors = asBriefConnectors(connectors);
            b.sources = [...(b.sources ?? []), ...sigSources.filter((x) => !(b.sources ?? []).some((y: any) => y.id === x.id))];
            if (sig.length) b.summary.key_findings = [...b.summary.key_findings, ...sig];
          }
          evaluated.push(candidate);
        }
        const ranked = rank(MODEL, evaluated.map((c) => ({ opportunity_key: c.key, criterion_scores: c.criterion_scores, gates: c.gates })));
        const hard = checks.filter((c) => c.outcome === "dead" || c.outcome === "mismatch").length;
        const unreachable = checks.filter((c) => c.outcome === "unreachable" || (c.outcome === "skipped" && /^https?:/.test(c.url))).length;
        const sigMissing = signals.filter((s) => s.status !== "collected").length;
        return { output: { evaluated, ranked, downgrades, sourceSummary: { checked: checks.length, confirmed: checks.filter((c) => c.outcome === "confirmed").length, reachable: checks.filter((c) => c.outcome === "reachable").length, failed: hard, unreachable, viaObservation: eff.assisted, staleObservations: eff.stale.length }, observations: checks.filter((c) => c.via === "observation").map((c) => ({ sourceId: c.sourceId, outcome: c.outcome, observedAt: c.observedAt, note: c.note })), staleObservations: eff.stale, signalsMissing: sigMissing, unconnected: unconnectedNames(connectors) } };
      },
    }, {
      name: "persist",
      async run({ db, input, outputs }) {
        const runId = String(input.runId);
        const ev = outputs.evaluate as { evaluated: PackCandidate[]; ranked: ReturnType<typeof rank>; downgrades: Record<string, Downgrade[]>; sourceSummary: { checked: number; confirmed: number; reachable: number; failed: number; unreachable: number; viaObservation: number; staleObservations: number }; observations: unknown[]; staleObservations: string[]; signalsMissing: number; unconnected: string[] };
        const at = nowIso();
        await db.prepare(`INSERT INTO scoring_models (id,version,content_json,content_hash,active,created_at) VALUES (?,?,?,?,1,?) ON CONFLICT(version) DO NOTHING`)
          .bind(MODEL.model_id, MODEL.version, JSON.stringify(scoringModelDoc), await sha256Hex(canonicalJson(scoringModelDoc)), at).run();
        const byKey = new Map(ev.evaluated.map((c) => [c.key, c]));
        const stored: { key: string; opportunityId: string; briefId: string | null; briefNote?: string }[] = [];
        const errors: string[] = [];
        for (const r of ev.ranked) {
          const c = byKey.get(r.opportunity_key)!;
          let briefId: string | null = null; let briefNote: string | undefined;
          if (c.brief) {
            const errs = validateBrief(c.brief);
            if (errs.length) { briefNote = `brief not stored: ${errs.slice(0, 3).join("; ")}`; errors.push(`${c.key}: ${briefNote}`); }
            else {
              const dup = await db.prepare(`SELECT id FROM market_briefs WHERE niche_id = ? AND version = ?`).bind(c.brief.niche, c.brief.version).first<{ id: string }>();
              briefId = dup ? dup.id : (await storeBrief(db, c.brief)).id;
              if (dup) briefNote = "brief version already stored; linked to the existing row";
            }
          }
          const doc = opportunityDoc(c, r, runId, at, briefId, ev.unconnected);
          const errs = validateOpportunity(doc);
          if (errs.length) { errors.push(`${c.key}: opportunity invalid: ${errs.slice(0, 3).join("; ")}`); continue; }
          const id = doc.opportunity_id as string;
          await db.prepare(`INSERT INTO opportunities (id,opportunity_key,title,score,rank,recommended,scoring_model_version,brief_ref,run_id,status,content_json,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .bind(id, c.key, c.title, r.adjusted_score, r.rank, r.recommended ? 1 : 0, MODEL.version, briefId, runId, r.recommended ? "recommended" : "candidate", JSON.stringify(doc), await sha256Hex(canonicalJson(doc)), at).run();
          stored.push({ key: c.key, opportunityId: id, briefId, ...(briefNote ? { briefNote } : {}) });
        }
        const partial = errors.length > 0 || ev.sourceSummary.unreachable > 0 || ev.signalsMissing > 0;
        const status = stored.length ? (partial ? "partial" : "succeeded") : "failed";
        await db.prepare(`UPDATE research_runs SET status=?, finished_at=? WHERE id=?`).bind(status, at, runId).run();
        const report = { runId, packId: input.packId, status, ranking: ev.ranked.map((r) => ({ key: r.opportunity_key, rank: r.rank, raw: r.raw_score, adjusted: r.adjusted_score, coverage: r.evidence_coverage, recommended: r.recommended, strength: r.recommendation_strength, missingRequired: r.missing_required })), stored, downgrades: ev.downgrades, sources: ev.sourceSummary, observations: ev.observations, staleObservations: ev.staleObservations, signalsMissing: ev.signalsMissing, unconnected: ev.unconnected, errors };
        await db.prepare(`INSERT INTO research_run_reports (run_id,pack_id,report_json,created_at) VALUES (?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET report_json=excluded.report_json`).bind(runId, String(input.packId), JSON.stringify(report), at).run();
        if (!stored.length) throw new NonRetryableError(`Scout run stored no opportunities: ${errors.join(" | ").slice(0, 400)}`);
        return { output: { status, stored: stored.length, recommended: ev.ranked.find((r) => r.recommended)?.opportunity_key ?? null, errors: errors.length } };
      },
    }],
  };
  /** Monthly: re-run the newest discovery pack so Command's opportunity board is never older than a month. */
  const cycle: HandlerDef = {
    kind: "intel.scout.cycle", registryId: "FORGE-INTEL-SCOUT-CYCLE", runType: "deterministic", usesModel: false,
    steps: [{
      name: "enqueue",
      async run({ db, now, jobId }) {
        const packId = await latestDiscoveryPack(db);
        if (!packId) return { output: { skipped: "no evidence pack stored yet" } };
        const month = now.toISOString().slice(0, 7);
        const j = await enqueue(db, handlers(), { kind: "intel.scout.run", parentId: jobId, idempotencyKey: `scout:${packId}:${month}`, input: { packId, requestedBy: "schedule:INTEL-SCOUT-MONTHLY" }, createdBy: `job:${jobId}`, maxAttempts: 2 });
        return { output: { packId, month, scoutJob: j.id, created: j.created } };
      },
    }],
  };
  return [run, sourceCheck, signalCollect, finalize, cycle];
}

export function opportunityDoc(c: PackCandidate, r: ReturnType<typeof rank>[number], runId: string, at: string, briefId: string | null, unconnected: string[]): Record<string, unknown> {
  const claims = c.claims;
  const pick = (re: RegExp) => claims.filter((x) => re.test(x.id)).slice(0, 12);
  const sourceIds = [...new Set(claims.flatMap((x) => x.source_ids))];
  return {
    schema_version: "1.0.0", opportunity_id: `opp_${runId.slice(4)}_${c.key}`.slice(0, 120), opportunity_key: c.key, run_id: runId, title: c.title, created_at: at,
    scoring_model_version: MODEL.version, customer_segment: c.customer_segment, problem: c.problem, proposed_offer: c.proposed_offer,
    demand_summary: pick(/demand|sig_|market|audience/), competitor_summary: pick(/comp|price|wtp/),
    ...(c.seasonality ? { seasonality: c.seasonality } : {}), ...(c.economics ? { economics: c.economics } : {}),
    ...(c.launch_effort ? { launch_effort: c.launch_effort } : {}), ...(c.support_load ? { support_load: c.support_load } : {}),
    criterion_scores: c.criterion_scores.map((s) => ({ key: s.key, score: s.score, evidence: s.evidence, rationale: s.rationale, ...(s.claim_ids ? { claim_ids: s.claim_ids } : {}) })),
    raw_score: r.raw_score, adjusted_score: r.adjusted_score, evidence_coverage: r.evidence_coverage,
    gates: c.gates.map((g) => ({ key: g.key, passed: g.passed, ...(g.note ? { note: g.note } : {}) })),
    rank: r.rank, recommended: r.recommended, recommendation_strength: r.recommendation_strength,
    ...(c.hypothesis ? { hypothesis: c.hypothesis } : {}), ...(c.why_beats_alternatives ? { why_beats_alternatives: c.why_beats_alternatives } : {}), ...(c.falsifying_test ? { falsifying_test: c.falsifying_test } : {}),
    confidence: c.confidence,
    unconnected_sources: connectorStates().filter((s) => s.status !== "connected" && unconnected.includes(s.name)).map((s) => ({ name: s.name, would_add: s.would_add })),
    brief_ref: briefId, source_ids: sourceIds, status: "proposed",
  };
}
