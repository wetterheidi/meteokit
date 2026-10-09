#!/usr/bin/env node
/**
 * Holt einen Testfall für die Frontenanalyse: mehrere Termine, mehrere
 * Druckflächen (aus ICON-Modellleveln interpoliert) und Oberflächenfelder,
 * als gzip-komprimierte JSON-Fixture (Format v2, s. README). Mehrere
 * Termine braucht es für Drucktendenz und Frontverlagerung. Der Server hält
 * nur rund eine Woche Historie, also Fälle zeitnah sichern.
 *
 *   node tools/fronts/fetch-case.mjs --start 2026-10-08T18:00 --end 2026-10-09T12:00 \
 *     [--step 3] [--model icon_eu] [--res 0.5] [--pressures 850,700] \
 *     [--bbox latMin,latMax,lonMin,lonMax] [--name 2026-10-09] [--out …json.gz]
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { fetchPlaneField, DEFAULT_SURFACE } from "../../src/fronts/field.js";
import { fetchModelRunInit } from "../../src/weather.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));

const model = args.model || "icon_eu";
const start = args.start, end = args.end || args.start;
if (!start) { console.error("--start YYYY-MM-DDTHH:00 fehlt"); process.exit(1); }
const stepH = Number(args.step || 3);
const res = Number(args.res || 0.5);
const pressures = (args.pressures || "850,700").split(",").map(Number);
// Default: ICON-EU-Gebiet in Europa (West- und Südrand = Modellrand), Raster
// auf das 0,0625°-Gitter ausgerichtet, damit "nearest" exakt trifft.
const [latMin, latMax, lonMin, lonMax] = (args.bbox || "30,70,-23.5,44.5").split(",").map(Number);
const name = args.name || start.slice(0, 10);
const out = args.out || `tools/fronts/fixtures/${model}_${name}.json.gz`;

const times = [];
for (let t = Date.parse(`${start}Z`); t <= Date.parse(`${end}Z`); t += stepH * 3600e3) {
  times.push(new Date(t).toISOString().slice(0, 16));
}

const runInit = await fetchModelRunInit(model);
const round = (arr, digits) => Array.from(arr, (x) => (Number.isFinite(x) ? +x.toFixed(digits) : null));
// Rundung je Feld: genug für Gradienten/Tendenzen, klein genug für das Repo.
const DIGITS = { T: 2, q: 6, u: 2, v: 2, w: 3, psfc: 1, u10: 2, v10: 2 };
const SFC_DIGITS = { pressure_msl: 1, temperature_2m: 1, dew_point_2m: 1 }; // sonst 1 bzw. ganzzahlig
const steps = [];
const t0 = Date.now();
for (const time of times) {
  const f = await fetchPlaneField({
    model, bbox: { latMin, latMax, lonMin, lonMax }, res, time, pressures, surface: DEFAULT_SURFACE,
    onProgress: (d, n) => process.stderr.write(`\r${time}: ${d}/${n} Blöcke   `),
  });
  const levels = {};
  for (const p of pressures) {
    const L = f.levels[p];
    levels[p] = { below: Array.from(L.below) };
    for (const key of ["T", "q", "u", "v", "w"]) levels[p][key] = round(L[key], DIGITS[key]);
  }
  const sfc = {};
  for (const [k, arr] of Object.entries(f.sfc)) sfc[k] = round(arr, SFC_DIGITS[k] ?? (k.startsWith("cloud") || k === "cape" ? 0 : 2));
  // Vorlauf relativ zum letzten Lauf beim Abruf: <= 0 heißt, die Stunde
  // stammt aus einem Lauf zu oder kurz vor diesem Termin (ICON-EU 3-stündlich).
  const leadH = runInit ? Math.round((Date.parse(`${time}Z`) / 1000 - runInit) / 3600) : null;
  steps.push({
    validTime: time, leadH: leadH != null && leadH > 0 ? leadH : 0,
    levels, psfc: round(f.psfc, DIGITS.psfc), u10: round(f.u10, 2), v10: round(f.v10, 2), sfc,
  });
}
process.stderr.write(`\n${((Date.now() - t0) / 1000).toFixed(1)} s\n`);

const fixture = {
  version: 2, model, res, lat0: latMin, lon0: lonMin,
  nx: Math.round((lonMax - lonMin) / res) + 1, ny: Math.round((latMax - latMin) / res) + 1,
  pressures, stepH, times,
  lastRunAtFetch: runInit ? new Date(runInit * 1000).toISOString() : null,
  fetchedAt: new Date().toISOString(),
  units: {
    T: "K", q: "kg/kg", u: "m/s", v: "m/s", w: "m/s", psfc: "hPa", u10: "m/s", v10: "m/s",
    pressure_msl: "hPa", precipitation: "mm/h", rain: "mm/h", showers: "mm/h",
    cloud_cover: "%", temperature_2m: "°C", dew_point_2m: "°C", cape: "J/kg",
  },
  steps,
};
await mkdir(dirname(out), { recursive: true });
const gz = gzipSync(JSON.stringify(fixture), { level: 9 });
await writeFile(out, gz);
console.log(`${out}: ${times.length} Termine ${times[0]} … ${times.at(-1)}, ${fixture.nx}×${fixture.ny}, `
  + `${(gz.length / 1e6).toFixed(1)} MB, Lauf ${fixture.lastRunAtFetch}, Vorlauf ${steps.map((s) => s.leadH).join("/")} h`);
