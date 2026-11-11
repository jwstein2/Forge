// Frost Date Planting calculator UI. Runs in the browser only; the ZIP and dates never leave the device.
// Builds DOM with textContent (no innerHTML from input). No inline handlers, no third-party code.
import { buildCalendar, byMonth, freezeIsRare, lookupZip, normalizeZip, parseIsoDate, parseMonthDay, range, seasonYear, shardPath, shortDate, COMPLETENESS } from "./garden-calendar.js";

let cropsPromise = null;
const crops = () => (cropsPromise ??= fetch("/data/crops.json").then((r) => { if (!r.ok) throw new Error("crops"); return r.json(); }));

function el(tag, text, attrs = {}) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function renderTable(out, lastFrost, list, heading) {
  const rows = buildCalendar(lastFrost, list);
  out.append(el("h3", heading));
  const wrap = el("div", null, { class: "table-wrap", tabindex: "0", role: "region", "aria-label": heading });
  const t = el("table");
  const head = el("thead"); const hr = el("tr");
  for (const h of ["When", "What", "Crop"]) hr.append(el("th", h, { scope: "col" }));
  head.append(hr); t.append(head);
  const body = el("tbody");
  for (const m of byMonth(rows)) {
    const mr = el("tr"); mr.append(el("th", m.month, { colspan: "3", scope: "rowgroup" })); body.append(mr);
    for (const r of m.rows) { const tr = el("tr"); tr.append(el("td", range(r.from, r.to)), el("td", r.label), el("td", r.name)); body.append(tr); }
  }
  t.append(body); wrap.append(t); out.append(wrap);
  const print = el("button", "Print this calendar", { type: "button", class: "btn btn-warm calc-print" });
  print.addEventListener("click", () => window.print());
  out.append(print);
}

async function onSubmit(form, out) {
  out.replaceChildren();
  const data = await crops();
  const list = form.dataset.crop ? data.crops.filter((c) => c.id === form.dataset.crop) : data.crops;
  const year = seasonYear(new Date());
  const typed = parseIsoDate(form.elements.date.value);
  if (typed) {
    out.append(el("p", `Using your last-frost date: ${shortDate(typed)} ${typed.getUTCFullYear()}.`));
    renderTable(out, typed, list, "Your planting calendar");
    return;
  }
  const zip = normalizeZip(form.elements.zip.value);
  if (!zip) { out.append(el("p", "Enter a 5-digit ZIP code, or pick your own last-frost date.", { class: "calc-msg" })); form.elements.zip.focus(); return; }
  let shard = null;
  try { const r = await fetch(shardPath(zip)); if (r.ok) shard = await r.json(); } catch { /* offline: handled below */ }
  const hit = lookupZip(zip, shard);
  if (!hit.station) {
    const why = hit.reason === "no_station_nearby"
      ? "There is no frost-normals weather station with frost dates within 150 km of this ZIP. In many such places a 32°F frost is rare."
      : "We don't have this ZIP in the Census ZIP areas (PO-box and single-building ZIPs have none).";
    out.append(el("p", `${why} Pick your own last-frost date above to build a calendar.`, { class: "calc-msg" }));
    return;
  }
  const s = hit.station;
  const lf = parseMonthDay(s.last_spring, year); const ff = parseMonthDay(s.first_fall, year);
  out.append(el("p", `Nearest station: ${s.name}, ${hit.km} km away${s.elev_m != null ? `, elevation ${Math.round(s.elev_m)} m` : ""}. Data: ${COMPLETENESS[s.completeness] ?? "see NOAA documentation"}.`));
  if (freezeIsRare(s)) {
    out.append(el("p", `A 32°F frost happens in only about ${Math.round(s.freeze_chance_pct)}% of years at this station, so a calendar keyed to a spring frost date doesn't fit well here. If you want one anyway, pick a date above. Your local extension office publishes planting dates for frost-free areas.`, { class: "calc-msg" }));
    return;
  }
  out.append(el("p", `Estimated last spring frost: ${shortDate(lf)} (half of years have a later frost). First fall frost: around ${shortDate(ff)}. Source: NOAA 1991-2020 climate normals.`));
  renderTable(out, lf, list, `Your ${year} planting calendar`);
}

for (const form of document.querySelectorAll("form[data-garden-calc]")) {
  const out = form.parentElement.querySelector("[data-garden-out]") ?? form.nextElementSibling;
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    onSubmit(form, out).catch(() => { out.replaceChildren(el("p", "Sorry, the calendar data didn't load. Check your connection and try again.", { class: "calc-msg" })); });
  });
}
