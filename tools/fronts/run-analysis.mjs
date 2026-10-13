#!/usr/bin/env node
/**
 * Laufende Frontenanalyse (Cron-Job, s. README „Laufende Analyse“): holt zu
 * den synoptischen Hauptterminen (00/06/12/18 UTC) die Felder von ICON-EU
 * und ICON Global, rechnet die Fronten und legt beides als Archiv ab, das
 * die Debug-Seite (und später die App) liest.
 *
 *   node tools/fronts/run-analysis.mjs --out <dir> [--time 2026-10-13T06:00]
 *     [--horizon 0] [--lookback 24] [--keep-days 60] [--no-upper] [--redetect]
 *
 * Ohne --time arbeitet der Job alle Hauptermine der letzten --lookback
 * Stunden ab, für die ICON-EU den Lauf zum Termin schon hat. Er ist darauf
 * ausgelegt, stündlich zu laufen: Was fertig ist, wird übersprungen.
 *
 * Vorläufig und endgültig: ICON-EU ist rund 4 h nach dem Termin auf dem
 * Server, ICON Global erst nach rund 8 h. Solange der Global-Lauf zum
 * Termin fehlt, kommt der Außenbereich aus dem Vorlauf (Kurzfrist-
 * vorhersage) und die Analyse gilt als `preliminary`; ein späterer Lauf
 * holt ICON Global neu und setzt `final`.
 *
 * --horizon H holt zusätzlich Vorhersagetermine bis +H h (3-stündlich, wegen
 * der Drucktendenz) und rechnet für jeden die Fronten. Default 0: nur die
 * Analyse (plus Vortermin −3 h für die Drucktendenz).
 *
 * --redetect rechnet die Fronten aller archivierten Termine aus den
 * gespeicherten Feldern neu (nach einer Änderung am Algorithmus), ohne
 * Abruf. Läufe im --lookback-Fenster mit älterer `algo_version` werden auch
 * ohne den Schalter neu gerechnet.
 *
 * Ablage (<dir>):
 *   latest.json                 neuester Termin (id, Status, Version)
 *   index.json                  alle Termine, neuester zuerst
 *   runs/<id>/run.json          Metadaten (Läufe, Vorlauf, Dauer, Dateien)
 *   runs/<id>/icon_eu_<id>.json.gz, icon_global_<id>.json.gz,
 *            icon_eu_upper_<id>.json.gz, icon_global_upper_<id>.json.gz
 *                               Felder als Fixture v2 (wie tools/fronts/fixtures)
 *   runs/<id>/fronts_<YYYY-MM-DDTHH>.geojson   Fronten je Termin
 * mit <id> = Analysetermin "YYYY-MM-DDTHH".
 */

import { readFile, writeFile, rename, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { fetchCase, caseTimes, typedCase, mergeCases } from "../../src/fronts/cases.js";
import { fieldAt } from "../../src/fronts/field.js";
import { detectFronts } from "../../src/fronts/detect.js";
import { fetchModelRunInit } from "../../src/weather.js";

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const outDir = arg("--out");
if (!outDir) { console.error("--out <Verzeichnis> fehlt"); process.exit(1); }
const horizonH = Number(arg("--horizon") ?? 0);
const lookbackH = Number(arg("--lookback") ?? 24);
const keepDays = Number(arg("--keep-days") ?? 60);
const withUpper = !argv.includes("--no-upper");
const redetectAll = argv.includes("--redetect");
const onlyTime = arg("--time");

const SYNOP_HOURS = [0, 6, 12, 18];
const PRESSURE = 850; // Analysefläche, wie compare.mjs
const runsDir = `${outDir}/runs`;
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);
const iso = (ms) => new Date(ms).toISOString().slice(0, 16); // "YYYY-MM-DDTHH:00"
const idOf = (time) => time.slice(0, 13);

// Version des Algorithmus: Prüfsumme über src/fronts/*.js. Ändert sich der
// Code, ändern sich die Fronten -- dann wird neu gerechnet.
const srcDir = fileURLToPath(new URL("../../src/fronts/", import.meta.url));
const ALGO_VERSION = (() => {
  const h = createHash("sha256");
  for (const f of readdirSync(srcDir).filter((f) => f.endsWith(".js")).sort()) h.update(f).update(readFileSync(srcDir + f));
  return h.digest("hex").slice(0, 10);
})();

/** Datei atomar schreiben (erst .tmp, dann umbenennen): Leser sehen nie Halbes. */
async function writeAtomic(path, data) {
  await writeFile(`${path}.tmp`, data);
  await rename(`${path}.tmp`, path);
}
const writeJson = (path, obj) => writeAtomic(path, JSON.stringify(obj, null, 1));
const writeGz = (path, obj) => writeAtomic(path, gzipSync(JSON.stringify(obj), { level: 9 }));
const readGz = async (path) => JSON.parse(gunzipSync(await readFile(path)));
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

// Nur eine Instanz zugleich (stündlicher Cron, ein Lauf kann mehrere Minuten
// dauern). Eine Sperre älter als 2 h gilt als verwaist.
const lockDir = `${outDir}/.lock`;
async function lock() {
  await mkdir(outDir, { recursive: true });
  try { await mkdir(lockDir); return true; } catch {
    const age = Date.now() - (await stat(lockDir)).mtimeMs;
    if (age < 2 * 3600e3) return false;
    log("verwaiste Sperre entfernt");
    await rm(lockDir, { recursive: true, force: true });
    await mkdir(lockDir);
    return true;
  }
}

const runInitIso = (fx) => fx.lastRunAtFetch?.slice(0, 16) ?? null;
const files = (id) => ({
  eu: `icon_eu_${id}.json.gz`, global: `icon_global_${id}.json.gz`,
  euUpper: `icon_eu_upper_${id}.json.gz`, globalUpper: `icon_global_upper_${id}.json.gz`,
});

/** Felder für einen Analysetermin holen; `only` = Liste der Schlüssel aus files(). */
async function fetchFields(time, dir, only) {
  const id = idOf(time), F = files(id);
  const times = caseTimes(iso(Date.parse(`${time}Z`) - 3 * 3600e3), iso(Date.parse(`${time}Z`) + horizonH * 3600e3), 3);
  const jobs = [
    ["eu", { model: "icon_eu" }], ["global", { model: "icon_global" }],
    ...(withUpper ? [["euUpper", { model: "icon_eu", upper: true }], ["globalUpper", { model: "icon_global", upper: true }]] : []),
  ].filter(([key]) => only.includes(key));
  const got = {};
  for (const [key, opts] of jobs) {
    const t0 = Date.now();
    // Nacheinander, nicht parallel: der Modelllevel-Server soll den Job kaum spüren.
    got[key] = await fetchCase({ ...opts, times });
    await writeGz(`${dir}/${F[key]}`, got[key]);
    log(`  ${F[key]}: ${times.length} Termine, ${((Date.now() - t0) / 1000).toFixed(0)} s, Lauf ${runInitIso(got[key])}`);
  }
  return got;
}

/** Fronten aller Termine ab dem Analysetermin aus den abgelegten Feldern rechnen. */
async function detect(dir, meta) {
  const F = files(meta.id);
  const merged = mergeCases(typedCase(await readGz(`${dir}/${F.eu}`)), typedCase(await readGz(`${dir}/${F.global}`)));
  const out = [];
  merged.steps.forEach((st, n) => {
    if (n === 0 || st.validTime < meta.analysis_time) return; // Vortermin nur für die Tendenz
    const prev = merged.stepH === 3 ? fieldAt(merged, n - 1, PRESSURE) : undefined;
    const fc = detectFronts(fieldAt(merged, n, PRESSURE), { prev, keepInactive: true });
    const lead = Math.round((Date.parse(`${st.validTime}Z`) - Date.parse(`${meta.analysis_time}Z`)) / 3600e3);
    fc.properties = {
      ...fc.properties, valid_time: st.validTime, analysis_time: meta.analysis_time, lead_h: lead,
      status: meta.status, algo_version: ALGO_VERSION, server_runs: meta.server_runs,
    };
    out.push({ valid_time: st.validTime, lead_h: lead, file: `fronts_${idOf(st.validTime)}.geojson`, fc });
  });
  for (const o of out) await writeAtomic(`${dir}/${o.file}`, JSON.stringify(o.fc));
  return out.map(({ fc, ...rest }) => ({ ...rest, fronts: fc.features.length }));
}

async function processTime(time, inits, { force = false } = {}) {
  const id = idOf(time), dir = `${runsDir}/${id}`, metaPath = `${dir}/run.json`;
  const old = existsSync(metaPath) ? await readJson(metaPath) : null;
  const globalReady = inits.icon_global >= time;
  let todo;
  if (!old || force) todo = ["eu", "global", "euUpper", "globalUpper"];
  else if (old.status === "preliminary" && globalReady) todo = ["global", "globalUpper"];
  else if (old.algo_version !== ALGO_VERSION || redetectAll) todo = [];
  else return false;

  const t0 = Date.now();
  log(`${id}: ${todo.length ? `hole ${todo.join(", ")}` : "rechne Fronten neu"}`);
  await mkdir(dir, { recursive: true });
  const got = await fetchFields(time, dir, todo);
  const runs = { ...old?.server_runs };
  if (got.eu) runs.icon_eu = runInitIso(got.eu);
  if (got.global) runs.icon_global = runInitIso(got.global);
  const meta = {
    id, analysis_time: time, horizon_h: horizonH,
    // Endgültig, wenn beide Modelle den Lauf zum Termin (oder später) geliefert haben.
    status: runs.icon_eu >= time && runs.icon_global >= time ? "final" : "preliminary",
    // Neuester Lauf auf dem Server beim Abruf; die Termine selbst kommen aus dem
    // jüngsten Lauf, der sie abdeckt (bei ICON-EU also dem Lauf zum Termin).
    server_runs: runs, algo_version: ALGO_VERSION, upper: withUpper || !!old?.upper,
    fetched_at: todo.length ? new Date().toISOString() : old.fetched_at,
    detected_at: new Date().toISOString(),
    files: files(id),
  };
  meta.fronts = await detect(dir, meta);
  meta.duration_s = Math.round((Date.now() - t0) / 1000);
  await writeJson(metaPath, meta); // zuletzt: erst jetzt gilt der Termin als vorhanden
  log(`${id}: ${meta.status}, ${meta.fronts.map((f) => `${f.valid_time.slice(11, 13)} UTC ${f.fronts} Linien`).join(", ")}, ${meta.duration_s} s`);
  return true;
}

/** Index und latest.json aus den run.json neu aufbauen; alte Termine löschen. */
async function rebuildIndex() {
  const cutoff = iso(Date.now() - keepDays * 86400e3);
  const runs = [];
  for (const id of existsSync(runsDir) ? await readdir(runsDir) : []) {
    const metaPath = `${runsDir}/${id}/run.json`;
    if (!existsSync(metaPath)) continue; // unfertig oder abgebrochen
    const m = await readJson(metaPath);
    if (m.analysis_time < cutoff) { await rm(`${runsDir}/${id}`, { recursive: true, force: true }); log(`${id}: gelöscht (älter als ${keepDays} Tage)`); continue; }
    runs.push({ id: m.id, analysis_time: m.analysis_time, status: m.status, server_runs: m.server_runs, algo_version: m.algo_version, fronts: m.fronts });
  }
  runs.sort((a, b) => b.analysis_time.localeCompare(a.analysis_time));
  const updated = new Date().toISOString();
  await writeJson(`${outDir}/index.json`, { updated, algo_version: ALGO_VERSION, runs });
  if (runs[0]) await writeJson(`${outDir}/latest.json`, { updated, ...runs[0], path: `runs/${runs[0].id}/` });
}

if (!(await lock())) { log("läuft schon, Ende"); process.exit(0); }
let failed = false;
try {
  const inits = {};
  for (const m of ["icon_eu", "icon_global"]) {
    const t = await fetchModelRunInit(m);
    inits[m] = t ? iso(t * 1000) : "";
  }
  log(`Läufe auf dem Server: ICON-EU ${inits.icon_eu || "?"}, ICON Global ${inits.icon_global || "?"}, Algorithmus ${ALGO_VERSION}`);

  let times;
  if (onlyTime) times = [onlyTime.length === 13 ? `${onlyTime}:00` : onlyTime];
  else {
    times = [];
    const now = Date.now();
    for (let t = Math.floor(now / 3600e3) * 3600e3; t >= now - lookbackH * 3600e3; t -= 3600e3) {
      if (SYNOP_HOURS.includes(new Date(t).getUTCHours())) times.unshift(iso(t));
    }
    // --redetect: auch alle archivierten Termine außerhalb des Fensters.
    if (redetectAll && existsSync(runsDir)) {
      for (const id of await readdir(runsDir)) if (existsSync(`${runsDir}/${id}/run.json`) && !times.includes(`${id}:00`)) times.push(`${id}:00`);
      times.sort();
    }
  }
  for (const time of times) {
    const archived = existsSync(`${runsDir}/${idOf(time)}/run.json`);
    if (!archived && !(inits.icon_eu >= time)) { log(`${idOf(time)}: ICON-EU-Lauf noch nicht da`); continue; }
    try {
      await processTime(time, inits, { force: !!onlyTime && !redetectAll });
    } catch (err) {
      failed = true;
      log(`${idOf(time)}: FEHLER ${err.stack || err}`);
    }
  }
  await rebuildIndex();
} finally {
  await rm(lockDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
