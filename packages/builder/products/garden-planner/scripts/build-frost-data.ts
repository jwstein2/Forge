/**
 * Builds the ZIP -> nearest frost-normals station lookup used by the Garden Planner calculator.
 *
 *   node --experimental-strip-types products/garden-planner/scripts/build-frost-data.ts \
 *     --normals <dir of NOAA annual/seasonal by-station CSVs> --zips <zip,lat,lng CSV> --out products/garden-planner/data/frost
 *
 * Inputs (public, free, no account):
 *   - NOAA NCEI U.S. Climate Normals 1991-2020, annual/seasonal, multivariate by station (CC0), from the NOAA open-data
 *     bucket: s3://noaa-normals-pds/normals-annualseasonal/1991-2020/archive/
 *       us-climate-normals_1991-2020_v1.0.1_annualseasonal_multivariate_by-station_c20230404.tar.gz
 *   - Census 2025 ZCTA Gazetteer internal points (public domain), as zip,lat,lng (packaged in us-zip-centroids@1.2.0 data/zip_centroids.csv).
 * Output: one JSON shard per 3-digit ZIP prefix plus index.json with input hashes. Deterministic for the same inputs.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { haversineKm, parseMonthDay } from "../calendar.js";

export const MAX_KM = 150; // farther than this, the calculator asks for a date instead of guessing
const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

export interface Station { name: string; lat: number; lon: number; elev_m: number | null; last_spring: string; first_fall: string; freeze_chance_pct: number | null; completeness: string; years: number }

/** Minimal CSV line parser for the NOAA files (quoted fields, commas inside quotes). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** One NOAA station CSV -> Station, or null when the 50% 32F freeze dates are missing (-9999) or malformed. */
export function stationFromCsv(text: string): [string, Station] | null {
  const [head, row] = text.split(/\r?\n/).filter((l) => l.trim());
  if (!head || !row) return null;
  const h = parseCsvLine(head); const r = parseCsvLine(row);
  const get = (k: string) => { const i = h.indexOf(k); return i >= 0 ? (r[i] ?? "").trim() : ""; };
  const lst = get("ANN-TMIN-PRBLST-T32FP50"), fst = get("ANN-TMIN-PRBFST-T32FP50");
  if (!parseMonthDay(lst, 2001) || !parseMonthDay(fst, 2001)) return null;
  const lat = Number(get("LATITUDE")), lon = Number(get("LONGITUDE"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const elev = Number(get("ELEVATION"));
  return [get("STATION"), {
    name: get("NAME"), lat, lon, elev_m: Number.isFinite(elev) && elev > -999 ? elev : null,
    last_spring: lst.padStart(5, "0"), first_fall: fst.padStart(5, "0"),
    freeze_chance_pct: (() => { const v = Number(get("ANN-TMIN-PRBOCC-LSTH032")); return get("ANN-TMIN-PRBOCC-LSTH032") !== "" && Number.isFinite(v) && v >= 0 ? v : null; })(),
    completeness: get("comp_flag_ANN-TMIN-PRBLST-T32FP50") || "?", years: Number(get("years_ANN-TMIN-PRBLST-T32FP50")) || 0,
  }];
}

/** Nearest station within MAX_KM for each ZIP, using a 1-degree grid so it runs in seconds. */
export function nearest(zips: [string, number, number][], stations: Map<string, Station>): Map<string, [string, number] | null> {
  const grid = new Map<string, [string, Station][]>();
  const cell = (lat: number, lon: number) => `${Math.floor(lat)}:${Math.floor(lon)}`;
  for (const [id, s] of stations) { const k = cell(s.lat, s.lon); (grid.get(k) ?? grid.set(k, []).get(k)!).push([id, s]); }
  const out = new Map<string, [string, number] | null>();
  for (const [zip, lat, lon] of zips) {
    let best: [string, number] | null = null;
    const span = Math.ceil(MAX_KM / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))) + 1;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -span; dx <= span; dx++) {
      for (const [id, s] of grid.get(`${Math.floor(lat) + dy}:${Math.floor(lon) + dx}`) ?? []) {
        const km = haversineKm(lat, lon, s.lat, s.lon);
        if (km <= MAX_KM && (!best || km < best[1] || (km === best[1] && id < best[0]))) best = [id, km];
      }
    }
    out.set(zip, best ? [best[0], Math.round(best[1] * 10) / 10] : null);
  }
  return out;
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

if (import.meta.url === `file://${process.argv[1]}`) {
  const normals = flag("--normals"), zipsPath = flag("--zips"), out = flag("--out");
  if (!normals || !zipsPath || !out) { console.error("usage: build-frost-data --normals <dir> --zips <csv> --out <dir>"); process.exit(2); }
  const stations = new Map<string, Station>(); let skipped = 0;
  const files = readdirSync(normals).filter((f) => f.endsWith(".csv")).sort();
  const listHash = createHash("sha256");
  for (const f of files) {
    const text = readFileSync(join(normals, f), "utf8"); listHash.update(f).update(sha(text));
    const s = stationFromCsv(text); if (s) stations.set(s[0], s[1]); else skipped++;
  }
  const zipText = readFileSync(zipsPath, "utf8");
  const zips = zipText.split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(",")).map(([z, la, lo]) => [z!, Number(la), Number(lo)] as [string, number, number]);
  const near = nearest(zips, stations);
  const shards = new Map<string, { stations: Record<string, Station>; zips: Record<string, [string, number] | null> }>();
  for (const [zip] of zips) {
    const k = zip.slice(0, 3); const sh = shards.get(k) ?? shards.set(k, { stations: {}, zips: {} }).get(k)!;
    const hit = near.get(zip) ?? null; sh.zips[zip] = hit; if (hit) sh.stations[hit[0]] = stations.get(hit[0])!;
  }
  const dir = resolve(out); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  for (const [k, sh] of [...shards].sort()) writeFileSync(join(dir, `${k}.json`), JSON.stringify(sh));
  const covered = [...near.values()].filter(Boolean).length;
  writeFileSync(join(dir, "index.json"), JSON.stringify({
    kind: "garden-planner-frost-lookup", version: "1.0.0", max_km: MAX_KM,
    element: "ANN-TMIN-PRBLST-T32FP50 (50% probability last spring 32F date), ANN-TMIN-PRBFST-T32FP50 (50% first fall 32F date), ANN-TMIN-PRBOCC-LSTH032 (% of years with a 32F freeze)",
    rare_freeze_rule: "When freeze_chance_pct < 50, a 32F freeze happens in fewer than half of years, so the calculator does not build a frost-keyed calendar automatically.",
    sources: [
      { id: "src_ncei_normals_1991_2020", title: "NOAA NCEI U.S. Climate Normals 1991-2020, annual/seasonal by station", licence: "CC0 1.0 (public domain)", url: "https://noaa-normals-pds.s3.amazonaws.com/normals-annualseasonal/1991-2020/archive/us-climate-normals_1991-2020_v1.0.1_annualseasonal_multivariate_by-station_c20230404.tar.gz", files: files.length, files_sha256: listHash.digest("hex") },
      { id: "src_census_zcta_2025", title: "US Census Bureau 2025 ZCTA Gazetteer internal points (via us-zip-centroids 1.2.0)", licence: "Public domain (US Government work)", url: "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip", sha256: sha(zipText) },
    ],
    stations_with_freeze_dates: stations.size, stations_skipped: skipped, zips: zips.length, zips_with_station: covered, shards: shards.size,
  }, null, 1) + "\n");
  console.log(`${stations.size} stations (${skipped} without 32F freeze dates), ${covered}/${zips.length} ZIPs within ${MAX_KM} km, ${shards.size} shards -> ${dir}`);
}
