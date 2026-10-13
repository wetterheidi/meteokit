/**
 * Leaflet-Ebenen der Frontenkarte (`meteokit/fronts/map`): Feldschattierung,
 * Isolinien, Isobaren, Windpfeile, Fronten mit den üblichen Symbolen und
 * Tiefs. Leaflet wird als `L` übergeben (wie bei `meteokit/airspace`), die
 * Bibliothek selbst hat keine Abhängigkeiten.
 *
 * Alle Funktionen liefern Ebenen, ohne sie zur Karte hinzuzufügen. `pane`
 * ist der Leaflet-Pane, in den gezeichnet wird.
 */

import { isolineSegments, gaussianSmooth } from "../grid.js";
import { colorAt } from "./scales.js";

export const RED = "#d7191c", BLUE = "#1f4fd8", PURPLE = "#8e24aa";

/**
 * Feld als Bild-Overlay, in Web-Mercator aufgelöst, damit es lagerichtig ist
 * (Leaflet streckt ein ImageOverlay linear in Projektionskoordinaten).
 * Wo `below` (Geländemaske der Analysefläche) gesetzt ist, wird ein Feld
 * ohne `scale.surface` grau abgedeckt (`showMask`) bzw. ausgespart.
 */
export function fieldOverlay(L, fld, G, scale, { below, showMask = true, pane, opacity = 1 } = {}) {
  const { nx, ny, lat0, lon0, res } = G;
  const south = lat0 - res / 2, north = lat0 + (ny - 0.5) * res;
  const west = lon0 - res / 2, east = lon0 + (nx - 0.5) * res;
  const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const imerc = (y) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;
  const W = nx * 4, H = ny * 6, ys = merc(south), yn = merc(north);
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(W, H);
  for (let py = 0; py < H; py++) {
    const lat = imerc(yn - ((py + 0.5) / H) * (yn - ys));
    const j = Math.min(ny - 1, Math.max(0, Math.round((lat - lat0) / res)));
    for (let px = 0; px < W; px++) {
      const lon = west + ((px + 0.5) / W) * (east - west);
      const i = Math.min(nx - 1, Math.max(0, Math.round((lon - lon0) / res)));
      const k = j * nx + i, o = (py * W + px) * 4, v = fld[k];
      if (below?.[k] && !scale.surface) {
        if (showMask) { img.data.set([110, 110, 110, 170], o); }
        continue;
      }
      if (!Number.isFinite(v)) continue;
      const [r, g, b] = colorAt(scale, v);
      img.data.set([r, g, b, 255], o);
    }
  }
  ctx.putImageData(img, 0, 0);
  const overlay = L.imageOverlay(cv.toDataURL(), [[south, west], [north, east]], { pane, opacity });
  overlay.on("add", () => { overlay.getElement().style.imageRendering = "pixelated"; });
  return overlay;
}

/** Isolinien eines Felds im Abstand `step` über den ganzen Wertebereich. */
export function isolineLayer(L, fld, G, step, { pane, color = "#333", weight = 0.8, dashArray } = {}) {
  const group = L.layerGroup();
  let lo = Infinity, hi = -Infinity;
  for (const x of fld) if (Number.isFinite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  for (let lev = Math.ceil(lo / step) * step; lev <= hi; lev += step) {
    const segs = isolineSegments(fld, G, lev);
    if (segs.length) L.polyline(segs, { pane, color, weight, dashArray, interactive: false }).addTo(group);
  }
  return group;
}

/**
 * Isobaren des Bodendrucks alle `dp` hPa, 10er dick, 5er mittel. Leicht
 * geglättet (60 km, bei 1/2 hPa 40 km), damit Gitterrauschen keine Zacken
 * erzeugt. Fein aufgelöste Isobaren zeigen die Knicke schwacher Fronten
 * (Genuatief).
 */
export function isobarLayer(L, msl, G, dp, { pane } = {}) {
  const group = L.layerGroup();
  const p = gaussianSmooth(msl, G, dp < 5 ? 40 : 60);
  for (let lev = 950; lev <= 1060; lev += dp) {
    const segs = isolineSegments(p, G, lev);
    const major = lev % 10 === 0, mid = lev % 5 === 0;
    if (segs.length) L.polyline(segs, { pane, color: "#000", weight: major ? 1.6 : mid ? 1.1 : 0.6, opacity: mid ? 1 : 0.7, interactive: false }).addTo(group);
  }
  return group;
}

/** Windpfeile (u, v in m/s) an jedem `every`-ten Gitterpunkt, Länge ∝ Geschwindigkeit. */
export function windArrows(L, u, v, G, { color = "#000", pane, every = 3 } = {}) {
  const { nx, ny, lat0, lon0, res } = G, s = 0.04; // Grad je m/s
  const lines = [];
  for (let j = 0; j < ny; j += every) for (let i = 0; i < nx; i += every) {
    const k = j * nx + i, uu = u[k], vv = v[k];
    if (!Number.isFinite(uu) || !Number.isFinite(vv)) continue;
    const lat = lat0 + j * res, lon = lon0 + i * res, c = Math.cos((lat * Math.PI) / 180);
    const tip = [lat + vv * s, lon + (uu * s) / c];
    const ang = Math.atan2(vv, uu), hl = 0.35 * Math.hypot(uu, vv) * s;
    const head = (da) => [tip[0] - hl * Math.sin(ang + da), tip[1] - (hl * Math.cos(ang + da)) / c];
    lines.push([[lat, lon], tip], [head(0.5), tip, head(-0.5)]);
  }
  return L.polyline(lines, { pane, color, weight: 1, interactive: false });
}

// Frontsymbole in km-Geometrie um einen Punkt (lat, lon): t = Tangente,
// nrm = Normale zur Symbolseite, beide als Einheitsvektoren (Ost, Nord).
const KM_PER_DEG = 111.2;
const offset = (p, dxKm, dyKm) => [p[0] + dyKm / KM_PER_DEG, p[1] + dxKm / (KM_PER_DEG * Math.cos((p[0] * Math.PI) / 180))];
function triangle(p, t, nrm, size) {
  return [offset(p, -t[0] * size * 0.6, -t[1] * size * 0.6), offset(p, t[0] * size * 0.6, t[1] * size * 0.6), offset(p, nrm[0] * size, nrm[1] * size)];
}
function semicircle(p, t, nrm, size) {
  const r = size * 0.55, pts = [];
  for (let a = 0; a <= Math.PI + 1e-9; a += Math.PI / 10) {
    pts.push(offset(p, r * (Math.cos(a) * t[0] + Math.sin(a) * nrm[0]), r * (Math.cos(a) * t[1] + Math.sin(a) * nrm[1])));
  }
  return pts;
}

/**
 * Eine Front mit Symbolen (alle ~250 km) in `layer` zeichnen. `ll`: Punkte
 * [lat, lon]; `pr`: front_type, activity_class, warm_side, motion_side (wie
 * detectFronts). Schwache Fronten gestrichelt, Okklusionen violett mit
 * abwechselnden Symbolen, quasistationäre rot/blau. Gibt die Hauptlinie
 * zurück (für Tooltip/Klick).
 */
export function addFront(L, layer, ll, pr, { tip, onClick, bubbling = true, pane } = {}) {
  const base = { pane, weight: 3, bubblingMouseEvents: bubbling, ...(pr.activity_class === "weak" ? { dashArray: "10 8" } : {}) };
  let main;
  if (pr.front_type === "stationary") {
    main = L.polyline(ll, { ...base, color: RED }).addTo(layer);
    L.polyline(ll, { ...base, color: BLUE, dashArray: "14 14", interactive: false }).addTo(layer);
  } else {
    const color = pr.front_type === "cold" ? BLUE : pr.front_type === "occluded" ? PURPLE : RED;
    main = L.polyline(ll, { ...base, color }).addTo(layer);
  }
  if (tip) main.bindTooltip(tip);
  if (onClick) main.on("click", onClick);
  // Seite aus motion_side bzw. warm_side.
  const sideSign = (side) => (side === "left" ? 1 : -1);
  let acc = 125, n = 0;
  for (let m = 1; m < ll.length; m++) {
    const a = ll[m - 1], b = ll[m], c = Math.cos((a[0] * Math.PI) / 180);
    const dx = (b[1] - a[1]) * KM_PER_DEG * c, dy = (b[0] - a[0]) * KM_PER_DEG, d = Math.hypot(dx, dy);
    if (!(d > 0)) continue;
    const t = [dx / d, dy / d], left = [-t[1], t[0]];
    for (; acc <= d; acc += 250, n++) {
      const p = [a[0] + (b[0] - a[0]) * (acc / d), a[1] + (b[1] - a[1]) * (acc / d)];
      let kind = pr.front_type, side = pr.motion_side, fill = null;
      if (kind === "occluded") { kind = n % 2 ? "warm" : "cold"; fill = PURPLE; } // abwechselnd, gleiche Seite
      else if (kind === "stationary") {
        kind = n % 2 ? "warm" : "cold";
        side = kind === "cold" ? pr.warm_side : (pr.warm_side === "left" ? "right" : "left");
      }
      const s = sideSign(side), nrm = [left[0] * s, left[1] * s];
      const poly = kind === "cold" ? triangle(p, t, nrm, 55) : semicircle(p, t, nrm, 55);
      L.polygon(poly, { pane, stroke: false, fillColor: fill || (kind === "cold" ? BLUE : RED), fillOpacity: 1, interactive: false }).addTo(layer);
    }
    acc -= d;
  }
  return main;
}

/** [lat, lon]-Punkte eines GeoJSON-LineString-Features. */
export const featureLatLngs = (f) => f.geometry.coordinates.map(([lo, la]) => [la, lo]);

const fmt2 = (x) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(2));

/**
 * Tooltip (HTML) einer automatisch gefundenen Front mit allen Kriterien.
 * `fgMean`: mittlere Frontogenese entlang der Linie (meanAlong), optional.
 */
export function frontTooltip(pr, { fgMean = null } = {}) {
  const cr = pr.criteria;
  return `${pr.front_type}  ${pr.length_km} km` + (pr.activity_class ? `  <b>${pr.activity_class}</b> (Aktivität ${pr.activity})` : "")
    + (pr.method === "stau" ? `<br><i>schleift am Gebirgsrand</i> (Stau: Druckanstieg ${cr?.tendency_rim} hPa/3 h, RR ${cr?.precip} mm/h)` : "")
    + (pr.method === "precip" ? `<br><i>aus Niederschlagsachse</i>, RR ${cr?.precip} mm/h, Advektion ${cr?.advection_k10h} K/10 h` : "")
    + (pr.unlinked ? "<br><b>ohne Anschluss an einen Tiefkern</b> (entfällt)" : "")
    + (pr.bridge ? "<br><b>Brücke</b>: ohne Wetter, verbindet die Front mit dem Tief (frontolytisch)" : "")
    + (pr.duplicate ? "<br><b>Doppellinie</b> neben einer stärkeren Front (entfällt)" : "")
    + `<br>|∇θw| ${pr.gradient}  TFP ${pr.tfp}  Querwind ${pr.cross_wind} m/s`
    + `<br>Frontogenese Ø ${fmt2(fgMean)} K/(100 km · 3 h)`
    + (cr ? `<br>ΔT850 ${cr.contrast_k} K  Rinne ${cr.trough}  Konv. ${cr.convergence}  Vort. ${cr.vorticity}`
      + `<br>Tendenzsprung ${cr.tendency_jump} hPa/3h  RR ${cr.precip} mm/h  tiefe Wolken ${cr.cloud_low} %  w700 ${cr.w700} cm/s`
      + `<br>Rinne ~${cr.sfc_offset_km} km zur warmen Seite` + (pr.surface_offset_km != null ? `, verschoben um ${pr.surface_offset_km} km` : "") : "");
}

/**
 * Fronten einer detectFronts-Ausgabe in `layer`. Linien ohne Wetter
 * (`activity_class: "none"`) nur mit `showInactive`, grau gepunktet.
 * `fgMean(ll)` liefert optional die Frontogenese für den Tooltip.
 */
export function addAutoFronts(L, layer, fc, { pane, showInactive = false, fgMean } = {}) {
  for (const f of fc.features) {
    const pr = f.properties, ll = featureLatLngs(f);
    const tip = frontTooltip(pr, { fgMean: fgMean?.(ll) ?? null });
    if (pr.activity_class === "none") {
      if (showInactive) L.polyline(ll, { pane, color: "#888", weight: 2, dashArray: "2 6" }).bindTooltip(tip).addTo(layer);
      continue;
    }
    addFront(L, layer, ll, pr, { tip, pane });
  }
}

/**
 * Tiefzentren (Bodendruck) als rotes T mit Kerndruck in `layer`;
 * Zentraltiefs (Achse zum 500-hPa-Tief senkrecht) mit Ring.
 */
export function addLows(L, layer, lows, { pane } = {}) {
  for (const l of lows || []) {
    const ring = l.central ? "border:2px solid #d7191c;border-radius:50%;padding:2px 4px;" : "";
    L.marker([l.lat, l.lon], {
      pane,
      icon: L.divIcon({ className: "", iconSize: [40, 30], iconAnchor: [20, 15],
        html: `<div style="text-align:center;color:#d7191c;font:bold 20px/1 sans-serif;${ring}">T<div style="font-size:11px">${Math.round(l.pressure)}</div></div>` }),
    }).bindTooltip(`Tief ${l.pressure} hPa, Tiefe ${l.depth} hPa<br>Achse zum 500-hPa-Tief: ${l.tilt_km == null ? "kein geschlossenes Höhentief" : `${l.tilt_km} km`}`
      + (l.central ? "<br><b>Zentraltief</b>: niedrigere Kontrastschwellen bis 1800 km" : "")).addTo(layer);
  }
}
