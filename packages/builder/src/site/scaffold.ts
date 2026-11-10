/**
 * Site scaffold generator: Launch Blueprint + brand tokens + site config -> a static staging site (files in memory).
 *
 * Honesty rules, enforced here and by tests:
 *  - Visible text comes only from the blueprint (which is traced to the brief), the brand, or the operator config.
 *    Anything else a page needs is a visible "Copy needed" marker, collected into COPY_GAPS.md for the website stage (G2).
 *  - No testimonials, ratings, counts, results or stock imagery. Product previews are placeholders until rendered from real files.
 *  - Staging only: every page carries a staging banner and noindex; robots.txt disallows all; checkout is off or test mode.
 *  - The internal positioning statement is strategy, not customer copy, so it is never rendered.
 */
import type { LaunchBlueprint, PageSpec, ProductSpec } from "../types.ts";
import { contentHash } from "../hash.ts";
import { brandCss, checkBrand, type Brand } from "./brand.ts";
import { COMPONENTS_JS, runtimeConfigJs, type SiteRuntimeConfig } from "./components.ts";

export interface Operator { name: string; state: string; contact: string }
export interface SiteConfig {
  operator: Operator | null;          // legal pages show copy gaps until this is set (G7 cannot pass without it)
  legalDate: string;                  // YYYY-MM-DD shown as "Last updated"
  liveSiteUrl: string | null;         // existing free tools live here; staging links to them instead of copying them
  runtime: SiteRuntimeConfig;
}
export interface ScaffoldResult { files: Record<string, string>; copyGaps: { page: string; gap: string }[]; manifest: StagingManifest }
export interface StagingManifest {
  kind: "forge-staging-site"; implementation_status: "BUILT"; deployable_to_production: false;
  blueprint_id: string; blueprint_version: string; blueprint_hash: string; brand: { niche: string; version: string; status: string };
  generated_at: string; generator: string; pages: string[]; copy_gaps: number;
  gates: { gate: string; result: "NOT_RUN"; scope: string }[];
  files: { path: string; sha256: string }[];
}

export class ScaffoldRefused extends Error {}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (v: number | null) => (v == null ? null : `$${v % 1 ? v.toFixed(2) : v}`);
const outPath = (p: string) => (p.endsWith("/") ? `${p.slice(1)}index.html` : p.slice(1));

export async function scaffoldSite(bp: LaunchBlueprint, brand: Brand, cfg: SiteConfig, opts: { generatedAt?: string } = {}): Promise<ScaffoldResult> {
  if (brand.niche !== bp.niche) throw new ScaffoldRefused(`brand is for ${brand.niche}, blueprint is for ${bp.niche}`);
  const problems = checkBrand(brand);
  if (problems.length) throw new ScaffoldRefused(`brand fails accessibility checks: ${problems.join("; ")}`);
  if (cfg.runtime.checkout.mode !== "off" && cfg.runtime.checkout.mode !== "test") throw new ScaffoldRefused("staging checkout must be off or test");

  const gaps: { page: string; gap: string }[] = [];
  const sf = bp.sales_framework;
  const core = bp.products.find((p) => p.product_id === sf.cta.product_id) ?? null;
  const name = bp.display_name;
  const nav = bp.page_map.filter((p) => ["home", "resource", "product", "book"].includes(p.template) && p.required_for_launch)
    .concat(bp.page_map.filter((p) => p.path === "/about/"));

  const files: Record<string, string> = {};

  for (const page of bp.page_map) {
    const gap = (text: string) => { gaps.push({ page: page.path, gap: text }); return `<p class="copy-gap">${esc(text)}</p>`; };
    const product = page.template === "product" || page.template === "book"
      ? bp.products.find((p) => page.purpose.endsWith(p.name)) ?? null : null;
    const body = renderPage(page, { bp, product, core, cfg, gap });
    files[outPath(page.path)] = layout({ bp, page, nav, title: pageTitle(page, product, name), body });
  }

  files["assets/site.css"] = brandCss(brand);
  files["assets/forge.js"] = COMPONENTS_JS;
  files["assets/forge-config.js"] = runtimeConfigJs(cfg.runtime);
  files["robots.txt"] = "# Staging preview: not for indexing\nUser-agent: *\nDisallow: /\n";
  files["_headers"] = `/*\n  X-Robots-Tag: noindex, nofollow\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https:; form-action 'self' https:; frame-ancestors 'none'; base-uri 'self'\n`;
  files["SOURCES_AND_LICENSES.md"] = `# Sources and licences: ${name} staging build\n\nNo images, webfonts, icons, video or third-party text are used. Fonts are system font stacks installed on the visitor's device; no font files are shipped. Decorative motifs are CSS gradients.\n\nAdd a row here for every asset before it ships (G8): asset, source URL, author, licence, commercial use, attribution, date, destination. Unknown provenance is a FAIL.\n\n| Asset | Source | Author | Licence | Commercial use | Attribution | Date | Used on |\n|---|---|---|---|---|---|---|---|\n`;

  for (const p of bp.products) files[`_drafts/${p.product_id}/PRODUCT_DRAFT.md`] = productDraft(p, bp);

  files["COPY_GAPS.md"] = `# Copy gaps: ${name} staging build\n\nWritten at the website stage and reviewed under G2. Each marker is visible on the page as "Copy needed".\n\n| Page | What is needed |\n|---|---|\n${gaps.map((g) => `| \`${g.page}\` | ${g.gap.replace(/\|/g, "\\|")} |`).join("\n")}\n`;

  const gates = [
    ...["G1", "G2", "G3", "G8", "G9", "G12", "G15"].map((g) => ({ gate: g, result: "NOT_RUN" as const, scope: "website stage, rendered staging pages" })),
    ...["G5", "G6", "G7"].map((g) => ({ gate: g, result: "NOT_RUN" as const, scope: "integrations stage (checkout, ledger, legal)" })),
  ];
  files["GATES.md"] = `# Gate checklist: ${name} staging build\n\nNothing here has been independently reviewed. Results are recorded as gate receipts (release id \`<buildId>:<stage>\`), never edited here.\n\n| Gate | Result | Scope |\n|---|---|---|\n${gates.map((g) => `| ${g.gate} | ${g.result} | ${g.scope} |`).join("\n")}\n\nKnown blockers before G7 can pass: ${cfg.operator ? "none from the scaffold" : "operator name, state and contact are not configured"}.\n`;

  const sorted = Object.keys(files).sort();
  const manifest: StagingManifest = {
    kind: "forge-staging-site", implementation_status: "BUILT", deployable_to_production: false,
    blueprint_id: bp.blueprint_id, blueprint_version: bp.version, blueprint_hash: await contentHash(bp),
    brand: { niche: brand.niche, version: brand.version, status: brand.status },
    generated_at: opts.generatedAt ?? bp.created_at, generator: "@forge/builder site scaffold 1.0.0",
    pages: bp.page_map.map((p) => p.path), copy_gaps: gaps.length, gates,
    files: await Promise.all(sorted.map(async (path) => ({ path, sha256: (await contentHash(files[path])).slice(7) }))),
  };
  files["STAGING_MANIFEST.json"] = JSON.stringify(manifest, null, 2) + "\n";
  return { files, copyGaps: gaps, manifest };
}

function pageTitle(page: PageSpec, product: ProductSpec | null, name: string): string {
  if (page.path === "/") return name;
  if (product) return `${product.name} | ${name}`;
  const t: Record<string, string> = { "/tools/": "Free tools", "/thank-you/": "Thank you", "/about/": "About", "/contact/": "Contact", "/privacy/": "Privacy", "/terms/": "Terms", "/refunds/": "Refund policy" };
  return `${t[page.path] ?? page.purpose} | ${name}`;
}

function layout(a: { bp: LaunchBlueprint; page: PageSpec; nav: PageSpec[]; title: string; body: string }): string {
  const label = (p: PageSpec) => p.path === "/" ? "Home" : p.path === "/tools/" ? "Free tools" : p.path === "/about/" ? "About" : a.bp.products.find((x) => p.purpose.endsWith(x.name))?.name ?? p.purpose;
  const navHtml = a.nav.map((p) => `<li><a href="${p.path}"${p.path === a.page.path ? ' aria-current="page"' : ""}>${esc(label(p))}</a></li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(a.title)}</title>
<link rel="stylesheet" href="/assets/site.css">
<script src="/assets/forge-config.js" defer></script>
<script src="/assets/forge.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="staging" role="note">Staging preview built from blueprint ${esc(a.bp.blueprint_id)}. Not live, not indexed. Draft text is marked; checkout and signup are not connected.</div>
<header class="site"><a class="brand" href="/">${esc(a.bp.display_name)}</a><nav aria-label="Main"><ul>${navHtml}</ul></nav></header>
<div class="motif" aria-hidden="true"></div>
<main id="main">
${a.body}
</main>
<footer class="site"><ul><li><a href="/about/">About</a></li><li><a href="/contact/">Contact</a></li><li><a href="/privacy/">Privacy</a></li><li><a href="/terms/">Terms</a></li><li><a href="/refunds/">Refunds</a></li></ul></footer>
</body>
</html>
`;
}

interface Ctx { bp: LaunchBlueprint; product: ProductSpec | null; core: ProductSpec | null; cfg: SiteConfig; gap: (t: string) => string }

function checkoutBlock(p: ProductSpec, label: string): string {
  const price = money(p.price.value);
  return `<div class="panel buy">${price ? `<p class="price">${price}</p>` : ""}<a class="btn" data-checkout="${esc(p.product_id)}" data-track="checkout_click" aria-disabled="true" role="link">${esc(label)}</a><span class="btn-note">Checkout is not connected on this staging preview.</span></div>`;
}

function section(name: string, c: Ctx): string {
  const { bp, gap } = c;
  const sf = bp.sales_framework;
  const p = c.product ?? c.core;
  switch (name) {
    case "promise": return `<section class="hero">${sf.promise.draft ? `<h1>${esc(sf.promise.draft)}</h1>` : `<h1>${esc(bp.display_name)}</h1>${gap("Headline promise: the brief has no desired outcome to ground it.")}`}${gap("One-sentence subheading that says who this is for and what they get, in customer language.")}</section>`;
    case "pain": return `<section><h2>${c.product ? "Why this exists" : "Sound familiar?"}</h2><ul class="ticks draft">${sf.pain.map((x) => `<li>${esc(x.statement)}</li>`).join("")}</ul>${gap("Rewrite these research statements in the customer's own words (sources are in the blueprint).")}</section>`;
    case "proof": return `<section><h2>See it before you buy</h2><div class="grid"><div class="preview">Preview rendered from the real product file goes here (products stage).</div><div class="preview">Worked example with clearly labelled sample data goes here.</div></div><p class="lede">No reviews or results are shown until real customers have given them.</p></section>`;
    case "plan": return `<section><h2>How it works</h2><ol class="plan">${sf.plan.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></section>`;
    case "picture": return `<section class="panel"><h2>What changes</h2>${sf.picture.draft ? `<p class="lede">${esc(sf.picture.draft)}</p>` : ""}${gap("Describe the after-picture concretely, without promising results.")}</section>`;
    case "free-tools": return `<section><h2>Free tools</h2><p><a href="/tools/">Use the free tools</a>${c.cfg.liveSiteUrl ? ` (they live on the current site)` : ""}.</p></section>`;
    case "paid-offer": return c.core ? `<section><h2>${esc(c.core.name)}</h2><div class="grid"><div><ul class="ticks">${c.core.must_include.slice(0, 5).map((m) => `<li>${esc(m)}</li>`).join("")}</ul><p><a href="${productPath(c.core)}">See what's inside</a></p></div>${checkoutBlock(c.core, sf.cta.label)}</div></section>` : "";
    case "email-capture": return `<section class="panel"><h2>Get new tools by email</h2>${gap("One line on what subscribers receive and how often.")}<form class="signup" data-signup><label>Email address<input type="email" name="email" autocomplete="email" required></label><button class="btn" type="submit">Sign up</button><p class="form-note btn-note">Email signup is not connected on this staging preview.</p></form></section>`;
    case "tool": return `<section><h1>Free tools</h1><p class="lede">${esc(bp.offer_ladder.find((t) => t.tier === "free")?.item ?? "Free resources")}</p>${c.cfg.liveSiteUrl ? `<p><a href="${esc(c.cfg.liveSiteUrl)}">Open the free tools on the current site</a>. They stay where they are; this staging build links to them rather than copying them.</p>` : gap("Free tools are not built yet for this business.")}</section>`;
    case "how-to-use": return `<section><h2>How to use them</h2>${gap("Short how-to for the most-used tool.")}</section>`;
    case "worked-example": return `<section><h2>A worked example</h2><div class="preview">Worked example with labelled sample inputs goes here.</div></section>`;
    case "related-resources": return "";
    case "paid-upgrade-cta": return c.core ? `<section class="panel"><h2>Need more than the free tools?</h2><p><a href="${productPath(c.core)}">${esc(c.core.name)}</a>${money(c.core.price.value) ? ` · ${money(c.core.price.value)}` : ""}</p></section>` : "";
    case "whats-inside-previews": return p ? `<section><h2>What's inside</h2>${p.must_include.length ? `<ul class="ticks">${p.must_include.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : gap(`Contents of ${p.name} (the blueprint has no spec yet).`)}<div class="grid"><div class="preview">Page or sheet preview from the real file.</div><div class="preview">Page or sheet preview from the real file.</div></div><p>Format: ${esc(p.format)}</p></section>` : "";
    case "price-and-cta": return p ? `<section><h2>Get it</h2>${checkoutBlock(p, `Get the ${p.name}`)}</section>` : "";
    case "faq-objections": return `<section><h2>Questions</h2>${sf.objections.map((o) => `<details><summary>${esc(o.claim.statement)}</summary>${gap(`Honest answer to: ${o.claim.statement}`)}</details>`).join("")}</section>`;
    case "refund-policy-link": return `<p><a href="/refunds/">Refund policy</a></p>`;
    case "amazon-link": return `<section>${gap("Amazon listing link: added by the owner once the KDP listing is confirmed live.")}</section>`;
    case "download-steps": return `<section><h1>Thank you</h1><ol class="plan"><li>Check your email for the download link from the checkout provider.</li><li>Download the file and save a copy.</li><li>Open the quick start first.</li></ol>${gap("Product-specific first step, matching the delivered file.")}</section>`;
    case "support-contact": return `<section><p>Problems with a file? <a href="/contact/">Contact us</a>.</p></section>`;
    case "operator": return `<section><h1>About ${esc(bp.display_name)}</h1>${c.cfg.operator ? `<p>${esc(bp.display_name)} is run by ${esc(c.cfg.operator.name)} in ${esc(c.cfg.operator.state)}.</p>` : gap("Who runs this site (real operator; no invented story).")}</section>`;
    case "mission": return `<section>${gap("Why this site exists and who it is for, in the operator's own words.")}</section>`;
    case "contact": return `<section><h1>Contact</h1>${c.cfg.operator ? `<p>Email <a href="mailto:${esc(c.cfg.operator.contact)}">${esc(c.cfg.operator.contact)}</a> about the tools or an order.</p>` : gap("Support email address.")}</section>`;
    case "disclosure": case "recommendations": return gap("Affiliate disclosure and recommendations (needs owner-approved programmes).");
    default: return gap(`Section "${name}" has no template yet.`);
  }
}

function productPath(p: ProductSpec): string {
  return `/products/${p.name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)}/`;
}

function renderPage(page: PageSpec, c: Ctx): string {
  if (page.template === "legal") return legal(page.path, c);
  if (page.template === "product" || page.template === "book") {
    const p = c.product;
    if (!p) return c.gap(`No product matches ${page.path}.`);
    const head = `<section class="hero"><h1>${esc(p.name)}</h1>${money(p.price.value) ? `<p class="price">${money(p.price.value)}</p>` : ""}${c.gap(`Product subheading for ${p.name}.`)}</section>`;
    return head + page.sections.filter((s) => s !== "promise").map((s) => section(s, c)).join("\n");
  }
  return page.sections.map((s) => section(s, c)).join("\n");
}

function legal(path: string, c: Ctx): string {
  const o = c.cfg.operator; const name = c.bp.display_name; const date = esc(c.cfg.legalDate);
  const who = o ? `<p>${esc(name)} is operated by ${esc(o.name)}, ${esc(o.state)}, United States. Contact: <a href="mailto:${esc(o.contact)}">${esc(o.contact)}</a>.</p>` : c.gap("Operator name, state and contact email (required for G7).");
  const has = (id: string) => c.bp.integrations.some((i) => i.id === id);
  if (path === "/privacy/") return `<article class="legal"><h1>Privacy</h1><p>Last updated ${date}</p>
<p>Calculators run in your browser; the numbers you enter are not sent to us or stored.</p>
<h2>Visit counts</h2><p>We keep anonymous daily totals of a few actions (a page view, a click through to checkout) by day, page and coarse traffic source. They use no cookies or browser storage, store no IP address or identifier, and are skipped when your browser sends Do Not Track or Global Privacy Control.</p>
${has("email") ? `<h2>Email updates</h2><p>If you sign up, your email address is stored by MailerLite, our email provider, under its own privacy policy. We email you only after you confirm, and every email has an unsubscribe link.</p>` : ""}
${has("checkout") ? `<h2>Orders</h2><p>If you buy a product, Lemon Squeezy, the merchant of record, processes your name, email, billing details and payment under its own privacy policy, and shares your name, email and order details with us so we can deliver the file and support you. We never see your full card number.</p>` : ""}
<h2>Your choices</h2><p>Contact us to access, correct or delete your information. We do not sell personal information.</p>
<h2>Who runs this site</h2>${who}</article>`;
  if (path === "/terms/") return `<article class="legal"><h1>Terms of use</h1><p>Last updated ${date}</p>
<p><strong>Estimates only.</strong> The tools and files do arithmetic on the numbers you enter. Results are estimates, not legal, tax, financial or professional advice.</p>
${c.gap("Niche-specific disclaimer, if any (for example local rules the customer must check).")}
<p><strong>Digital products.</strong> Buying a file gives you a personal or single-business, non-transferable licence to use and edit it. You may not resell or redistribute the file.</p>
<p><strong>Liability.</strong> The tools are provided as is. To the extent the law allows, our total liability for any claim is limited to the amount you paid us. Nothing here limits rights that cannot be limited by law.</p>
${o ? `<p><strong>Governing law.</strong> These terms are governed by the laws of the State of ${esc(o.state)} and the United States.</p>` : c.gap("Governing-law state.")}
<h2>Operator</h2>${who}</article>`;
  if (path === "/refunds/") return `<article class="legal"><h1>Refund policy</h1><p>Last updated ${date}</p>
<p>Our products are digital downloads. If your file is defective, will not open, or is not as described, contact us within 14 days of purchase with your order details and we will send a working file or give you a full refund.</p>
<p>Because files can't be returned once downloaded, we don't otherwise offer refunds for change of mind. This does not affect any rights you have under the law where you live. The checkout provider may apply its own refund rules.</p>${who}</article>`;
  return c.gap(`Legal page ${path} has no template.`);
}

function productDraft(p: ProductSpec, bp: LaunchBlueprint): string {
  const L = [`# Draft: ${p.name}`, "", `Product id \`${p.product_id}\` · ${p.tier} tier · playbook \`${p.playbook}\` · price ${money(p.price.value) ?? "UNKNOWN"} (${p.price.evidence}) · status **${p.status}**`, ""];
  if (p.registry_product_id) L.push(`Builds on existing registry product \`${p.registry_product_id}\`: inventory and reuse the existing file and any build script before writing anything new.`, "");
  L.push(`Format: ${p.format}`, "", "## Outline (one section per required element)", "");
  if (p.must_include.length) p.must_include.forEach((m, i) => L.push(`${i + 1}. **${m}**`, `   - Inputs: _to specify_`, `   - Output the customer sees: _to specify_`, `   - Test case (G4): _to specify_`));
  else L.push("_The blueprint has no contents for this product yet (see its unknowns). Product & Offer proposes them; reviewed at B1._");
  L.push("", "## Must not", "", ...(p.must_not.length ? p.must_not.map((m) => `- ${m}`) : ["- _none listed_"]));
  L.push("", "## Deliverables checklist", "", ...p.deliverables.map((d) => `- [ ] **${d.kind}** (${d.file_format}): ${d.spec}`));
  L.push("", "## Gates", "", ...p.gates.map((g) => `- ${g}: NOT_RUN`));
  if (p.falsifying_test) L.push("", "## Falsifying test", "", p.falsifying_test);
  L.push("", `_Generated from ${bp.blueprint_id}. This outline is a plan, not a product._`, "");
  return L.join("\n");
}
