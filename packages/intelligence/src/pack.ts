/** Structural validation of an evidence pack before any job is enqueued. Content documents are validated against the JSON Schemas later. */
import type { EvidencePack } from "./types.ts";

const LABELS = new Set(["VERIFIED", "ESTIMATED", "INFERRED", "UNKNOWN"]);
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validatePack(p: unknown): string[] {
  const e: string[] = [];
  const pack = p as EvidencePack;
  if (!pack || typeof pack !== "object") return ["pack must be an object"];
  if (pack.schema !== "forge.evidence-pack/1") e.push("schema must be forge.evidence-pack/1");
  if (!pack.label) e.push("label required");
  if (!Array.isArray(pack.sources)) e.push("sources[] required");
  if (!Array.isArray(pack.candidates) || pack.candidates.length < 1) e.push("candidates[] required");
  if (e.length) return e;
  if (pack.candidates.length > 8) e.push("at most 8 candidates per run (bounded fan-out)");
  if (pack.sources.length > 200) e.push("at most 200 sources per run");
  const srcIds = new Set<string>();
  for (const s of pack.sources) {
    if (!/^src_[a-z0-9_-]+$/.test(s.id)) e.push(`source id ${s.id} must match src_...`);
    if (srcIds.has(s.id)) e.push(`duplicate source ${s.id}`);
    srcIds.add(s.id);
    if (!s.url) e.push(`source ${s.id} has no url`);
  }
  const keys = new Set<string>();
  for (const c of pack.candidates) {
    const where = `candidate ${c.key}`;
    if (!SLUG.test(c.key ?? "")) e.push(`${where}: key must be kebab-case`);
    if (keys.has(c.key)) e.push(`${where}: duplicate key`);
    keys.add(c.key);
    const price = c.proposed_offer?.price as { evidence?: string } | undefined;
    if (!price || !LABELS.has(String(price.evidence))) e.push(`${where}: proposed_offer.price must be a metric with an evidence label`);
    const claimIds = new Set((c.claims ?? []).map((x) => x.id));
    for (const cl of c.claims ?? []) {
      if (!LABELS.has(cl.evidence)) e.push(`${where}: claim ${cl.id} has bad evidence label`);
      for (const s of cl.source_ids ?? []) if (!srcIds.has(s)) e.push(`${where}: claim ${cl.id} cites unknown source ${s}`);
      if ((cl.evidence === "VERIFIED" || cl.evidence === "ESTIMATED") && !(cl.source_ids ?? []).length) e.push(`${where}: claim ${cl.id} is ${cl.evidence} without a source`);
      if (cl.evidence === "UNKNOWN" && !cl.to_resolve) e.push(`${where}: claim ${cl.id} is UNKNOWN without to_resolve`);
    }
    for (const cs of c.criterion_scores ?? []) {
      if (!LABELS.has(cs.evidence)) e.push(`${where}: criterion ${cs.key} has bad evidence label`);
      if (cs.score !== null && (cs.score < 0 || cs.score > 5)) e.push(`${where}: criterion ${cs.key} score out of range`);
      for (const id of cs.claim_ids ?? []) if (!claimIds.has(id)) e.push(`${where}: criterion ${cs.key} cites unknown claim ${id}`);
    }
  }
  return e.slice(0, 50);
}
