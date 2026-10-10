/**
 * Schleifende Fronten am Gebirgsrand (`meteokit/fronts`), in Erprobung.
 *
 * Kaltfronten, die von Norden oder Nordwesten gegen die Alpen laufen,
 * verlagern wegen der Orographie nicht ungehindert nach Süden: Sie bleiben
 * am Nordrand hängen, es staut sich Kaltluft, der Druck steigt (deshalb
 * greift dort kein Isobarenknick), und die Front wellt am Alpennordrand
 * (Projektleitung, 08.10. 18 UTC: Kaltfront bis Oberösterreich, dann
 * quasistationär am Alpennordrand bis in die Schweiz; Druckanstieg
 * +3 bis +4,5 hPa/3 h, Niederschlag 0,6–1,1 mm/h).
 *
 * Endet eine Kaltfront am Gelände (850 hPa unter Grund), wird sie entlang
 * des Geländerands als quasistationäre Front fortgesetzt, solange das
 * Stau-Signal anhält: Druckanstieg und Niederschlag.
 */

import { gaussianSmooth, isolineSegments, chainSegments, sampleBilinear, distKm, lineLengthKm, smoothAlong } from "./grid.js";

export const STAU_DEFAULTS = {
  endKm: 150,          // Ende der Kaltfront höchstens so weit vom Geländerand
  southMax: 0.6,       // Lauf endet, wo der Rand nach Süden abbiegt (Anteil Süd an 100 km Weg)
  tendMin: 1.5,        // hPa/3 h Druckanstieg am Rand
  rrMin: 0.3,          // mm/h Niederschlag am Rand
  breakKm: 100,        // so lange darf das Signal aussetzen
  minKm: 200,          // Mindestlänge des schleifenden Stücks
  offsetKm: 20,        // Linie so weit vom Geländerand ins Vorland gerückt
};

/**
 * @param {object[]} features Fronten (GeoJSON, [lon, lat])
 * @param {object} field      mit psfc, below, pressure, sfc
 * @param {object} prev       Vortermin (für die Drucktendenz)
 * @returns {object[]} neue quasistationäre Fronten
 */
export function stauFronts(features, field, prev, g, opts = {}) {
  const o = { ...STAU_DEFAULTS, ...opts };
  if (!prev?.sfc?.pressure_msl || !field.sfc?.precipitation) return [];
  const n = g.nx * g.ny;
  const terrain = new Float32Array(n);
  for (let k = 0; k < n; k++) terrain[k] = field.below[k] || !(field.psfc[k] - field.pressure >= 25) ? 1 : 0;
  // Geländerand als Isolinie des leicht geglätteten Geländes.
  const rims = chainSegments(isolineSegments(gaussianSmooth(terrain, g, 30), g, 0.5)).filter((l) => lineLengthKm(l) > 300);
  if (!rims.length) return [];
  const T = gaussianSmooth(terrain, g, 30);
  const S = (a, s) => gaussianSmooth(Float32Array.from(a, (x) => (x == null ? NaN : x)), g, s);
  const tend = S(field.sfc.pressure_msl.map((x, k) => x - prev.sfc.pressure_msl[k]), 60);
  const rr = S(field.sfc.precipitation, 40);
  const at = (f, p) => sampleBilinear(f, g, p[0], p[1]);
  const ok = (p) => at(tend, p) >= o.tendMin && at(rr, p) >= o.rrMin;

  const out = [];
  for (const f of features) {
    const pr = f.properties;
    if (pr.front_type !== "cold" || pr.activity_class === "none") continue;
    const ll = f.geometry.coordinates.map(([lo, la]) => [la, lo]);
    for (const end of [ll[0], ll[ll.length - 1]]) {
      // nächster Punkt auf einem Geländerand
      let best = null;
      for (const rim of rims) rim.forEach((p, i) => { const d = distKm(end, p); if (!best || d < best.d) best = { d, rim, i }; });
      if (!best || best.d > o.endKm) continue;
      // in beide Richtungen am Rand entlang, solange das Stau-Signal anhält
      const walk = (dir) => {
        const pts = [];
        let gapKm = 0, lastOk = -1;
        for (let i = best.i; i >= 0 && i < best.rim.length; i += dir) {
          const p = best.rim[i];
          if (pts.length) gapKm += distKm(pts[pts.length - 1], p);
          pts.push(p);
          // nur am Nordrand: biegt der Rand nach Süden ab (Westalpen), endet der Lauf
          let q = pts.length - 1, s = 0;
          while (q > 0 && s < 100) { s += distKm(pts[q - 1], pts[q]); q--; }
          if (s >= 100 && ((pts[q][0] - p[0]) * 111.2) / s > o.southMax) break;
          if (ok(p)) { lastOk = pts.length - 1; gapKm = 0; } else if (gapKm > o.breakKm) break;
        }
        return pts.slice(0, lastOk + 1);
      };
      const runs = [walk(1), walk(-1)].filter((r) => r.length > 1 && lineLengthKm(r) >= o.minKm);
      if (!runs.length) continue;
      const run = runs.sort((a, b) => lineLengthKm(b) - lineLengthKm(a))[0];
      // ins Vorland rücken (weg vom Gelände) und glätten; Start am Kaltfrontende
      const moved = run.map((p) => offFromTerrain(p, T, g, o.offsetKm));
      const pts = smoothAlong([end, ...moved], 100, 2);
      out.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: pts.map(([la, lo]) => [+lo.toFixed(3), +la.toFixed(3)]) },
        properties: {
          ...pr,
          front_type: "stationary",
          method: "stau",
          length_km: Math.round(lineLengthKm(pts)),
          criteria: { ...pr.criteria, tendency_rim: +mean(run.map((p) => at(tend, p))).toFixed(1), precip: +mean(run.map((p) => at(rr, p))).toFixed(2) },
          warm_side: terrainSide(pts, T, g),
          motion_side: null,
        },
      });
    }
  }
  return out;
}

const mean = (a) => { const f = a.filter(Number.isFinite); return f.length ? f.reduce((x, y) => x + y, 0) / f.length : NaN; };

// Punkt entlang des Gegengradienten des Geländes um km verschieben.
function offFromTerrain(p, T, g, km) {
  const h = 0.25;
  const dx = sampleBilinear(T, g, p[0], p[1] + h) - sampleBilinear(T, g, p[0], p[1] - h);
  const dy = sampleBilinear(T, g, p[0] + h, p[1]) - sampleBilinear(T, g, p[0] - h, p[1]);
  const c = Math.cos((p[0] * Math.PI) / 180), L = Math.hypot(dx / c, dy);
  if (!(L > 0)) return p;
  return [p[0] - (km * dy) / L / 111.2, p[1] - (km * dx) / c / L / (111.2 * c)];
}

// Seite (in Punktreihenfolge), auf der das Gelände liegt: dort ist es wärmer
// (die Kaltluft staut sich im Vorland).
function terrainSide(pts, T, g) {
  let s = 0;
  for (let m = 1; m < pts.length; m++) {
    const a = pts[m - 1], b = pts[m], c = Math.cos((a[0] * Math.PI) / 180);
    const tx = (b[1] - a[1]) * c, ty = b[0] - a[0], L = Math.hypot(tx, ty) || 1;
    // links der Laufrichtung: (−ty, tx) in (Ost, Nord), 0,3° Abstand
    const left = [a[0] + (0.3 * tx) / L, a[1] - (0.3 * ty) / (L * c)];
    const right = [a[0] - (0.3 * tx) / L, a[1] + (0.3 * ty) / (L * c)];
    s += sampleBilinear(T, g, left[0], left[1]) - sampleBilinear(T, g, right[0], right[1]);
  }
  return s >= 0 ? "left" : "right";
}
