/**
 * `<gramet-panel>` -- eigenständige Web Component für das GRAMET-Meteogramm.
 * Erster Baustein einer geplanten komponentenübergreifenden Bibliothek (s.
 * Gespräch beim Umbau): volle Shadow-DOM-Kapselung, keine Abhängigkeit von
 * einer Host-App-globalen `settings`-Instanz oder festen DOM-IDs -- nur
 * Properties/Events.
 *
 * Eingabe: `.grid` (Ergebnis von `gramet/grid.js` `gridFromColumn()` bzw.
 * `gridFromWaypoints()` -- reine Daten, kein Netzwerk-Fetch hier). Die
 * Ableitung von `view` (`gramet/derive.js` `deriveView()`) sowie das
 * eigentliche Zeichnen (`gramet/render.js` `renderGramet()`) übernimmt die
 * Komponente selbst.
 *
 * PATH-MODUS (`grid.meta.mode === "path"`, s. `gramet/path.js`
 * `fetchGridForPath()`): zusätzlich `terrain` (Mapterhorn-Geländeprofil),
 * `pathStop` (Abbruchmarker am Modellrand) und `profile` (Höhenprofil der
 * Host-App, z. B. eine Trajektorie -- `{ pos, z (m AMSL), color?, label? }`)
 * über `update()` hereinreichbar; `maxHeight: null` schaltet die
 * Max-Flughöhen-Deckellinie ab (Default 300 m für den droneforecast-
 * Punktmodus bleibt). Achse und Zoombereich wählt die Komponente path-gerecht
 * selbst (AMSL linear, `_pathZoom()`).
 *
 * BIBLIOTHEKS-OBERFLÄCHE (für einbettende Apps, z. B. trajectories via
 * Vite-Alias): öffentliche Einstiegspunkte sind NUR diese Komponente,
 * `gramet/path.js` (`fetchGridForPath`, `posOfPath`) und `units.js`
 * (`setUnits`) -- alles andere ist intern und darf sich ohne Rücksicht auf
 * Einbettungen ändern.
 *
 * EINBETTUNG IN FLACHE AUSSCHNITTE: `minMainHeight` (px) setzt die Untergrenze
 * der Hauptfläche. Ohne sie füllt der Chart den Container und wird in einem
 * niedrigen Ausschnitt gequetscht; mit ihr behält er seine Höhe und der
 * Panel-Body scrollt vertikal. Für ein angedocktes Fenster neben einer Karte
 * ist das der Unterschied zwischen lesbar und unbrauchbar.
 *
 * Darstellungs-Zustand (Höhenbereich, Ebenen-Sichtbarkeit, Flughöhe) lebt
 * ausschließlich in der Komponente; Persistenz (z. B. in
 * `localStorage`) ist Sache der Host-App -- dafür das `settingschange`-Event
 * beobachten und beim nächsten Öffnen die zuletzt gespeicherten Werte wieder
 * über `.update()`/die einzelnen Property-Setter hereinreichen.
 *
 * Events: `settingschange` (detail: `{ range, layers }`, bei Klick auf
 * Höhenbereich-Umschalter oder Ebenen-Checkbox), `close` (Klick auf ×,
 * Host entscheidet, ob/wie das Panel verschwindet -- z. B. `hidden`),
 * `poshover` (detail: `{ pos, index }` bzw. `{ pos: null }` beim Verlassen --
 * die gehoverte Stelle der X-Achse) und `posclick` (detail: `{ pos, index }`,
 * dieselbe Stelle bei einem Klick; ein Zeigerzug im waagerecht scrollenden
 * Chart löst es nicht aus). Zusammen mit der `cursor`-Property ist das die
 * Synchronisierung in beide Richtungen: `poshover`/`posclick` melden, wo der
 * Zeiger im Chart steht, `cursor` zeigt, wo er anderswo steht. Alle drei
 * sprechen dieselbe Größe (s. `cursor`).
 *
 * `poshover` und `posclick` sind mit Absicht getrennt: Hover ist eine Frage
 * (flüchtig, beliebig oft), Klick eine Ansage. Wo an der Position der
 * Host-App etwas Teures hängt -- neu geladene Kartenlayer etwa --, gehört sie
 * an den Klick, nie an den Hover.
 */

import css from "./gramet-panel.css?inline";
import { deriveView } from "../../gramet/derive.js";
import { renderGramet, exportPng as exportGrametPng } from "../../gramet/render.js";

// Höhenbereich "bis Flughöhe": etwas Luft über der eingestellten Flughöhe,
// damit die Ceiling-Linie nicht exakt am oberen Rand klebt (wie zuvor
// `XS_ZOOM_HEADROOM` in app.js).
const ZOOM_HEADROOM = 1.15;

// "terrain" (echtes Mapterhorn-Gelände) ist nur im Path-Modus sinnvoll --
// die Checkbox dazu blendet gramet-panel.css über `:host([path])` ein/aus.
const LAYER_KEYS = ["isotherms", "isotachs", "hazards", "windbarbs", "terrain"];

export class GrametPanelElement extends HTMLElement {
  static observedAttributes = ["subtitle", "range", "max-height"];

  #grid = null;
  #view = null;
  #canvas = null;
  #loading = null;
  // Default 300 m fürs droneforecast-Punktszenario; `null` (via `update({
  // maxHeight: null })`) heißt "keine Deckellinie" -- im Path-Modus einer
  // Trajektorien-App gibt es keine gesetzliche Max-Flughöhe zu zeichnen.
  #maxHeightM = 300;
  #range = "full";
  #exportNameParts = ["gramet"];
  #terrain = null;
  #pathStop = null;
  #profile = null;
  // `null` = Renderer-Default (s. `MIN_MAIN_H` in render.js).
  #minMainHeight = null;
  #cursor = null;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${css}</style>
      <div class="head">
        <span class="title">GRAMET</span>
        <span class="subtitle"></span>
        <div class="layers">
          <label><input type="checkbox" data-layer="isotherms" checked> Isothermen</label>
          <label><input type="checkbox" data-layer="isotachs" checked> Isotachen</label>
          <label><input type="checkbox" data-layer="hazards" checked> Hazards</label>
          <label><input type="checkbox" data-layer="windbarbs"> Windfiedern</label>
          <label class="terrain"><input type="checkbox" data-layer="terrain" checked> Gelände</label>
        </div>
        <div class="range-toggle">
          <button type="button" data-range="full">Gesamthöhe</button>
          <button type="button" data-range="zoom">bis Flughöhe</button>
        </div>
        <button type="button" class="export-btn" title="Als PNG speichern">⭳ PNG</button>
        <button type="button" class="close-btn" title="Schließen">×</button>
      </div>
      <div class="notice" hidden></div>
      <div class="plot">
        <div class="body"></div>
        <div class="busy" hidden></div>
      </div>
    `;

    this._subtitleEl = root.querySelector(".subtitle");
    this._bodyEl = root.querySelector(".body");
    this._busyEl = root.querySelector(".busy");
    this._noticeEl = root.querySelector(".notice");
    this._zoomBtn = root.querySelector('button[data-range="zoom"]');

    root.querySelector(".layers").addEventListener("change", (e) => {
      if (!e.target.closest("input[data-layer]")) return;
      this._render();
      this._emitChange();
    });
    root.querySelector(".range-toggle").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-range]");
      if (!btn) return;
      this.range = btn.dataset.range;
      this._emitChange();
    });
    root.querySelector(".export-btn").addEventListener("click", () => this.exportPng());
    root.querySelector(".close-btn").addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
    });

    this._syncRangeButtons();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal) return;
    if (name === "subtitle") this.subtitle = newVal ?? "";
    else if (name === "range") this.range = newVal;
    else if (name === "max-height") this.maxHeight = Number(newVal);
  }

  get grid() { return this.#grid; }
  set grid(g) {
    this.#grid = g ?? null;
    this.#view = this.#grid ? deriveView(this.#grid) : null;
    this.#loading = null;
    this._render();
  }

  get range() { return this.#range; }
  set range(v) {
    this.#range = v === "zoom" ? "zoom" : "full";
    this._syncRangeButtons();
    this._render();
  }

  get maxHeight() { return this.#maxHeightM; }
  set maxHeight(v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) this.#maxHeightM = n;
    this._render();
  }

  get subtitle() { return this._subtitleEl.textContent; }
  set subtitle(v) { this._subtitleEl.textContent = v ?? ""; }

  /** Beschriftung des Zoom-Knopfes. Default "bis Flughöhe" passt, wo die
   *  Host-App eine Flughöhe VORGIBT (droneforecast: Eingabefeld, daraus die
   *  Deckellinie). Wo der Ausschnitt stattdessen aus den Daten folgt -- etwa
   *  aus einem übergebenen `profile` --, kann die Host-App hier den
   *  zutreffenden Namen setzen, statt eine Flughöhe zu behaupten, die es
   *  nicht gibt. */
  get zoomLabel() { return this._zoomBtn.textContent; }
  set zoomLabel(v) { this._zoomBtn.textContent = v || "bis Flughöhe"; }

  /** Mindesthöhe der Hauptfläche in px. Der Chart füllt den Container, solange
   *  darin mehr Platz ist; darunter behält er diese Höhe und der Rest wird
   *  gescrollt, statt die Wetterdarstellung zusammenzuquetschen. Für ein
   *  bildschirmfüllendes Panel genügt der Renderer-Default -- zu setzen ist
   *  das hier von Host-Apps, die das GRAMET in einen flachen Ausschnitt
   *  hängen (angedocktes Fenster neben einer Karte o. Ä.). `null` gibt an den
   *  Default zurück. */
  get minMainHeight() { return this.#minMainHeight; }
  set minMainHeight(v) {
    const n = Number(v);
    const next = v == null || !Number.isFinite(n) || n <= 0 ? null : n;
    if (next === this.#minMainHeight) return; // kein Redraw ohne Änderung
    this.#minMainHeight = next;
    this._render();
  }

  /** Meldetext STATT Chart -- für den Erstaufbau und für Fehler, wo es nichts
   *  Sinnvolles zu zeigen gibt. Beim Nachladen über einem bereits stehenden
   *  Chart stattdessen `busy` setzen (s. dort), sonst blinkt die Tafel bei
   *  jedem Datenwechsel auf eine Textmeldung zurück. */
  get loading() { return this.#loading; }
  set loading(v) {
    this.#loading = v || null;
    if (this.#loading) this.busy = null;
    this._render();
  }

  /** Ladehinweis ÜBER dem weiterhin sichtbaren Chart -- für Aktualisierungen,
   *  die dauern (im Path-Modus kostet ein Datenwechsel etliche Säulenabrufe),
   *  ohne die alte Darstellung wegzunehmen. `null` blendet ihn aus. */
  get busy() { return this._busyEl.hidden ? null : this._busyEl.textContent; }
  set busy(v) {
    this._busyEl.textContent = v || "";
    this._busyEl.hidden = !v;
  }

  /** Dauerhafter Warnhinweis über dem Chart -- für Zustände, die das Gezeigte
   *  entwerten, ohne es falsch zu machen: etwa "die Einstellungen der Host-App
   *  passen nicht mehr zu diesen Daten". Anders als `busy` transportiert er
   *  keine Aktivität, sondern eine Einordnung, und wird deshalb von `update()`
   *  NICHT automatisch gelöscht -- ein Datenwechsel hebt die Ursache ja nicht
   *  auf. Die Host-App setzt ihn auf `null`, wenn der Zustand vorbei ist. */
  get notice() { return this._noticeEl.hidden ? null : this._noticeEl.textContent; }
  set notice(v) {
    this._noticeEl.textContent = v || "";
    this._noticeEl.hidden = !v;
  }

  get layers() {
    const out = {};
    for (const key of LAYER_KEYS) out[key] = this._layerCheckbox(key).checked;
    return out;
  }
  set layers(v = {}) {
    for (const key of LAYER_KEYS) {
      if (key in v) this._layerCheckbox(key).checked = !!v[key];
    }
    this._render();
  }

  /** Positionscursor: eine Stelle auf der X-Achse, die von AUSSEN kommt --
   *  gedacht für Host-Apps, die dieselbe Strecke noch anderswo zeigen (eine
   *  Karte, einen Zeitregler) und beide Ansichten aufeinander zeigen lassen
   *  wollen. Der Wert hat dieselbe Einheit wie die X-Achse, also genau die,
   *  die das `poshover`-Event in der Gegenrichtung meldet: im Punkt-Modus
   *  Epochensekunden, im Path-Modus verstrichene Sekunden seit Pfadbeginn.
   *  `null` blendet ihn aus. Kostet keinen Redraw (DOM-Overlay). */
  get cursor() { return this.#cursor; }
  set cursor(v) { this.setCursor(v); }

  /** Wie die `cursor`-Property, aber mit `reveal: true` scrollt der Chart
   *  waagerecht nach, bis die Stelle im Blick ist. Für Positionen, die von
   *  außen kommen -- beim Hovern im Chart selbst wäre Scrollen unter dem
   *  Zeiger eine Zumutung. */
  setCursor(pos, { reveal = false } = {}) {
    const n = Number(pos);
    this.#cursor = pos == null || !Number.isFinite(n) ? null : n;
    this._bodyEl.__gmSetCursor?.(this.#cursor, reveal);
  }

  /** Dateiname-Bausteine für den PNG-Export, s. `render.js` `exportPng()`. */
  get exportNameParts() { return this.#exportNameParts; }
  set exportNameParts(parts) { this.#exportNameParts = Array.isArray(parts) ? parts : ["gramet"]; }

  exportPng() {
    if (this.#canvas) exportGrametPng(this.#canvas, this.#exportNameParts);
  }

  /** Mehrere Properties in einem Rutsch setzen -- ein einziger Redraw statt
   *  einem pro Einzel-Setter (relevant beim Öffnen/bei Datenwechsel, wo
   *  Grid, Flughöhe, Höhenbereich und Ebenen zusammen aktualisiert werden). */
  update({ grid, maxHeight, range, layers, subtitle, exportNameParts, terrain, pathStop, profile, zoomLabel, minMainHeight } = {}) {
    this.#loading = null;
    this.busy = null;
    if (zoomLabel !== undefined) this.zoomLabel = zoomLabel;
    if (minMainHeight !== undefined) {
      const n = Number(minMainHeight);
      this.#minMainHeight = minMainHeight == null || !Number.isFinite(n) || n <= 0 ? null : n;
    }
    if (grid !== undefined) {
      this.#grid = grid ?? null;
      this.#view = this.#grid ? deriveView(this.#grid) : null;
    }
    if (maxHeight !== undefined) {
      const n = Number(maxHeight);
      if (maxHeight === null) this.#maxHeightM = null;
      else if (Number.isFinite(n) && n > 0) this.#maxHeightM = n;
    }
    // Path-Modus-Beiwerk: `undefined` = unverändert lassen, `null` = löschen.
    if (terrain !== undefined) this.#terrain = terrain ?? null;
    if (pathStop !== undefined) this.#pathStop = pathStop ?? null;
    if (profile !== undefined) this.#profile = profile ?? null;
    if (range !== undefined) {
      this.#range = range === "zoom" ? "zoom" : "full";
      this._syncRangeButtons();
    }
    if (layers) {
      for (const key of LAYER_KEYS) {
        if (key in layers) this._layerCheckbox(key).checked = !!layers[key];
      }
    }
    if (subtitle !== undefined) this.subtitle = subtitle;
    if (exportNameParts !== undefined) this.#exportNameParts = exportNameParts;
    this._render();
  }

  _layerCheckbox(key) {
    return this.shadowRoot.querySelector(`input[data-layer="${key}"]`);
  }

  _syncRangeButtons() {
    this.shadowRoot.querySelectorAll(".range-toggle button").forEach((b) => {
      b.classList.toggle("active", b.dataset.range === this.#range);
    });
  }

  _emitChange() {
    this.dispatchEvent(new CustomEvent("settingschange", {
      bubbles: true,
      composed: true,
      detail: { range: this.#range, layers: this.layers },
    }));
  }

  _render() {
    if (this.#loading) {
      this._bodyEl.innerHTML = "";
      const msg = document.createElement("div");
      msg.className = "body-message";
      msg.textContent = this.#loading;
      this._bodyEl.append(msg);
      this.#canvas = null;
      return;
    }
    if (!this.#grid || !this.#view) {
      this._bodyEl.innerHTML = "";
      this.#canvas = null;
      this.removeAttribute("path");
      return;
    }
    const isPath = this.#grid.meta?.mode === "path";
    // `path`-Attribut fürs CSS (Gelände-Checkbox nur im Path-Modus zeigen).
    this.toggleAttribute("path", isPath);
    let zMin, zMax;
    if (this.#range === "zoom") {
      if (isPath) ({ zMin, zMax } = this._pathZoom());
      else if (this.#maxHeightM) {
        zMax = Math.round(this.#maxHeightM * ZOOM_HEADROOM);
        zMin = Math.max(10, this.#grid.z[0] || 10);
      }
    }
    this.#canvas = renderGramet(this._bodyEl, this.#grid, this.#view, {
      // Path-Modus: Achse dem Renderer überlassen (linear auf AMSL, s.
      // render.js) -- ein erzwungenes "log" wäre dort Unsinn, weil der
      // log-Nullpunkt auf Meereshöhe statt am Boden läge.
      axis: isPath ? undefined : (this.#range === "zoom" ? "lin" : "log"),
      zMin,
      zMax,
      maxHeightM: this.#maxHeightM ?? undefined,
      terrain: isPath ? this.#terrain ?? undefined : undefined,
      pathStop: isPath ? this.#pathStop ?? undefined : undefined,
      profile: isPath ? this.#profile ?? undefined : undefined,
      layerToggles: this.layers,
      minMainH: this.#minMainHeight ?? undefined,
      onRedraw: (canvas) => { this.#canvas = canvas; },
    });
    // Ein vor dem ersten Chart gesetzter Cursor (Host-App synchronisiert schon,
    // während die Daten noch laden) hat noch kein Overlay gefunden -- jetzt
    // nachziehen. Spätere Redraws erledigt der Renderer selbst.
    if (this.#cursor != null) this._bodyEl.__gmSetCursor?.(this.#cursor);
  }

  /** Zoombereich ("bis Flughöhe") im Path-Modus: AMSL-Spanne vom tiefsten
   *  Modell-Boden bis Gelände + Flughöhe bzw. bis übers Profilmaximum --
   *  Konvention aus dem Debug-Harness (`debug/gramet-path.js`), erweitert um
   *  das Trajektorien-Profil. Die Punkt-Modus-Rechnung (`grid.z[0]`, AGL)
   *  wäre hier falsch, `grid.z` sind im Path-Modus AGL-Werte auf einer
   *  AMSL-Achse. Ohne Flughöhe UND ohne Profil gibt es nichts, worauf man
   *  zoomen könnte -> volle Höhe (leeres Objekt). */
  _pathZoom() {
    let eMin = Infinity, eMax = -Infinity;
    for (const e of this.#grid.elevation) {
      if (!Number.isFinite(e)) continue;
      if (e < eMin) eMin = e;
      if (e > eMax) eMax = e;
    }
    if (!Number.isFinite(eMin)) return {};
    let profMax = -Infinity;
    for (const z of this.#profile?.z ?? []) {
      if (Number.isFinite(z) && z > profMax) profMax = z;
    }
    if (this.#maxHeightM == null && !Number.isFinite(profMax)) return {};
    // 20 m Polster unterm tiefsten Boden, damit die Silhouette sichtbar bleibt.
    const zMin = Math.max(0, eMin - 20);
    let zMax = eMax + (this.#maxHeightM ?? 0) * ZOOM_HEADROOM;
    if (Number.isFinite(profMax)) {
      zMax = Math.max(zMax, profMax + 0.15 * Math.max(profMax - zMin, 100));
    }
    if (!(zMax > zMin)) return {};
    return { zMin, zMax };
  }
}

customElements.define("gramet-panel", GrametPanelElement);
