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
 *   [--cells-file PATH]
 *
 * `--test-bbox` beschränkt den Lauf auf eine einzelne, kleine Region (für
 * einen schnellen lokalen Test statt des mehrtägigen Welt-Grids).
 *
 * `--cells-file` liest eine Liste von Bboxen (eine "minLon,minLat,maxLon,maxLat"
 * pro Zeile) statt des vollen Welt-Grids und schreibt sie direkt in das
 * bereits live ausgelieferte `--out`-Verzeichnis (kein Staging/Swap -- reine
 * Ergänzung). Gedacht, um gezielt Zellen nachzuholen, die in einem früheren
 * Lauf nach Erschöpfen der Retries als fehlgeschlagen markiert wurden (s.
 * `<out>.failed-cells.txt`, wird bei jedem Lauf automatisch geschrieben,
 * sobald mindestens eine Zelle endgültig fehlschlägt).
 */

import { mkdir, writeFile, rm, rename, readdir, readFile, appendFile } from "node:fs/promises";
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
const CELLS_FILE = args["cells-file"] || null;

const API_URL = "https://api.core.openaip.net/api/airspaces";
const FIELDS = "name,icaoClass,type,activity,geometry,upperLimit,lowerLimit,country";
const PAGE_LIMIT = 500;
// Empirisch am 2026-09-13 gegen die echte API ermittelt: 1.5s zwischen Requests
// führte fast durchgehend zu 429; selbst 15s brachte noch ca. 40% 429-Treffer.
// 20s als Basis-Delay + der bestehende Retry-Backoff bei 429/404/408 als Netz.
const REQUEST_DELAY_MS = 20000;
const MAX_RETRIES = 5;
const RETRY_BACKOFF_MS = 30_000; // bei 404/408/429: erstmal deutlich länger pausieren als der reguläre Delay
// Beim Welt-Lauf 2026-09-13..17 beobachtet: ab einem bestimmten Punkt hat die
// API ~1,5 Tage lang JEDE Anfrage mit 404 statt Daten beantwortet (vermutlich
// ein Tages-/Laufkontingent, das nicht sauber als 429 signalisiert wird).
// Das Skript hat das damals als "hier gibt es keinen Luftraum" missverstanden
// und über 4800 Zellen (u.a. ganz Mitteleuropa, große Teile der USA) leer
// gelassen. Ein einzelner 404 ist also nicht vertrauenswürdig als "leer" --
// erst nach MAX_RETRIES Versuchen gilt eine Zelle als "kein Ergebnis", und
// mehrere solcher Zellen in Folge brechen den ganzen Lauf ab, statt einen
// Großteil der Welt fälschlich als leer zu veröffentlichen.
const CONSECUTIVE_FAILURE_LIMIT = 10;

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

async function cellsFromFile(filePath) {
  const text = await readFile(filePath, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(",").map(Number));
}

function cellKey(minLon, minLat) {
  return `${minLat}_${minLon}`;
}

/**
 * Holt eine Seite; bei 404/408/429 wird mit Backoff wiederholt (kein Abbruch
 * der einzelnen Zelle -- ein einzelner Treffer soll den mehrstündigen Lauf
 * nicht beenden). 404 ist dabei bewusst mit dabei: die API liefert für
 * tatsächlich leere Bboxen ein reguläres 200 mit leerem `items`-Array, ein
 * 404 ist hier also immer ein Fehlersignal, nie eine legitime "keine Daten"-
 * Antwort (s. Kommentar bei CONSECUTIVE_FAILURE_LIMIT oben). Andere
 * Fehlerstatus werfen sofort.
 */
async function fetchPage(bbox, page) {
  const url = `${API_URL}?bbox=${bbox.join(",")}&limit=${PAGE_LIMIT}&page=${page}&fields=${FIELDS}`;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers: { "x-openaip-api-key": API_KEY } });
    if (res.ok) return res.json();
    if ((res.status === 404 || res.status === 408 || res.status === 429) && attempt < MAX_RETRIES) {
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

async function writeCell(tilesDir, bbox) {
  const key = cellKey(bbox[0], bbox[1]);
  const features = await fetchCellFeatures(bbox); // wirft nach MAX_RETRIES erschöpften Versuchen
  if (features.length > 0) {
    await writeFile(path.join(tilesDir, `${key}.geojson`), JSON.stringify({ type: "FeatureCollection", features }));
  }
  return features.length;
}

/** Zählt Zellen/Features im bereits geschriebenen `tilesDir` -- für eine wahrheitsgetreue meta.json nach einem Merge-Lauf. */
async function countTiles(tilesDir) {
  const files = (await readdir(tilesDir)).filter((f) => f.endsWith(".geojson"));
  let totalFeatures = 0;
  for (const file of files) {
    const data = JSON.parse(await readFile(path.join(tilesDir, file), "utf8"));
    totalFeatures += data.features.length;
  }
  return { cellCount: files.length, totalFeatures };
}

async function main() {
  const isMerge = Boolean(CELLS_FILE);
  const tilesDir = isMerge ? path.join(OUT_DIR, "tiles") : path.join(`${OUT_DIR}.staging`, "tiles");

  if (isMerge) {
    await mkdir(tilesDir, { recursive: true }); // OUT_DIR existiert bereits (live ausgeliefert), tiles/ sicherheitshalber sicherstellen
  } else {
    await rm(`${OUT_DIR}.staging`, { recursive: true, force: true });
    await mkdir(tilesDir, { recursive: true });
  }

  const allCells = isMerge ? await cellsFromFile(CELLS_FILE) : [...cells()];
  const failedCellsFile = `${OUT_DIR}.failed-cells.txt`;
  await rm(failedCellsFile, { force: true });

  let cellCount = 0;
  let totalFeatures = 0;
  let cellIndex = 0;
  let consecutiveFailures = 0;
  let aborted = false;

  for (const bbox of allCells) {
    cellIndex++;
    const key = cellKey(bbox[0], bbox[1]);
    console.log(`[${cellIndex}/${allCells.length}] Zelle ${key} (bbox ${bbox.join(",")}) ...`);
    try {
      const n = await writeCell(tilesDir, bbox);
      consecutiveFailures = 0;
      if (n > 0) {
        cellCount++;
        totalFeatures += n;
        console.log(`  ${n} Features geschrieben.`);
      }
    } catch (err) {
      console.error(`  Übersprungen nach Fehler: ${err.message}`);
      await appendFile(failedCellsFile, `${bbox.join(",")}\n`);
      consecutiveFailures++;
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        console.error(
          `${consecutiveFailures} Zellen in Folge fehlgeschlagen -- vermutlich ein anhaltendes API-Problem ` +
          `(z.B. ein Tageskontingent, das als 404 statt 429 signalisiert wird). Breche ab, statt den Rest der ` +
          `Welt fälschlich als "leer" zu veröffentlichen. Verbleibende Zellen werden ${isMerge ? "" : "ebenfalls "}nach ${failedCellsFile} geschrieben.`
        );
        if (!isMerge) {
          const remaining = allCells.slice(cellIndex);
          for (const rest of remaining) await appendFile(failedCellsFile, `${rest.join(",")}\n`);
        }
        aborted = true;
        break;
      }
    }
  }

  if (isMerge) {
    const totals = await countTiles(tilesDir);
    await writeFile(
      path.join(OUT_DIR, "meta.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), cellSizeDeg: CELL_SIZE_DEG, ...totals }, null, 2),
    );
    console.log(`Merge fertig: ${cellCount} von ${allCells.length} angefragten Zellen hatten Daten, insgesamt jetzt ${totals.cellCount} Zellen / ${totals.totalFeatures} Features live.`);
    if (aborted) process.exitCode = 1;
    return;
  }

  if (aborted) {
    console.error(`Abgebrochen -- der bisherige Live-Stand unter ${OUT_DIR} bleibt unverändert (kein Swap). Fehlgeschlagene Zellen stehen in ${failedCellsFile}, erneut versuchen mit --cells-file.`);
    await rm(`${OUT_DIR}.staging`, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }

  await writeFile(
    path.join(`${OUT_DIR}.staging`, "meta.json"),
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
  await rename(`${OUT_DIR}.staging`, OUT_DIR);
  await rm(backupDir, { recursive: true, force: true });

  console.log(`Fertig: ${cellCount} Zellen, ${totalFeatures} Features gesamt, ausgeliefert unter ${OUT_DIR}.`);
}

main().catch((err) => {
  console.error("Abbruch:", err);
  process.exit(1);
});
