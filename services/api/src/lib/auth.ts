/**
 * Owner authentication.
 *
 * Staging/production: the app sits behind Cloudflare Access (free tier, owner's identity provider).
 * Access injects a signed JWT in `Cf-Access-Jwt-Assertion`; we verify signature (RS256, team JWKS),
 * issuer, audience and expiry, then require the email to be on OWNER_EMAILS. Defense in depth: the
 * Worker never trusts the Access email header alone.
 *
 * Development/test only: `x-forge-dev-token` equal to DEV_AUTH_TOKEN. Refused in any other environment.
 */
import type { Me } from "@forge/contracts";
import type { Env } from "./env.ts";
import { timingSafeEqualHex } from "./util.ts";

export type JwksFetcher = (url: string) => Promise<{ keys: (JsonWebKey & { kid?: string })[] }>;
const defaultFetcher: JwksFetcher = async (url) => (await fetch(url)).json();

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const b64urlJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

export class AuthError extends Error {
  status: 401 | 403;
  constructor(message: string, status: 401 | 403 = 401) { super(message); this.status = status; }
}

function owners(env: Env): string[] {
  return (env.OWNER_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export async function verifyAccessJwt(token: string, env: Env, fetcher: JwksFetcher = defaultFetcher, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new AuthError("access not configured");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("malformed token");
  const [h, p, sig] = parts as [string, string, string];
  const header = b64urlJson(h); const payload = b64urlJson(p);
  if (header.alg !== "RS256") throw new AuthError("unexpected alg");
  const team = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "");
  const { keys } = await fetcher(`${team}/cdn-cgi/access/certs`);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new AuthError("unknown signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new AuthError("bad signature");
  const aud: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new AuthError("wrong audience");
  if (payload.iss !== team) throw new AuthError("wrong issuer");
  if (typeof payload.exp !== "number" || payload.exp < nowSec) throw new AuthError("expired");
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 60) throw new AuthError("not yet valid");
  const email = String(payload.email || "").toLowerCase();
  if (!owners(env).includes(email)) throw new AuthError("not an owner", 403);
  return email;
}

export async function authenticate(req: Request, env: Env, fetcher?: JwksFetcher): Promise<Me> {
  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (jwt) return { email: await verifyAccessJwt(jwt, env, fetcher), role: "owner", authMethod: "cloudflare_access" };
  const dev = req.headers.get("x-forge-dev-token");
  if (dev) {
    if (env.ENVIRONMENT !== "development" && env.ENVIRONMENT !== "test") throw new AuthError("dev auth disabled in this environment");
    if (!env.DEV_AUTH_TOKEN || env.DEV_AUTH_TOKEN.length < 16) throw new AuthError("dev auth not configured");
    if (!timingSafeEqualHex(dev, env.DEV_AUTH_TOKEN)) throw new AuthError("bad dev token");
    const email = owners(env)[0];
    if (!email) throw new AuthError("no owner configured", 403);
    return { email, role: "owner", authMethod: "dev" };
  }
  throw new AuthError("authentication required");
}
