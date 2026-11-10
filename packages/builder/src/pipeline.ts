/**
 * Build stage state machine. Pure functions: given a blueprint, gate receipts and owner approvals,
 * compute each stage's status and the build's status. Nothing here deploys, publishes or spends.
 *
 * Conventions (stored in existing platform tables, no schema change):
 *   gate_receipts.release_id = "<buildId>:<stage>"     (one receipt per gate per review)
 *   approvals.scope          = "build:<buildId>"; approvals.action = the exact owner_approvals text in the blueprint
 */
import { BUILD_STAGES, type BuildStage } from "@forge/contracts";
import type { GateId, LaunchBlueprint } from "./types.ts";

export type GateResult = "PASS" | "FAIL" | "NOT_RUN" | "BLOCKED";
export type StageStatus = "not_started" | "running" | "blocked" | "failed" | "passed";
export type BuildStatus = "draft" | "running" | "blocked" | "awaiting_approval" | "complete" | "cancelled";

export interface ReceiptLike { stage: BuildStage; gate: string; result: GateResult; reviewer: string; producer: string; createdAt: string }
export interface ApprovalLike { action: string; status: "pending" | "approved" | "denied" | "expired" }

export interface StageEvaluation {
  stage: BuildStage; status: StageStatus;
  passed: GateId[]; missing: GateId[]; failed: GateId[]; blocked: GateId[];
  pendingApprovals: string[]; deniedApprovals: string[]; escalate: GateId[]; ignoredSelfCertified: number;
  notes: string;
}
export interface BuildEvaluation { status: BuildStatus; stages: StageEvaluation[]; next: BuildStage[]; launchReady: boolean }

export const releaseId = (buildId: string, stage: BuildStage) => `${buildId}:${stage}`;
export const approvalScope = (buildId: string) => `build:${buildId}`;
export function parseReleaseId(id: string): { buildId: string; stage: BuildStage } | null {
  const i = id.lastIndexOf(":");
  if (i < 0) return null;
  const stage = id.slice(i + 1) as BuildStage;
  return (BUILD_STAGES as readonly string[]).includes(stage) ? { buildId: id.slice(0, i), stage } : null;
}

/** Latest independent receipt per gate. Self-certified receipts never count (the database also refuses them). */
function latest(receipts: ReceiptLike[]): { byGate: Map<string, ReceiptLike>; fails: Map<string, number>; ignored: number } {
  const byGate = new Map<string, ReceiptLike>(); const fails = new Map<string, number>(); let ignored = 0;
  for (const r of [...receipts].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!r.reviewer || r.reviewer === r.producer) { ignored++; continue; }
    byGate.set(r.gate, r);
    if (r.result === "FAIL") fails.set(r.gate, (fails.get(r.gate) ?? 0) + 1);
  }
  return { byGate, fails, ignored };
}

export function evaluateBuild(bp: LaunchBlueprint, receipts: ReceiptLike[], approvals: ApprovalLike[], opts: { cancelled?: boolean } = {}): BuildEvaluation {
  const results = new Map<BuildStage, StageEvaluation>();
  for (const plan of bp.stages) {
    // launch_readiness looks at the latest receipt for each gate across the whole build; other stages only at their own.
    const scoped = plan.stage === "launch_readiness" ? receipts : receipts.filter((r) => r.stage === plan.stage);
    const { byGate, fails, ignored } = latest(scoped);
    const passed: GateId[] = [], missing: GateId[] = [], failed: GateId[] = [], blocked: GateId[] = [], escalate: GateId[] = [];
    for (const g of plan.gates) {
      const r = byGate.get(g);
      if (!r || r.result === "NOT_RUN") missing.push(g);
      else if (r.result === "PASS") passed.push(g);
      else if (r.result === "FAIL") failed.push(g);
      else blocked.push(g);
      // One revision cycle after a FAIL; a second FAIL escalates (FORGE_RELEASE_GATES §1).
      if ((fails.get(g) ?? 0) >= 2 && r?.result !== "PASS") escalate.push(g);
    }
    const appr = (a: string) => approvals.filter((x) => x.action === a);
    const pendingApprovals = plan.owner_approvals.filter((a) => !appr(a).some((x) => x.status === "approved"));
    const deniedApprovals = plan.owner_approvals.filter((a) => appr(a).some((x) => x.status === "denied") && !appr(a).some((x) => x.status === "approved"));
    const unmet = plan.depends_on.filter((d) => results.get(d)?.status !== "passed");

    let status: StageStatus; const notes: string[] = [];
    if (failed.length) { status = "failed"; notes.push(`FAIL: ${failed.join(", ")}`); }
    else if (blocked.length) { status = "blocked"; notes.push(`BLOCKED: ${blocked.join(", ")}`); }
    else if (deniedApprovals.length) { status = "blocked"; notes.push(`Owner declined: ${deniedApprovals.join("; ")}`); }
    else if (unmet.length) { status = "not_started"; notes.push(`Waiting on ${unmet.join(", ")}`); }
    else if (!missing.length && !pendingApprovals.length) status = "passed";
    else if (!missing.length) { status = "blocked"; notes.push(`Awaiting owner: ${pendingApprovals.join("; ")}`); }
    else { status = passed.length ? "running" : "not_started"; notes.push(`Gates outstanding: ${missing.join(", ")}`); }
    if (escalate.length) notes.push(`Escalate: second FAIL on ${escalate.join(", ")}`);
    if (ignored) notes.push(`${ignored} self-certified receipt(s) ignored`);
    results.set(plan.stage, { stage: plan.stage, status, passed, missing, failed, blocked, pendingApprovals, deniedApprovals, escalate, ignoredSelfCertified: ignored, notes: notes.join(". ") });
  }
  const stages = BUILD_STAGES.map((s) => results.get(s)!);
  const launchReady = stages.every((s) => s.stage === "launch_readiness" ? s.missing.length === 0 && !s.failed.length && !s.blocked.length : s.status === "passed");
  const next = stages.filter((s) => (s.status === "not_started" || s.status === "running") && !s.notes.startsWith("Waiting on")).map((s) => s.stage);

  let status: BuildStatus;
  if (opts.cancelled) status = "cancelled";
  else if (stages.every((s) => s.status === "passed")) status = "complete";
  else if (stages.some((s) => s.status === "failed" || (s.status === "blocked" && !s.notes.startsWith("Awaiting owner")))) status = "blocked";
  else if (stages.some((s) => s.status === "blocked")) status = "awaiting_approval";
  else if (stages.some((s) => s.status === "running" || s.status === "passed")) status = "running";
  else status = "draft";
  return { status, stages, next, launchReady };
}
