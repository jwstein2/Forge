import { describe, expect, it, beforeAll } from "vitest";
import { authenticate, verifyAccessJwt, AuthError } from "../src/lib/auth.ts";
import type { Env } from "../src/lib/env.ts";

const TEAM = "https://forge-team.cloudflareaccess.com";
const AUD = "aud-tag-123";
let keys: CryptoKeyPair; let jwk: JsonWebKey & { kid: string };
const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
async function sign(payload: Record<string, unknown>, kid = "k1", key = keys.privateKey) {
  const h = b64u(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })); const p = b64u(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64u(sig)}`;
}
const env = (over: Partial<Env> = {}): Env => ({ DB: {} as D1Database, ENVIRONMENT: "staging", OWNER_EMAILS: "james@example.com", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...over });
const fetcher = async () => ({ keys: [jwk] });
const now = Math.floor(Date.now() / 1000);
const good = () => ({ aud: [AUD], iss: TEAM, email: "James@Example.com", exp: now + 600, iat: now });

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  jwk = { ...((await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey), kid: "k1" };
});

describe("Cloudflare Access JWT verification", () => {
  it("accepts a valid owner token", async () => {
    expect(await verifyAccessJwt(await sign(good()), env(), fetcher)).toBe("james@example.com");
  });
  it.each([
    ["wrong audience", { aud: ["other"] }],
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["expired", { exp: now - 10 }],
  ])("rejects %s", async (_n, over) => {
    await expect(verifyAccessJwt(await sign({ ...good(), ...over }), env(), fetcher)).rejects.toBeInstanceOf(AuthError);
  });
  it("rejects a non-owner with 403", async () => {
    await expect(verifyAccessJwt(await sign({ ...good(), email: "someone@else.com" }), env(), fetcher)).rejects.toMatchObject({ status: 403 });
  });
  it("rejects a token signed by another key", async () => {
    const other = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    await expect(verifyAccessJwt(await sign(good(), "k1", other.privateKey), env(), fetcher)).rejects.toThrow(/signature/);
  });
  it("rejects a tampered payload", async () => {
    const t = (await sign(good())).split(".");
    const forged = `${t[0]}.${b64u(JSON.stringify({ ...good(), email: "james@example.com", exp: now + 99999 }))}.${t[2]}`;
    await expect(verifyAccessJwt(forged, env(), fetcher)).rejects.toThrow(/signature/);
  });
});

describe("development token", () => {
  const req = (h: Record<string, string>) => new Request("http://x/", { headers: h });
  it("works only in development/test", async () => {
    const token = "a".repeat(32);
    await expect(authenticate(req({ "x-forge-dev-token": token }), env({ ENVIRONMENT: "development", DEV_AUTH_TOKEN: token }))).resolves.toMatchObject({ authMethod: "dev" });
    await expect(authenticate(req({ "x-forge-dev-token": token }), env({ ENVIRONMENT: "staging", DEV_AUTH_TOKEN: token }))).rejects.toThrow(/disabled/);
    await expect(authenticate(req({ "x-forge-dev-token": token }), env({ ENVIRONMENT: "production", DEV_AUTH_TOKEN: token }))).rejects.toThrow(/disabled/);
  });
  it("requires some credential", async () => {
    await expect(authenticate(req({}), env())).rejects.toThrow(/required/);
  });
});
