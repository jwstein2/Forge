import { describe, expect, it } from "vitest";
import { generateBlueprint } from "../src/generate.ts";
import { evaluateBuild, parseReleaseId, releaseId, type ApprovalLike, type ReceiptLike } from "../src/pipeline.ts";
import type { GateId, LaunchBlueprint } from "../src/types.ts";
import { loadBrief, syntheticNewBusinessBrief } from "./helpers.ts";

const bp = await generateBlueprint(loadBrief("bidline"));
let t = 0;
const pass = (stage: ReceiptLike["stage"], gate: string, result: ReceiptLike["result"] = "PASS", reviewer = "qa", producer = "builder"): ReceiptLike =>
  ({ stage, gate, result, reviewer, producer, createdAt: `2026-11-10T04:${String(t++).padStart(2, "0")}:00Z` });
/** PASS every gate of every stage up to and including `until`. */
function passThrough(b: LaunchBlueprint, until: ReceiptLike["stage"]): ReceiptLike[] {
  const out: ReceiptLike[] = [];
  for (const s of b.stages) { for (const g of s.gates) out.push(pass(s.stage, g)); if (s.stage === until) break; }
  return out;
}
const approved = (b: LaunchBlueprint, except: string[] = []): ApprovalLike[] =>
  b.stages.flatMap((s) => s.owner_approvals).filter((a) => !except.includes(a)).map((action) => ({ action, status: "approved" as const }));

describe("build stage pipeline", () => {
  it("a fresh build is a draft whose only next step is research", () => {
    const ev = evaluateBuild(bp, [], []);
    expect(ev.status).toBe("draft");
    expect(ev.next).toEqual(["research"]);
    expect(ev.stages[1]!.notes).toMatch(/Waiting on research/);
  });

  it("an independent B0 PASS completes research and unlocks blueprint", () => {
    const ev = evaluateBuild(bp, [pass("research", "B0")], []);
    expect(ev.stages[0]!.status).toBe("passed");
    expect(ev.next).toEqual(["blueprint"]);
    expect(ev.status).toBe("running");
  });

  it("self-certified receipts never count", () => {
    const ev = evaluateBuild(bp, [pass("research", "B0", "PASS", "builder", "builder")], []);
    expect(ev.stages[0]!.status).toBe("not_started");
    expect(ev.stages[0]!.ignoredSelfCertified).toBe(1);
  });

  it("a FAIL blocks the build; a second FAIL escalates; a later PASS clears it", () => {
    const base = passThrough(bp, "blueprint");
    let ev = evaluateBuild(bp, [...base, pass("products", "G4", "FAIL")], []);
    expect(ev.stages[2]!.status).toBe("failed");
    expect(ev.status).toBe("blocked");
    ev = evaluateBuild(bp, [...base, pass("products", "G4", "FAIL"), pass("products", "G4", "FAIL")], []);
    expect(ev.stages[2]!.escalate).toEqual(["G4"]);
    ev = evaluateBuild(bp, [...base, pass("products", "G4", "FAIL"), pass("products", "G4", "PASS")], []);
    expect(ev.stages[2]!.failed).toEqual([]);
  });

  it("gates from one stage do not satisfy another (website G1 is not testing G1)", () => {
    const r = passThrough(bp, "marketing");
    const ev = evaluateBuild(bp, r, approved(bp));
    expect(ev.stages[7]!.status).toBe("not_started");
    expect(ev.stages[7]!.missing).toEqual(["G1", "G5", "G13"]);
  });

  it("integrations wait for the owner's account approvals even when gates pass", () => {
    const ev = evaluateBuild(bp, passThrough(bp, "integrations"), []);
    expect(ev.stages[5]!.status).toBe("blocked");
    expect(ev.stages[5]!.notes).toMatch(/Awaiting owner: Lemon Squeezy/);
    expect(ev.status).toBe("awaiting_approval");
  });

  it("all gates PASS still does not launch without the owner's launch approval", () => {
    const all = passThrough(bp, "launch_readiness");
    const ev = evaluateBuild(bp, all, approved(bp, ["Production deploy and launch"]));
    expect(ev.gatesReadyForLaunchDecision).toBe(true);
    expect(ev.launchApproved).toBe(false);
    expect(ev.stages[8]!.status).toBe("blocked");
    expect(ev.status).toBe("awaiting_approval");
    const done = evaluateBuild(bp, all, approved(bp));
    expect(done.status).toBe("complete");
  });

  it("launch readiness uses the latest receipt per gate across the build, so a later FAIL reopens it", () => {
    const all = passThrough(bp, "launch_readiness");
    const ev = evaluateBuild(bp, [...all, pass("website", "G12", "FAIL")], approved(bp));
    expect(ev.gatesReadyForLaunchDecision).toBe(false);
    expect(ev.status).toBe("blocked");
  });

  it("an owner refusal blocks the stage", () => {
    const ev = evaluateBuild(bp, passThrough(bp, "integrations"), [{ action: "Lemon Squeezy", status: "denied" }]);
    expect(ev.stages[5]!.notes).toMatch(/Owner declined: Lemon Squeezy/);
    expect(ev.status).toBe("blocked");
  });

  it("a new business cannot get past research without the owner's selection", async () => {
    const nb = await generateBlueprint(syntheticNewBusinessBrief(), { businessKind: "new_business" });
    const ev = evaluateBuild(nb, [pass("research", "B0")], []);
    expect(ev.stages[0]!.status).toBe("blocked");
    expect(ev.status).toBe("awaiting_approval");
  });

  it("QA-004 B4: a later denial revokes an earlier approval", () => {
    const all = passThrough(bp, "launch_readiness");
    const launch = "Production deploy and launch";
    const approvals: ApprovalLike[] = [
      ...approved(bp, [launch]),
      { action: launch, status: "approved", decidedAt: "2026-11-10T06:00:00Z" },
      { action: launch, status: "denied", decidedAt: "2026-11-10T07:00:00Z" },
    ];
    const ev = evaluateBuild(bp, all, approvals);
    expect(ev.status).toBe("blocked");
    expect(ev.launchApproved).toBe(false);
    const reapproved = evaluateBuild(bp, all, [...approvals, { action: launch, status: "approved", decidedAt: "2026-11-10T08:00:00Z" }]);
    expect(reapproved.status).toBe("complete");
    expect(reapproved.launchApproved).toBe(true);
  });

  it("QA-004 B5: reviewer identity differing only by case or spacing is not independent", () => {
    for (const reviewer of ["Builder", " builder ", "BUILDER", "build-er"]) {
      const ev = evaluateBuild(bp, [pass("research", "B0", "PASS", reviewer, "builder")], []);
      expect(ev.stages[0]!.status).toBe("not_started");
    }
  });

  it("cancelled builds report cancelled", () => expect(evaluateBuild(bp, [], [], { cancelled: true }).status).toBe("cancelled"));

  it("release ids round-trip", () => {
    expect(parseReleaseId(releaseId("bld_x:y", "website"))).toEqual({ buildId: "bld_x:y", stage: "website" });
    expect(parseReleaseId("bld_x:nope")).toBeNull();
  });

  it("every gate any stage names is a real gate", () => {
    const valid = new Set<GateId>(["B0", "B1", ...Array.from({ length: 15 }, (_, i) => `G${i + 1}` as GateId)]);
    expect(bp.stages.flatMap((s) => s.gates).every((g) => valid.has(g))).toBe(true);
  });
});
