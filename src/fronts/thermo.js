/**
 * Äquivalent- und Feuchtpotentielle Temperatur für die Frontenanalyse.
 *
 * θe nach Bolton (1980), Monthly Weather Review 108, 1046–1053:
 *   Gl. 10  e_s  = 6.112·exp(17.67·T_c / (T_c + 243.5))           [hPa]
 *   Gl. 22  T_L  = 2840 / (3.5·ln T − ln e − 4.805) + 55          [K]
 *   Gl. 43  θe   = T·(1000/p)^(0.2854·(1 − 0.28e-3·r))
 *                   · exp((3.376/T_L − 0.00254) · r·(1 + 0.81e-3·r))
 * mit r Mischungsverhältnis in g/kg. (Formeln aus der Standardliteratur
 * übernommen, nicht erneut gegen das Original geprüft.)
 *
 * θw wird NICHT über eine Näherungsformel bestimmt, sondern exakt im selben
 * Formelsystem: die Temperatur bei 1000 hPa, bei der gesättigte Luft dasselbe
 * θe hat (Bisektion, θe_sat ist streng monoton in T). Damit sind θe und θw
 * konsistent, ohne eine weitere, ungeprüfte Fit-Formel einzuführen.
 */

const KELVIN = 273.15;

/** Sättigungsdampfdruck über Wasser in hPa (Bolton Gl. 10), T in K. */
export function esHpa(tK) {
  const tc = tK - KELVIN;
  return 6.112 * Math.exp((17.67 * tc) / (tc + 243.5));
}

/**
 * θe in K. tK Temperatur [K], q spezifische Feuchte [kg/kg], pHpa Druck [hPa].
 */
export function thetaE(tK, q, pHpa) {
  const qq = Math.max(q, 1e-7);
  const r = (qq / (1 - qq)) * 1000; // g/kg
  const e = Math.max((pHpa * r) / (622 + r), 1e-4); // hPa
  const tL = 2840 / (3.5 * Math.log(tK) - Math.log(e) - 4.805) + 55;
  return tK * Math.pow(1000 / pHpa, 0.2854 * (1 - 0.28e-3 * r))
    * Math.exp((3.376 / tL - 0.00254) * r * (1 + 0.81e-3 * r));
}

/** θe gesättigter Luft bei 1000 hPa und Temperatur tK (T_L = T). */
function thetaESat1000(tK) {
  const es = esHpa(tK);
  const r = (622 * es) / (1000 - es);
  return tK * Math.exp((3.376 / tK - 0.00254) * r * (1 + 0.81e-3 * r));
}

/** θw in K aus θe in K (Umkehrung von θe_sat bei 1000 hPa). */
export function thetaWFromThetaE(thE) {
  if (!Number.isFinite(thE)) return NaN;
  let lo = 200, hi = 330; // θw-Bereich der Troposphäre mit Reserve
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (thetaESat1000(mid) < thE) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * θe und θw für ein ganzes Flächenfeld (`fetchPlaneField` bzw. Fixture).
 * Maskierte Punkte (T = NaN/null) bleiben NaN.
 */
export function thetaFields(field) {
  const n = field.nx * field.ny;
  const thE = new Float32Array(n), thW = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const t = field.T[k], q = field.q[k];
    if (t == null || q == null || !Number.isFinite(t) || !Number.isFinite(q)) { thE[k] = NaN; thW[k] = NaN; continue; }
    thE[k] = thetaE(t, q, field.pressure);
    thW[k] = thetaWFromThetaE(thE[k]);
  }
  return { thE, thW };
}
