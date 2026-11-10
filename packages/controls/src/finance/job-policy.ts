/**
 * Cost policy per job kind (FORGE_COST_MODEL.md §4/§5.4). A handler may declare its own `runType`/`usesModel`;
 * this table covers handlers owned by other packages so the engine can apply defaults without editing them.
 * Unknown kinds get no default cap and are treated as not using a model.
 */
import { capForRunType } from "./budget.ts";

export interface JobCostPolicy { runType: string; usesModel: boolean }

export const JOB_COST_POLICY: Record<string, JobCostPolicy> = {
  "registry.seed": { runType: "deterministic", usesModel: false },
  "ledger.sync": { runType: "deterministic", usesModel: false },
  "n8n.sync": { runType: "deterministic", usesModel: false },
  "heartbeat.watchdog": { runType: "deterministic", usesModel: false },
  "ops.site_health": { runType: "deterministic", usesModel: false },
  "ops.seo_audit": { runType: "deterministic", usesModel: false },
  "ops.pin_runway": { runType: "deterministic", usesModel: false },
  "ops.weekly_summary": { runType: "deterministic", usesModel: false },
  "ops.content_plan": { runType: "deterministic", usesModel: false },
  "ops.content_draft": { runType: "specialist", usesModel: true },   // N items x per-item cap; the job cap is the monthly reservation
  "ops.content_publish": { runType: "deterministic", usesModel: false },
  "ops.content_verify": { runType: "deterministic", usesModel: false },
  "builder.blueprint.generate": { runType: "deterministic", usesModel: false },
  "builder.build.plan": { runType: "deterministic", usesModel: false },
  "builder.build.evaluate": { runType: "deterministic", usesModel: false },
};

export function resolveJobPolicy(kind: string, declared?: Partial<JobCostPolicy>): JobCostPolicy | null {
  const base = JOB_COST_POLICY[kind];
  if (!base && !declared?.runType && declared?.usesModel === undefined) return null;
  return { runType: declared?.runType ?? base?.runType ?? "unknown", usesModel: declared?.usesModel ?? base?.usesModel ?? false };
}

/** Cap to store on a new job: explicit cap wins; else the run type's default; null when nothing is known. */
export function defaultCapFor(kind: string, explicit: number | null | undefined, declared?: Partial<JobCostPolicy>): number | null {
  if (explicit != null) return explicit;
  const p = resolveJobPolicy(kind, declared);
  return p ? capForRunType(p.runType) : null;
}
