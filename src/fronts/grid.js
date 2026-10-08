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
