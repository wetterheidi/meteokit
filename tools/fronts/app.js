import { thetaFields } from "../../src/fronts/thermo.js";
import { isolineSegments, chainSegments, sampleBilinear } from "../../src/fronts/grid.js";
import { compareFronts, fcToLines } from "./compare.js";
import { detectFronts, frontFields, DETECT_DEFAULTS } from "../../src/fronts/detect.js";
import { frontogenesis } from "../../src/fronts/frontogenesis.js";
import { fieldAt } from "../../src/fronts/field.js";
import { typedCase, mergeCases, attachUpper } from "../../src/fronts/cases.js";
import {
  SCALES, paintScale, scaleTicks, gridOf, prevField, thermoDerived, caseDerived, geopotentialLevel, kinkLines, meanAlong,
  fieldOverlay, isolineLayer, isobarLayer, windArrows, addAutoFronts, addLows,
  createFrontEditor, lineFeatures, linesFromGeoJSON,
} from "../../src/fronts/map/index.js";

/**
 * Synoptix (tools/fronts/index.html): Frontenanalyse auf der Karte. Mit
 * ?debug=1 (debug.html leitet dorthin) als „Fronten-Debug“ mit zusätzlichen
 * Werkzeugen für die Abstimmung der Automatik (Elemente .debug-only).
 */
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEBUG = params.has("debug");
if (DEBUG) { document.body.classList.add("debug"); document.title = "Fronten-Debug"; $("title").textContent = "Fronten-Debug"; }
$("fixture").value = params.get("fixture") || "latest";

// Schattierungen als Knopfraster, nach Themen. [Schlüssel, Knopf, Name mit Einheit];
// "{p}" steht für die gewählte Druckfläche.
const FIELD_GROUPS = [
  ["{p}", [["thE", "θe", "θe [°C]"], ["thW", "θw", "θw [°C]"], ["T", "T", "Temperatur [°C]"],
    ["grad", "|∇θw|", "|∇θw| [K/100 km]"], ["tfp", "TFP", "TFP [K/(100 km)²]"], ["fg", "Frontog.", "Frontogenese nach Petterssen [K/(100 km · 3 h)]"]]],
  ["Boden", [["tend", "Δp 3 h", "Drucktendenz 3 h [hPa]"], ["precip", "RR", "Niederschlag [mm/h]"],
    ["cloud", "N", "Gesamtbewölkung [%]"], ["cloudLow", "N tief", "tiefe Wolken [%]"]]],
  ["700 hPa", [["w700", "w", "Vertikalwind 700 hPa [cm/s]"], ["spread700", "Spread", "Spread 700 hPa [K]"]]],
  ["Höhe", [["thk", "Dicke", "Schichtdicke 500/1000 hPa [gpdm]"], ["z500", "Z500", "Geopotential 500 hPa [gpdm]"],
    ["pva", "PVA", "Vorticity-Advektion 500 hPa [10⁻⁹ s⁻²]"], ["zeta500", "ζ500", "Vorticity 500 hPa [10⁻⁵ s⁻¹]"],
    ["vortTend", "Δζ 3 h", "Vorticity-Änderung 3 h, {p} [10⁻⁵ s⁻¹]"]]],
];
const FIELDS = FIELD_GROUPS.flatMap(([, list]) => list);

// Anzeige-Einstellungen im Browser merken (localStorage, getrennt für
// Synoptix und Debug-Seite). Nicht gespeichert werden die Analyseparameter
// (σ, K1, K2 …), sonst überstimmte ein alter Wert still geänderte Vorgaben
// der Automatik, und Datenquelle/Termin (Start immer mit dem neuesten Termin).
const SETTINGS_KEY = DEBUG ? "synoptix-settings:debug" : "synoptix-settings";
const CHECKS = ["mergeGlobal", "wind", "wind10", "fronts", "precipFronts", "inactive", "ridges", "kinks", "cand", "edShow"];
const saved = (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })();
const validField = (k) => FIELDS.some(([key]) => key === k);
let fieldKey = validField(params.get("field")) ? params.get("field") : validField(saved.field) ? saved.field : "thE";
for (const id of CHECKS) if (typeof saved.checks?.[id] === "boolean") $(id).checked = saved.checks[id];
if (Number.isFinite(saved.opacity)) $("opacity").value = saved.opacity;
if (saved.detailsOpen) document.querySelector("details").open = true;
let settingsReady = false; // erst nach dem ersten Laden speichern
function saveSettings() {
  if (!settingsReady) return;
  const out = {
    v: 1, field: fieldKey, pres: $("presSel").value || saved.pres, opacity: Number($("opacity").value),
    checks: Object.fromEntries(CHECKS.map((id) => [id, $(id).checked])),
    iso: Object.fromEntries(ISO.map((d) => [d.key, { on: $(`iso_${d.key}`).checked, step: Number($(`isoStep_${d.key}`).value) }])),
    detailsOpen: document.querySelector("details").open,
    hoverCollapsed: document.querySelector(".hoverbox")?.classList.contains("collapsed") || false,
  };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(out)); } catch { /* ohne Speicher nur für diese Sitzung */ }
}

// Isolinien: beliebig viele zugleich, je mit eigenem Abstand und Stil.
const ISO = [
  { key: "msl", label: "Isobaren (Boden)", unit: "hPa", step: 5, on: true, color: "#000", isobar: true },
  { key: "zLev", label: "Isohypsen {p}", unit: "gpdm", step: 4, color: "#00695c", weight: 1.1 },
  { key: "thE", label: "θe {p}", unit: "K", step: 3, on: true, color: "#333", weight: 0.8 },
  { key: "thW", label: "θw {p}", unit: "K", step: 1, color: "#666", weight: 0.8, dashArray: "4 3" },
  { key: "thk", label: "Schichtdicke 500/1000", unit: "gpdm", step: 4, color: "#c62828", weight: 1, dashArray: "6 4" },
  { key: "z500", label: "Z500", unit: "gpdm", step: 4, color: "#283593", weight: 1.2 },
];
for (const d of ISO) {
  const sv = saved.iso?.[d.key];
  if (typeof sv?.on === "boolean") d.on = sv.on;
  if (sv?.step > 0) d.step = sv.step;
}
const plev = () => `${$("presSel").value || 850} hPa`;
const withP = (s) => s.replace("{p}", plev());
// Ablage der laufenden Analyse (run-analysis.mjs --out …), relativ zur Seite.
const LIVE = (params.get("live") || "live/").replace(/\/?$/, "/");
const FALLBACK_FIXTURE = "fixtures/icon_eu_2026-10-09.json.gz";
$("sigma").value = DETECT_DEFAULTS.sigmaKm; // Glättung wie die Bibliothek (90 km)
$("k1").value = DETECT_DEFAULTS.k1; $("k2").value = DETECT_DEFAULTS.k2;
$("minLen").value = DETECT_DEFAULTS.minLengthKm; $("windMin").value = DETECT_DEFAULTS.windMin;

const map = L.map("map", { preferCanvas: true }).setView([52, 8], 4);
map.createPane("field").style.zIndex = 350;
map.createPane("geo").style.zIndex = 410;
map.createPane("lines").style.zIndex = 420;
const pane = "lines";

// Küsten und Ländergrenzen als Vektorlinien (Natural Earth 1:50 Mio. via
// world-atlas) statt Kachelkarte -- kein API-Key, und die Felder bleiben wie
// auf einer Wetterkarte gut lesbar.
fetch("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json")
  .then((r) => r.json())
  .then((topo) => {
    const obj = topo.objects.countries;
    const style = (weight) => ({ pane: "geo", color: "#000", weight, interactive: false });
    L.geoJSON(topojson.mesh(topo, obj, (a, b) => a === b), { style: style(1) }).addTo(map);
    L.geoJSON(topojson.mesh(topo, obj, (a, b) => a !== b), { style: { ...style(0.6), dashArray: "3 3" } }).addTo(map);
    map.attributionControl.addAttribution("Grenzen: Natural Earth");
  })
  .catch((err) => console.warn("Grenzen nicht geladen:", err));

let F = null, G = null, TH = null, overlay = null, windLayer = null, derived = null;
let frontLayer = null, fronts = null, FF = null, FG = null, CASE = null, wind10Layer = null;
const isoLayers = {};

// Knopfraster der Schattierungen.
function buildFieldGrid() {
  $("fieldGrid").innerHTML = FIELD_GROUPS.map(([group, list]) => `<div class="fgroup"><span class="gname">${withP(group)}</span><span class="btns">${
    list.map(([key, short, name]) => `<button class="fbtn${key === fieldKey ? " on" : ""}" data-key="${key}" title="${withP(name)}">${short}</button>`).join("")}</span></div>`).join("");
  $("fieldName").textContent = withP(FIELDS.find(([k]) => k === fieldKey)[2]);
}
function setField(key) {
  fieldKey = key;
  for (const b of $("fieldGrid").querySelectorAll(".fbtn")) b.classList.toggle("on", b.dataset.key === key);
  $("fieldName").textContent = withP(FIELDS.find(([k]) => k === key)[2]);
  params.set("field", key); history.replaceState(null, "", `?${params}`);
  saveSettings();
  if (derived) drawField();
}
$("fieldGrid").addEventListener("click", (e) => { const b = e.target.closest(".fbtn"); if (b) setField(b.dataset.key); });
// Tasten , und . schalten zurück bzw. vor (nicht in Eingabefeldern).
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key !== "," && e.key !== ".") return;
  const i = FIELDS.findIndex(([k]) => k === fieldKey), n = FIELDS.length;
  setField(FIELDS[(i + (e.key === "." ? 1 : n - 1)) % n][0]);
});

// Isolinienliste: Häkchen, Abstand, Einheit, Linienstil.
function buildIsoList() {
  $("isoList").innerHTML = ISO.map((d) => `<div class="iso">
    <label class="chk"><input type="checkbox" id="iso_${d.key}"${d.on ? " checked" : ""}> <span class="isoname" data-key="${d.key}">${withP(d.label)}</span></label>
    <input type="number" id="isoStep_${d.key}" value="${d.step}" min="0.5" step="${d.step >= 2 ? 1 : 0.5}" title="Abstand">
    <span class="unit">${d.unit}</span>
    <span class="swatch" style="border-top: ${d.isobar ? 2 : 2}px ${d.dashArray ? "dashed" : "solid"} ${d.color}"></span></div>`).join("");
  for (const d of ISO) {
    $(`iso_${d.key}`).onchange = () => drawIso(d);
    $(`isoStep_${d.key}`).onchange = () => drawIso(d);
  }
}
const updatePlevLabels = () => {
  for (const el of document.querySelectorAll(".plev")) el.textContent = plev();
  for (const el of document.querySelectorAll(".isoname")) el.textContent = withP(ISO.find((d) => d.key === el.dataset.key).label);
  buildFieldGrid();
};

// Werte unter der Maus: Kasten unten links auf der Karte, einklappbar.
const HoverBox = L.Control.extend({
  options: { position: "bottomleft" },
  onAdd() {
    const div = L.DomUtil.create("div", "hoverbox");
    div.innerHTML = `<div class="hb-head">Werte ▾</div><pre id="hover">Maus über die Karte …</pre>`;
    L.DomEvent.disableClickPropagation(div);
    const head = div.querySelector(".hb-head");
    const show = (collapsed) => { div.classList.toggle("collapsed", collapsed); head.textContent = collapsed ? "Werte ▸" : "Werte ▾"; };
    show(!!saved.hoverCollapsed);
    head.onclick = () => { show(!div.classList.contains("collapsed")); saveSettings(); };
    return div;
  },
});
new HoverBox().addTo(map);
buildFieldGrid();
buildIsoList();

// Fixture v1 (ein Termin, eine Fläche) in die v2-Form heben, damit alles
// über fieldAt() läuft.
function asCase(fx) {
  if (fx.version === 2) return fx;
  return {
    version: 2, model: fx.model, res: fx.res, lat0: fx.lat0, lon0: fx.lon0, nx: fx.nx, ny: fx.ny,
    pressures: [fx.pressure], stepH: 3, times: [fx.validTime], lastRunAtFetch: fx.lastRunAtFetch,
    steps: [{ validTime: fx.validTime, leadH: null, levels: { [fx.pressure]: { T: fx.T, q: fx.q, u: fx.u, v: fx.v, below: fx.below } }, psfc: fx.psfc, sfc: {} }],
  };
}

async function fetchCase(url) {
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const body = url.endsWith(".gz") ? new Response(resp.body.pipeThrough(new DecompressionStream("gzip"))) : resp;
  return typedCase(asCase(await body.json()));
}

// Archivierte Termine der laufenden Analyse in die Auswahlliste (neueste zuerst).
const STATUS = { final: "endgültig", preliminary: "vorläufig, ICON Global aus Vorlauf" };
const runLabel = (r) => `Analyse ${r.analysis_time.slice(8, 10)}.${r.analysis_time.slice(5, 7)}. ${r.analysis_time.slice(11, 13)} UTC (${STATUS[r.status] ?? r.status})`;
async function listRuns() {
  try {
    const r = await fetch(`${LIVE}index.json`, { cache: "no-store" });
    if (!r.ok) return;
    const html = (await r.json()).runs.map((run) =>
      `<option value="${LIVE}runs/${run.id}/icon_eu_${run.id}.json.gz">${runLabel(run)}</option>`).join("");
    $("fixtures").querySelector('option[value="latest"]').insertAdjacentHTML("afterend", html);
  } catch { /* ohne laufende Analyse nur die Fixtures */ }
}

// "latest" -> ICON-EU-Datei des neuesten Termins; null, wenn es keinen gibt.
async function resolveLatest() {
  try {
    const r = await fetch(`${LIVE}latest.json`, { cache: "no-store" });
    if (!r.ok) return null;
    const latest = await r.json();
    return `${LIVE}${latest.path}icon_eu_${latest.id}.json.gz`;
  } catch { return null; }
}

// Metadaten eines Termins der laufenden Analyse (run.json im selben Ordner).
async function runMeta(url) {
  if (!/\/runs\/[^/]+\/icon_eu_[^/]+$/.test(url)) return null;
  try {
    const r = await fetch(url.replace(/[^/]+$/, "run.json"), { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

let RUN = null;
async function load() {
  const choice = $("fixture").value;
  let url = choice;
  if (choice === "latest") {
    url = await resolveLatest();
    if (!url) { $("meta").textContent = `Keine laufende Analyse unter ${LIVE}, lade ${FALLBACK_FIXTURE}`; url = FALLBACK_FIXTURE; }
  }
  $("meta").textContent = `lade ${url} …`;
  CASE = await fetchCase(url);
  if (!CASE) { $("meta").textContent = `Fehler beim Laden: ${url}`; return; }
  RUN = await runMeta(url);
  const glUrl = url.replace("icon_eu_", "icon_global_");
  if ($("mergeGlobal").checked && glUrl !== url) {
    const gl = await fetchCase(glUrl);
    if (gl) CASE = mergeCases(CASE, gl);
  }
  // Höhenwind (500 hPa) aus der Zusatz-Fixture gleichen Namens, falls vorhanden,
  // als levels[500] an die Termine hängen (nicht als wählbare Analysefläche).
  const upUrl = url.replace(/icon_eu_/, "icon_eu_upper_");
  if (upUrl !== url) {
    let up = await fetchCase(upUrl);
    if (up && $("mergeGlobal").checked && glUrl !== url) {
      const upGl = await fetchCase(upUrl.replace("icon_eu_upper_", "icon_global_upper_"));
      up = upGl ? mergeCases(up, upGl) : null;
    }
    attachUpper(CASE, up);
  }
  $("stepSel").innerHTML = CASE.steps.map((st, n) =>
    `<option value="${n}">${st.validTime.replace("T", " ")} UTC${st.leadH ? ` (+${st.leadH} h)` : st.leadH === 0 ? " (Analyse)" : ""}</option>`).join("");
  const keepPres = $("presSel").value || String(saved.pres || "");
  $("presSel").innerHTML = CASE.pressures.map((p) => `<option value="${p}">${p} hPa</option>`).join("");
  if (CASE.pressures.map(String).includes(keepPres)) $("presSel").value = keepPres;
  // Laufende Analyse: auf den Analysetermin springen (der erste Termin ist
  // nur der Vortermin für die Drucktendenz), außer ?step= sagt etwas anderes.
  const want = (params.get("fixture") === choice && params.get("step")) || RUN?.analysis_time;
  const idx = CASE.steps.findIndex((st) => st.validTime === want);
  $("stepSel").value = String(idx >= 0 ? idx : CASE.steps.findIndex((st) => st.validTime.endsWith("T00:00")) >= 0
    ? CASE.steps.findIndex((st) => st.validTime.endsWith("T00:00")) : 0);
  params.set("fixture", choice); history.replaceState(null, "", `?${params}`);
  selectStep();
}

function selectStep() {
  const n = Number($("stepSel").value), p = Number($("presSel").value);
  F = fieldAt(CASE, n, p);
  G = gridOf(F);
  updatePlevLabels();
  TH = thetaFields(F);
  $("meta").textContent = [
    `${F.model}  ${F.pressure} hPa`,
    `gültig    ${F.validTime} UTC`,
    `Lauf (bei Abruf) ${CASE.lastRunAtFetch?.slice(0, 16).replace("T", " ") ?? "?"}`,
    `Raster    ${F.res}°  ${F.nx}×${F.ny}`,
    ...(RUN ? [`Analyse   ${STATUS[RUN.status] ?? RUN.status}`] : []),
  ].join("\n");
  params.set("step", F.validTime); history.replaceState(null, "", `?${params}`);
  recompute();
  loadManual();
}

function recompute() {
  if (!F) return;
  const sigma = Number($("sigma").value);
  $("sigmaVal").textContent = sigma;
  derived = { ...thermoDerived(F, sigma, TH), ...caseDerived(CASE, Number($("stepSel").value), F.pressure) };
  derived.zLev = geopotentialLevel(F) || new Float32Array(F.nx * F.ny).fill(NaN);
  runDetection(false);
  derived.tfp = FF.TFP; derived.fg = FG;
  drawField(); drawIsolines(); drawWind(); drawWind10(); drawFronts();
}

function drawField() {
  const scale = SCALES[fieldKey];
  overlay?.remove();
  // Wo die Druckfläche unter Grund liegt, grau abdecken.
  overlay = fieldOverlay(L, derived[fieldKey], G, scale, {
    below: F.below, showMask: true, pane: "field", opacity: Number($("opacity").value),
  }).addTo(map);
  paintScale($("legend").querySelector("canvas"), scale);
  $("legend").querySelector(".ticks").innerHTML = scaleTicks(scale).map((t) => `<span>${t}</span>`).join("");
}

function drawIso(d) {
  isoLayers[d.key]?.remove(); isoLayers[d.key] = null;
  const step = Number($(`isoStep_${d.key}`).value), fld = derived?.[d.key];
  if (!$(`iso_${d.key}`).checked || !(step > 0) || !fld?.some(Number.isFinite)) return;
  isoLayers[d.key] = (d.isobar
    ? isobarLayer(L, fld, G, step, { pane })
    : isolineLayer(L, fld, G, step, { pane, color: d.color, weight: d.weight, dashArray: d.dashArray })).addTo(map);
}
function drawIsolines() { for (const d of ISO) drawIso(d); }

function drawWind10() {
  wind10Layer?.remove(); wind10Layer = null;
  if (!$("wind10").checked || !F.u10) return;
  wind10Layer = windArrows(L, F.u10, F.v10, G, { color: "#0a6", pane }).addTo(map);
}

function drawWind() {
  windLayer?.remove(); windLayer = null;
  if (!$("wind").checked) return;
  const mask = (a) => a.map((x, k) => (F.below[k] ? NaN : x));
  windLayer = windArrows(L, mask(F.u), mask(F.v), G, { color: "#000", pane }).addTo(map);
}

function detectOpts() {
  return {
    sigmaKm: Number($("sigma").value), k1: Number($("k1").value), k2: Number($("k2").value),
    minLengthKm: Number($("minLen").value), windMin: Number($("windMin").value),
    // Synoptix zeigt immer die Bodenfronten; die Lage in der Druckfläche nur im Debug-Modus.
    position: DEBUG && !$("surface").checked ? "analysis" : "surface",
    precipFronts: $("precipFronts").checked,
  };
}

function runDetection(redraw = true) {
  if (!F) return;
  const o = detectOpts();
  FF = frontFields(F, o);
  FG = frontogenesis(FF);
  fronts = detectFronts(F, { ...o, prev: prevField(CASE, Number($("stepSel").value), F.pressure), keepInactive: true });
  const cnt = (c) => fronts.features.filter((f) => f.properties.activity_class === c).length;
  $("nFronts").textContent = fronts.features[0]?.properties.activity_class != null
    ? `${cnt("active")} aktiv, ${cnt("weak")} schwach, ${cnt("none")} ohne Wetter`
    : `${fronts.features.length} Linien (ohne Bewertung)`;
  if (redraw) { derived.tfp = FF.TFP; derived.fg = FG; drawFronts(); if (["tfp", "fg"].includes(fieldKey)) drawField(); }
  updateCompare();
}

function drawFronts() {
  frontLayer?.remove(); frontLayer = L.layerGroup();
  if (DEBUG && $("cand").checked && FF) {
    const segs = chainSegments(isolineSegments(FF.F, FF.g, 0));
    L.polyline(segs, { pane, color: "#777", weight: 0.8, interactive: false }).addTo(frontLayer);
  }
  if ($("fronts").checked && fronts) {
    // Mittlere Frontogenese für den Tooltip, für die verschobene (Boden-)Lage;
    // Frontogenese im 90-km-Feld ist breit genug, dass der Versatz kaum zählt.
    addAutoFronts(L, frontLayer, fronts, { pane, showInactive: $("inactive").checked, fgMean: (ll) => (FG ? meanAlong(FG, G, ll) : null) });
  }
  if ($("kinks").checked && derived?.msl?.some(Number.isFinite)) {
    L.polyline(kinkLines(derived.msl, G), { pane, color: "#ff8c00", weight: 2, interactive: false }).addTo(frontLayer);
  }
  if ($("ridges").checked && fronts?.properties?.ridges) {
    L.polyline(fronts.properties.ridges, { pane, color: "#8e24aa", weight: 1.5, dashArray: "1 5", interactive: false }).addTo(frontLayer);
  }
  if ($("fronts").checked) addLows(L, frontLayer, fronts?.properties?.lows, { pane });
  frontLayer.addTo(map);
  editor.redraw(); // Handanalyse über der Automatik
}

function exportGeoJSON() {
  if (!fronts) return;
  const { ridges, ...props } = fronts.properties;
  const out = { ...fronts, properties: props, features: fronts.features.filter((f) => f.properties.activity_class !== "none") };
  download(out, `fronts_${F.model}_${F.pressure}_${F.validTime.replace(/[-:]/g, "").slice(0, 11)}.geojson`);
}

function download(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 1)], { type: "application/geo+json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------------------
// Handanalyse (src/fronts/map/editor.js). Die Seite verwaltet die Ablage:
// Entwurf im Browser (localStorage je Termin), Referenz in reference/.

// Warme Seite aus der θw-Normalen der aktuellen Analyse (wie detect.js).
function autoWarmSide(ll) {
  if (!FF) return "left";
  let sum = 0;
  for (let m = 1; m < ll.length; m++) {
    const a = ll[m - 1], b = ll[m], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const tx = (b[1] - a[1]) * Math.cos((mid[0] * Math.PI) / 180), ty = b[0] - a[0];
    const nx = sampleBilinear(FF.nx, FF.g, mid[0], mid[1]), ny = sampleBilinear(FF.ny, FF.g, mid[0], mid[1]);
    if (Number.isFinite(nx) && Number.isFinite(ny)) sum += tx * ny - ty * nx;
  }
  return sum >= 0 ? "left" : "right";
}

const editor = createFrontEditor(L, map, {
  pane,
  warmSide: autoWarmSide,
  newLine: () => ({ type: $("edType").value, weak: $("edWeak").checked }),
  onChange: () => { saveDraft(); updateCompare(); },
  onState: ({ selected, canUndo, drawing }) => {
    if (selected) { $("edType").value = selected.type; $("edWeak").checked = selected.weak; }
    $("edFlip").disabled = !selected; $("edDel").disabled = !selected;
    $("edUndo").disabled = !canUndo;
    $("edNew").textContent = drawing ? "Fertig" : "Neue Front";
  },
});

// Kennzeichen der geladenen Referenz, die beim Speichern erhalten bleiben
// (sonst ging z. B. "partial" beim erneuten Speichern verloren).
let refMeta = {}, loadTok = 0;
const keepMeta = (fc) => { const p = fc?.properties || {}; return { ...(p.partial ? { partial: true } : {}), ...(p.note ? { note: p.note } : {}), ...(p.exclude ? { exclude: p.exclude } : {}) }; };
const refPath = () => `reference/${F.validTime.slice(0, 13)}.geojson`;
const draftKey = () => `fronts-draft:${F.validTime}`;
const setStatus = (t) => { $("edStatus").textContent = t; };

function toGeoJSON() {
  return {
    type: "FeatureCollection",
    // Gezeichnetes Gebiet (Raster der geladenen Felder, bei "ICON Global
    // außen" das zusammengesetzte): compare.mjs wertet nur dort aus.
    properties: {
      source: "manual", valid_time: F.validTime, fixture: $("fixture").value, model: F.model,
      domain: { latMin: G.lat0, latMax: +(G.lat0 + (G.ny - 1) * G.res).toFixed(4), lonMin: G.lon0, lonMax: +(G.lon0 + (G.nx - 1) * G.res).toFixed(4) },
      created: new Date().toISOString(),
      ...refMeta,
    },
    features: lineFeatures(editor.lines),
  };
}

function saveDraft() {
  try { localStorage.setItem(draftKey(), JSON.stringify(editor.lines)); } catch { /* ohne Speicher nur in der Sitzung */ }
  setStatus("Entwurf im Browser – „Referenz speichern“ legt die Datei an.");
}

async function loadManual() {
  const tok = ++loadTok;
  editor.finishDrawing(true);
  let draft = null, ref = null;
  try { draft = localStorage.getItem(draftKey()); } catch { /* kein Speicher */ }
  // Die Referenzdatei auch bei einem Entwurf lesen: ihre Kennzeichen bleiben.
  try {
    const r = await fetch(refPath(), { cache: "no-store" });
    if (r.ok) ref = await r.json();
  } catch { /* keine Referenz */ }
  if (tok !== loadTok) return;
  refMeta = keepMeta(ref);
  let lines = [];
  if (draft) {
    lines = JSON.parse(draft);
    setStatus("Entwurf aus dem Browser (nicht als Datei gespeichert).");
  } else if (ref) {
    lines = linesFromGeoJSON(ref, autoWarmSide); setStatus(`Referenz ${refPath()}`);
  } else setStatus("Keine Referenz für diesen Termin.");
  editor.setLines(lines);
  updateCompare();
}

// Vergleich Handanalyse ↔ Automatik am aktuellen Termin.
function updateCompare() {
  if (!fronts || !editor.lines.length) { $("edCompare").textContent = ""; return; }
  const r = compareFronts(editor.compareLines(), fcToLines(fronts));
  const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)} %`);
  $("edCompare").textContent = [
    "Automatik gegen Handanalyse (±150 km)",
    `Treffer    ${pct(r.pod)}  (nur Lage ${pct(r.podAny)})`,
    `Fehlalarm  ${pct(r.far)}`,
    `Abstand    ${r.meanDistKm == null ? "–" : `${Math.round(r.meanDistKm)} km`} im Mittel`,
  ].join("\n");
}

$("edNew").onclick = () => editor.startDrawing();
$("edDel").onclick = () => editor.deleteSelected();
$("edUndo").onclick = () => editor.undo();
$("edFlip").onclick = () => editor.flipSelected();
$("edType").onchange = () => editor.setType($("edType").value);
$("edWeak").onchange = () => editor.setWeak($("edWeak").checked);
$("edImport").onclick = () => { if (fronts) editor.importFronts(fronts); };
$("edClear").onclick = () => { if (editor.lines.length && confirm("Alle Linien der Handanalyse löschen?")) editor.clear(); };
$("edSave").onclick = () => {
  if (!F) return;
  const name = `${F.validTime.slice(0, 13)}.geojson`;
  download(toGeoJSON(), name);
  setStatus(`Gespeichert als ${name} – nach tools/fronts/reference/ legen.`);
};
$("edOpen").onclick = () => $("edFile").click();
$("edFile").onchange = async () => {
  const file = $("edFile").files[0];
  if (!file) return;
  try {
    const fc = JSON.parse(await file.text());
    refMeta = keepMeta(fc);
    editor.replaceLines(linesFromGeoJSON(fc, autoWarmSide));
    const vt = fc.properties?.valid_time;
    setStatus(`${file.name} geladen${vt && vt !== F.validTime ? ` – Achtung: Termin ${vt}` : ""}.`);
  } catch (err) { setStatus(`${file.name}: ${err.message}`); }
  $("edFile").value = "";
};
$("edReset").onclick = () => {
  try { localStorage.removeItem(draftKey()); } catch { /* kein Speicher */ }
  loadManual();
};
$("edShow").onchange = () => editor.setVisible($("edShow").checked);

map.on("mousemove", (e) => {
  if (!F) return;
  const { nx, ny, lat0, lon0, res } = G;
  const j = Math.round((e.latlng.lat - lat0) / res), i = Math.round((e.latlng.lng - lon0) / res);
  if (i < 0 || j < 0 || i >= nx || j >= ny) { $("hover").textContent = "außerhalb"; return; }
  const k = j * nx + i, f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "–");
  const ff = Math.hypot(F.u[k], F.v[k]);
  const dd = (Math.atan2(-F.u[k], -F.v[k]) * 180 / Math.PI + 360) % 360;
  $("hover").textContent = [
    `${(lat0 + j * res).toFixed(2)}° N  ${(lon0 + i * res).toFixed(2)}° E`,
    `T      ${f1(derived.T[k])} °C`,
    `θe     ${f1(derived.thE[k])} °C`,
    `θw     ${f1(derived.thW[k])} °C`,
    `|∇θw|  ${f1(derived.grad[k])} K/100 km`,
    `p_msl  ${f1(derived.msl[k])} hPa  Δ3h ${f1(derived.tend[k])}`,
    `RR     ${f1(derived.precip[k])} mm/h  N ${f1(derived.cloud[k])} %`,
    `w700   ${f1(derived.w700[k])} cm/s  Spread700 ${f1(derived.spread700[k])} K`,
    `Dicke  ${f1(derived.thk[k])} gpdm  Z${F.pressure} ${f1(derived.zLev[k])} gpdm`,
    `TFP    ${Number.isFinite(FF?.TFP[k]) ? FF.TFP[k].toFixed(2) : "–"}  Maske ${FF?.mask[k] ? "ja" : "nein"}`,
    `Wind   ${Number.isFinite(ff) ? `${dd.toFixed(0)}° / ${(ff * 1.94384).toFixed(0)} kt` : "–"}`,
    `p_sfc  ${f1(F.psfc[k])} hPa${F.below[k] ? "  (unter Grund)" : ""}`,
  ].join("\n");
});

$("load").onclick = load;
listRuns();
$("mergeGlobal").onchange = load;
$("stepSel").onchange = selectStep;
$("presSel").onchange = selectStep;
$("wind10").onchange = drawWind10;
for (const id of ["k1", "k2", "minLen", "windMin", "surface", "precipFronts"]) $(id).onchange = () => runDetection();
$("fronts").onchange = drawFronts;
$("cand").onchange = drawFronts;
$("inactive").onchange = drawFronts;
$("ridges").onchange = drawFronts;
$("kinks").onchange = drawFronts;
$("export").onclick = exportGeoJSON;
$("sigma").oninput = recompute;
$("wind").onchange = drawWind;
$("opacity").oninput = () => overlay?.setOpacity(Number($("opacity").value));
// Jede Änderung in der Seitenleiste speichert die Anzeige-Einstellungen.
$("panel").addEventListener("change", saveSettings);
$("opacity").addEventListener("change", saveSettings);
document.querySelector("details").addEventListener("toggle", saveSettings);
$("resetSettings").onclick = () => {
  try { localStorage.removeItem(SETTINGS_KEY); } catch { /* kein Speicher */ }
  params.delete("field");
  location.search = params.toString();
};
if (!$("edShow").checked) editor.setVisible(false);
load().then(() => { settingsReady = true; saveSettings(); });
