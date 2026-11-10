/**
 * Built-in job handlers. Each is deterministic; none spends money or writes outside the FORGE database.
 */
import { NonRetryableError, type HandlerDef } from "./engine.ts";
import { builderHandlers } from "@forge/builder/handlers";
import { d1Ledger, d1RestLedger, importLedger, snapshotLedger, type LedgerSnapshot } from "../adapters/ledger.ts";
import { importN8n, liveN8n, snapshotN8n, type N8nSnapshot } from "../adapters/n8n.ts";
import { listSources } from "../adapters/sources.ts";
import { listRegistry } from "../domain/registry.ts";
import { newId, nowIso } from "../lib/util.ts";
import { seedRegistry } from "../domain/seed.ts";
import { REGISTRY_DATA } from "../domain/registry-data.ts";
import ledgerSnapshot from "../../fixtures/ledger-snapshot-2026-11-10.json" with { type: "json" };
import n8nSnapshot from "../../fixtures/n8n-snapshot-2026-11-10.json" with { type: "json" };

export const ledgerSync: HandlerDef = {
  kind: "ledger.sync",
  registryId: "FORGE-LEDGER-SYNC",
  steps: [{
    name: "import",
    async run({ db, env }) {
      // Live read-only binding when the owner has approved one for this environment; otherwise the dated snapshot.
      const reader = env.LEDGER_API_TOKEN && env.LEDGER_ACCOUNT_ID && env.LEDGER_DATABASE_ID
        ? d1RestLedger({ accountId: env.LEDGER_ACCOUNT_ID, databaseId: env.LEDGER_DATABASE_ID, token: env.LEDGER_API_TOKEN })
        : env.LEDGER_DB ? d1Ledger(env.LEDGER_DB) : snapshotLedger(ledgerSnapshot as LedgerSnapshot);
      return { output: { mode: reader.mode, ...(await importLedger(db, reader)) } };
    },
  }],
};

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
  steps: [{ name: "seed", async run({ db }) { return { output: await seedRegistry(db, REGISTRY_DATA) }; } }],
};

const BUILDER_REGISTRY: Record<string, string> = {
  "builder.blueprint.generate": "FORGE-BUILDER-BLUEPRINT", "builder.build.plan": "FORGE-BUILDER-PLAN", "builder.build.evaluate": "FORGE-BUILDER-EVALUATE",
};
const builder = (): HandlerDef[] => builderHandlers({ NonRetryableError }).map((h) => ({ ...h, registryId: h.registryId ?? BUILDER_REGISTRY[h.kind] }) as HandlerDef);

export const defaultHandlers = (): Map<string, HandlerDef> =>
  new Map([registrySeed, ledgerSync, n8nSync, heartbeatWatchdog, ...builder()].map((h) => [h.kind, h]));
