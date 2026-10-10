#!/usr/bin/env node
/**
 * Vergleicht die automatische Frontenanalyse mit allen Handanalysen in
 * tools/fronts/reference/ (Debug-Seite, „Referenz speichern“). Zu jeder
 * Referenz wird eine Fixture mit diesem Termin gesucht, möglichst mit
 * Vortermin (für die Drucktendenz).
 *
 *   node tools/fronts/compare.mjs ['{"sigmaKm":100}'] [--tol 150]
 *
 * Das optionale JSON überschreibt DETECT_DEFAULTS, so lassen sich
 * Parameter gegen alle Referenzen zugleich prüfen.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { fieldAt, detectFronts } from "../../src/fronts/index.js";
import { compareFronts, fcToLines } from "./compare.js";

const dir = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
const tolIdx = argv.indexOf("--tol");
const tolKm = tolIdx >= 0 ? Number(argv[tolIdx + 1]) : undefined;
const optsArg = argv.find((a, i) => a.startsWith("{") && argv[i - 1] !== "--tol");
const detectOpts = optsArg ? JSON.parse(optsArg) : {};

const refDir = `${dir}reference/`;
const refs = existsSync(refDir) ? readdirSync(refDir).filter((f) => f.endsWith(".geojson")).sort() : [];
if (!refs.length) { console.log(`Keine Referenzen in ${refDir}`); process.exit(0); }

// null -> NaN und typisierte Arrays (wie in debug.html).
function toTyped(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length > 1000) obj[k] = k === "below" ? Uint8Array.from(v) : Float32Array.from(v, (x) => (x == null ? NaN : x));
    else if (v && typeof v === "object" && !Array.isArray(v)) toTyped(v);
  }
}
const fixtures = readdirSync(`${dir}fixtures/`).filter((f) => f.endsWith(".json.gz")).map((name) => {
  const C = JSON.parse(gunzipSync(readFileSync(`${dir}fixtures/${name}`)));
  for (const st of C.steps) toTyped(st);
  return { name, C };
});

const pct = (x) => (x == null ? "  –" : `${Math.round(x * 100)}`.padStart(3) + " %");
const km = (x) => (x == null ? "  –" : `${Math.round(x)}`.padStart(4));
console.log("Termin            Fixture                     Treffer  Lage  Fehlalarm  Abstand  Ref/Auto km");
const tot = { refKm: 0, testKm: 0, hitKm: 0, hitAnyKm: 0, falseKm: 0, distSum: 0, distN: 0 };
for (const file of refs) {
  const fc = JSON.parse(readFileSync(refDir + file, "utf8"));
  const vt = fc.properties?.valid_time || `${file.slice(0, 13)}:00`;
  // Fixture mit diesem Termin, bevorzugt mit Vortermin.
  let hit = null;
  for (const fx of fixtures) {
    const n = fx.C.steps.findIndex((st) => st.validTime === vt);
    if (n >= 0 && (!hit || (hit.n === 0 && n > 0))) hit = { ...fx, n };
  }
  if (!hit) { console.log(`${vt}  keine Fixture`); continue; }
  const { C, n } = hit;
  const field = fieldAt(C, n, 850);
  const prev = n > 0 && C.stepH === 3 ? fieldAt(C, n - 1, 850) : undefined;
  const auto = detectFronts(field, { ...detectOpts, prev });
  // Teilanalyse (properties.partial): Fehlalarme nur nahe den geprüften Linien.
  const r = compareFronts(fcToLines(fc), fcToLines(auto), { ...(tolKm ? { tolKm } : {}), ...(fc.properties?.partial ? { partialKm: 300 } : {}) });
  for (const k of Object.keys(tot)) tot[k] += r[k];
  console.log(`${vt}${fc.properties?.partial ? "*" : " "} ${hit.name.padEnd(26)}  ${pct(r.pod)}  ${pct(r.podAny)}    ${pct(r.far)}   ${km(r.meanDistKm)} km  ${km(r.refKm)}/${km(r.testKm)}${prev ? "" : "  (ohne Vortermin)"}`);
}
console.log("* Teilanalyse: Fehlalarm nur im Umkreis von 300 km um die geprüften Linien");
console.log(`Gesamt${" ".repeat(40)}${pct(tot.hitKm / tot.refKm)}  ${pct(tot.hitAnyKm / tot.refKm)}    ${pct(tot.testKm ? tot.falseKm / tot.testKm : null)}   ${km(tot.distN ? tot.distSum / tot.distN : null)} km`);
