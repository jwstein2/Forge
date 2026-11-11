/**
 * Built-in job handlers. Each is deterministic; none spends money or writes outside the FORGE database.
 */
import { NonRetryableError, enqueue, modelUsageMonthToDate, type HandlerDef, type StepDef } from "./engine.ts";
import { runDataControls, toAlertRow, type ProductPrice, type RawSale } from "@forge/controls/engine";
import { builderHandlers } from "@forge/builder/handlers";
import { d1Ledger, d1RestLedger, importLedger, snapshotLedger, type LedgerSnapshot } from "../adapters/ledger.ts";
import { importN8n, liveN8n, snapshotN8n, type N8nSnapshot } from "../adapters/n8n.ts";
import { listSources } from "../adapters/sources.ts";
import { listRegistry } from "../domain/registry.ts";
import { newId, nowIso } from "../lib/util.ts";
import { seedRegistry } from "../domain/seed.ts";
import { REGISTRY_DATA } from "../domain/registry-data.ts";
import { operatorHandlers, seedOperatorRegistry } from "@forge/operator";
import { intelligenceHandlers, seedIntelligenceRegistry, seedBriefs, storeObservations, storePack, GIT_BRIEFS, GIT_OBSERVATIONS, GIT_PACKS } from "@forge/intelligence";
import ledgerSnapshot from "../../fixtures/ledger-snapshot-2026-11-10.json" with { type: "json" };
import n8nSnapshot from "../../fixtures/n8n-snapshot-2026-11-10.json" with { type: "json" };

function ledgerReader(env: Parameters<StepDef["run"]>[0]["env"]) {
  // Live read-only binding when the owner has approved one for this environment; otherwise the dated snapshot.
  return env.LEDGER_API_TOKEN && env.LEDGER_ACCOUNT_ID && env.LEDGER_DATABASE_ID
    ? d1RestLedger({ accountId: env.LEDGER_ACCOUNT_ID, databaseId: env.LEDGER_DATABASE_ID, token: env.LEDGER_API_TOKEN })
    : env.LEDGER_DB ? d1Ledger(env.LEDGER_DB) : snapshotLedger(ledgerSnapshot as LedgerSnapshot);
}

export const ledgerSync: HandlerDef = {
  kind: "ledger.sync",
  registryId: "FORGE-LEDGER-SYNC",
  runType: "deterministic",
  steps: [{
    name: "import",
    async run({ db, env }) {
      const reader = ledgerReader(env);
      return { output: { mode: reader.mode, ...(await importLedger(db, reader)) } };
    },
  }, {
    // Workstream F data controls on the same ledger read: integrity, price and budget checks → deduplicated alerts.
    name: "controls",
    async run({ db, env, now }) {
      const reader = ledgerReader(env);
      if (reader.mode === "unconnected") return { output: { skipped: "ledger unconnected" } };
      const out = await runControlsOnDb(db, (await reader.readSales()) as RawSale[], now);
      return { output: { mode: reader.mode, ...out } };
    },
  }],
};

/** Run @forge/controls data checks and reconcile their alerts: open/refresh current findings, resolve ones that cleared. */
export async function runControlsOnDb(db: D1Database, sales: RawSale[], now: Date) {
  const products = (await db.prepare(`SELECT id, niche_id, name, tier, site_price_cents, checkout_price_cents, ledger_product_name, checkout_status FROM products`).all<Record<string, any>>()).results
    .map((p): ProductPrice => ({ id: p.id, nicheId: p.niche_id, name: p.name, tier: p.tier, sitePriceCents: p.site_price_cents, checkoutPriceCents: p.checkout_price_cents, ledgerProductName: p.ledger_product_name, checkoutStatus: p.checkout_status }));
  const budgets = (await db.prepare(`SELECT * FROM budgets`).all<Record<string, any>>()).results
    .map((b) => ({ id: b.id, scope: b.scope, ceilingCents: b.ceiling_cents, approvedCents: b.approved_cents, spentCents: b.spent_cents, evidence: b.evidence, notes: b.notes }));
  const mtd = await modelUsageMonthToDate(db, now); // throws on a read error (not a missing table): the step retries instead of reporting $0
  const findings = runDataControls({ sales, products, budgets, modelUsageMonthToDateCents: mtd });
  const at = nowIso();
  const stmts = findings.map((f) => { const r = toAlertRow(f, at);
    return db.prepare(`INSERT INTO alerts (id,severity,niche_id,source,title,detail,state,dedupe_key,first_seen,last_seen,next_action,needs_owner)
      VALUES (?,?,?,?,?,?,'open',?,?,?,?,?) ON CONFLICT(dedupe_key) DO UPDATE SET last_seen=excluded.last_seen, detail=excluded.detail, severity=excluded.severity, needs_owner=excluded.needs_owner,
      state=CASE WHEN alerts.state='acknowledged' THEN 'acknowledged' ELSE 'open' END`)
      .bind(newId("al"), r.severity, r.niche_id, r.source, r.title, r.detail, r.dedupe_key, at, at, r.next_action, r.needs_owner); });
  // Controls owned by this step (fin:ledger / fin:price / fin:budget) that no longer fire are resolved. An empty ledger
  // read is not evidence that ledger problems cleared (QA-006 R1), so fin:ledger alerts are left as they are then.
  const keys = findings.map((f) => f.dedupeKey);
  const owned = sales.length ? `dedupe_key LIKE 'fin:ledger:%' OR dedupe_key LIKE 'fin:price:%' OR dedupe_key LIKE 'fin:budget:%'` : `dedupe_key LIKE 'fin:price:%' OR dedupe_key LIKE 'fin:budget:%'`;
  stmts.push(db.prepare(`UPDATE alerts SET state='resolved', last_seen=? WHERE state <> 'resolved' AND source LIKE 'controls:FIN-%' AND (${owned})
    AND dedupe_key NOT IN (SELECT value FROM json_each(?))`).bind(at, JSON.stringify(keys)));
  await db.batch(stmts);
  return { findings: findings.length, critical: findings.filter((f) => f.severity === "critical").length, codes: [...new Set(findings.map((f) => f.code))] };
}

export const n8nSync: HandlerDef = {
  kind: "n8n.sync",
  steps: [{
    name: "import",
    async run({ db, env }) {
      const reader = env.N8N_API_KEY && env.N8N_BASE_URL ? liveN8n(env.N8N_BASE_URL, env.N8N_API_KEY) : snapshotN8n(n8nSnapshot as N8nSnapshot);
      return { output: { mode: reader.mode, runs: await importN8n(db, reader) } };
    },
  }],
};

/** Raise an alert for every scheduled entry whose heartbeat is late or never observed; resolve recovered ones. */
export const heartbeatWatchdog: HandlerDef = {
  kind: "heartbeat.watchdog",
  registryId: "FORGE-WATCHDOG",
  steps: [{
    name: "evaluate",
    async run({ db, now }) {
      const sources = await listSources(db);
      const n8n = sources.find((s) => s.id === "n8n")!;
      const entries = await listRegistry(db, { n8n, now });
      const at = nowIso(); let raised = 0; let resolved = 0;
      for (const e of entries) {
        if (e.id === "FORGE-WATCHDOG" || e.status === "PROPOSED" || e.status === "FAILED") continue;
        const key = `heartbeat:${e.id}`;
        if (e.heartbeat === "late" || (e.heartbeat === "never_observed" && e.status === "LIVE")) {
          const late = e.heartbeat === "late";
          await db.prepare(`INSERT INTO alerts (id,severity,niche_id,source,title,detail,state,dedupe_key,first_seen,last_seen,next_action)
            VALUES (?,?,?,?,?,?,'open',?,?,?,?) ON CONFLICT(dedupe_key) DO UPDATE SET last_seen=excluded.last_seen, state=CASE WHEN alerts.state='resolved' THEN 'open' ELSE alerts.state END`)
            .bind(newId("al"), late ? "warning" : "info", e.nicheId, "heartbeat.watchdog",
              late ? `${e.name} has not succeeded within 2× its interval` : `${e.name} is marked LIVE but FORGE has no run record`,
              late ? `Last success ${e.lastSuccess?.finishedAt ?? e.lastSuccess?.startedAt}; cadence ${e.cadence}.` : `Runner ${e.runner} does not report runs to FORGE yet.`,
              key, at, at, late ? "Check the runner; FORGE will re-check on the next tick." : "Connect this runner's heartbeat (Milestone 3).").run();
          raised++;
        } else if (e.heartbeat === "ok") {
          const r = await db.prepare(`UPDATE alerts SET state='resolved', last_seen=? WHERE dedupe_key=? AND state<>'resolved'`).bind(at, key).run();
          resolved += Number(r.meta.changes ?? 0);
        }
      }
      return { output: { evaluated: entries.length, raised, resolved } };
    },
  }],
};

/** Load the git registry into the database (idempotent; never overwrites runtime state such as pauses). */
export const registrySeed: HandlerDef = {
  kind: "registry.seed",
  steps: [{ name: "seed", async run({ db }) { const out = await seedRegistry(db, REGISTRY_DATA); return { output: { ...out, operator_registry: await seedOperatorRegistry(db), intelligence_registry: await seedIntelligenceRegistry(db) } }; } }],
};

/**
 * Git-kept intelligence data (evidence packs, dated observations, briefs), seeded in small child jobs: inline in the
 * scheduled invocation it would cost ~50 D1 subrequests on top of the registry seed (free plan: 50 per invocation).
 * input.part: "packs" | "observations" | "brief" (+ index). All writes are content-hash or niche+version deduped.
 */
export const seedDataJob: HandlerDef = {
  kind: "system.seed_data",
  steps: [{ name: "seed", async run({ db, input, jobId }) {
    const part = String(input.part ?? "");
    if (part === "plan") {
      const h = defaultHandlers(); const ids: string[] = [];
      for (const p of seedDataParts()) ids.push((await enqueue(db, h, { kind: "system.seed_data", input: p, parentId: jobId, priority: 40, idempotencyKey: `${jobId}:${p.part}:${p.index ?? 0}`, createdBy: `job:${jobId}`, maxAttempts: 2 })).id);
      return { output: { planned: ids } };
    }
    if (part === "packs") { for (const p of GIT_PACKS) await storePack(db, p, "git"); return { output: { packs: GIT_PACKS.length } }; }
    if (part === "observations") return { output: await storeObservations(db, GIT_OBSERVATIONS) };
    if (part === "brief") {
      const doc = GIT_BRIEFS[Number(input.index)];
      if (!doc) throw new NonRetryableError(`no git brief at index ${input.index}`);
      const out = await seedBriefs(db, [doc]);
      // An invalid git brief fails this child job, which raises the engine's job alert (QA-019 I2-2); the cron tick itself only enqueues.
      if (out.invalid.length) throw new NonRetryableError(`git brief invalid: ${out.invalid.join("; ")}`);
      return { output: out };
    }
    throw new NonRetryableError(`unknown seed part: ${part}`);
  } }],
};
export const seedDataParts = (): Record<string, unknown>[] => [{ part: "packs" }, { part: "observations" }, ...GIT_BRIEFS.map((_, index) => ({ part: "brief", index }))];

const BUILDER_REGISTRY: Record<string, string> = {
  "builder.blueprint.generate": "FORGE-BUILDER-BLUEPRINT", "builder.build.plan": "FORGE-BUILDER-PLAN", "builder.build.evaluate": "FORGE-BUILDER-EVALUATE",
};
const builder = (): HandlerDef[] => builderHandlers({ NonRetryableError }).map((h) => ({ ...h, registryId: h.registryId ?? BUILDER_REGISTRY[h.kind] }) as HandlerDef);

export const defaultHandlers = (): Map<string, HandlerDef> =>
  new Map([registrySeed, seedDataJob, ledgerSync, n8nSync, heartbeatWatchdog, ...builder(), ...operatorHandlers(), ...intelligenceHandlers()].map((h) => [h.kind, h]));
