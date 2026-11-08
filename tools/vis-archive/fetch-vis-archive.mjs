#!/usr/bin/env node
/**
 * Sichtweiten-Archiv: sichert ICON-D2/-EU-Modellsicht (`visibility`) samt
 * aller Eingangsgrößen einer eigenen Sichtparametrisierung sowie METARs für
 * eine feste Stationsliste (stations.json). Hintergrund und Ablauf s.
 * README.md -- kurz: der DWD stellt VIS nach dem 30.11.2026 ein, bis dahin
 * brauchen wir eine Vergleichsbasis.
 *
 * Reines Node ≥18, keine Abhängigkeiten.
 *
 *   node fetch-vis-archive.mjs --out DIR [--past-days N] [--metar-hours H]
 *                              [--only models|metar] [--stations ID,ID]
 *
 * --past-days N   Modellstunden der letzten N vollständigen UTC-Tage holen
 *                 (Default 3; Backfill z. B. 45 -- der Server hält die
 *                 Historie nur begrenzt, s. README).
 * --metar-hours H METARs der letzten H Stunden (Default 36; Backfill bis
 *                 ~700, die API hält etwa einen Monat).
 * --only          nur Modelle oder nur METAR.
 * --stations      nur diese Stations-IDs (Test).
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const API_BASE = "https://open-meteo.wetterheidi.de";
const METAR_API = "https://aviationweather.gov/api/data/metar";
const REQUEST_DELAY_MS = 1500;
const METAR_HOURS = 36;

// Unterste Modellflächen, die mitgesichert werden (k0 = unterste Fläche).
// Die Fläche mit dem größten Index ist bei Open-Meteo die unterste
// (level1 ≈ Modelloberrand).
const N_LOW_LEVELS = 5;
const MODELS = {
  icon_d2: { nLevels: 65 },
  icon_eu: { nLevels: 74 },
};

const SURFACE_VARS = [
  "visibility",
  "temperature_2m", "relative_humidity_2m", "dew_point_2m",
  "precipitation", "rain", "showers", "snowfall",
  "weather_code",
  "cloud_cover", "cloud_cover_low",
  "wind_speed_10m", "wind_gusts_10m",
  "pressure_msl", "surface_pressure",
  "snowfall_height", "freezing_level_height",
];
const LEVEL_VARS = [
  "height_agl", "pressure", "temperature", "relative_humidity",
  "specific_humidity", "cloud_water", "cloud_ice", "cloud_cover",
];

// ---------------------------------------------------------------- Helfer

function parseArgs(argv) {
  const a = { out: null, pastDays: 3, metarHours: METAR_HOURS, only: null, stations: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--out") a.out = argv[++i];
    else if (k === "--past-days") a.pastDays = Number(argv[++i]);
    else if (k === "--metar-hours") a.metarHours = Number(argv[++i]);
    else if (k === "--only") a.only = argv[++i];
    else if (k === "--stations") a.stations = argv[++i].split(",");
    else throw new Error(`Unbekanntes Argument: ${k}`);
  }
  if (!a.out) throw new Error("--out DIR fehlt");
  if (!(a.pastDays >= 1 && a.pastDays <= 92)) throw new Error("--past-days muss 1..92 sein");
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...x) => console.log(new Date().toISOString(), ...x);

async function fetchJson(url, tries = 4) {
  let last;
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "meteokit-vis-archive" } });
      if (res.ok) {
        // aviationweather antwortet ohne Treffer mit leerem Body (HTTP 204),
        // z. B. für nicht durchgehend besetzte Plätze wie EDQD -- das ist
        // "keine Meldungen", kein Fehler.
        const text = await res.text();
        return text.trim() ? JSON.parse(text) : [];
      }
      last = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (res.status === 400) break; // Anfragefehler -- Wiederholen hilft nicht
    } catch (e) {
      last = e;
    }
    await sleep(5000 * 2 ** t);
  }
  throw last;
}

/** Atomar schreiben: erst .tmp, dann rename. */
async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

const csvCell = (v) => (v == null || (typeof v === "number" && !Number.isFinite(v)) ? "" : String(v));

function utcDay(d) { return d.toISOString().slice(0, 10); }

// ---------------------------------------------------------------- Modelle

function levelColumns() {
  const cols = [];
  for (const v of LEVEL_VARS) for (let k = 0; k < N_LOW_LEVELS; k++) cols.push(`${v}_k${k}`);
  return cols;
}

/** Holt eine Station × Modell, liefert { meta, units, rows: [{time, ...}] }. */
async function fetchModelStation(model, st, pastDays) {
  const { nLevels } = MODELS[model];
  const levelApi = [];
  const levelMap = {}; // API-Name -> CSV-Spalte
  for (const v of LEVEL_VARS) {
    for (let k = 0; k < N_LOW_LEVELS; k++) {
      const api = `${v}_level${nLevels - k}`;
      levelApi.push(api);
      levelMap[api] = `${v}_k${k}`;
    }
  }
  const params = new URLSearchParams({
    latitude: String(st.lat),
    longitude: String(st.lon),
    // Keine Höhenkorrektur: Werte der Modell-Gitterzelle, damit T/RH zu der
    // Gitterzelle passen, für die auch die Modellsicht gilt.
    elevation: "nan",
    hourly: [...SURFACE_VARS, ...levelApi].join(","),
    models: model,
    past_days: String(pastDays),
    forecast_days: "1",
    timezone: "UTC",
  });
  const d = await fetchJson(`${API_BASE}/v1/forecast?${params}`);
  const h = d.hourly;
  const rows = h.time.map((time, i) => {
    const r = { time };
    for (const v of SURFACE_VARS) r[v] = h[v]?.[i];
    for (const api of levelApi) r[levelMap[api]] = h[api]?.[i];
    return r;
  });
  const units = {};
  for (const [k, u] of Object.entries(d.hourly_units ?? {})) units[levelMap[k] ?? k] = u;
  return {
    meta: { gridLat: d.latitude, gridLon: d.longitude, gridElev: d.elevation },
    units,
    rows,
  };
}

/** Anzahl nicht-leerer visibility-Werte einer bestehenden Tagesdatei. */
async function countVisInFile(path) {
  if (!existsSync(path)) return -1;
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  const idx = lines[0].split(",").indexOf("visibility");
  return lines.slice(1).filter((l) => l.split(",")[idx] !== "").length;
}

async function archiveModels(out, stations, pastDays) {
  const now = new Date();
  const today = utcDay(now);
  const unitsAll = {};
  const gridMeta = {};
  for (const model of Object.keys(MODELS)) {
    const byDay = new Map(); // day -> array of CSV-Zeilen
    const cols = ["station", "time", "grid_lat", "grid_lon", "grid_elev", ...SURFACE_VARS, ...levelColumns()];
    gridMeta[model] = {};
    for (const st of stations) {
      let res;
      try {
        res = await fetchModelStation(model, st, pastDays);
      } catch (e) {
        log(`FEHLER ${model} ${st.id}: ${e.message}`);
        await sleep(REQUEST_DELAY_MS);
        continue;
      }
      Object.assign(unitsAll, res.units);
      gridMeta[model][st.id] = res.meta;
      for (const r of res.rows) {
        const day = r.time.slice(0, 10);
        if (day >= today) continue; // nur vollständige, vergangene UTC-Tage
        const line = [st.id, r.time, res.meta.gridLat, res.meta.gridLon, res.meta.gridElev,
          ...SURFACE_VARS.map((v) => r[v]), ...levelColumns().map((c) => r[c])].map(csvCell).join(",");
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(line);
      }
      log(`${model} ${st.id}: ${res.rows.length} Stunden`);
      await sleep(REQUEST_DELAY_MS);
    }
    for (const [day, lines] of [...byDay].sort()) {
      const path = join(out, model, `${day}.csv`);
      const idx = cols.indexOf("visibility");
      const nNew = lines.filter((l) => l.split(",")[idx] !== "").length;
      if (nNew === 0) continue; // Server hat diesen Tag nicht (mehr)
      const nOld = await countVisInFile(path);
      if (nNew < nOld) {
        // Nie einen vollständigeren Stand durch einen lückenhafteren ersetzen
        // (Historie am Server rollt raus, einzelne Stationsabrufe scheitern).
        log(`${model} ${day}: behalte bestehende Datei (${nOld} > ${nNew} Werte)`);
        continue;
      }
      await writeAtomic(path, [cols.join(","), ...lines].join("\n") + "\n");
      log(`${model} ${day}: ${lines.length} Zeilen, ${nNew} mit Sicht geschrieben`);
    }
  }
  return { unitsAll, gridMeta };
}

// ---------------------------------------------------------------- METAR

const METAR_FIELDS = ["icaoId", "reportTime", "obsTime", "metarType", "rawOb", "visib",
  "wxString", "temp", "dewp", "wdir", "wspd", "wgst", "altim", "clouds", "vertVis"];

// Die API liefert pro Anfrage höchstens 400 Meldungen (gemessen 2026-11-08)
// und hält etwa einen Monat Historie. Deshalb je Station und in Zeitfenstern
// von METAR_WINDOW_H Stunden (`date` = Fensterende) abfragen -- ein Fenster
// hat auch bei 20-min-METARs nur ~220 Meldungen.
const METAR_WINDOW_H = 72;

function aviationDate(d) {
  return d.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "_");
}

async function archiveMetar(out, stations, hours) {
  const ids = stations.filter((s) => s.metar).map((s) => s.id);
  if (!ids.length) return;
  const list = [];
  const now = Date.now();
  for (const id of ids) {
    for (let back = 0; back < hours; back += METAR_WINDOW_H) {
      const win = Math.min(METAR_WINDOW_H, hours - back);
      const end = new Date(now - back * 3600e3);
      const url = `${METAR_API}?${new URLSearchParams({
        ids: id, format: "json", hours: String(win), date: aviationDate(end),
      })}`;
      try {
        const part = await fetchJson(url);
        if (Array.isArray(part)) list.push(...part);
        if (Array.isArray(part) && part.length >= 400) log(`WARNUNG metar ${id}: 400er-Grenze erreicht, Fenster verkleinern`);
      } catch (e) {
        log(`FEHLER metar ${id} bis ${end.toISOString()}: ${e.message}`);
        process.exitCode = 1;
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }
  const byDay = new Map();
  for (const m of list) {
    const rec = {};
    for (const f of METAR_FIELDS) if (m[f] !== undefined) rec[f] = m[f];
    const day = String(rec.reportTime ?? "").slice(0, 10);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(rec);
  }
  for (const [day, recs] of byDay) {
    const path = join(out, "metar", `${day}.jsonl`);
    const merged = new Map();
    const key = (r) => `${r.icaoId}|${r.reportTime}|${r.rawOb}`;
    if (existsSync(path)) {
      for (const l of (await readFile(path, "utf8")).split("\n")) if (l.trim()) {
        const r = JSON.parse(l); merged.set(key(r), r);
      }
    }
    const before = merged.size;
    for (const r of recs) merged.set(key(r), r);
    const sorted = [...merged.values()].sort((a, b) =>
      a.icaoId === b.icaoId ? String(a.reportTime).localeCompare(String(b.reportTime)) : a.icaoId.localeCompare(b.icaoId));
    await writeAtomic(path, sorted.map((r) => JSON.stringify(r)).join("\n") + "\n");
    log(`metar ${day}: ${sorted.length} Meldungen (${sorted.length - before} neu)`);
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv);
  const cfg = JSON.parse(await readFile(join(HERE, "stations.json"), "utf8"));
  let stations = cfg.stations;
  if (args.stations) stations = stations.filter((s) => args.stations.includes(s.id));

  let modelInfo = null;
  if (args.only !== "metar") modelInfo = await archiveModels(args.out, stations, args.pastDays);
  if (args.only !== "models") {
    try {
      await archiveMetar(args.out, stations, args.metarHours);
    } catch (e) {
      log(`FEHLER metar: ${e.message}`);
      process.exitCode = 1;
    }
  }

  // meta.json: Variablen, Einheiten, Gitterpunkte -- nur bei Modelllauf
  // aktualisieren (bei --only metar fehlen die Infos).
  if (modelInfo && Object.keys(modelInfo.unitsAll).length) {
    const metaPath = join(args.out, "meta.json");
    await writeAtomic(metaPath, JSON.stringify({
      updatedAt: new Date().toISOString(),
      source: API_BASE,
      elevation: "nan (Werte der Modell-Gitterzelle, keine Höhenkorrektur)",
      levels: `k0 = unterste Modellfläche, k${N_LOW_LEVELS - 1} = ${N_LOW_LEVELS}. von unten`,
      surfaceVars: SURFACE_VARS,
      levelVars: LEVEL_VARS,
      units: modelInfo.unitsAll,
      grid: modelInfo.gridMeta,
      stations,
    }, null, 2) + "\n");
  }
  log("fertig");
}

main().catch((e) => { console.error(e); process.exit(1); });
