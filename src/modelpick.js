/**
 * Automatische Modellwahl für einen Punkt (`meteokit/modelpick`).
 *
 * Reihenfolge: feinstes Modell zuerst (nach `MODELS[].grid`), also ICON-D2 →
 * ICON-EU → ICON Global. Ein Modell kommt nur in Frage, wenn
 *  1. der Punkt mit `margin` Abstand innerhalb seiner `bbox` liegt -- die
 *     Bbox ist nur eine rechteckige Näherung (s. `gramet/path.js`), am Rand
 *     liefert z. B. ICON-D2 trotz "drin" keine Daten, und
 *  2. die tatsächlich geladene Säule Daten hat UND den verlangten Zeitraum
 *     (`coverFrom`..`coverUntil`) abdeckt. Liegt der Punkt außerhalb des
 *     echten Modellgebiets, kürzt `fetchColumn` die Zeitreihe auf Länge 0
 *     (real reproduziert: ICON-D2 bei 57,5 N / 3 W).
 * Scheitert ein Modell, wird das nächste probiert. Die geladene Säule wird
 * mit zurückgegeben -- kein zweiter Abruf in der Host-App.
 */

import { MODELS } from "./config.js";
import { fetchColumn } from "./column.js";

/** Modellschlüssel, deren Bbox den Punkt (mit Randabstand in Grad) enthält,
 *  feinstes Gitter zuerst. */
export function candidateModels(lat, lon, { margin = 0.3 } = {}) {
  return Object.keys(MODELS)
    .filter((key) => {
      const b = MODELS[key].bbox;
      if (!b) return false;
      const global = b.latMin <= -90 && b.latMax >= 90 && b.lonMin <= -180 && b.lonMax >= 180;
      if (global) return true;
      return lat >= b.latMin + margin && lat <= b.latMax - margin
        && lon >= b.lonMin + margin && lon <= b.lonMax - margin;
    })
    .sort((a, b) => MODELS[a].grid - MODELS[b].grid);
}

/**
 * Bestes verfügbares Modell am Punkt wählen und seine Säule laden.
 * @param {number} lat
 * @param {number} lon
 * @param {number|{startDate:string,endDate:string}} horizon  wie `fetchColumn`
 * @param {object} [opts]
 * @param {number} [opts.coverFrom]   Unixsekunden: Säule muss hier schon Daten haben
 * @param {number} [opts.coverUntil]  Unixsekunden: Säule muss bis hier reichen
 * @param {number} [opts.margin=0.3]  Randabstand zur Bbox in Grad
 * @param {string[]} [opts.only]      Kandidaten auf diese Schlüssel beschränken
 *                                    (z. B. manuelle Wahl in der Host-App)
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<{ model: string, col: object, tried: Array<{model:string, reason:string}> }>}
 */
export async function pickModel(lat, lon, horizon, { coverFrom, coverUntil, margin = 0.3, only, fetchImpl } = {}) {
  let keys = candidateModels(lat, lon, { margin });
  if (only) keys = keys.filter((k) => only.includes(k));
  const tried = [];
  for (const key of keys) {
    let col;
    try {
      col = await fetchColumn(lat, lon, key, horizon, fetchImpl);
    } catch (e) {
      tried.push({ model: key, reason: e.message || String(e) });
      continue;
    }
    const reason = coverageProblem(col, coverFrom, coverUntil);
    if (reason) { tried.push({ model: key, reason }); continue; }
    return { model: key, col, tried };
  }
  const detail = tried.map((t) => `${t.model}: ${t.reason}`).join("; ");
  throw new Error(`Kein Modell liefert Daten für ${lat.toFixed(2)}, ${lon.toFixed(2)}`
    + (detail ? ` (${detail})` : ""));
}

function coverageProblem(col, coverFrom, coverUntil) {
  const time = col.time;
  if (!time.length) return "keine Modelldaten an diesem Punkt";
  if (coverFrom != null && time[0] > coverFrom) return "Zeitraum beginnt zu spät";
  if (coverUntil != null && time[time.length - 1] < coverUntil) return "Vorhersagehorizont zu kurz";
  return null;
}
