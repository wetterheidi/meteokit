#!/usr/bin/env node
/**
 * Holt weltweit alle openAIP-Luftraumdaten und schreibt sie als statische,
 * in Grid-Zellen aufgeteilte GeoJSON-Dateien -- Grundlage für
 * `meteokit/airspace`s Cache-Server (s. README.md in diesem Ordner für den
 * Hintergrund: openAIPs Live-`/api/airspaces`-bbox-Endpunkt ist für
 * Browser-Viewport-Abfragen nicht geeignet, dafür aber genau für diesen
 * Anwendungsfall -- einen periodischen Bulk-Export -- laut eigener Doku
 * vorgesehen).
 *
 * Läuft mit reinem Node >=18 (globales `fetch`, `fs/promises`), keine
 * npm-Abhängigkeiten, kein `npm install` auf dem Server nötig.
 *
 * Aufruf: OPENAIP_API_KEY=... node fetch-airspaces.mjs [--out DIR]
 *   [--cell-size DEG] [--test-bbox minLon,minLat,maxLon,maxLat]
 *
 * `--test-bbox` beschränkt den Lauf auf eine einzelne, kleine Region (für
 * einen schnellen lokalen Test statt des mehrstündigen Welt-Grids).
 */

import { mkdir, writeFile, rm, rename } from "node:fs/promises";
import path from "node:path";

const API_KEY = process.env.OPENAIP_API_KEY;
if (!API_KEY) {
  console.error("OPENAIP_API_KEY ist nicht gesetzt.");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const OUT_DIR = path.resolve(args.out || "./output");
const CELL_SIZE_DEG = Number(args["cell-size"] || 2);
const TEST_BBOX = args["test-bbox"] ? args["test-bbox"].split(",").map(Number) : null;

const API_URL = "https://api.core.openaip.net/api/airspaces";
const FIELDS = "name,icaoClass,type,activity,geometry,upperLimit,lowerLimit,country";
const PAGE_LIMIT = 500;
// Empirisch am 2026-09-13 gegen die echte API ermittelt: 1.5s zwischen Requests
// führte fast durchgehend zu 429; selbst 15s brachte noch ca. 40% 429-Treffer.
// 20s als Basis-Delay + der bestehende Retry-Backoff bei 429/408 als Netz.
const REQUEST_DELAY_MS = 20000;
const MAX_RETRIES = 5;
const RETRY_BACKOFF_MS = 30_000; // bei 408/429: erstmal deutlich länger pausieren als der reguläre Delay

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

/** Alle Zellgrenzen (minLon,minLat,maxLon,maxLat) im Welt-Grid, oder nur die Test-Bbox. */
function* cells() {
  if (TEST_BBOX) {
    yield TEST_BBOX;
    return;
  }
  for (let lat = -90; lat < 90; lat += CELL_SIZE_DEG) {
    for (let lon = -180; lon < 180; lon += CELL_SIZE_DEG) {
      yield [lon, lat, lon + CELL_SIZE_DEG, lat + CELL_SIZE_DEG];
    }
  }
}

function cellKey(minLon, minLat) {
  return `${minLat}_${minLon}`;
}

/**
 * Holt eine Seite; bei 408/429 wird mit Backoff wiederholt (kein Abbruch --
 * ein einzelner Timeout/Ratelimit-Treffer soll den mehrstündigen Lauf nicht
 * beenden). Andere Fehlerstatus werfen sofort.
 */
async function fetchPage(bbox, page) {
  const url = `${API_URL}?bbox=${bbox.join(",")}&limit=${PAGE_LIMIT}&page=${page}&fields=${FIELDS}`;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers: { "x-openaip-api-key": API_KEY } });
    if (res.ok) return res.json();
    if ((res.status === 408 || res.status === 429) && attempt < MAX_RETRIES) {
      console.warn(`  HTTP ${res.status} auf ${bbox.join(",")} (Seite ${page}), Versuch ${attempt + 1}/${MAX_RETRIES}, Pause ${RETRY_BACKOFF_MS / 1000}s ...`);
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    throw new Error(`HTTP ${res.status} auf ${bbox.join(",")} (Seite ${page})`);
  }
  throw new Error(`Rate-Limit/Timeout nach ${MAX_RETRIES} Versuchen: ${bbox.join(",")}`);
}

/** Alle Features einer Zelle, vollständig paginiert. */
async function fetchCellFeatures(bbox) {
  const features = [];
  for (let page = 1; ; page++) {
    const data = await fetchPage(bbox, page);
    const items = data.items || [];
    for (const item of items) {
      const { geometry, ...properties } = item;
      features.push({ type: "Feature", geometry, properties });
    }
    await sleep(REQUEST_DELAY_MS);
    if (!data.nextPage || items.length < PAGE_LIMIT) break;
  }
  return features;
}

async function main() {
  const stagingDir = `${OUT_DIR}.staging`;
  const tilesDir = path.join(stagingDir, "tiles");
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(tilesDir, { recursive: true });

  let cellCount = 0;
  let totalFeatures = 0;
  let cellIndex = 0;
  const allCells = [...cells()];

  for (const bbox of allCells) {
    cellIndex++;
    const key = cellKey(bbox[0], bbox[1]);
    console.log(`[${cellIndex}/${allCells.length}] Zelle ${key} (bbox ${bbox.join(",")}) ...`);
    let features;
    try {
      features = await fetchCellFeatures(bbox);
    } catch (err) {
      console.error(`  Übersprungen nach Fehler: ${err.message}`);
      continue;
    }
    if (features.length > 0) {
      await writeFile(
        path.join(tilesDir, `${key}.geojson`),
        JSON.stringify({ type: "FeatureCollection", features }),
      );
      cellCount++;
      totalFeatures += features.length;
      console.log(`  ${features.length} Features geschrieben.`);
    }
  }

  await writeFile(
    path.join(stagingDir, "meta.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      cellSizeDeg: CELL_SIZE_DEG,
      cellCount,
      totalFeatures,
    }, null, 2),
  );

  // Atomarer Swap: erst wenn alles fertig geschrieben ist, den alten Stand
  // ersetzen -- nie einen halb-geschriebenen Zustand live ausliefern.
  const backupDir = `${OUT_DIR}.previous`;
  await rm(backupDir, { recursive: true, force: true });
  try {
    await rename(OUT_DIR, backupDir);
  } catch {
    // Erster Lauf überhaupt: OUT_DIR existiert noch nicht -- kein Problem.
  }
  await rename(stagingDir, OUT_DIR);
  await rm(backupDir, { recursive: true, force: true });

  console.log(`Fertig: ${cellCount} Zellen, ${totalFeatures} Features gesamt, ausgeliefert unter ${OUT_DIR}.`);
}

main().catch((err) => {
  console.error("Abbruch:", err);
  process.exit(1);
});
