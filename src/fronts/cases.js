/**
 * Fälle für die Frontenanalyse (Fixture-Format v2) abrufen und aufbereiten: mehrere
 * Termine, Druckflächen und Oberflächenfelder eines Modells auf einem
 * Raster. Gemeinsame Grundlage von `tools/fronts/fetch-case.mjs`
 * (Testfälle) und `tools/fronts/run-analysis.mjs` (laufende Analyse).
 *
 * Das Ergebnis ist ein reines JSON-Objekt (gerundete Zahlen, null statt
 * NaN), bereit zum Schreiben. Vor der Analyse mit `typedCase` in
 * typisierte Arrays wandeln.
 */

import { fetchPlaneField, fieldAt, mergeFields, DEFAULT_SURFACE } from "./field.js";
import { fetchModelRunInit } from "../weather.js";

/**
 * Gebiete der zusammengesetzten Analyse: ICON-EU innen (West- und Südrand =
 * Modellrand, auf das 0,0625°-Gitter ausgerichtet, damit "nearest" exakt
 * trifft), ICON Global außen (bis 80° W, s. README `mergeFields`).
 */
export const CASE_DOMAINS = {
  icon_eu: { latMin: 30, latMax: 70, lonMin: -23.5, lonMax: 44.5 },
  icon_global: { latMin: 25, latMax: 78, lonMin: -80, lonMax: 60 },
};

// Levelbereich für 500 hPa (Stichproben in field.js: ICON-EU Level 48 ≈ 530,
// 38 ≈ 350 hPa; ICON Global 96 ≈ 550–585, 88 ≈ 390–430 hPa), mit Reserve für
// tiefe Kerne, in denen die Fläche tiefer liegt.
export const UPPER_LEVELS = { icon_eu: [36, 54], icon_global: [84, 100] };

// Rundung je Feld: genug für Gradienten/Tendenzen, klein genug fürs Archiv.
const DIGITS = { T: 2, q: 6, u: 2, v: 2, w: 3, psfc: 1, u10: 2, v10: 2 };
const SFC_DIGITS = { pressure_msl: 1, temperature_2m: 1, dew_point_2m: 1 }; // sonst 1 bzw. ganzzahlig

const UNITS = {
  T: "K", q: "kg/kg", u: "m/s", v: "m/s", w: "m/s", psfc: "hPa", u10: "m/s", v10: "m/s",
  pressure_msl: "hPa", precipitation: "mm/h", rain: "mm/h", showers: "mm/h",
  cloud_cover: "%", temperature_2m: "°C", dew_point_2m: "°C", cape: "J/kg", thickness: "gpm (500/1000 hPa)",
};

const round = (arr, digits) => Array.from(arr, (x) => (Number.isFinite(x) ? +x.toFixed(digits) : null));

/** Termine von `start` bis `end` (je "YYYY-MM-DDTHH:00", UTC) im Abstand `stepH`. */
export function caseTimes(start, end = start, stepH = 3) {
  const times = [];
  for (let t = Date.parse(`${start}Z`); t <= Date.parse(`${end}Z`); t += stepH * 3600e3) {
    times.push(new Date(t).toISOString().slice(0, 16));
  }
  return times;
}

/**
 * @param {object} opts
 * @param {string} [opts.model="icon_eu"]
 * @param {string[]} opts.times             Gültigkeitszeiten, aufsteigend, gleicher Abstand.
 * @param {object} [opts.bbox]              Default `CASE_DOMAINS[model]`.
 * @param {number} [opts.res=0.5]
 * @param {number[]} [opts.pressures]       Default 850,700 bzw. 500 mit `upper`.
 * @param {boolean} [opts.upper=false]      Nur Höhenflächen (ohne Oberfläche und
 *   Schichtdicke) aus den oberen Modellleveln -- Ergänzung zum Fall gleichen
 *   Namens und Rasters.
 * @param {Function} [opts.onProgress]     (time, fertig, gesamt) => void
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<object>} Fixture v2 (JSON-fähig).
 */
export async function fetchCase({
  model = "icon_eu", times, bbox = CASE_DOMAINS[model], res = 0.5, pressures, upper = false, onProgress, fetchImpl,
} = {}) {
  if (!times?.length) throw new Error("fetchCase: keine Termine");
  if (!bbox) throw new Error(`fetchCase: kein Gebiet für ${model}`);
  pressures ||= upper ? [500] : [850, 700];
  const stepH = times.length > 1 ? Math.round((Date.parse(`${times[1]}Z`) - Date.parse(`${times[0]}Z`)) / 3600e3) : 3;
  const runInit = await fetchModelRunInit(model, fetchImpl);
  const steps = [];
  let heights = null; // Levelhöhen: zeitlich konstant, nur beim ersten Termin holen
  for (const time of times) {
    const f = await fetchPlaneField({
      model, bbox, res, time, pressures, fetchImpl,
      ...(upper ? { surface: [], thickness: false, levels: UPPER_LEVELS[model] } : { surface: DEFAULT_SURFACE, thickness: true, heights }),
      onProgress: (d, n) => onProgress?.(time, d, n),
    });
    heights = f.heights;
    const levels = {};
    for (const p of pressures) {
      const L = f.levels[p];
      levels[p] = { below: Array.from(L.below) };
      for (const key of ["T", "q", "u", "v", "w"]) levels[p][key] = round(L[key], DIGITS[key]);
    }
    // Vorlauf relativ zum letzten Lauf beim Abruf: <= 0 heißt, die Stunde
    // stammt aus einem Lauf zu oder kurz vor diesem Termin (Analyse).
    const lead = runInit ? Math.round((Date.parse(`${time}Z`) / 1000 - runInit) / 3600) : null;
    const leadH = lead != null && lead > 0 ? lead : 0;
    if (upper) { steps.push({ validTime: time, leadH, levels }); continue; }
    const sfc = {};
    for (const [k, arr] of Object.entries(f.sfc)) sfc[k] = round(arr, SFC_DIGITS[k] ?? (k.startsWith("cloud") || k === "cape" ? 0 : 2));
    steps.push({
      validTime: time, leadH, levels, psfc: round(f.psfc, DIGITS.psfc), u10: round(f.u10, 2), v10: round(f.v10, 2), sfc,
      thickness: round(f.thickness, 0),
    });
  }
  return {
    version: 2, model, ...(upper ? { upper: true } : {}), res, lat0: bbox.latMin, lon0: bbox.lonMin,
    nx: Math.round((bbox.lonMax - bbox.lonMin) / res) + 1, ny: Math.round((bbox.latMax - bbox.latMin) / res) + 1,
    pressures, stepH, times,
    lastRunAtFetch: runInit ? new Date(runInit * 1000).toISOString() : null,
    fetchedAt: new Date().toISOString(),
    units: UNITS,
    steps,
  };
}

/**
 * Fixture nach dem Einlesen analysefertig machen: Felder als typisierte
 * Arrays, null -> NaN (`below` als Uint8Array). Ändert das Objekt an Ort
 * und Stelle und gibt es zurück.
 */
export function typedCase(fixture) {
  const typed = (obj) => {
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.length > 1000) obj[k] = k === "below" ? Uint8Array.from(v) : Float32Array.from(v, (x) => (x == null ? NaN : x));
      else if (v && typeof v === "object" && !Array.isArray(v)) typed(v);
    }
  };
  for (const st of fixture.steps) typed(st);
  return fixture;
}

/**
 * ICON-EU-Fall `inner` und ICON-Global-Fall `outer` je Termin zusammensetzen
 * (`mergeFields`: ICON-EU innen, ICON Global außen, auf dem Raster von
 * `outer`). Termine, die nur einer der beiden Fälle hat, entfallen -- die
 * Schrittliste soll ein Raster haben. Beide Fälle typisiert (`typedCase`).
 */
export function mergeCases(inner, outer) {
  const steps = [];
  inner.steps.forEach((st, n) => {
    const m = outer.steps.findIndex((s) => s.validTime === st.validTime);
    if (m < 0) return;
    const f = mergeFields(fieldAt(inner, n, inner.pressures[0]), fieldAt(outer, m, outer.pressures[0]));
    steps.push({ validTime: st.validTime, leadH: st.leadH, levels: f.levels, psfc: f.psfc, u10: f.u10, v10: f.v10, sfc: f.sfc, thickness: f.thickness });
  });
  return { ...outer, model: `${inner.model}+${outer.model}`, steps, times: steps.map((s) => s.validTime), lastRunAtFetch: inner.lastRunAtFetch };
}

/**
 * Höhenflächen eines `upper`-Falls (gleiches Raster) als zusätzliche
 * `levels[p]` an die Termine von `fixture` hängen, nicht als wählbare
 * Analysefläche. Gibt false zurück, wenn die Raster nicht passen.
 */
export function attachUpper(fixture, upper) {
  if (!upper || upper.nx !== fixture.nx || upper.ny !== fixture.ny) return false;
  for (const st of fixture.steps) {
    const u = upper.steps.find((s) => s.validTime === st.validTime);
    if (u) Object.assign(st.levels, u.levels);
  }
  return true;
}
