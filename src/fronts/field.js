/**
 * Flächenfelder auf Druckflächen aus ICON-Modellleveln (`meteokit/fronts`).
 *
 * Der Modelllevel-Server liefert keine Druckflächen-Variablen
 * (`temperature_850hPa` u. ä. kommen als null, Stand 2026-10-08) -- deshalb
 * wird hier aus den Modellleveln selbst interpoliert (linear in ln p). Das
 * liefert gleich die Orographiemaske mit: wo der Druck am untersten Level
 * (~10 m AGL) kleiner als die Zielfläche ist, liegt diese unter Grund.
 *
 * Zusätzlich Oberflächenfelder desselben Laufs (Bodendruck, Niederschlag,
 * Bewölkung, …) für das Wetter-/Dynamikkriterium und der Wind am untersten
 * Modelllevel (~10 m) für Konvergenz und Windsprung.
 *
 * Abruf als Mehrpunkt-POST in Blöcken; ein 0,5°-Raster über Europa sind
 * rund 11 000 Punkte. Für den Browser ist das zu schwer -- gedacht für
 * Vorberechnung (Node) bzw. Debug-Seiten mit Fixture.
 */

import { getModel } from "../config.js";
import { fetchJsonWithFallback, modelApiBases } from "../apifetch.js";

const KMH_TO_MS = 1 / 3.6;
const RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Levelbereich, der die Zielflächen abdecken muss. ICON-EU (Stichprobe
// 2026-10-09 00 UTC): 850 hPa liegt im Flachland bei Level 60–66, 700 hPa
// bei 55–57; bei tiefem Kerndruck rutscht beides nach oben. 50–70 deckt
// etwa 550–960 hPa ab. Das unterste Level (nLevels) kommt immer dazu: sein
// Druck ist der Bodendruck der Maske, sein Wind der "10-m-Wind".
const DEFAULT_LEVELS = { icon_eu: [50, 70] };

// Felder je Druckfläche: API-Name -> [Schlüssel, Faktor]. w kommt nativ in m/s.
const LEVEL_VARS = {
  temperature: ["T", 1],
  specific_humidity: ["q", 1e-3],
  wind_u_component: ["u", KMH_TO_MS],
  wind_v_component: ["v", KMH_TO_MS],
  wind_w: ["w", 1],
};

/** Oberflächenfelder, die ein Fall standardmäßig mitbringt. */
export const DEFAULT_SURFACE = [
  "pressure_msl", "precipitation", "rain", "showers",
  "cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high",
  "temperature_2m", "dew_point_2m", "cape",
];

/**
 * @param {object} opts
 * @param {string} [opts.model="icon_eu"]
 * @param {{latMin:number,latMax:number,lonMin:number,lonMax:number}} opts.bbox
 * @param {number} [opts.res=0.5]          Rasterweite in Grad.
 * @param {string} opts.time               Gültigkeitszeit "YYYY-MM-DDTHH:00" (UTC).
 * @param {number[]} [opts.pressures=[850]] Zielflächen in hPa.
 * @param {string[]} [opts.surface=[]]     Oberflächenvariablen (API-Namen).
 * @param {[number,number]} [opts.levels]  Levelbereich [oben, unten] (API-Zählung).
 * @param {number} [opts.batchSize=400]    Punkte je Request.
 * @param {number} [opts.concurrency=3]
 * @param {Function} [opts.onProgress]     (fertig, gesamt) => void
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<object>} Row-major Arrays (j = Breite von Süd nach Nord,
 *   i = Länge von West nach Ost; Index j*nx+i):
 *   - `levels[p]` = { T [K], q [kg/kg], u, v, w [m/s], below (1 = unter Grund) }
 *   - `psfc` [hPa], `u10`/`v10` [m/s] (unterstes Modelllevel)
 *   - `sfc[name]` in API-Einheiten (hPa, mm, %, °C, J/kg)
 *   - Für die erste Fläche zusätzlich `pressure`, `T`, `q`, `u`, `v`, `below`
 *     auf oberster Ebene (Form, die `detectFronts` erwartet).
 */
export async function fetchPlaneField({
  model: modelKey = "icon_eu", bbox, res = 0.5, time, pressures = [850], surface = [],
  levels, batchSize = 400, concurrency = 3, onProgress, fetchImpl,
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

  const vars = [...surface];
  for (const l of levelList) {
    vars.push(`pressure_level${l}`);
    for (const name of Object.keys(LEVEL_VARS)) vars.push(`${name}_level${l}`);
  }

  const nanArr = () => new Float32Array(n).fill(NaN);
  const out = {
    model: modelKey, validTime: time, pressures, res,
    lat0: bbox.latMin, lon0: bbox.lonMin, nx, ny,
    levels: {}, psfc: nanArr(), u10: nanArr(), v10: nanArr(), sfc: {},
  };
  for (const p of pressures) {
    out.levels[p] = { below: new Uint8Array(n) };
    for (const [key] of Object.values(LEVEL_VARS)) out.levels[p][key] = nanArr();
  }
  for (const name of surface) out.sfc[name] = nanArr();

  const batches = [];
  for (let k = 0; k < n; k += batchSize) batches.push([k, Math.min(n, k + batchSize)]);
  let done = 0;
  const queue = batches.slice();
  const worker = async () => {
    while (queue.length) {
      const [k0, k1] = queue.shift();
      const data = await fetchBatch(k0, k1);
      for (let k = k0; k < k1; k++) storePoint(data[k - k0].hourly, k);
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

  function storePoint(H, k) {
    const at = (name) => H[name]?.[0];
    for (const name of surface) out.sfc[name][k] = at(name) ?? NaN;
    const pSfc = at(`pressure_level${model.nLevels}`);
    out.psfc[k] = pSfc ?? NaN;
    out.u10[k] = (at(`wind_u_component_level${model.nLevels}`) ?? NaN) * KMH_TO_MS;
    out.v10[k] = (at(`wind_v_component_level${model.nLevels}`) ?? NaN) * KMH_TO_MS;
    for (const p of pressures) interpolate(at, k, p, pSfc);
  }

  function interpolate(at, k, pressure, pSfc) {
    const L = out.levels[pressure];
    if (!Number.isFinite(pSfc) || pSfc < pressure) { L.below[k] = 1; return; }
    // Level von oben nach unten: Druck nimmt zu. Erstes Paar suchen, das die
    // Zielfläche einschließt.
    for (let m = 0; m < levelList.length - 1; m++) {
      const la = levelList[m], lb = levelList[m + 1];
      const pa = at(`pressure_level${la}`), pb = at(`pressure_level${lb}`);
      if (!(pa <= pressure && pressure <= pb)) continue;
      const f = Math.log(pressure / pa) / Math.log(pb / pa);
      for (const [name, [key, scale]] of Object.entries(LEVEL_VARS)) {
        const a = at(`${name}_level${la}`), b = at(`${name}_level${lb}`);
        L[key][k] = Number.isFinite(a) && Number.isFinite(b) ? (a + f * (b - a)) * scale : NaN;
      }
      L.T[k] += 273.15;
      return;
    }
    // Zielfläche außerhalb des abgerufenen Levelbereichs (sollte mit den
    // Defaults nicht vorkommen) -- bleibt NaN, ohne als "unter Grund" zu gelten.
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  const first = out.levels[pressures[0]];
  Object.assign(out, { pressure: pressures[0], T: first.T, q: first.q, u: first.u, v: first.v, below: first.below });
  return out;
}

/**
 * Ein Termin eines Falls (Fixture v2, s. tools/fronts) in der Form, die
 * `detectFronts` erwartet: Felder der Fläche `pressure` auf oberster Ebene,
 * dazu `psfc`, `u10`, `v10`, `sfc` und die übrigen Flächen unter `levels`.
 */
export function fieldAt(fixture, stepIndex = 0, pressure = fixture.pressures[0]) {
  const s = fixture.steps[stepIndex];
  const L = s.levels[pressure];
  return {
    model: fixture.model, res: fixture.res, lat0: fixture.lat0, lon0: fixture.lon0,
    nx: fixture.nx, ny: fixture.ny, pressures: fixture.pressures,
    validTime: s.validTime, pressure, levels: s.levels,
    T: L.T, q: L.q, u: L.u, v: L.v, w: L.w, below: L.below,
    psfc: s.psfc, u10: s.u10, v10: s.v10, sfc: s.sfc,
  };
}
