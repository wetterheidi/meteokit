/**
 * Flächenfeld auf einer Druckfläche aus ICON-Modellleveln (`meteokit/fronts`).
 *
 * Der Modelllevel-Server liefert keine Druckflächen-Variablen
 * (`temperature_850hPa` u. ä. kommen als null, Stand 2026-10-08) -- deshalb
 * wird hier aus den Modellleveln selbst interpoliert (linear in ln p). Das
 * liefert gleich die Orographiemaske mit: wo der Druck am untersten Level
 * (~10 m AGL) kleiner als die Zielfläche ist, liegt diese unter Grund.
 *
 * Abruf als Mehrpunkt-POST in Blöcken; ein 0,5°-Raster über Europa sind
 * rund 11 000 Punkte und ~60 MB JSON (ca. 1 min). Für den Browser ist das zu
 * schwer -- gedacht für Vorberechnung (Node) bzw. Debug-Seiten mit Fixture.
 */

import { getModel } from "../config.js";
import { fetchJsonWithFallback, modelApiBases } from "../apifetch.js";

const KMH_TO_MS = 1 / 3.6;
const RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Levelbereich, der die Zielfläche abdecken muss. ICON-EU (Stichprobe
// 2026-10-09 00 UTC): 850 hPa liegt im Flachland bei Level 60–66, bei
// tiefem Kerndruck tiefer -- 55–70 deckt etwa 690–960 hPa ab. Das unterste
// Level (nLevels) kommt immer dazu: sein Druck ist der Bodendruck der Maske.
const DEFAULT_LEVELS = { icon_eu: [55, 70] };

/**
 * @param {object} opts
 * @param {string} [opts.model="icon_eu"]
 * @param {{latMin:number,latMax:number,lonMin:number,lonMax:number}} opts.bbox
 * @param {number} [opts.res=0.5]          Rasterweite in Grad.
 * @param {string} opts.time               Gültigkeitszeit "YYYY-MM-DDTHH:00" (UTC).
 * @param {number} [opts.pressure=850]     Zielfläche in hPa.
 * @param {[number,number]} [opts.levels]  Levelbereich [oben, unten] (API-Zählung).
 * @param {number} [opts.batchSize=600]    Punkte je Request.
 * @param {number} [opts.concurrency=3]
 * @param {Function} [opts.onProgress]     (fertig, gesamt) => void
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<object>} Feld mit row-major Arrays (j = Breite von Süd
 *   nach Nord, i = Länge von West nach Ost; Index j*nx+i): T [K], q [kg/kg],
 *   u, v [m/s], psfc [hPa], below (1 = Fläche unter Grund, dort NaN).
 */
export async function fetchPlaneField({
  model: modelKey = "icon_eu", bbox, res = 0.5, time, pressure = 850,
  levels, batchSize = 600, concurrency = 3, onProgress, fetchImpl,
} = {}) {
  const model = getModel(modelKey);
  const [lTop, lBot] = levels || DEFAULT_LEVELS[modelKey] || [1, model.nLevels];
  const levelList = [];
  for (let l = lTop; l <= lBot; l++) levelList.push(l);
  if (!levelList.includes(model.nLevels)) levelList.push(model.nLevels);

  const nx = Math.round((bbox.lonMax - bbox.lonMin) / res) + 1;
  const ny = Math.round((bbox.latMax - bbox.latMin) / res) + 1;
  const n = nx * ny;
  const lat = (j) => +(bbox.latMin + j * res).toFixed(4);
  const lon = (i) => +(bbox.lonMin + i * res).toFixed(4);

  const vars = [];
  for (const l of levelList) {
    vars.push(`temperature_level${l}`, `specific_humidity_level${l}`,
      `wind_u_component_level${l}`, `wind_v_component_level${l}`, `pressure_level${l}`);
  }

  const out = {
    model: modelKey, validTime: time, pressure, res,
    lat0: bbox.latMin, lon0: bbox.lonMin, nx, ny,
    T: new Float32Array(n).fill(NaN), q: new Float32Array(n).fill(NaN),
    u: new Float32Array(n).fill(NaN), v: new Float32Array(n).fill(NaN),
    psfc: new Float32Array(n).fill(NaN), below: new Uint8Array(n),
  };

  const batches = [];
  for (let k = 0; k < n; k += batchSize) batches.push([k, Math.min(n, k + batchSize)]);
  let done = 0;
  const queue = batches.slice();
  const worker = async () => {
    while (queue.length) {
      const [k0, k1] = queue.shift();
      const data = await fetchBatch(k0, k1);
      for (let k = k0; k < k1; k++) interpolatePoint(data[k - k0].hourly, k);
      done++;
      onProgress?.(done, batches.length);
    }
  };

  async function fetchBatch(k0, k1) {
    const lats = [], lons = [];
    for (let k = k0; k < k1; k++) { lats.push(lat(Math.floor(k / nx))); lons.push(lon(k % nx)); }
    const body = new URLSearchParams({
      latitude: lats.join(","), longitude: lons.join(","),
      hourly: vars.join(","), models: model.apiModel,
      start_hour: time, end_hour: time, cell_selection: "nearest",
    });
    let lastErr;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const data = await fetchJsonWithFallback(modelApiBases(model), "/v1/forecast", {
          fetchImpl, sourceKey: model.apiModel,
          init: { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
          validate: (d) => Array.isArray(d) ? d.length === k1 - k0 : k1 - k0 === 1,
        });
        return Array.isArray(data) ? data : [data];
      } catch (err) {
        lastErr = err;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  function interpolatePoint(H, k) {
    const at = (name) => H[name]?.[0];
    const pSfc = at(`pressure_level${model.nLevels}`);
    out.psfc[k] = pSfc ?? NaN;
    if (!Number.isFinite(pSfc) || pSfc < pressure) { out.below[k] = 1; return; }
    // Level von oben nach unten: Druck nimmt zu. Erstes Paar suchen, das die
    // Zielfläche einschließt.
    for (let m = 0; m < levelList.length - 1; m++) {
      const la = levelList[m], lb = levelList[m + 1];
      const pa = at(`pressure_level${la}`), pb = at(`pressure_level${lb}`);
      if (!(pa <= pressure && pressure <= pb)) continue;
      const f = Math.log(pressure / pa) / Math.log(pb / pa);
      const mix = (name, scale) => {
        const a = at(`${name}_level${la}`), b = at(`${name}_level${lb}`);
        return Number.isFinite(a) && Number.isFinite(b) ? (a + f * (b - a)) * scale : NaN;
      };
      out.T[k] = mix("temperature", 1) + 273.15;
      out.q[k] = mix("specific_humidity", 1e-3);
      out.u[k] = mix("wind_u_component", KMH_TO_MS);
      out.v[k] = mix("wind_v_component", KMH_TO_MS);
      return;
    }
    // Zielfläche außerhalb des abgerufenen Levelbereichs (sollte mit den
    // Defaults nicht vorkommen) -- bleibt NaN, ohne als "unter Grund" zu gelten.
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return out;
}
