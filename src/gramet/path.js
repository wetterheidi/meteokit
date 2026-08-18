/**
 * Fetch-Orchestrierung für den GRAMET-Path-Modus: holt pro (sub-gesampeltem)
 * Wegpunkt eine volle Säule (`column.js` `fetchColumn`), prüft VOR jedem Fetch
 * die Modell-Bbox (s. Kommentar unten) und setzt das Gitter zusammen
 * (`grid.js` `gridFromWaypoints`). Getrennt von `grid.js`, das nur noch reine
 * Form-Assemblierung macht -- diese Datei trägt die Netzwerk-/Policy-Seite.
 */

import { getModel } from "../config.js";
import { fetchColumn } from "../column.js";
import { fetchSurface } from "../weather.js";
import { gridFromWaypoints } from "./grid.js";
import { deriveView } from "./derive.js";
import { resamplePath } from "./resample.js";
import { fetchTerrainProfile } from "./terrain.js";

// Bbox-Verlassen VOR dem Fetch prüfen, nicht danach: `fetchColumn` nutzt
// `cell_selection: "nearest"` (s. column.js) -- ein Punkt außerhalb der Bbox
// bekäme sonst KEINEN Fehler, sondern still die nächstgelegene Zelle unter
// falschem Label zurück. Dieselbe Prüfung/Meldung wie `windfield.js`
// (`inBBox`, "Rand des Modellgebiets erreicht", dort für die Wind-Overlay-
// Interpolation) -- hier eine eigene, lokale Kopie statt eines Imports, weil
// `windfield.js`s Klasse deutlich mehr mitbringt (Gitter-Cache, Interpolation),
// als hier gebraucht wird.
function inBBox(lat, lon, model) {
  const b = model.bbox;
  return lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax;
}

const BBOX_STOP_REASON = "Rand des Modellgebiets erreicht";
// `MODELS[key].bbox` ist nur eine rechteckige Näherung -- das tatsächliche
// Modellgebiet (z. B. ICON-D2) ist kleiner/unregelmäßig geschnitten. Ein
// Punkt kann also innerhalb der Bbox liegen und trotzdem keine Daten liefern
// (`fetchColumn` trimmt die Zeitreihe dann auf Länge 0, s. dort). Realer Fall,
// mit echten Koordinaten reproduziert -- kein hypothetischer Randfall.
const NO_DATA_STOP_REASON = "Keine Modelldaten an diesem Punkt";

// Gleichzeitige Säulen-Fetches. Ein Pfad braucht bis zu `maxCols` volle
// Modellsäulen, und EINE Säule ist teuer: 65-120 Level x 11 Variablen, gemessen
// 2,2 s (ICON-D2) bzw. 4,2 s (ICON-EU) pro Request. Streng nacheinander wurde
// ein 12-h-Pfad damit zur Dreiviertelminute, in der die Host-App nur "lädt"
// zeigen konnte (Feedback aus `trajectories`).
// Der Server skaliert gut mit Parallelität (16 gleichzeitige Säulen kosteten
// im Test nur ~1,7x die Zeit einer einzelnen): 16 Spalten brauchten mit Pool 6
// gemessen 8,1 s, mit Pool 12 nur 3,5 s. Trotzdem bewusst NICHT ans Maximum
// gegangen -- beim Testen quittierte die private Instanz anhaltende Last mit
// 429/503. 8 ist der Kompromiss: klar schneller als 6, aber kein Schwall, der
// eine Ratenbegrenzung reißt. Ein doch auftretender 429 ist seit `column.js`
// (`RETRYABLE_STATUS`) kein Abbruch mehr, sondern wird ausgesessen.
const FETCH_CONCURRENCY = 8;

/** `mapper` über alle `items`, höchstens `limit` gleichzeitig. Ergebnisse in
 *  Eingabereihenfolge (die Pfadreihenfolge trägt hier Bedeutung). */
async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await mapper(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Open-Meteo liefert immer stündlich, unabhängig vom Modell (`grid.js`s
// `meta.dt` ist faktisch immer 3600s) -- die zeitliche Auflösung ist also
// eine Konstante, keine Modell-Eigenschaft.
const MODEL_TIME_RES_SEC = 3600;

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Datumsbereich (UTC), der alle Wegpunkt-Zeiten abdeckt -- als `horizon`-
 * Objekt für `fetchColumn`/`fetchSurface` (s. `weather.js` `horizonParams()`).
 * Anders als das frühere `forecast_days` funktioniert das auch für Pfade in
 * der Vergangenheit (Rückwärtstrajektorien) und lädt für Zukunftspfade nur
 * die tatsächlich benötigten Tage statt des vollen Vorhersagehorizonts.
 * 1 h Polster an beiden Enden: `sliceColumnAtTime` klemmt an den Serien-
 * rändern (s. `column.js` `bracketTime`) -- ein Wegpunkt um 23:30 UTC darf
 * nicht auf die 23:00-Stunde des Endtags geklemmt werden.
 */
function dateRangeOfWaypoints(waypoints) {
  const day = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
  return {
    startDate: day(waypoints[0].t - 3600),
    endDate: day(waypoints[waypoints.length - 1].t + 3600),
  };
}

/**
 * Verstrichene Sekunden seit `waypoints[0].t` -- der X-Achsen-Positionswert
 * im Path-Modus (Entscheidung: verstrichene Zeit statt Distanz, s. Diskussion
 * vor dem Umbau). Separat exportiert, damit ein späteres Terrain-Profil
 * (Mapterhorn, noch nicht umgesetzt) dieselbe Positionsberechnung wieder-
 * verwenden kann, statt unabhängig davon zu driften.
 */
export function posOfPath(waypoints) {
  const t0 = waypoints[0].t;
  return waypoints.map((wp) => wp.t - t0);
}

/**
 * Kombinierte Sampling-Policy ("Fall C", s. Diskussion): ein Wegpunkt wird
 * erst tatsächlich gefetcht, wenn seit dem zuletzt gefetchten ENTWEDER die
 * Modell-Zeitauflösung (`timeResSec`, Default `MODEL_TIME_RES_SEC`) ODER die
 * Modell-Gitterweite (`distResM`, Default `model.gridMeters`) überschritten
 * ist -- was zuerst eintritt. Bildet ab, wann das Modell überhaupt neue
 * Information hergibt, statt pauschal eine feste Spaltenzahl übers Gitter
 * zu verteilen.
 * @returns Indizes in `waypoints`, aufsteigend, ohne Duplikate, immer inkl.
 *   erstem und letztem Index.
 */
function selectWaypointsToFetch(waypoints, model, opts = {}) {
  const maxCols = opts.maxCols ?? 12;
  const timeResSec = opts.timeResSec ?? MODEL_TIME_RES_SEC;
  const distResM = opts.distResM ?? model.gridMeters;

  const candidates = [0];
  let last = waypoints[0];
  for (let i = 1; i < waypoints.length; i++) {
    const wp = waypoints[i];
    const dt = wp.t - last.t;
    const dist = haversineM(last.lat, last.lon, wp.lat, wp.lon);
    if (dt >= timeResSec || dist >= distResM) {
      candidates.push(i);
      last = wp;
    }
  }
  const lastIdx = waypoints.length - 1;
  if (candidates[candidates.length - 1] !== lastIdx) candidates.push(lastIdx);

  // Notbremse: übersteigt die so entstandene Liste trotzdem `maxCols` (z. B.
  // ein sehr langer Loiter-Flug, der die Zeitschwelle laufend reißt, ohne
  // räumlich voranzukommen), gleichmäßig ausdünnen -- gleiche Methode wie die
  // frühere Platzhalter-Policy, jetzt nur noch als Fallback statt Regelfall.
  if (candidates.length <= maxCols) return candidates;
  const thinned = new Set();
  for (let k = 0; k < maxCols; k++) {
    thinned.add(candidates[Math.round((k / (maxCols - 1)) * (candidates.length - 1))]);
  }
  return [...thinned].sort((a, b) => a - b);
}

/**
 * Holt Säulen für eine (sub-gesampelte) Wegpunktliste, bricht beim ersten
 * Verlassen der Modell-Bbox ab (kein weiterer Fetch danach, kein
 * Modell-Handoff -- ein Path-Grid nimmt EIN Modell für den gesamten Pfad an,
 * s. Plan), und setzt das Gitter zusammen.
 * @param waypoints Array<{ lat, lon, t }> -- dicht, vom Aufrufer geliefert
 *   (z. B. aus einer Trajektorienberechnung), `t` in Unixsekunden,
 *   aufsteigend (Rückwärtstrajektorien vor der Übergabe umkehren).
 * @param forecastDays ungenutzt (historisch) -- der Zeithorizont wird seit
 *   der `start_date`/`end_date`-Umstellung aus den Wegpunkt-Zeiten selbst
 *   abgeleitet (s. `dateRangeOfWaypoints`), womit auch Pfade in der
 *   Vergangenheit funktionieren. Parameter bleibt für Aufrufer-Kompatibilität
 *   in der Signatur.
 * @param opts { maxCols, timeResSec, distResM (s. `selectWaypointsToFetch`),
 *   resampleIntervalSec (optional -- wenn gesetzt, wird das gefetchte,
 *   sparsame Gitter per `resample.js` `resamplePath()` auf diese Kadenz in
 *   Sekunden interpoliert, z. B. 600 für alle 10 min; ohne diese Option
 *   bleibt es bei einer Spalte pro tatsächlich gefetchtem Wegpunkt),
 *   terrain (optional -- wenn true, wird zusätzlich ein Geländeprofil per
 *   `terrain.js` `fetchTerrainProfile()` geholt, unabhängig von der
 *   Wetter-Fetch-Policy und parallel zur Wetterschleife),
 *   terrainIntervalSec (optional, an `fetchTerrainProfile` durchgereicht --
 *   Geländesampling-Kadenz, Default dort "etwa minütlich"),
 *   terrainDeferred (optional -- wenn true, wartet der Aufruf NICHT auf das
 *   Geländeprofil, sondern liefert `terrain: null` plus `terrainPromise`;
 *   s. Begründung am Rückgabewert) }
 * @returns { grid, view, pathStop: { lat, lon, index, reason } | null,
 *   terrain: { pos, elevation, gaps } | null, terrainPromise? }
 *
 * Zum Gelände: es ist ein VERGLEICHS-Overlay, das Wetter ist der Inhalt --
 * trotzdem dominierte es die Wartezeit, weil ein langer Pfad viele
 * Mapterhorn-Kacheln braucht (im Browser gemessen deutlich mehr als der
 * gesamte Wetterabruf). Mit `terrainDeferred` kann die Host-App die Tafel
 * zeichnen, sobald das Wetter steht, und das Gelände nachreichen, sobald
 * `terrainPromise` erfüllt ist (Ergebnis bereits auf den Chartbereich
 * zugeschnitten, direkt an `<gramet-panel>.update({ terrain })` übergebbar).
 */
export async function fetchGridForPath(waypoints, modelKey, forecastDays, fetchImpl, opts = {}) {
  const model = getModel(modelKey);
  if (waypoints.length < 2) throw new Error("Path-Modus braucht mindestens zwei Wegpunkte");

  const pos = posOfPath(waypoints);
  const horizon = dateRangeOfWaypoints(waypoints);
  const indices = selectWaypointsToFetch(waypoints, model, opts);
  // Läuft unabhängig von der Wetterschleife unten durch -- Gelände hat nichts
  // mit der Modell-Bbox/-Auflösung zu tun, deshalb über die volle dichte
  // `waypoints`-Liste statt über die (sparsame) Fetch-Policy-Auswahl.
  const terrainPromise = opts.terrain
    ? fetchTerrainProfile(waypoints, { fetchImpl, terrainIntervalSec: opts.terrainIntervalSec })
    : null;

  // Bbox-Abbruch VOR dem Netzwerk bestimmen: die Prüfung ist rein lokal, also
  // muss dafür (anders als früher) nicht erst Spalte für Spalte gefetcht
  // werden -- so lassen sich alle verbleibenden Wegpunkte parallel holen.
  let pathStop = null;
  const toFetch = [];
  for (const i of indices) {
    const wp = waypoints[i];
    if (!inBBox(wp.lat, wp.lon, model)) {
      pathStop = { lat: wp.lat, lon: wp.lon, index: i, reason: BBOX_STOP_REASON };
      break;
    }
    toFetch.push(i);
  }

  // Säule (Modell-Level, `column.js`, private Instanz) und Oberflächenwerte
  // (`weather.js`, öffentliche Instanz, s. `SURFACE_API_BASE` in config.js)
  // sind zwei getrennte Requests an zwei getrennte Instanzen -- parallel,
  // weil keins vom Ergebnis des anderen abhängt. Ein Ausfall der
  // Oberflächenwerte bricht den Pfad NICHT ab (nur die ergänzenden
  // Zahlen-/Wetter-Zeilen bleiben dann für diesen Wegpunkt leer, s.
  // `grid.js` `buildSurfaceFromWaypoints`) -- anders als die Säule, ohne
  // die es für diese Spalte gar kein Höhenprofil gäbe.
  const fetched = await mapLimit(toFetch, FETCH_CONCURRENCY, async (i) => {
    const wp = waypoints[i];
    const [col, surface] = await Promise.all([
      fetchColumn(wp.lat, wp.lon, modelKey, horizon, fetchImpl),
      fetchSurface(wp.lat, wp.lon, modelKey, horizon, fetchImpl).catch(() => null),
    ]);
    return { i, wp, col, surface };
  });

  // Datenloch (Punkt innerhalb der Bbox, aber außerhalb des realen Modell-
  // gebiets, s. `NO_DATA_STOP_REASON`) beendet den Pfad an der ERSTEN solchen
  // Stelle -- die Reihenfolge entscheidet, deshalb erst hier nach dem
  // (reihenfolgetreuen) Parallelabruf ausgewertet.
  const waypointColumns = [];
  for (const { i, wp, col, surface } of fetched) {
    if (!col.time.length) {
      pathStop = { lat: wp.lat, lon: wp.lon, index: i, reason: NO_DATA_STOP_REASON };
      break;
    }
    waypointColumns.push({
      lat: wp.lat, lon: wp.lon, t: wp.t, pos: pos[i],
      elevation: col.elevation, model: modelKey, col, surface,
    });
  }

  if (waypointColumns.length < 2) {
    throw new Error(pathStop ? pathStop.reason : "Keine Wegpunkte im Modellgebiet");
  }

  const dense = opts.resampleIntervalSec ? resamplePath(waypointColumns, opts.resampleIntervalSec) : waypointColumns;
  const grid = gridFromWaypoints(dense);
  const view = deriveView(grid);

  const maxPos = grid.pos[grid.pos.length - 1];
  const trimmed = terrainPromise
    ? terrainPromise.then((t) => (t ? trimTerrainToChart(t, maxPos) : null))
    : null;

  // Aufgeschoben: Tafel jetzt, Gelände später (s. Doc-Kommentar oben). Der
  // Fehlerfall wird hier schon abgefangen -- ein fehlgeschlagenes Overlay darf
  // in der Host-App keine unbehandelte Promise-Ablehnung auslösen, das Wetter
  // steht ja bereits.
  if (opts.terrainDeferred) {
    return {
      grid, view, pathStop, terrain: null,
      terrainPromise: trimmed ? trimmed.catch(() => null) : Promise.resolve(null),
    };
  }
  return { grid, view, pathStop, terrain: trimmed ? await trimmed : null };
}

// Gelände jenseits des tatsächlich genutzten Wetter-Bereichs (Bbox-/No-Data-
// Stop, s. `pathStop` oben) hat im Chart keinen Platz mehr -- `x.right`
// endet dort (s. `render.js`), ein weiter reichendes Geländeprofil würde
// nirgends gezeichnet.
function trimTerrainToChart(terrain, maxPos) {
  let n = terrain.pos.length;
  while (n > 0 && terrain.pos[n - 1] > maxPos) n--;
  const gaps = terrain.gaps
    .filter((g) => g.fromPos <= maxPos)
    .map((g) => ({ fromPos: g.fromPos, toPos: Math.min(g.toPos, maxPos) }));
  return { pos: terrain.pos.subarray(0, n), elevation: terrain.elevation.subarray(0, n), gaps };
}
