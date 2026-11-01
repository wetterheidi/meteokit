#!/usr/bin/env node
/**
 * Holt weltweit alle openAIP-Luftraumdaten und schreibt sie als statische,
 * in Grid-Zellen aufgeteilte GeoJSON-Dateien -- Grundlage für
 * `meteokit/airspace`s Cache-Server (s. README.md in diesem Ordner für den
 * Hintergrund: openAIPs Live-`/api/airspaces`-Endpunkt ist für
 * Browser-Viewport-Abfragen nicht geeignet, dafür aber genau für diesen
 * Anwendungsfall -- einen periodischen Bulk-Export -- laut eigener Doku
 * vorgesehen).
 *
 * Seit 2026-11 ohne Bbox-Rasterung: Cloudflare vor der API blockiert
 * Anfragen mit `bbox` bzw. `pos`/`dist` inzwischen mit einer 403-Seite (s.
 * README.md). Das Skript blättert deshalb den gesamten Bestand durch und
 * verteilt jeden Luftraum selbst auf alle Zellen, die seine Bounding-Box
 * schneidet -- wie zuvor die API pro Zell-Bbox, nur ohne Geo-Abfrage.
 *
 * Läuft mit reinem Node >=18 (globales `fetch`, `fs/promises`), keine
 * npm-Abhängigkeiten, kein `npm install` auf dem Server nötig.
 *
 * Aufruf: OPENAIP_API_KEY=... node fetch-airspaces.mjs [--out DIR]
 *   [--cell-size DEG] [--max-pages N]
 *
 * `--max-pages` holt nur die ersten N Seiten (für einen schnellen lokalen
 * Test); die Vollständigkeitsprüfung entfällt dann.
 *
 * Schlägt eine Seite nach allen Retries fehl, bricht der ganze Lauf ab (alter
 * Stand bleibt live) und wird einfach komplett wiederholt -- das kostet nur
 * Minuten.
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
const MAX_PAGES = args["max-pages"] ? Number(args["max-pages"]) : Infinity;

const API_URL = "https://api.core.openaip.net/api/airspaces";
const FIELDS = "name,icaoClass,type,activity,geometry,upperLimit,lowerLimit,country,frequencies";
const PAGE_LIMIT = 500;
// Empirisch am 2026-09-13 gegen die echte API ermittelt: 1.5s zwischen Requests
// führte fast durchgehend zu 429; selbst 15s brachte noch ca. 40% 429-Treffer.
// 20s als Basis-Delay + Retry-Backoff bei 429/404/408 als Netz.
const REQUEST_DELAY_MS = 20000;
const MAX_RETRIES = 5;
const RETRY_BACKOFF_MS = 30_000; // bei 404/408/429: erstmal deutlich länger pausieren als der reguläre Delay
// Beim Welt-Lauf 2026-09-13..17 hat die API ~1,5 Tage lang JEDE Anfrage mit
// 404 beantwortet (s. README.md) -- ein 404 ist nie "keine Daten", leere
// Ergebnisse kommen als 200 mit leerem `items`. Liegen am Ende deutlich
// weniger Lufträume vor, als die API selbst als `totalCount` meldet, ist beim
// Blättern etwas schiefgelaufen -- dann lieber den alten Stand live lassen.
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
 * Alle Lufträume, vollständig paginiert und nach `_id` dedupliziert (falls
 * sich der Bestand während des Laufs verschiebt und ein Eintrag auf zwei
 * Seiten landet). Gibt zusätzlich das von der API gemeldete `totalCount` zurück.
 *
 * Jeder Luftraum wird sofort zu `{ json, keys }` reduziert (fertig
 * serialisiertes Feature + Zellschlüssel): Der Server hat nur ~1 GB RAM frei,
 * und der Bestand umfasst mehrere hundert MB Geometrie -- als geparste
 * Objekte wäre das ein Vielfaches davon.
 */
async function fetchAllAirspaces() {
  const byId = new Map();
  let totalCount = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchPage(page);
    const items = data.items || [];
    if (totalCount == null) totalCount = data.totalCount ?? null;
    for (const item of items) byId.set(item._id, toEntry(item));
    console.log(`Seite ${page}${data.totalPages ? `/${data.totalPages}` : ""}: ${items.length} Einträge, ${byId.size} gesamt.`);
    await sleep(REQUEST_DELAY_MS);
    if (!data.nextPage || items.length < PAGE_LIMIT) break;
  }
  return { airspaces: [...byId.values()], totalCount };
}

function toEntry(item) {
  const { geometry, ...properties } = item;
  const keys = geometry?.coordinates ? cellKeysForGeometry(geometry) : [];
  return { json: JSON.stringify({ type: "Feature", geometry, properties }), keys };
}

/** Alle [lon, lat]-Paare einer (Multi-)Polygon-Geometrie. */
function* positions(geometry) {
  const polygons = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  for (const polygon of polygons) {
    for (const ring of polygon) yield* ring;
  }
}

/**
 * Zellschlüssel "{latFloor}_{lonFloor}" aller Zellen, die die Bounding-Box der
 * Geometrie schneiden. Ein Polygon über die Datumsgrenze (Längenspanne >180°)
 * wird als zwei Bereiche [-180, größte negative Länge] und [kleinste positive
 * Länge, 180] behandelt statt als Band um die ganze Welt.
 */
function cellKeysForGeometry(geometry) {
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;
  let maxNegLon = -Infinity, minPosLon = Infinity;
  for (const [lon, lat] of positions(geometry)) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    if (lon < 0) maxNegLon = Math.max(maxNegLon, lon);
    else minPosLon = Math.min(minPosLon, lon);
  }
  if (!Number.isFinite(minLat)) return [];

  const lonRanges = maxLon - minLon > 180 ? [[-180, maxNegLon], [minPosLon, 180]] : [[minLon, maxLon]];
  const floorCell = (v, max) => Math.min(Math.floor(v / CELL_SIZE_DEG) * CELL_SIZE_DEG, max - CELL_SIZE_DEG);
  const keys = [];
  for (let lat = floorCell(minLat, 90); lat <= floorCell(maxLat, 90); lat += CELL_SIZE_DEG) {
    for (const [lo, hi] of lonRanges) {
      for (let lon = floorCell(lo, 180); lon <= floorCell(hi, 180); lon += CELL_SIZE_DEG) {
        keys.push(`${lat}_${lon}`);
      }
    }
  }
  return keys;
}

async function main() {
  const stagingDir = `${OUT_DIR}.staging`;
  const tilesDir = path.join(stagingDir, "tiles");
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(tilesDir, { recursive: true });

  let airspaces, totalCount;
  try {
    ({ airspaces, totalCount } = await fetchAllAirspaces());
  } catch (err) {
    console.error(`Abgebrochen (${err.message}) -- der bisherige Live-Stand unter ${OUT_DIR} bleibt unverändert (kein Swap).`);
    await rm(stagingDir, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }

  if (MAX_PAGES === Infinity && totalCount != null && airspaces.length < totalCount * MIN_COMPLETENESS) {
    console.error(`Abgebrochen: nur ${airspaces.length} von ${totalCount} gemeldeten Lufträumen geholt -- der bisherige Live-Stand unter ${OUT_DIR} bleibt unverändert (kein Swap).`);
    await rm(stagingDir, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }

  const cells = new Map();
  let skipped = 0;
  for (const { json, keys } of airspaces) {
    if (keys.length === 0) {
      skipped++;
      continue;
    }
    for (const key of keys) {
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(json);
    }
  }
  if (skipped > 0) console.warn(`${skipped} Lufträume ohne verwertbare Geometrie übersprungen.`);

  // totalFeatures zählt wie bisher Features summiert über alle Kacheln (ein
  // Luftraum über mehreren Zellen zählt mehrfach), airspaceCount die
  // eindeutigen Lufträume.
  let totalFeatures = 0;
  for (const [key, features] of cells) {
    await writeFile(path.join(tilesDir, `${key}.geojson`), `{"type":"FeatureCollection","features":[${features.join(",")}]}`);
    totalFeatures += features.length;
  }

  await writeFile(
    path.join(stagingDir, "meta.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      cellSizeDeg: CELL_SIZE_DEG,
      cellCount: cells.size,
      totalFeatures,
      airspaceCount: airspaces.length - skipped,
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

  console.log(`Fertig: ${cells.size} Zellen, ${airspaces.length - skipped} Lufträume, ${totalFeatures} Features über alle Kacheln, ausgeliefert unter ${OUT_DIR}.`);
}

main().catch((err) => {
  console.error("Abbruch:", err);
  process.exit(1);
});
