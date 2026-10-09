/**
 * Tiefzentren und Okklusionen (`meteokit/fronts`).
 *
 * Nach dem Zyklonenmodell treffen sich am Okklusionspunkt drei Äste:
 * Kaltfront, Warmfront und Okklusion. Kalt- und Warmfront begrenzen den
 * Warmsektor; die Okklusion ist der dritte Ast, der vom Warmsektor weg in
 * die Kaltluft zeigt (meist zum Tiefkern hin). Objektiv:
 *
 *  1. Okklusionspunkt: Ein Ende einer Kalt- (Warm-)front liegt nahe an einer
 *     Front des anderen Typs, nicht an deren Ende (sonst stoßen nur zwei
 *     Fronten aneinander).
 *  2. Dort teilt sich die berührte Linie in zwei Äste. Okklusion ist der Ast,
 *     dessen Richtung am stärksten der Warmsektor-Richtung entgegenläuft
 *     (Mittel der n̂ beider Fronten am Okklusionspunkt, n̂ zeigt zur warmen
 *     Seite).
 *  3. Die Okklusion reicht vom Okklusionspunkt bis zum Ende dieses Asts,
 *     höchstens bis auf `lowStopKm` an ein Tiefzentrum heran (sie soll um
 *     den Kern herum, nicht hinein geführt werden, K4).
 *
 * Kriterien und Quellen: tools/fronts/KRITERIEN.md, Abschnitt 7. Der
 * Charakter (Kalt-/Warmfrontcharakter) bleibt als `occlusion_character`
 * erhalten -- aus der Verlagerung, wie zuvor für den Ast bestimmt.
 */

import { gaussianSmooth, sampleBilinear, distKm, lineLengthKm } from "./grid.js";

const DEG = Math.PI / 180;
const KM_PER_DEG = 111.2;

export const OCCLUSION_DEFAULTS = {
  // Tiefzentren
  lowSmoothKm: 100,     // Glättung des Bodendrucks
  lowRingKm: 500,       // Ring für die Tiefe
  lowMinDepth: 3,       // hPa: Ringmittel minus Kerndruck
  lowMergeKm: 300,      // benachbarte Minima zusammenfassen
  // Okklusionspunkt
  // max. Abstand Frontende <-> andere Front. 250 km reichte am Ostsee-Tief
  // (2026-10-09 06 UTC) nicht: die Kaltfront reißt dort 322 km vor der
  // Warmfront ab. 350 km erzeugte im Testfall keine falschen Punkte.
  junctionKm: 350,
  endGapKm: 150,        // berührte Stelle muss so weit von deren Enden weg sein
  branchProbeKm: 300,   // Richtung eines Asts: Punkt in diesem Abstand
  lowStopKm: 150,       // Okklusion endet so weit vor dem Tiefkern
};

/** Tiefzentren als lokale Minima des geglätteten Bodendrucks mit Mindesttiefe. */
export function findLows(field, g, opts = {}) {
  const o = { ...OCCLUSION_DEFAULTS, ...opts };
  if (!field.sfc?.pressure_msl) return [];
  const msl = gaussianSmooth(Float32Array.from(field.sfc.pressure_msl, (x) => (x == null ? NaN : x)), g, o.lowSmoothKm);
  const found = [];
  for (let j = 2; j < g.ny - 2; j++) {
    for (let i = 2; i < g.nx - 2; i++) {
      const v = msl[j * g.nx + i];
      if (!Number.isFinite(v)) continue;
      let isMin = true;
      for (let dj = -2; dj <= 2 && isMin; dj++) {
        for (let di = -2; di <= 2; di++) {
          if ((di || dj) && !(msl[(j + dj) * g.nx + i + di] >= v)) { isMin = false; break; }
        }
      }
      if (!isMin) continue;
      const lat = g.lat0 + j * g.res, lon = g.lon0 + i * g.res;
      // Ring darf am Gebietsrand teilweise fehlen (Islandtief am ICON-EU-Rand),
      // mindestens ein Drittel muss aber im Gebiet liegen.
      let s = 0, c = 0;
      for (let a = 0; a < 360; a += 15) {
        const x = sampleBilinear(msl, g, lat + (o.lowRingKm / KM_PER_DEG) * Math.cos(a * DEG),
          lon + (o.lowRingKm / (KM_PER_DEG * Math.cos(lat * DEG))) * Math.sin(a * DEG));
        if (Number.isFinite(x)) { s += x; c++; }
      }
      if (c >= 8 && s / c - v >= o.lowMinDepth) found.push({ lat, lon, pressure: +v.toFixed(1), depth: +(s / c - v).toFixed(1) });
    }
  }
  found.sort((a, b) => a.pressure - b.pressure);
  const lows = [];
  for (const l of found) if (!lows.some((m) => distKm([l.lat, l.lon], [m.lat, m.lon]) < o.lowMergeKm)) lows.push(l);
  return lows;
}

/**
 * Okklusionen in einer Frontenliste markieren. Erwartet Features aus
 * `detectFronts` (Koordinaten [lon, lat], `front_type` cold/warm/…),
 * `ff` = frontFields (für n̂). Gibt eine neue Feature-Liste zurück; die
 * Okklusionsäste sind abgetrennt und haben `front_type: "occluded"`.
 */
export function markOcclusions(features, ff, lows, opts = {}) {
  const o = { ...OCCLUSION_DEFAULTS, ...opts };
  const g = ff.g;
  const nAt = (p) => {
    const nx = sampleBilinear(ff.nx, g, p[0], p[1]), ny = sampleBilinear(ff.ny, g, p[0], p[1]);
    const L = Math.hypot(nx, ny);
    return L > 0 ? [nx / L, ny / L] : null;
  };
  // Lokaler Ost-/Nord-Vektor (km) von a nach b.
  const vec = (a, b) => [(b[1] - a[1]) * KM_PER_DEG * Math.cos(((a[0] + b[0]) / 2) * DEG), (b[0] - a[0]) * KM_PER_DEG];
  const unit = (v) => { const L = Math.hypot(v[0], v[1]); return L > 0 ? [v[0] / L, v[1] / L] : [0, 0]; };

  const lines = features.map((f) => ({ f, pts: f.geometry.coordinates.map(([lo, la]) => [la, lo]) }));
  const isFront = (f) => ["cold", "warm", "stationary"].includes(f.properties.front_type)
    && f.properties.activity_class !== "none";
  const cuts = []; // { line, idx, branch: +1|-1, junction }

  for (const A of lines) {
    if (!isFront(A.f) || A.f.properties.front_type === "stationary") continue;
    for (const endIdx of [0, A.pts.length - 1]) {
      const E = A.pts[endIdx];
      // Nächstgelegene Stelle auf einer Front des anderen Typs (stationär zählt mit).
      let best = null;
      for (const B of lines) {
        if (B === A || !isFront(B.f) || B.f.properties.front_type === A.f.properties.front_type) continue;
        for (let m = 0; m < B.pts.length; m++) {
          const d = distKm(E, B.pts[m]);
          if (d <= o.junctionKm && (!best || d < best.d)) best = { B, m, d };
        }
      }
      if (!best) continue;
      const { B, m } = best;
      const P = B.pts[m];
      // Berührt das Ende nur das Ende der anderen Linie, stoßen zwei Fronten
      // aneinander -- kein Okklusionspunkt.
      const along = (from, to) => { let s = 0; const st = from < to ? 1 : -1; for (let q = from; q !== to; q += st) s += distKm(B.pts[q], B.pts[q + st]); return s; };
      const toStart = along(m, 0), toEnd = along(m, B.pts.length - 1);
      if (Math.min(toStart, toEnd) < o.endGapKm) continue;

      // Warmsektor-Richtung: Mittel der n̂ beider Fronten am Okklusionspunkt.
      const nA = nAt(E), nB = nAt(P);
      if (!nA || !nB) continue;
      const w = unit([nA[0] + nB[0], nA[1] + nB[1]]);
      // Die beiden Äste von B ab P: Richtung über branchProbeKm.
      const probe = (dir) => {
        let s = 0, q = m;
        while (q + dir >= 0 && q + dir < B.pts.length && s < o.branchProbeKm) { s += distKm(B.pts[q], B.pts[q + dir]); q += dir; }
        return unit(vec(P, B.pts[q]));
      };
      const dPrev = probe(-1), dNext = probe(+1);
      const dot = (u, v) => u[0] * v[0] + u[1] * v[1];
      const branch = dot(dPrev, w) < dot(dNext, w) ? -1 : +1;
      cuts.push({ line: B, idx: m, branch, junction: { lat: +P[0].toFixed(2), lon: +P[1].toFixed(2) } });
    }
  }

  // Linien an den Okklusionspunkten teilen. Pro Linie höchstens ein Schnitt
  // (der erste gefundene); mehrere Okklusionspunkte auf einer Linie sind
  // im Testfall nicht vorgekommen.
  const out = [];
  const done = new Set();
  for (const L of lines) {
    const cut = cuts.find((c) => c.line === L);
    if (!cut || done.has(L)) { out.push(L.f); continue; }
    done.add(L);
    const { idx, branch } = cut;
    const occPts = branch < 0 ? L.pts.slice(0, idx + 1).reverse() : L.pts.slice(idx);
    const restPts = branch < 0 ? L.pts.slice(idx) : L.pts.slice(0, idx + 1);
    // Vor dem Tiefkern enden (spiralig herum statt hinein, K4).
    let end = occPts.length;
    for (let q = 1; q < occPts.length; q++) {
      if (lows.some((l) => distKm(occPts[q], [l.lat, l.lon]) < o.lowStopKm)) { end = q + 1; break; }
    }
    const occ = occPts.slice(0, end);
    const toFeature = (pts, props) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: pts.map(([la, lo]) => [lo, la]) },
      properties: { ...L.f.properties, length_km: Math.round(lineLengthKm(pts)), ...props },
    });
    if (restPts.length >= 2) out.push(toFeature(restPts, {}));
    if (occ.length >= 2) {
      out.push(toFeature(occ, {
        front_type: "occluded",
        occlusion_character: L.f.properties.front_type,
        occlusion_point: cut.junction,
        // Symbole: Okklusion zieht wie ihr Ast; Seite unverändert übernommen,
        // aber Punktreihenfolge kann umgedreht sein -> Seite spiegeln.
        motion_side: flipIf(L.f.properties.motion_side, branch < 0),
        warm_side: flipIf(L.f.properties.warm_side, branch < 0),
      }));
    }
  }
  return out;
}

function flipIf(side, cond) {
  if (!side || !cond) return side;
  return side === "left" ? "right" : "left";
}
