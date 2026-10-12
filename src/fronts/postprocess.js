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
  overlapKm: 200,       // seitlich versetzte, parallele Enden bis zu diesem Abstand vorher kürzen
  smoothKm: 150,        // abschließende Glättung aller Fronten
  smoothPasses: 2,
  occPrecip: true,      // Okklusion zum Niederschlagsmaximum quer zur Linie rücken
  occPrecipKm: 60,      // … höchstens so weit
  occPrecipMin: 0.2,    // mm/h: nur wo dort so viel fällt
  coreJunction: true,   // offenes Tief: Übergang Warm-/Kaltfront in den Tiefkern legen
  coreKm: 300,          // … wenn der Übergang höchstens so weit vom Kern liegt
  lowLink: true,        // jede Front hängt (über ihr Frontsystem) an einem Tiefkern
  lowKm: 300,           // so nah muss eine Front des Systems am Tiefkern liegen
  linkKm: 150,          // Fronten gelten als verbunden, wenn ein Ende so nah an der anderen liegt
  // Brücken: Stücke ohne Wetter, aber mit deutlichem Kontrast, verbinden eine
  // aktive Front mit einem Tief (dieselbe Zyklonenfamilie; Welle 06.10. 18 UTC
  // über der Nordsee). Sie werden schwach mit bridge: true.
  bridges: true,
  bridgeContrastMin: 4, // K, Mittel über das Stück
  // Doppellinien: eine Front, die fast ganz auf einer stärkeren liegt, entfällt
  // (mit ICON Global im Gebiet lief eine schwache Warmfront 20 km neben der
  // Islandokklusion, 09.10. 12 UTC).
  dupKm: 100,
  dupShare: 0.7,
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
const flipSide = (s) => (s === "left" ? "right" : s === "right" ? "left" : s);

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
            // A so ausgerichtet, dass die Lücke an seinem Ende liegt, B an seinem Anfang.
            let aP = ea ? A.pts : A.pts.slice().reverse(), bP = eb ? B.pts.slice().reverse() : B.pts;
            const d0 = distKm(aP[aP.length - 1], bP[0]);
            if (d0 < 1 || d0 > o.gapKm) continue;
            // Seitlich versetzte, parallel laufende Enden (Genua-Kaltfront 09.10.
            // 12 UTC: das nördliche Stück begann neben dem Ende des südlichen):
            // die überlappenden Enden kürzen, bis B vor A liegt.
            const tA0 = outward(aP, true), tB0 = outward(bP, false);
            if (d0 <= o.overlapKm && dotV(tA0, [-tB0[0], -tB0[1]]) >= o.gapAlignMin) {
              // so weit, dass die Lücke überwiegend in Laufrichtung liegt
              // (Vorlauf mindestens so groß wie der seitliche Versatz)
              const gap = () => { const v = vecKm(aP[aP.length - 1], bP[0]); return { ahead: dotV(v, tA0), side: Math.abs(v[0] * tA0[1] - v[1] * tA0[0]) }; };
              const short = () => { const x = gap(); return x.ahead < x.side; };
              while (short() && (aP.length > 2 || bP.length > 2)) {
                if (aP.length > 2) aP = aP.slice(0, -1);
                if (short() && bP.length > 2) bP = bP.slice(1);
              }
            }
            const pa = aP[aP.length - 1], pb = bP[0];
            const d = distKm(pa, pb);
            if (d < 1 || d > o.gapKm || (best && d >= best.d)) continue;
            const tA = outward(aP, true), tB = outward(bP, false), ab = unitV(vecKm(pa, pb));
            if (dotV(tA, ab) < o.gapAlignMin || dotV(tB, [-ab[0], -ab[1]]) < o.gapAlignMin) continue;
            // Niederschlag entlang der Verbindung (Maximum der Stichproben).
            let rr = 0;
            for (let s = 0.1; s < 1; s += 0.1) rr = Math.max(rr, sampleBilinear(af.precip, g, pa[0] + s * (pb[0] - pa[0]), pa[1] + s * (pb[1] - pa[1])) || 0);
            if (rr < o.gapPrecipMin) continue;
            // Warme Luft auf derselben Seite (in der Laufrichtung der
            // Verbindung): sonst entstand eine Front mit teils vertauschten
            // Symbolen (09.10. 12 UTC östlich Goose Bay, Glättung 120 km).
            const sideA = ea ? A.f.properties.warm_side : flipSide(A.f.properties.warm_side);
            const sideB = eb ? flipSide(B.f.properties.warm_side) : B.f.properties.warm_side;
            if (sideA && sideB && sideA !== sideB) continue;
            best = { a, b, ea, eb, d, tA, tB, pa, pb, aP, bP };
          }
        }
      }
    }
    if (!best) break;
    const A = items[best.a], B = items[best.b];
    const aPts = best.aP, bPts = best.bP;
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

/**
 * Doppellinien entfernen: Liegt eine Front zu mindestens dupShare ihrer
 * Punkte höchstens dupKm neben einer anderen, entfällt die schwächere
 * (Rang: Okklusion vor aktiv vor schwach, bei Gleichstand die kürzere).
 * Sie wird zu "none" mit `duplicate: true`.
 */
export function dropDuplicates(features, opts = {}) {
  const o = { ...POSTPROCESS_DEFAULTS, ...opts };
  if (!(o.dupKm > 0)) return features;
  const pts = features.map((f) => f.geometry.coordinates.map(([lo, la]) => [la, lo]));
  const live = features.map((f) => f.properties.activity_class !== "none");
  const rank = (f) => (f.properties.front_type === "occluded" ? 3 : f.properties.activity_class === "active" ? 2 : 1);
  const len = pts.map((l) => lineLengthKm(l));
  const dropped = new Set();
  for (let a = 0; a < features.length; a++) {
    if (!live[a]) continue;
    for (let b = 0; b < features.length; b++) {
      if (a === b || !live[b] || dropped.has(b)) continue;
      if (rank(features[a]) > rank(features[b]) || (rank(features[a]) === rank(features[b]) && len[a] >= len[b])) continue;
      const share = pts[a].filter((p) => pts[b].some((q) => distKm(p, q) <= o.dupKm)).length / pts[a].length;
      if (share >= o.dupShare) { dropped.add(a); break; }
    }
  }
  return features.map((f, i) => (dropped.has(i) ? { ...f, properties: { ...f.properties, activity_class: "none", duplicate: true } } : f));
}

/**
 * Jede Front hängt an einem analysierten Tiefkern, direkt oder über ihr
 * Frontsystem (bei teilokkludierten Tiefs über die Okklusion). Fronten sind
 * verbunden, wenn ein Ende höchstens linkKm von der anderen Linie entfernt
 * liegt. Ein System ist angeschlossen, wenn eine seiner Fronten näher als
 * lowKm an einem Tiefkern liegt oder seine Okklusion zu einem Randtief
 * jenseits des Gebiets führt (occlusion_low "edge"). Betrachtet werden nur
 * Fronten mit Wetter (activity_class nicht "none"); Systeme ohne Anschluss
 * werden zu "none" mit `unlinked: true`.
 *
 * Brücken (bridges): Erreicht ein System mit einer aktiven Front den
 * Anschluss nur über Stücke ohne Wetter, die im Mittel mindestens
 * bridgeContrastMin Kontrast haben (eine Folge solcher Stücke, Enden je
 * höchstens linkKm auseinander), werden diese Stücke schwach mit
 * `bridge: true` (frontolytisch, gehören zur selben Zyklonenfamilie).
 */
export function requireLowLink(features, lows, opts = {}) {
  const o = { ...POSTPROCESS_DEFAULTS, ...opts };
  if (!o.lowLink) return features;
  const pts = features.map((f) => f.geometry.coordinates.map(([lo, la]) => [la, lo]));
  const live = features.map((f) => f.properties.activity_class !== "none");
  const n = features.length;
  const near = (p, line, km) => line.some((q) => distKm(p, q) <= km);
  const touch = (a, b) => {
    const A = pts[a], B = pts[b];
    return [A[0], A[A.length - 1]].some((p) => near(p, B, o.linkKm)) || [B[0], B[B.length - 1]].some((p) => near(p, A, o.linkKm));
  };
  const atLow = (i) => {
    const pr = features[i].properties;
    return lows.some((l) => near([l.lat, l.lon], pts[i], o.lowKm)) || pr.occlusion_low === "edge" || (pr.occlusion_low && typeof pr.occlusion_low === "object");
  };
  // Zusammenhangskomponenten (Union-Find) der Fronten mit Wetter.
  const parent = features.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let a = 0; a < n; a++) {
    if (!live[a]) continue;
    for (let b = a + 1; b < n; b++) if (live[b] && touch(a, b)) parent[find(a)] = find(b);
  }
  const anchored = new Set();
  for (let i = 0; i < n; i++) if (live[i] && atLow(i)) anchored.add(find(i));

  // Brücken: Breitensuche von jedem nicht angeschlossenen System mit aktiver
  // Front über Brückenkandidaten bis zu einem angeschlossenen System oder
  // einem Tiefkern.
  const bridged = new Set();
  if (o.bridges) {
    const cand = features.map((f, i) => {
      const pr = f.properties;
      return !live[i] && !pr.unlinked && !pr.duplicate && ["cold", "warm", "stationary"].includes(pr.front_type)
        && pr.criteria?.contrast_k >= o.bridgeContrastMin;
    });
    const comps = new Map();
    for (let i = 0; i < n; i++) if (live[i]) { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(i); }
    for (const [root, members] of comps) {
      if (anchored.has(root) || !members.some((i) => features[i].properties.activity_class === "active")) continue;
      const prev = new Map();
      const queue = [];
      for (let c = 0; c < n; c++) if (cand[c] && members.some((m) => touch(m, c))) { prev.set(c, -1); queue.push(c); }
      let goal = -1;
      while (queue.length && goal < 0) {
        const c = queue.shift();
        if (atLow(c) || features.some((_, j) => live[j] && anchored.has(find(j)) && touch(c, j))) { goal = c; break; }
        for (let d = 0; d < n; d++) if (cand[d] && !prev.has(d) && touch(c, d)) { prev.set(d, c); queue.push(d); }
      }
      if (goal < 0) continue;
      for (let c = goal; c >= 0; c = prev.get(c)) bridged.add(c);
      anchored.add(root);
    }
  }
  return features.map((f, i) => {
    if (bridged.has(i)) return { ...f, properties: { ...f.properties, activity_class: "weak", bridge: true } };
    if (live[i] && !anchored.has(find(i))) return { ...f, properties: { ...f.properties, activity_class: "none", unlinked: true } };
    return f;
  });
}

/**
 * Bei einem offenen Tief (ohne Okklusion) liegt der Übergang von der Warm-
 * zur Kaltfront im Tiefkern (Projektleitung, Russlandtief 10.10. 06 UTC:
 * die Automatik wechselte 110 km nordnordöstlich des Kerns). Treffen sich
 * eine Warm- und eine Kaltfront höchstens coreKm vom Kern eines Tiefs, an
 * dem keine Okklusion hängt, wird der Treffpunkt in den Kern verschoben;
 * beide Fronten folgen weich (Verschiebung nimmt über max(400 km, 2·Weg)
 * entlang der Linie auf null ab).
 */
export function junctionToCore(features, lows, opts = {}) {
  const o = { ...POSTPROCESS_DEFAULTS, ...opts };
  if (!o.coreJunction || !lows.length) return features;
  const pts = features.map((f) => f.geometry.coordinates.map(([lo, la]) => [la, lo]));
  const occLows = features.filter((f) => f.properties.front_type === "occluded").map((f) => f.properties.occlusion_low).filter((l) => l && typeof l === "object");
  const moved = new Map(); // Feature-Index -> Punkte
  const ends = [];
  features.forEach((f, i) => {
    const t = f.properties.front_type;
    if ((t !== "cold" && t !== "warm") || f.properties.activity_class === "none") return;
    ends.push({ i, t, atEnd: false, p: pts[i][0] }, { i, t, atEnd: true, p: pts[i][pts[i].length - 1] });
  });
  for (const a of ends) {
    if (a.t !== "warm") continue;
    const b = ends.find((e) => e.t === "cold" && distKm(e.p, a.p) < 5);
    if (!b) continue;
    const low = lows.map((l) => ({ l, d: distKm([l.lat, l.lon], a.p) })).sort((x, y) => x.d - y.d)[0];
    if (!low || low.d > o.coreKm || low.d < 10) continue;
    if (occLows.some((ol) => distKm([ol.lat, ol.lon], [low.l.lat, low.l.lon]) < 100)) continue;
    const D = [low.l.lat - a.p[0], low.l.lon - a.p[1]];
    const taper = Math.max(400, 2 * low.d);
    for (const e of [a, b]) {
      const line = (moved.get(e.i) || pts[e.i]).map((p) => p.slice());
      const order = e.atEnd ? line.slice().reverse() : line;
      let s = 0;
      const shifted = order.map((p, q) => {
        if (q) s += distKm(order[q - 1], order[q]);
        const x = Math.max(0, 1 - s / taper), w = x * x * (3 - 2 * x);
        return [p[0] + w * D[0], p[1] + w * D[1]];
      });
      moved.set(e.i, e.atEnd ? shifted.reverse() : shifted);
    }
  }
  return features.map((f, i) => (moved.has(i) ? {
    ...f,
    geometry: { type: "LineString", coordinates: moved.get(i).map(([la, lo]) => [+lo.toFixed(3), +la.toFixed(3)]) },
    properties: { ...f.properties, length_km: Math.round(lineLengthKm(moved.get(i))), core_junction: true },
  } : f));
}

/**
 * Okklusion am Niederschlag ausrichten (Projektleitung, Ostsee-Okklusion
 * 09.10. 12 UTC und Skagerrak-Okklusion 10.10. 06 UTC "stärker am
 * Niederschlag orientiert"): je Punkt quer zur Linie bis occPrecipKm das
 * Niederschlagsmaximum suchen, den Versatz entlang der Linie glätten
 * (300 km) und am Okklusionspunkt auf null ausblenden (200 km), damit die
 * Anschlüsse halten.
 */
export function occlusionToPrecip(features, af, g, opts = {}) {
  const o = { ...POSTPROCESS_DEFAULTS, ...opts };
  if (!o.occPrecip || !af?.precip) return features;
  return features.map((f) => {
    if (f.properties.front_type !== "occluded") return f;
    const ll = f.geometry.coordinates.map(([lo, la]) => [la, lo]);
    const n = ll.length;
    if (n < 3) return f;
    const nrm = [], off = [];
    for (let i = 0; i < n; i++) {
      const a = ll[Math.max(0, i - 1)], b = ll[Math.min(n - 1, i + 1)], c = Math.cos(ll[i][0] * DEG);
      const t = unitV([(b[1] - a[1]) * c, b[0] - a[0]]);
      const nn = [-t[1], t[0]];
      nrm.push(nn);
      let best = -1, bs = 0;
      for (let s = -o.occPrecipKm; s <= o.occPrecipKm; s += 10) {
        const q = [ll[i][0] + (s * nn[1]) / KM_PER_DEG, ll[i][1] + (s * nn[0]) / (KM_PER_DEG * c)];
        const r = sampleBilinear(af.precip, g, q[0], q[1]);
        if (r > best) { best = r; bs = s; }
      }
      off.push(best >= o.occPrecipMin ? bs : 0);
    }
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + distKm(ll[i - 1], ll[i]));
    const sm = off.map((_, i) => { let s = 0, k = 0; for (let j = 0; j < n; j++) if (Math.abs(cum[j] - cum[i]) <= 150) { s += off[j]; k++; } return s / k; });
    // Okklusionspunkt am Anfang (markOcclusions legt ihn dorthin)
    const out = ll.map((p, i) => {
      const x = Math.min(1, cum[i] / 200), w = x * x * (3 - 2 * x), c = Math.cos(p[0] * DEG);
      return [p[0] + (w * sm[i] * nrm[i][1]) / KM_PER_DEG, p[1] + (w * sm[i] * nrm[i][0]) / (KM_PER_DEG * c)];
    });
    return { ...f, geometry: { type: "LineString", coordinates: out.map(([la, lo]) => [+lo.toFixed(3), +la.toFixed(3)]) }, properties: { ...f.properties, length_km: Math.round(lineLengthKm(out)) } };
  });
}
