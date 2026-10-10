/**
 * Fronten aus Niederschlagsachsen (`meteokit/fronts`) für Tiefs mit
 * schwachem Luftmassenkontrast, an denen die TFP-Analyse nichts findet
 * (Genuatief 09.10. 12 UTC: T850-Kontrast 1–3 K, Warmfront in 850 hPa im
 * Gelände, aber durchgehend Niederschlag genau auf den handanalysierten
 * Linien).
 *
 * Ablauf:
 *  1. Tiefs ohne TFP-Front (aktiv oder schwach) im Umkreis frontFreeKm.
 *  2. Rückenachsen des Niederschlags (Hesse-Matrix, wie die Schichtdicke)
 *     im Umkreis rangeKm um diese Tiefs, mit Mindestniederschlag und
 *     Mindestlänge, geglättet und an scharfen Ecken geteilt.
 *  3. Typ aus der Temperaturadvektion (850 hPa, im Gelände 700 hPa),
 *     gemittelt je Achsenstück: Kaltluftadvektion -> Kaltfront,
 *     Warmluftadvektion -> Warmfront.
 *
 * Die Stücke durchlaufen danach dieselbe Lücken-, Okklusions-, Glättungs-
 * und Anschlusslogik wie die TFP-Fronten. Kennzeichen: `method: "precip"`.
 */

import { gaussianSmooth, gradient, sampleBilinear, distKm, lineLengthKm, smoothAlong } from "./grid.js";
import { ridgeLines } from "./occlusion.js";
import { activityClass } from "./activity.js";

export const PRECIP_FRONT_DEFAULTS = {
  frontFreeKm: 500,     // Tief gilt als "ohne Front", wenn keine TFP-Front so nah am Kern liegt
  rangeKm: 1000,        // Achsen in diesem Umkreis um ein solches Tief
  rrSmoothKm: 60,       // Glättung des Niederschlags für die Achsen
  rrLambdaMin: 0.05,    // Mindestkrümmung der Achse
  rrMin: 0.3,           // mm/h: mittlerer Niederschlag entlang eines Stücks
  minKm: 250,           // Mindestlänge eines Stücks
  junctionKm: 60,       // Achsen an Gabelungen teilen (Ende einer anderen Achse so nah)
  tfpKm: 250,           // Stück entfällt, wenn ein Anteil tfpShare so nah an einer TFP-Front liegt
  tfpShare: 0.25,
  smoothKm: 150,        // Glättung der Achsen ("wie Segel")
  cornerDeg: 70,        // Teilung an Ecken wie bei TFP-Linien (45° machte das Band Tunesien–Neapel zur Okklusion)
  advSmoothKm: 150,     // Glättung von T und Wind für die Advektion
  advMin: 0.2,          // K/10 h: darunter kein eindeutiger Typ -> Stück entfällt
  activityRamp: [0.1, 0.6], // mm/h -> Aktivität (Klassen wie activity.js)
};

const DEG = Math.PI / 180;
const ramp = (x, [a, b]) => Math.min(1, Math.max(0, (x - a) / (b - a)));

/**
 * @param {object} field   fetchPlaneField-Ergebnis (mit sfc, levels[850], levels[700])
 * @param {object} g       Gitter
 * @param {object[]} lows  findLows-Ergebnis
 * @param {object[]} features bisherige Fronten (GeoJSON, [lon, lat])
 * @param {object} ctx     { split(line) -> lines } (Teilung an Ecken aus detect.js)
 * @returns {object[]} neue Front-Features
 */
export function precipFronts(field, g, lows, features, opts = {}, ctx = {}) {
  const o = { ...PRECIP_FRONT_DEFAULTS, ...opts };
  if (!field.sfc?.precipitation || !lows.length) return [];
  // `features` ist das fertige TFP-Ergebnis (nach der Okklusionsanalyse):
  // Zieltiefs sind Tiefs, an denen danach keine Front liegt.
  const lines = features
    .filter((f) => f.properties.activity_class !== "none")
    .map((f) => f.geometry.coordinates.map(([lo, la]) => [la, lo]));
  const near = (p, km) => lines.some((l) => l.some((q) => distKm(p, q) < km));
  const targets = lows.filter((l) => !near([l.lat, l.lon], o.frontFreeKm));
  if (!targets.length) return [];

  const rr = gaussianSmooth(Float32Array.from(field.sfc.precipitation, (x) => (x == null ? NaN : x)), g, 50);
  const adv = advectionFields(field, g, o.advSmoothKm);
  const axes = splitAtJunctions(ridgeLines(field.sfc.precipitation, g, { ridgeSmoothKm: o.rrSmoothKm, ridgeMinKm: 150 }, o.rrLambdaMin), o.junctionKm);

  const out = [];
  for (const axis of axes) {
    // Nur der Teil im Umkreis eines Zieltiefs, zusammenhängende Abschnitte.
    const inRange = axis.map((p) => targets.some((l) => distKm(p, [l.lat, l.lon]) <= o.rangeKm));
    const runs = [];
    let cur = [];
    axis.forEach((p, i) => { if (inRange[i]) cur.push(p); else { if (cur.length > 1) runs.push(cur); cur = []; } });
    if (cur.length > 1) runs.push(cur);
    for (const run of runs) {
      const sm = smoothAlong(run, o.smoothKm, 2);
      for (const piece of ctx.split ? ctx.split(sm) : [sm]) {
        if (lineLengthKm(piece) < o.minKm) continue;
        // Begleitband einer TFP-Front (Niederschlag vor der Warmfront, hinter
        // der Kaltfront) oder die Front selbst: gehört zum TFP-System.
        if (piece.filter((p) => near(p, o.tfpKm)).length > o.tfpShare * piece.length) continue;
        const rain = mean(piece.map((p) => sampleBilinear(rr, g, p[0], p[1])));
        if (!(rain >= o.rrMin)) continue;
        const a = mean(piece.map((p) => advAt(adv, g, p)));
        if (!(Math.abs(a) >= o.advMin)) continue;
        const type = a < 0 ? "cold" : "warm";
        const warm = warmSide(piece, adv, g);
        const activity = ramp(rain, o.activityRamp);
        out.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: piece.map(([la, lo]) => [+lo.toFixed(3), +la.toFixed(3)]) },
          properties: {
            front_type: type,
            method: "precip",
            level: "surface",
            analysis_level: "precip",
            valid_time: field.validTime,
            length_km: Math.round(lineLengthKm(piece)),
            activity: +activity.toFixed(2),
            activity_class: activityClass(activity),
            criteria: { precip: +rain.toFixed(2), advection_k10h: +a.toFixed(2) },
            warm_side: warm,
            motion_side: type === "cold" ? warm : warm === "left" ? "right" : "left",
          },
        });
      }
    }
  }
  return out;
}

const mean = (a) => { const f = a.filter(Number.isFinite); return f.length ? f.reduce((x, y) => x + y, 0) / f.length : NaN; };

// Temperatur und Advektion in 850 und 700 hPa; 850 hPa im Gelände maskiert.
function advectionFields(field, g, sm) {
  const res = {};
  for (const P of [850, 700]) {
    const L = field.levels?.[P];
    if (!L) continue;
    const m = (arr) => Float32Array.from(arr, (x, k) => (P === 850 && (field.below[k] || field.psfc[k] - 850 < 25)) || x == null ? NaN : x);
    const T = gaussianSmooth(m(L.T), g, sm), u = gaussianSmooth(m(L.u), g, sm), v = gaussianSmooth(m(L.v), g, sm);
    const gr = gradient(T, g);
    // gradient: K/100 km; (K/100 km)·(m/s)·36000 s/10 h / 1e5 m = 0.36 K/10 h
    res[P] = { T, gx: gr.gx, gy: gr.gy, adv: T.map((_, k) => -(u[k] * gr.gx[k] + v[k] * gr.gy[k]) * 0.36) };
  }
  return res;
}

function advAt(adv, g, p) {
  for (const P of [850, 700]) {
    const x = adv[P] && sampleBilinear(adv[P].adv, g, p[0], p[1]);
    if (Number.isFinite(x)) return x;
  }
  return NaN;
}

// Warme Seite der Linie (in Punktreihenfolge) aus dem T-Gradienten, je
// Punkt 850 hPa, im Gelände 700 hPa.
function warmSide(pts, adv, g) {
  let sum = 0;
  for (let m = 1; m < pts.length; m++) {
    const a = pts[m - 1], b = pts[m], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const tx = (b[1] - a[1]) * Math.cos(mid[0] * DEG), ty = b[0] - a[0];
    for (const P of [850, 700]) {
      if (!adv[P]) continue;
      const gx = sampleBilinear(adv[P].gx, g, mid[0], mid[1]), gy = sampleBilinear(adv[P].gy, g, mid[0], mid[1]);
      if (Number.isFinite(gx) && Number.isFinite(gy)) { sum += tx * gy - ty * gx; break; }
    }
  }
  return sum >= 0 ? "left" : "right";
}

// Achsen an Gabelungen teilen: liegt das Ende einer Achse nahe am Inneren
// einer anderen, wird diese dort geteilt. chainSegments läuft an einer
// Gabelung willkürlich in einen der Äste weiter (Genuatief: das Band
// Tunesien–Sizilien lief nach Osten weiter, der Ast nach Norden zur
// Kaltfront wurde abgeschnitten).
function splitAtJunctions(axes, km) {
  const ends = axes.flatMap((a, i) => [{ i, p: a[0] }, { i, p: a[a.length - 1] }]);
  return axes.flatMap((a, i) => {
    const cuts = new Set();
    for (const e of ends) {
      if (e.i === i) continue;
      let best = -1, bd = km;
      for (let q = 2; q < a.length - 2; q++) { const d = distKm(e.p, a[q]); if (d < bd) { bd = d; best = q; } }
      if (best > 0) cuts.add(best);
    }
    if (!cuts.size) return [a];
    const idx = [...cuts].sort((x, y) => x - y), parts = [];
    let start = 0;
    for (const c of idx) { parts.push(a.slice(start, c + 1)); start = c; }
    parts.push(a.slice(start));
    return parts.filter((p) => p.length >= 2);
  });
}
