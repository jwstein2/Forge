/**
 * Garden Planner planting calendar: pure functions shared by the browser calculator, the kit builder data export and the tests.
 * Plain ES module, no dependencies, no network. Dates are calendar dates (UTC), never times.
 *
 * Honesty rules: frost dates are 1991-2020 NOAA climate normals (50% last-spring 32F date) from the nearest station,
 * shown as estimates with the station name and distance. Crop timings are general guidance from cited sources.
 */

const DAY = 86400000;

/** "05/11" + 2027 -> Date (UTC midnight). Returns null for anything that is not a real MM/DD. */
export function parseMonthDay(md, year) {
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(String(md ?? "").trim());
  if (!m) return null;
  const month = Number(m[1]), day = Number(m[2]);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null;
}

/** "2027-05-11" -> Date (UTC midnight) or null. */
export function parseIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}` ? d : null;
}

export const iso = (d) => d.toISOString().slice(0, 10);
export const addWeeks = (d, w) => new Date(d.getTime() + w * 7 * DAY);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Date -> "May 11" */
export const shortDate = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
/** Two dates -> "Mar 2 to Mar 16", or one date when equal. */
export const range = (a, b) => (a.getTime() === b.getTime() ? shortDate(a) : `${shortDate(a)} to ${shortDate(b)}`);

export const ACTIONS = { start_indoors: "Start indoors", transplant: "Plant out seedlings", direct_sow: "Sow outdoors" };

/**
 * The planting season a visitor is planning: the current year until July, the next year after that
 * (a calendar built in November is for next spring).
 */
export function seasonYear(today) {
  return today.getUTCMonth() >= 6 ? today.getUTCFullYear() + 1 : today.getUTCFullYear();
}

/**
 * One frost date + crop table -> dated tasks, earliest first (ties keep crop order).
 * crops: entries of data/crops.json; each timing is {from_weeks, to_weeks} relative to the last-frost date, or null.
 */
/**
 * @param {Date} lastFrost
 * @param {any[]} crops
 * @returns {{ crop: string, name: string, action: string, label: string, from: Date, to: Date }[]}
 */
export function buildCalendar(lastFrost, crops) {
  if (!(lastFrost instanceof Date) || Number.isNaN(lastFrost.getTime())) throw new TypeError("lastFrost must be a Date");
  const rows = [];
  crops.forEach((c, order) => {
    for (const action of Object.keys(ACTIONS)) {
      const t = c[action];
      if (!t) continue;
      if (t.from_weeks > t.to_weeks) throw new RangeError(`${c.id}.${action}: from_weeks after to_weeks`);
      rows.push({ crop: c.id, name: c.name, action, label: ACTIONS[action], from: addWeeks(lastFrost, t.from_weeks), to: addWeeks(lastFrost, t.to_weeks), order });
    }
  });
  rows.sort((a, b) => a.from - b.from || a.order - b.order || Object.keys(ACTIONS).indexOf(a.action) - Object.keys(ACTIONS).indexOf(b.action));
  return rows.map(({ order, ...r }) => r);
}

/**
 * Group tasks by the month they start in: [{month: "Mar 2027", rows: [...]}].
 * @template {{ from: Date }} T
 * @param {T[]} rows
 */
export function byMonth(rows) {
  /** @type {{ month: string, rows: typeof rows }[]} */
  const out = [];
  for (const r of rows) {
    const key = `${MONTHS[r.from.getUTCMonth()]} ${r.from.getUTCFullYear()}`;
    if (!out.length || out[out.length - 1].month !== key) out.push({ month: key, rows: [] });
    out[out.length - 1].rows.push(r);
  }
  return out;
}

/** Great-circle distance in km. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180, R = 6371.0088;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A 5-digit ZIP string, or null. Leading zeros matter, so numbers are refused. */
export function normalizeZip(z) {
  if (typeof z !== "string") return null;
  const m = /^\s*(\d{5})(?:-\d{4})?\s*$/.exec(z);
  return m ? m[1] : null;
}

/** Shard file for a ZIP: data shards are split by the first three digits. */
export const shardPath = (zip) => `/data/frost/${zip.slice(0, 3)}.json`;

/**
 * Resolve a ZIP inside its shard -> { zip, station: {...}, km } | { zip, station: null, reason }.
 * Shard shape: { stations: { [id]: {name, lat, lon, elev_m, last_spring, first_fall, freeze_chance_pct, completeness, years} }, zips: { [zip]: [id, km] | null } }
 */
export function lookupZip(zip, shard) {
  const z = normalizeZip(zip);
  if (!z) return { zip, station: null, reason: "not_a_zip" };
  const hit = shard?.zips?.[z];
  if (hit === undefined) return { zip: z, station: null, reason: "zip_not_covered" };
  if (hit === null) return { zip: z, station: null, reason: "no_station_nearby" };
  const s = shard.stations[hit[0]];
  return s ? { zip: z, station: { id: hit[0], ...s }, km: hit[1] } : { zip: z, station: null, reason: "zip_not_covered" };
}

/** A 32F freeze happens in fewer than half of years: a frost-keyed spring calendar does not fit (south Florida, low desert). */
export const freezeIsRare = (station) => station.freeze_chance_pct != null && station.freeze_chance_pct < 50;

export const COMPLETENESS = { S: "standard (24+ years of data)", R: "representative (10+ years)", P: "provisional (10+ years, some gaps)", E: "estimated from nearby stations" };
