#!/usr/bin/env node
/**
 * Holt ein 850-hPa-Feld (aus ICON-Modellleveln interpoliert) und legt es als
 * kompakte JSON-Fixture ab -- Testfälle für die Frontenanalyse. Der Server
 * hält nur rund eine Woche Historie, also Fälle zeitnah sichern.
 *
 *   node tools/fronts/fetch-field.mjs --time 2026-10-09T00:00 \
 *     [--model icon_eu] [--res 0.5] [--pressure 850] \
 *     [--bbox latMin,latMax,lonMin,lonMax] [--out tools/fronts/fixtures/…json]
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fetchPlaneField } from "../../src/fronts/field.js";
import { fetchModelRunInit } from "../../src/weather.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));

const model = args.model || "icon_eu";
const time = args.time;
if (!time) { console.error("--time YYYY-MM-DDTHH:00 fehlt"); process.exit(1); }
const res = Number(args.res || 0.5);
const pressure = Number(args.pressure || 850);
// Default: ICON-EU-Gebiet in Europa (West- und Südrand = Modellrand), Raster
// auf das 0,0625°-Gitter ausgerichtet, damit "nearest" exakt trifft.
const [latMin, latMax, lonMin, lonMax] = (args.bbox || "30,70,-23.5,44.5").split(",").map(Number);
const stamp = time.replace(/[-:T]/g, "").slice(0, 10);

const t0 = Date.now();
const [field, runInit] = await Promise.all([
  fetchPlaneField({
    model, bbox: { latMin, latMax, lonMin, lonMax }, res, time, pressure,
    onProgress: (d, n) => process.stderr.write(`\r${d}/${n} Blöcke`),
  }),
  fetchModelRunInit(model),
]);
process.stderr.write(`\n${((Date.now() - t0) / 1000).toFixed(1)} s\n`);

const round = (arr, digits) => Array.from(arr, (x) => (Number.isFinite(x) ? +x.toFixed(digits) : null));
const fixture = {
  model, validTime: time, pressure, res,
  lat0: field.lat0, lon0: field.lon0, nx: field.nx, ny: field.ny,
  // Letzter Lauf ZUM ABRUFZEITPUNKT. Liegt validTime davor, stammt der Wert
  // aus dem jüngsten Lauf, der diese Stunde noch enthielt (Open-Meteo führt
  // eine Zeitreihe aus den jeweils neuesten Läufen) -- i. d. R. der Lauf
  // genau zu validTime, also die Analyse (+0 h).
  lastRunAtFetch: runInit ? new Date(runInit * 1000).toISOString() : null,
  fetchedAt: new Date().toISOString(),
  units: { T: "K", q: "kg/kg", u: "m/s", v: "m/s", psfc: "hPa" },
  T: round(field.T, 2), q: round(field.q, 6),
  u: round(field.u, 2), v: round(field.v, 2),
  psfc: round(field.psfc, 1), below: Array.from(field.below),
};
// Dateiname mit Herkunft: "_an" = Analyse (+0 h, Abruf nach validTime --
// ICON-EU läuft 3-stündlich, die Stunde stammt dann aus dem Lauf zu
// validTime), sonst "_fc06" = Vorhersagestunde ab dem letzten Lauf.
const leadH = runInit ? Math.round((Date.parse(`${time}Z`) / 1000 - runInit) / 3600) : null;
const tag = leadH == null ? "" : leadH <= 0 ? "_an" : `_fc${String(leadH).padStart(2, "0")}`;
const out = args.out || `tools/fronts/fixtures/${model}_${pressure}_${stamp}${tag}.json`;
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(fixture));
const nBelow = fixture.below.reduce((a, b) => a + b, 0);
const nNaN = fixture.T.filter((x) => x == null).length;
console.log(`${out}: ${field.nx}×${field.ny} Punkte, ${nBelow} unter Grund, ${nNaN - nBelow} sonst ohne Wert, Lauf ${fixture.lastRunAtFetch}`);
