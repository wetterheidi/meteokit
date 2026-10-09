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
  towardLowMin: 0.3,    // cos des Winkels zwischen Okklusionsast und Richtung zum Tief
  edgeLowDrop: 8,       // hPa Druckfall bis zum Gebietsrand für ein Randtief
  edgeKm: 150,          // Minimum so nah am Gebietsrand -> Randtief
  // Verlängerung entlang der Warmluftzunge (θw-Rücken, i. d. R. 700 hPa, K4)
  ridgeSmoothKm: 150,
  ridgeLambdaMin: 0.3,  // K/(100 km)², Mindestkrümmung quer zur Achse (θw)
  // Dasselbe für die Schichtdicke 500/1000: 40 gpm ≈ 2 K Schichtmittel,
  // also 0,3 K ≈ 6 gpm. Erste Annahme, am Fall zu prüfen.
  thicknessLambdaMin: 6,  // gpm/(100 km)²
  ridgeMinKm: 200,      // kürzere Rückenstücke verwerfen
  ridgeJoinKm: 80,      // Achsenstücke mit so nahen Enden zusammenfügen
  ridgeSnapKm: 200,     // Abstand Okklusionsende <-> Rückenachse
  ridgeMaxKm: 1200,     // höchstens so weit verlängern
  // nur im Bereich eines Tiefs. 1200 km war für das großräumige Islandtief
  // (2026-10-09 12 UTC: Okklusionspunkt 1300 km vom Kern) zu knapp.
  lowRangeKm: 1600,
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
export function markOcclusions(features, ff, lows, opts = {}, ridges = null, msl = null) {
  const o = { ...OCCLUSION_DEFAULTS, ...opts };
  const g = ff.g;
  const nAt = (p) => {
    const nx = sampleBilinear(ff.nx, g, p[0], p[1]), ny = sampleBilinear(ff.ny, g, p[0], p[1]);
    const L = Math.hypot(nx, ny);
    return L > 0 ? [nx / L, ny / L] : null;
  };
  const props = (i) => features[i].properties;
  const active = (i) => props(i).activity_class !== "none";
  const isFrontType = (t) => t === "cold" || t === "warm" || t === "stationary";

  // Ketten: aufeinanderfolgende Stücke derselben Linie (detectFronts teilt
  // nach Typ und Aktivität, die Stücke teilen sich den Randpunkt). Die
  // Geometrie wird auf der ganzen Kette bestimmt -- der Okklusionsast hat in
  // 850 hPa oft wenig Wetter und ist als "none" eingestuft (12 UTC Island).
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  const chains = [], range = [];
  features.forEach((f, i) => {
    const pts = f.geometry.coordinates.map(([lo, la]) => [la, lo]);
    const last = chains[chains.length - 1];
    if (last && same(last.pts[last.pts.length - 1], pts[0])) {
      const base = last.pts.length - 1;
      for (let q = 1; q < pts.length; q++) { last.pts.push(pts[q]); last.owner.push(i); }
      last.feats.push(i); range[i] = [base, base + pts.length - 1]; f._chain = last;
    } else {
      const c = { pts: pts.slice(), owner: pts.map(() => i), feats: [i] };
      chains.push(c); range[i] = [0, pts.length - 1]; f._chain = c;
    }
  });
  const chainOf = (i) => features[i]._chain;
  const segOwner = (C, q, dir) => C.owner[dir > 0 ? Math.min(q + 1, C.pts.length - 1) : q];
  const along = (C, from, to) => { let s = 0; const st = from < to ? 1 : -1; for (let q = from; q !== to; q += st) s += distKm(C.pts[q], C.pts[q + st]); return s; };

  const cuts = [];
  features.forEach((fa, i) => {
    const t = props(i).front_type;
    if ((t !== "cold" && t !== "warm") || !active(i)) return;
    const C = chainOf(i);
    for (const endIdx of range[i]) {
      // Freies Ende: Kettenende oder Übergang zu einem Stück ohne Wetter.
      const inner = endIdx > 0 && endIdx < C.pts.length - 1;
      if (inner) {
        const other = endIdx === range[i][0] ? C.owner[endIdx] : C.owner[endIdx + 1];
        if (other !== i && active(other)) continue;
      }
      const E = C.pts[endIdx];
      let best = null;
      for (const B of chains) {
        if (B === C) continue;
        for (let m = 0; m < B.pts.length; m++) {
          const j = B.owner[m], tj = props(j).front_type;
          if (!active(j) || !isFrontType(tj) || tj === t) continue;
          const d = distKm(E, B.pts[m]);
          if (d <= o.junctionKm && (!best || d < best.d)) best = { B, m, d };
        }
      }
      if (!best) continue;
      const { B, m } = best;
      const P = B.pts[m];
      // Berührt das Ende nur das Ende der anderen Kette, stoßen zwei Fronten
      // aneinander -- kein Okklusionspunkt.
      if (Math.min(along(B, m, 0), along(B, m, B.pts.length - 1)) < o.endGapKm) continue;
      const nA = nAt(E), nB = nAt(P);
      if (!nA || !nB) continue;
      const w = unitV([nA[0] + nB[0], nA[1] + nB[1]]);
      const probe = (dir) => {
        let s = 0, q = m;
        while (q + dir >= 0 && q + dir < B.pts.length && s < o.branchProbeKm) { s += distKm(B.pts[q], B.pts[q + dir]); q += dir; }
        return unitV(vecKm(P, B.pts[q]));
      };
      const dPrev = probe(-1), dNext = probe(+1);
      const branch = dotV(dPrev, w) < dotV(dNext, w) ? -1 : +1;
      const dir = branch < 0 ? dPrev : dNext;
      // Eine Okklusion gehört zu einem Tief und zeigt zu ihm hin. Ohne diese
      // Bedingung entstanden nach der Verschiebung auf die Bodenposition
      // Scheinokklusionen an zufällig nahen Linienenden.
      // Zugehöriges Tief: das in Reichweite, auf das der Ast am besten zuläuft
      // (nicht einfach das nächste -- 12 UTC lag das Ostsee-Tief näher am
      // Okklusionspunkt über der Nordsee als das Islandtief).
      let low = null, bestDot = o.towardLowMin;
      for (const l of lows) {
        if (distKm(P, [l.lat, l.lon]) > o.lowRangeKm) continue;
        const dd = dotV(dir, unitV(vecKm(P, [l.lat, l.lon])));
        if (dd >= bestDot) { bestDot = dd; low = l; }
      }
      // Randtief: liegt der Kern jenseits des Modellgebiets (Islandtief am
      // ICON-EU-Westrand um 00 UTC), genügt deutlicher Druckfall entlang des
      // Asts bis zum Gebietsrand.
      if (!low && msl) low = edgeLowAhead(P, dir, msl, g, o);
      if (!low) continue;
      cuts.push({ chain: B, idx: m, branch, dir, low, gap: best.d, P, from: i, endIdx,
        junction: { lat: +P[0].toFixed(2), lon: +P[1].toFixed(2) } });
    }
  });

  // Pro Kette und pro Tief höchstens ein Okklusionspunkt; bei mehreren
  // Kandidaten gewinnt der engste Anschluss (kleinste Lücke Frontende <->
  // andere Front).
  const applied = [];
  for (const c of cuts.sort((a, b) => a.gap - b.gap)) {
    const key = (x) => (x.low.edge ? "edge" : x.low);
    if (!applied.some((a) => a.chain === c.chain || key(a) === key(c))) applied.push(c);
  }

  const toFeature = (i, pts, extra = {}) => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: pts.map(([la, lo]) => [+lo.toFixed(3), +la.toFixed(3)]) },
    properties: { ...props(i), length_km: Math.round(lineLengthKm(pts)), ...extra },
  });
  // Punkte eines Stücks, ggf. mit weich an den Okklusionspunkt gebogenem Ende.
  const featPts = (i) => {
    const C = chainOf(i), [a, b] = range[i];
    let pts = C.pts.slice(a, b + 1);
    for (const j of applied.filter((c) => c.from === i)) pts = bendTo(pts, j.endIdx === a, j.P);
    return pts;
  };

  const out = [];
  for (const C of chains) {
    const cut = applied.find((c) => c.chain === C);
    if (!cut) {
      for (const i of C.feats) {
        const joins = applied.filter((c) => c.from === i);
        out.push(joins.length ? toFeature(i, featPts(i), { occlusion_point: joins[0].junction }) : stripChain(features[i]));
      }
      continue;
    }
    const { idx: m, branch } = cut;
    const last = C.pts.length - 1;
    const [r0, r1] = branch < 0 ? [m, last] : [0, m]; // Rest (Warm-/Kaltfront)
    for (const i of C.feats) {
      const [a, b] = range[i];
      const s0 = Math.max(a, r0), s1 = Math.min(b, r1);
      if (s1 - s0 < 1) continue; // ganz auf der Okklusionsseite
      const pts = featPts(i).slice(s0 - a, s1 - a + 1);
      const extra = s0 === m || s1 === m ? { occlusion_point: cut.junction } : {};
      out.push(s0 === a && s1 === b && !extra.occlusion_point ? stripChain(features[i]) : toFeature(i, pts, extra));
    }
    // Okklusion: bevorzugt entlang der Rückenachse des Warmluftkeils vom
    // Okklusionspunkt bis vor den Kern (K1: durch den Scheitel des Keils der
    // Schichtdicke 500/1000). Sonst der Kettenast, vor dem Kern gekappt bzw.
    // entlang der Achse verlängert.
    const occPts = branch < 0 ? C.pts.slice(0, m + 1).reverse() : C.pts.slice(m);
    let end = occPts.length;
    for (let q = 1; q < occPts.length; q++) if (nearLow(occPts[q], lows, o.lowStopKm)) { end = q + 1; break; }
    let occ = occPts.slice(0, end), geometry = "front_branch";
    const onRidge = ridges?.length ? occlusionAlongRidge(cut.P, cut.dir, ridges, lows, o) : null;
    if (onRidge) { occ = onRidge; geometry = "ridge"; }
    else if (ridges?.length && end === occPts.length) occ = extendAlongRidge(occ, ridges, lows, o);
    // Eigenschaften vom aktiven Stück am Okklusionspunkt.
    const near = [segOwner(C, m, branch), segOwner(C, m, -branch)];
    const src = near.find((i) => active(i)) ?? near[0];
    if (occ.length >= 2) {
      out.push(toFeature(src, occ, {
        front_type: "occluded",
        occlusion_character: props(src).front_type,
        occlusion_point: cut.junction,
        occlusion_geometry: geometry,
        activity_class: props(src).activity_class === "none" ? "weak" : props(src).activity_class,
        // Symbole: Seite wie das Stück, bei umgekehrter Punktreihenfolge gespiegelt.
        motion_side: flipIf(props(src).motion_side, branch < 0),
        warm_side: flipIf(props(src).warm_side, branch < 0),
      }));
    }
  }
  features.forEach((f) => { delete f._chain; });
  return out;
}

function stripChain(f) {
  const { _chain, ...rest } = f;
  return rest;
}

const nearLow = (p, lows, km) => lows.some((l) => distKm(p, [l.lat, l.lon]) < km);

// Randtief: im Sektor ±60° um die Richtung t (Strahlen bis lowRangeKm) das
// Druckminimum suchen. Liegt es am Gebietsrand (≤ edgeKm) und mindestens
// edgeLowDrop unter dem Druck bei P, steht dort ein Tief jenseits des
// Gebiets -- als Pseudotief am Randpunkt zurückgegeben. Ein einzelner Strahl
// reichte nicht: um 00 UTC lief er nördlich am Islandtief vorbei.
function edgeLowAhead(P, t, msl, g, o) {
  const p0 = sampleBilinear(msl, g, P[0], P[1]);
  if (!Number.isFinite(p0)) return null;
  const base = Math.atan2(t[1], t[0]);
  let best = null;
  for (let da = -60; da <= 60; da += 10) {
    const a = base + (da * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
    for (let s = 50; s <= o.lowRangeKm; s += 50) {
      const q = [P[0] + (s * dy) / KM_PER_DEG, P[1] + (s * dx) / (KM_PER_DEG * Math.cos(P[0] * DEG))];
      const v = sampleBilinear(msl, g, q[0], q[1]);
      if (!Number.isFinite(v)) break;
      if (!best || v < best.v) best = { v, q };
    }
  }
  if (!best || p0 - best.v < o.edgeLowDrop) return null;
  const [la, lo] = best.q;
  const edgeKm = Math.min(
    (la - g.lat0) * KM_PER_DEG, (g.lat0 + (g.ny - 1) * g.res - la) * KM_PER_DEG,
    (lo - g.lon0) * KM_PER_DEG * Math.cos(la * DEG), (g.lon0 + (g.nx - 1) * g.res - lo) * KM_PER_DEG * Math.cos(la * DEG));
  if (edgeKm > o.edgeKm) return null;
  return { lat: +la.toFixed(2), lon: +lo.toFixed(2), pressure: +best.v.toFixed(1), edge: true };
}


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
 * Achsen von Warmluftzungen: Rückenlinien eines Felds (θw oder Schichtdicke
 * 500/1000, geglättet); `lambdaMin` in Feldeinheit/(100 km)². Ein Rücken
 * liegt dort, wo die Krümmung quer zur Achse stark negativ ist (kleinster
 * Eigenwert der Hesse-Matrix λ₁ < −lambdaMin) und der Gradient entlang des
 * zugehörigen Eigenvektors verschwindet. Die Vorzeichen der Eigenvektoren
 * werden je Gitterzelle aneinander ausgerichtet, sonst entstehen an
 * Vorzeichenwechseln Scheinlinien.
 * @returns {number[][][]} Polylinien aus [lat, lon]
 */
export function ridgeLines(values, g, opts = {}, lambdaMin = null) {
  const o = { ...OCCLUSION_DEFAULTS, ...opts };
  const lam = lambdaMin ?? o.ridgeLambdaMin;
  const th = gaussianSmooth(Float32Array.from(values, (x) => (x == null ? NaN : x)), g, o.ridgeSmoothKm);
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
      if (!ks.every((k) => l1[k] < -lam)) continue;
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
  return joinLines(chainSegments(segs), o.ridgeJoinKm).filter((l) => lineLengthKm(l) >= o.ridgeMinKm);
}

// Polylinien zusammenfügen, deren Enden näher als tolKm beieinander liegen
// und die dort ohne scharfen Knick ineinander übergehen. Nötig, weil die
// zellweise Ausrichtung der Eigenvektoren an Vorzeichenwechseln keine
// bitgleichen Kreuzungspunkte liefert und chainSegments dort abreißt.
function joinLines(lines, tolKm) {
  const ls = lines.map((l) => l.slice());
  const endDir = (l, atEnd) => {
    // Richtung, in die die Linie an diesem Ende hinausläuft (über ~100 km).
    const n = l.length;
    let q = atEnd ? n - 1 : 0, s = 0;
    const st = atEnd ? -1 : 1;
    while (q + st >= 0 && q + st < n && s < 100) { s += distKm(l[q], l[q + st]); q += st; }
    return unitV(vecKm(l[q], l[atEnd ? n - 1 : 0]));
  };
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let a = 0; a < ls.length; a++) {
      for (let b = a + 1; b < ls.length; b++) {
        for (const ea of [true, false]) {
          for (const eb of [true, false]) {
            const pa = ea ? ls[a][ls[a].length - 1] : ls[a][0];
            const pb = eb ? ls[b][ls[b].length - 1] : ls[b][0];
            if (distKm(pa, pb) > tolKm) continue;
            // Weiterlaufen: Richtung aus a heraus muss zur Richtung in b hinein passen.
            if (dotV(endDir(ls[a], ea), unitV(vecKm(pb, eb ? ls[b][0] : ls[b][ls[b].length - 1]))) < 0) continue;
            const A = ea ? ls[a] : ls[a].slice().reverse();
            const B = eb ? ls[b].slice().reverse() : ls[b];
            ls[a] = [...A, ...B];
            ls.splice(b, 1);
            merged = true;
            break outer;
          }
        }
      }
    }
  }
  return ls;
}

const vecKm = (a, b) => [(b[1] - a[1]) * KM_PER_DEG * Math.cos(((a[0] + b[0]) / 2) * DEG), (b[0] - a[0]) * KM_PER_DEG];
const unitV = (v) => { const L = Math.hypot(v[0], v[1]); return L > 0 ? [v[0] / L, v[1] / L] : [0, 0]; };
const dotV = (u, v) => u[0] * v[0] + u[1] * v[1];

// Nächste Rückenachse zu Q (≤ ridgeSnapKm) und die Laufrichtung darauf, die
// am besten zu t passt. null, wenn keine Achse nah genug ist oder alle
// Richtungen zurücklaufen.
function snapRidge(Q, t, ridges, o) {
  let best = null;
  for (const R of ridges) {
    for (let r = 0; r < R.length; r++) {
      const d = distKm(Q, R[r]);
      if (d <= o.ridgeSnapKm && (!best || d < best.d)) best = { R, r, d };
    }
  }
  if (!best) return null;
  const { R, r } = best;
  const ahead = (dir) => { let q = r, a = 0; while (q + dir >= 0 && q + dir < R.length && a < 150) { a += distKm(R[q], R[q + dir]); q += dir; } return q; };
  const qF = ahead(+1), qB = ahead(-1);
  const sF = qF !== r ? dotV(unitV(vecKm(R[r], R[qF])), t) : -2;
  const sB = qB !== r ? dotV(unitV(vecKm(R[r], R[qB])), t) : -2;
  if (Math.max(sF, sB) < 0) return null;
  return { R, r, dir: sF >= sB ? +1 : -1 };
}

// Entlang einer Achse laufen: bis vor den Tiefkern, bis die Achse endet,
// scharf abknickt, ridgeMaxKm erreicht sind oder kein Tief mehr nah ist.
function walkRidge({ R, r, dir }, from, t, lows, o) {
  const ext = [];
  let len = 0, lastDir = t, anchor = from, started = false;
  for (let q = r; q >= 0 && q < R.length; q += dir) {
    const p = R[q];
    const step = distKm(anchor, p);
    if (step < 25) continue; // dichte Stützpunkte zusammenfassen
    const dv = unitV(vecKm(anchor, p));
    // Einstieg: erst ab dem ersten Achsenpunkt, der in Laufrichtung vor dem
    // Startpunkt liegt (der nächstgelegene liegt oft seitlich dahinter).
    if (!started) {
      if (dotV(dv, t) < 0.3) continue;
      started = true;
    } else if (dotV(dv, lastDir) < Math.cos((100 * Math.PI) / 180)) break; // scharfer Knick
    len += step;
    if (len > o.ridgeMaxKm) break;
    ext.push(p);
    lastDir = dv; anchor = p;
    if (nearLow(p, lows, o.lowStopKm)) break;
    if (!lows.some((l) => distKm(p, [l.lat, l.lon]) <= o.lowRangeKm)) break;
  }
  return ext;
}

// Okklusion ab ihrem Ende entlang der nächstgelegenen Rückenachse
// fortsetzen. Nur im Bereich eines Tiefs (lowRangeKm) -- ohne Zyklone keine
// Okklusion.
function extendAlongRidge(occ, ridges, lows, o) {
  const Q = occ[occ.length - 1];
  if (!lows.some((l) => distKm(Q, [l.lat, l.lon]) <= o.lowRangeKm)) return occ;
  let back = occ.length - 1, s = 0;
  while (back > 0 && s < 150) { s += distKm(occ[back - 1], occ[back]); back--; }
  const t = unitV(vecKm(occ[back], Q));
  const snap = snapRidge(Q, t, ridges, o);
  if (!snap) return occ;
  const ext = walkRidge(snap, Q, t, lows, o);
  return ext.length ? [...occ, ...ext] : occ;
}

// Okklusion ganz entlang der Achse: vom Okklusionspunkt P in Richtung t (vom
// Warmsektor weg) bis vor den Tiefkern. Der Anfang biegt weich in P ein.
// null, wenn keine Achse nah ist oder das Stück kürzer als ridgeMinKm wäre.
function occlusionAlongRidge(P, t, ridges, lows, o) {
  if (!lows.some((l) => distKm(P, [l.lat, l.lon]) <= o.lowRangeKm)) return null;
  const snap = snapRidge(P, t, ridges, o);
  if (!snap) return null;
  const ext = walkRidge(snap, P, t, lows, o);
  if (ext.length < 2 || lineLengthKm(ext) < o.ridgeMinKm) return null;
  return bendTo(ext, true, P);
}

function flipIf(side, cond) {
  if (!side || !cond) return side;
  return side === "left" ? "right" : "left";
}
