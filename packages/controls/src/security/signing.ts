/**
 * Signed machine-to-machine calls (gate G6/G12; audit H1 "unauthenticated n8n webhook").
 *
 * v2 scheme for FORGE heartbeats and internal webhooks:
 *   X-Forge-Timestamp: unix seconds
 *   X-Forge-Signature: v2=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
 * The timestamp is inside the MAC, and receivers reject anything outside a ±5 minute window, so a captured
 * request cannot be replayed later. Receivers also dedupe on a required externalId within the window.
 * v1 (body-only HMAC, used by the live sales Worker → n8n forward today) stays verifiable for migration.
 */
const enc = new TextEncoder();

export async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const MIN_SECRET_LENGTH = 32;
export const WINDOW_SECONDS = 300;

export async function sign(secret: string, rawBody: string, nowSec = Math.floor(Date.now() / 1000)): Promise<{ "x-forge-timestamp": string; "x-forge-signature": string }> {
  if (!secret || secret.length < MIN_SECRET_LENGTH) throw new Error(`signing secret must be at least ${MIN_SECRET_LENGTH} characters`);
  const ts = String(nowSec);
  return { "x-forge-timestamp": ts, "x-forge-signature": `v2=${await hmacHex(secret, `${ts}.${rawBody}`)}` };
}

export type VerifyResult = { ok: true; scheme: "v1" | "v2" } | { ok: false; reason: "not_configured" | "malformed" | "stale" | "bad_signature" | "v1_disallowed" };

export async function verify(opts: {
  secrets: string[]; rawBody: string; signature: string | null; timestamp: string | null;
  nowSec?: number; windowSec?: number; allowV1?: boolean;
}): Promise<VerifyResult> {
  const secrets = opts.secrets.map((s) => s.trim()).filter((s) => s.length >= MIN_SECRET_LENGTH);
  if (!secrets.length) return { ok: false, reason: "not_configured" };
  const sig = (opts.signature ?? "").trim().toLowerCase();
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (sig.startsWith("v2=")) {
    const hex = sig.slice(3);
    if (!/^[0-9a-f]{64}$/.test(hex) || !/^\d{9,11}$/.test(opts.timestamp ?? "")) return { ok: false, reason: "malformed" };
    if (Math.abs(now - Number(opts.timestamp)) > (opts.windowSec ?? WINDOW_SECONDS)) return { ok: false, reason: "stale" };
    for (const s of secrets) if (constantTimeEqual(hex, await hmacHex(s, `${opts.timestamp}.${opts.rawBody}`))) return { ok: true, scheme: "v2" };
    return { ok: false, reason: "bad_signature" };
  }
  if (/^[0-9a-f]{64}$/.test(sig)) {
    if (!opts.allowV1) return { ok: false, reason: "v1_disallowed" };
    for (const s of secrets) if (constantTimeEqual(sig, await hmacHex(s, opts.rawBody))) return { ok: true, scheme: "v1" };
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: false, reason: "malformed" };
}

/** Bounded in-memory replay guard for a single receiver instance (D1-backed dedupe is preferred where available). */
export class ReplayGuard {
  private seen = new Map<string, number>();
  private readonly windowSec: number;
  private readonly max: number;
  constructor(windowSec = WINDOW_SECONDS, max = 10000) {
    this.windowSec = windowSec;
    this.max = max;
  }
  /** Returns false if this id was already accepted inside the window. */
  accept(id: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
    const cutoff = nowSec - 2 * this.windowSec;
    for (const [k, t] of this.seen) { if (t < cutoff) this.seen.delete(k); else break; }
    if (this.seen.has(id)) return false;
    if (this.seen.size >= this.max) this.seen.delete(this.seen.keys().next().value!);
    this.seen.set(id, nowSec);
    return true;
  }
}
