#!/usr/bin/env node
/**
 * Vergleicht die automatische Frontenanalyse mit allen Handanalysen in
 * tools/fronts/reference/ (Debug-Seite, „Referenz speichern“). Zu jeder
 * Referenz wird eine Fixture mit diesem Termin gesucht, möglichst mit
 * Vortermin (für die Drucktendenz).
 *
 *   node tools/fronts/compare.mjs ['{"sigmaKm":100}'] [--tol 150] [--no-merge]
 *     [--fixtures dir] [--model icon_global] [--clip latMin,latMax,lonMin,lonMax]
 *
 * Das optionale JSON überschreibt DETECT_DEFAULTS, so lassen sich
 * Parameter gegen alle Referenzen zugleich prüfen.
 *
 * Wie im Betrieb vorgesehen, werden die Felder zusammengesetzt
 * (mergeFields): ICON-EU innen, ICON Global außen, wenn es eine
 * ICON-Global-Fixture mit dem Termin gibt. Ausgewertet wird dann nur das
 * Gebiet der ICON-EU-Fixture, auf dem die Referenzen gezeichnet sind
 * (Fronten außerhalb wären sonst Fehlalarme). --no-merge rechnet nur auf
 * ICON-EU. --fixtures nimmt die Fixtures aus einem anderen Verzeichnis,
 * --model nur Fixtures dieses Modells (ohne Zusammensetzen), --clip legt
 * das ausgewertete Gebiet fest.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { fieldAt, mergeFields, detectFronts } from "../../src/fronts/index.js";
import { compareFronts, fcToLines } from "./compare.js";

const dir = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
const tolIdx = argv.indexOf("--tol");
const tolKm = tolIdx >= 0 ? Number(argv[tolIdx + 1]) : undefined;
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const FLAGS = ["--no-merge"]; // Schalter ohne Wert
const fixDir = arg("--fixtures") ? `${arg("--fixtures").replace(/\/$/, "")}/` : `${dir}fixtures/`;
const modelArg = arg("--model");
const mergeModel = argv.includes("--no-merge") || modelArg ? null : "icon_global";
const clipArg = arg("--clip")?.split(",").map(Number);
// Linien auf das Gebiet zuschneiden (Stücke innerhalb bleiben getrennt erhalten).
const clipLines = (lines, clip) => !clip ? lines : lines.flatMap((l) => {
  const out = [];
  let cur = [];
  for (const p of l.ll) {
    if (p[0] >= clip[0] && p[0] <= clip[1] && p[1] >= clip[2] && p[1] <= clip[3]) cur.push(p);
    else { if (cur.length > 1) out.push({ ...l, ll: cur }); cur = []; }
  }
  if (cur.length > 1) out.push({ ...l, ll: cur });
  return out;
});
const optsArg = argv.find((a, i) => a.startsWith("{") && !(argv[i - 1]?.startsWith("--") && !FLAGS.includes(argv[i - 1])));
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
const all = readdirSync(fixDir).filter((f) => f.endsWith(".json.gz")).map((name) => {
  const C = JSON.parse(gunzipSync(readFileSync(`${fixDir}${name}`)));
  for (const st of C.steps) toTyped(st);
  return { name, C };
});
const isMerge = (fx) => mergeModel && fx.name.startsWith(`${mergeModel}_`);
const fixtures = all.filter((fx) => (!modelArg || fx.name.startsWith(`${modelArg}_`)) && !isMerge(fx));
// Feld eines Termins aus dem äußeren Modell (ICON Global), falls vorhanden.
const outerAt = (vt) => {
  for (const fx of all.filter(isMerge)) {
    const n = fx.C.steps.findIndex((st) => st.validTime === vt);
    if (n >= 0) return fieldAt(fx.C, n, 850);
  }
  return null;
};
const merged = (f) => { const o = mergeModel && f && outerAt(f.validTime); return o ? mergeFields(f, o) : f; };

const pct = (x) => (x == null ? "  –" : `${Math.round(x * 100)}`.padStart(3) + " %");
const km = (x) => (x == null ? "  –" : `${Math.round(x)}`.padStart(4));
console.log("Termin            Fixture                         Treffer  Lage  Fehlalarm  Abstand  Ref/Auto km");
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
  const inner = fieldAt(C, n, 850);
  const field = merged(inner);
  const prev = n > 0 && C.stepH === 3 ? merged(fieldAt(C, n - 1, 850)) : undefined;
  const isMerged = field !== inner;
  const clip = clipArg || (isMerged ? [inner.lat0, inner.lat0 + (inner.ny - 1) * inner.res, inner.lon0, inner.lon0 + (inner.nx - 1) * inner.res] : null);
  const auto = detectFronts(field, { ...detectOpts, prev });
  // Teilanalyse (properties.partial): Fehlalarme nur nahe den geprüften Linien.
  const r = compareFronts(fcToLines(fc), clipLines(fcToLines(auto), clip), { ...(tolKm ? { tolKm } : {}), ...(fc.properties?.partial ? { partialKm: 300 } : {}) });
  for (const k of Object.keys(tot)) tot[k] += r[k];
  console.log(`${vt}${fc.properties?.partial ? "*" : " "} ${(hit.name.replace(/\.json\.gz$/, "") + (isMerged ? " +global" : "")).padEnd(30)}  ${pct(r.pod)}  ${pct(r.podAny)}    ${pct(r.far)}   ${km(r.meanDistKm)} km  ${km(r.refKm)}/${km(r.testKm)}${prev ? "" : "  (ohne Vortermin)"}`);
}
console.log("* Teilanalyse: Fehlalarm nur im Umkreis von 300 km um die geprüften Linien");
console.log(`Gesamt${" ".repeat(44)}${pct(tot.hitKm / tot.refKm)}  ${pct(tot.hitAnyKm / tot.refKm)}    ${pct(tot.testKm ? tot.falseKm / tot.testKm : null)}   ${km(tot.distN ? tot.distSum / tot.distN : null)} km`);
