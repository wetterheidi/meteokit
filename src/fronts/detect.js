/**
 * Objektive Frontendetektion nach der TFP-Methode (`meteokit/fronts`).
 *
 * Grundlage: Renard & Clarke (1965) bzw. Hewson (1998), Meteorol. Appl. 5,
 * 37–65. Die Formeln und Startschwellen unten sind aus der Sekundärliteratur
 * bzw. aus dem Gedächtnis übernommen und NICHT gegen das Original geprüft;
 * die Schwellen sind ohnehin an unseren Daten (ICON-EU, 0,5°, Glättung) zu
 * kalibrieren.
 *
 *   τ     = θw in 850 hPa, geglättet
 *   n̂     = ∇τ/|∇τ|                 (zeigt zur warmen Luft)
 *   G     = |∇τ|                    [K/100 km]
 *   TFP   = −∇G · n̂                 [K/(100 km)²] — positiv auf der warmen
 *                                   Seite eines Gradientmaximums
 *   Linie = Nulllinie von ∇TFP · n̂, also das TFP-Maximum quer zur Zone:
 *           die WARME Kante der Frontalzone (dort liegt die Bodenfront eher
 *           als in der Zonenmitte)
 *   Masken: K1  TFP > k1
 *           K2  G + m/√2 · TFP > k2  (G zur kalten Seite hin extrapoliert,
 *               m = Maskenlänge; sorgt dafür, dass nur echte Gradientzonen
 *               zählen, nicht flache TFP-Buckel)
 *
 * Klassifikation über den Wind quer zur Linie (850 hPa, gleich geglättet):
 *   c = v · n̂ > +cMin  → Kaltluft schiebt zur warmen Seite  → Kaltfront
 *   c < −cMin         → Warmluft schiebt zur kalten Seite  → Warmfront
 *   sonst             → quasistationär
 * Entlang einer Linie kann der Typ wechseln (z. B. Kaltfront, die in eine
 * Warmfront übergeht); die Linie wird dann in typreine Stücke geteilt.
 *
 * Wetter-/Dynamikkriterium („Front = Luftmassengrenze mit Wetter“): je
 * Stützpunkt in activity.js bewertet, entlang der Linie geglättet und in
 * Klassen aktiv / schwach / keine Front geteilt. Stücke ohne Front fallen
 * weg, außer mit `keepInactive: true` (Debug). Braucht Oberflächenfelder
 * (Fixture v2) und für die Drucktendenz den Vortermin als `prev`.
 *
 * Bodenposition (`position: "surface"`, Standard mit Oberflächenfeldern):
 * Kalt- und quasistationäre Fronten werden von der 850-hPa-Lage zur
 * Bodendruckrinne auf der warmen Seite verschoben, Warmfronten bleiben
 * (s. DETECT_DEFAULTS.surfaceTypes). Das geschieht vor der Okklusionsanalyse.
 *
 * Okklusionen (occlusion.js): am Okklusionspunkt, wo eine Kalt- auf eine
 * Warmfront trifft, wird der vom Warmsektor wegzeigende Ast als
 * `front_type: "occluded"` abgetrennt. Tiefzentren stehen in
 * `properties.lows` der FeatureCollection.
 */

import { thetaFields } from "./thermo.js";
import {
  gaussianSmooth, gradient, isolineSegments, chainSegments,
  sampleBilinear, lineLengthKm, distKm,
} from "./grid.js";
import { activityFields, assessPoints, activityClass } from "./activity.js";
import { findLows, markOcclusions, ridgeLines, OCCLUSION_DEFAULTS } from "./occlusion.js";

export const DETECT_DEFAULTS = {
  sigmaKm: 120,       // Gauß-Glättung von θw (und Wind)
  // Erste Kalibrierung am Fall 2026-10-09 00/06 UTC (gegen DWD, KNMI,
  // GeoSphere): 0.3/1.5 fand nur die zwei stärksten Fronten; 0.1/0.8 trifft
  // alle Hauptfronten, liefert aber auch Gradientbänder ohne Wetter (z. B.
  // Nordafrika) -- die soll das Wetterkriterium aussortieren.
  k1: 0.1,            // K/(100 km)², TFP-Maske
  k2: 0.8,            // K/100 km, Gradientmaske
  maskLenKm: 100,     // m in der K2-Maske
  minLengthKm: 400,   // kürzere Linien verwerfen
  sfcMarginHpa: 25,   // Fläche weniger als so tief über Grund -> maskiert
  windMin: 2,         // m/s, Schwelle Kalt-/Warmfront vs. quasistationär
  windSmoothKm: 300,  // Glättung von c entlang der Linie (laufendes Mittel)
  minPieceKm: 250,    // kürzere Typ-/Aktivitäts-Stücke gehen im Nachbarn auf
  activitySmoothKm: 300, // Glättung der Aktivität entlang der Linie
  activity: {},       // überschreibt ACTIVITY_DEFAULTS (activity.js)
  // Bodenposition: Linien von der Analysefläche auf die Bodenfront schieben.
  // Die 850-hPa-Warmfront liegt 250–450 km vor, die Kaltfront 50–250 km
  // hinter der Bodenfront (Leitfaden) -- beides heißt: zur warmen Seite hin.
  position: "surface",          // "surface" | "analysis"
  // Typen, die verschoben werden. Warmfronten nicht: am Fall 2026-10-09
  // lag die warme Kante der 850-hPa-Zone schon an der Bodenwarmfront der
  // Analysen (KNMI/DWD); die Verschiebung um den Leitfaden-Versatz
  // (250–450 km) erzeugte Haken und Parallellinien zur Okklusion.
  surfaceTypes: ["cold", "stationary"],
  surfaceDefaultKm: { cold: 120, stationary: 50 },
  surfaceTroughRamp: [0.1, 0.5], // hPa/(100 km)²: ab hier zählt die gefundene Rinne voll
  surfaceSmoothKm: 400,         // Glättung des Versatzes entlang der Linie
  occlusions: true,   // Okklusionen bestimmen (occlusion.js)
  occlusion: {},      // überschreibt OCCLUSION_DEFAULTS
};

/**
 * Ableitungsfelder für Detektion und Debug-Anzeige.
 * @returns {{ g, tau, G, TFP, F, mask, nx, ny, u, v }} alle Float32Array
 *   (außer g); mask: 1 = beide Masken erfüllt.
 */
export function frontFields(field, opts = {}) {
  const o = { ...DETECT_DEFAULTS, ...opts };
  const g = { nx: field.nx, ny: field.ny, lat0: field.lat0, lon0: field.lon0, res: field.res };
  const n = g.nx * g.ny;
  const { thW } = thetaFields(field);
  const raw = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const nearGround = !(field.psfc[k] - field.pressure >= o.sfcMarginHpa);
    raw[k] = field.below[k] || nearGround ? NaN : thW[k];
  }
  const tau = gaussianSmooth(raw, g, o.sigmaKm);
  const { gx, gy, mag: G } = gradient(tau, g);
  const nx = new Float32Array(n), ny = new Float32Array(n);
  for (let k = 0; k < n; k++) { nx[k] = gx[k] / G[k]; ny[k] = gy[k] / G[k]; }

  const dG = gradient(G, g);
  const TFP = new Float32Array(n);
  for (let k = 0; k < n; k++) TFP[k] = -(dG.gx[k] * nx[k] + dG.gy[k] * ny[k]);

  const dT = gradient(TFP, g);
  const F = new Float32Array(n), mask = new Uint8Array(n);
  const mFac = o.maskLenKm / 100 / Math.SQRT2;
  for (let k = 0; k < n; k++) {
    F[k] = dT.gx[k] * nx[k] + dT.gy[k] * ny[k];
    mask[k] = TFP[k] > o.k1 && G[k] + mFac * TFP[k] > o.k2 ? 1 : 0;
  }

  const fill = (src) => Float32Array.from(src, (x) => (x == null ? NaN : x));
  const u = gaussianSmooth(fill(field.u), g, o.sigmaKm);
  const v = gaussianSmooth(fill(field.v), g, o.sigmaKm);
  return { g, tau, G, TFP, F, mask, nx, ny, u, v };
}

/**
 * Fronten als GeoJSON-FeatureCollection (Koordinaten [lon, lat]).
 * @param {object} field  `fetchPlaneField`-Ergebnis bzw. Fixture.
 * @param {object} [opts] Überschreibt `DETECT_DEFAULTS`, dazu:
 * @param {object} [opts.prev]          Vortermin (3 h früher, gleiche Form) für die Drucktendenz.
 * @param {boolean} [opts.keepInactive] Auch Stücke ohne Wetter ausgeben (activity_class "none").
 */
export function detectFronts(field, opts = {}) {
  const { prev, keepInactive = false, ...rest } = opts;
  const o = { ...DETECT_DEFAULTS, ...rest };
  const ff = frontFields(field, o);
  const { g, F, mask } = ff;
  const Fm = Float32Array.from(F, (x, k) => (mask[k] ? x : NaN));
  const lines = chainSegments(isolineSegments(Fm, g, 0))
    .filter((line) => lineLengthKm(line) >= o.minLengthKm);
  const af = activityFields(field, prev, g);

  const surface = o.position === "surface" && af;
  const features = [];
  for (const line of lines) {
    const pieces = classify(line, ff, o).flatMap((typed) => byActivity(typed, ff, af, o));
    // Bodenposition: ganze Linie auf einmal verschieben (stetig über
    // Typwechsel), dann die Stücke aus der verschobenen Linie neu schneiden.
    const shift = surface ? surfaceShift(line, pieces, ff, o) : null;
    for (const piece of pieces) {
      if (shift) {
        piece.pts = piece.lineIdx.map((i) => shift.pts[i]);
        piece.offsetKm = mean(piece.lineIdx.map((i) => shift.offset[i]));
      }
      {
        const crit = (key, d = 2) => round(mean(piece.assess.map((x) => x[key])), d);
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: piece.pts.map(([la, lo]) => [+lo.toFixed(3), +la.toFixed(3)]) },
          properties: {
            front_type: piece.type,
            // "surface": auf die Bodenposition verschoben (Standard mit
            // Oberflächenfeldern), sonst die Lage in der Analysefläche (hPa).
            level: shift ? "surface" : field.pressure,
            analysis_level: field.pressure,
            surface_offset_km: shift ? Math.round(piece.offsetKm) : null,
            valid_time: field.validTime,
            length_km: Math.round(lineLengthKm(piece.pts)),
            gradient: round(mean(piece.pts.map(([la, lo]) => sampleBilinear(ff.G, g, la, lo))), 2),
            tfp: round(mean(piece.pts.map(([la, lo]) => sampleBilinear(ff.TFP, g, la, lo))), 2),
            cross_wind: round(mean(piece.c), 2),
            // Wetter-/Dynamikkriterium (activity.js); null ohne Oberflächenfelder.
            activity: af ? crit("activity") : null,
            activity_class: af ? piece.activityClass : null,
            criteria: af ? {
              contrast_k: crit("contrast", 1), trough: crit("trough"), convergence: crit("conv"),
              vorticity: crit("vort"), tendency_jump: crit("tendJump"), precip: crit("precip"),
              cloud_low: crit("cloudLow", 0), w700: crit("w700", 1), sfc_offset_km: crit("sfcOffsetKm", 0),
            } : null,
            // Seite (in Linienrichtung), auf der die warme Luft liegt, und die
            // Zugrichtung der Front -- für die Symbole (Dreiecke/Halbkreise).
            warm_side: piece.warmSide,
            motion_side: piece.type === "cold" ? piece.warmSide
              : piece.type === "warm" ? flip(piece.warmSide) : null,
          },
        });
      }
    }
  }
  // Okklusionen brauchen die bewerteten Fronten (Okklusionspunkt nur
  // zwischen echten Fronten) und den Bodendruck (Tiefzentren).
  const lows = o.occlusions && field.sfc ? findLows(field, g, o.occlusion) : [];
  // Warmluftzungen: bevorzugt aus der Schichtdicke 500/1000 (Okklusion
  // durch den Scheitel des Warmluftkeils, K1), sonst aus θw in 700 hPa
  // (Isentropenanalyse 700 hPa, K4).
  const oo = { ...OCCLUSION_DEFAULTS, ...o.occlusion };
  const L7 = field.levels?.[700];
  let ridges = null, ridgeSource = null;
  if (o.occlusions && field.thickness) {
    ridges = ridgeLines(field.thickness, g, oo, oo.thicknessLambdaMin); ridgeSource = "thickness";
  } else if (o.occlusions && L7) {
    ridges = ridgeLines(thetaFields({ nx: g.nx, ny: g.ny, T: L7.T, q: L7.q, pressure: 700 }).thW, g, oo); ridgeSource = "theta700";
  }
  // Okklusionen auf allen Stücken bestimmen, auch denen ohne Wetter: der
  // Okklusionsast ist in 850 hPa oft schwach und gehört trotzdem zur Linie.
  const msl = o.occlusions && field.sfc ? gaussianSmooth(Float32Array.from(field.sfc.pressure_msl, (x) => (x == null ? NaN : x)), g, oo.lowSmoothKm) : null;
  const all = o.occlusions && field.sfc ? markOcclusions(features, ff, lows, oo, ridges, msl) : features;
  const out = keepInactive ? all : all.filter((f) => f.properties.activity_class !== "none");
  return { type: "FeatureCollection", features: out, properties: { params: o, lows, ridges, ridgeSource } };
}

// Abstand entlang der Linie [km] je Stützpunkt.
function cumDist(line) {
  const s = [0];
  for (let m = 1; m < line.length; m++) s.push(s[m - 1] + distKm(line[m - 1], line[m]));
  return s;
}

// Laufendes Mittel über widthKm entlang der Linie (NaN werden übergangen).
function runningMean(values, s, widthKm) {
  return values.map((_, m) => {
    let sum = 0, cnt = 0;
    for (let q = 0; q < values.length; q++) {
      if (Math.abs(s[q] - s[m]) <= widthKm / 2 && Number.isFinite(values[q])) { sum += values[q]; cnt++; }
    }
    return cnt ? sum / cnt : NaN;
  });
}

// Linie nach Label je Stützpunkt in Stücke teilen. Stücke schließen
// lückenlos aneinander an (gemeinsamer Punkt); zu kurze gehen im längeren
// Nachbarn auf, gleichartige Nachbarn verschmelzen.
function splitRuns(labels, s, minPieceKm) {
  let pieces = [];
  for (let m = 0; m < labels.length; m++) {
    const last = pieces[pieces.length - 1];
    if (last && last.label === labels[m]) { last.idx.push(m); continue; }
    pieces.push({ label: labels[m], idx: last ? [last.idx[last.idx.length - 1], m] : [m] });
  }
  const lenOf = (p) => s[p.idx[p.idx.length - 1]] - s[p.idx[0]];
  while (pieces.length > 1) {
    let iMin = -1;
    for (let q = 0; q < pieces.length; q++) {
      if (lenOf(pieces[q]) < minPieceKm && (iMin < 0 || lenOf(pieces[q]) < lenOf(pieces[iMin]))) iMin = q;
    }
    if (iMin < 0) break;
    const prev = pieces[iMin - 1], next = pieces[iMin + 1];
    const into = !next || (prev && lenOf(prev) >= lenOf(next)) ? prev : next;
    if (into === prev) prev.idx.push(...pieces[iMin].idx.slice(1));
    else next.idx.unshift(...pieces[iMin].idx.slice(0, -1));
    pieces.splice(iMin, 1);
    pieces = pieces.reduce((acc, p) => {
      const l = acc[acc.length - 1];
      if (l && l.label === p.label) l.idx.push(...p.idx.slice(1)); else acc.push(p);
      return acc;
    }, []);
  }
  return pieces;
}

// Typ je Stützpunkt aus dem entlang der Linie geglätteten Querwind, dann in
// typreine Stücke teilen.
function classify(line, ff, o) {
  const { g } = ff;
  const at = (f, p) => sampleBilinear(f, g, p[0], p[1]);
  const cRaw = line.map((p) => {
    const nx = at(ff.nx, p), ny = at(ff.ny, p), len = Math.hypot(nx, ny);
    return (at(ff.u, p) * nx + at(ff.v, p) * ny) / len;
  });
  const s = cumDist(line);
  const c = runningMean(cRaw, s, o.windSmoothKm);
  const typeOf = (x) => (x > o.windMin ? "cold" : x < -o.windMin ? "warm" : "stationary");
  return splitRuns(c.map(typeOf), s, o.minPieceKm).map((p) => {
    const pts = p.idx.map((m) => line[m]);
    return { type: p.label, pts, lineIdx: p.idx, c: p.idx.map((m) => c[m]), warmSide: warmSide(pts, ff) };
  });
}

// Typreines Stück nach Aktivitätsklasse weiter teilen (aktiv / schwach /
// keine Front). Ohne Oberflächenfelder bleibt es ein Stück ohne Bewertung.
function byActivity(piece, ff, af, o) {
  if (!af) return [{ ...piece, assess: [], activityClass: null }];
  const assess = assessPoints(piece.pts, piece.type, ff, af, o.activity);
  const s = cumDist(piece.pts);
  const act = runningMean(assess.map((x) => x.activity), s, o.activitySmoothKm);
  assess.forEach((x, m) => { x.activity = act[m]; });
  return splitRuns(act.map((a) => activityClass(a, o.activity)), s, o.minPieceKm).map((p) => {
    const pts = p.idx.map((m) => piece.pts[m]);
    return {
      type: piece.type, pts, lineIdx: p.idx.map((m) => piece.lineIdx[m]), c: p.idx.map((m) => piece.c[m]), warmSide: piece.warmSide,
      assess: p.idx.map((m) => assess[m]), activityClass: p.label,
    };
  });
}

// Versatz 850 hPa -> Boden je Stützpunkt der ganzen Linie und die
// verschobenen Punkte. Grundlage ist die Lage der stärksten Bodendruckrinne
// auf der warmen Seite (activity.js, sfcOffsetKm); bei schwacher Rinne wird
// zum typischen Versatz nach Leitfaden hin gemischt. Entlang der Linie
// geglättet (surfaceSmoothKm), dann senkrecht zur Zone (n̂, zur warmen Seite)
// verschoben.
function surfaceShift(line, pieces, ff, o) {
  const sum = new Float64Array(line.length), cnt = new Float64Array(line.length);
  for (const piece of pieces) {
    const shiftThis = o.surfaceTypes.includes(piece.type);
    const def = o.surfaceDefaultKm[piece.type] ?? 0;
    piece.assess.forEach((x, m) => {
      if (!shiftThis) { const i = piece.lineIdx[m]; cnt[i] += 1; return; } // Versatz 0
      if (!Number.isFinite(x.sfcOffsetKm)) return;
      const w = Number.isFinite(x.trough)
        ? Math.min(1, Math.max(0, (x.trough - o.surfaceTroughRamp[0]) / (o.surfaceTroughRamp[1] - o.surfaceTroughRamp[0]))) : 0;
      const i = piece.lineIdx[m];
      sum[i] += w * x.sfcOffsetKm + (1 - w) * def;
      cnt[i] += 1;
    });
  }
  const raw = Array.from(sum, (v, i) => (cnt[i] ? v / cnt[i] : NaN));
  const offset = runningMean(raw, cumDist(line), o.surfaceSmoothKm).map((x) => (Number.isFinite(x) ? x : 0));
  const pts = line.map((p, i) => {
    const nx = sampleBilinear(ff.nx, ff.g, p[0], p[1]), ny = sampleBilinear(ff.ny, ff.g, p[0], p[1]);
    const L = Math.hypot(nx, ny);
    if (!(L > 0)) return p;
    const s = offset[i];
    return [p[0] + (s * ny) / L / 111.2, p[1] + (s * nx) / L / (111.2 * Math.cos((p[0] * Math.PI) / 180))];
  });
  return { pts, offset };
}

// Liegt die warme Luft links oder rechts der Linie (in Punktreihenfolge)?
// Vorzeichen des Kreuzprodukts Tangente × n̂ in lokal metrischen Koordinaten.
function warmSide(pts, ff) {
  let sum = 0;
  for (let m = 1; m < pts.length; m++) {
    const a = pts[m - 1], b = pts[m];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const tx = (b[1] - a[1]) * Math.cos((mid[0] * Math.PI) / 180), ty = b[0] - a[0];
    const nx = sampleBilinear(ff.nx, ff.g, mid[0], mid[1]), ny = sampleBilinear(ff.ny, ff.g, mid[0], mid[1]);
    if (Number.isFinite(nx) && Number.isFinite(ny)) sum += tx * ny - ty * nx;
  }
  return sum >= 0 ? "left" : "right";
}

const flip = (side) => (side === "left" ? "right" : "left");
const mean = (a) => { const f = a.filter(Number.isFinite); return f.length ? f.reduce((x, y) => x + y, 0) / f.length : NaN; };
const round = (x, d) => (Number.isFinite(x) ? +x.toFixed(d) : null);
