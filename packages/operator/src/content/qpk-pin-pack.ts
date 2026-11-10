/**
 * Quilt Plan Kit Pinterest pack 2026-11-13..26: the next 14 pins for the site's RSS drip (pins.xml), one a day.
 * The site's queue ends 2026-11-12. Every pin points at a live page on quiltplankit.pages.dev and repeats only numbers that
 * page states (read 2026-11-10). The test re-derives each number from the page's own formula, so a pin can never
 * disagree with its page. Status: drafted. Publishing needs a site deploy (pins.xml + images), which James approves.
 * Pages left out on purpose: /answers/binding-baby-quilt (its intro suggests a fat quarter, which its own math rules out)
 * and /answers/backing-king-quilt ("no seams needed if you join 2 panels" contradicts itself). Both are reported to the
 * site owner.
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
const d = (n: number) => `2026-11-${String(n).padStart(2, "0")}`;

const bq = binding(84, 102), bt = binding(50, 65), bk = binding(100, 102), btw = binding(63, 97);
const kq = backing(84, 102), kt = backing(50, 65), ktw = backing(63, 97);
const h25 = hst(2.5), h4 = hst(4), h6 = hst(6);
const brT = borders(48.5, 60.5, 4), brQ = borders(80.5, 90.5, 6);
const chT = charms(50, 65), chQ = charms(84, 102);

export const PINS: Pin[] = [
  { date: d(13), slug: "borders-throw", path: "/guides/how-much-fabric-for-borders",
    title: "How Much Fabric for Quilt Borders? Step-by-Step with a Throw Example",
    description: `Cut width is the finished border plus 1/2 in. A 48 1/2 x 60 1/2 in throw with a 4 in border needs ${brT.strips} strips cut ${brT.cut} in wide, ${brT.yardage}. Measure through the centre, not the edges.`,
    headline: ["How much fabric", "for quilt borders?"], facts: [`4 in border on a throw top`, `${brT.strips} strips cut ${brT.cut} in`, `${brT.yardage} of fabric`], claims: [`${brT.strips} strips`, brT.yardage] },
  { date: d(14), slug: "precuts-throw", path: "/guides/precut-quilt-sizes",
    title: "How Many Precuts for a Throw Quilt? Charm Packs, Layer Cakes, Jelly Rolls",
    description: `A 5 in charm finishes at 4 1/2 in. A 50 x 65 in throw takes ${chT.squares} charms, ${chT.packs} charm packs, or 1 layer cake, or 1 jelly roll. Pack counts vary by maker, so check the label.`,
    headline: ["How many precuts", "for a throw quilt?"], facts: [`${chT.packs} charm packs`, `or 1 layer cake`, `or 1 jelly roll`], claims: [`${chT.squares} charms`, `${chT.packs} charm packs`] },
  { date: d(15), slug: "binding-queen", path: "/answers/binding-queen-quilt",
    title: "How Much Binding for a Queen Quilt? Strips, Inches and Yardage",
    description: `An 84 x 102 in queen quilt needs ${bq.len} in of binding: ${bq.strips} strips, ${bq.wide} at 2 1/2 in wide or ${bq.narrow} at 2 1/4 in. Formula: 2 x (width + length) + 10 in for joins.`,
    headline: ["How much binding", "for a queen quilt?"], facts: [`${bq.len} in of binding`, `${bq.strips} strips`, `${bq.wide} at 2 1/2 in`], claims: [`${bq.len} in`, `${bq.strips} strips`, bq.wide, bq.narrow] },
  { date: d(16), slug: "hst-2-5", path: "/answers/hst-2-5-inch",
    title: "What Size to Cut for 2 1/2 Inch Half-Square Triangles?",
    description: `For 2 1/2 in finished HSTs, cut ${h25.two} in squares to make 2 at a time, or ${h25.eight} in squares to make 8 at a time. Trim each unit to ${h25.trim} in.`,
    headline: ["2 1/2 in half-square", "triangles: cut size"], facts: [`2 at a time: ${h25.two} in`, `8 at a time: ${h25.eight} in`, `Trim to ${h25.trim} in`], claims: [h25.two, h25.eight, h25.trim] },
  { date: d(17), slug: "backing-queen", path: "/answers/backing-queen-quilt",
    title: "How Much Backing Fabric for a Queen Quilt? Panels, Seams and Yardage",
    description: `Add 4 in on every side: an 84 x 102 in queen needs a ${kq.size} in backing. That is ${kq.panels} panels of 42 in fabric with ${kq.seams} seams, or one piece of 108 in wide-back.`,
    headline: ["How much backing", "for a queen quilt?"], facts: [`Backing ${kq.size} in`, `${kq.panels} panels, ${kq.seams} seams`, `or 1 piece of wide-back`], claims: [kq.size, `${kq.panels} panels`, kq.seams] },
  { date: d(18), slug: "binding-throw", path: "/answers/binding-throw-quilt",
    title: "How Much Binding for a Throw Quilt? Strips, Inches and Yardage",
    description: `A 50 x 65 in throw needs ${bt.len} in of binding: ${bt.strips} strips, ${bt.wide} at 2 1/2 in wide or ${bt.narrow} at 2 1/4 in.`,
    headline: ["How much binding", "for a throw quilt?"], facts: [`${bt.len} in of binding`, `${bt.strips} strips`, `${bt.wide} at 2 1/2 in`], claims: [`${bt.len} in`, `${bt.strips} strips`, bt.wide, bt.narrow] },
  { date: d(19), slug: "hst-4", path: "/answers/hst-4-inch",
    title: "What Size to Cut for 4 Inch Half-Square Triangles?",
    description: `For 4 in finished HSTs, cut ${h4.two} in squares to make 2 at a time, or ${h4.eight} in squares to make 8 at a time. Trim each unit to ${h4.trim} in before piecing.`,
    headline: ["4 in half-square", "triangles: cut size"], facts: [`2 at a time: ${h4.two} in`, `8 at a time: ${h4.eight} in`, `Trim to ${h4.trim} in`], claims: [h4.two, h4.eight, h4.trim] },
  { date: d(20), slug: "backing-throw", path: "/answers/backing-throw-quilt",
    title: "How Much Backing Fabric for a Throw Quilt?",
    description: `A 50 x 65 in throw needs a ${kt.size} in backing: ${kt.panels} panels of 42 in fabric with a ${kt.seams} seam, or one piece of 108 in wide-back with no seam.`,
    headline: ["How much backing", "for a throw quilt?"], facts: [`Backing ${kt.size} in`, `${kt.panels} panels, ${kt.seams} seam`, `or 1 piece of wide-back`], claims: [kt.size, `${kt.panels} panels`, kt.seams] },
  { date: d(21), slug: "binding-king", path: "/answers/binding-king-quilt",
    title: "How Much Binding for a King Quilt? Strips, Inches and Yardage",
    description: `A 100 x 102 in king quilt needs ${bk.len} in of binding: ${bk.strips} strips, ${bk.wide} at 2 1/2 in wide or ${bk.narrow} at 2 1/4 in.`,
    headline: ["How much binding", "for a king quilt?"], facts: [`${bk.len} in of binding`, `${bk.strips} strips`, `${bk.wide} at 2 1/2 in`], claims: [`${bk.len} in`, `${bk.strips} strips`, bk.wide, bk.narrow] },
  { date: d(22), slug: "hst-6", path: "/answers/hst-6-inch",
    title: "What Size to Cut for 6 Inch Half-Square Triangles?",
    description: `For 6 in finished HSTs, cut ${h6.two} in squares to make 2 at a time, or ${h6.eight} in squares to make 8 at a time. Trim each unit to ${h6.trim} in.`,
    headline: ["6 in half-square", "triangles: cut size"], facts: [`2 at a time: ${h6.two} in`, `8 at a time: ${h6.eight} in`, `Trim to ${h6.trim} in`], claims: [h6.two, h6.eight, h6.trim] },
  { date: d(23), slug: "borders-calculator", path: "/calculators/borders",
    title: "Free Quilt Border Calculator: Strips, Lengths and Yardage",
    description: `Enter your top size and border width to get strip count, border lengths and yardage. Example: an 80 1/2 x 90 1/2 in queen top with a 6 in border takes ${brQ.strips} strips, ${brQ.yardage}.`,
    headline: ["Quilt border", "calculator"], facts: [`6 in border on a queen top`, `${brQ.strips} strips cut ${brQ.cut} in`, `${brQ.yardage} of fabric`], claims: [`${brQ.strips} strips`, brQ.yardage] },
  { date: d(24), slug: "precuts-calculator", path: "/calculators/precuts",
    title: "Free Quilt Precut Calculator: How Many Charm Packs or Jelly Rolls?",
    description: `Enter your quilt size to count charm packs, layer cakes or jelly rolls. Example: an 84 x 102 in queen takes ${chQ.squares} charms, which is ${chQ.packs} charm packs.`,
    headline: ["Quilt precut", "calculator"], facts: [`Queen quilt, 84 x 102 in`, `${chQ.squares} charm squares`, `${chQ.packs} charm packs`], claims: [`${chQ.squares} charms`, `${chQ.packs} charm packs`] },
  { date: d(25), slug: "binding-twin", path: "/answers/binding-twin-quilt",
    title: "How Much Binding for a Twin Quilt? Strips, Inches and Yardage",
    description: `A 63 x 97 in twin quilt needs ${btw.len} in of binding: ${btw.strips} strips, ${btw.wide} at 2 1/2 in wide or ${btw.narrow} at 2 1/4 in.`,
    headline: ["How much binding", "for a twin quilt?"], facts: [`${btw.len} in of binding`, `${btw.strips} strips`, `${btw.wide} at 2 1/2 in`], claims: [`${btw.len} in`, `${btw.strips} strips`, btw.wide, btw.narrow] },
  { date: d(26), slug: "backing-twin", path: "/answers/backing-twin-quilt",
    title: "How Much Backing Fabric for a Twin Quilt?",
    description: `A 63 x 97 in twin needs a ${ktw.size} in backing: ${ktw.panels} panels of 42 in fabric with a ${ktw.seams} seam, or ${yd(eighths(ktw.wideInches))} of 108 in wide-back with no seam.`,
    headline: ["How much backing", "for a twin quilt?"], facts: [`Backing ${ktw.size} in`, `${ktw.panels} panels, ${ktw.seams} seam`, `or ${yd(eighths(ktw.wideInches))} of wide-back`], claims: [ktw.size, `${ktw.panels} panels`, ktw.seams] },
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
