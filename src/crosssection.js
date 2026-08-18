/**
 * Cross-Sections (Höhe × Zeit) am Operationspunkt — reines SVG.
 * Oben Wind (sequenzielle Skala + Richtungspfeile), unten Temperatur
 * (regenbogenfarbig, Kalt→Warm + Nullgradlinie). Log-Höhenachse (dicht am Boden),
 * Flughöhe als Linie markiert. Farbskalen: Wind einhuig hell→dunkel,
 * Temperatur regenbogenfarbig Lila→Blau→Grün→Gelb→Orange→Rot (mehr Kontrast).
 * opts.axis = "lin" schaltet auf eine lineare Höhenachse (Zoom-Modus bis
 * Flughöhe: feines Gitter, dichtere Windpfeile).
 */

import {
  heightToDisplay, heightUnit, windToDisplay, windUnit, tempToDisplay, tempUnit,
  fmtHeight, fmtWind, fmtDir, fmtTemp,
} from "./units.js";
import { placeWindBarb, CHART_PX_PER_HOUR, CHART_BARB_SIZE } from "./windbarb.js";
import { lerpAngle } from "./column.js";

const KT_PER_MS = 1.94384;

const NS = "http://www.w3.org/2000/svg";
const INK = "#0b0b0b", MUTED = "#52514e", GRID = "#d9d8d3";
const TOPAX = 24, GAP = 26, BOT = 22, M = { l: 50, r: 66 };

// Sequenzielle Windskala (m/s): eine Hue, hell→dunkel.
const WIND_STOPS = [
  [0, "#eef4fb"], [3, "#c2dbf0"], [6, "#8bb8e2"], [9, "#5290cf"],
  [12, "#2f6cb6"], [16, "#1d4c8c"], [22, "#122f5c"],
];
// Regenbogen-Temperaturskala (°C): Lila (kalt) → Blau → Cyan → Grün → Gelb → Orange → Rot (warm).
// Testweise anstelle der divergierenden Blau/Grau/Rot-Skala für mehr Kontrast.
const TEMP_STOPS = [
  [-40, "#2a0a4a"], [-30, "#1b3f8c"], [-20, "#1f7ec9"], [-10, "#22b8c9"],
  [-4, "#3fc98a"], [0, "#8fd444"], [4, "#ffe93b"], [10, "#ffb62b"],
  [16, "#ff8a1f"], [22, "#f2521f"], [28, "#c9281f"], [35, "#7a1414"],
];
// Sequenzielle Wolkenskala (%): eine Hue, frei (weiß) → bedeckt (dunkelblau).
const CLOUD_STOPS = [
  [0, "#ffffff"], [15, "#e2edf7"], [40, "#b7d1ea"], [60, "#8bb4dc"], [80, "#5d90c8"], [100, "#34659f"],
];

export function renderCrossSection(host, field, opts = {}) {
  host.innerHTML = "";
  const { time, targetH } = field;
  if (!time || time.length < 2 || !targetH) { host.textContent = "Keine Säulendaten."; return; }

  // Panelbreite: fester Pixelabstand pro Stunde (Windfiedern brauchen dafür
  // genug Platz, siehe windArrows), Containerbreite nur als UNTERGRENZE für
  // kurze Horizonte. Bei langen Horizonten wächst die Breite mit — #xs-body
  // hat overflow:auto, das Panel scrollt dann horizontal statt die Fiedern
  // bis zur Unlesbarkeit zusammenzuquetschen.
  const hours = Math.max(1, (time[time.length - 1] - time[0]) / 3600);
  const containerPw = Math.max(host.clientWidth || 0, 360) - M.l - M.r;
  const pw = Math.max(hours * CHART_PX_PER_HOUR, containerPw);
  const W = pw + M.l + M.r;
  const Hpx = Math.max(host.clientHeight || 0, 460);
  const t0 = time[0], t1 = time[time.length - 1];
  const x = (t) => M.l + ((t - t0) / (t1 - t0)) * pw;
  x.right = M.l + pw;

  const panelH = (Hpx - TOPAX - 2 * GAP - BOT) / 3; // drei Panels, BOT unten
  const wTop = TOPAX, wBot = wTop + panelH;                 // Wind
  const tTop = wBot + GAP, tBot = tTop + panelH;            // Temperatur
  const cTop = tBot + GAP, cBot = cTop + panelH;            // Bewölkung

  const hMin = targetH[0], hMax = targetH[targetH.length - 1];
  const lin = opts.axis === "lin";
  const yFor = (top, bot) => {
    const la = lin ? hMin : Math.log(hMin), lb = lin ? hMax : Math.log(hMax);
    const f = (h) => {
      const s = lin ? clamp(h, hMin, hMax) : Math.log(clamp(h, hMin, hMax));
      return bot - (s - la) / (lb - la) * (bot - top);
    };
    f.top = top; f.bot = bot;
    return f;
  };
  const yW = yFor(wTop, wBot), yT = yFor(tTop, tBot), yC = yFor(cTop, cBot);

  const svg = mk("svg", { width: W, height: Hpx, viewBox: `0 0 ${W} ${Hpx}`, class: "xs-svg" });
  svg.append(txt(2, 10, "loc", MUTED, 9, "start")); // Zeitzonen-Hinweis: lokale Zeit

  // Panels: Heatmap-Zellen (Färbung nach physikalischem Wert, Skala einheitenfest).
  const gW = mk("g", {}), gT = mk("g", {}), gC = mk("g", {});
  heat(gW, field, field.spd, (v) => ramp(WIND_STOPS, v), x, yW, targetH, time, lin);
  heat(gT, field, field.temp, (v) => ramp(TEMP_STOPS, v), x, yT, targetH, time, lin);
  heat(gC, field, field.cloud, (v) => ramp(CLOUD_STOPS, v * 100), x, yC, targetH, time, lin);
  svg.append(gW, gT, gC);

  // Höhen-Gitter + Achsenbeschriftung je Panel.
  heightAxis(svg, yW, hMin, hMax, x, lin);
  heightAxis(svg, yT, hMin, hMax, x, lin);
  heightAxis(svg, yC, hMin, hMax, x, lin);

  // Zeitachse + Tagestrenner über alle Panels.
  timeAxis(svg, time, x, wTop, cBot);

  // Overlays. Im Zoom-Modus (lin) dichtere Pfeilreihen — dafür ist er da.
  windArrows(gW, field, x, yW, targetH, time, lin ? 11 : 7);
  freezingLine(svg, field, x, yT, hMin, hMax);
  for (const y of [yW, yT, yC]) flightLine(svg, y, opts.maxHeightM, x);

  // Titel + Farbleisten (Labels in Anzeigeeinheit, Färbung physikalisch).
  title(svg, M.l + 4, wTop + 13, `Wind (${windUnit()}) · Richtung`);
  title(svg, M.l + 4, tTop + 13, `Temperatur (${tempUnit()}) · Nullgradgrenze`);
  title(svg, M.l + 4, cTop + 13, `Bewölkung (%) · aus Modell-CLC`);
  colorbar(svg, x.right + 12, wTop, wBot, WIND_STOPS, windToDisplay, windUnit());
  colorbar(svg, x.right + 12, tTop, tBot, TEMP_STOPS, tempToDisplay, tempUnit());
  colorbar(svg, x.right + 12, cTop, cBot, CLOUD_STOPS, (v) => v, "%");

  host.append(svg);
  setupHover(svg, { field, x, panels: [[wTop, wBot, yW], [tTop, tBot, yT], [cTop, cBot, yC]], hMin, hMax, W, Hpx, lin });
}

// --- Hover-Ablesung --------------------------------------------------------

function setupHover(svg, ctx) {
  const { field, x, panels, hMin, hMax, W, Hpx, lin } = ctx;
  const { time, targetH } = field;
  const t0 = time[0], t1 = time[time.length - 1], dt = time[1] - time[0], T = time.length;
  const pw = x.right - M.l;
  const ov = mk("g", { "pointer-events": "none" });
  svg.append(ov);

  const invX = (px) => t0 + (px - M.l) / pw * (t1 - t0);
  const invY = (py, top, bot) => {
    const frac = (bot - py) / (bot - top);
    const h = lin
      ? hMin + frac * (hMax - hMin)
      : Math.exp(Math.log(hMin) + frac * (Math.log(hMax) - Math.log(hMin)));
    return clamp(h, hMin, hMax);
  };
  const sampleAt = (i, h) => {
    let k = 1; while (k < targetH.length && targetH[k] < h) k++;
    if (k >= targetH.length) k = targetH.length - 1;
    const k0 = k - 1, f = (h - targetH[k0]) / (targetH[k] - targetH[k0]);
    const lin = (a) => a[k0][i] + f * (a[k][i] - a[k0][i]);
    // Richtung über den kürzeren Bogen, Betrag linear -- field.spd/field.dir
    // kommen bereits so aus buildField() (s. dortiger Doc-Kommentar), hier nur
    // zwischen den beiden benachbarten Zielhöhen-Reihen weiterinterpoliert.
    return {
      spd: lin(field.spd),
      dir: lerpAngle(field.dir[k0][i], field.dir[k][i], f),
      temp: lin(field.temp), cloud: lin(field.cloud),
    };
  };
  const clearOv = () => { while (ov.firstChild) ov.removeChild(ov.firstChild); };

  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = (e.clientX - r.left) * (W / r.width);
    const py = (e.clientY - r.top) * (Hpx / r.height);
    const panel = panels.find(([top, bot]) => py >= top && py <= bot);
    if (!panel || px < M.l || px > x.right) { clearOv(); return; }
    const [top, bot, y] = panel;

    const i = clamp(Math.round((invX(px) - t0) / dt), 0, T - 1);
    const sx = x(time[i]), h = invY(py, top, bot), s = sampleAt(i, h);
    clearOv();
    // Fadenkreuz: Zeit gerastet (stündlich), Höhe stufenlos.
    ov.append(mk("line", { x1: sx, y1: top, x2: sx, y2: bot, stroke: INK, "stroke-width": 0.8, opacity: 0.55 }));
    ov.append(mk("line", { x1: M.l, y1: py, x2: x.right, y2: py, stroke: INK, "stroke-width": 0.8, opacity: 0.55 }));
    ov.append(mk("circle", { cx: sx, cy: py, r: 3.2, fill: "none", stroke: "#fff", "stroke-width": 2.4 }));
    ov.append(mk("circle", { cx: sx, cy: py, r: 3.2, fill: "none", stroke: INK, "stroke-width": 1.3 }));
    void y;
    drawTip(ov, px, py, [
      new Date(time[i] * 1000).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" }),
      `Höhe ${fmtHeight(h)}`,
      `Wind ${fmtDir(s.dir)} ${fmtWind(s.spd)}`,
      `Temp ${fmtTemp(s.temp)}`,
      `Wolken ${Math.round(s.cloud * 100)} %`,
    ], W, Hpx);
  });
  svg.addEventListener("pointerleave", clearOv);
}

function drawTip(ov, px, py, lines, W, Hpx) {
  const pad = 7, lh = 15, w = 168, h = pad * 2 + lines.length * lh;
  let tx = px + 14, ty = py + 14;
  if (tx + w > W) tx = px - 14 - w;
  if (ty + h > Hpx) ty = py - 14 - h;
  ov.append(mk("rect", { x: tx, y: ty, width: w, height: h, rx: 5, fill: "rgba(252,252,251,0.97)", stroke: "#c9c8c2", "stroke-width": 1 }));
  lines.forEach((ln, j) => {
    ov.append(txt(tx + pad, ty + pad + lh * (j + 1) - 4, ln, j === 0 ? INK : MUTED, 11, "start", j === 0 ? 700 : 400));
  });
}

// --- Heatmap ---------------------------------------------------------------

function heat(g, field, val2d, colorFn, x, y, targetH, time, lin) {
  const n = targetH.length, T = time.length;
  const dt = time[1] - time[0];
  // Höhen-Kanten: Mittel passend zum Gitter (log: geometrisch, lin: arithmetisch).
  const yE = new Float64Array(n + 1);
  yE[0] = targetH[0]; yE[n] = targetH[n - 1];
  for (let k = 1; k < n; k++) {
    yE[k] = lin ? (targetH[k - 1] + targetH[k]) / 2 : Math.sqrt(targetH[k - 1] * targetH[k]);
  }
  for (let i = 0; i < T; i++) {
    const x0 = clamp(x(time[i] - dt / 2), M.l, x.right);
    const x1 = clamp(x(time[i] + dt / 2), M.l, x.right);
    for (let k = 0; k < n; k++) {
      const v = val2d[k][i];
      if (!Number.isFinite(v)) continue;
      const yTop = y(yE[k + 1]), yBot = y(yE[k]);
      g.append(mk("rect", {
        x: x0.toFixed(1), y: yTop.toFixed(1), width: (x1 - x0).toFixed(1),
        height: (yBot - yTop).toFixed(1), fill: colorFn(v), "shape-rendering": "crispEdges",
      }));
    }
  }
  // Feiner Rahmen ums Panel.
  g.append(mk("rect", { x: M.l, y: y.top, width: x.right - M.l, height: y.bot - y.top, fill: "none", stroke: MUTED, "stroke-width": 1 }));
}

// --- Overlays --------------------------------------------------------------

// Windfiedern (WMO-Barbs) stündlich entlang der Zeitachse, je Höhenreihe
// (nRows, unabhängig von der Zeitauflösung) — kleine Symbolgröße
// (CHART_BARB_SIZE), dafür wächst die Panelbreite mit fester Pixeldichte pro
// Stunde (siehe renderCrossSection).
function windArrows(g, field, x, y, targetH, time, nRows = 7) {
  const n = targetH.length, T = time.length;
  const stepK = Math.max(1, Math.round(n / nRows));
  for (let i = 0; i < T; i++) {
    for (let k = Math.floor(stepK / 2); k < n; k += stepK) {
      const s = field.spd[k][i], d = field.dir[k][i];
      if (!Number.isFinite(s) || !Number.isFinite(d)) continue;
      g.append(placeWindBarb(x(time[i]), y(targetH[k]), s * KT_PER_MS, d, { size: CHART_BARB_SIZE, color: INK }));
    }
  }
}

function freezingLine(g, field, x, y, hMin, hMax) {
  let d = "", pen = false, hFirst = null;
  for (let i = 0; i < field.time.length; i++) {
    const h = field.freezing[i];
    // Außerhalb des dargestellten Bandes (Zoom-Modus): Lücke statt Klemmen an den Rand.
    if (!Number.isFinite(h) || h < hMin || h > hMax) { pen = false; continue; }
    d += (pen ? "L" : "M") + x(field.time[i]).toFixed(1) + " " + y(h).toFixed(1) + " ";
    pen = true;
    if (hFirst == null) hFirst = h;
  }
  if (!d) return;
  g.append(mk("path", { d, fill: "none", stroke: "#fff", "stroke-width": 3.2 }));
  g.append(mk("path", { d, fill: "none", stroke: INK, "stroke-width": 1.4 }));
  // Beschriftung am linken Ende.
  g.append(txt(M.l + 6, y(hFirst) - 4, "0 °C", INK, 10, "start", 700));
}

function flightLine(g, y, maxHeightM, x) {
  if (!maxHeightM) return;
  const py = y(maxHeightM);
  g.append(mk("line", { x1: M.l, y1: py, x2: x.right, y2: py, stroke: "#fff", "stroke-width": 3 }));
  g.append(mk("line", { x1: M.l, y1: py, x2: x.right, y2: py, stroke: "#b5179e", "stroke-width": 1.4, "stroke-dasharray": "6 3" }));
  g.append(txt(x.right - 4, py - 4, `Max. Flughöhe ${fmtH(maxHeightM)}`, "#b5179e", 10, "end", 700));
}

// --- Achsen ----------------------------------------------------------------

function heightAxis(svg, y, hMin, hMax, x, lin) {
  const ticks = lin ? niceTicks(hMin, hMax, 6) : niceLogHeights(hMin, hMax);
  for (const hM of ticks) {
    const py = y(hM);
    svg.append(mk("line", { x1: M.l, y1: py, x2: x.right, y2: py, stroke: GRID, "stroke-width": 1, opacity: 0.5 }));
    svg.append(txt(M.l - 4, py + 3, fmtH(hM), MUTED, 10, "end"));
  }
}

function timeAxis(svg, time, x, yTop, yBot) {
  let lastDay = null;
  for (let i = 0; i < time.length; i++) {
    const d = new Date(time[i] * 1000);
    if (d.getMinutes() !== 0) continue;
    const h = d.getHours(), dayKey = d.toDateString();
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      svg.append(mk("line", { x1: x(time[i]), y1: yTop, x2: x(time[i]), y2: yBot, stroke: "#c9c8c2", "stroke-width": 1, "stroke-dasharray": "2 3" }));
      svg.append(txt(x(time[i]) + 3, 12, d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }), INK, 11, "start", 600));
    } else if (h === 6 || h === 12 || h === 18) {
      svg.append(txt(x(time[i]), 12, String(h).padStart(2, "0"), MUTED, 10, "middle"));
    }
  }
}

// --- Farbleiste ------------------------------------------------------------

function colorbar(svg, cx, top, bot, stops, labelFn, unit) {
  const N = 26, h = bot - top, cw = 11;
  const lo = stops[0][0], hi = stops[stops.length - 1][0]; // physikalische Domäne
  for (let i = 0; i < N; i++) {
    const v = hi - (hi - lo) * i / N;             // oben = hoch, physikalisch
    const yy = top + (h * i) / N;
    svg.append(mk("rect", { x: cx, y: yy.toFixed(1), width: cw, height: (h / N + 1).toFixed(1), fill: ramp(stops, v), "shape-rendering": "crispEdges" }));
  }
  svg.append(mk("rect", { x: cx, y: top, width: cw, height: h, fill: "none", stroke: MUTED, "stroke-width": 0.8 }));
  // Marken: nette Werte in der Anzeigeeinheit (Skala linear -> Position linear).
  const loD = labelFn(lo), hiD = labelFn(hi);
  for (const tD of niceTicks(Math.min(loD, hiD), Math.max(loD, hiD), 5)) {
    const yy = bot - (tD - loD) / (hiD - loD) * (bot - top);
    svg.append(txt(cx + cw + 3, yy + 3, String(Math.round(tD)), MUTED, 9, "start"));
  }
  svg.append(txt(cx + cw / 2, bot + 12, unit, MUTED, 9, "middle"));
}

// --- Helfer ----------------------------------------------------------------

export function fmtH(m) { return `${Math.round(heightToDisplay(m))} ${heightUnit()}`; }

export function niceLogHeights(hMin, hMax) {
  const cand = [30, 50, 100, 200, 300, 500, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 10000];
  return cand.filter((h) => h >= hMin && h <= hMax);
}

export function niceTicks(lo, hi, n) {
  const raw = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

function ramp(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  if (v >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [v0, c0] = stops[i - 1], [v1, c1] = stops[i];
      return mix(c0, c1, (v - v0) / (v1 - v0));
    }
  }
  return stops[stops.length - 1][1];
}
function mix(a, b, f) {
  const ca = hex(a), cb = hex(b);
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * f);
  const gg = Math.round(ca[1] + (cb[1] - ca[1]) * f);
  const bl = Math.round(ca[2] + (cb[2] - ca[2]) * f);
  return `rgb(${r},${gg},${bl})`;
}
function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function title(svg, x, y, s) { svg.append(txt(x, y, s, INK, 11, "start", 700)); }
function mk(tag, attrs) { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; }
function txt(x, y, s, fill, size, anchor = "start", weight = 400) {
  const e = mk("text", { x, y, fill, "font-size": size, "text-anchor": anchor, "font-weight": weight });
  e.textContent = s; return e;
}
