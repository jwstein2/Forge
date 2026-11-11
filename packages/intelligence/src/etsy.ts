/**
 * Etsy Open API v3 re-check (official API; used only when the owner has approved and set ETSY_API_KEY).
 * Reads listing state and price. Review counts are not in the listing endpoint, so expectations that are not prices
 * are reported as not checkable rather than as mismatches.
 */
import type { Fetcher } from "./fetch.ts";
import type { SourceCheck } from "./types.ts";

export const etsyListingId = (url: string): string | null => /(?:^|\.)etsy\.com\/(?:[a-z]{2}\/)?listing\/(\d+)/i.exec(url.replace(/^https?:\/\/(www\.)?/i, ""))?.[1] ?? null;
const PRICE = /^\$?\d+(?:\.\d{2})$/;

export async function etsyApiCheck(fetcher: Fetcher, key: string, src: { id: string; url: string; expect?: string[] }): Promise<SourceCheck> {
  const id = etsyListingId(src.url)!;
  const r = await fetcher(`https://openapi.etsy.com/v3/application/listings/${id}`, { accept: "application/json", headers: { "x-api-key": key }, maxBytes: 200_000 });
  const base = { sourceId: src.id, url: src.url, via: "etsy_api" as const };
  if (r.status === 404) return { ...base, outcome: "dead", httpStatus: 404, missing: src.expect ?? [], note: "listing not found" };
  if (!r.ok || r.status === null) return { ...base, outcome: "unreachable", httpStatus: r.status, missing: [] };
  let j: { state?: string; price?: { amount: number; divisor: number; currency_code?: string } };
  try { j = JSON.parse(r.text); } catch { return { ...base, outcome: "unreachable", httpStatus: r.status, missing: [], note: "unparseable API response" }; }
  if (j.state && j.state !== "active") return { ...base, outcome: "dead", httpStatus: r.status, missing: src.expect ?? [], note: `listing state ${j.state}` };
  const price = j.price ? (j.price.amount / j.price.divisor).toFixed(2) : null;
  // Expected prices are USD figures. A listing priced in another currency is not compared (QA-019 I2-1): neither confirmed nor mismatched.
  const currency = j.price?.currency_code?.toUpperCase();
  const comparable = !currency || currency === "USD";
  const prices = comparable ? (src.expect ?? []).filter((e) => PRICE.test(e)) : [];
  const missing = prices.filter((e) => e.replace("$", "") !== price);
  const unchecked = (src.expect ?? []).filter((e) => !prices.includes(e));
  return { ...base, outcome: !prices.length ? "reachable" : missing.length ? "mismatch" : "confirmed", httpStatus: r.status, missing,
    note: [price ? `price ${price}${currency && !comparable ? ` ${currency} (not compared with USD figures)` : ""}` : null, unchecked.length ? `not checkable via API: ${unchecked.join(", ")}` : null].filter(Boolean).join("; ") || undefined };
}
