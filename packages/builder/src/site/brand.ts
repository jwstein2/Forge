/**
 * Brand tokens (brand stage output) and the CSS generated from them.
 * A brand file is a PROPOSED design decision grounded in the brief's visual claims; G2/G8 review it.
 * Contrast is checked here so an inaccessible palette never reaches a staging build (G3).
 */
export interface Brand {
  niche: string; version: string; status: "PROPOSED" | "BUILT" | "TESTED" | "LIVE";
  note: string; basis_claim_ids: string[]; direction: string;
  fonts: { heading: string; body: string; numeric: string };
  base_size_px: number; radius_px: number;
  motif: "pieced-squares" | "graph-paper" | "flour-dust" | "none";
  colors: { bg: string; surface: string; ink: string; muted: string; line: string; accent: string; accent_ink: string; secondary: string; highlight: string };
}

const HEX = /^#[0-9a-f]{6}$/i;
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/** WCAG 2.2 AA pairs the templates actually use. Returns problems; empty means usable. */
export function checkBrand(b: Brand): string[] {
  const e: string[] = [];
  for (const [k, v] of Object.entries(b.colors)) if (!HEX.test(v)) e.push(`colour ${k} must be #rrggbb`);
  if (e.length) return e;
  const c = b.colors;
  const pairs: [string, string, string, number][] = [
    ["ink on bg", c.ink, c.bg, 4.5], ["ink on surface", c.ink, c.surface, 4.5], ["muted on bg", c.muted, c.bg, 4.5],
    ["muted on surface", c.muted, c.surface, 4.5], ["accent_ink on accent", c.accent_ink, c.accent, 4.5],
    ["accent on bg (links)", c.accent, c.bg, 4.5], ["accent on surface (links)", c.accent, c.surface, 4.5],
    ["ink on highlight", c.ink, c.highlight, 4.5], ["surface on secondary", c.surface, c.secondary, 4.5],
  ];
  for (const [name, fg, bg, min] of pairs) { const r = contrast(fg, bg); if (r < min) e.push(`${name} contrast ${r.toFixed(2)} < ${min}`); }
  if (b.base_size_px < 16) e.push("base size below 16px");
  return e;
}

const MOTIF: Record<Brand["motif"], (c: Brand["colors"]) => string> = {
  "pieced-squares": (c) => `.motif{height:14px;background:
    linear-gradient(45deg,${c.accent} 25%,transparent 25%,transparent 75%,${c.accent} 75%) 0 0/28px 28px,
    linear-gradient(45deg,${c.secondary} 25%,${c.highlight} 25%,${c.highlight} 75%,${c.secondary} 75%) 14px 14px/28px 28px;opacity:.85}`,
  "graph-paper": (c) => `body{background-image:linear-gradient(${c.line}66 1px,transparent 1px),linear-gradient(90deg,${c.line}66 1px,transparent 1px);background-size:24px 24px}
.motif{height:6px;background:repeating-linear-gradient(90deg,${c.accent} 0 24px,${c.highlight} 24px 48px)}`,
  "flour-dust": (c) => `body{background-image:radial-gradient(${c.line} 1px,transparent 1.5px);background-size:22px 22px}
.motif{height:10px;background:radial-gradient(circle at 10px 5px,${c.accent} 3px,transparent 3.5px) 0 0/40px 10px}`,
  none: () => `.motif{display:none}`,
};

export function brandCss(b: Brand): string {
  const c = b.colors;
  return `/* Generated from brands/${b.niche}.brand.json v${b.version} (${b.status}). Do not edit by hand. */
:root{--bg:${c.bg};--surface:${c.surface};--ink:${c.ink};--muted:${c.muted};--line:${c.line};--accent:${c.accent};--accent-ink:${c.accent_ink};--secondary:${c.secondary};--highlight:${c.highlight};
--f-head:${b.fonts.heading};--f-body:${b.fonts.body};--f-num:${b.fonts.numeric};--r:${b.radius_px}px;--base:${b.base_size_px}px}
*{box-sizing:border-box}
html{font-size:var(--base);-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--f-body);line-height:1.6}
a{color:var(--accent);text-underline-offset:3px}
a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid var(--secondary);outline-offset:2px}
.skip{position:absolute;left:-999px}.skip:focus{left:1rem;top:1rem;background:var(--surface);padding:.5rem 1rem;z-index:10}
.staging{background:var(--secondary);color:var(--surface);font-size:.85rem;padding:.5rem 1rem;text-align:center}
.staging a{color:var(--surface)}
header.site,footer.site{max-width:68rem;margin:0 auto;padding:1rem}
header.site{display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;align-items:center;justify-content:space-between}
.brand{font-family:var(--f-head);font-size:1.4rem;font-weight:700;color:var(--ink);text-decoration:none}
nav ul{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem;list-style:none;margin:0;padding:0}
nav a{color:var(--ink);text-decoration:none;padding:.4rem 0;display:inline-block}
nav a:hover,nav a[aria-current]{color:var(--accent);text-decoration:underline}
main{max-width:68rem;margin:0 auto;padding:0 1rem 3rem}
h1,h2,h3{font-family:var(--f-head);line-height:1.2;margin:1.6em 0 .5em}
h1{font-size:clamp(2rem,5vw,3rem);margin-top:.8em}
h2{font-size:clamp(1.4rem,3.2vw,1.9rem)}
.lede{font-size:1.15rem;color:var(--muted);max-width:40rem}
section{margin:2.5rem 0}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:1.25rem 1.5rem}
.grid{display:grid;gap:1.25rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr))}
.price{font-family:var(--f-num);font-size:2rem;font-weight:700}
.btn{display:inline-block;background:var(--accent);color:var(--accent-ink);border:0;border-radius:var(--r);padding:.8rem 1.4rem;font:inherit;font-weight:700;text-decoration:none;cursor:pointer;min-height:44px}
.btn[aria-disabled=true]{background:var(--surface);color:var(--accent);border:2px dashed var(--accent);cursor:not-allowed}
.btn-note{display:block;font-size:.85rem;color:var(--muted);margin-top:.4rem}
ol.plan{counter-reset:s;list-style:none;padding:0}
ol.plan li{counter-increment:s;padding:.6rem 0 .6rem 3rem;position:relative}
ol.plan li::before{content:counter(s);position:absolute;left:0;top:.45rem;width:2.1rem;height:2.1rem;border-radius:50%;background:var(--highlight);font-family:var(--f-num);font-weight:700;display:grid;place-items:center}
ul.ticks{padding-left:1.2rem}ul.ticks li{margin:.35rem 0}
.draft{border-left:4px solid var(--highlight);padding-left:.9rem}
.badge{display:inline-block;font-size:.72rem;letter-spacing:.04em;text-transform:uppercase;background:var(--highlight);color:var(--ink);border-radius:999px;padding:.1rem .55rem;vertical-align:middle;margin-left:.4rem}
.copy-gap{display:block;border:2px dashed var(--accent);border-radius:var(--r);padding:.6rem .9rem;margin:.6rem 0;color:var(--ink);background:var(--surface);font-size:.95rem}
.copy-gap::before{content:"Copy needed · ";font-weight:700;color:var(--accent)}
.preview{border:2px dashed var(--line);border-radius:var(--r);min-height:9rem;display:grid;place-items:center;color:var(--muted);text-align:center;padding:1rem}
details{border-bottom:1px solid var(--line);padding:.7rem 0}summary{cursor:pointer;font-weight:600}
form.signup{display:flex;flex-wrap:wrap;gap:.6rem;align-items:end}
form.signup label{display:flex;flex-direction:column;gap:.25rem;flex:1 1 16rem}
input[type=email]{font:inherit;padding:.7rem .8rem;border:1px solid var(--muted);border-radius:var(--r);background:var(--surface);color:var(--ink);min-height:44px}
footer.site{border-top:1px solid var(--line);color:var(--muted);font-size:.9rem;margin-top:2rem}
footer.site ul{display:flex;flex-wrap:wrap;gap:.25rem 1.2rem;list-style:none;padding:0}
footer.site a{color:var(--muted)}
.legal{max-width:44rem}
${MOTIF[b.motif](c)}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
@media print{.staging,nav,form.signup,.btn{display:none}}
`;
}
