/**
 * Farbskalen der Feldschattierung (`meteokit/fronts/map`). Gestuft wie in
 * Druckkarten: jeder Wert fällt in ein Band der Breite `step`.
 *
 * Eine Skala: { min, max, step, stops, surface? }. `surface: true` heißt,
 * das Feld ist ein Oberflächen- bzw. Höhenfeld und wird nicht mit der
 * Geländemaske der Analysefläche abgedeckt.
 */

// Farbskala angelehnt an die gängigen θe-Karten (violett kalt -> rot warm).
const STOPS = ["#6a1b9a", "#d81bd0", "#2a2ad0", "#3a78ff", "#6cc8ff", "#3fd0b0",
  "#3cbf3c", "#a6e03c", "#ffff3c", "#f5a623", "#e0601e", "#c0201e", "#7a0d3c"];
const GRAD_STOPS = ["#ffffff", "#fff3b0", "#ffc04d", "#f46d25", "#c4161c", "#5a0a2a"];
const DIVERGING = ["#2166ac", "#92c5de", "#f7f7f7", "#f4a582", "#b2182b"];

export const SCALES = {
  thE: { min: -9, max: 81, step: 3, stops: STOPS },
  thW: { min: -12, max: 24, step: 1, stops: STOPS },
  T: { min: -24, max: 24, step: 2, stops: STOPS },
  grad: { min: 0, max: 6, step: 0.5, stops: GRAD_STOPS },
  tfp: { min: -1, max: 1, step: 0.1, stops: DIVERGING },
  // Petterssen, auf θw der Analysefläche: rot Frontogenese, blau Frontolyse.
  fg: { min: -1, max: 1, step: 0.1, stops: DIVERGING },
  // Oberflächen- bzw. 700-hPa-Felder: keine 850-Maske (surface: true).
  tend: { min: -4, max: 4, step: 0.5, stops: ["#b2182b", "#f4a582", "#f7f7f7", "#92c5de", "#2166ac"], surface: true },
  precip: { min: 0, max: 4, step: 0.2, stops: ["#ffffff", "#c7e9c0", "#41ab5d", "#006d2c", "#08306b"], surface: true },
  cloud: { min: 0, max: 100, step: 10, stops: ["#ffffff", "#d9d9d9", "#969696", "#525252"], surface: true },
  cloudLow: { min: 0, max: 100, step: 10, stops: ["#ffffff", "#d9d9d9", "#969696", "#525252"], surface: true },
  w700: { min: -30, max: 30, step: 2, stops: ["#8c510a", "#d8b365", "#f5f5f5", "#5ab4ac", "#01665e"], surface: true },
  spread700: { min: 0, max: 20, step: 1, stops: ["#1a9850", "#91cf60", "#ffffbf", "#fee08b", "#d73027"], surface: true },
  thk: { min: 512, max: 576, step: 4, stops: STOPS, surface: true },
  // Zyklogenese (cyclogenesis.js): rot PVA bzw. Zunahme, blau NVA bzw. Abnahme.
  z500: { min: 504, max: 588, step: 4, stops: STOPS, surface: true },
  pva: { min: -10, max: 10, step: 1, stops: DIVERGING, surface: true },
  zeta500: { min: -15, max: 15, step: 1.5, stops: DIVERGING, surface: true },
  vortTend: { min: -4, max: 4, step: 0.5, stops: DIVERGING, surface: true },
};

const hex = (h) => [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16));

/** Farbe [r, g, b] eines Werts auf der Skala (Bänder wie in Druckkarten). */
export function colorAt(scale, value) {
  const q = Math.floor(value / scale.step) * scale.step;
  const f = Math.min(1, Math.max(0, (q - scale.min) / (scale.max - scale.min)));
  const x = f * (scale.stops.length - 1), i = Math.min(scale.stops.length - 2, Math.floor(x));
  const a = hex(scale.stops[i]), b = hex(scale.stops[i + 1]), t = x - i;
  return a.map((c, n) => Math.round(c + t * (b[n] - c)));
}

/** Farbbalken der Skala auf ein Canvas malen (ganze Breite = min … max). */
export function paintScale(canvas, scale) {
  const ctx = canvas.getContext("2d");
  for (let x = 0; x < canvas.width; x++) {
    const v = scale.min + (x / canvas.width) * (scale.max - scale.min);
    ctx.fillStyle = `rgb(${colorAt(scale, v).join(",")})`; ctx.fillRect(x, 0, 1, canvas.height);
  }
}

/** n+1 gleichabständige Beschriftungswerte von min bis max. */
export function scaleTicks(scale, n = 6) {
  const t = [];
  for (let s = 0; s <= n; s++) t.push(+(scale.min + (s / n) * (scale.max - scale.min)).toFixed(1));
  return t;
}
