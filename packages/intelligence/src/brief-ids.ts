/** Claim ids must be unique within a brief: the Builder and the re-check trace every claim by id. JSON Schema cannot express this. */
export function duplicateClaimIds(doc: unknown): string[] {
  const seen = new Set<string>(), dup = new Set<string>();
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === "object") {
      const r = o as Record<string, unknown>;
      if (typeof r.id === "string" && typeof r.statement === "string") { if (seen.has(r.id)) dup.add(r.id); seen.add(r.id); }
      Object.values(r).forEach(walk);
    }
  };
  walk(doc);
  return [...dup];
}
