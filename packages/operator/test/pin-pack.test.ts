import { describe, expect, it } from "vitest";
import { PINS, binding, backing, hst, borders, charms, eighths, yd, rssItem, pinLink, queueEntry } from "../src/content/qpk-pin-pack.ts";
import { claimsLint } from "../src/handlers/content.ts";

// Numbers as stated on the live pages (read 2026-11-10). The pack must reproduce them from the pages' own formulas.
describe("QPK pin pack matches the site's pages", () => {
  it("binding answers", () => {
    expect(binding(84, 102)).toEqual({ len: 382, strips: 10, wide: "3/4 yd", narrow: "5/8 yd" });
    expect(binding(100, 102)).toEqual({ len: 414, strips: 10, wide: "3/4 yd", narrow: "5/8 yd" });
    expect(binding(50, 65)).toEqual({ len: 240, strips: 6, wide: "1/2 yd", narrow: "3/8 yd" });
    expect(binding(63, 97)).toEqual({ len: 330, strips: 8, wide: "5/8 yd", narrow: "1/2 yd" });
  });
  it("backing answers", () => {
    expect(backing(84, 102)).toMatchObject({ size: "92 x 110", seams: "horizontal", panels: 3, inches: 276, wideInches: 110 });
    expect(backing(50, 65)).toMatchObject({ size: "58 x 73", seams: "horizontal", panels: 2, inches: 116 });
    expect(backing(63, 97)).toMatchObject({ size: "71 x 105", seams: "vertical", panels: 2, inches: 210, wideInches: 71 });
    expect(yd(eighths(71))).toBe("2 yd"); // page: 2 yd of wide-back (105 in runs across the 106 in width)
  });
  it("half-square triangles", () => {
    expect(hst(2.5)).toEqual({ two: "3 3/8", eight: "6 3/4", trim: "3" });
    expect(hst(4)).toEqual({ two: "4 7/8", eight: "9 3/4", trim: "4 1/2" });
    expect(hst(6)).toEqual({ two: "6 7/8", eight: "13 3/4", trim: "6 1/2" });
  });
  it("borders and precuts guides", () => {
    expect(borders(48.5, 60.5, 4)).toEqual({ cut: "4 1/2", strips: 6, yardage: "3/4 yd" });
    expect(borders(80.5, 90.5, 6)).toEqual({ cut: "6 1/2", strips: 10, yardage: "1 7/8 yd" });
    expect(charms(50, 65)).toEqual({ squares: 180, packs: 5 });
    expect(charms(84, 102)).toEqual({ squares: 437, packs: 11 });
  });
});

describe("QPK pin pack is publishable copy", () => {
  it("has 4 pins for pages the queue lacks, one a day from 2026-12-14", () => {
    expect(PINS.map((p) => p.slug)).toEqual(["borders-throw", "precuts-throw", "borders-calculator", "precuts-calculator"]);
    PINS.forEach((p, i) => expect(p.date).toBe(`2026-12-${14 + i}`));
    expect(queueEntry(PINS[0]!)).toMatchObject({ slug: "borders-throw", path: "/guides/how-much-fabric-for-borders", publish: "2026-12-14T19:00:00.000Z" });
  });
  it("passes the claims check, with no prices at all", () => {
    for (const p of PINS) expect(claimsLint(`${p.title}\n${p.description}\n${p.facts.join("\n")}`, [])).toEqual([]);
  });
  it("'at a time' is a cutting method, not a time-saving claim", () => {
    expect(claimsLint("Cut 4 7/8 in squares to make 2 at a time, or 9 3/4 in squares.")).toEqual([]);
    expect(claimsLint("Cut your cutting time by 3 hours.")).toContain("unsupported performance claim");
  });
  it("every number it claims appears in its own copy, and every fact fits a pin line", () => {
    for (const p of PINS) {
      for (const c of p.claims) expect(p.description).toContain(c);
      expect(p.title.length).toBeLessThanOrEqual(100);
      expect(p.description.length).toBeLessThanOrEqual(500);
      for (const f of [...p.facts, ...p.headline]) expect(f.length).toBeLessThanOrEqual(30);
    }
  });
  it("builds valid RSS items", () => {
    const x = rssItem(PINS[0]!);
    expect(x).toContain("<pubDate>Mon, 14 Dec 2026 19:00:00 GMT</pubDate>");
    expect(x).toContain("utm_content=borders-throw");
    expect(x).not.toMatch(/&(?!amp;|lt;|gt;)/);
    expect(pinLink(PINS[3]!)).toBe("https://quiltplankit.pages.dev/calculators/precuts?utm_source=pinterest&utm_medium=organic&utm_campaign=rss&utm_content=precuts-calculator");
  });
});
