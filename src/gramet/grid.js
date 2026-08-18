/**
 * Zeit-Höhen-Gitter für das GRAMET-Meteogramm — baut auf der bereits
 * bestehenden Säule (`column.js` `fetchColumn`) und den Oberflächenwerten
 * (`weather.js` `fetchSurface`) auf, statt eigene Requests zu stellen: beide
 * werden im Rest der App ohnehin schon geladen und in `state.data` gecacht.
 *
 * Abweichung vom ursprünglichen Plan: `pressure_level{l}` liefert Michaels
 * Server bereits direkt (siehe `column.js`), die hydrostatische Integration
 * aus `pressure_msl` ist damit unnötig — Levelddruck kommt 1:1 aus der Säule.
 * `pressure_msl` selbst wird trotzdem gebraucht (SLP-Zeile im Row-Stack) —
 * kommt ebenfalls direkt aus `column.js`, gleiche Instanz/Zeitreihe.
 *
 * Level-Ordnung: k=0 unterstes Level (~10 m AGL), aufsteigend — `column.js`
 * liefert die Level bereits in dieser Reihenfolge, keine Umkehr nötig.
 * Einheiten intern SI (K, m/s, kg/kg, m, Pa); °C/hPa nur an der Grenze zu
 * `clouds.js` (das RH-Kriterium arbeitet in °C/hPa), s. `cloudFracAt()`.
 */

import { cloudFraction } from "../clouds.js";
import { fetchColumn, sliceColumnAtTime, lerpAngle } from "../column.js";
import { nearestIndex } from "../weather.js";

const KELVIN = 273.15;
const P0_PA = 100000, KAPPA = 0.2857; // R_d/c_p
const G = 9.80665;

/** Säule + Oberflächenwerte laden und ins GRAMET-Gitter überführen. */
export async function fetchGrid(lat, lon, modelKey, forecastDays, surface, fetchImpl) {
  const col = await fetchColumn(lat, lon, modelKey, forecastDays, fetchImpl);
  const grid = gridFromColumn(col, surface, lat, lon);
  validate(grid);
  return grid;
}

/** Aus einer bereits geladenen Säule + Oberflächenwerten (kein Request). */
export function gridFromColumn(col, surface, lat, lon) {
  const nk = col.nLevels, times = col.time, nt = times.length;
  const z = new Float32Array(nt * nk), T = new Float32Array(nt * nk),
    u = new Float32Array(nt * nk), v = new Float32Array(nt * nk),
    w = new Float32Array(nt * nk), qv = new Float32Array(nt * nk),
    qw = new Float32Array(nt * nk), qi = new Float32Array(nt * nk),
    clc = new Float32Array(nt * nk), rh = new Float32Array(nt * nk),
    p = new Float32Array(nt * nk);

  for (let i = 0; i < nt; i++) {
    for (let k = 0; k < nk; k++) {
      const ix = i * nk + k;
      z[ix] = col.h[k][i];
      T[ix] = col.t[k][i] + KELVIN;
      u[ix] = col.u[k][i];
      v[ix] = col.v[k][i];
      w[ix] = col.w ? col.w[k][i] : NaN;
      qv[ix] = col.q ? col.q[k][i] : NaN;
      qw[ix] = col.qw ? col.qw[k][i] : NaN;
      qi[ix] = col.qi ? col.qi[k][i] : NaN;
      clc[ix] = col.clc ? col.clc[k][i] : NaN;
      rh[ix] = col.rh ? col.rh[k][i] : NaN;
      p[ix] = col.p ? col.p[k][i] * 100 : NaN; // hPa -> Pa
    }
  }

  return {
    meta: { lat, lon, elevation: col.elevation, model: col.model, dt: nt > 1 ? times[1] - times[0] : 3600, mode: "point" },
    times, nk,
    // X-Achsen-Positionswert getrennt von `times` (Kalenderzeit) gehalten:
    // im Point-Modus identisch zu `times`, im Path-Modus (s. `gridFromWaypoints`)
    // verstrichene Sekunden seit Pfadbeginn -- nur der Renderer liest `pos` für
    // die X-Position, alles Kalenderbezogene (Tageslicht, Achsenbeschriftung,
    // Tooltips) bleibt auf `times`.
    pos: Float64Array.from(times),
    lat: new Float64Array(nt).fill(lat),
    lon: new Float64Array(nt).fill(lon),
    elevation: new Float32Array(nt).fill(col.elevation),
    z, T, u, v, w, qv, qw, qi, clc, rh, p,
    surface: buildSurface(surface, times, col),
    derived: null,
  };
}

function buildSurface(surface, times, col) {
  const nt = times.length;
  const t2m = new Float32Array(nt).fill(NaN), td2m = new Float32Array(nt).fill(NaN),
    ws10 = new Float32Array(nt).fill(NaN), wd10 = new Float32Array(nt).fill(NaN),
    gust = new Float32Array(nt).fill(NaN), precip = new Float32Array(nt).fill(NaN),
    snow = new Float32Array(nt).fill(NaN), cape = new Float32Array(nt).fill(NaN),
    wcode = new Float32Array(nt).fill(NaN), visibility = new Float32Array(nt).fill(NaN);
  // pressure_msl kommt direkt aus der Säule (dieselbe Instanz/Zeitreihe wie die
  // Level-Daten, s. column.js) -- 1:1 indexiert, kein nearestIndex-Abgleich nötig.
  const pmsl = col?.pmsl ? Float32Array.from(col.pmsl) : new Float32Array(nt).fill(NaN);
  if (!surface?.time?.length) {
    return { t2m, td2m, ws10, wd10, gust, precip, snow, cape, wcode, visibility, pmsl };
  }

  const V = surface.vars || {};
  const pick = (name, out, factor = 1) => {
    const src = V[name];
    if (!src) return;
    for (let i = 0; i < nt; i++) {
      // Fehlende Stunden am Horizontende (kürzere Oberflächenreihe) bleiben NaN.
      const j = nearestIndex(surface.time, times[i] * 1000);
      const val = j >= 0 && Math.abs(surface.time[j] - times[i]) <= 1800 ? src[j] : null;
      out[i] = val == null ? NaN : val * factor;
    }
  };
  pick("temperature_2m", t2m);
  pick("dew_point_2m", td2m);
  pick("wind_speed_10m", ws10, 1 / 3.6); // km/h -> m/s
  pick("wind_direction_10m", wd10);
  pick("wind_gusts_10m", gust, 1 / 3.6);
  pick("precipitation", precip);
  pick("snowfall", snow);
  pick("cape", cape);
  pick("weather_code", wcode);
  pick("visibility", visibility);
  return { t2m, td2m, ws10, wd10, gust, precip, snow, cape, wcode, visibility, pmsl };
}

/**
 * Gitter aus einer Liste bereits geladener Wegpunkt-Säulen (Path-Modus) --
 * jede Spalte hat ihren eigenen Ort UND Zeitpunkt, statt (wie `gridFromColumn`)
 * einen festen Ort über eine gemeinsame Zeitreihe zu teilen. Nimmt EIN Modell
 * für den gesamten Pfad an (`nk` konstant über alle Wegpunkte) -- das
 * Verlassen der Modell-Bbox wird schon vor dem Fetch abgefangen (s. `path.js`),
 * hier wird nur noch zusammengesetzt.
 * @param waypointColumns Array<{ lat, lon, t (Unixsekunden, Zielzeitpunkt),
 *   pos (X-Achsen-Positionswert), elevation, model, surface (optional, wie
 *   `fetchSurface()`), col (vollständiges `fetchColumn()`-Ergebnis, wird bei
 *   Bedarf per `sliceColumnAtTime()` auf `t` reduziert), levelSlice (optional
 *   -- bereits fertiger Levelquerschnitt, z. B. aus `resample.js`
 *   `resamplePath()`; wenn gesetzt, wird `col` NICHT mehr gesliced, nur noch
 *   für `pmsl` in `buildSurfaceFromWaypoints` gebraucht) }>
 */
export function gridFromWaypoints(waypointColumns) {
  const nt = waypointColumns.length;
  const nk = waypointColumns[0].levelSlice?.h.length ?? waypointColumns[0].col.nLevels;
  const z = new Float32Array(nt * nk), T = new Float32Array(nt * nk),
    u = new Float32Array(nt * nk), v = new Float32Array(nt * nk),
    w = new Float32Array(nt * nk), qv = new Float32Array(nt * nk),
    qw = new Float32Array(nt * nk), qi = new Float32Array(nt * nk),
    clc = new Float32Array(nt * nk), rh = new Float32Array(nt * nk),
    p = new Float32Array(nt * nk);

  const times = new Float64Array(nt), pos = new Float64Array(nt),
    lat = new Float64Array(nt), lon = new Float64Array(nt), elevation = new Float32Array(nt);

  for (let i = 0; i < nt; i++) {
    const wp = waypointColumns[i];
    const slice = wp.levelSlice ?? sliceColumnAtTime(wp.col, wp.t);
    times[i] = wp.t; pos[i] = wp.pos; lat[i] = wp.lat; lon[i] = wp.lon;
    elevation[i] = wp.elevation;
    for (let k = 0; k < nk; k++) {
      const ix = i * nk + k;
      z[ix] = slice.h[k];
      T[ix] = slice.t[k] + KELVIN;
      u[ix] = slice.u[k];
      v[ix] = slice.v[k];
      w[ix] = slice.w ? slice.w[k] : NaN;
      qv[ix] = slice.q ? slice.q[k] : NaN;
      qw[ix] = slice.qw ? slice.qw[k] : NaN;
      qi[ix] = slice.qi ? slice.qi[k] : NaN;
      clc[ix] = slice.clc ? slice.clc[k] : NaN;
      rh[ix] = slice.rh ? slice.rh[k] : NaN;
      p[ix] = slice.p ? slice.p[k] * 100 : NaN; // hPa -> Pa
    }
  }

  return {
    meta: {
      lat: lat[0], lon: lon[0], elevation: elevation[0], model: waypointColumns[0].model,
      dt: nt > 1 ? pos[1] - pos[0] : 3600, mode: "path",
    },
    times, nk, pos, lat, lon, elevation,
    z, T, u, v, w, qv, qw, qi, clc, rh, p,
    surface: buildSurfaceFromWaypoints(waypointColumns, times),
    derived: null,
  };
}

// Wie `buildSurface`, aber pro Wegpunkt aus dessen EIGENER (optionaler)
// Oberflächen-Serie und der eigenen Säule (für `pmsl`) -- nicht aus einer
// gemeinsamen Zeitreihe an einem festen Ort.
function buildSurfaceFromWaypoints(waypointColumns, times) {
  const nt = times.length;
  const t2m = new Float32Array(nt).fill(NaN), td2m = new Float32Array(nt).fill(NaN),
    ws10 = new Float32Array(nt).fill(NaN), wd10 = new Float32Array(nt).fill(NaN),
    gust = new Float32Array(nt).fill(NaN), precip = new Float32Array(nt).fill(NaN),
    snow = new Float32Array(nt).fill(NaN), cape = new Float32Array(nt).fill(NaN),
    wcode = new Float32Array(nt).fill(NaN), visibility = new Float32Array(nt).fill(NaN),
    pmsl = new Float32Array(nt).fill(NaN);

  const FIELDS = [
    ["temperature_2m", t2m, 1], ["dew_point_2m", td2m, 1],
    ["wind_speed_10m", ws10, 1 / 3.6], ["wind_direction_10m", wd10, 1], // km/h -> m/s
    ["wind_gusts_10m", gust, 1 / 3.6], ["precipitation", precip, 1],
    ["snowfall", snow, 1], ["cape", cape, 1],
    ["weather_code", wcode, 1], ["visibility", visibility, 1],
  ];

  for (let i = 0; i < nt; i++) {
    const wp = waypointColumns[i];
    const tMs = wp.t * 1000;
    const pIdx = wp.col ? nearestIndex(wp.col.time, tMs) : -1;
    if (pIdx >= 0 && wp.col.pmsl) pmsl[i] = wp.col.pmsl[pIdx];

    if (!wp.surface?.time?.length) continue;
    const V = wp.surface.vars || {};
    const j = nearestIndex(wp.surface.time, tMs);
    if (j < 0 || Math.abs(wp.surface.time[j] - wp.t) > 1800) continue;
    for (const [name, out, factor] of FIELDS) {
      const src = V[name];
      if (src?.[j] != null) out[i] = src[j] * factor;
    }
  }
  return { t2m, td2m, ws10, wd10, gust, precip, snow, cape, wcode, visibility, pmsl };
}

export function idx(grid, t, k) { return t * grid.nk + k; }

/** Punkt (Zeitindex i, Höhe m AGL) linear zwischen Levels interpoliert. */
export function sampleAt(grid, i, hAgl) {
  const { nk } = grid;
  const base = i * nk;
  let k = 1;
  while (k < nk && grid.z[base + k] < hAgl) k++;
  if (k >= nk) k = nk - 1;
  const k0 = base + k - 1, k1 = base + k;
  const z0 = grid.z[k0], z1 = grid.z[k1];
  const f = z1 > z0 ? clamp01((hAgl - z0) / (z1 - z0)) : 0;
  const lerp = (a) => a[k0] + f * (a[k1] - a[k0]);
  // Richtung über den kürzeren Bogen, Betrag linear -- NICHT rohe u/v-
  // Interpolation mit anschließender atan2/hypot-Ableitung (frühere Version,
  // s. dieselbe Korrektur + Begründung in column.js `buildField()`). Betraf
  // hier den GRAMET-Hover-Tooltip und die Windfiedern-Overlay
  // (`rows/wind.js` `drawWindBarbOverlay`) -- beide riefen bislang
  // `Math.atan2`/`Math.hypot` auf dem u/v-Ergebnis dieser Funktion auf.
  const dir0 = (Math.atan2(-grid.u[k0], -grid.v[k0]) * 180 / Math.PI + 360) % 360;
  const dir1 = (Math.atan2(-grid.u[k1], -grid.v[k1]) * 180 / Math.PI + 360) % 360;
  const spd0 = Math.hypot(grid.u[k0], grid.v[k0]), spd1 = Math.hypot(grid.u[k1], grid.v[k1]);
  return {
    z: hAgl, T: lerp(grid.T), dir: lerpAngle(dir0, dir1, f), spd: spd0 + f * (spd1 - spd0), w: lerp(grid.w),
    rh: lerp(grid.rh), p: lerp(grid.p), cloudFrac: lerp(derive(grid).cloudFrac),
  };
}

/** Wolkenfraktion für eine Gitterzelle über die bestehende `clouds.js`-Heuristik
 *  (Stufe 1/2/3-Fallback, s. dort) — Umrechnung K->°C/Pa->hPa nur hier am Rand. */
function cloudFracAt(grid, ix) {
  return cloudFraction({
    q: grid.qv[ix], p: grid.p[ix] / 100, t: grid.T[ix] - KELVIN,
    rh: grid.rh[ix], qw: grid.qw[ix], qi: grid.qi[ix], clc: grid.clc[ix], model: grid.meta.model,
  }, grid.z[ix], grid.w[ix]);
}

/** Abgeleitete Felder, lazy + idempotent (einmal berechnet, am Gitter gecacht). */
export function derive(grid) {
  if (grid.derived) return grid.derived;
  const { nk, times } = grid, nt = times.length, n = nt * nk;
  const theta = new Float32Array(n), wspd = new Float32Array(n), cloudFrac = new Float32Array(n);
  for (let ix = 0; ix < n; ix++) {
    theta[ix] = grid.T[ix] * Math.pow(P0_PA / grid.p[ix], KAPPA);
    wspd[ix] = Math.hypot(grid.u[ix], grid.v[ix]);
    cloudFrac[ix] = cloudFracAt(grid, ix);
  }

  // Staggered Zwischenniveaus (nt x (nk-1)) für Scherung/Stabilität — Grundlage
  // des späteren Turbulenz-Moduls (hazards/turbulence.js).
  const nm = Math.max(0, nk - 1);
  const shear2 = new Float32Array(nt * nm), n2 = new Float32Array(nt * nm), ri = new Float32Array(nt * nm);
  for (let i = 0; i < nt; i++) {
    for (let k = 0; k < nm; k++) {
      const ix0 = i * nk + k, ix1 = i * nk + k + 1, im = i * nm + k;
      const dz = grid.z[ix1] - grid.z[ix0];
      if (!(dz > 0)) { shear2[im] = NaN; n2[im] = NaN; ri[im] = NaN; continue; }
      const du = grid.u[ix1] - grid.u[ix0], dv = grid.v[ix1] - grid.v[ix0];
      const s2 = (du / dz) ** 2 + (dv / dz) ** 2;
      const thetaAvg = (theta[ix0] + theta[ix1]) / 2;
      const dTheta = theta[ix1] - theta[ix0];
      const nn2 = (G / thetaAvg) * (dTheta / dz);
      shear2[im] = s2;
      n2[im] = nn2;
      ri[im] = s2 > 1e-8 ? nn2 / s2 : NaN; // Schutz bei ~Nullscherung
    }
  }

  grid.derived = { theta, wspd, cloudFrac, shear2, n2, ri, nm };
  return grid.derived;
}

// --- Validierung -------------------------------------------------------------

function validate(grid) {
  const { nk, times } = grid, nt = times.length;
  for (let i = 0; i < nt; i++) {
    let prevZ = -Infinity;
    for (let k = 0; k < nk; k++) {
      const ix = i * nk + k;
      const z = grid.z[ix], T = grid.T[ix], q = grid.qv[ix];
      if (Number.isFinite(z) && z <= prevZ) {
        console.warn(`gramet/grid: z nicht streng monoton (t=${i}, k=${k})`);
      }
      if (Number.isFinite(z)) prevZ = z;
      if (Number.isFinite(T) && (T < 150 || T > 350)) {
        console.warn(`gramet/grid: T außerhalb [150,350] K (t=${i}, k=${k}): ${T}`);
      }
      if (Number.isFinite(q) && q < 0) {
        console.warn(`gramet/grid: q_v < 0 (t=${i}, k=${k}): ${q}`);
      }
    }
  }
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
