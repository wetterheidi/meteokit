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
 * Bewusst noch NICHT enthalten: Okklusionen und das Wetter-/Dynamik-
 * Kriterium („Front = Luftmassengrenze mit Wetter“) -- folgt als Attribut.
 */

import { thetaFields } from "./thermo.js";
import {
  gaussianSmooth, gradient, isolineSegments, chainSegments,
  sampleBilinear, lineLengthKm, distKm,
} from "./grid.js";

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
  minPieceKm: 250,    // kürzere Typ-Stücke gehen im Nachbarn auf
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
 * @param {object} [opts] Überschreibt `DETECT_DEFAULTS`.
 */
export function detectFronts(field, opts = {}) {
  const o = { ...DETECT_DEFAULTS, ...opts };
  const ff = frontFields(field, o);
  const { g, F, mask } = ff;
  const Fm = Float32Array.from(F, (x, k) => (mask[k] ? x : NaN));
  const lines = chainSegments(isolineSegments(Fm, g, 0))
    .filter((line) => lineLengthKm(line) >= o.minLengthKm);

  const features = [];
  for (const line of lines) {
    for (const piece of classify(line, ff, o)) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: piece.pts.map(([la, lo]) => [+lo.toFixed(3), +la.toFixed(3)]) },
        properties: {
          front_type: piece.type,
          level: field.pressure,
          valid_time: field.validTime,
          length_km: Math.round(lineLengthKm(piece.pts)),
          gradient: round2(mean(piece.pts.map(([la, lo]) => sampleBilinear(ff.G, g, la, lo)))),
          tfp: round2(mean(piece.pts.map(([la, lo]) => sampleBilinear(ff.TFP, g, la, lo)))),
          cross_wind: round2(mean(piece.c)),
          // Seite (in Linienrichtung), auf der die warme Luft liegt, und die
          // Zugrichtung der Front -- für die Symbole (Dreiecke/Halbkreise).
          warm_side: piece.warmSide,
          motion_side: piece.type === "cold" ? piece.warmSide
            : piece.type === "warm" ? flip(piece.warmSide) : null,
        },
      });
    }
  }
  return { type: "FeatureCollection", features, properties: { params: o } };
}

// Typ je Stützpunkt aus dem entlang der Linie geglätteten Querwind, dann in
// typreine Stücke teilen; zu kurze Stücke gehen im längeren Nachbarn auf.
function classify(line, ff, o) {
  const { g } = ff;
  const at = (f, p) => sampleBilinear(f, g, p[0], p[1]);
  const cRaw = line.map((p) => {
    const nx = at(ff.nx, p), ny = at(ff.ny, p), len = Math.hypot(nx, ny);
    return (at(ff.u, p) * nx + at(ff.v, p) * ny) / len;
  });
  // Laufendes Mittel über windSmoothKm (Abstand entlang der Linie).
  const s = [0];
  for (let m = 1; m < line.length; m++) s.push(s[m - 1] + distKm(line[m - 1], line[m]));
  const c = cRaw.map((_, m) => {
    let sum = 0, cnt = 0;
    for (let q = 0; q < line.length; q++) {
      if (Math.abs(s[q] - s[m]) <= o.windSmoothKm / 2 && Number.isFinite(cRaw[q])) { sum += cRaw[q]; cnt++; }
    }
    return cnt ? sum / cnt : NaN;
  });
  const typeOf = (x) => (x > o.windMin ? "cold" : x < -o.windMin ? "warm" : "stationary");

  let pieces = [];
  for (let m = 0; m < line.length; m++) {
    const t = typeOf(c[m]);
    const last = pieces[pieces.length - 1];
    if (last && last.type === t) { last.idx.push(m); continue; }
    // Neues Stück beginnt am letzten Punkt des vorigen -> lückenlos.
    pieces.push({ type: t, idx: last ? [last.idx[last.idx.length - 1], m] : [m] });
  }
  const lenOf = (p) => s[p.idx[p.idx.length - 1]] - s[p.idx[0]];
  for (let changed = true; changed && pieces.length > 1;) {
    changed = false;
    let iMin = -1;
    for (let q = 0; q < pieces.length; q++) {
      if (lenOf(pieces[q]) < o.minPieceKm && (iMin < 0 || lenOf(pieces[q]) < lenOf(pieces[iMin]))) iMin = q;
    }
    if (iMin < 0) break;
    const prev = pieces[iMin - 1], next = pieces[iMin + 1];
    const into = !next || (prev && lenOf(prev) >= lenOf(next)) ? prev : next;
    if (into === prev) prev.idx.push(...pieces[iMin].idx.slice(1));
    else next.idx.unshift(...pieces[iMin].idx.slice(0, -1));
    pieces.splice(iMin, 1);
    // Gleichartige Nachbarn verschmelzen.
    pieces = pieces.reduce((acc, p) => {
      const l = acc[acc.length - 1];
      if (l && l.type === p.type) l.idx.push(...p.idx.slice(1)); else acc.push(p);
      return acc;
    }, []);
    changed = true;
  }

  return pieces.map((p) => {
    const pts = p.idx.map((m) => line[m]);
    return { type: p.type, pts, c: p.idx.map((m) => c[m]), warmSide: warmSide(pts, ff) };
  });
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
const round2 = (x) => (Number.isFinite(x) ? +x.toFixed(2) : null);
