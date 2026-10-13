#!/usr/bin/env node
/**
 * Vergleicht die automatische Frontenanalyse mit allen Handanalysen in
 * tools/fronts/reference/ (Debug-Seite, „Referenz speichern“). Zu jeder
 * Referenz wird eine Fixture mit diesem Termin gesucht, möglichst mit
 * Vortermin (für die Drucktendenz).
 *
 *   node tools/fronts/compare.mjs ['{"sigmaKm":100}'] [--tol 150] [--no-merge]
 *     [--fixtures dir] [--refs dir] [--model icon_global] [--clip latMin,latMax,lonMin,lonMax] [--rim Grad]
 *
 * Das optionale JSON überschreibt DETECT_DEFAULTS, so lassen sich
 * Parameter gegen alle Referenzen zugleich prüfen.
 *
 * Wie im Betrieb vorgesehen, werden die Felder zusammengesetzt
 * (mergeFields): ICON-EU innen, ICON Global außen, wenn es eine
 * ICON-Global-Fixture mit dem Termin gibt. Ausgewertet wird nur das
 * Gebiet, auf dem die Referenz gezeichnet ist (properties.domain, sonst das
 * der ICON-EU-Fixture); Fronten außerhalb wären sonst Fehlalarme.
 * --no-merge rechnet nur auf ICON-EU, --model nur auf den Fixtures dieses
 * Modells (ohne Zusammensetzen). --fixtures und --refs nehmen Fixtures bzw.
 * Referenzen aus einem anderen Verzeichnis, --clip legt das ausgewertete
 * Gebiet fest, --rim spart einen Randstreifen aus (Referenz und Automatik).
 * Ausschlussgebiete der Referenz (properties.exclude) zählen nicht.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { fieldAt, mergeFields, detectFronts, typedCase } from "../../src/fronts/index.js";
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
const rimDeg = arg("--rim") != null ? Number(arg("--rim")) : 0;
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
// Ausschlussgebiete der Referenz (properties.exclude: [{latMin, latMax,
// lonMin, lonMax, note}]): Systeme, die die Analystin bewusst offen lässt;
// dort zählen weder Referenz noch Automatik.
const dropBoxes = (lines, boxes) => !boxes?.length ? lines : lines.flatMap((l) => {
  const out = [];
  let cur = [];
  for (const p of l.ll) {
    if (!boxes.some((b) => p[0] >= b.latMin && p[0] <= b.latMax && p[1] >= b.lonMin && p[1] <= b.lonMax)) cur.push(p);
    else { if (cur.length > 1) out.push({ ...l, ll: cur }); cur = []; }
  }
  if (cur.length > 1) out.push({ ...l, ll: cur });
  return out;
});
const optsArg = argv.find((a, i) => a.startsWith("{") && !(argv[i - 1]?.startsWith("--") && !FLAGS.includes(argv[i - 1])));
const detectOpts = optsArg ? JSON.parse(optsArg) : {};

const refDir = arg("--refs") ? `${arg("--refs").replace(/\/$/, "")}/` : `${dir}reference/`;
const refs = existsSync(refDir) ? readdirSync(refDir).filter((f) => f.endsWith(".geojson")).sort() : [];
if (!refs.length) { console.log(`Keine Referenzen in ${refDir}`); process.exit(0); }

const all = readdirSync(fixDir).filter((f) => f.endsWith(".json.gz")).map((name) => {
  const C = typedCase(JSON.parse(gunzipSync(readFileSync(`${fixDir}${name}`))));
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
  // Ausgewertet wird das Gebiet, auf dem die Referenz gezeichnet ist
  // (properties.domain, von der Debug-Seite gespeichert); ältere Referenzen
  // ohne Angabe sind auf ICON-EU gezeichnet.
  const d = fc.properties?.domain;
  const clip0 = clipArg || (d ? [d.latMin, d.latMax, d.lonMin, d.lonMax]
    : isMerged ? [inner.lat0, inner.lat0 + (inner.ny - 1) * inner.res, inner.lon0, inner.lon0 + (inner.nx - 1) * inner.res] : null);
  // Randstreifen aussparen: am Rand kann die Handanalyse nicht beurteilen,
  // wie es jenseits des Gebiets weitergeht (Projektleitung, 09.10. Atlantik).
  const clip = clip0 && rimDeg > 0 ? [clip0[0] + rimDeg, clip0[1] - rimDeg, clip0[2] + rimDeg, clip0[3] - rimDeg] : clip0;
  const auto = detectFronts(field, { ...detectOpts, prev });
  // Teilanalyse (properties.partial): Fehlalarme nur nahe den geprüften Linien.
  const ex = fc.properties?.exclude;
  const r = compareFronts(dropBoxes(clipLines(fcToLines(fc), rimDeg > 0 ? clip : null), ex), dropBoxes(clipLines(fcToLines(auto), clip), ex), { ...(tolKm ? { tolKm } : {}), ...(fc.properties?.partial ? { partialKm: 300 } : {}) });
  for (const k of Object.keys(tot)) tot[k] += r[k];
  console.log(`${vt}${fc.properties?.partial ? "*" : " "} ${(hit.name.replace(/\.json\.gz$/, "") + (isMerged ? " +global" : "")).padEnd(30)}  ${pct(r.pod)}  ${pct(r.podAny)}    ${pct(r.far)}   ${km(r.meanDistKm)} km  ${km(r.refKm)}/${km(r.testKm)}${prev ? "" : "  (ohne Vortermin)"}`);
}
console.log("* Teilanalyse: Fehlalarm nur im Umkreis von 300 km um die geprüften Linien");
console.log(`Gesamt${" ".repeat(44)}${pct(tot.hitKm / tot.refKm)}  ${pct(tot.hitAnyKm / tot.refKm)}    ${pct(tot.testKm ? tot.falseKm / tot.testKm : null)}   ${km(tot.distN ? tot.distSum / tot.distN : null)} km`);
