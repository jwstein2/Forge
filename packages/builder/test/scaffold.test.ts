import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { generateBlueprint } from "../src/generate.ts";
import { checkBrand, type Brand } from "../src/site/brand.ts";
import { ScaffoldRefused, scaffoldSite, type SiteConfig } from "../src/site/scaffold.ts";
import { NICHES, clone, loadBrief, registryProducts } from "./helpers.ts";

const brand = (n: string): Brand => JSON.parse(readFileSync(join(import.meta.dirname, "..", "brands", `${n}.brand.json`), "utf8"));
const cfg = (n: string, operator = true): SiteConfig => ({
  operator: operator ? { name: "Test Operator", state: "Minnesota", contact: "owner@example.test" } : null,
  legalDate: "2026-11-10", liveSiteUrl: `https://${n}.example.test`,
  runtime: { checkout: { mode: "off", urls: {} }, email: { action: null }, beacon: { url: null, hosts: [], site: n } },
});
const build = async (n: string, operator = true) => {
  const bp = await generateBlueprint(loadBrief(n), { registryProducts: registryProducts() });
  return { bp, r: await scaffoldSite(bp, brand(n), cfg(n, operator)) };
};
const r0css = readFileSync(join(import.meta.dirname, "..", "src", "site", "brand.ts"), "utf8");
const html = (files: Record<string, string | Uint8Array>) => Object.entries(files).filter(([p]) => p.endsWith(".html")) as [string, string][];
const visibleText = (h: string) => h.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

describe("site scaffold generator", () => {
  for (const n of NICHES) {
    it(`${n}: every page is a noindex staging page with no inline script or style`, async () => {
      const { r, bp } = await build(n);
      expect(html(r.files).length).toBe(bp.page_map.length);
      for (const [p, h] of html(r.files)) {
        expect(h, p).toContain('<meta name="robots" content="noindex, nofollow">');
        expect(h, p).toContain("Staging preview built from blueprint");
        expect(h, p).not.toMatch(/<script>(?!<\/script>)|<script(?![^>]*\bsrc=)[^>]*>|\sstyle=|\son[a-z]+=/i);
      }
      expect(r.files["robots.txt"]).toContain("Disallow: /");
      expect(r.files["_headers"]).toContain("X-Robots-Tag: noindex");
    });

    it(`${n}: every internal link resolves to a generated file`, async () => {
      const { r } = await build(n);
      for (const [p, h] of html(r.files)) for (const m of h.matchAll(/(?:href|src)="(\/[^"#?]*)"/g)) {
        const t = m[1]!.endsWith("/") ? `${m[1]!.slice(1)}index.html` : m[1]!.slice(1);
        expect(r.files[t], `${p} -> ${m[1]}`).toBeDefined();
      }
    });

    it(`${n}: invents no figures (every number on a page is in the blueprint, brand or config)`, async () => {
      const { r, bp } = await build(n);
      const known = JSON.stringify(bp) + JSON.stringify(brand(n)) + JSON.stringify(cfg(n)) + " 14 2026-11-10 ";
      for (const [p, h] of html(r.files)) for (const num of visibleText(h).match(/\d[\d,.]*\d|\d/g) ?? []) {
        expect(known.includes(num.replace(/,/g, "")) || known.includes(num), `${p}: "${num}"`).toBe(true);
      }
    });

    it(`${n}: no social proof, ratings or stock imagery; strategy text never shown`, async () => {
      const { r, bp } = await build(n);
      for (const [p, h] of html(r.files)) {
        const t = visibleText(h);
        expect(t, p).not.toMatch(/testimonial|★|\b\d+ (happy )?(customers|users|buyers)|rated \d|as seen in|trusted by/i);
        expect(h, p).not.toMatch(/<img|unsplash|shutterstock|istock/i);
        expect(t, p).not.toContain(bp.positioning.one_line);
      }
    });

    it(`${n}: checkout and signup are disconnected; legal pages name the operator`, async () => {
      const { r } = await build(n);
      for (const [, h] of html(r.files)) for (const a of h.match(/<a [^>]*data-checkout[^>]*>/g) ?? []) expect(a).not.toMatch(/href=/);
      expect(r.files["assets/forge-config.js"]).toContain('"mode": "off"');
      for (const p of ["privacy/index.html", "terms/index.html", "refunds/index.html"]) {
        expect(r.files[p]).toContain("Test Operator, Minnesota");
        expect(r.files[p]).toMatch(/Last updated 2026-11-10/);
      }
      expect(r.files["terms/index.html"]).toContain("laws of the State of Minnesota");
    });

    it(`${n}: manifest hashes match the files, it is not deployable, and every gate is NOT_RUN`, async () => {
      const { r } = await build(n);
      expect(r.manifest.deployable_to_production).toBe(false);
      expect(r.manifest.gates.every((g) => g.result === "NOT_RUN")).toBe(true);
      // QA-009 S1: hashes are of the raw bytes, so `sha256sum` on the written files matches.
      for (const f of r.manifest.files) expect(createHash("sha256").update(r.files[f.path]!).digest("hex"), f.path).toBe(f.sha256);
      expect(r.manifest.copy_gaps).toBe(r.copyGaps.length);
      expect((r.files["COPY_GAPS.md"] as string).split("\n").filter((l: string) => l.startsWith("| `")).length).toBe(r.copyGaps.length);
    });

    it(`${n}: brand passes WCAG AA contrast checks`, () => expect(checkBrand(brand(n))).toEqual([]));
  }

  it("QA-009 S4: staging banner is inside a landmark; CSP allows only configured origins", async () => {
    const { r } = await build("bidline");
    expect(r.files["index.html"]).toMatch(/<aside class="staging" aria-label="Staging notice">/);
    expect(r.files["_headers"]).toContain("connect-src 'self'; form-action 'self';");
    const bp = await generateBlueprint(loadBrief("bidline"));
    const c = cfg("bidline"); c.runtime.email.action = "https://forms.example.test/sub"; c.runtime.beacon.url = "https://beacon.example.test/e";
    const r2 = await scaffoldSite(bp, brand("bidline"), c);
    expect(r2.files["_headers"]).toContain("connect-src 'self' https://beacon.example.test; form-action 'self' https://forms.example.test;");
  });

  it("QA-009 S2: signup fields can shrink to the viewport", () => {
    expect(r0css).toContain("flex:1 1 min(16rem,100%);min-width:0");
    expect(r0css).toMatch(/input\[type=email\]\{width:100%/);
  });

  it("V2: the three brands carry the owner's V2 tokens and layout system", () => {
    const v2: Record<string, [string, string, string]> = { bidline: ["#F5F7F6", "#183C4A", "#E7A342"], "quilt-plan-kit": ["#FFF9F3", "#925B68", "#DB9B72"], "loaf-ledger": ["#FCF5EA", "#7D5539", "#D69B58"] };
    for (const [n, [paper, primary, gold]] of Object.entries(v2)) {
      const b = brand(n);
      expect([b.colors.bg, b.colors.accent, b.colors.gold]).toEqual([paper, primary, gold]);
      expect(b.layout).toMatchObject({ card_radius_px: 22, button_radius_px: 14, container_px: 1160 });
    }
    expect(brand("bidline").layout!.hero).toBe("dark-grid");
  });

  it("V2: signup is omitted until a form action is configured, then rendered", async () => {
    const { r, bp } = await build("quilt-plan-kit");
    expect(r.files["index.html"]).not.toContain("data-signup");
    const c = cfg("quilt-plan-kit"); c.runtime.email.action = "https://forms.example.test/sub";
    const r2 = await scaffoldSite(bp, brand("quilt-plan-kit"), c);
    expect(r2.files["index.html"]).toContain("data-signup");
  });

  it("V2: the hero has at most one button and links to the product page, not checkout", async () => {
    for (const n of NICHES) {
      const { r } = await build(n);
      const hero = (r.files["index.html"] as string).match(/<section class="hero">[\s\S]*?<\/section>/)![0];
      expect((hero.match(/class="btn/g) ?? []).length).toBeLessThanOrEqual(1);
      expect(hero).not.toContain("data-checkout");
    }
  });

  it("is deterministic", async () => {
    const a = await build("bidline"); const b = await build("bidline");
    expect(a.r.files).toEqual(b.r.files);
  });

  it("without an operator, legal pages show copy gaps and G7 is named as blocked", async () => {
    const { r } = await build("loaf-ledger", false);
    expect(r.files["privacy/index.html"]).toContain("Operator name, state and contact email (required for G7).");
    expect(r.files["GATES.md"]).toContain("operator name, state and contact are not configured");
  });

  it("writes a product draft per product that reuses existing registry products", async () => {
    const { r, bp } = await build("quilt-plan-kit");
    for (const p of bp.products) expect(r.files[`_drafts/${p.product_id}/PRODUCT_DRAFT.md`]).toContain("status **PROPOSED**");
    expect(r.files["_drafts/prd_quilt-plan-kit_the-quilt-planner-printable-pdf/PRODUCT_DRAFT.md"]).toContain("Builds on existing registry product `prd_qpk_planner`");
  });

  it("refuses live checkout, a mismatched brand, and an inaccessible palette", async () => {
    const bp = await generateBlueprint(loadBrief("bidline"));
    const live = clone(cfg("bidline")) as any; live.runtime.checkout.mode = "live";
    await expect(scaffoldSite(bp, brand("bidline"), live)).rejects.toBeInstanceOf(ScaffoldRefused);
    await expect(scaffoldSite(bp, brand("loaf-ledger"), cfg("bidline"))).rejects.toThrow(/brand is for loaf-ledger/);
    const grey = clone(brand("bidline")); grey.colors.muted = "#BBBBBB";
    await expect(scaffoldSite(bp, grey, cfg("bidline"))).rejects.toThrow(/contrast/);
  });

  it("the picture never repeats the promise", async () => {
    for (const n of NICHES) {
      const bp = await generateBlueprint(loadBrief(n));
      if (bp.sales_framework.picture.draft) expect(bp.sales_framework.picture.draft).not.toBe(bp.sales_framework.promise.draft);
    }
  });
});
