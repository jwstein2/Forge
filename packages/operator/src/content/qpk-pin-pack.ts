/**
 * Quilt Plan Kit Pinterest pack: 4 pins for pages the site's queue (pins/pins.json, 38 items through 2026-12-13, staged
 * for the next site deploy) does not cover yet, scheduled 2026-12-14..17. Ten earlier candidates duplicated queued pins and
 * were dropped. Every pin points at a live page on quiltplankit.pages.dev and repeats only numbers that
 * page states (read 2026-11-10). The test re-derives each number from the page's own formula, so a pin can never
 * disagree with its page. Status: drafted. Publishing needs a site deploy (pins.xml + images), which James approves.
 */
export const SITE = "https://quiltplankit.pages.dev";
export const FABRIC = 42; // usable width of quilting cotton the site assumes
export const WIDEBACK = 106; // usable width of 108 in wide-back

/** Inches → yards rounded up to the next 1/8 yd, the site's rule. Returns eighths. */
export const eighths = (inches: number) => Math.ceil(inches / 4.5 - 1e-9);
export function yd(e: number): string {
  const whole = Math.floor(e / 8); let n = e % 8; let d = 8;
  while (n && n % 2 === 0) { n /= 2; d /= 2; }
  return n ? (whole ? `${whole} ${n}/${d} yd` : `${n}/${d} yd`) : `${whole} yd`;
}
export function frac(x: number): string { // 3.375 → "3 3/8"
  const whole = Math.floor(x + 1e-9); let n = Math.round((x - whole) * 8); let d = 8;
  while (n && n % 2 === 0) { n /= 2; d /= 2; }
  return n ? (whole ? `${whole} ${n}/${d}` : `${n}/${d}`) : `${whole}`;
}

export const binding = (w: number, l: number) => {
  const len = 2 * (w + l) + 10; const strips = Math.ceil(len / FABRIC - 1e-9);
  return { len, strips, wide: yd(eighths(strips * 2.5)), narrow: yd(eighths(strips * 2.25)) };
};
export const backing = (w: number, l: number) => {
  const bw = w + 8, bl = l + 8;
  const vert = Math.ceil(bw / FABRIC - 1e-9) * bl, horiz = Math.ceil(bl / FABRIC - 1e-9) * bw;
  const best = horiz <= vert ? { seams: "horizontal", panels: Math.ceil(bl / FABRIC - 1e-9), inches: horiz } : { seams: "vertical", panels: Math.ceil(bw / FABRIC - 1e-9), inches: vert };
  const wideLen = Math.min(...[[bw, bl], [bl, bw]].filter(([across]) => across! <= WIDEBACK).map(([, along]) => along!), Infinity);
  return { size: `${bw} x ${bl}`, ...best, wideInches: wideLen };
};
export const hst = (f: number) => ({ two: frac(f + 7 / 8), eight: frac(2 * (f + 7 / 8)), trim: frac(f + 0.5) });
export const borders = (w: number, l: number, b: number) => {
  const cut = b + 0.5; const total = 2 * (l + 2) + 2 * (w + 2 * b + 2);
  const strips = Math.ceil(total / (FABRIC - 0.5) - 1e-9);
  return { cut: frac(cut), strips, yardage: yd(eighths(strips * cut)) };
};
export const charms = (w: number, l: number) => { const n = Math.ceil(w / 4.5 - 1e-9) * Math.ceil(l / 4.5 - 1e-9); return { squares: n, packs: Math.ceil(n / 42) }; };

export interface Pin { date: string; slug: string; path: string; title: string; description: string; headline: string[]; facts: string[]; claims: string[] }
const d = (n: number) => `2026-12-${String(n).padStart(2, "0")}`;

const brT = borders(48.5, 60.5, 4), brQ = borders(80.5, 90.5, 6);
const chT = charms(50, 65), chQ = charms(84, 102);

export const PINS: Pin[] = [
  { date: d(14), slug: "borders-throw", path: "/guides/how-much-fabric-for-borders",
    title: "How Much Fabric for Quilt Borders? Step-by-Step with a Throw Example",
    description: `Cut width is the finished border plus 1/2 in. A 48 1/2 x 60 1/2 in throw with a 4 in border needs ${brT.strips} strips cut ${brT.cut} in wide, ${brT.yardage}. Measure through the centre, not the edges.`,
    headline: ["How much fabric", "for quilt borders?"], facts: [`4 in border on a throw top`, `${brT.strips} strips cut ${brT.cut} in`, `${brT.yardage} of fabric`], claims: [`${brT.strips} strips`, brT.yardage] },
  { date: d(15), slug: "precuts-throw", path: "/guides/precut-quilt-sizes",
    title: "How Many Precuts for a Throw Quilt? Charm Packs, Layer Cakes, Jelly Rolls",
    description: `A 5 in charm finishes at 4 1/2 in. A 50 x 65 in throw takes ${chT.squares} charms, ${chT.packs} charm packs, or 1 layer cake, or 1 jelly roll, which is tight: it leaves no spare strips. Pack counts vary by maker, so check the label.`,
    headline: ["How many precuts", "for a throw quilt?"], facts: [`${chT.packs} charm packs`, `or 1 layer cake`, `or 1 jelly roll (tight)`], claims: [`${chT.squares} charms`, `${chT.packs} charm packs`] },
  { date: d(16), slug: "borders-calculator", path: "/calculators/borders",
    title: "Free Quilt Border Calculator: Strips, Lengths and Yardage",
    description: `Enter your top size and border width to get strip count, border lengths and yardage. Example: an 80 1/2 x 90 1/2 in queen top with a 6 in border takes ${brQ.strips} strips, ${brQ.yardage}.`,
    headline: ["Quilt border", "calculator"], facts: [`6 in border on a queen top`, `${brQ.strips} strips cut ${brQ.cut} in`, `${brQ.yardage} of fabric`], claims: [`${brQ.strips} strips`, brQ.yardage] },
  { date: d(17), slug: "precuts-calculator", path: "/calculators/precuts",
    title: "Free Quilt Precut Calculator: How Many Charm Packs or Jelly Rolls?",
    description: `Enter your quilt size to count charm packs, layer cakes or jelly rolls. Example: an 84 x 102 in queen takes ${chQ.squares} charms, which is ${chQ.packs} charm packs.`,
    headline: ["Quilt precut", "calculator"], facts: [`Queen quilt, 84 x 102 in`, `${chQ.squares} charm squares`, `${chQ.packs} charm packs`], claims: [`${chQ.squares} charms`, `${chQ.packs} charm packs`] }
];

export const pinLink = (p: Pin) => `${SITE}${p.path}?utm_source=pinterest&utm_medium=organic&utm_campaign=rss&utm_content=${p.slug}`;
export const pinImage = (p: Pin) => `${SITE}/pins/${p.slug}.png`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function rssItem(p: Pin): string {
  const pub = new Date(`${p.date}T19:00:00Z`).toUTCString();
  return `    <item>
      <title>${esc(p.title)}</title>
      <link>${esc(pinLink(p))}</link>
      <guid isPermaLink="false">qpk-pin-${p.slug}</guid>
      <pubDate>${pub}</pubDate>
      <description>${esc(p.description)}</description>
      <enclosure url="${pinImage(p)}" type="image/png" length="0"/>
    </item>`;
}

/** Entry in the site's pins/pins.json shape. */
export const queueEntry = (p: Pin) => ({ slug: p.slug, path: p.path, title: p.title, description: p.description, publish: `${p.date}T19:00:00.000Z` });
