import { describe, expect, it } from "vitest";
import { apiSecurityHeaders, auditHeaders, inlineHandlers, inlineScriptHashes, pagesHeadersFile, secureHeaders, siteCsp } from "../src/security/headers.ts";
import { hmacHex, ReplayGuard, sign, verify } from "../src/security/signing.ts";
import { scanText, sensitiveFile, fingerprint } from "../src/security/leak-scan.ts";
import { createHash } from "node:crypto";

const SECRET = "a".repeat(8) + "b".repeat(8) + "c".repeat(8) + "d".repeat(8) + "e";

describe("security headers", () => {
  it("API headers pass the audit; a bare response fails it", () => {
    expect(auditHeaders(apiSecurityHeaders(), "api")).toEqual({ ok: true, missing: [], weak: [] });
    const bare = auditHeaders(new Headers({ "access-control-allow-origin": "*" }), "api");
    expect(bare.ok).toBe(false);
    expect(bare.missing).toContain("content-security-policy");
    expect(bare.weak).toContain("API allows any origin");
  });
  it("middleware adds headers without overriding route-specific ones", async () => {
    const c = { res: { headers: new Headers({ "cache-control": "public, max-age=60" }) } };
    await secureHeaders()(c, async () => {});
    expect(c.res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(c.res.headers.get("cache-control")).toBe("public, max-age=60");
  });
  it("site CSP: no unsafe-inline scripts, hashes allowed, only chosen third parties", () => {
    const html = `<script>window.x=1</script><script src="/js/track.js" defer></script><script type="application/ld+json">{"a":1}</script><button onclick="go()">`;
    const hashes = inlineScriptHashes(html);
    expect(hashes).toEqual([`sha256-${createHash("sha256").update("window.x=1").digest("base64")}`]);
    expect(inlineHandlers(html)).toEqual(["onclick"]);
    const csp = siteCsp({ site: "quilt-plan-kit", beaconOrigin: "https://quiltplankit-sales.sales-webhook.workers.dev", thirdParties: ["lemonSqueezy", "mailerLite"], inlineScriptHashes: hashes });
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("https://assets.lemonsqueezy.com");
    expect(csp).toContain("connect-src 'self' https://quiltplankit-sales.sales-webhook.workers.dev");
    expect(csp).not.toContain("pinimg");
    expect(csp).toContain("frame-ancestors 'none'");
  });
  it("_headers file lets embed pages be framed and everything else not", () => {
    const f = pagesHeadersFile({ site: "quilt-plan-kit", beaconOrigin: "https://w.example", thirdParties: ["cloudflareAnalytics"], embedPaths: ["/embed/*"] });
    expect(f).toMatch(/^\/\*$/m);
    expect(f).toContain("X-Frame-Options: DENY");
    expect(f).toContain("/embed/*\n  ! X-Frame-Options");
    expect(f).toContain("frame-ancestors *");
    const audit = auditHeaders(Object.fromEntries(f.split("\n").filter((l) => /^  [A-Z]/.test(l)).slice(0, 7).map((l) => l.trim().split(/: (.*)/s).slice(0, 2) as [string, string])), "site");
    expect(audit.missing).toEqual([]);
  });
});

describe("signed calls with replay window", () => {
  const body = JSON.stringify({ registryId: "job_x", externalId: "run-1", status: "success" });
  it("round-trips v2 and rejects tampering, staleness and short secrets", async () => {
    const h = await sign(SECRET, body, 1_800_000_000);
    expect(await verify({ secrets: [SECRET], rawBody: body, signature: h["x-forge-signature"], timestamp: h["x-forge-timestamp"], nowSec: 1_800_000_100 })).toEqual({ ok: true, scheme: "v2" });
    expect(await verify({ secrets: [SECRET], rawBody: body + " ", signature: h["x-forge-signature"], timestamp: h["x-forge-timestamp"], nowSec: 1_800_000_100 })).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(await verify({ secrets: [SECRET], rawBody: body, signature: h["x-forge-signature"], timestamp: h["x-forge-timestamp"], nowSec: 1_800_000_301 })).toMatchObject({ ok: false, reason: "stale" });
    // moving the timestamp forward breaks the MAC
    expect(await verify({ secrets: [SECRET], rawBody: body, signature: h["x-forge-signature"], timestamp: "1800000200", nowSec: 1_800_000_200 })).toMatchObject({ ok: false, reason: "bad_signature" });
    await expect(sign("short", body)).rejects.toThrow();
    expect(await verify({ secrets: ["short"], rawBody: body, signature: h["x-forge-signature"], timestamp: h["x-forge-timestamp"] })).toMatchObject({ reason: "not_configured" });
  });
  it("supports secret rotation (old and new both accepted) and v1 only when allowed", async () => {
    const NEW = SECRET.replace(/a/g, "z");
    const h = await sign(SECRET, body, 1_800_000_000);
    expect((await verify({ secrets: [NEW, SECRET], rawBody: body, signature: h["x-forge-signature"], timestamp: h["x-forge-timestamp"], nowSec: 1_800_000_000 })).ok).toBe(true);
    const v1 = await hmacHex(SECRET, body);
    expect(await verify({ secrets: [SECRET], rawBody: body, signature: v1, timestamp: null })).toMatchObject({ reason: "v1_disallowed" });
    expect(await verify({ secrets: [SECRET], rawBody: body, signature: v1, timestamp: null, allowV1: true })).toEqual({ ok: true, scheme: "v1" });
  });
  it("replay guard rejects repeats inside the window and forgets after it", () => {
    const g = new ReplayGuard(300);
    expect(g.accept("run-1", 1000)).toBe(true);
    expect(g.accept("run-1", 1100)).toBe(false);
    expect(g.accept("run-1", 1000 + 601)).toBe(true);
  });
});

describe("secret scanner", () => {
  // Built at runtime so this file never contains a literal token.
  const fake = (prefix: string, n: number) => prefix + "Q7x9Lm2Pz4Rt8Kw1".repeat(8).slice(0, n);
  it.each([
    ["anthropic", `const k = "${fake("sk-ant-api03-", 40)}"`],
    ["github", `token: ${fake("ghp_", 36)}`],
    ["jwt", `LS=${"eyJ" + fake("", 20)}.${"eyJ" + fake("", 20)}.${fake("", 30)}`],
    ["named-env", `LEMONSQUEEZY_API_KEY=${fake("", 24)}`],
    ["url-credentials", `https://admin:${fake("", 12)}@example.com/x`],
    ["n8n-webhook", `fetch("https://james1854.app.n8n.cloud/webhook/qpk-sale-abc")`],
    ["assigned-literal", `password = "${fake("", 20)}"`],
  ])("detects %s without printing it", (rule, text) => {
    const hits = scanText("x.ts", text);
    expect(hits.map((h) => h.rule)).toContain(rule);
    for (const h of hits) expect(text.includes(h.preview.replace(/….*$/, "")) && h.preview.length < 30).toBe(true);
  });
  it("ignores placeholders and low-entropy literals, honours the fingerprint allowlist", () => {
    expect(scanText("x", `api_key = "<your-api-key-here-xxxx>"`)).toEqual([]);
    expect(scanText("x", `password = "aaaaaaaaaaaaaaaaaaaa"`)).toEqual([]);
    const t = `LEMONSQUEEZY_API_KEY=${fake("", 24)}`;
    expect(scanText("x", t, new Set([fingerprint(fake("", 24))]))).toEqual([]);
  });
  it("flags sensitive file names", () => {
    expect(sensitiveFile(".dev.vars")).toBeTruthy();
    expect(sensitiveFile("services/api/.env.production")).toBeTruthy();
    expect(sensitiveFile("export/vault.1pux")).toBeTruthy();
    expect(sensitiveFile("C:\\x\\credentials.json")).toBeTruthy();
    expect(sensitiveFile("docs/controls/SECRETS_POLICY.md")).toBeNull();
  });
});
