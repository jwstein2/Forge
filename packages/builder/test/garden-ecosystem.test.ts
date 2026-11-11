/** Garden Planner staged ecosystem: calculator logic, frost data, crop data, site module, copy deck, kit build. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCalendar, freezeIsRare, lookupZip, normalizeZip, parseIsoDate, parseMonthDay, range, seasonYear, iso } from "../products/garden-planner/calendar.js";
import { parseCsvLine, stationFromCsv, nearest, MAX_KM } from "../products/garden-planner/scripts/build-frost-data.ts";
import { gardenModule, loadCrops, loadShard, timingText } from "../products/garden-planner/site-module.ts";
import { kitData, PREVIEWS } from "../products/garden-planner/kit/build.ts";
import { scaffoldSite } from "../src/site/scaffold.ts";
import { validateCopyDeck, type CopyDeck } from "../src/site/copy.ts";
import type { Brand } from "../src/site/brand.ts";
import type { LaunchBlueprint } from "../src/types.ts";

const B = join(import.meta.dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(B, p), "utf8"));
const bp = read("blueprints/garden-planner/launch-blueprint.v1.0.5.json") as LaunchBlueprint;
const brief = read("test/fixtures/garden-planner.brief.json");
const brand = read("brands/garden-planner.brand.json") as Brand;
const deck = read("copy/garden-planner.copy.json") as CopyDeck;
const cfg = { operator: null, legalDate: "2026-11-10", liveSiteUrl: null, runtime: { checkout: { mode: "off" as const, urls: {} }, email: { action: null }, beacon: { url: null, hosts: [], site: "garden-planner" } } };

describe("planting calendar logic", () => {
  it("parses only real dates", () => {
    expect(iso(parseMonthDay("05/11", 2027)!)).toBe("2027-05-11");
    expect(parseMonthDay("02/30", 2027)).toBeNull();
    expect(parseMonthDay("-9999.0", 2027)).toBeNull();
    expect(parseIsoDate("2027-02-29")).toBeNull();
    expect(iso(parseIsoDate("2028-02-29")!)).toBe("2028-02-29");
  });
  it("plans next spring once the summer is over", () => {
    expect(seasonYear(new Date("2026-11-11T00:00:00Z"))).toBe(2027);
    expect(seasonYear(new Date("2027-03-01T00:00:00Z"))).toBe(2027);
  });
  it("dates every task from the frost date, earliest first", () => {
    const crops = loadCrops().crops;
    const rows = buildCalendar(parseMonthDay("05/11", 2027)!, crops);
    const tomato = rows.filter((r) => r.crop === "tomato");
    expect(tomato.map((r) => [r.action, iso(r.from), iso(r.to)])).toEqual([["start_indoors", "2027-03-16", "2027-03-30"], ["transplant", "2027-05-18", "2027-05-18"]]);
    expect(range(tomato[0]!.from, tomato[0]!.to)).toBe("Mar 16 to Mar 30");
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.from.getTime()).toBeGreaterThanOrEqual(rows[i - 1]!.from.getTime());
  });
  it("normalises ZIPs without guessing", () => {
    expect(normalizeZip("02139")).toBe("02139");
    expect(normalizeZip("55401-1234")).toBe("55401");
    expect(normalizeZip("2139")).toBeNull();
    expect(normalizeZip(2139 as unknown as string)).toBeNull();
  });
  it("words timings plainly", () => {
    expect(timingText({ from_weeks: -8, to_weeks: -6 })).toBe("6 to 8 weeks before your last-frost date");
    expect(timingText({ from_weeks: 1, to_weeks: 2 })).toBe("1 to 2 weeks after your last-frost date");
    expect(timingText({ from_weeks: 0, to_weeks: 0 })).toBe("on your last-frost date");
    expect(timingText({ from_weeks: -4, to_weeks: 0 })).toBe("from 4 weeks before up to your last-frost date");
  });
});

describe("crop data", () => {
  const data = loadCrops();
  it("has about 30 crops, each cited and with at least one valid timing", () => {
    expect(data.crops.length).toBe(30);
    for (const c of data.crops) {
      expect(data.sources[c.source_id], c.id).toBeDefined();
      const ts = [c.start_indoors, c.transplant, c.direct_sow].filter(Boolean);
      expect(ts.length, c.id).toBeGreaterThan(0);
      for (const t of ts) expect(t!.from_weeks, c.id).toBeLessThanOrEqual(t!.to_weeks);
      if (c.source_id === "src_johnnys_calc") expect(c.note, c.id).toMatch(/^Derived: /);
    }
  });
});

describe("frost data", () => {
  const index = read("products/garden-planner/data/frost/index.json");
  it("records its public sources and coverage", () => {
    expect(index.sources.map((s: { licence: string }) => s.licence)).toEqual(["CC0 1.0 (public domain)", "Public domain (US Government work)"]);
    expect(index.zips_with_station).toBeGreaterThan(33000);
    expect(readdirSync(join(B, "products/garden-planner/data/frost")).length).toBe(index.shards + 1);
  });
  it("finds the nearest station with dates, and refuses beyond the cap", () => {
    const mpls = lookupZip("55401", loadShard("554"));
    expect(mpls.station?.name).toMatch(/MN US$/);
    expect(mpls.km).toBeLessThan(10);
    expect(lookupZip("96813", loadShard("968"))).toMatchObject({ station: null, reason: "no_station_nearby" });
    expect(lookupZip("00000", loadShard("554"))).toMatchObject({ station: null, reason: "zip_not_covered" });
  });
  it("flags places where a frost is rare instead of building a calendar", () => {
    const s = lookupZip("33139", loadShard("331")).station!;
    expect(freezeIsRare(s)).toBe(true);
    expect(freezeIsRare(lookupZip("55401", loadShard("554")).station!)).toBe(false);
  });
  it("every shard entry is a valid station within the cap", () => {
    for (const f of readdirSync(join(B, "products/garden-planner/data/frost")).filter((f) => f !== "index.json").slice(0, 120)) {
      const sh = loadShard(f.replace(".json", ""));
      for (const hit of Object.values(sh.zips) as ([string, number] | null)[]) {
        if (!hit) continue;
        expect(hit[1]).toBeLessThanOrEqual(MAX_KM);
        const s = sh.stations[hit[0]];
        expect(parseMonthDay(s.last_spring, 2001)).not.toBeNull();
        expect(parseMonthDay(s.first_fall, 2001)).not.toBeNull();
      }
    }
  });
  it("parses NOAA CSVs and drops stations without freeze dates", () => {
    expect(parseCsvLine('"A","B, C",1')).toEqual(["A", "B, C", "1"]);
    const head = '"STATION","NAME","LATITUDE","LONGITUDE","ELEVATION","ANN-TMIN-PRBLST-T32FP50","comp_flag_ANN-TMIN-PRBLST-T32FP50","years_ANN-TMIN-PRBLST-T32FP50","ANN-TMIN-PRBFST-T32FP50","ANN-TMIN-PRBOCC-LSTH032"';
    expect(stationFromCsv(`${head}\n"X1","TEST, MN US"," 45.0"," -93.0"," 250.0","   05/11","S","29","   10/01","100.0"`)).toEqual(["X1", { name: "TEST, MN US", lat: 45, lon: -93, elev_m: 250, last_spring: "05/11", first_fall: "10/01", freeze_chance_pct: 100, completeness: "S", years: 29 }]);
    expect(stationFromCsv(`${head}\n"X2","T"," 45.0"," -93.0"," 250.0","-9999.0"," ","0","-9999.0","0.0"`)).toBeNull();
    const st = new Map([["A", { name: "a", lat: 45, lon: -93, elev_m: null, last_spring: "05/01", first_fall: "10/01", freeze_chance_pct: 100, completeness: "S", years: 30 }]]);
    expect(nearest([["11111", 45.01, -93], ["22222", 50, -80]], st)).toEqual(new Map([["11111", ["A", 1.1]], ["22222", null]]));
  });
});

describe("garden staging site with the calculator module and proposed copy", async () => {
  const r = await scaffoldSite(bp, brand, cfg, { modules: [gardenModule({ generatedAt: bp.created_at, bp })], copy: deck });
  const html = Object.entries(r.files).filter(([p]) => p.endsWith(".html")) as [string, string][];
  it("adds the calculator, 30 crop pages and the data, without inline scripts", () => {
    expect(r.manifest.modules).toEqual(["garden-planner-calendar@1.0.0"]);
    expect(r.manifest.pages.filter((p) => p.startsWith("/when-to-plant/")).length).toBe(31);
    expect(r.files["tools/index.html"]).toContain("data-garden-calc");
    expect(r.files["tools/index.html"]).toContain('<div class="table-wrap" tabindex="0" role="region" aria-label='); // QA-021 B3-4
    expect(r.files["data/frost/554.json"]).toBeDefined();
    for (const [p, h] of html) expect(h, p).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>|\son[a-z]+=|\sstyle=/i);
  });
  it("cites a source on every crop page and labels the worked example", () => {
    for (const [p, h] of html.filter(([p]) => /^when-to-plant\/[^/]+\/index\.html$/.test(p))) {
      expect(h, p).toMatch(/Source: <a href="https:\/\//);
      expect(h, p).toContain("Example only: ZIP 55401");
    }
  });
  it("tells visitors what the calculator downloads", () => {
    expect(r.files["privacy/index.html"]).toContain("first three digits of the ZIP");
  });
  it("fills only the markers the deck covers and records the deck in the manifest", () => {
    expect(r.copyUsed.length).toBe(deck.entries.length);
    expect(r.manifest.copy_deck).toMatchObject({ version: deck.version, entries_used: deck.entries.length, status: "PROPOSED" });
    expect(r.files["about/index.html"]).toContain("copy-gap"); // operator's own words stay a gap
  });
});

describe("copy decks for the three live businesses", () => {
  for (const n of ["bidline", "quilt-plan-kit", "loaf-ledger"]) {
    it(`${n}: deck is PROPOSED, valid against blueprint v1.0.4 and its brief, and fills its markers`, async () => {
      const d = read(`copy/${n}.copy.json`) as CopyDeck; const b = read(`blueprints/${n}/launch-blueprint.v1.0.4.json`) as LaunchBlueprint;
      expect(d.status).toBe("PROPOSED");
      expect(validateCopyDeck(d, b, read(`test/fixtures/${n}.brief.json`))).toEqual([]);
      const site = await scaffoldSite(b, read(`brands/${n}.brand.json`) as Brand, { ...cfg, runtime: { ...cfg.runtime, beacon: { ...cfg.runtime.beacon, site: n } } }, { copy: d });
      expect(site.copyUsed.length).toBe(d.entries.length);
    });
  }
});

describe("copy deck rules", () => {
  it("the garden deck passes", () => expect(validateCopyDeck(deck, bp, brief)).toEqual([]));
  const bad = (entries: CopyDeck["entries"]) => validateCopyDeck({ ...deck, entries }, bp, brief);
  it("FAQ prices follow the lowest observed price (QA-021 B3-1)", () => {
    expect(deck.entries.find((e) => e.key === "*#faq.c_g_obj_cheap")!.text).toContain("$1.99");
    expect(deck.entries.find((e) => e.key === "*#faq.c_g_obj_free")!.text).not.toMatch(/don't include|do not include/);
  });
  it("refuses proof the business does not have", () => {
    expect(bad([{ key: "*#picture.after", text: "Loved by gardeners: 5 stars from our reviews.", basis: [] }]).join()).toMatch(/proof/);
  });
  it("refuses figures that are not in the blueprint or cited claims", () => {
    expect(bad([{ key: "*#picture.after", text: "Saves 3 hours a week.", basis: [] }]).join()).toMatch(/figure 3/);
    expect(bad([{ key: "*#faq.c_g_obj_cheap", text: "From $3.99 elsewhere.", basis: ["c_g_obj_cheap"] }])).toEqual([]);
  });
  it("refuses legal/operator markers and unknown claims", () => {
    expect(bad([{ key: "*#legal.operator", text: "Run by someone", basis: [] }]).join()).toMatch(/cannot be filled/);
    expect(bad([{ key: "*#picture.after", text: "x", basis: ["c_nope"] }]).join()).toMatch(/unknown claim/);
  });
});

describe("Garden Season Kit draft", () => {
  const data = kitData("2026-11-10T00:00:00Z");
  it("builds the sample sheet from the same calendar as the site", () => {
    expect(data.sample).toMatchObject({ zip: "55401", season: 2027 });
    const all = data.sample.months.flatMap((m) => m.rows);
    expect(all.length).toBe(buildCalendar(parseMonthDay(lookupZip("55401", loadShard("554")).station!.last_spring, 2027)!, loadCrops().crops).length);
  });
  const python = (() => { try { execFileSync("python3", ["-c", "import reportlab, pypdf"], { stdio: "ignore" }); return true; } catch { return false; } })();
  it.runIf(python)("renders Letter and A4 PDFs reproducibly (python3 + reportlab; also run by npm run kit:test)", () => {
    const out = mkdtempSync(join(tmpdir(), "kit-"));
    const dataPath = join(out, "kit-data.json");
    writeFileSync(dataPath, JSON.stringify(data));
    execFileSync("python3", [join(B, "products/garden-planner/kit/build_kit.py"), "--data", dataPath, "--out", out]);
    const pages = (f: string) => Number(execFileSync("python3", ["-c", `import pypdf,sys;print(len(pypdf.PdfReader(sys.argv[1]).pages))`, join(out, f)], { encoding: "utf8" }).trim());
    expect(pages("garden-season-kit.letter.pdf")).toBe(10);
    expect(pages("garden-season-kit.a4.pdf")).toBe(10);
    const text = execFileSync("python3", ["-c", `import pypdf,sys;print(pypdf.PdfReader(sys.argv[1]).pages[0].extract_text())`, join(out, "personal-calendar.sample-55401.letter.pdf")], { encoding: "utf8" });
    expect(text).toContain("SAMPLE for ZIP 55401");
    expect(text).toMatch(/NOAA 1991-2020/);
    const first = readFileSync(join(out, "garden-season-kit.letter.pdf"));
    execFileSync("python3", [join(B, "products/garden-planner/kit/build_kit.py"), "--data", dataPath, "--out", out]);
    expect(readFileSync(join(out, "garden-season-kit.letter.pdf")).equals(first)).toBe(true);
    expect(PREVIEWS.length).toBe(4);
  });
});
