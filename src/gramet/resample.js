/**
 * Resampling der (sparsam gefetchten) Path-Modus-Spalten auf eine feste
 * Kadenz -- entkoppelt die Fetch-Dichte (`path.js` `selectWaypointsToFetch`,
 * an der Modellauflösung ausgerichtet) von der Anzeige-Dichte (frei wählbar,
 * z. B. alle 10 Minuten). Reine Berechnung auf bereits geladenen Daten, kein
 * eigener Netzwerkzugriff -- deshalb getrennt von `path.js`.
 *
 * Zweistufige Interpolation je Ausgabespalte zwischen den beiden
 * umgebenden echten Wegpunkten A/B:
 *   1. zeitlich, INNERHALB jeder Säule (`column.js` `sliceColumnAtTime`,
 *      beide Säulen decken mehrere Tage ab, die Zielzeit liegt also in
 *      beiden),
 *   2. räumlich, ZWISCHEN den beiden so zeit-korrigierten Querschnitten,
 *      linear nach Streckenanteil gewichtet.
 * Oberflächenwerte (Böen/Sicht/SLP/Wettercode) werden bewusst NICHT
 * interpoliert, sondern vom jeweils näheren der beiden Wegpunkte übernommen
 * -- eine kategoriale Größe wie der Wettercode lässt sich ohnehin nicht
 * sinnvoll linear interpolieren, und für die übrigen wäre der Zusatzaufwand
 * gegenüber dem Vertikalprofil (Haupttafel: Isothermen/Wolken/Hazards) nicht
 * gerechtfertigt (Entscheidung, s. Plan).
 */

import { sliceColumnAtTime } from "../column.js";

function blendArr(a, b, f) {
  if (!a || !b) return null;
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + f * (b[i] - a[i]);
  return out;
}

function blendSlices(a, b, f) {
  return {
    h: blendArr(a.h, b.h, f), u: blendArr(a.u, b.u, f), v: blendArr(a.v, b.v, f), t: blendArr(a.t, b.t, f),
    rh: blendArr(a.rh, b.rh, f), p: blendArr(a.p, b.p, f), w: blendArr(a.w, b.w, f), q: blendArr(a.q, b.q, f),
    qw: blendArr(a.qw, b.qw, f), qi: blendArr(a.qi, b.qi, f), clc: blendArr(a.clc, b.clc, f),
  };
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// `A === B` an den Rändern (erster/letzter Ausgabepunkt) -- die Blendung
// vereinfacht sich dann von selbst auf `f = 0` (`blendSlices(a, a, f) === a`
// unabhängig von `f`), kein Sonderfall im Code nötig. `sliceB` wird trotzdem
// nur einmal berechnet, um die doppelte Arbeit zu sparen.
function blendAnchors(A, B, f, pos, t) {
  const sliceA = sliceColumnAtTime(A.col, t);
  const sliceB = A === B ? sliceA : sliceColumnAtTime(B.col, t);
  const nearest = f < 0.5 ? A : B;
  return {
    lat: A.lat + f * (B.lat - A.lat),
    lon: A.lon + f * (B.lon - A.lon),
    t, pos,
    elevation: A.elevation + f * (B.elevation - A.elevation),
    model: A.model,
    surface: nearest.surface,
    col: nearest.col, // Fallback für pmsl, s. grid.js `buildSurfaceFromWaypoints`
    levelSlice: blendSlices(sliceA, sliceB, f),
  };
}

/**
 * @param waypointColumns Array<{ lat, lon, t, pos, elevation, model, surface,
 *   col }> -- sparsam gefetchte Spalten (`path.js`), aufsteigend nach `pos`.
 * @param intervalSec Ausgabe-Kadenz in Sekunden (z. B. 600 für alle 10 min).
 * @returns Liste in derselben Form wie `waypointColumns`, jetzt mit
 *   `levelSlice` statt `col` als Quelle des Levelquerschnitts für die
 *   interpolierten Zwischenpunkte -- direkt an `grid.js` `gridFromWaypoints`
 *   übergebbar.
 */
export function resamplePath(waypointColumns, intervalSec) {
  if (waypointColumns.length < 2 || !(intervalSec > 0)) return waypointColumns;

  const t0 = waypointColumns[0].t;
  const lastPos = waypointColumns[waypointColumns.length - 1].pos;

  const outPositions = [];
  for (let p = 0; p < lastPos; p += intervalSec) outPositions.push(p);
  outPositions.push(lastPos); // exakter Endpunkt immer dabei, auch ohne Vielfaches von intervalSec

  const dense = [];
  let ai = 0;
  for (const p of outPositions) {
    while (ai < waypointColumns.length - 2 && waypointColumns[ai + 1].pos <= p) ai++;
    const A = waypointColumns[ai], B = waypointColumns[Math.min(ai + 1, waypointColumns.length - 1)];
    const f = B.pos > A.pos ? clamp01((p - A.pos) / (B.pos - A.pos)) : 0;
    dense.push(blendAnchors(A, B, f, p, t0 + p));
  }
  return dense;
}
