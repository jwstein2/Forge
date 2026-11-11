/**
 * Garden Planner site module: the free planting-calendar calculator, one page per crop, and the data they use.
 * Everything shown is computed from data/crops.json (cited planting tables) and data/frost/ (NOAA 1991-2020 normals
 * + Census ZIP points). No marketing claims live here; page wording is reviewed under G2 with the rest of the site.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SiteModule } from "../../src/site/scaffold.ts";
import type { LaunchBlueprint } from "../../src/types.ts";
import { ACTIONS, buildCalendar, byMonth, lookupZip, parseMonthDay, range, seasonYear, shortDate, COMPLETENESS } from "./calendar.js";

const HERE = import.meta.dirname;
export interface CropTiming { from_weeks: number; to_weeks: number }
export interface Crop { id: string; name: string; kind: string; start_indoors: CropTiming | null; transplant: CropTiming | null; direct_sow: CropTiming | null; source_id: string; note: string | null }
export interface CropData { version: string; relative_to: string; sources: Record<string, { title: string; url: string; accessed: string; use: string }>; crops: Crop[] }

export const loadCrops = (): CropData => JSON.parse(readFileSync(join(HERE, "data", "crops.json"), "utf8"));
export const loadShard = (prefix: string) => JSON.parse(readFileSync(join(HERE, "data", "frost", `${prefix}.json`), "utf8"));
/** The worked example everywhere uses one real ZIP, labelled as an example. */
export const EXAMPLE_ZIP = "55401";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Human text for a crop timing relative to the last-frost date. */
export function timingText(t: CropTiming): string {
  const wk = (n: number) => `${n} week${n === 1 ? "" : "s"}`;
  const one = (n: number) => (n === 0 ? "on your last-frost date" : `${wk(Math.abs(n))} ${n < 0 ? "before" : "after"} your last-frost date`);
  const { from_weeks: f, to_weeks: to } = t;
  if (f === to) return one(f);
  if (f < 0 && to < 0) return `${-to} to ${wk(-f)} before your last-frost date`;
  if (f > 0 && to > 0) return `${f} to ${wk(to)} after your last-frost date`;
  if (f === 0) return `from your last-frost date to ${wk(to)} after`;
  if (to === 0) return `from ${wk(-f)} before up to your last-frost date`;
  return `from ${wk(-f)} before to ${wk(to)} after your last-frost date`;
}

function calcForm(crop: string | null): string {
  return `<form class="calc" data-garden-calc${crop ? ` data-crop="${esc(crop)}"` : ""} novalidate>
<label>ZIP code<input name="zip" inputmode="numeric" autocomplete="postal-code" pattern="[0-9]{5}" maxlength="10" placeholder="e.g. ${EXAMPLE_ZIP}"></label>
<p class="calc-or">or</p>
<label>Your own last-frost date<input name="date" type="date"></label>
<button class="btn" type="submit">Make my calendar</button>
</form>
<div class="calc-out" data-garden-out aria-live="polite"></div>
<noscript><p>The calculator needs JavaScript. The week offsets on each crop page work without it: count back from your last-frost date.</p></noscript>`;
}

function exampleTable(crops: Crop[], filter: string[] | null, year: number): string {
  const r = lookupZip(EXAMPLE_ZIP, loadShard(EXAMPLE_ZIP.slice(0, 3)));
  if (!r.station) throw new Error(`example ZIP ${EXAMPLE_ZIP} has no station`);
  const s = r.station; const lf = parseMonthDay(s.last_spring, year)!;
  const rows = buildCalendar(lf, filter ? crops.filter((c) => filter.includes(c.id)) : crops);
  const body = byMonth(rows).map((m) => `<tr><th colspan="3" scope="rowgroup">${esc(m.month)}</th></tr>${m.rows.map((x) => `<tr><td>${esc(range(x.from, x.to))}</td><td>${esc(x.label)}</td><td>${esc(x.name)}</td></tr>`).join("")}`).join("");
  return `<p>Example only: ZIP ${EXAMPLE_ZIP} (Minneapolis). Nearest frost-normals station: ${esc(s.name)}, ${r.km} km away. Estimated last spring frost ${esc(shortDate(lf))} (half of years have a later frost), first fall frost ${esc(shortDate(parseMonthDay(s.first_fall, year)!))}. Dates for the ${year} season.</p>
<div class="table-wrap" tabindex="0" role="region" aria-label="Example planting calendar"><table><thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">Crop</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function cropPage(c: Crop, data: CropData, year: number): { path: string; title: string; body: string } {
  const src = data.sources[c.source_id]!;
  const lines = (Object.keys(ACTIONS) as (keyof typeof ACTIONS)[]).filter((a) => c[a]).map((a) => `<li><strong>${esc(ACTIONS[a])}:</strong> ${esc(timingText(c[a]!))}</li>`);
  return {
    path: `/when-to-plant/${c.id}/`, title: `When to plant ${c.name.toLowerCase()}`,
    body: `<section class="hero"><h1>When to plant ${esc(c.name.toLowerCase())}</h1><p class="lede">Timed from your last spring frost date. Enter a ZIP code to get the dates for your area.</p></section>
<section><h2>Timing</h2><ul class="ticks">${lines.join("")}</ul><p class="btn-note">Source: <a href="${esc(src.url)}">${esc(src.title)}</a>${c.note ? `. ${esc(c.note)}` : ""}. General guidance, not local advice: check seed packets and your local extension office.</p></section>
<section class="panel"><h2>Your ${esc(c.name.toLowerCase())} dates</h2>${calcForm(c.id)}</section>
<section><h2>Worked example</h2>${exampleTable(data.crops, [c.id], year)}</section>
<p><a href="/tools/">Full planting calendar for about 30 crops</a> · <a href="/when-to-plant/">All crops</a></p>`,
  };
}

/** Preview images of real kit pages, as built by kit/build.ts (name, alt). */
export interface Preview { name: string; alt: string; bytes: Uint8Array }

export function gardenModule(opts: { generatedAt: string; bp?: LaunchBlueprint; previews?: Preview[] }): SiteModule {
  const data = loadCrops();
  const core = opts.bp?.products.find((p) => p.product_id === opts.bp!.sales_framework.cta.product_id) ?? null;
  const corePage = core ? opts.bp!.page_map.find((p) => p.purpose.endsWith(core.name))?.path ?? null : null;
  const previews = opts.previews ?? [];
  const year = seasonYear(new Date(opts.generatedAt));
  const frostDir = join(HERE, "data", "frost");
  const files: Record<string, string | Uint8Array> = {
    "assets/garden-calendar.js": readFileSync(join(HERE, "calendar.js"), "utf8"),
    "assets/garden-ui.js": readFileSync(join(HERE, "garden-ui.js"), "utf8"),
    "data/crops.json": readFileSync(join(HERE, "data", "crops.json"), "utf8"),
  };
  for (const p of previews) files[`assets/previews/${p.name}`] = p.bytes;
  for (const f of readdirSync(frostDir).filter((f) => f.endsWith(".json")).sort()) files[`data/frost/${f}`] = readFileSync(join(frostDir, f), "utf8");
  const cropLinks = data.crops.map((c) => `<li><a href="/when-to-plant/${c.id}/">${esc(c.name)}</a></li>`).join("");
  const toolIntro = `<section><h1>Planting calendar</h1><p class="lede">Enter your ZIP code to get sowing and planting dates for about 30 vegetables and herbs, timed from your estimated last spring frost.</p>
<div class="panel">${calcForm(null)}</div>
<p class="btn-note">Frost dates are estimates: the 1991-2020 NOAA climate normal at the nearest weather station (the date after which half of years have no 32°F frost), with the station name and distance shown. Your garden can be colder or warmer than the station.</p></section>`;
  return {
    id: "garden-planner-calendar@1.0.0",
    sections: {
      "/tools/#tool": () => toolIntro + `<script type="module" src="/assets/garden-ui.js"></script>`,
      "/tools/#how-to-use": () => `<section><h2>How to use it</h2><ol class="plan"><li>Enter your ZIP code, or type your own last-frost date if you know it.</li><li>Check the station and distance. If you are much higher or lower than the station, adjust your date.</li><li>Print the calendar or keep the page open. Each row says when to start seeds indoors, plant seedlings out, or sow outdoors.</li></ol></section>`,
      "/tools/#worked-example": () => `<section><h2>Worked example</h2>${exampleTable(data.crops, ["peas", "lettuce", "tomato", "beans"], year)}</section>`,
      "/tools/#related-resources": () => `<section><h2>Crop by crop</h2><ul class="crop-list">${cropLinks}</ul></section>`,
      ...(corePage && core && previews.length ? {
        [`${corePage}#proof`]: () => `<section><h2>See it before you buy</h2><p>Try the <a href="/tools/">free planting calendar</a> with your ZIP code: the kit's calendar uses the same frost data and crop timings. Page previews of the kit are below.</p><p class="lede">No reviews or results are shown until real customers have given them.</p></section>`,
        [`${corePage}#whats-inside-previews`]: () => `<section><h2>What's inside</h2><ul class="ticks">${core.must_include.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
<div class="grid previews">${previews.map((p) => `<figure class="panel"><img src="/assets/previews/${esc(p.name)}" alt="${esc(p.alt)}" width="510" height="660" loading="lazy"><figcaption class="btn-note">${esc(p.alt)}</figcaption></figure>`).join("")}</div>
<p>Format: ${esc(core.format)}</p><p class="btn-note">Previews are rendered from the actual draft files. The personal calendar shown is a labelled sample for ZIP ${EXAMPLE_ZIP}.</p></section>`,
      } : {}),
      "/#free-tools": () => `<section><h2>Free planting calendar</h2><p>Enter a ZIP code and get dates for about 30 crops from the nearest NOAA frost record. <a href="/tools/">Make your calendar</a>.</p></section>`,
    },
    pages: [
      { path: "/when-to-plant/", title: "When to plant: crop by crop", body: `<section class="hero"><h1>When to plant, crop by crop</h1><p class="lede">Sowing and planting times for each crop, counted from your last spring frost.</p></section><section><ul class="crop-list">${cropLinks}</ul></section>` },
      ...data.crops.map((c) => cropPage(c, data, year)),
    ].map((p) => ({ ...p, body: p.body + (p.path.startsWith("/when-to-plant/") && p.path !== "/when-to-plant/" ? `<script type="module" src="/assets/garden-ui.js"></script>` : "") })),
    files,
    privacy: [`<h2>Planting calendar</h2><p>When you enter a ZIP code, your browser downloads a small public data file named after the first three digits of the ZIP (for example /data/frost/554.json) and finds your station on your device. The full ZIP code and any date you enter stay in your browser.</p>`],
    sources: [
      `| Frost dates (data/frost/) | [NOAA NCEI U.S. Climate Normals 1991-2020](https://noaa-normals-pds.s3.amazonaws.com/normals-annualseasonal/1991-2020/archive/us-climate-normals_1991-2020_v1.0.1_annualseasonal_multivariate_by-station_c20230404.tar.gz) | NOAA NCEI | CC0 1.0 | Yes | Credit NOAA NCEI (courtesy) | 2026-11-11 | /tools/, /when-to-plant/* |`,
      `| ZIP points (data/frost/) | [Census 2025 ZCTA Gazetteer](https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip), via npm us-zip-centroids@1.2.0 | US Census Bureau | Public domain | Yes | None required | 2026-11-11 | /tools/, /when-to-plant/* |`,
      ...previews.map((p) => `| ${p.name} | Rendered from the kit draft (kit/build_kit.py) | FORGE | Own work | Yes | None | 2026-11-11 | ${corePage ?? "product page"} |`),
      ...Object.entries(data.sources).map(([id, s]) => `| Crop timings (data/crops.json, ${id}) | [${s.title}](${s.url}) | Publisher | Facts with attribution; reuse licence not stated | Needs G8 decision | Cited on each crop page | ${s.accessed} | /tools/, /when-to-plant/* |`),
    ],
  };
}

export { COMPLETENESS };
