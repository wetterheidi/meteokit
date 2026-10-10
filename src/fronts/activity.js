/**
 * Wetter- und Dynamikkriterium der Frontenanalyse (`meteokit/fronts`).
 *
 * Leitsatz: Eine Front ist eine Luftmassengrenze MIT Wetter. Ein
 * θw-Gradientband allein reicht nicht (Scheinfronten unter Absinkinversionen,
 * Feuchtegrenzen über Nordafrika, …). Die Kriterien folgen den
 * DWD-Kompendien, s. tools/fronts/KRITERIEN.md:
 *
 *   Kontrast   T850-Sprung über die Zone (≥ 4 K für eine Front)
 *   Rinne      zyklonale Krümmung des Bodendrucks quer zur Front
 *   Wind       Konvergenz und zyklonale Vorticity des ~10-m-Winds
 *   Tendenz    Sprung der 3-h-Drucktendenz (hinten höher als vorn)
 *   Wetter     Niederschlag, tiefe Bewölkung mit Hebung in 700 hPa
 *
 * Bodenposition: Die 850-hPa-Linie liegt bei Warmfronten 250–450 km vor,
 * bei Kaltfronten 50–250 km hinter der Bodenfront -- beides heißt, die
 * Bodenfront liegt auf der WARMEN Seite. Sie wird als Maximum der
 * Druckrinne in diesem Fenster gesucht; Wind und Tendenz werden dort
 * ausgewertet, das Wetter zwischen 850-hPa-Linie und Bodenfront.
 *
 * Bewertung je Stützpunkt, Rampen 0..1 (erste Kalibrierung am Fall
 * 2026-10-09 00/06 UTC gegen DWD/KNMI/GeoSphere -- an weiteren Fällen
 * prüfen):
 *   activity = Kontrast · (½ Wetter + ½ Dynamik)
 * Der Kontrast wirkt als Faktor: ohne Luftmassengegensatz keine Front, egal
 * wie viel Wetter.
 */

import { gaussianSmooth, gradient, sampleBilinear } from "./grid.js";
import { thetaFields } from "./thermo.js";

const DEG = Math.PI / 180;
const KM_PER_DEG = 111.2;

export const ACTIVITY_DEFAULTS = {
  contrastKm: 300,          // T850-Kontrast: Linie gegen Punkt so weit auf der kalten Seite
  contrastRamp: [2, 4],     // K
  contrastE: false,         // zusätzlich θe-Kontrast 850 hPa (Feuchtegrenzen, Genuatief), in Erprobung
  contrastRampE: [4, 8],    // K, Rampe für den θe-Kontrast; zählt der größere Faktor
  contrastMin: 3.5,         // K: an freien Linienenden endet die Front darunter, auch mit Wetter
  // Suchfenster der Bodenfront auf der warmen Seite der 850-hPa-Linie [km]
  sfcWindow: { warm: [0, 450], cold: [0, 250], stationary: [-100, 300] },
  curvStepKm: 150,          // Schrittweite der zweiten Ableitung des Bodendrucks
  curvRamp: [0.1, 0.5],     // hPa/(100 km)²
  convRamp: [0.3, 1.2],     // 10⁻⁵ s⁻¹
  vortRamp: [0.5, 1.5],     // 10⁻⁵ s⁻¹
  tendStepKm: 150,          // vor/hinter der Bodenfront
  tendRamp: [-0.2, 0.6],    // hPa/3 h, hinten minus vorn
  precipRamp: [0.05, 0.4],  // mm/h
  cloudLowRamp: [40, 80],   // %
  w700Ramp: [0.5, 2],       // cm/s
  // Klassen: ab `active` durchgezogen, ab `weak` gestrichelt, darunter keine Front
  active: 0.5,
  weak: 0.25,
};

const ramp = (x, [a, b]) => (Number.isFinite(x) ? Math.min(1, Math.max(0, (x - a) / (b - a))) : NaN);
const meanFinite = (a) => { const f = a.filter(Number.isFinite); return f.length ? f.reduce((x, y) => x + y, 0) / f.length : NaN; };

/**
 * Hilfsfelder für die Bewertung. `field` braucht `sfc`, `u10`/`v10` und
 * `levels[700]`; `prev` ist der Vortermin (3 h vorher) für die Tendenz und
 * darf fehlen. Ohne Oberflächenfelder (Fixture v1) -> null.
 */
export function activityFields(field, prev, g) {
  if (!field.sfc?.pressure_msl) return null;
  const S = (a, s) => gaussianSmooth(Float32Array.from(a, (x) => (x == null ? NaN : x)), g, s);
  const msl = S(field.sfc.pressure_msl, 100);
  const tend = prev?.sfc?.pressure_msl
    ? S(Float32Array.from(field.sfc.pressure_msl, (x, k) => x - prev.sfc.pressure_msl[k]), 100) : null;
  const u10 = S(field.u10, 100), v10 = S(field.v10, 100);
  // gradient() liefert pro 100 km; (m/s)/(100 km) = 1e-5 s⁻¹.
  const du = gradient(u10, g), dv = gradient(v10, g);
  const conv = du.gx.map((x, k) => -(x + dv.gy[k]));
  const vort = dv.gx.map((x, k) => x - du.gy[k]);
  const w700 = field.levels?.[700]?.w ? S(field.levels[700].w, 100).map((x) => x * 100) : null;
  return {
    msl, tend, conv, vort, w700,
    T850: S(field.levels?.[850]?.T ?? field.T, 120),
    thE850: field.levels?.[850] ? S(thetaFields({ nx: g.nx, ny: g.ny, ...field.levels[850], pressure: 850 }).thE, 120) : null,
    precip: field.sfc.precipitation ? S(field.sfc.precipitation, 50) : null,
    cloudLow: field.sfc.cloud_cover_low ? S(field.sfc.cloud_cover_low, 50) : null,
  };
}

/**
 * Bewertung je Stützpunkt einer Linie gleichen Typs.
 * @param {number[][]} pts   [lat, lon]
 * @param {string} type      cold | warm | stationary
 * @param {object} ff        frontFields (für n̂)
 * @param {object} af        activityFields
 * @returns {object[]} je Punkt { activity, contrast, trough, conv, vort, tendJump, precip, cloudLow, w700, sfcOffsetKm }
 */
export function assessPoints(pts, type, ff, af, opts = {}) {
  const o = { ...ACTIVITY_DEFAULTS, ...opts };
  const g = ff.g;
  const at = (f, p) => (f ? sampleBilinear(f, g, p[0], p[1]) : NaN);
  const off = (p, nx, ny, s) => [p[0] + (s * ny) / KM_PER_DEG, p[1] + (s * nx) / (KM_PER_DEG * Math.cos(p[0] * DEG))];
  // Zugrichtung relativ zu n̂ (zur warmen Luft): Kaltfront +1, Warmfront −1.
  const mdir = type === "cold" ? 1 : type === "warm" ? -1 : 0;
  const [w0, w1] = o.sfcWindow[type];
  const h = o.curvStepKm;

  return pts.map((p) => {
    let nx = at(ff.nx, p), ny = at(ff.ny, p);
    const len = Math.hypot(nx, ny);
    if (!(len > 0)) return { activity: NaN };
    nx /= len; ny /= len;
    const q = (s) => off(p, nx, ny, s);

    const contrast = at(af.T850, p) - at(af.T850, q(-o.contrastKm));
    const contrastE = o.contrastE && af.thE850 ? at(af.thE850, p) - at(af.thE850, q(-o.contrastKm)) : NaN;
    // Bodenfront = stärkste Rinne (zweite Ableitung des Bodendrucks quer zur Linie).
    let trough = -Infinity, sb = 0;
    for (let s = w0; s <= w1; s += 25) {
      const c = (at(af.msl, q(s + h)) - 2 * at(af.msl, q(s)) + at(af.msl, q(s - h))) / (h / 100) ** 2;
      if (c > trough) { trough = c; sb = s; }
    }
    let conv = -Infinity, vort = -Infinity;
    for (let s = sb - 100; s <= sb + 100; s += 25) {
      conv = Math.max(conv, at(af.conv, q(s)));
      vort = Math.max(vort, at(af.vort, q(s)));
    }
    const tendJump = mdir && af.tend ? at(af.tend, q(sb - mdir * o.tendStepKm)) - at(af.tend, q(sb + mdir * o.tendStepKm)) : NaN;
    // Wetter zwischen 850-hPa-Linie und Bodenfront, je 100 km Rand.
    let precip = 0, w700 = -Infinity; const cl = [];
    for (let s = Math.min(0, sb) - 100; s <= Math.max(0, sb) + 100; s += 25) {
      precip = Math.max(precip, at(af.precip, q(s)) || 0);
      w700 = Math.max(w700, at(af.w700, q(s)));
      cl.push(at(af.cloudLow, q(s)));
    }
    const cloudLow = meanFinite(cl);

    const weather = Math.max(ramp(precip, o.precipRamp) || 0,
      (ramp(cloudLow, o.cloudLowRamp) || 0) * (ramp(w700, o.w700Ramp) || 0));
    const dyn = meanFinite([ramp(trough, o.curvRamp), ramp(conv, o.convRamp), ramp(vort, o.vortRamp), ramp(tendJump, o.tendRamp)]);
    const cf = Math.max(ramp(contrast, o.contrastRamp) || 0, ramp(contrastE, o.contrastRampE) || 0);
    const activity = cf * (0.5 * weather + 0.5 * (dyn || 0));
    return { activity, contrast, contrastE, trough, conv, vort, tendJump, precip, cloudLow, w700, sfcOffsetKm: sb };
  });
}

/** Klasse eines Aktivitätswerts: "active" | "weak" | "none". */
export function activityClass(a, opts = {}) {
  const o = { ...ACTIVITY_DEFAULTS, ...opts };
  return a >= o.active ? "active" : a >= o.weak ? "weak" : "none";
}
