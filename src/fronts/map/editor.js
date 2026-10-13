/**
 * Handanalyse (`meteokit/fronts/map`): Fronten auf der Karte zeichnen und
 * bearbeiten. Eine Linie ist { type, weak, warm, cps }: Typ, schwach
 * (gestrichelt), Seite der warmen Luft in Punktreihenfolge ("left"/"right"),
 * Stützpunkte [lat, lon]. Gezeichnet wird ein Spline durch die Stützpunkte
 * ("wie Segel").
 *
 * Wo Entwürfe und Referenzen gespeichert werden, entscheidet die Seite: der
 * Editor meldet jede Änderung über `onChange` und nimmt Linien über
 * `setLines` entgegen. Die reinen Hilfsfunktionen (spline, decimate,
 * linesFromGeoJSON, lineFeatures) brauchen kein DOM.
 */

import { distKm } from "../grid.js";
import { addFront } from "./layers.js";

export const flipSide = (s) => (s === "left" ? "right" : "left");

/**
 * Centripetaler Catmull-Rom-Spline (keine Schleifen bei ungleichen
 * Abständen), lokal metrisch. seg[k]: Abschnitt, zu dem Punkt k gehört.
 */
export function spline(cps, per = 12) {
  if (cps.length < 3) return { ll: cps.map((p) => p.slice()), seg: cps.map((_, i) => Math.max(0, Math.min(i, cps.length - 2))) };
  const c = Math.cos((cps[0][0] * Math.PI) / 180);
  const P = cps.map(([la, lo]) => [lo * c, la]);
  const refl = (a, b) => [2 * a[0] - b[0], 2 * a[1] - b[1]];
  const tj = (a, b) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const ll = [], seg = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p1 = P[i], p2 = P[i + 1];
    const p0 = i > 0 ? P[i - 1] : refl(p1, p2), p3 = i < P.length - 2 ? P[i + 2] : refl(p2, p1);
    const t0 = 0, t1 = t0 + tj(p0, p1), t2 = t1 + tj(p1, p2), t3 = t2 + tj(p2, p3);
    for (let k = 0; k < per; k++) {
      const u = t1 + ((t2 - t1) * k) / per;
      const L = (a, b, ta, tb) => [0, 1].map((d) => ((tb - u) * a[d] + (u - ta) * b[d]) / (tb - ta));
      const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
      const v = L(L(A1, A2, t0, t2), L(A2, A3, t1, t3), t1, t2);
      ll.push([v[1], v[0] / c]); seg.push(i);
    }
  }
  ll.push(cps[cps.length - 1].slice()); seg.push(P.length - 2);
  return { ll, seg };
}

/** Stützpunkte etwa alle stepKm aus einer dichten Linie (Endpunkte bleiben). */
export function decimate(ll, stepKm = 150) {
  const out = [ll[0]];
  let acc = 0;
  for (let i = 1; i < ll.length - 1; i++) {
    acc += distKm(ll[i - 1], ll[i]);
    if (acc >= stepKm) { out.push(ll[i]); acc = 0; }
  }
  if (out.length > 1 && distKm(out[out.length - 1], ll[ll.length - 1]) < stepKm / 2) out.pop();
  out.push(ll[ll.length - 1]);
  return out.map((p) => p.slice());
}

/**
 * Eigenschaften im Format von detectFronts. Symbole zeigen in Zugrichtung:
 * Kaltfront und Okklusion zur warmen Luft, Warmfront zur kalten.
 */
export function lineProps(ln) {
  const motion = ln.type === "cold" || ln.type === "occluded" ? ln.warm : ln.type === "warm" ? flipSide(ln.warm) : null;
  return { front_type: ln.type, activity_class: ln.weak ? "weak" : "active", warm_side: ln.warm, motion_side: motion };
}

/** Linien als GeoJSON-Features (Spline als Geometrie, Stützpunkte in control_points). */
export function lineFeatures(lines) {
  const r3 = ([la, lo]) => [+lo.toFixed(3), +la.toFixed(3)];
  return lines.map((ln) => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: spline(ln.cps).ll.map(r3) },
    properties: { ...lineProps(ln), control_points: ln.cps.map(r3) },
  }));
}

/**
 * Linien aus GeoJSON: eigene Referenzen (mit control_points) und ebenso
 * exportierte Automatik-Analysen (dann werden Stützpunkte ausgedünnt).
 * `warmSide(ll)` bestimmt die warme Seite, wo sie fehlt.
 */
export function linesFromGeoJSON(fc, warmSide = () => "left") {
  return (fc.features || [])
    .filter((f) => f.geometry?.type === "LineString" && f.properties?.activity_class !== "none")
    .map((f) => {
      const pr = f.properties;
      const cps = pr.control_points ? pr.control_points.map(([lo, la]) => [la, lo]) : decimate(f.geometry.coordinates.map(([lo, la]) => [la, lo]));
      return { type: pr.front_type || "cold", weak: pr.activity_class === "weak", warm: pr.warm_side || warmSide(cps), cps };
    });
}

/**
 * Editor auf einer Leaflet-Karte.
 *
 * @param {object} L        Leaflet
 * @param {object} map      L.Map
 * @param {object} [opts]
 * @param {string} [opts.pane]                Pane der Linien.
 * @param {Function} [opts.warmSide]          (ll) => "left"|"right" für neue Linien.
 * @param {Function} [opts.newLine]           () => ({ type, weak }) für neue Linien.
 * @param {Function} [opts.onChange]          (lines) => void nach jeder Änderung.
 * @param {Function} [opts.onState]           ({ selected, canUndo, drawing }) => void,
 *   wenn sich Auswahl, Undo-Stapel oder Zeichenmodus ändern (Knöpfe).
 * @param {boolean} [opts.keyboard=true]      Enter/Esc/Entf/Strg+Z auf dem Dokument.
 */
export function createFrontEditor(L, map, {
  pane, warmSide = () => "left", newLine = () => ({ type: "cold", weak: false }),
  onChange = () => {}, onState = () => {}, keyboard = true,
} = {}) {
  let lines = [], sel = -1, drawing = null, undoStack = [], visible = true;
  let layer = null, handles = null, preview = null;

  const state = () => onState({ selected: lines[sel] || null, canUndo: undoStack.length > 0, drawing: !!drawing });
  const pushUndo = () => { undoStack.push(JSON.stringify(lines)); if (undoStack.length > 100) undoStack.shift(); };

  function renderLines() {
    layer?.remove(); layer = L.layerGroup();
    if (visible) {
      lines.forEach((ln, i) => {
        const { ll } = spline(ln.cps);
        if (i === sel) L.polyline(ll, { pane, color: "#ffd400", weight: 11, opacity: 0.6, interactive: false }).addTo(layer);
        addFront(L, layer, ll, lineProps(ln), { onClick: (e) => lineClick(i, e), bubbling: !!drawing, pane });
      });
      for (const p of drawing?.cps || []) {
        L.circleMarker(p, { pane, radius: 4, color: "#000", weight: 1, fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(layer);
      }
    }
    layer.addTo(map);
  }

  function renderHandles() {
    handles?.remove(); handles = L.layerGroup();
    const ln = lines[sel];
    if (ln && visible) {
      ln.cps.forEach((p, k) => {
        const m = L.marker(p, { draggable: true, icon: L.divIcon({ className: "cp", iconSize: [12, 12] }) });
        m.on("dragstart", pushUndo);
        m.on("drag", (e) => { const q = e.target.getLatLng(); ln.cps[k] = [q.lat, q.lng]; renderLines(); });
        m.on("dragend", () => { onChange(lines); state(); });
        m.on("contextmenu", (e) => {
          L.DomEvent.preventDefault(e.originalEvent);
          if (ln.cps.length > 2) { pushUndo(); ln.cps.splice(k, 1); changed(); }
        });
        m.addTo(handles);
      });
    }
    handles.addTo(map);
  }

  function changed() { onChange(lines); renderLines(); renderHandles(); state(); }

  function select(i) {
    sel = i;
    renderLines(); renderHandles(); state();
  }

  function lineClick(i, e) {
    if (drawing) return; // der Klick läuft zur Karte weiter und setzt dort einen Punkt
    if (sel !== i) { select(i); return; }
    // Ausgewählte Linie angeklickt: Stützpunkt im passenden Abschnitt einfügen.
    const p = [e.latlng.lat, e.latlng.lng], { ll, seg } = spline(lines[i].cps);
    let best = 0, bd = Infinity;
    ll.forEach((q, k) => { const d = distKm(p, q); if (d < bd) { bd = d; best = k; } });
    pushUndo(); lines[i].cps.splice(seg[best] + 1, 0, p); changed();
  }

  function startDrawing() {
    if (drawing) { finishDrawing(); return; }
    sel = -1; renderHandles();
    drawing = { cps: [] };
    preview = L.polyline([], { pane, color: "#000", weight: 2, dashArray: "4 4", interactive: false }).addTo(map);
    map.doubleClickZoom.disable();
    map.getContainer().style.cursor = "crosshair";
    renderLines(); state();
  }

  function finishDrawing(cancel = false) {
    const d = drawing;
    if (!d) return;
    drawing = null;
    preview?.remove(); preview = null;
    map.doubleClickZoom.enable();
    map.getContainer().style.cursor = "";
    if (!cancel && d.cps.length >= 2) {
      pushUndo();
      const ln = { ...newLine(), cps: d.cps };
      ln.warm = warmSide(spline(ln.cps).ll);
      lines.push(ln); sel = lines.length - 1;
      changed();
    } else { renderLines(); state(); }
  }

  function deleteSelected() {
    if (sel < 0) return;
    pushUndo(); lines.splice(sel, 1); sel = -1; changed();
  }

  function undo() {
    if (!undoStack.length) return;
    lines = JSON.parse(undoStack.pop()); sel = -1; changed();
  }

  // Ausgewählte Linie ändern (Typ, schwach, Seite).
  function updateSelected(fn) {
    const ln = lines[sel];
    if (!ln) return;
    pushUndo(); fn(ln); changed();
  }

  map.on("click", (e) => {
    if (drawing) {
      const p = [e.latlng.lat, e.latlng.lng], c = drawing.cps;
      if (!c.length || distKm(c[c.length - 1], p) > 10) c.push(p); // Doppelklick setzt keinen zweiten Punkt
      renderLines();
    } else if (sel >= 0) select(-1);
  });
  map.on("dblclick", (e) => { if (drawing) { L.DomEvent.stop(e); finishDrawing(); } });
  map.on("mousemove", (e) => {
    if (drawing?.cps.length) preview.setLatLngs(spline([...drawing.cps, [e.latlng.lat, e.latlng.lng]]).ll);
  });
  if (keyboard) {
    document.addEventListener("keydown", (e) => {
      if (e.target.matches("input, select, textarea")) return;
      if (e.key === "Enter" && drawing) finishDrawing();
      else if (e.key === "Escape") { if (drawing) finishDrawing(true); else select(-1); }
      else if ((e.key === "Delete" || e.key === "Backspace") && sel >= 0) { e.preventDefault(); deleteSelected(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
    });
  }

  return {
    get lines() { return lines; },
    get selected() { return lines[sel] || null; },
    get drawing() { return !!drawing; },
    /** Linien ersetzen (Laden eines Termins): Auswahl und Undo-Stapel leeren, kein onChange. */
    setLines(next) {
      if (drawing) finishDrawing(true);
      lines = next; sel = -1; undoStack = [];
      renderLines(); renderHandles(); state();
    },
    /** Linien ersetzen wie eine Bearbeitung (mit Undo und onChange), z. B. Datei laden. */
    replaceLines(next) { pushUndo(); lines = next; sel = -1; changed(); },
    startDrawing, finishDrawing, deleteSelected, undo, select,
    setType(type) { updateSelected((ln) => { ln.type = type; }); },
    setWeak(weak) { updateSelected((ln) => { ln.weak = weak; }); },
    flipSelected() { updateSelected((ln) => { ln.warm = flipSide(ln.warm); }); },
    clear() { pushUndo(); lines = []; sel = -1; changed(); },
    /** Aktive und schwache Fronten einer detectFronts-Ausgabe übernehmen (ohne Doppelte). */
    importFronts(fc) {
      pushUndo();
      const same = (a, b) => a.length === b.length && a.every((p, i) => distKm(p, b[i]) < 1);
      for (const f of fc.features) {
        const pr = f.properties;
        if (pr.activity_class === "none") continue;
        const cps = decimate(f.geometry.coordinates.map(([lo, la]) => [la, lo]));
        if (lines.some((ln) => same(ln.cps, cps))) continue;
        lines.push({ type: pr.front_type, weak: pr.activity_class === "weak", warm: pr.warm_side, cps });
      }
      sel = -1; changed();
    },
    /** Sichtbarkeit der Handanalyse. */
    setVisible(v) { visible = v; renderLines(); renderHandles(); },
    /** Neu zeichnen, z. B. damit die Handanalyse über einer neu gezeichneten Automatik liegt. */
    redraw() { if (layer) renderLines(); },
    /** Linien als { type, ll } (Spline) für compareFronts. */
    compareLines() { return lines.map((ln) => ({ type: ln.type, ll: spline(ln.cps).ll })); },
  };
}
