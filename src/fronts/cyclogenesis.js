/**
 * Zyklogenetische Hinweise (Idee der Projektleitung 12.10.: an Wellen
 * prüfen, ob PVA vorherrscht oder andere zyklogenetische Signale erkennbar
 * sind). Bisher nur Anzeige auf der Debug-Seite, keine Regel.
 *
 * - `vorticityAdvection`: Advektion der absoluten Vorticity in 500 hPa mit
 *   dem echten Wind (keine geostrophische Näherung),
 *   A = −V·∇(ζ + f), in 10⁻⁹ s⁻². A > 0 (PVA) stützt nach der QG-Omega-
 *   Gleichung Hebung und Druckfall darunter. Ein erster Versuch aus einer
 *   genäherten Z500 (Bodendruck + Schichtdicke, geostrophisch) trennte die
 *   Wellen nicht -- die zweite Ableitung einer Näherung war zu grob.
 * - `vorticityTendency`: 3-h-Änderung der relativen Vorticity in der
 *   Analysefläche (850 hPa), in 10⁻⁵ s⁻¹ je 3 h -- direktes Maß dafür, ob
 *   sich eine Zirkulation aufbaut.
 * - `geopotential500`: Z500 = Z1000 + Schichtdicke 500/1000 in gpdm, Z1000
 *   hypsometrisch aus dem Bodendruck (virtuelle Temperatur aus 2 m), für
 *   Isohypsen in der Anzeige.
 *
 * Höhenwind: `field.levels[500]` (Fixture `<model>_upper_<Name>`,
 * `fetch-case.mjs --upper`).
 */

import { gaussianSmooth, gradient } from "./grid.js";

const DEG = Math.PI / 180;
const OMEGA = 7.292e-5;
const RD = 287.05, G0 = 9.80665;

const coriolis = (g, k) => 2 * OMEGA * Math.sin((g.lat0 + Math.floor(k / g.nx) * g.res) * DEG);
const fill = (a) => Float32Array.from(a, (x) => (x == null ? NaN : x));

/** Relative Vorticity [s⁻¹] aus u, v [m/s] (gradient liefert je 100 km). */
function vorticity(u, v, g) {
  const dv = gradient(v, g), du = gradient(u, g);
  return Float32Array.from(u, (_, k) => (dv.gx[k] - du.gy[k]) / 1e5);
}

/**
 * Vorticity-Advektion in einer Höhenfläche (Default 500 hPa).
 * @returns {{ adv: Float32Array, zeta: Float32Array } | null}
 *   adv in 10⁻⁹ s⁻², zeta (relativ) in 10⁻⁵ s⁻¹; null ohne Höhenwind.
 */
export function vorticityAdvection(field, { pressure = 500, smoothKm = 150 } = {}) {
  const L = field.levels?.[pressure];
  if (!L?.u || !L?.v) return null;
  const g = { nx: field.nx, ny: field.ny, lat0: field.lat0, lon0: field.lon0, res: field.res };
  const u = gaussianSmooth(fill(L.u), g, smoothKm), v = gaussianSmooth(fill(L.v), g, smoothKm);
  const zeta = vorticity(u, v, g);
  const eta = Float32Array.from(zeta, (z, k) => z + coriolis(g, k));
  const de = gradient(eta, g);
  const adv = Float32Array.from(u, (_, k) => (-(u[k] * de.gx[k] + v[k] * de.gy[k]) / 1e5) * 1e9);
  return { adv, zeta: zeta.map((z) => z * 1e5) };
}

/** 3-h-Änderung der relativen Vorticity der Analysefläche, 10⁻⁵ s⁻¹ je 3 h. */
export function vorticityTendency(field, prev, { smoothKm = 100 } = {}) {
  if (!prev?.u) return null;
  const g = { nx: field.nx, ny: field.ny, lat0: field.lat0, lon0: field.lon0, res: field.res };
  const z1 = vorticity(gaussianSmooth(fill(field.u), g, smoothKm), gaussianSmooth(fill(field.v), g, smoothKm), g);
  const z0 = vorticity(gaussianSmooth(fill(prev.u), g, smoothKm), gaussianSmooth(fill(prev.v), g, smoothKm), g);
  return Float32Array.from(z1, (z, k) => (z - z0[k]) * 1e5);
}

/** Z500 [gpdm] aus Bodendruck, 2-m-Temperatur/-Taupunkt und Schichtdicke. */
export function geopotential500(field) {
  const msl = field.sfc?.pressure_msl, thk = field.thickness;
  if (!msl || !thk) return null;
  const T2 = field.sfc.temperature_2m, Td = field.sfc.dew_point_2m;
  return Float32Array.from(msl, (p, k) => {
    const T = (T2?.[k] ?? 10) + 273.15;
    const e = Td ? 6.112 * Math.exp((17.67 * Td[k]) / (Td[k] + 243.5)) : 10;
    const Tv = T * (1 + 0.378 * e / p);
    // Mitteltemperatur der Schicht Meeresniveau–1000 hPa ≈ Bodenwert
    return (((RD * Tv) / G0) * Math.log(p / 1000) + thk[k]) / 10;
  });
}
