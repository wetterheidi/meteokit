/**
 * Vergleich einer Frontenanalyse mit einer Referenz (Handanalyse aus der
 * Debug-Seite). Gemeinsam genutzt von debug.html und compare.mjs.
 *
 * Beide Analysen werden alle stepKm abgetastet. Ein Referenzpunkt gilt als
 * getroffen, wenn eine Front gleichen Typs höchstens tolKm entfernt liegt
 * ("nur Lage": Front beliebigen Typs). Ein Punkt der Automatik ist ein
 * Fehlalarm, wenn keine Referenzfront gleichen Typs so nah liegt. Alle
 * Anteile sind längengewichtet.
 */

import { distKm } from "../../src/fronts/grid.js";

export const COMPARE_DEFAULTS = { tolKm: 150, stepKm: 25 };

/** Fronten einer FeatureCollection als { type, ll: [[lat, lon], …] }, ohne activity_class "none". */
export function fcToLines(fc) {
  return (fc?.features || [])
    .filter((f) => f.geometry?.type === "LineString" && f.properties?.activity_class !== "none")
    .map((f) => ({ type: f.properties.front_type, ll: f.geometry.coordinates.map(([lo, la]) => [la, lo]) }));
}

// Punkte im Abstand stepKm entlang der Linie (einschließlich Anfang).
function resample(ll, step) {
  const out = [ll[0]];
  let acc = 0;
  for (let i = 1; i < ll.length; i++) {
    let a = ll[i - 1];
    const b = ll[i];
    let d = distKm(a, b);
    while (acc + d >= step && d > 0) {
      const f = (step - acc) / d;
      a = [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
      out.push(a);
      d = distKm(a, b);
      acc = 0;
    }
    acc += d;
  }
  if (acc > step / 2) out.push(ll[ll.length - 1]);
  return out;
}

/**
 * @param {{type: string, ll: number[][]}[]} ref   Referenz (Handanalyse)
 * @param {{type: string, ll: number[][]}[]} test  zu prüfende Analyse
 * @returns Längen [km] und Anteile: pod (Treffer), podAny (nur Lage),
 *   far (Fehlalarm), meanDistKm (mittlerer Abstand der Treffer), perRef.
 */
export function compareFronts(ref, test, opts = {}) {
  const o = { ...COMPARE_DEFAULTS, ...opts };
  const sample = (lines) => lines.filter((l) => l.ll.length >= 2).map((l) => ({ type: l.type, pts: resample(l.ll, o.stepKm) }));
  const R = sample(ref), T = sample(test);
  const near = (p, lines, type) => {
    let best = Infinity;
    for (const l of lines) {
      if (type && l.type !== type) continue;
      for (const q of l.pts) { const d = distKm(p, q); if (d < best) best = d; }
    }
    return best;
  };

  let refKm = 0, hitKm = 0, hitAnyKm = 0, distSum = 0, distN = 0;
  const perRef = [];
  for (const l of R) {
    let hits = 0, ds = 0;
    for (const p of l.pts) {
      const d = near(p, T, l.type);
      if (d <= o.tolKm) { hits++; ds += d; }
      if (near(p, T) <= o.tolKm) hitAnyKm += o.stepKm;
    }
    refKm += l.pts.length * o.stepKm; hitKm += hits * o.stepKm; distSum += ds; distN += hits;
    perRef.push({ type: l.type, km: l.pts.length * o.stepKm, pod: hits / l.pts.length, meanDistKm: hits ? ds / hits : null });
  }
  let testKm = 0, falseKm = 0;
  for (const l of T) {
    for (const p of l.pts) { testKm += o.stepKm; if (near(p, R, l.type) > o.tolKm) falseKm += o.stepKm; }
  }
  return {
    refKm, testKm, hitKm, hitAnyKm, falseKm, distSum, distN,
    pod: refKm ? hitKm / refKm : null,
    podAny: refKm ? hitAnyKm / refKm : null,
    far: testKm ? falseKm / testKm : null,
    meanDistKm: distN ? distSum / distN : null,
    perRef,
  };
}
