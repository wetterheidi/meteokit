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
  lowStopKm: 80,        // Okklusion endet so weit vor dem Tiefkern (Referenzanalyse: dicht um den Kern)
  towardLowMin: 0.3,    // cos des Winkels zwischen Okklusionsast und Richtung zum Tief
  edgeLowDrop: 8,       // hPa Druckfall bis zum Gebietsrand für ein Randtief
  edgeKm: 150,          // Minimum so nah am Gebietsrand -> Randtief
  // Okklusionspunkt zum stärksten 3-h-Druckfall entlang der Achse des
  // Warmluftkeils (K1: Zentrum des isallobarischen Tiefs; so orientiert sich
  // auch die synoptische Referenzanalyse 2026-10-09 12 UTC)
  opSearchKm: 300,
  opRidgeKm: 100,       // Kandidaten so nah an der Achse, der die Okklusion folgt
  opTrimKm: 150,        // liegt der neue Punkt so nah an einer Front, wird sie dort gekürzt
  opBackKm: 30,         // höchstens so weit entgegen der Okklusionsrichtung
  opDistPenalty: 0.15,  // hPa/3 h je 100 km Verschiebung
  opMinGain: 0.3,       // hPa/3 h: nur bei deutlich stärkerem Fall verschieben
  // Spirale um den Kern (gegen den Uhrzeigersinn, Druck fallend)
  spiralStepKm: 50,
  spiralMinDrop: 0.05,  // hPa je Schritt
  spiralMaxKm: 1500,
  passLowKm: 50,        // Achse verlassen, sobald sie sich so weit wieder vom Kern entfernt
  spiralMaxTurn: 200,   // Grad, höchstens so weit um den Kern
  spiralInwardKm: 8,    // je Schritt mindestens so viel näher an den Kern
  spiralMaxStepTurn: 60, // Grad je Schritt -- enger wird es zur Zacke
  // Glättung ("Fronten spannen sich wie Segel")
  occSmoothKm: 150,     // Okklusion insgesamt
  junctionSmoothKm: 500, // Kaltfront + Okklusion um den Okklusionspunkt (Drehung auf beide verteilen)
  occBlendKm: 300,      // Okklusion verlässt den Punkt in Kaltfrontrichtung, Übergang über diese Länge
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
export function markOcclusions(features, ff, lows, opts = {}, ridges = null, ctx = null) {
  const msl = ctx?.msl ?? null;
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
  const ptsOf = (i) => chainOf(i).pts.slice(range[i][0], range[i][1] + 1);

  // Geometrie an jedem Okklusionspunkt neu aufbauen. Überschriebene Punkte
  // je Stück (newPts), weggefallene Stücke (drop), Zusatzattribute (extra).
  const newPts = new Map(), drop = new Set(), extra = new Map(), occFeatures = [];
  for (const cut of applied) {
    const C = cut.chain, m = cut.idx, branch = cut.branch, last = C.pts.length - 1;
    // 1. Okklusionspunkt zum stärksten Druckfall (isallobarisches Tief, K1).
    // Nur entlang der Achse, der auch die Okklusion folgt -- sonst springt der
    // Punkt auf die Achse des Warmsektors (Ostsee-Tief 12 UTC).
    const occRidge = ridges?.length ? snapRidge(cut.P, cut.dir, ridges, o) : null;
    const P2 = ctx?.tend && occRidge ? refineJunction(cut.P, ctx.tend, g, o, [occRidge.R], cut.dir) : cut.P;

    // 2. Zuführende Front A und Rest der Kette, beide mit dem Punkt am Ende.
    const A = cut.from;
    const aAtStart = cut.endIdx === range[A][0];
    let aPts = ptsOf(A); if (aAtStart) aPts.reverse();
    const [r0, r1] = branch < 0 ? [m, last] : [0, m];
    let rest = C.pts.slice(r0, r1 + 1); if (branch < 0) rest.reverse();
    // Liegt der neue Punkt nahe an einer der beiden Linien, wird sie dort
    // gekürzt statt zurückgebogen (sonst entsteht ein Haken).
    aPts = bendTo(trimToward(aPts, P2, o.opTrimKm), false, P2);
    rest = bendTo(trimToward(rest, P2, o.opTrimKm), false, P2);

    // 3. Okklusion ab dem Punkt: bevorzugt entlang der Rückenachse des
    // Warmluftkeils (K1: durch den Scheitel des Keils der Schichtdicke
    // 500/1000), sonst der Kettenast (vor dem Kern gekappt, ggf. entlang der
    // Achse verlängert).
    let occ = null, geometry = "ridge";
    if (ridges?.length) occ = occlusionAlongRidge(P2, cut.dir, ridges, lows, o, cut.low);
    if (!occ) {
      geometry = "front_branch";
      const br = branch < 0 ? C.pts.slice(0, m + 1).reverse() : C.pts.slice(m);
      let end = br.length;
      for (let q = 1; q < br.length; q++) if (nearLow(br[q], lows, o.lowStopKm)) { end = q + 1; break; }
      occ = bendTo(br.slice(0, end).reverse(), false, P2).reverse();
      if (ridges?.length && end === br.length) occ = extendAlongRidge(occ, ridges, lows, o, cut.low);
    }
    // 4. Spiralig gegen den Uhrzeigersinn bis vor den Kern, Druck fallend.
    let spiralKm = 0;
    if (ctx?.msl && !cut.low.edge) {
      const before = occ.length;
      occ = spiralToLow(occ, cut.low, ctx.msl, g, o);
      if (occ.length > before) spiralKm = Math.round(lineLengthKm(occ.slice(before - 1)));
    }
    occ = smoothLine(occ, o.occSmoothKm, 2); // "wie Segel": keine Zacken

    // 5. Kaltfront und Okklusion als ein durchgehender Bogen (die Okklusion
    // setzt die Kaltfront ohne Knick fort, die Warmfront setzt mit Knick an).
    const coldIsA = props(A).front_type === "cold";
    const cold = coldIsA ? aPts : rest;
    // Der Okklusionsast stammt aus derselben Linie wie die Warmfront und setzt
    // daher sie fort statt der Kaltfront. Anfang neu führen: tangential aus
    // der Kaltfront heraus, über occBlendKm weich in den Keilverlauf.
    occ = continueFrom(cold, occ, o.occBlendKm);
    const J = cold.length - 1;
    const comp = smoothAround([...cold, ...occ.slice(1)], J, o.junctionSmoothKm);
    const coldNew = comp.slice(0, J + 1);
    occ = comp.slice(J);
    const Q = comp[J];
    if (coldIsA) { aPts = coldNew; rest = bendTo(rest, false, Q); }
    else { rest = coldNew; aPts = bendTo(aPts, false, Q); }
    const junction = { lat: +Q[0].toFixed(2), lon: +Q[1].toFixed(2) };

    // Zurückschreiben: A als ganzes Stück, der Rest stückweise über die
    // Kettenindizes (Punktzahl unverändert), Stücke auf der Okklusionsseite fallen weg.
    if (aAtStart) aPts.reverse();
    newPts.set(A, aPts); extra.set(A, { occlusion_point: junction });
    if (branch < 0) rest.reverse();
    for (const i of C.feats) {
      const [a, b] = range[i];
      const s0 = Math.max(a, r0), s1 = Math.min(b, r1);
      if (s1 - s0 < 1) { drop.add(i); continue; }
      newPts.set(i, rest.slice(s0 - r0, s1 - r0 + 1));
      if (s0 === m || s1 === m) extra.set(i, { occlusion_point: junction });
    }

    // Eigenschaften der Okklusion vom aktiven Stück am Okklusionspunkt.
    const near = [segOwner(C, m, branch), segOwner(C, m, -branch)];
    const src = near.find((i) => active(i)) ?? near[0];
    if (occ.length >= 2) {
      occFeatures.push(toFeature(src, occ, {
        front_type: "occluded",
        occlusion_character: props(src).front_type,
        occlusion_point: junction,
        occlusion_geometry: geometry,
        occlusion_spiral_km: spiralKm,
        occlusion_low: cut.low.edge ? "edge" : { lat: cut.low.lat, lon: cut.low.lon },
        activity_class: props(src).activity_class === "none" ? "weak" : props(src).activity_class,
        // Symbole: Seite wie das Stück, bei umgekehrter Punktreihenfolge gespiegelt.
        motion_side: flipIf(props(src).motion_side, branch < 0),
        warm_side: flipIf(props(src).warm_side, branch < 0),
      }));
    }
  }

  const out = [];
  features.forEach((f, i) => {
    if (drop.has(i)) return;
    out.push(newPts.has(i) ? toFeature(i, newPts.get(i), extra.get(i) || {}) : stripChain(f));
  });
  out.push(...occFeatures);
  features.forEach((f) => { delete f._chain; });
  return out;
}

// Okklusionspunkt zum stärksten 3-h-Druckfall entlang der Achse des
// Warmluftkeils verschieben (Druckfall unter der abgehobenen Warmluft;
// Kandidaten höchstens opRidgeKm von einer Rückenachse): Minimum von
// Tendenz + Abstandsmalus im Umkreis opSearchKm. Nur wenn der Fall dort
// deutlich stärker ist (opMinGain), sonst bleibt der Punkt. Ohne die
// Achsenbindung wanderte der Punkt am Ostsee-Tief in den Druckfall vor der
// Warmfront.
function refineJunction(P, tend, g, o, ridges, dir = null) {
  const t0 = sampleBilinear(tend, g, P[0], P[1]);
  if (!Number.isFinite(t0)) return P;
  let best = { score: t0, t: t0, p: P };
  const dLat = o.opSearchKm / KM_PER_DEG, dLon = o.opSearchKm / (KM_PER_DEG * Math.cos(P[0] * DEG));
  for (let j = 0; j < g.ny; j++) {
    const la = g.lat0 + j * g.res;
    if (Math.abs(la - P[0]) > dLat) continue;
    for (let i = 0; i < g.nx; i++) {
      const lo = g.lon0 + i * g.res;
      if (Math.abs(lo - P[1]) > dLon) continue;
      const d = distKm(P, [la, lo]);
      if (d > o.opSearchKm) continue;
      const t = tend[j * g.nx + i];
      if (!Number.isFinite(t)) continue;
      if (ridges?.length && !ridges.some((R) => R.some((p) => distKm(p, [la, lo]) <= o.opRidgeKm))) continue;
      // Nicht hinter den Okklusionsbeginn (vom Tief weg) wandern.
      if (dir && dotV(vecKm(P, [la, lo]), dir) < -o.opBackKm) continue;
      const score = t + (o.opDistPenalty * d) / 100;
      if (score < best.score) best = { score, t, p: [la, lo] };
    }
  }
  return t0 - best.t >= o.opMinGain ? best.p : P;
}

// Ab dem Okklusionsende in Schritten weiter: jeweils die kleinste
// Linksdrehung (gegen den Uhrzeigersinn), bei der der Bodendruck fällt und
// der Abstand zum Kern nicht wächst. So wickelt sich die Okklusion spiralig
// um den Kern, und der Druck nimmt entlang der Front zum Kern hin ab (K4).
function spiralToLow(occ, low, msl, g, o) {
  const L = [low.lat, low.lon];
  let E = occ[occ.length - 1];
  if (distKm(E, L) <= o.lowStopKm) return occ;
  let back = occ.length - 1, s = 0;
  while (back > 0 && s < 100) { s += distKm(occ[back - 1], occ[back]); back--; }
  let h = unitV(vecKm(occ[back], E));
  let pE = sampleBilinear(msl, g, E[0], E[1]);
  const ext = [];
  let len = 0, turned = 0;
  while (len < o.spiralMaxKm && turned < o.spiralMaxTurn && distKm(E, L) > o.lowStopKm) {
    let next = null;
    for (let a = 0; a <= o.spiralMaxStepTurn; a += 10) {
      const r = (a * Math.PI) / 180;
      const d = [h[0] * Math.cos(r) - h[1] * Math.sin(r), h[0] * Math.sin(r) + h[1] * Math.cos(r)];
      const Q = [E[0] + (o.spiralStepKm * d[1]) / KM_PER_DEG, E[1] + (o.spiralStepKm * d[0]) / (KM_PER_DEG * Math.cos(E[0] * DEG))];
      const pQ = sampleBilinear(msl, g, Q[0], Q[1]);
      if (!(pQ < pE - o.spiralMinDrop)) continue;
      // Echt einwärts (sonst kreist sie bei schwachem Druckfall um den Kern).
      if (distKm(Q, L) > distKm(E, L) - o.spiralInwardKm) continue;
      next = { Q, d, pQ, a };
      break;
    }
    if (!next) break;
    ext.push(next.Q);
    E = next.Q; h = next.d; pE = next.pQ;
    len += o.spiralStepKm; turned += next.a;
  }
  return ext.length ? [...occ, ...ext] : occ;
}

// Linie (Okklusionspunkt am Ende) am Punkt kürzen, der P am nächsten liegt,
// falls dieser näher als km ist und nicht schon das Ende ist. Die
// Punktzahl bleibt gleich: die abgeschnittenen Punkte fallen auf den
// Kürzungspunkt zusammen (für das Zurückschreiben über Kettenindizes).
function trimToward(pts, P, km) {
  let k = pts.length - 1, best = distKm(pts[k], P);
  for (let q = 0; q < pts.length; q++) { const d = distKm(pts[q], P); if (d < best) { best = d; k = q; } }
  if (k === pts.length - 1 || best > km) return pts;
  return pts.map((p, q) => (q > k ? pts[k] : p));
}

// Okklusion `occ` (beginnt am Okklusionspunkt = Ende von `cold`) so umformen,
// dass sie die Kaltfront ohne Knick fortsetzt: Punkte im Abstand s vom
// Okklusionspunkt werden zwischen der verlängerten Kaltfront-Tangente und dem
// ursprünglichen Verlauf gemischt (Smoothstep über blendKm).
function continueFrom(cold, occ, blendKm) {
  const P = cold[cold.length - 1];
  let back = cold.length - 1, s0 = 0;
  while (back > 0 && s0 < 150) { s0 += distKm(cold[back - 1], cold[back]); back--; }
  const t = unitV(vecKm(cold[back], P));
  if (!(Math.hypot(t[0], t[1]) > 0)) return occ;
  const out = [occ[0]];
  let s = 0;
  for (let q = 1; q < occ.length; q++) {
    s += distKm(occ[q - 1], occ[q]);
    if (s >= blendKm) { out.push(...occ.slice(q)); break; }
    const x = s / blendKm, w = x * x * (3 - 2 * x);
    const X = [P[0] + (s * t[1]) / KM_PER_DEG, P[1] + (s * t[0]) / (KM_PER_DEG * Math.cos(P[0] * DEG))];
    out.push([(1 - w) * X[0] + w * occ[q][0], (1 - w) * X[1] + w * occ[q][1]]);
  }
  return out;
}

// Laufendes Mittel entlang der Linie (Fenster ±km/2), Endpunkte fest.
function smoothLine(pts, km, passes = 1) {
  let cur = pts.map((p) => p.slice());
  for (let n = 0; n < passes; n++) {
    const s = [0];
    for (let q = 1; q < cur.length; q++) s.push(s[q - 1] + distKm(cur[q - 1], cur[q]));
    cur = cur.map((p, q) => {
      if (q === 0 || q === cur.length - 1) return p;
      let la = 0, lo = 0, c = 0;
      for (let r = 0; r < cur.length; r++) {
        if (Math.abs(s[r] - s[q]) <= km / 2) { la += cur[r][0]; lo += cur[r][1]; c++; }
      }
      return [la / c, lo / c];
    });
  }
  return cur;
}

// Glättung nur um den Index J (±windowKm), zum Rand hin ausgeblendet; die
// Punktzahl bleibt gleich, die Endpunkte bleiben fest.
function smoothAround(pts, J, windowKm) {
  const sm = smoothLine(pts, windowKm / 2, 3);
  const s = [0];
  for (let q = 1; q < pts.length; q++) s.push(s[q - 1] + distKm(pts[q - 1], pts[q]));
  return pts.map((p, q) => {
    const w = Math.max(0, 1 - Math.abs(s[q] - s[J]) / windowKm);
    return [p[0] + w * (sm[q][0] - p[0]), p[1] + w * (sm[q][1] - p[1])];
  });
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
// Punkte im letzten Abschnitt werden
// um einen mit der Nähe zum Ende wachsenden Anteil der Lücke verschoben
// (glatt, 0 -> 1), der Endpunkt landet genau auf P. Strecke vierfache
// Lückenlänge, mindestens 200 km -- kürzer gab sichtbare Ecken.
function bendTo(pts, atStart, P) {
  const line = atStart ? pts.slice().reverse() : pts.slice();
  const E = line[line.length - 1];
  const gap = distKm(E, P);
  if (gap < 1) return pts;
  const span = Math.max(200, 4 * gap);
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
function walkRidge({ R, r, dir }, from, t, lows, o, target = null) {
  const ext = [];
  // Nicht über das eigene Tief hinaus: endet, sobald sich die Achse wieder
  // deutlich vom Kern entfernt (Ostsee-Tief 12 UTC lief sie sonst nördlich
  // am Kern vorbei nach Westen). Ab dort übernimmt die Spirale.
  const T = target && !target.edge ? [target.lat, target.lon] : null;
  let minD = T ? distKm(from, T) : Infinity, minLen = 0;
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
    if (T) {
      const d = distKm(p, T);
      if (d < minD) { minD = d; minLen = ext.length; }
      else if (d > minD + o.passLowKm) { ext.length = minLen; break; }
    }
    if (nearLow(p, lows, o.lowStopKm)) break;
    if (!lows.some((l) => distKm(p, [l.lat, l.lon]) <= o.lowRangeKm)) break;
  }
  return ext;
}

// Okklusion ab ihrem Ende entlang der nächstgelegenen Rückenachse
// fortsetzen. Nur im Bereich eines Tiefs (lowRangeKm) -- ohne Zyklone keine
// Okklusion.
function extendAlongRidge(occ, ridges, lows, o, target = null) {
  const Q = occ[occ.length - 1];
  if (!lows.some((l) => distKm(Q, [l.lat, l.lon]) <= o.lowRangeKm)) return occ;
  let back = occ.length - 1, s = 0;
  while (back > 0 && s < 150) { s += distKm(occ[back - 1], occ[back]); back--; }
  const t = unitV(vecKm(occ[back], Q));
  const snap = snapRidge(Q, t, ridges, o);
  if (!snap) return occ;
  const ext = walkRidge(snap, Q, t, lows, o, target);
  return ext.length ? [...occ, ...ext] : occ;
}

// Okklusion ganz entlang der Achse: vom Okklusionspunkt P in Richtung t (vom
// Warmsektor weg) bis vor den Tiefkern. Der Anfang biegt weich in P ein.
// null, wenn keine Achse nah ist oder das Stück kürzer als ridgeMinKm wäre.
function occlusionAlongRidge(P, t, ridges, lows, o, target = null) {
  if (!lows.some((l) => distKm(P, [l.lat, l.lon]) <= o.lowRangeKm)) return null;
  const snap = snapRidge(P, t, ridges, o);
  if (!snap) return null;
  const ext = walkRidge(snap, P, t, lows, o, target);
  if (ext.length < 2 || lineLengthKm(ext) < o.ridgeMinKm) return null;
  return bendTo(ext, true, P);
}

function flipIf(side, cond) {
  if (!side || !cond) return side;
  return side === "left" ? "right" : "left";
}
