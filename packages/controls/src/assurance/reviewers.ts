/**
 * Authorised QA reviewer identities for gate receipts (release gates §1: independence; constitution §12).
 * The database already refuses reviewer = producer; this adds: the reviewer must be a registered, active reviewer
 * whose scope covers the gate, and must not belong to the producer's workstream (aliases resolved).
 */
import registry from "./reviewers.json" with { type: "json" };

export interface ReviewerEntry { id: string; aliases: string[]; role: string; workstream: string; gates: string[]; activeFrom: string; activeUntil: string | null }
export interface ProducerEntry { id: string; aliases: string[]; workstream: string }
export interface ReviewerRegistry { reviewers: ReviewerEntry[]; producers: ProducerEntry[] }

export const REVIEWERS: ReviewerRegistry = registry as ReviewerRegistry;
export const normaliseIdentity = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[\s_.\-:]+/g, "");

function find<T extends { id: string; aliases: string[] }>(xs: T[], who: string): T | null {
  const n = normaliseIdentity(who);
  if (!n) return null;
  return xs.find((x) => [x.id, ...x.aliases].some((a) => normaliseIdentity(a) === n)) ?? null;
}

export type ReceiptCheck = { ok: true; reviewerId: string } | { ok: false; reason: "unknown_reviewer" | "inactive" | "gate_out_of_scope" | "same_workstream" | "bad_result" | "no_evidence" };

export function checkReceipt(r: { reviewer: string; producer: string; gate: string; result: string; evidence?: unknown[]; at: string }, reg: ReviewerRegistry = REVIEWERS): ReceiptCheck {
  if (!["PASS", "FAIL", "NOT_RUN", "BLOCKED"].includes(r.result)) return { ok: false, reason: "bad_result" };
  const rev = find(reg.reviewers, r.reviewer);
  if (!rev) return { ok: false, reason: "unknown_reviewer" };
  const day = r.at.slice(0, 10);
  if (day < rev.activeFrom || (rev.activeUntil && day > rev.activeUntil)) return { ok: false, reason: "inactive" };
  if (!rev.gates.includes("*") && !rev.gates.includes(r.gate)) return { ok: false, reason: "gate_out_of_scope" };
  const prodWs = find(reg.producers, r.producer)?.workstream ?? find(reg.reviewers, r.producer)?.workstream ?? `unregistered:${normaliseIdentity(r.producer)}`;
  if (prodWs === rev.workstream || normaliseIdentity(r.producer) === normaliseIdentity(r.reviewer)) return { ok: false, reason: "same_workstream" };
  // A PASS must carry evidence; FAIL/BLOCKED/NOT_RUN are accepted without (they block anyway).
  if (r.result === "PASS" && !(r.evidence && r.evidence.length)) return { ok: false, reason: "no_evidence" };
  return { ok: true, reviewerId: rev.id };
}
