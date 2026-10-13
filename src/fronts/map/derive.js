/**
 * Abgeleitete Felder für die Kartenanzeige (`meteokit/fronts/map`), ohne
 * DOM: Schattierungen und Isolinien rechnen sich hieraus, ebenso die
 * Knicklinien der Isobaren und Mittelwerte entlang einer Front.
 *
 * Alle Felder liegen auf dem Raster `G = { nx, ny, lat0, lon0, res }` des
 * Termins (row-major, j·nx+i). Einheiten wie in der Schattierungsauswahl:
 * °C, hPa, gpdm, cm/s, 10⁻⁹ s⁻² bzw. 10⁻⁵ s⁻¹.
 */

import { fieldAt } from "../field.js";
import { thetaFields } from "../thermo.js";
import { gaussianSmooth, gradient, sampleBilinear } from "../grid.js";
import { ridgeLines } from "../occlusion.js";
import { vorticityAdvection, vorticityTendency, geopotential500 } from "../cyclogenesis.js";

/** Raster eines Felds. */
export const gridOf = (F) => ({ nx: F.nx, ny: F.ny, lat0: F.lat0, lon0: F.lon0, res: F.res });

/**
 * Feld des Vortermins auf derselben Fläche, wenn der Fall 3-stündlich ist
 * (Drucktendenz, Vorticity-Änderung, `detectFronts({ prev })`), sonst undefined.
 */
export function prevField(fixture, n, pressure) {
  return n > 0 && fixture.stepH === 3 ? fieldAt(fixture, n - 1, pressure) : undefined;
}

/**
 * θe, θw, T (je mit σ geglättet, °C) und |∇θw| [K/100 km] der Analysefläche.
 * `TH` (thetaFields) lässt sich je Termin einmal rechnen und wiederverwenden.
 */
export function thermoDerived(F, sigmaKm, TH = thetaFields(F)) {
  const G = gridOf(F);
  const thE = gaussianSmooth(TH.thE, G, sigmaKm);
  const thW = gaussianSmooth(TH.thW, G, sigmaKm);
  const T = gaussianSmooth(F.T, G, sigmaKm);
  return {
    thE: thE.map((x) => x - 273.15), thW: thW.map((x) => x - 273.15), T: T.map((x) => x - 273.15),
    grad: gradient(thW, G).mag,
  };
}

const RD = 287.05, G0 = 9.80665;

/**
 * Geopotentielle Höhe [gpdm] der Analysefläche `F.pressure`, näherungsweise
 * hypsometrisch vom Boden aus: Z1000 aus Bodendruck und 2-m-Werten (wie
 * geopotential500), darüber mit der Mitteltemperatur zwischen 1000 hPa und
 * der Fläche. Der Server liefert keine Geopotentialfelder der Druckflächen.
 * Über Hochgebirge ungenau (Fläche bzw. 1000 hPa unter Grund).
 */
export function geopotentialLevel(F) {
  const msl = F.sfc?.pressure_msl, T2 = F.sfc?.temperature_2m, Td = F.sfc?.dew_point_2m;
  if (!msl) return null;
  const p = F.pressure;
  return Float32Array.from(msl, (pm, k) => {
    const T = (T2?.[k] ?? 10) + 273.15;
    const e = Td ? 6.112 * Math.exp((17.67 * Td[k]) / (Td[k] + 243.5)) : 10;
    const Tv0 = T * (1 + 0.378 * e / pm);
    const Tvp = F.T[k] * (1 + 0.61 * (F.q[k] || 0));
    const z1000 = ((RD * Tv0) / G0) * Math.log(pm / 1000);
    return (z1000 + ((RD * (Tv0 + Tvp) / 2) / G0) * Math.log(1000 / p)) / 10;
  });
}

/** Taupunktdifferenz [K] aus T [K], q [kg/kg] und p [hPa] (Magnus wie thermo.js). */
export function spread(T, q, p) {
  const r = q / (1 - q), e = (p * r) / (0.622 + r), l = Math.log(Math.max(e, 1e-4) / 6.112);
  return T - 273.15 - (243.5 * l) / (17.67 - l);
}

/**
 * Oberflächen-, 700-hPa- und Höhenfelder des Termins n: tend (3-h-Tendenz
 * rückwärts, wie in der Bodenkarte), precip, cloud, cloudLow, w700,
 * spread700, msl, thk, dazu die zyklogenetischen Hinweise z500, pva,
 * zeta500 (nur mit 500-hPa-Wind) und vortTend der Fläche `pressure`.
 * Fehlt ein Feld, ist es NaN.
 */
export function caseDerived(fixture, n, pressure) {
  const st = fixture.steps[n], prev = fixture.steps[n - 1];
  const cur = fieldAt(fixture, n, pressure);
  const nan = () => new Float32Array(cur.nx * cur.ny).fill(NaN);
  const msl = st.sfc.pressure_msl;
  const L7 = st.levels[700];
  const va = vorticityAdvection(cur);
  const pf = prevField(fixture, n, pressure);
  return {
    tend: msl && prev?.sfc.pressure_msl && fixture.stepH === 3 ? msl.map((x, k) => x - prev.sfc.pressure_msl[k]) : nan(),
    precip: st.sfc.precipitation || nan(),
    cloud: st.sfc.cloud_cover || nan(),
    cloudLow: st.sfc.cloud_cover_low || nan(),
    w700: L7?.w ? L7.w.map((x) => x * 100) : nan(),
    spread700: L7 ? L7.T.map((t, k) => spread(t, L7.q[k], 700)) : nan(),
    msl: msl || nan(),
    thk: st.thickness ? st.thickness.map((x) => x / 10) : nan(),
    z500: geopotential500(cur) || nan(),
    pva: va?.adv || nan(),
    zeta500: va?.zeta || nan(),
    vortTend: (pf && vorticityTendency(cur, pf)) || nan(),
  };
}

/**
 * Knicklinien der Isobaren: Achsen maximaler zyklonaler Krümmung
 * κ = ∇·(∇p/|∇p|) des Bodendrucks (40 km geglättet), s. KRITERIEN.md.
 * Liefert Linien als [lat, lon]-Listen.
 */
export function kinkLines(msl, G) {
  const p = gaussianSmooth(msl, G, 40), d = gradient(p, G);
  const ux = d.gx.map((x, k) => x / Math.max(d.mag[k], 0.3)), uy = d.gy.map((x, k) => x / Math.max(d.mag[k], 0.3));
  const dx = gradient(ux, G), dy = gradient(uy, G);
  return ridgeLines(ux.map((_, k) => dx.gx[k] + dy.gy[k]), G, { ridgeSmoothKm: 40, ridgeMinKm: 200 }, 0.05);
}

/** Mittelwert eines Felds entlang einer Linie ([lat, lon]-Punkte), null ohne Werte. */
export function meanAlong(fld, G, ll) {
  let s = 0, c = 0;
  for (const [la, lo] of ll) { const x = sampleBilinear(fld, G, la, lo); if (Number.isFinite(x)) { s += x; c++; } }
  return c ? s / c : null;
}
