#!/usr/bin/env node
/**
 * Holt einen Testfall für die Frontenanalyse: mehrere Termine, mehrere
 * Druckflächen (aus ICON-Modellleveln interpoliert) und Oberflächenfelder,
 * als gzip-komprimierte JSON-Fixture (Format v2, s. README). Mehrere
 * Termine braucht es für Drucktendenz und Frontverlagerung. Der Server hält
 * Modellleveldaten nur begrenzt vor (Stand 12.10.: zurück bis 29.09.), also
 * Fälle zeitnah sichern -- oder aus dem Archiv der laufenden Analyse
 * (run-analysis.mjs) nehmen.
 *
 *   node tools/fronts/fetch-case.mjs --start 2026-10-08T18:00 --end 2026-10-09T12:00 \
 *     [--step 3] [--model icon_eu] [--res 0.5] [--pressures 850,700] \
 *     [--bbox latMin,latMax,lonMin,lonMax] [--name 2026-10-09] [--out …json.gz] [--upper]
 *
 * --upper holt nur Höhenflächen (Default 500 hPa: T, q, u, v, w) aus den
 * oberen Modellleveln, ohne Oberfläche und Schichtdicke, nach
 * fixtures/<model>_upper_<name>.json.gz -- Ergänzung zur Fixture gleichen
 * Namens (gleiches Raster), z. B. für die Vorticity-Advektion (PVA).
 *
 * Der Abruf selbst steckt in src/fronts/cases.js.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { fetchCase, caseTimes, CASE_DOMAINS } from "../../src/fronts/cases.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));

const model = args.model || "icon_eu";
const start = args.start, end = args.end || args.start;
if (!start) { console.error("--start YYYY-MM-DDTHH:00 fehlt"); process.exit(1); }
const upper = "upper" in args;
const bbox = args.bbox
  ? Object.fromEntries(["latMin", "latMax", "lonMin", "lonMax"].map((k, i) => [k, Number(args.bbox.split(",")[i])]))
  : CASE_DOMAINS[model];
const name = args.name || start.slice(0, 10);
const out = args.out || `tools/fronts/fixtures/${model}${upper ? "_upper" : ""}_${name}.json.gz`;

const t0 = Date.now();
const fixture = await fetchCase({
  model, bbox, upper, times: caseTimes(start, end, Number(args.step || 3)),
  res: Number(args.res || 0.5),
  ...(args.pressures ? { pressures: args.pressures.split(",").map(Number) } : {}),
  onProgress: (time, d, n) => process.stderr.write(`\r${time}: ${d}/${n} Blöcke   `),
});
process.stderr.write(`\n${((Date.now() - t0) / 1000).toFixed(1)} s\n`);

await mkdir(dirname(out), { recursive: true });
const gz = gzipSync(JSON.stringify(fixture), { level: 9 });
await writeFile(out, gz);
const { times } = fixture;
console.log(`${out}: ${times.length} Termine ${times[0]} … ${times.at(-1)}, ${fixture.nx}×${fixture.ny}, `
  + `${(gz.length / 1e6).toFixed(1)} MB, Lauf ${fixture.lastRunAtFetch}, Vorlauf ${fixture.steps.map((s) => s.leadH).join("/")} h`);
