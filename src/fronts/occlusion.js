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
 *     den Kern herum, nicht hinein geführt werden, K4). Endet der Ast vorher,
 *     wird sie entlang der Warmluftzunge (θw-Rücken in 700 hPa) verlängert.
 *  4. Die Kalt- bzw. Warmfront, deren Ende den Okklusionspunkt bestimmt
 *     hat, wird bis dorthin verlängert: dort treffen sich alle drei.
 *
 * Kriterien und Quellen: tools/fronts/KRITERIEN.md, Abschnitt 7. Der
 * Charakter (Kalt-/Warmfrontcharakter) bleibt als `occlusion_character`
 * erhalten -- aus der Verlagerung, wie zuvor für den Ast bestimmt.
 */

import { gaussianSmooth, gradient, chainSegments, sampleBilinear, distKm, lineLengthKm } from "./grid.js";

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
  // Verlängerung entlang der Warmluftzunge (θw-Rücken, i. d. R. 700 hPa, K4)
  ridgeSmoothKm: 150,
  ridgeLambdaMin: 0.3,  // K/(100 km)², Mindestkrümmung quer zur Achse
  ridgeMinKm: 200,      // kürzere Rückenstücke verwerfen
  ridgeSnapKm: 200,     // Abstand Okklusionsende <-> Rückenachse
  ridgeMaxKm: 1200,     // höchstens so weit verlängern
  lowRangeKm: 1200,     // nur im Bereich eines Tiefs
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
 * `ff` = frontFields (für n̂), `ridges` = `ridgeLines` der Warmluftzungen
 * (optional, für die Verlängerung um den Kern). Gibt eine neue Feature-
 * Liste zurück: Okklusionsäste sind abgetrennt (`front_type: "occluded"`),
 * die zuführende Kalt- bzw. Warmfront ist bis an den Okklusionspunkt
 * verlängert, so dass sich dort alle drei treffen.
 */
export function markOcclusions(features, ff, lows, opts = {}, ridges = null) {
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
      cuts.push({ line: B, idx: m, branch, P, from: A, endIdx, junction: { lat: +P[0].toFixed(2), lon: +P[1].toFixed(2) } });
    }
  }

  // Pro Linie höchstens ein Schnitt (der erste gefundene); mehrere
  // Okklusionspunkte auf einer Linie sind im Testfall nicht vorgekommen.
  const applied = [];
  for (const c of cuts) if (!applied.some((a) => a.line === c.line)) applied.push(c);
  const toFeature = (L, pts, props) => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: pts.map(([la, lo]) => [+lo.toFixed(3), +la.toFixed(3)]) },
    properties: { ...L.f.properties, length_km: Math.round(lineLengthKm(pts)), ...props },
  });

  const out = [];
  for (const L of lines) {
    const cut = applied.find((c) => c.line === L);
    if (!cut) {
      // Freies Ende einer Kalt-/Warmfront bis an den Okklusionspunkt
      // verlängern, damit sich dort alle drei Fronten treffen.
      const joins = applied.filter((c) => c.from === L);
      if (!joins.length) { out.push(L.f); continue; }
      let pts = L.pts.slice();
      for (const j of joins) pts = bendTo(pts, j.endIdx === 0, j.P);
      out.push(toFeature(L, pts, { occlusion_point: joins[0].junction }));
      continue;
    }
    const { idx, branch } = cut;
    const occPts = branch < 0 ? L.pts.slice(0, idx + 1).reverse() : L.pts.slice(idx);
    const restPts = branch < 0 ? L.pts.slice(idx) : L.pts.slice(0, idx + 1);
    // Vor dem Tiefkern enden (spiralig herum statt hinein, K4).
    let end = occPts.length;
    for (let q = 1; q < occPts.length; q++) {
      if (nearLow(occPts[q], lows, o.lowStopKm)) { end = q + 1; break; }
    }
    let occ = occPts.slice(0, end);
    // Hört die Okklusion vor dem Kern auf, entlang der Warmluftzunge
    // (θw-Rücken in 700 hPa) weiterführen.
    if (ridges?.length && end === occPts.length) occ = extendAlongRidge(occ, ridges, lows, o);
    if (restPts.length >= 2) out.push(toFeature(L, restPts, { occlusion_point: cut.junction }));
    if (occ.length >= 2) {
      out.push(toFeature(L, occ, {
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

const nearLow = (p, lows, km) => lows.some((l) => distKm(p, [l.lat, l.lon]) < km);

// Linienende weich an P heranbiegen statt ein gerades Stück anzuhängen: die
// Punkte im letzten Abschnitt (doppelte Lückenlänge, mind. 150 km) werden
// um einen mit der Nähe zum Ende wachsenden Anteil der Lücke verschoben
// (glatt, 0 -> 1), der Endpunkt landet genau auf P.
function bendTo(pts, atStart, P) {
  const line = atStart ? pts.slice().reverse() : pts.slice();
  const E = line[line.length - 1];
  const gap = distKm(E, P);
  if (gap < 1) return pts;
  const span = Math.max(150, 2 * gap);
  const dLat = P[0] - E[0], dLon = P[1] - E[1];
  let s = 0;
  for (let q = line.length - 1; q >= 0; q--) {
    if (q < line.length - 1) s += distKm(line[q], line[q + 1]);
    if (s > span) break;
    const x = 1 - s / span, w = x * x * (3 - 2 * x); // smoothstep
    line[q] = [line[q][0] + w * dLat, line[q][1] + w * dLon];
  }
  return atStart ? line.reverse() : line;
}

/**
 * Achsen von Warmluftzungen: Rückenlinien von θw (geglättet). Ein Rücken
 * liegt dort, wo die Krümmung quer zur Achse stark negativ ist (kleinster
 * Eigenwert der Hesse-Matrix λ₁ < −lambdaMin) und der Gradient entlang des
 * zugehörigen Eigenvektors verschwindet. Die Vorzeichen der Eigenvektoren
 * werden je Gitterzelle aneinander ausgerichtet, sonst entstehen an
 * Vorzeichenwechseln Scheinlinien.
 * @returns {number[][][]} Polylinien aus [lat, lon]
 */
export function ridgeLines(thetaW, g, opts = {}) {
  const o = { ...OCCLUSION_DEFAULTS, ...opts };
  const th = gaussianSmooth(thetaW, g, o.ridgeSmoothKm);
  const d1 = gradient(th, g), dX = gradient(d1.gx, g), dY = gradient(d1.gy, g);
  const n = g.nx * g.ny;
  const l1 = new Float32Array(n), ex = new Float32Array(n), ey = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const a = dX.gx[k], c = dY.gy[k], b = (dX.gy[k] + dY.gx[k]) / 2;
    l1[k] = (a + c) / 2 - Math.hypot((a - c) / 2, b);
    let vx = b, vy = l1[k] - a;
    if (Math.hypot(vx, vy) < 1e-9) { vx = l1[k] - c; vy = b; }
    const L = Math.hypot(vx, vy) || 1;
    ex[k] = vx / L; ey[k] = vy / L;
  }
  const P = (i, j) => [g.lat0 + j * g.res, g.lon0 + i * g.res];
  const segs = [];
  for (let j = 0; j < g.ny - 1; j++) {
    for (let i = 0; i < g.nx - 1; i++) {
      const ks = [j * g.nx + i, j * g.nx + i + 1, (j + 1) * g.nx + i + 1, (j + 1) * g.nx + i];
      if (!ks.every((k) => l1[k] < -o.ridgeLambdaMin)) continue;
      const e0x = ex[ks[0]], e0y = ey[ks[0]];
      const d = ks.map((k) => (Math.sign(ex[k] * e0x + ey[k] * e0y) || 1) * (d1.gx[k] * ex[k] + d1.gy[k] * ey[k]));
      if (!d.every(Number.isFinite)) continue;
      const pts = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)], cr = [];
      for (let e = 0; e < 4; e++) {
        const a = d[e], b = d[(e + 1) % 4];
        if ((a >= 0) === (b >= 0)) continue;
        const f = a / (a - b), p0 = pts[e], p1 = pts[(e + 1) % 4];
        cr.push([p0[0] + f * (p1[0] - p0[0]), p0[1] + f * (p1[1] - p0[1])]);
      }
      if (cr.length === 2) segs.push(cr);
    }
  }
  return chainSegments(segs).filter((l) => lineLengthKm(l) >= o.ridgeMinKm);
}

// Okklusion ab ihrem Ende entlang der nächstgelegenen Rückenachse
// fortsetzen: Richtung wie das Okklusionsende, bis vor den Tiefkern, bis
// die Achse endet, scharf abknickt oder ridgeMaxKm erreicht sind. Nur im
// Bereich eines Tiefs (lowRangeKm) -- ohne Zyklone keine Okklusion.
function extendAlongRidge(occ, ridges, lows, o) {
  const Q = occ[occ.length - 1];
  if (!lows.some((l) => distKm(Q, [l.lat, l.lon]) <= o.lowRangeKm)) return occ;
  const vec = (a, b) => [(b[1] - a[1]) * KM_PER_DEG * Math.cos(((a[0] + b[0]) / 2) * DEG), (b[0] - a[0]) * KM_PER_DEG];
  const unit = (v) => { const L = Math.hypot(v[0], v[1]); return L > 0 ? [v[0] / L, v[1] / L] : [0, 0]; };
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1];
  let back = occ.length - 1, s = 0;
  while (back > 0 && s < 150) { s += distKm(occ[back - 1], occ[back]); back--; }
  const t = unit(vec(occ[back], Q));

  let best = null;
  for (const R of ridges) {
    for (let r = 0; r < R.length; r++) {
      const d = distKm(Q, R[r]);
      if (d <= o.ridgeSnapKm && (!best || d < best.d)) best = { R, r, d };
    }
  }
  if (!best) return occ;
  const { R, r } = best;
  const ahead = (dir) => { let q = r, a = 0; while (q + dir >= 0 && q + dir < R.length && a < 150) { a += distKm(R[q], R[q + dir]); q += dir; } return q; };
  const qF = ahead(+1), qB = ahead(-1);
  const sF = qF !== r ? dot(unit(vec(R[r], R[qF])), t) : -2;
  const sB = qB !== r ? dot(unit(vec(R[r], R[qB])), t) : -2;
  const dir = sF >= sB ? +1 : -1;
  if (Math.max(sF, sB) < 0) return occ; // Achse läuft zurück, nicht weiter

  const ext = [];
  let len = 0, lastDir = t, anchor = Q;
  for (let q = r; q >= 0 && q < R.length; q += dir) {
    const p = R[q];
    const step = distKm(anchor, p);
    if (step < 25) continue; // dichte Stützpunkte zusammenfassen
    const dv = unit(vec(anchor, p));
    if (dot(dv, lastDir) < Math.cos((100 * Math.PI) / 180)) break; // scharfer Knick
    len += step;
    if (len > o.ridgeMaxKm) break;
    ext.push(p);
    lastDir = dv; anchor = p;
    if (nearLow(p, lows, o.lowStopKm)) break;
    if (!lows.some((l) => distKm(p, [l.lat, l.lon]) <= o.lowRangeKm)) break;
  }
  return ext.length ? [...occ, ...ext] : occ;
}

function flipIf(side, cond) {
  if (!side || !cond) return side;
  return side === "left" ? "right" : "left";
}
