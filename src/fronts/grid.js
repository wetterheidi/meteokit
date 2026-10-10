/**
 * Werkzeuge auf dem regulären Lat/Lon-Gitter der Frontenanalyse.
 *
 * Gittergeometrie `g = { nx, ny, lat0, lon0, res }`: Felder row-major, Index
 * j*nx+i, j = Breite von Süd nach Nord, i = Länge von West nach Ost. Alle
 * Abstände sphärisch (dx = R·cosφ·Δλ), damit Glättung und Gradienten im
 * Norden des Gebiets nicht verzerrt sind.
 */

const R_KM = 6371;
const DEG = Math.PI / 180;

const latOf = (g, j) => g.lat0 + j * g.res;

/**
 * Gauß-Glättung mit Skala sigmaKm, separabel (erst Ost-West je Breite mit
 * breitenabhängiger Kernbreite, dann Nord-Süd). NaN-tolerant über
 * normalisierte Faltung: Lücken (z. B. Orographiemaske) werden aus den
 * Nachbarn gefüllt, soweit welche im Kern liegen -- maskierte Punkte selbst
 * bleiben NaN.
 */
export function gaussianSmooth(field, g, sigmaKm) {
  if (!(sigmaKm > 0)) return Float32Array.from(field);
  const { nx, ny } = g;
  const tmp = new Float32Array(nx * ny);
  const out = new Float32Array(nx * ny);
  const dyKm = R_KM * g.res * DEG;

  for (let j = 0; j < ny; j++) {
    const dxKm = Math.max(dyKm * Math.cos(latOf(g, j) * DEG), 1e-3);
    convolve1d(field, tmp, j * nx, 1, nx, sigmaKm / dxKm);
  }
  for (let i = 0; i < nx; i++) convolve1d(tmp, out, i, nx, ny, sigmaKm / dyKm);
  for (let k = 0; k < field.length; k++) if (!Number.isFinite(field[k])) out[k] = NaN;
  return out;
}

function convolve1d(src, dst, start, stride, n, sigmaCells) {
  const half = Math.min(n - 1, Math.ceil(3 * sigmaCells));
  const w = new Float32Array(half + 1);
  for (let d = 0; d <= half; d++) w[d] = Math.exp(-0.5 * (d / sigmaCells) ** 2);
  for (let a = 0; a < n; a++) {
    let s = 0, sw = 0;
    for (let b = Math.max(0, a - half); b <= Math.min(n - 1, a + half); b++) {
      const x = src[start + b * stride];
      if (!Number.isFinite(x)) continue;
      const wb = w[Math.abs(b - a)];
      s += wb * x; sw += wb;
    }
    dst[start + a * stride] = sw > 0 ? s / sw : NaN;
  }
}

/**
 * Zentrale Differenzen (am Rand einseitig) in Einheit/100 km.
 * @returns {{gx: Float32Array, gy: Float32Array, mag: Float32Array}}
 */
export function gradient(field, g) {
  const { nx, ny } = g;
  const gx = new Float32Array(nx * ny).fill(NaN);
  const gy = new Float32Array(nx * ny).fill(NaN);
  const mag = new Float32Array(nx * ny).fill(NaN);
  const dyKm = R_KM * g.res * DEG;
  for (let j = 0; j < ny; j++) {
    const dxKm = dyKm * Math.cos(latOf(g, j) * DEG);
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const i0 = Math.max(0, i - 1), i1 = Math.min(nx - 1, i + 1);
      const j0 = Math.max(0, j - 1), j1 = Math.min(ny - 1, j + 1);
      const ddx = (field[j * nx + i1] - field[j * nx + i0]) / ((i1 - i0) * dxKm) * 100;
      const ddy = (field[j1 * nx + i] - field[j0 * nx + i]) / ((j1 - j0) * dyKm) * 100;
      gx[k] = ddx; gy[k] = ddy;
      mag[k] = Math.hypot(ddx, ddy);
    }
  }
  return { gx, gy, mag };
}

/**
 * Isolinie `level` als lose Segmente [[lat, lon], [lat, lon]] (marching
 * squares, Sattelzellen über den Zellmittelwert). Zum Zeichnen reicht das;
 * für Frontlinien, die verkettet und gefiltert werden müssen, kommt später
 * eine Verkettung dazu.
 */
export function isolineSegments(field, g, level) {
  const { nx, ny } = g;
  const segs = [];
  const P = (i, j) => [latOf(g, j), g.lon0 + i * g.res];
  const cross = (va, vb, pa, pb) => {
    const f = (level - va) / (vb - va);
    return [pa[0] + f * (pb[0] - pa[0]), pa[1] + f * (pb[1] - pa[1])];
  };
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const v00 = field[j * nx + i], v10 = field[j * nx + i + 1];
      const v01 = field[(j + 1) * nx + i], v11 = field[(j + 1) * nx + i + 1];
      if (!(Number.isFinite(v00) && Number.isFinite(v10) && Number.isFinite(v01) && Number.isFinite(v11))) continue;
      const p00 = P(i, j), p10 = P(i + 1, j), p01 = P(i, j + 1), p11 = P(i + 1, j + 1);
      const hit = (a, b) => (a >= level) !== (b >= level);
      const s = hit(v00, v10) ? cross(v00, v10, p00, p10) : null;
      const e = hit(v10, v11) ? cross(v10, v11, p10, p11) : null;
      const n = hit(v01, v11) ? cross(v01, v11, p01, p11) : null;
      const w = hit(v00, v01) ? cross(v00, v01, p00, p01) : null;
      const pts = [s, e, n, w].filter(Boolean);
      if (pts.length === 2) segs.push(pts);
      else if (pts.length === 4) {
        const centerHigh = (v00 + v10 + v01 + v11) / 4 >= level;
        if (centerHigh === (v00 >= level)) { segs.push([s, e]); segs.push([n, w]); }
        else { segs.push([s, w]); segs.push([n, e]); }
      }
    }
  }
  return segs;
}

/**
 * Lose Segmente (aus `isolineSegments`) zu Polylinien verketten. Ein innerer
 * Kreuzungspunkt wird von beiden Nachbarzellen aus denselben Eckwerten in
 * derselben Richtung berechnet -> bitgleich, ein String-Schlüssel reicht.
 */
export function chainSegments(segs) {
  const key = (p) => `${p[0]}|${p[1]}`;
  const ends = new Map();
  segs.forEach((s, si) => {
    for (const e of [0, 1]) {
      const k = key(s[e]);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push({ si, e });
    }
  });
  const used = new Uint8Array(segs.length);
  const next = (pt) => (ends.get(key(pt)) || []).find(({ si }) => !used[si]);
  const lines = [];
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const line = [segs[s0][0], segs[s0][1]];
    for (const forward of [true, false]) {
      for (;;) {
        const tip = forward ? line[line.length - 1] : line[0];
        const n = next(tip);
        if (!n) break;
        used[n.si] = 1;
        const other = segs[n.si][1 - n.e];
        if (forward) line.push(other); else line.unshift(other);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Bilineare Interpolation an [lat, lon]; NaN außerhalb oder bei NaN-Ecken. */
export function sampleBilinear(field, g, lat, lon) {
  const x = (lon - g.lon0) / g.res, y = (lat - g.lat0) / g.res;
  const i = Math.floor(x), j = Math.floor(y);
  if (i < 0 || j < 0 || i >= g.nx - 1 || j >= g.ny - 1) return NaN;
  const fx = x - i, fy = y - j, k = j * g.nx + i;
  return (field[k] * (1 - fx) + field[k + 1] * fx) * (1 - fy)
    + (field[k + g.nx] * (1 - fx) + field[k + g.nx + 1] * fx) * fy;
}

/** Großkreisabstand in km zwischen [lat, lon]-Punkten. */
export function distKm(a, b) {
  const p1 = a[0] * DEG, p2 = b[0] * DEG;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((b[1] - a[1]) * DEG) / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

/** Länge einer Polylinie aus [lat, lon]-Punkten in km. */
export function lineLengthKm(line) {
  let s = 0;
  for (let m = 1; m < line.length; m++) s += distKm(line[m - 1], line[m]);
  return s;
}

/**
 * Laufendes Mittel einer Polylinie entlang der Bogenlänge (Fenster ±km/2),
 * Endpunkte fest. Gemittelt wird über die Strecke, nicht über die Punkte:
 * Bei ungleichen Abständen (Isolinienpunkte 0..150 km auseinander) zog ein
 * Mittel nach Punktzahl die Punkte über mehrere Durchgänge zu Klumpen mit
 * Sprüngen dazwischen zusammen. Punktzahl bleibt gleich.
 * @param {number[][]} pts [lat, lon]
 */
export function smoothAlong(pts, km, passes = 1) {
  let cur = pts.map((p) => p.slice());
  const h = km / 2;
  for (let n = 0; n < passes; n++) {
    const s = [0];
    for (let q = 1; q < cur.length; q++) s.push(s[q - 1] + distKm(cur[q - 1], cur[q]));
    cur = cur.map((p, q) => {
      if (q === 0 || q === cur.length - 1) return p;
      const a = Math.max(0, s[q] - h), b = Math.min(s[s.length - 1], s[q] + h);
      let la = 0, lo = 0, w = 0;
      for (let r = 1; r < cur.length; r++) {
        const s0 = Math.max(a, s[r - 1]), s1 = Math.min(b, s[r]), len = s1 - s0, seg = s[r] - s[r - 1];
        if (!(len > 0) || !(seg > 0)) continue;
        const f = ((s0 + s1) / 2 - s[r - 1]) / seg; // Mitte des überlappenden Stücks
        la += len * (cur[r - 1][0] + f * (cur[r][0] - cur[r - 1][0]));
        lo += len * (cur[r - 1][1] + f * (cur[r][1] - cur[r - 1][1]));
        w += len;
      }
      return w > 0 ? [la / w, lo / w] : p;
    });
  }
  return cur;
}
