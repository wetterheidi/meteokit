#!/usr/bin/env node
/**
 * Holt weltweit alle openAIP-Flugplätze (Name, ICAO-Code, Typ, Position,
 * Funkfrequenzen) und schreibt sie in dasselbe Grid-Zellen-Format wie
 * `fetch-airspaces.mjs` (`tiles/{latFloor}_{lonFloor}.geojson` + `meta.json`),
 * sodass Clients dieselbe Zellschlüssel-Berechnung wiederverwenden können.
 *
 * Anders als bei den Lufträumen wird hier NICHT per Bbox gerastert: Flugplätze
 * sind Punkte, die Welt passt in wenige hundert Seiten à PAGE_LIMIT Einträge.
 * Das Skript blättert den ganzen `/api/airports`-Bestand durch und sortiert
 * jeden Flugplatz anhand seiner Koordinate selbst in die passende Zelle --
 * ein Lauf dauert damit eher eine Stunde als Tage.
 *
 * Läuft mit reinem Node >=18 (globales `fetch`, `fs/promises`), keine
 * npm-Abhängigkeiten, kein `npm install` auf dem Server nötig.
 *
 * Aufruf: OPENAIP_API_KEY=... node fetch-airports.mjs [--out DIR]
 *   [--cell-size DEG] [--max-pages N]
 *
 * `--max-pages` holt nur die ersten N Seiten (für einen schnellen lokalen
 * Test); die Vollständigkeitsprüfung entfällt dann. Eine Bbox-Einschränkung
 * gibt es bewusst nicht: Cloudflare vor der API blockiert `bbox`-Anfragen
 * seit 2026-11 (s. README.md).
 *
 * Kein `--cells-file`-Modus wie bei den Lufträumen: Schlägt eine Seite nach
 * allen Retries fehl, bricht der ganze Lauf ab (alter Stand bleibt live) und
 * wird einfach komplett wiederholt -- das kostet hier nur Minuten.
 */

import { mkdir, writeFile, rm, rename } from "node:fs/promises";
import path from "node:path";

const API_KEY = process.env.OPENAIP_API_KEY;
if (!API_KEY) {
  console.error("OPENAIP_API_KEY ist nicht gesetzt.");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const OUT_DIR = path.resolve(args.out || "./output-airports");
const CELL_SIZE_DEG = Number(args["cell-size"] || 2);
const MAX_PAGES = args["max-pages"] ? Number(args["max-pages"]) : Infinity;

const API_URL = "https://api.core.openaip.net/api/airports";
const FIELDS = "name,icaoCode,type,geometry,frequencies";
const PAGE_LIMIT = 500;
// Rate-Limit und Retry-Verhalten wie in fetch-airspaces.mjs (dort empirisch
// ermittelt, s. README.md): 20s zwischen Requests, Backoff bei 404/408/429.
// 404 ist auch hier nie "keine Daten" (leere Seiten kommen als 200 mit leerem
// `items`), sondern das beobachtete Kontingent-Signal der API.
const REQUEST_DELAY_MS = 20000;
const MAX_RETRIES = 5;
const RETRY_BACKOFF_MS = 30_000;
// Wenn am Ende deutlich weniger Flugplätze vorliegen, als die API selbst als
// `totalCount` meldet, ist beim Blättern etwas schiefgelaufen -- dann lieber
// den alten Stand live lassen als einen lückenhaften auszuliefern.
const MIN_COMPLETENESS = 0.98;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Zellschlüssel "{latFloor}_{lonFloor}" für einen Punkt, wie in `meteokit/airspace`. */
function cellKeyForPoint(lon, lat) {
  // Punkte genau auf 180°E bzw. 90°N gehören noch in die letzte Zelle des Grids.
  const latFloor = Math.min(Math.floor(lat / CELL_SIZE_DEG) * CELL_SIZE_DEG, 90 - CELL_SIZE_DEG);
  const lonFloor = Math.min(Math.floor(lon / CELL_SIZE_DEG) * CELL_SIZE_DEG, 180 - CELL_SIZE_DEG);
  return `${latFloor}_${lonFloor}`;
}

/** Holt eine Seite; bei 404/408/429 mit Backoff wiederholen, sonst sofort werfen. */
async function fetchPage(page) {
  const url = `${API_URL}?limit=${PAGE_LIMIT}&page=${page}&fields=${FIELDS}`;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers: { "x-openaip-api-key": API_KEY } });
    if (res.ok) return res.json();
    if ((res.status === 404 || res.status === 408 || res.status === 429) && attempt < MAX_RETRIES) {
      console.warn(`  HTTP ${res.status} auf Seite ${page}, Versuch ${attempt + 1}/${MAX_RETRIES}, Pause ${RETRY_BACKOFF_MS / 1000}s ...`);
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    throw new Error(`HTTP ${res.status} auf Seite ${page}`);
  }
  throw new Error(`Rate-Limit/Timeout nach ${MAX_RETRIES} Versuchen: Seite ${page}`);
}

/**
 * Alle Flugplätze, vollständig paginiert und nach `_id` dedupliziert (falls
 * sich der Bestand während des Laufs verschiebt und ein Eintrag auf zwei
 * Seiten landet). Gibt zusätzlich das von der API gemeldete `totalCount` zurück.
 */
async function fetchAllAirports() {
  const byId = new Map();
  let totalCount = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchPage(page);
    const items = data.items || [];
    if (totalCount == null) totalCount = data.totalCount ?? null;
    for (const item of items) byId.set(item._id, item);
    console.log(`Seite ${page}${data.totalPages ? `/${data.totalPages}` : ""}: ${items.length} Einträge, ${byId.size} gesamt.`);
    await sleep(REQUEST_DELAY_MS);
    if (!data.nextPage || items.length < PAGE_LIMIT) break;
  }
  return { airports: [...byId.values()], totalCount };
}

async function main() {
  const stagingDir = `${OUT_DIR}.staging`;
  const tilesDir = path.join(stagingDir, "tiles");
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(tilesDir, { recursive: true });

  let airports, totalCount;
  try {
    ({ airports, totalCount } = await fetchAllAirports());
  } catch (err) {
    console.error(`Abgebrochen (${err.message}) -- der bisherige Live-Stand unter ${OUT_DIR} bleibt unverändert (kein Swap).`);
    await rm(stagingDir, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }

  if (MAX_PAGES === Infinity && totalCount != null && airports.length < totalCount * MIN_COMPLETENESS) {
    console.error(`Abgebrochen: nur ${airports.length} von ${totalCount} gemeldeten Flugplätzen geholt -- der bisherige Live-Stand unter ${OUT_DIR} bleibt unverändert (kein Swap).`);
    await rm(stagingDir, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }

  const cells = new Map();
  let skipped = 0;
  for (const item of airports) {
    const { geometry, ...properties } = item;
    const [lon, lat] = geometry?.coordinates || [];
    if (geometry?.type !== "Point" || !Number.isFinite(lon) || !Number.isFinite(lat)) {
      skipped++;
      continue;
    }
    const key = cellKeyForPoint(lon, lat);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push({ type: "Feature", geometry, properties });
  }
  if (skipped > 0) console.warn(`${skipped} Flugplätze ohne gültige Punktgeometrie übersprungen.`);

  let totalFeatures = 0;
  for (const [key, features] of cells) {
    await writeFile(path.join(tilesDir, `${key}.geojson`), JSON.stringify({ type: "FeatureCollection", features }));
    totalFeatures += features.length;
  }

  await writeFile(
    path.join(stagingDir, "meta.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      cellSizeDeg: CELL_SIZE_DEG,
      cellCount: cells.size,
      totalFeatures,
    }, null, 2),
  );

  // Atomarer Swap wie in fetch-airspaces.mjs: nie einen halb-geschriebenen
  // Zustand live ausliefern.
  const backupDir = `${OUT_DIR}.previous`;
  await rm(backupDir, { recursive: true, force: true });
  try {
    await rename(OUT_DIR, backupDir);
  } catch {
    // Erster Lauf überhaupt: OUT_DIR existiert noch nicht -- kein Problem.
  }
  await rename(stagingDir, OUT_DIR);
  await rm(backupDir, { recursive: true, force: true });

  console.log(`Fertig: ${cells.size} Zellen, ${totalFeatures} Flugplätze gesamt, ausgeliefert unter ${OUT_DIR}.`);
}

main().catch((err) => {
  console.error("Abbruch:", err);
  process.exit(1);
});
