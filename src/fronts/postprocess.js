/**
 * Nachbearbeitung der Frontlinien (`meteokit/fronts`): Lücken schließen und
 * glätten. Leitbild aus der Referenzanalyse: „Fronten spannen sich wie Segel
 * im Wind auf“ -- durchgehend, ohne Knicke und Zacken.
 */

import { sampleBilinear, distKm, lineLengthKm, smoothAlong } from "./grid.js";

const DEG = Math.PI / 180;
const KM_PER_DEG = 111.2;
const vecKm = (a, b) => [(b[1] - a[1]) * KM_PER_DEG * Math.cos(((a[0] + b[0]) / 2) * DEG), (b[0] - a[0]) * KM_PER_DEG];
const unitV = (v) => { const L = Math.hypot(v[0], v[1]); return L > 0 ? [v[0] / L, v[1] / L] : [0, 0]; };
const dotV = (u, v) => u[0] * v[0] + u[1] * v[1];

export const POSTPROCESS_DEFAULTS = {
  gapKm: 600,           // Lücken bis zu dieser Länge schließen
  gapAlignMin: 0.6,     // cos: Linienenden müssen aufeinander zu zeigen
  gapPrecipMin: 0.1,    // mm/h: so viel Niederschlag muss entlang der Lücke fallen
  smoothKm: 150,        // abschließende Glättung aller Fronten
  smoothPasses: 2,
};

// Richtung, in die eine Linie an ihrem Ende hinausläuft (über ~100 km).
function outward(pts, atEnd) {
  const n = pts.length;
  let q = atEnd ? n - 1 : 0, s = 0;
  const st = atEnd ? -1 : 1;
  while (q + st >= 0 && q + st < n && s < 100) { s += distKm(pts[q], pts[q + st]); q += st; }
  return unitV(vecKm(pts[q], pts[atEnd ? n - 1 : 0]));
}

// Kubischer Bogen von A nach B, der A in Richtung tA verlässt und B aus
// Richtung −tB erreicht (tA, tB = auswärts gerichtete Endtangenten).
function bridge(A, tA, B, tB, stepKm = 40) {
  const L = distKm(A, B), k = L / 3;
  const off = (p, t, s) => [p[0] + (s * t[1]) / KM_PER_DEG, p[1] + (s * t[0]) / (KM_PER_DEG * Math.cos(p[0] * DEG))];
  const c1 = off(A, tA, k), c2 = off(B, tB, k);
  const n = Math.max(2, Math.ceil(L / stepKm));
  const out = [];
  for (let i = 1; i < n; i++) {
    const t = i / n, u = 1 - t;
    out.push([0, 1].map((d) => u * u * u * A[d] + 3 * u * u * t * c1[d] + 3 * u * t * t * c2[d] + t * t * t * B[d]));
  }
  return out;
}

/**
 * Lücken zwischen Fronten gleichen Typs schließen. Voraussetzung: beide
 * Stücke sind aktiv oder schwach, ihre Enden liegen höchstens gapKm
 * auseinander und zeigen aufeinander zu, und entlang der Lücke fällt
 * Niederschlag (sonst ist es keine Front, s. Leitsatz). Die verbundenen
 * Stücke werden zu einem Feature; `gap_closed_km` nennt die Lückenlänge.
 * @param {object[]} features  GeoJSON-Features ([lon, lat])
 * @param {object} af          activityFields (für den Niederschlag) oder null
 */
export function closeGaps(features, af, g, opts = {}) {
  const o = { ...POSTPROCESS_DEFAULTS, ...opts };
  if (!af?.precip) return features;
  const items = features.map((f) => ({ f, pts: f.geometry.coordinates.map(([lo, la]) => [la, lo]), gaps: [] }));
  const ok = (it) => it.f.properties.activity_class !== "none" && ["cold", "warm", "stationary"].includes(it.f.properties.front_type);

  for (let merged = true; merged;) {
    merged = false;
    let best = null;
    for (let a = 0; a < items.length; a++) {
      for (let b = a + 1; b < items.length; b++) {
        const A = items[a], B = items[b];
        if (!ok(A) || !ok(B) || A.f.properties.front_type !== B.f.properties.front_type) continue;
        for (const ea of [true, false]) {
          for (const eb of [true, false]) {
            const pa = ea ? A.pts[A.pts.length - 1] : A.pts[0], pb = eb ? B.pts[B.pts.length - 1] : B.pts[0];
            const d = distKm(pa, pb);
            if (d < 1 || d > o.gapKm || (best && d >= best.d)) continue;
            const tA = outward(A.pts, ea), tB = outward(B.pts, eb), ab = unitV(vecKm(pa, pb));
            if (dotV(tA, ab) < o.gapAlignMin || dotV(tB, [-ab[0], -ab[1]]) < o.gapAlignMin) continue;
            // Niederschlag entlang der Verbindung (Maximum der Stichproben).
            let rr = 0;
            for (let s = 0.1; s < 1; s += 0.1) rr = Math.max(rr, sampleBilinear(af.precip, g, pa[0] + s * (pb[0] - pa[0]), pa[1] + s * (pb[1] - pa[1])) || 0);
            if (rr < o.gapPrecipMin) continue;
            best = { a, b, ea, eb, d, tA, tB, pa, pb };
          }
        }
      }
    }
    if (!best) break;
    const A = items[best.a], B = items[best.b];
    const aPts = best.ea ? A.pts : A.pts.slice().reverse();
    const bPts = best.eb ? B.pts.slice().reverse() : B.pts;
    const pts = [...aPts, ...bridge(best.pa, best.tA, best.pb, best.tB), ...bPts];
    const main = lineLengthKm(A.pts) >= lineLengthKm(B.pts) ? A : B;
    // Seitenangaben gelten in Punktreihenfolge: übernimmt das Hauptstück eine
    // umgekehrte Richtung, spiegeln. A läuft umgekehrt, wenn die Lücke an
    // seinem Anfang liegt, B, wenn sie an seinem Ende liegt.
    const reversed = main === A ? !best.ea : best.eb;
    const flip = (s) => (s && reversed ? (s === "left" ? "right" : "left") : s);
    const props = { ...main.f.properties, warm_side: flip(main.f.properties.warm_side), motion_side: flip(main.f.properties.motion_side) };
    const gaps = [...A.gaps, ...B.gaps, Math.round(best.d)];
    items[best.a] = { f: { ...main.f, properties: props }, pts, gaps };
    items.splice(best.b, 1);
    merged = true;
  }
  return items.map(({ f, pts, gaps }) => (gaps.length ? {
    ...f,
    geometry: { type: "LineString", coordinates: pts.map(([la, lo]) => [+lo.toFixed(3), +la.toFixed(3)]) },
    properties: { ...f.properties, length_km: Math.round(lineLengthKm(pts)), gap_closed_km: gaps },
  } : f));
}

/** Laufendes Mittel entlang der Linie (Fenster ±km/2), Endpunkte fest (s. smoothAlong). */
export function smoothPolyline(pts, km, passes = 1) {
  return smoothAlong(pts, km, passes);
}

/**
 * Alle Fronten abschließend glätten. Die Endpunkte bleiben fest, damit
 * Anschlüsse (Okklusionspunkt, Typwechsel) erhalten bleiben.
 */
export function smoothFeatures(features, opts = {}) {
  const o = { ...POSTPROCESS_DEFAULTS, ...opts };
  return features.map((f) => {
    const pts = f.geometry.coordinates.map(([lo, la]) => [la, lo]);
    if (pts.length < 3) return f;
    const sm = smoothPolyline(pts, o.smoothKm, o.smoothPasses);
    return { ...f, geometry: { type: "LineString", coordinates: sm.map(([la, lo]) => [+lo.toFixed(3), +la.toFixed(3)]) } };
  });
}
