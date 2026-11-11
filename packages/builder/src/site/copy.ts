/**
 * Copy decks: proposed customer-facing text that fills the scaffold's "Copy needed" markers.
 * A deck is always PROPOSED (G2 reviews it). Only marketing-copy markers can be filled; operator, legal and
 * contact details always come from the site config, never from a deck.
 *
 * Honesty rules enforced by validateCopyDeck:
 *  - no proof the business does not have (reviews, ratings, counts, "best-selling", guarantees of results);
 *  - every number must already be in the blueprint's products (price, name, contents) or in a brief claim the entry cites;
 *  - cited claims must exist in the source brief.
 */
import type { LaunchBlueprint } from "../types.ts";

export interface CopyEntry { key: string; text: string; basis: string[]; note?: string }
export interface CopyDeck { niche: string; version: string; status: "PROPOSED"; blueprint_id: string; written_by: string; entries: CopyEntry[] }

/** Marker keys a deck may fill (faq.<claim id> answers objections). */
export const COPYABLE = ["promise.headline", "promise.subhead", "pain.voice", "picture.after", "email.offer", "howto", "download.first", "mission", "terms.disclaimer", "product.subhead"] as const;
export const copyKeyAllowed = (key: string) => (COPYABLE as readonly string[]).includes(key) || /^faq\.[A-Za-z0-9_.-]+$/.test(key);

const FAKE_PROOF = /\b(testimonials?|reviews?|reviewed|rated|ratings?|stars?|best[- ]?sell(ing|er)|#\s?1\b|number one|guarantee[ds]?|thousands of|hundreds of|customers (love|say)|trusted by|as seen (on|in)|award[- ]winning|proven|clinically)\b|★/i;
const numbers = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", ""));

/** All claims in a brief, by id (any object with id + statement). */
export function briefClaims(brief: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.id === "string" && typeof o.statement === "string") out.set(o.id, o.statement);
      Object.values(o).forEach(walk);
    }
  };
  walk(brief);
  return out;
}

export function validateCopyDeck(deck: CopyDeck, bp: LaunchBlueprint, brief: unknown): string[] {
  const e: string[] = [];
  if (deck.status !== "PROPOSED") e.push("copy deck status must be PROPOSED (G2 approves copy, not the deck)");
  if (deck.niche !== bp.niche) e.push(`copy deck is for ${deck.niche}, blueprint is ${bp.niche}`);
  if (deck.blueprint_id !== bp.blueprint_id) e.push(`copy deck was written for ${deck.blueprint_id}, not ${bp.blueprint_id}`);
  const claims = briefClaims(brief);
  const base = new Set(bp.products.flatMap((p) => [String(p.price.value ?? ""), ...numbers(p.name), ...p.must_include.flatMap(numbers)]));
  const seen = new Set<string>();
  for (const en of deck.entries) {
    const where = `copy ${en.key}`;
    if (seen.has(en.key)) e.push(`${where}: duplicate key`); seen.add(en.key);
    const [path, key] = en.key.split("#");
    if (!path || !key || !(path === "*" || path.startsWith("/"))) { e.push(`${where}: key must be "<page path>#<marker>" or "*#<marker>"`); continue; }
    if (!copyKeyAllowed(key)) e.push(`${where}: "${key}" cannot be filled from a deck (it comes from config or the blueprint)`);
    if (path !== "*" && !bp.page_map.some((p) => p.path === path)) e.push(`${where}: no page ${path} in the blueprint`);
    if (!en.text.trim()) e.push(`${where}: empty text`);
    if (FAKE_PROOF.test(en.text)) e.push(`${where}: reads as proof the business does not have ("${en.text.match(FAKE_PROOF)![0]}")`);
    const allowed = new Set(base);
    for (const id of en.basis) { const st = claims.get(id); if (st === undefined) e.push(`${where}: cites unknown claim ${id}`); else numbers(st).forEach((n) => allowed.add(n)); }
    for (const n of numbers(en.text)) if (!allowed.has(n)) e.push(`${where}: figure ${n} is not in the blueprint's products or the claims it cites`);
    if (key.startsWith("faq.") && !claims.has(key.slice(4)) && !bp.sales_framework.objections.some((o) => o.claim.claim_id === key.slice(4))) e.push(`${where}: no objection ${key.slice(4)}`);
  }
  return e;
}
