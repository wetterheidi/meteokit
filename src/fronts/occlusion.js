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

import { gaussianSmooth, gradient, chainSegments, sampleBilinear, distKm, lineLengthKm, smoothAlong } from "./grid.js";

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
  // Treffpunkt so nah an einem Tiefkern: offenes Tief (Warm- und Kaltfront
  // treffen sich im Kern), kein Okklusionspunkt. Sonst griff der Punkt am
  // Russlandtief (10.10. 06 UTC, mit ICON Global im Gebiet) das 1400 km
  // entfernte Skagerraktief und verdrängte dessen Okklusion. Größer geht
  // nicht: der Okklusionspunkt am Skagerraktief (10.10. 03 UTC) liegt nur
  // rund 270 km vom Kern, 250 km verwarf ihn schon.
  coreSkipKm: 150,
  // Längere Okklusionen entfallen (die Kette bleibt, wie sie war). Am
  // Russlandtief (10.10. 03 UTC, Treffpunkt 230 km vom Kern) wurde die
  // Kaltfront sonst zu einer 3900 km langen Okklusion bis zum Schwarzen Meer;
  // längste echte Okklusion der Fälle: Island 09.10. 12 UTC, 1780 km.
  occMaxKm: 2500,
  edgeLowDrop: 8,       // hPa Druckfall bis zum Gebietsrand für ein Randtief
  edgeKm: 150,          // Minimum so nah am Gebietsrand -> Randtief
  // Okklusionspunkt zum stärksten 3-h-Druckfall entlang der Achse des
  // Warmluftkeils (K1: Zentrum des isallobarischen Tiefs; so orientiert sich
  // auch die synoptische Referenzanalyse 2026-10-09 12 UTC)
  // Standardmäßig AUS: mit 90 km Glättung liegt der geometrisch bestimmte
  // Punkt schon am stärksten Druckfall (Island 12 UTC 57/5,4 ≈ Minimum der
  // Tendenz 57,5/5), die Verschiebung zog den Ostsee-Punkt dagegen um
  // 250 km von der Referenzanalyse weg.
  opRefine: false,
  opSearchKm: 300,
  opRidgeKm: 100,       // Kandidaten so nah an der Achse, der die Okklusion folgt
  opTrimKm: 150,        // liegt der neue Punkt so nah an einer Front, wird sie dort gekürzt
  opBackKm: 30,         // höchstens so weit entgegen der Okklusionsrichtung
  cornerOpKm: 350,      // Ecke der Restfront so nah am Punkt -> Punkt dorthin
  cornerOpDeg: 60,
  opDistPenalty: 0.15,  // hPa/3 h je 100 km Verschiebung
  opMinGain: 0.3,       // hPa/3 h: nur bei deutlich stärkerem Fall verschieben
  // Okklusionspunkt entlang der Okklusion zum stärksten 3-h-Druckfall
  // vorschieben (Projektleitung: Punkt nach dem stärksten Druckfall, liegt
  // so auch eher im stärksten Niederschlag). Kaltfront und Warmfront reichen
  // bis zum neuen Punkt. Abzug opDistPenalty je 100 km, mindestens opMinGain.
  opFall: true,
  opFallKm: 400,
  // … nur, solange der Weg die Richtung der Kaltfront hält (die Okklusion
  // setzt sie ohne Knick fort). Am Russlandtief (10.10. 09 UTC) bog die
  // Okklusion hinter dem Punkt scharf ab, die Kaltfront wurde mitgezogen.
  opFallTurnDeg: 30,
  // Spirale um den Kern (gegen den Uhrzeigersinn, Druck fallend)
  spiralStepKm: 50,
  spiralMinDrop: 0.05,  // hPa je Schritt
  spiralMaxKm: 1500,
  passLowKm: 50,        // Achse verlassen, sobald sie sich so weit wieder vom Kern entfernt
  spiralMaxTurn: 200,   // Grad, höchstens so weit um den Kern
  // je Schritt mindestens so viel näher an den Kern. 8 km ließ die Spirale am
  // Barentssee-Tief (06.10. 18 UTC) bis zur Höchstlänge in 330 km Abstand
  // kreisen; die Handanalyse zieht ab 500 km stetig in den Kern.
  spiralInwardKm: 25,
  // Unter den zulässigen Richtungen die mit dem meisten Niederschlag (die
  // Okklusion fängt die Niederschläge am Kern ein, Projektleitung), je 10°
  // Drehung spiralTurnPen mm/h Abzug; aus: die geradeste.
  spiralPrecip: false,
  spiralTurnPen: 0.02,
  spiralMaxStepTurn: 60, // Grad je Schritt -- enger wird es zur Zacke
  // Glättung ("Fronten spannen sich wie Segel")
  occSmoothKm: 150,     // Okklusion insgesamt
  junctionSmoothKm: 400, // gemeinsame Glättung Kaltfront + Okklusion um den (festen) Punkt
  opSlideKm: 150,       // Okklusionspunkt bis so weit entlang der Kaltfront zurücklegen …
  opSlideLookKm: 200,   // … gemessen am Knick zwischen Kaltfront und Richtung zum Okklusionsverlauf in diesem Abstand
  opSlidePen: 10,       // Grad je 100 km Zurücklegen (bei gleichem Knick lieber nah am TFP-Punkt)
  occBlendKm: 150,      // Okklusion verlässt den Punkt in Kaltfrontrichtung, Übergang über diese Länge (länger: schießt hinaus)
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

/**
 * Zentraltiefs: Achse vom Bodentief zum 500-hPa-Tief annähernd senkrecht.
 * Junge Tiefs sind stromaufwärts geneigt, Zentraltiefs stehen senkrecht,
 * sterbende Tiefs kurz stromabwärts geneigt (Projektleitung 2026-10-11).
 * Z500 ≈ Z1000 + Schichtdicke 500/1000, Z1000 ≈ 8 m/hPa · (MSLP − 1000).
 * Liegt das Z500-Minimum im Umkreis searchKm höchstens tiltKm vom Bodentief
 * und ist das Tief mindestens depthMin tief (gegen den 500-km-Ring), bekommt
 * es `central: true`; `tilt_km` ist der Abstand (null ohne geschlossenes
 * Höhentief, d. h. Minimum am Rand des Suchkreises). Die Tiefe trennt junge
 * Tiefs unter einem abgeschnürten Höhentief ab (Genuatief 09.10. 12 UTC:
 * Achse 69 km, aber flach).
 */
export function markCentralLows(lows, field, g, { tiltKm = 150, searchKm = 700, depthMin = 8 } = {}) {
  if (!field.thickness || !field.sfc?.pressure_msl) return lows;
  const z = gaussianSmooth(Float32Array.from(field.sfc.pressure_msl, (p, k) => 8 * (p - 1000) + field.thickness[k]), g, 100);
  return lows.map((l) => {
    let best = null;
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      const p = [g.lat0 + j * g.res, g.lon0 + i * g.res];
      const d = distKm(p, [l.lat, l.lon]);
      if (d > searchKm) continue;
      const v = z[j * g.nx + i];
      if (Number.isFinite(v) && (!best || v < best.v)) best = { v, d };
    }
    const closed = best && best.d < searchKm - 2 * g.res * KM_PER_DEG;
    return { ...l, tilt_km: closed ? Math.round(best.d) : null, central: !!closed && best.d <= tiltKm && l.depth >= depthMin };
  });
}

/**
 * Randtiefs (Wellen) ohne geschlossene Isobare: lokale Minima der 3-h-
 * Drucktendenz (60 km geglättet) bis höchstens tendMax mit zyklonalem
 * Wirbel in 850 hPa (100 km geglättet) ab vortMin. Randtief vor der
 * norwegischen Küste 05.10. 12 UTC (Projektleitung): −5,8 hPa/3 h,
 * 6,8·10⁻⁵ s⁻¹. Dienen nur als Anker der Anschlussregel (`wave: true`).
 */
export function findWaveLows(field, prev, g, { tendMax = -3, vortMin = 5 } = {}) {
  if (!prev?.sfc?.pressure_msl || !field.sfc?.pressure_msl) return [];
  const tend = gaussianSmooth(Float32Array.from(field.sfc.pressure_msl, (v, k) => v - prev.sfc.pressure_msl[k]), g, 60);
  const u = gaussianSmooth(field.u, g, 100), v = gaussianSmooth(field.v, g, 100);
  const out = [];
  for (let j = 2; j < g.ny - 2; j++) for (let i = 2; i < g.nx - 2; i++) {
    const k = j * g.nx + i, t = tend[k];
    if (!(t <= tendMax)) continue;
    const la = g.lat0 + j * g.res, c = Math.cos(la * DEG), dx = g.res * KM_PER_DEG * 1e3 * c, dy = g.res * KM_PER_DEG * 1e3;
    const vort = ((v[k + 1] - v[k - 1]) / (2 * dx) - (u[k + g.nx] - u[k - g.nx]) / (2 * dy)) * 1e5;
    if (!(vort >= vortMin)) continue;
    let isMin = true;
    for (let a = -2; a <= 2 && isMin; a++) for (let b = -2; b <= 2; b++) { const kk = k + a * g.nx + b; if (kk !== k && tend[kk] < t) { isMin = false; break; } }
    if (isMin) out.push({ lat: la, lon: g.lon0 + i * g.res, tendency: +t.toFixed(1), vorticity: +vort.toFixed(1), wave: true });
  }
  return out;
}

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
      if (lows.some((l) => distKm(P, [l.lat, l.lon]) <= o.coreSkipKm)) continue;
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

  const dedup = (pts) => pts.filter((p, q) => q === 0 || distKm(p, pts[q - 1]) > 0.5);
  const toFeature = (i, pts0, extra = {}) => { const pts = dedup(pts0); return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: pts.map(([la, lo]) => [+lo.toFixed(3), +la.toFixed(3)]) },
    properties: { ...props(i), length_km: Math.round(lineLengthKm(pts)), ...extra },
  }; };
  const ptsOf = (i) => chainOf(i).pts.slice(range[i][0], range[i][1] + 1);

  // Geometrie an jedem Okklusionspunkt neu aufbauen. Überschriebene Punkte
  // je Stück (newPts), weggefallene Stücke (drop), Zusatzattribute (extra).
  const newPts = new Map(), drop = new Set(), extra = new Map(), occFeatures = [];
  for (const cut of applied) {
    const C = cut.chain, branch = cut.branch, last = C.pts.length - 1;
    // Ecke der Restlinie nahe am Punkt: dort beginnt die eigentliche Front,
    // der Okklusionspunkt rückt dorthin (Ostsee-Tief 12 UTC: die Warmfront
    // lief vom Punkt erst 190 km nach Norden und knickte dann nach Osten).
    const m = cornerNear(C.pts, cut.idx, -branch, o);
    if (m !== cut.idx) cut.P = C.pts[m];
    // 1. Okklusionspunkt zum stärksten Druckfall (isallobarisches Tief, K1).
    // Nur entlang der Achse, der auch die Okklusion folgt -- sonst springt der
    // Punkt auf die Achse des Warmsektors (Ostsee-Tief 12 UTC).
    const occRidge = ridges?.length ? snapRidge(cut.P, cut.dir, ridges, o) : null;
    const P2 = o.opRefine && ctx?.tend && occRidge ? refineJunction(cut.P, ctx.tend, g, o, [occRidge.R], cut.dir) : cut.P;

    // 2. Zuführende Front A und Rest der Kette, beide mit dem Punkt am Ende.
    const A = cut.from;
    const aAtStart = cut.endIdx === range[A][0];
    let aPts = ptsOf(A); if (aAtStart) aPts.reverse();
    const [r0, r1] = branch < 0 ? [m, last] : [0, m];
    let rest = C.pts.slice(r0, r1 + 1); if (branch < 0) rest.reverse();
    // Liegt der neue Punkt nahe an einer der beiden Linien, wird sie dort
    // gekürzt statt zurückgebogen (sonst entsteht ein Haken).
    const coldIsA = props(A).front_type === "cold";
    // Die Kaltfront wird weich in den Punkt gebogen (sie läuft in die
    // Okklusion weiter). Die andere Front darf abknicken: sie wird am
    // nächstgelegenen Punkt gekürzt und mit einem kurzen Bogen angeschlossen
    // -- Biegen zog sonst ihren ganzen Anfang mit (Ostsee-Warmfront 12 UTC
    // lief erst 190 km nach Norden).
    if (coldIsA) { aPts = bendTo(trimToward(aPts, P2, o.opTrimKm), false, P2); rest = attach(rest, P2); }
    else { rest = bendTo(trimToward(rest, P2, o.opTrimKm), false, P2); aPts = attach(aPts, P2); }

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
      occ = spiralToLow(occ, cut.low, ctx.msl, g, o, ctx.precip);
      if (occ.length > before) spiralKm = Math.round(lineLengthKm(occ.slice(before - 1)));
    }
    occ = smoothLine(occ, o.occSmoothKm, 2); // "wie Segel": keine Zacken
    if (lineLengthKm(occ) > o.occMaxKm) continue;

    // 5. Kaltfront und Okklusion als ein durchgehender Bogen (die Okklusion
    // setzt die Kaltfront ohne Knick fort, die Warmfront setzt mit Knick an).
    let cold = coldIsA ? aPts : rest;
    // Okklusionspunkt entlang der Kaltfront dorthin, wo die Okklusion sie
    // ohne Knick fortsetzt (Handanalyse 09.10. 12 UTC: der Punkt lag 100 km
    // weiter zurück auf der Kaltfront, die Okklusion lief von dort fast
    // gerade weiter; vom automatischen Punkt aus knickte sie um 70°).
    let slidKm = 0;
    if (o.opSlideKm > 0) ({ cold, occ, slidKm } = slideAlongCold(cold, occ, o));
    let fallKm = 0;
    // Nur wenn die Kaltfront als ganzes Stück zurückgeschrieben wird (A):
    // in der Restkette verschob das Neuverteilen der Punkte die Stückgrenzen,
    // ein Stück mit anderer Symbolseite lag dann auf der Verlängerung
    // (Russlandtief 10.10. 09 UTC).
    if (o.opFall && ctx?.tend && coldIsA) ({ cold, occ, fallKm } = advanceToFall(cold, occ, ctx.tend, g, o));
    // Der Okklusionsast stammt aus derselben Linie wie die Warmfront und setzt
    // daher sie fort statt der Kaltfront. Anfang neu führen: tangential aus
    // der Kaltfront heraus, über occBlendKm weich in den Keilverlauf.
    // Die Drehung zwischen Kaltfront und Okklusion auf beide verteilen
    // (gemeinsame Glättung um den Punkt), den Punkt dabei aber festhalten:
    // eine freie Glättung zog ihn in die Innenseite des Winkels (Ostsee-Tief
    // 12 UTC um 250 km), und die Warmfront musste mit Haken nachgezogen werden.
    // Okklusion gleichmäßig verdichten, in der Punktdichte der Kaltfront:
    // Beide Schritte unten arbeiten punktweise, und die Okklusion hatte
    // teils doppelte Punkte und Lücken bis 180 km. Dann griff der tangentiale
    // Start kaum, und die gemeinsame Glättung (Mittel nach Punktzahl) zog die
    // ersten Okklusionspunkte an den Punkt, gefolgt von einem Sprung: ein
    // Knick von 87° zwischen Kaltfront und Okklusion (Ostsee-Tief 12 UTC).
    occ = densify(occ, spacingNear(cold, 300));
    occ = continueFrom(cold, occ, o.occBlendKm);
    const J = cold.length - 1;
    const comp = smoothAroundFixed([...cold, ...occ.slice(1)], J, o.junctionSmoothKm);
    const coldNew = comp.slice(0, J + 1);
    occ = comp.slice(J);
    const Q = comp[J];
    if (coldIsA) { aPts = coldNew; rest = attach(rest, Q); }
    else { rest = coldNew; aPts = attach(aPts, Q); }
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
        occlusion_slide_km: slidKm,
        occlusion_fall_km: fallKm,
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
function spiralToLow(occ, low, msl, g, o, precip = null) {
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
      if (!(o.spiralPrecip && precip)) { next = { Q, d, pQ, a }; break; }
      const score = (sampleBilinear(precip, g, Q[0], Q[1]) || 0) - (o.spiralTurnPen * a) / 10;
      if (!next || score > next.score) next = { Q, d, pQ, a, score };
    }
    if (!next) break;
    ext.push(next.Q);
    E = next.Q; h = next.d; pE = next.pQ;
    len += o.spiralStepKm; turned += next.a;
  }
  return ext.length ? [...occ, ...ext] : occ;
}

// Auf der Kette ab Index m in Richtung dir (zur Restfront hin) innerhalb von
// cornerOpKm die schärfste Ecke suchen (Richtungsänderung zwischen Sehnen
// ±100 km). Ist sie schärfer als cornerOpDeg, wird ihr Index zurückgegeben,
// sonst m.
function cornerNear(pts, m, dir, o) {
  const v = (a, b) => [(b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180), b[0] - a[0]];
  const along = (from, km, st) => { let q = from, s = 0; while (q + st >= 0 && q + st < pts.length && s < km) { s += distKm(pts[q], pts[q + st]); q += st; } return q; };
  let best = { a: o.cornerOpDeg, q: m }, s = 0;
  for (let q = m; q >= 0 && q < pts.length && s <= o.cornerOpKm; q += dir) {
    if (q !== m) s += distKm(pts[q - dir], pts[q]);
    const a0 = along(q, 100, -dir), b0 = along(q, 100, dir);
    if (a0 === q || b0 === q) continue;
    const u = v(pts[a0], pts[q]), w = v(pts[q], pts[b0]);
    const c = (u[0] * w[0] + u[1] * w[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(w[0], w[1]));
    const ang = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
    if (ang > best.a) best = { a: ang, q };
  }
  return best.q;
}

// Linie (Anschlusspunkt am Ende) an P anschließen, ohne ihren Verlauf zu
// verschieben: am P nächstgelegenen Punkt k kürzen und von dort einen
// kubischen Bogen nach P legen (verlässt k in Linienrichtung). Die Punktzahl
// bleibt gleich (die Punkte nach k werden zum Bogen), damit das
// Zurückschreiben über Kettenindizes funktioniert.
function attach(pts, P) {
  const n = pts.length;
  let k = n - 1, best = distKm(pts[k], P);
  for (let q = 0; q < n; q++) { const d = distKm(pts[q], P); if (d < best) { best = d; k = q; } }
  if (best < 20 || n - 1 - k < 1) { const out = pts.slice(); out[n - 1] = P; return out; }
  // Anschlusspunkt: nicht einfach der nächste, sondern der, von dem aus die
  // Linie schon ungefähr auf P zeigt (Winkel + Abstandsstrafe, bis 300 km).
  // Sonst verlässt der Bogen die Linie in ihrer alten Richtung und kehrt
  // mit einem Haken zurück (Ostsee-Warmfront, nachdem der Okklusionspunkt
  // entlang der Kaltfront zurückgelegt wurde).
  let cost = Infinity;
  for (let q = 1; q < n - 1; q++) {
    const d = distKm(pts[q], P);
    if (d < 20 || d > 300) continue;
    const t = unitV(vecKm(pts[Math.max(0, q - 3)], pts[q]));
    const ang = (Math.acos(Math.max(-1, Math.min(1, dotV(t, unitV(vecKm(pts[q], P)))))) * 180) / Math.PI;
    const c = ang + (10 * d) / 100;
    if (c < cost) { cost = c; k = q; }
  }
  const tail = n - 1 - k;
  if (tail < 1) { const out = pts.slice(); out[n - 1] = P; return out; }
  const A = pts[k];
  const tA = k > 0 ? unitV(vecKm(pts[Math.max(0, k - 3)], A)) : unitV(vecKm(A, P));
  const tB = unitV(vecKm(P, A));
  const L = distKm(A, P), c = L / 3;
  const off = (p, t, s) => [p[0] + (s * t[1]) / KM_PER_DEG, p[1] + (s * t[0]) / (KM_PER_DEG * Math.cos(p[0] * DEG))];
  const c1 = off(A, tA, c), c2 = off(P, tB, c);
  const out = pts.slice(0, k + 1);
  for (let i = 1; i <= tail; i++) {
    const t = i / tail, u = 1 - t;
    out.push([0, 1].map((d) => u * u * u * A[d] + 3 * u * u * t * c1[d] + 3 * u * t * t * c2[d] + t * t * t * P[d]));
  }
  return out;
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
// Okklusionspunkt entlang der Kaltfront (Punkt am Ende) zurücklegen, bis
// höchstens opSlideKm. Kosten je Kandidat Q: Winkel zwischen der Richtung
// der Kaltfront in Q (über 150 km) und der Richtung von Q zum ersten
// Okklusionspunkt im Abstand >= opSlideLookKm, plus opSlidePen je 100 km.
// Die Kaltfront endet dann in Q (Punktzahl bleibt: die übrigen Punkte
// rücken auf Q), die Okklusion beginnt in Q und läuft auf ihren Verlauf ab
// diesem Punkt zu.
// Okklusionspunkt entlang der Okklusion (bis opFallKm) zum stärksten
// 3-h-Druckfall vorschieben; die Kaltfront läuft dafür auf dem bisherigen
// Okklusionsweg bis zum neuen Punkt weiter (kein Knick).
function advanceToFall(cold, occ, tend, g, o) {
  const t0 = sampleBilinear(tend, g, occ[0][0], occ[0][1]);
  if (!Number.isFinite(t0)) return { cold, occ, fallKm: 0 };
  let best = { q: 0, score: t0, t: t0, s: 0 }, s = 0;
  // Richtung der Kaltfront an ihrem Ende (über ~100 km).
  let b = cold.length - 1, sb = 0;
  while (b > 0 && sb < 100) { sb += distKm(cold[b - 1], cold[b]); b--; }
  const dc = unitV(vecKm(cold[b], cold[cold.length - 1]));
  const cosMax = Math.cos((o.opFallTurnDeg * Math.PI) / 180);
  for (let q = 1; q < occ.length - 2; q++) {
    s += distKm(occ[q - 1], occ[q]);
    if (s > o.opFallKm) break;
    // örtliche Richtung der Okklusion (Sehne über die letzten ~50 km)
    let a = q, sa = 0;
    while (a > 0 && sa < 50) { sa += distKm(occ[a - 1], occ[a]); a--; }
    if (a < q && dotV(unitV(vecKm(occ[a], occ[q])), dc) < cosMax) break;
    const t = sampleBilinear(tend, g, occ[q][0], occ[q][1]);
    if (!Number.isFinite(t)) continue;
    const score = t + (o.opDistPenalty * s) / 100;
    if (score < best.score) best = { q, score, t, s };
  }
  if (!best.q || t0 - best.t < o.opMinGain) return { cold, occ, fallKm: 0 };
  return { cold: [...cold, ...occ.slice(1, best.q + 1)], occ: occ.slice(best.q), fallKm: Math.round(best.s) };
}

function slideAlongCold(cold, occ, o) {
  const n = cold.length, s = [0];
  for (let q = n - 1; q > 0; q--) s.push(s[s.length - 1] + distKm(cold[q - 1], cold[q]));
  // s[k]: Abstand des Punkts n-1-k vom Ende
  const at = (b) => { // Punkt im Abstand b vom Ende, Index des nächsten Punkts davor
    for (let k = 1; k < s.length; k++) {
      if (s[k] >= b) {
        const f = (b - s[k - 1]) / (s[k] - s[k - 1] || 1), A = cold[n - k], B = cold[n - 1 - k];
        return { Q: [A[0] + f * (B[0] - A[0]), A[1] + f * (B[1] - A[1])], i: n - 1 - k };
      }
    }
    return null;
  };
  let best = null;
  for (let b = 0; b <= o.opSlideKm; b += 25) {
    const c = at(b);
    if (!c) break;
    const { Q, i } = c;
    let back = i, sb = distKm(cold[i], Q);
    while (back > 0 && sb < 150) { sb += distKm(cold[back - 1], cold[back]); back--; }
    const t = unitV(vecKm(cold[back], Q));
    const R = occ.find((p) => distKm(p, Q) >= o.opSlideLookKm);
    if (!R || !(Math.hypot(t[0], t[1]) > 0)) continue;
    const kink = (Math.acos(Math.max(-1, Math.min(1, dotV(t, unitV(vecKm(Q, R)))))) * 180) / Math.PI;
    const cost = kink + (o.opSlidePen * b) / 100;
    if (!best || cost < best.cost) best = { cost, b, Q, i, R };
  }
  if (!best || best.b === 0) return { cold, occ, slidKm: 0 };
  const newCold = cold.map((p, q) => (q <= best.i ? p : best.Q));
  const r = occ.indexOf(best.R);
  return { cold: newCold, occ: [best.Q, ...occ.slice(r)], slidKm: best.b };
}

// Mittlerer Punktabstand der letzten `km` einer Linie (zum Ende hin),
// begrenzt auf 15..60 km.
function spacingNear(pts, km) {
  let s = 0, n = 0;
  for (let q = pts.length - 1; q > 0 && s < km; q--, n++) s += distKm(pts[q - 1], pts[q]);
  return Math.min(60, Math.max(15, n ? s / n : 30));
}

// Linie mit gleichmäßigem Punktabstand ~stepKm (doppelte Punkte fallen weg).
function densify(pts, stepKm) {
  const out = [pts[0]];
  for (let q = 1; q < pts.length; q++) {
    const a = pts[q - 1], b = pts[q], d = distKm(a, b);
    if (d < 1e-3) continue;
    const n = Math.max(1, Math.round(d / stepKm));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

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

// Glättung um den Index J (±windowKm, zum Rand hin ausgeblendet), wobei der
// Punkt J an seiner Stelle bleibt: die geglättete Kurve wird um die
// Verschiebung von J zurückgesetzt, mit demselben Gewicht. Punktzahl und
// Endpunkte bleiben gleich.
function smoothAroundFixed(pts, J, windowKm) {
  const sm = smoothLine(pts, windowKm / 2, 3);
  const s = [0];
  for (let q = 1; q < pts.length; q++) s.push(s[q - 1] + distKm(pts[q - 1], pts[q]));
  const d = [pts[J][0] - sm[J][0], pts[J][1] - sm[J][1]];
  return pts.map((p, q) => {
    const w = Math.max(0, 1 - Math.abs(s[q] - s[J]) / windowKm);
    return [p[0] + w * (sm[q][0] + d[0] - p[0]), p[1] + w * (sm[q][1] + d[1] - p[1])];
  });
}

// Laufendes Mittel entlang der Linie (Fenster ±km/2), Endpunkte fest.
const smoothLine = (pts, km, passes = 1) => smoothAlong(pts, km, passes);


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
