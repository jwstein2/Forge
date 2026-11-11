/**
 * Builds the Frost Date Garden Planner draft: kit-data.json (from data/crops.json + calendar.js), the PDFs (build_kit.py,
 * Letter and A4) and PNG previews of real pages for the sales page.
 *   node --experimental-strip-types products/garden-planner/kit/build.ts --out <dir>
 * Needs python3 with reportlab, and pdftoppm (poppler) for previews. Local files only.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCalendar, byMonth, lookupZip, parseMonthDay, range, seasonYear, shortDate } from "../calendar.js";
import { EXAMPLE_ZIP, loadCrops, loadShard } from "../site-module.ts";

export function kitData(generatedAt: string) {
  const data = loadCrops();
  const year = seasonYear(new Date(generatedAt));
  const hit = lookupZip(EXAMPLE_ZIP, loadShard(EXAMPLE_ZIP.slice(0, 3)));
  if (!hit.station) throw new Error("example ZIP has no station");
  const lf = parseMonthDay(hit.station.last_spring, year)!;
  const rows = buildCalendar(lf, data.crops);
  return {
    version: "0.1.0", status: "PROPOSED", generated_from: { crops: data.version, season: year },
    crops: data.crops, crop_sources: Object.values(data.sources),
    sample: {
      zip: EXAMPLE_ZIP, station: hit.station.name, km: hit.km, last_frost: shortDate(lf), first_fall: shortDate(parseMonthDay(hit.station.first_fall, year)!), season: year,
      months: byMonth(rows).map((m) => ({ month: m.month, rows: m.rows.map((r) => ({ when: range(r.from, r.to), what: r.label, crop: r.name })) })),
    },
  };
}

/** Pages rendered as previews: cover, calendar worksheet, bed grid, succession planner (kit), page 1 of the sample sheet. */
export const PREVIEWS = [
  { file: "frost-date-garden-planner.letter.pdf", page: 2, name: "kit-calendar-worksheet.png", alt: "Planting calendar worksheet page: about 30 crops with week offsets and a column for your dates" },
  { file: "frost-date-garden-planner.letter.pdf", page: 3, name: "kit-bed-grid.png", alt: "Bed grid page with one-foot squares" },
  { file: "frost-date-garden-planner.letter.pdf", page: 7, name: "kit-succession-planner.png", alt: "Succession-sowing planner page" },
  { file: `personal-calendar.sample-${EXAMPLE_ZIP}.letter.pdf`, page: 1, name: "personal-calendar-sample.png", alt: `Sample personal planting calendar for ZIP ${EXAMPLE_ZIP}, labelled as a sample` },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--out"); const out = resolve(i > 0 ? process.argv[i + 1]! : "kit-out");
  mkdirSync(join(out, "previews"), { recursive: true });
  const dataPath = join(out, "kit-data.json");
  writeFileSync(dataPath, JSON.stringify(kitData(process.env.KIT_DATE ?? "2026-11-10T00:00:00Z"), null, 1) + "\n");
  console.log(execFileSync("python3", [join(import.meta.dirname, "build_kit.py"), "--data", dataPath, "--out", out], { encoding: "utf8" }).trim());
  for (const p of PREVIEWS) {
    execFileSync("pdftoppm", ["-png", "-r", "60", "-f", String(p.page), "-l", String(p.page), "-singlefile", join(out, p.file), join(out, "previews", p.name.replace(/\.png$/, ""))]);
  }
  console.log(`previews: ${PREVIEWS.map((p) => p.name).join(", ")} -> ${join(out, "previews")}`);
}
