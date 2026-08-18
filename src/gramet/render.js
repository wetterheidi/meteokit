/**
 * GRAMET-Meteogramm — Canvas-Renderer (anders als die SVG-Cross-Section:
 * Wolkenschraffur mit vielen Einzelstrichen ist auf Canvas günstiger).
 * Einstieg: `renderGramet(host, grid, view, state)`, `state = { zMin, zMax,
 * axis: "log"|"lin", activeRows, layerToggles, pathStop, terrain, maxHeightM,
 * profile }`.
 * Höhenumschalter (axis/zMin/zMax) folgt demselben State/Mechanismus wie
 * `crosssection.js` (`settings.xsZoom`) — dieselbe Umschaltfläche bedient
 * beide Ansichten. `terrain`/`maxHeightM`/`profile` sind nur im Path-Modus
 * wirksam; `profile = { pos, z (m AMSL, NaN = Lücke), color?, label? }`
 * zeichnet ein Höhenprofil (z. B. die Trajektorie der Host-App) als Linie in
 * die Haupttafel (s. `drawProfile`).
 *
 * HÖHENREFERENZ: Punkt-Modus plottet AGL (wie bisher), der PATH-Modus plottet
 * AMSL mit der Modell-Orographie als Silhouette in der Haupttafel (Ogimet-
 * Konvention) — s. Kommentar an `amslGrid()`/`drawModelTerrain()`. `zMin`/
 * `zMax` sind im Path-Modus entsprechend AMSL-Werte.
 *
 * Vereinfachung ggü. Plan: kein Offscreen-Cache für die Wolkentextur und kein
 * separates Overlay-Canvas fürs Hover-Fadenkreuz — jede State-Änderung baut
 * (wie bei `crosssection.js`) den ganzen Canvas neu auf, das ist bei
 * nt*nk im niedrigen 5-stelligen Bereich schnell genug (s. `texture.js`).
 * Hover zeigt die Werte als reines DOM-Overlay (Tooltip-Div), ohne
 * Fadenkreuz-Redraw.
 */

import { sampleAt } from "./grid.js";
import { contour } from "./derive.js";
import { drawClouds, cbCells, drawCbShafts, drawCbAnvils } from "./texture.js";
import { hashSeed, hashRand } from "./noise.js";
import { drawWindRow, WIND_ROW_HEIGHT, drawWindBarbOverlay } from "./rows/wind.js";
import { drawNumberRow, NUMBER_ROW_HEIGHT } from "./rows/numberRow.js";
import { niceLogHeights, niceTicks, fmtH } from "../crosssection.js";
import { CHART_PX_PER_HOUR } from "../windbarb.js";
import { fmtHeight, fmtWind, fmtTemp, fmtDir, windUnit, windToDisplay, tempUnit, tempToDisplay } from "../units.js";
import { metarWeather } from "../briefing.js";
import * as fog from "./hazards/fog.js";
import { TERRAIN_ATTRIBUTION } from "./terrain.js";

const INK = "#0b0b0b", MUTED = "#52514e", GRID = "#d9d8d3";
// Rechter Rand: Platz für die Beschriftungskästchen der Isothermen/Isotachen/
// Tropopause, die am rechten Ende ihrer Polylinie sitzen (also i. d. R. exakt
// auf `x.right`) -- mit dem alten 16 px wurden sie abgeschnitten.
const TOPAX = 22, GAP = 16, BOT = 22, M = { l: 50, r: 52 };

// Füllfarbe des mitscrollenden Achsenstreifens: deckend, damit der Chart beim
// horizontalen Scrollen darunter verschwindet (Panel-Hintergrund von #gramet).
const PANEL_BG = "#fcfcfb";

// Dunkleres Blau als im ersten Entwurf (das helle Himmelblau ließ die weiße
// Wolkenschraffur verschwinden) -- näher am Original-GRAMET-Kontrast.
const NIGHT_COLOR = "#050b1e", DAY_COLOR = "#2b5c93";

// Bodenstreifen unter dem Hauptpanel. Nur im PUNKT-Modus: GRAMET ist dort
// eine reine Punktprognose (ein Ort über die Zeit, nicht eine Route über den
// Raum) -- ein Geländeprofil ergibt dort keinen Sinn, die Höhe des einen
// Punkts ändert sich ja nicht. Statt einer Silhouette also ein schmaler,
// horizontaler Streifen im ohnehin leeren GAP zwischen Hauptpanel und
// Zahlenzeilen -- reine Bodenkontakt-Anzeige, kein Höhenprofil, verdrängt
// darum auch keine echten Daten (s. Feedback). Der PATH-Modus hat KEINEN
// Streifen mehr: das Gelände (Modell-Orographie) sitzt dort als Silhouette
// direkt in der Haupttafel (`drawModelTerrain`, AMSL-Achse -- Ogimet-
// Konvention, s. Feedback/Diskussion).
const GROUND_H = 14;

// Obergrenze der "Gesamthöhe": das Modell reicht bis ~20-22 km, oberhalb der
// Tropopause passiert für Luftfahrt/Drohnen aber nichts mehr -- die halbe
// Tafel bliebe leere Stratosphäre und drückte das Wettergeschehen in den
// unteren Rand (s. Feedback). Gezeigt wird deshalb bis knapp über die
// Tropopause: das Polster lässt überschießende Cb-Gipfel/Ambosse noch
// vollständig sichtbar (die durchstoßen die Tropopause um typisch einige
// hundert bis ~1500 m). Findet `derive.js` keine Tropopause (z. B. Gitter
// endet zu früh), greift der feste Deckel -- über typischen mittleren
// Breiten (11-12 km) und immer noch weit unter dem Modelldeckel.
const TROPOPAUSE_HEADROOM_M = 2500;
const FULL_RANGE_FALLBACK_TOP_M = 15000;
// Folgt derselben Tag/Nacht-Kurve wie der Himmel (`view.daylight`), damit
// Boden und Himmel zur selben Stunde gemeinsam dunkeln/hellen. Deutlich
// dunkler als eine "natürliche" Erdfarbe gewählt (nicht nur ein anderer
// Farbton, sondern spürbar geringere Leuchtdichte als NIGHT_COLOR/DAY_COLOR)
// -- mit einer nur leicht dunkleren Erdfarbe verschwamm der Boden mit dem
// Himmel zu ähnlich heller Fläche, die Horizontlinie blieb die einzige
// Trennung (s. Feedback).
const GROUND_NIGHT = "#0a0603", GROUND_DAY = "#afa488";
// Zieht den Bodenton zusätzlich Richtung Reifweiß, wenn `surface.t2m` <= 0 °C
// ist -- keine neue Datenquelle nötig, das Feld liegt in `grid.surface`
// ohnehin schon für die T/Taupunkt-Zeile bereit. Für Drohnenpiloten ist eine
// Frostnacht am Startpunkt relevant, das Signal soll also sichtbar sein.
const GROUND_FROST = "#dfe6ea";

// Hazard-Flächen als Kontur-Umriss (marching squares, s. `derive.js`
// `contour()`) statt Zellraster -- entspricht der GRAMET-Konvention aus dem
// Referenz-Screenshot (gestrichelt umrandete Fläche statt Pixelraster).
// icing: Grün (klassische Vereisungsfarbe), turbulence: Gelb->Orange->Rot
// (steigender Schweregrad), analog zur gelb umrandeten Fläche im Original.
const ICING_STYLES = { light: "#2e7d32", moderate: "#1b5e20", severe: "#0d3b10" };
const TURB_STYLES = { light: "#f9a825", moderate: "#ef6c00", severe: "#c62828" };
const HAZARD_LEVELS = { light: 1, moderate: 2, severe: 3 };

// Cb/TCU: sandfarbener Schaft + Amboss (Ellipsentechnik, s. `texture.js`), dazu
// als Kennzeichnung die WOLKENSYMBOLE DER BODENEINTRAGUNGSSYSTEMATIK (WMO-
// Schlüssel C_L) statt eines frei erfundenen Glyphs -- die kennt jeder
// Meteorologe von der Bodenkarte. Reine Strichzeichnung in Schwarz, wie auf
// der Karte; darunter ein weißer Halo, sonst geht der dünne Strich in der
// gefleckten Wolkentextur unter.
const CB_SYMBOL_INK = "#12161c";
const CB_SYMBOL_HALO = "rgba(255,255,255,0.9)";
// Vereisungssymbol bewusst in Rot statt im Cb-Schwarz -- hebt sich von der
// grünen Kontur-Füllung (ICING_STYLES) ab und markiert die Fläche als
// Warnung, dieselbe Rotstufe wie TURB_STYLES.severe (konsistente Alarmfarbe).
const ICING_SYMBOL_INK = "#c62828";
// Turbulenzsymbol nur in "severe"-Flächen (stärkste Stufe, analog Vereisung)
// -- dieselbe Rotstufe wie TURB_STYLES.severe, kein eigener Warnton nötig.
const TURB_SYMBOL_INK = "#c62828";

// Isothermen (rot/blau, gestrichelt) und Isotachen (violett, Strich-Punkt)
// bewusst in unterschiedlichen Farbfamilien UND unterschiedlichem Strich-
// muster -- vorher beide gestrichelt und in ähnlich stumpfen Tönen (Rot vs.
// Oliv), auf dem Tag/Nacht-Verlauf kaum zu trennen (s. Feedback).
const ISOTACH_COLOR = "#7b2fbf";
const ISOTACH_DASH = [7, 3, 1, 3];

/** Sicht fürs GRAMET, knapper als `metarVis` im Briefing (Meter, feste
 *  METAR-Rundung) -- hier ist die Spaltenbreite pro Stunde eng, daher km statt
 *  m und Dezimalstelle nur unterhalb 5 km, wo die Präzision für die
 *  VLOS-Einschätzung zählt (s. Feedback); ab 5 km reicht der volle km, ab
 *  10 km nur noch ">10". */
function fmtVisKm(m) {
  if (!Number.isFinite(m)) return "";
  if (m >= 10000) return ">10";
  const km = m / 1000;
  return km >= 5 ? String(Math.round(km)) : km.toFixed(1);
}

const ROW_DEFS = {
  wind: {
    height: WIND_ROW_HEIGHT, label: ["Wind", "10 m"],
    draw: (ctx, grid, view, x, top, h) => drawWindRow(ctx, grid, x, top, h),
  },
  // Zellen zeigen nur noch die nackte Zahl (kein " °C"/" km/h" pro Wert) --
  // die Einheit steht wie bei SLP schon im Zeilenlabel; erst das macht die
  // Werte schmal genug, um jede Stunde statt nur jede zweite zu plotten
  // (s. Feedback). `label` als Funktion, weil die Einheit vom Nutzer
  // umschaltbar ist (Einstellungen) und `ROW_DEFS` nur einmal gebaut wird.
  tempdew: {
    height: NUMBER_ROW_HEIGHT, label: () => ["T / Td", tempUnit()],
    draw: (ctx, grid, view, x, top, h) => drawNumberRow(ctx, grid.pos, x, top, h, [
      { values: grid.surface.t2m, fmt: (v) => String(Math.round(tempToDisplay(v))), color: "#c0392b" },
      { values: grid.surface.td2m, fmt: (v) => String(Math.round(tempToDisplay(v))), color: "#2980b9" },
    ]),
  },
  gust: {
    height: NUMBER_ROW_HEIGHT * 0.7, label: () => ["Böen 10 m", windUnit()],
    draw: (ctx, grid, view, x, top, h) => drawNumberRow(ctx, grid.pos, x, top, h, [
      { values: grid.surface.gust, fmt: (v) => String(Math.round(windToDisplay(v))), color: "#6a3d9a" },
    ]),
  },
  visibility: {
    height: NUMBER_ROW_HEIGHT * 0.7, label: ["Sicht", "km"],
    draw: (ctx, grid, view, x, top, h) => drawNumberRow(ctx, grid.pos, x, top, h, [
      { values: grid.surface.visibility, fmt: (v) => fmtVisKm(v), color: "#546e7a" },
    ]),
  },
  pressure: {
    height: NUMBER_ROW_HEIGHT * 0.7, label: ["SLP", "hPa"],
    draw: (ctx, grid, view, x, top, h) => drawNumberRow(ctx, grid.pos, x, top, h, [
      { values: grid.surface.pmsl, fmt: (v) => String(Math.round(v)), color: "#1a6b4a" },
    ]),
  },
  weather: {
    height: NUMBER_ROW_HEIGHT * 0.55, label: ["Wetter", "(METAR)"],
    draw: (ctx, grid, view, x, top, h) => drawWeatherRow(ctx, grid, view, x, top, h),
  },
};

// Reihenfolge wie im METAR-Meldungskopf: Wind/Böen, Sicht, WW (Wolken laufen
// nicht als eigene Zeile, sondern schon in der Hauptfläche mit), Temp/Taupunkt,
// Luftdruck (s. Feedback).
const DEFAULT_ROWS = ["wind", "gust", "visibility", "weather", "tempdew", "pressure"];

// Resize-Redraw: von GRAMET selbst besessener `ResizeObserver` auf `host`,
// statt (wie vorher) an einen globalen `window.resize`-Listener der
// App gekoppelt zu sein -- nötig, damit ein in eine fremde App eingebettetes
// GRAMET auch auf Container-Größenänderungen reagiert, die das Browserfenster
// selbst nicht betreffen (Sidebar-Toggle, Split-View o. Ä.). Guard gegen
// mehrfache Observer auf demselben Host: `renderGramet` wird schon heute
// wiederholt auf demselben `host` aufgerufen (Zoom-/Toggle-Änderungen in
// `app.js`s `renderGm()`) -- ohne Disconnect würden sich die Observer dabei
// aufsummieren und jede Größenänderung mehrfach neu zeichnen.
const RESIZE_DEBOUNCE_MS = 150;

export function renderGramet(host, grid, view, state = {}) {
  host.__gmObserver?.disconnect();

  function draw() {
    host.innerHTML = "";
    const { times, pos, nk } = grid;
    if (!times || times.length < 2) { host.textContent = "Keine Gitterdaten."; return null; }

    const activeRows = (state.activeRows ?? DEFAULT_ROWS).filter((id) => ROW_DEFS[id]);
    const isPath = grid.meta.mode === "path";
    // Path-Modus: AMSL-Projektion NUR fürs Rendering (`grid.z`/`view` bleiben
    // AGL, s. Kommentar an `amslGrid`) -- alle Zeichenfunktionen unten arbeiten
    // auf `rgrid`/`rview`, die Physik/Heuristik-Seite (maskFog, Hover-Sampling)
    // weiter auf dem originalen `grid`.
    const rgrid = isPath ? amslGrid(grid) : grid;
    const rview = isPath ? amslViewOf(view, grid) : view;
    // Modell-Orographie als Funktion der Pfadposition -- Anker für alles, was
    // "über Grund" gemeint ist (Nebelschleier, Niederschlags-Bodenkontakt).
    const groundAt = isPath ? (p) => interpAt(grid.pos, grid.elevation, p) : null;
    // Log-Achse ergibt auf AMSL wenig Sinn (der log-Nullpunkt läge auf
    // Meereshöhe, nicht am Boden) -- Path-Modus default daher linear wie das
    // Ogimet-Original; ein explizites `state.axis` gewinnt weiterhin.
    const lin = state.axis ? state.axis === "lin" : isPath;
    let hMinData, hMaxData;
    if (isPath) {
      // AMSL-Spanne: tiefster Modell-Boden bis höchstes Level über allen
      // Spalten (die Level-Oberkante variiert mit der Orographie).
      let eMin = Infinity, topMax = -Infinity;
      for (let i = 0; i < times.length; i++) {
        const e = grid.elevation[i];
        if (Number.isFinite(e) && e < eMin) eMin = e;
        const t = rgrid.z[i * nk + nk - 1];
        if (Number.isFinite(t) && t > topMax) topMax = t;
      }
      // Kleines Polster unter dem tiefsten Boden: exakt bei eMin begänne die
      // Silhouette dort mit 0 px Höhe -- ein sichtbares Bodenband soll überall
      // bleiben (wie im Ogimet-Original). 4 % der Datenspanne, rein optisch.
      const span = Number.isFinite(topMax) && Number.isFinite(eMin) ? topMax - eMin : 0;
      hMinData = Math.max(0, (Number.isFinite(eMin) ? eMin : 0) - 0.04 * span);
      hMaxData = Number.isFinite(topMax) ? topMax : rgrid.z[nk - 1];
    } else {
      hMinData = Math.max(10, grid.z[0] || 10);
      hMaxData = grid.z[nk - 1];
    }
    // Leere Stratosphäre abschneiden (s. `TROPOPAUSE_HEADROOM_M`). Auf
    // `rview` gerechnet, damit im Path-Modus AMSL gegen AMSL verglichen wird.
    // Nie unter den Datenboden drücken -- ein Pfad über Hochgebirge könnte
    // sonst theoretisch einen Deckel unterhalb von `hMinData` bekommen.
    hMaxData = Math.max(hMinData + 100, Math.min(hMaxData, fullRangeTop(rview.tropopause)));
    const zMin = state.zMin ?? hMinData, zMax = state.zMax ?? hMaxData;
    // Path-Modus ohne Bodenstreifen -- das Gelände sitzt in der Haupttafel.
    const stripH = isPath ? 0 : GROUND_H;

    // Spannweite in `pos`-Einheiten (Point-Modus: Sekunden = `times`-Spanne,
    // Path-Modus: verstrichene Sekunden seit Pfadbeginn) -- `CHART_PX_PER_HOUR`
    // bleibt der gemeinsame Dichte-Maßstab für beide Modi.
    const hours = Math.max(1, (pos[pos.length - 1] - pos[0]) / 3600);
    const containerPw = Math.max(host.clientWidth || 0, 360) - M.l - M.r;
    const pw = Math.max(hours * CHART_PX_PER_HOUR, containerPw);

    const rowsH = activeRows.reduce((s, id) => s + ROW_DEFS[id].height, 0);
    const mainH = Math.max(240, (host.clientHeight || 560) - TOPAX - stripH - rowsH - GAP * 2 - BOT);

    const W = M.l + pw + M.r;
    const H = TOPAX + mainH + stripH + GAP + rowsH + GAP + BOT;
    const dpr = window.devicePixelRatio || 1;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    canvas.className = "gm-canvas";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const p0 = pos[0], p1 = pos[pos.length - 1];
    const x = (p) => M.l + (p - p0) / (p1 - p0) * pw;
    x.left = M.l; x.right = M.l + pw;

    const mainTop = TOPAX, mainBot = TOPAX + mainH;
    const y = makeYScale(mainTop, mainBot, zMin, zMax, lin);

    const toggles = state.layerToggles ?? {};
    drawBackground(ctx, rgrid, rview, x, y, mainTop, mainBot);
    // FG/BR/HZ gemeinsam als ein Schleier (s. `drawFogHaze`/`hazeColorAlpha`)
    // vor Wolken/Hazards/Niederschlag, damit die auf dem Schleier noch klar
    // lesbar bleiben statt darin zu verschwimmen -- auch VOR den Wolken, damit
    // `drawClouds()` (s. u., mit maskierter cloudFrac) innerhalb der FG-Schicht
    // nichts mehr zu zeichnen hat.
    drawFogHaze(ctx, rgrid, rview, x, y, mainTop, mainBot, groundAt);
    // Zellzerlegung einmal ziehen: Schaft, Amboss und Symbol müssen auf demselben
    // Turm sitzen (s. `cbCells`).
    const cells = toggles.cb !== false ? cbCells(rgrid, rview.cb, x, y) : [];
    if (toggles.cb !== false) drawCbShafts(ctx, cells, x, y);
    // FG-Zellen aus der Ellipsentextur ausblenden (s. `maskFog`) -- sonst säße
    // die "Reiskorn"-Wolkentextur unter dem Nebelschleier. Die Maske rechnet
    // auf dem AGL-Grid (`grid.z` vs. AGL-Nebel-Tops), gezeichnet wird auf der
    // (im Path-Modus AMSL-) Projektion `rgrid`.
    if (toggles.clouds !== false) drawClouds(ctx, rgrid, maskFog(grid, view.cloudFrac, view.fog), x, y);
    if (toggles.cb !== false) {
      drawCbAnvils(ctx, cells, x, y);
      drawCbGlyphs(ctx, cells);
    }
    const seed = hashSeed(`${grid.meta.lat},${grid.meta.lon},${grid.meta.elevation},${times[0]}`);
    if (toggles.precip !== false) drawPrecip(ctx, rview.precip, pos, x, y, seed, groundAt);
    // Vereisung/Turbulenz bewusst ÜBER Wolken/Niederschlag: beides sind Gefahren-
    // hinweise, die auf der Wolke "aufsitzen" sollen, statt darunter zu verschwinden
    // -- die Kontur-Füllung ist transparent genug (s. `drawHazardArea`), dass die
    // Wolkentextur durchscheint.
    if (toggles.hazards !== false) {
      drawHazardArea(ctx, rgrid, rview.hazards.icing, ICING_STYLES, x, y);
      drawIcingSevereGlyphs(ctx, rgrid, rview.hazards.icing, x, y);
      drawHazardArea(ctx, rgrid, rview.hazards.turbulence, TURB_STYLES, x, y);
      drawTurbulenceSevereGlyphs(ctx, rgrid, rview.hazards.turbulence, x, y);
    }
    if (toggles.isotherms !== false) drawIsotherms(ctx, rview.isotherms, x, y);
    if (toggles.isotachs !== false) drawIsotachs(ctx, rview.isotachs, x, y);
    if (toggles.tropopause !== false) drawTropopause(ctx, rview.tropopause, x, y);

    // Windfiedern: opt-in (Default aus, s. settings.js), weil sie die ohnehin
    // volle Hauptfläche (Wolken/Hazards/Niederschlag) zusätzlich belasten --
    // deshalb das dämpfende Fade darunter, statt jedem Fähnchen einen eigenen
    // Halo zu geben (Test auf Wunsch, s. Feedback).
    // nRows=14 statt der Cross-Section-Vorgabe (7): GRAMETs Hauptfläche ist
    // ohne die feste Panelhöhe der Cross-Section i. d. R. deutlich höher,
    // doppelte Zeilenzahl bleibt darin noch überlappungsfrei (s. Feedback).
    if (toggles.windbarbs) {
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillRect(x.left, mainTop, x.right - x.left, mainBot - mainTop);
      drawWindBarbOverlay(ctx, rgrid, x, y, { nRows: 14 });
    }

    // Path-Modus: Modell-Orographie als Silhouette in der Haupttafel (Ogimet-
    // Konvention) -- deckt ALLE bisherigen Inhaltslayer unterhalb des Modell-
    // Bodens ab (v. a. Niederschlagsvorhang-Überstand), deshalb erst hier,
    // nicht pro Layer einzeln geclippt. Darauf optional das ECHTE Gelände
    // (Mapterhorn, `state.terrain`) als Vergleichs-Overlay -- macht die
    // Modell/Real-Differenz (METHODIK 5b) sichtbar, ohne die Wetterdaten
    // anzufassen. Die Max-Flughöhen-Linie folgt dem echten Gelände, wenn es
    // eingeblendet ist (die 120-m-Regel zählt über REALEM Grund), sonst der
    // Modell-Orographie.
    const showRealTerrain = isPath && state.terrain && toggles.terrain !== false;
    if (isPath) drawModelTerrain(ctx, grid, rview, x, y, mainBot);
    if (showRealTerrain) drawRealTerrainOverlay(ctx, state.terrain, x, y, mainBot);
    if (isPath && state.maxHeightM) {
      drawCeiling(ctx, grid, showRealTerrain ? state.terrain : null, state.maxHeightM, x, y);
    }
    if (isPath && state.profile) {
      drawProfile(ctx, state.profile, x, y, mainTop, mainBot, zMin, zMax);
    }

    ctx.strokeStyle = MUTED; ctx.lineWidth = 1;
    ctx.strokeRect(x.left + 0.5, mainTop + 0.5, pw - 1, mainH - 1);
    drawHeightAxis(ctx, y, zMin, zMax, x, lin, isPath);
    if (isPath) pathGridLines(ctx, grid, x, mainTop, mainBot);
    else timeGridLines(ctx, times, x, mainTop, mainBot);
    // Path-Modus: sichtbares Ende, wenn der Pfad die Modell-Bbox verlassen hat
    // (s. `path.js` `fetchGridForPath`) -- kein stiller Abbruch. Point-Modus
    // übergibt `state.pathStop` nie, hier also ohne Wirkung.
    if (state.pathStop) drawPathStopMarker(ctx, x, mainTop, mainBot, state.pathStop.reason);
    if (!isPath) drawGround(ctx, grid, view, x, mainBot, stripH);

    let rowTop = mainBot + stripH + GAP;
    for (const id of activeRows) {
      const def = ROW_DEFS[id];
      ctx.save();
      ctx.beginPath(); ctx.rect(x.left, rowTop, pw, def.height); ctx.clip();
      def.draw(ctx, grid, view, x, rowTop, def.height);
      ctx.restore();
      ctx.strokeStyle = GRID; ctx.lineWidth = 1;
      ctx.strokeRect(x.left + 0.5, rowTop + 0.5, pw - 1, def.height - 1);
      // Beschriftung im linken Randfeld (wie die Höhenachse), nicht über den
      // Werten -- dort war sie kaum lesbar (überlagert von Fiedern/Zahlen).
      drawRowLabel(ctx, typeof def.label === "function" ? def.label() : def.label, x.left - 4, rowTop, def.height);
      rowTop += def.height;
    }

    if (grid.meta.mode === "path") drawPathAxis(ctx, grid, x, mainTop, rowTop);
    else drawTimeAxis(ctx, times, x, mainTop, rowTop);
    ctx.fillStyle = INK; ctx.font = "bold 12px system-ui, sans-serif"; ctx.textAlign = "left";
    ctx.fillText("GRAMET", x.left, 13);

    const axis = makeStickyAxis(canvas, W, H, dpr);
    const plot = document.createElement("div");
    plot.className = "gm-plot";
    plot.append(axis, canvas);

    host.append(plot);
    // Attribution als DOM-Link (nicht Canvas-Text -- muss klickbar sein, s.
    // Mapterhorn-Lizenzbedingungen). Kein fester Einzelsatz möglich (die
    // Kacheln bündeln >130 regionale Quellen mit je eigener Lizenz), deshalb
    // Kurz-Credit mit Link auf die volle Liste statt Aufzählung inline.
    if (showRealTerrain) {
      const attribution = document.createElement("a");
      attribution.href = TERRAIN_ATTRIBUTION.url;
      attribution.target = "_blank";
      attribution.rel = "noopener noreferrer";
      attribution.textContent = TERRAIN_ATTRIBUTION.label;
      attribution.style.cssText = "display:block;font:10px system-ui,sans-serif;color:#8a8a86;text-decoration:none;padding:2px 4px;";
      host.append(attribution);
    }
    setupHover(host, canvas, axis, grid, { x, y, mainTop, mainBot, view, isPath });
    state.onRedraw?.(canvas);
    return canvas;
  }

  const canvas = draw();

  let resizeTimer = null;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, RESIZE_DEBOUNCE_MS);
  });
  ro.observe(host);
  host.__gmObserver = ro;

  return canvas;
}

// Der linke Randstreifen (Höhenachse + Zeilenbeschriftung) wird als Kopie der
// ersten `M.l` Pixel des fertigen Charts in ein eigenes, `position: sticky`
// gesetztes Canvas gespiegelt: beim horizontalen Scrollen bleibt die
// Beschriftung stehen, der Chart läuft darunter durch. Bewusst eine Kopie und
// kein eigener Zeichenpfad -- so bleibt genau ein Renderpfad, und das
// Haupt-Canvas enthält weiterhin alles (der PNG-Export braucht keine
// Sonderbehandlung).
function makeStickyAxis(canvas, W, H, dpr) {
  const axis = document.createElement("canvas");
  axis.className = "gm-axis";
  axis.width = Math.round(M.l * dpr);
  axis.height = Math.round(H * dpr);
  axis.style.width = `${M.l}px`;
  axis.style.height = `${H}px`;
  const actx = axis.getContext("2d");
  actx.scale(dpr, dpr);
  actx.fillStyle = PANEL_BG;
  actx.fillRect(0, 0, M.l, H);
  actx.drawImage(canvas, 0, 0, Math.round(M.l * dpr), canvas.height, 0, 0, M.l, H);
  // Negativer Rand: das Haupt-Canvas beginnt unter dem Streifen, die Summe der
  // Flex-Breiten bleibt damit W (kein zusätzlicher Scrollweg).
  canvas.style.marginLeft = `${-M.l}px`;
  return axis;
}

export function exportPng(canvas, nameParts) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${nameParts.filter(Boolean).join("_")}.png`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// --- Skalen ------------------------------------------------------------------

function makeYScale(top, bot, hMin, hMax, lin) {
  const safeMin = Math.max(hMin, lin ? hMin : 1);
  const la = lin ? safeMin : Math.log(safeMin), lb = lin ? hMax : Math.log(hMax);
  const f = (h) => {
    const s = lin ? clamp(h, safeMin, hMax) : Math.log(clamp(h, safeMin, hMax));
    return bot - (s - la) / (lb - la) * (bot - top);
  };
  f.top = top; f.bot = bot;
  f.inv = (py) => {
    const frac = clamp((bot - py) / (bot - top), 0, 1);
    return lin ? hMin + frac * (hMax - hMin) : Math.exp(la + frac * (lb - la));
  };
  return f;
}

// --- Hintergrund (Tag/Nacht) --------------------------------------------------

function drawBackground(ctx, grid, view, x, y, top, bot) {
  const { pos } = grid;
  const span = x.right - x.left, h = bot - top;

  // Grundverlauf Tag/Nacht -- waagerecht, unverändert.
  const grad = ctx.createLinearGradient(x.left, 0, x.right, 0);
  let lastOff = -1;
  for (let i = 0; i < pos.length; i++) {
    let off = clamp((x(pos[i]) - x.left) / span, 0, 1);
    if (off <= lastOff) off = Math.min(1, lastOff + 1e-4);
    grad.addColorStop(off, mixHex(NIGHT_COLOR, DAY_COLOR, view.daylight[i]));
    lastOff = off;
  }
  ctx.fillStyle = grad;
  ctx.fillRect(x.left, top, span, h);

  // Senkrechte Tiefe: Zenit dunkler als Horizont, multiplikativ statt additiv
  // aufgetragen -- bei Nacht ist der Grundton schon fast schwarz, ein
  // additiver dunkler Schleier hätte dort nichts mehr zu vertiefen (unten
  // bliebe er sichtbar grau) und bei Tag hätte er den ganzen Himmel gleich
  // stark eingetrübt statt nur oben. Multiplikativ skaliert die Vertiefung
  // stattdessen mit dem, was schon da ist.
  //
  // An der tatsächlichen HÖHE festgemacht (`y.inv`), nicht an der Panel-
  // Pixelposition -- sonst hätte dieselbe Höhe in "Gesamthöhe" und "bis
  // Flughöhe" unterschiedliche Farbe, weil dort jeweils etwas anderes an der
  // Panel-Oberkante steht (s. Feedback). Dafür reicht ein simpler 2-Stopp-
  // Gradient nicht: `y.inv` ist bei log-Achse nichtlinear in der Pixel-
  // koordinate, also wird die Kurve wie beim Tag/Nacht-Verlauf aus vielen
  // Stopps abgetastet -- hier gleichmäßig über die PIXEL (nicht über die
  // Höhe), damit die Auflösung unabhängig vom aktuellen Zoomfenster reicht.
  const depth = ctx.createLinearGradient(0, top, 0, bot);
  const DEPTH_STEPS = 40;
  for (let s = 0; s <= DEPTH_STEPS; s++) {
    const py = top + h * s / DEPTH_STEPS;
    const alpha = DEPTH_MAX_ALPHA * depthAt(y.inv(py));
    depth.addColorStop(s / DEPTH_STEPS, `rgba(2,6,16,${alpha})`);
  }
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = depth;
  ctx.fillRect(x.left, top, span, h);
  ctx.restore();
}

// Feste Referenzspanne für die Zenit-Verdunklung, bewusst UNABHÄNGIG von
// `grid.z`/`zMax` (s. Kommentar oben): 10 m (derselbe Bodenwert wie
// `hMinData` in `renderGramet`) bis 12000 m, grob Tropopausenniveau -- ab da
// ist der Himmel ohnehin schon fast im vollen Zenit-Ton, höher als in der
// Praxis gezeigt lohnt keine weitere Abstufung.
const DEPTH_REF_MIN = 10, DEPTH_REF_MAX = 12000;
const DEPTH_MAX_ALPHA = 0.55;
function depthAt(z) {
  return clamp((z - DEPTH_REF_MIN) / (DEPTH_REF_MAX - DEPTH_REF_MIN), 0, 1);
}

// --- Nebel/Dunst (BR/HZ) -------------------------------------------------------
//
// FG braucht hier nichts -- läuft komplett über `drawClouds()` (`cloudFrac`
// ist am Boden bereits hoch) plus das Label in der Wetter-Zeile. BR/HZ haben
// per Definition (s. `hazards/fog.js`) KEIN cloudFrac-Signal -- Luft ist
// nicht gesättigt -- und brauchen daher einen eigenen Schleier.
//
// Zwei UNABHÄNGIGE Verläufe (waagerecht: welche Stunde/welcher Typ+welche
// Stärke, senkrecht: wie nah am Boden) lassen sich nicht in einem einzigen
// Canvas-Gradient kombinieren. Deshalb der Offscreen-Umweg (gleiche Technik
// wie die Zenit-Tiefe oben, nur mit vertauschten Rollen): zuerst waagerecht
// Farbe+Stärke je Stunde aufmalen (wie der Tag/Nacht-Grundverlauf in
// `drawBackground`, nur mit BR-/HZ-Farbe statt Nacht/Tag), danach per
// `destination-in` mit der senkrechten Form maskieren (Boden voll, ab
// `HAZE_REF_MAX` nichts mehr) -- an der tatsächlichen HÖHE festgemacht wie
// `DEPTH_REF_MAX` oben, nicht an Panel-Pixeln, sonst hätte dieselbe Höhe bei
// "Gesamthöhe" und "bis Flughöhe" unterschiedlich viel Schleier.
const HAZE_REF_MIN = 10, HAZE_REF_MAX = 400; // m AGL -- gemeinsame Reichweite des Schleiers für FG/BR/HZ
// Kräftiger als im ersten Entwurf (0.5/gedämpfte Baseline) -- BR/HZ waren
// dort kaum vom normalen Himmel zu unterscheiden (s. Feedback).
const HAZE_MAX_ALPHA = 0.7;
// BR/FG waren als fast identisches Weißlich-Grau (225,235,238 / 210,212,214)
// nur noch über die Opazität zu unterscheiden -- bei schwacher BR-Stärke
// (t nahe 0, s. u.) kaum von echtem FG zu trennen (s. Feedback). Jetzt zwei
// eigene Farbfamilien: BR bleibt beim kühlen, leicht bläulichen Diesig-Ton
// (feuchter Dunst), FG rückt Richtung neutrales, dichtes Grau (fast farblos,
// wie eine geschlossene Nebelwand) -- der Farbabstand bleibt so auch bei
// schwacher BR-Stärke sichtbar, nicht erst am Opazitätsunterschied.
const BR_COLOR = "195,215,232"; // kühles Blaugrau -- BR ist feucht (Diesigkeit)
const HZ_COLOR = "196,155,74";  // ockerfarben -- HZ simuliert trockenen Staubdunst
// FG läuft über denselben Schleier wie BR/HZ (gleiche Reichweite/Verlaufsform
// statt eines eigenen scharf konturierten Blocks, s. Feedback: der harte
// Umriss mit fixem 100-m-Fallback-Top passte weder farblich noch in der Höhe
// zum weichen 400-m-Verlauf von BR/HZ), zusätzlich zur eigenen Farbfamilie
// (s. o.) weiterhin mit deutlich höherer Opazität -- "man sieht buchstäblich
// nichts mehr" statt eines durchscheinenden Schleiers.
const FG_COLOR = "196,197,199"; // neutrales, dichtes Grau -- bewusst blaustichfrei, Gegenteil von BR
const FG_ALPHA = 0.92;

/** Schleierfarbe+-stärke einer Stunde. Sicht ist jetzt das primäre Kriterium
 *  (s. `hazards/fog.js`) -- Rampe daher an der Position innerhalb des
 *  Sichtweiten-Bands (FG_VIS_MAX_M..HAZE_VIS_MAX_M) festgemacht, nicht mehr
 *  an RH. `visM` fehlt nur im seltenen Rand-/Instanzfall ohne Sichtweiten-
 *  daten (Fallback-Klassifikation in `fog.js`) -- dort bleibt RH die einzige
 *  verfügbare Größe für eine grobe Rampe. Baseline+Rampe statt reinem
 *  0..1-Verhältnis, damit "gerade eben BR/HZ" nicht schon fast unsichtbar
 *  ist -- rein optisch gewählt, nicht kalibriert. */
function hazeColorAlpha(entry, visM, rh0) {
  if (!entry) return null;
  if (entry.type === "FG") return { color: FG_COLOR, alpha: FG_ALPHA };
  const t = Number.isFinite(visM)
    ? clamp(1 - (visM - fog.FG_VIS_MAX_M) / (fog.HAZE_VIS_MAX_M - fog.FG_VIS_MAX_M), 0, 1)
    : Number.isFinite(rh0)
      ? clamp((rh0 - (entry.type === "BR" ? fog.BR_RH_FALLBACK_MIN : fog.HZ_RH_FALLBACK_MIN)) / 20, 0, 1)
      : 0.5;
  if (entry.type === "BR") return { color: BR_COLOR, alpha: HAZE_MAX_ALPHA * (0.65 + 0.35 * t) };
  if (entry.type === "HZ") return { color: HZ_COLOR, alpha: HAZE_MAX_ALPHA * (0.45 + 0.4 * t) };
  return null;
}

// `groundAt` (nur Path-Modus, sonst null): Modell-Geländehöhe in Achsen-
// Einheiten (AMSL) als Funktion der Pfadposition -- der Schleier ist an der
// Höhe ÜBER GRUND festgemacht (HAZE_REF_*) und muss dem Gelände folgen.
function drawFogHaze(ctx, grid, view, x, y, top, bot, groundAt = null) {
  const { pos, nk } = grid;
  const span = x.right - x.left, h = bot - top;
  if (span <= 0 || h <= 0 || !view.fog) return;

  // Waagerecht: Farbe+Stärke je Stunde, wie der Tag/Nacht-Grundverlauf.
  const colorGrad = ctx.createLinearGradient(x.left, 0, x.right, 0);
  let lastOff = -1, anyHaze = false;
  for (let i = 0; i < pos.length; i++) {
    let off = clamp((x(pos[i]) - x.left) / span, 0, 1);
    if (off <= lastOff) off = Math.min(1, lastOff + 1e-4);
    const ca = hazeColorAlpha(view.fog[i], grid.surface?.visibility?.[i], grid.rh[i * nk]);
    if (ca) anyHaze = true;
    colorGrad.addColorStop(off, ca ? `rgba(${ca.color},${ca.alpha})` : "rgba(0,0,0,0)");
    lastOff = off;
  }
  if (!anyHaze) return; // nichts zu zeichnen -- Offscreen-Aufwand sparen

  const dpr = window.devicePixelRatio || 1;
  const offCanvas = document.createElement("canvas");
  offCanvas.width = Math.max(1, Math.round(span * dpr));
  offCanvas.height = Math.max(1, Math.round(h * dpr));
  const octx = offCanvas.getContext("2d");
  octx.scale(dpr, dpr);
  octx.translate(-x.left, -top);

  octx.fillStyle = colorGrad;
  octx.fillRect(x.left, top, span, h);

  // Senkrecht: Form als Maske, an der tatsächlichen Höhe festgemacht (s. o.).
  const HAZE_SHAPE_STEPS = 24;
  if (!groundAt) {
    // Punkt-Modus (AGL-Achse): ein Verlauf über die volle Breite reicht, der
    // Boden liegt überall auf derselben Achsenhöhe.
    const shape = octx.createLinearGradient(0, top, 0, bot);
    for (let s = 0; s <= HAZE_SHAPE_STEPS; s++) {
      const py = top + h * s / HAZE_SHAPE_STEPS;
      const z = y.inv(py);
      const a = clamp(1 - (z - HAZE_REF_MIN) / (HAZE_REF_MAX - HAZE_REF_MIN), 0, 1);
      shape.addColorStop(s / HAZE_SHAPE_STEPS, `rgba(0,0,0,${a})`);
    }
    octx.globalCompositeOperation = "destination-in";
    octx.fillStyle = shape;
    octx.fillRect(x.left, top, span, h);
  } else {
    // Path-Modus (AMSL-Achse): die Maske muss dem Gelände folgen -- ein
    // einzelner Vertikalverlauf kann das nicht. Stattdessen schmale Streifen
    // mit je eigenem Verlauf in ein ZWEITES Offscreen (source-over) malen und
    // das einmal als Ganzes per destination-in anwenden -- destination-in
    // direkt je Streifen würde bei jedem Fill alles AUSSERHALB des Streifens
    // löschen (Compositing wirkt canvasweit).
    const STRIP_PX = 8;
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = offCanvas.width;
    maskCanvas.height = offCanvas.height;
    const mctx = maskCanvas.getContext("2d");
    mctx.scale(dpr, dpr);
    mctx.translate(-x.left, -top);
    for (let sx = x.left; sx < x.right; sx += STRIP_PX) {
      const w = Math.min(STRIP_PX, x.right - sx);
      const p = pos[0] + (sx + w / 2 - x.left) / span * (pos[pos.length - 1] - pos[0]);
      const g = groundAt(p);
      const shape = mctx.createLinearGradient(0, top, 0, bot);
      for (let s = 0; s <= HAZE_SHAPE_STEPS; s++) {
        const py = top + h * s / HAZE_SHAPE_STEPS;
        const a = clamp(1 - (y.inv(py) - g - HAZE_REF_MIN) / (HAZE_REF_MAX - HAZE_REF_MIN), 0, 1);
        shape.addColorStop(s / HAZE_SHAPE_STEPS, `rgba(0,0,0,${a})`);
      }
      mctx.fillStyle = shape;
      mctx.fillRect(sx, top, w, h);
    }
    octx.globalCompositeOperation = "destination-in";
    octx.save();
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.drawImage(maskCanvas, 0, 0);
    octx.restore();
  }

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.drawImage(offCanvas, x.left, top, span, h);
  ctx.restore();
}

// --- Nebel (FG): Ellipsentextur ausblenden ---------------------------------------
//
// FG wird seit der Sichtweiten-Umstellung über denselben Schleier wie BR/HZ
// gezeichnet (s. `drawFogHaze`/`hazeColorAlpha` oben) -- kein eigener Block
// mehr. Die normale Ellipsentextur von `drawClouds()` soll innerhalb der
// FG-Schicht trotzdem nicht mitlaufen (s. Feedback: wirkt für Nebel zu
// "gefleckt"/wolkig, echter Bodennebel ist optisch eintönig) -- dafür bleibt
// eine schmale Maskierung nötig, unabhängig von der (weicheren, weiter
// reichenden) Schleier-Optik.
//
// Ersatz-Obergrenze, wenn die Klassifikation keine liefert (Sichtweiten-/
// WW-Code-Fallback ohne RH/Kondensat-Top, s. hazards/fog.js): eine typische
// flache Nebelschicht, rein optisch gewählt, nicht kalibriert.
const FG_MASK_FALLBACK_M = 100;

/** 0/1-Feld (nt*nk): 1, wo eine Zelle innerhalb der (für die Maskierung
 *  angenommenen) FG-Schicht der jeweiligen Stunde liegt. */
function fgField(grid, fogCols) {
  const { nk, times } = grid;
  const field = new Float32Array(times.length * nk);
  let any = false;
  for (let i = 0; i < times.length; i++) {
    const entry = fogCols?.[i];
    if (!entry || entry.type !== "FG") continue;
    const topZ = entry.top ?? FG_MASK_FALLBACK_M;
    for (let k = 0; k < nk; k++) {
      const ix = i * nk + k;
      if (grid.z[ix] <= topZ) { field[ix] = 1; any = true; }
    }
  }
  return any ? field : null;
}

/** `cloudFrac`, mit auf 0 gesetzten FG-Zellen -- für `drawClouds()`, damit
 *  dort keine Ellipsentextur unter dem Nebelschleier entsteht. `view.cloudFrac`
 *  selbst bleibt unverändert (Vereisung/Wolkenbasis/Hover-Tooltip sollen Nebel
 *  weiterhin als echte Wolke sehen -- physikalisch ist er das ja auch, nur die
 *  TEXTUR soll ihn nicht mehr zeichnen). */
function maskFog(grid, cloudFrac, fogCols) {
  const field = fgField(grid, fogCols);
  if (!field) return cloudFrac;
  const out = Float32Array.from(cloudFrac);
  for (let ix = 0; ix < out.length; ix++) if (field[ix]) out[ix] = 0;
  return out;
}

// --- Boden ---------------------------------------------------------------------

// Schmaler Streifen direkt unter dem Hauptpanel, s. Kommentar an `GROUND_H`.
// Gleiche Verlaufstechnik wie `drawBackground` (ein Farbstopp je Zeitschritt),
// zusätzlich pro Stopp Richtung `GROUND_FROST` gezogen, wenn die Bodentemperatur
// an oder unter dem Gefrierpunkt liegt -- linear ausgereizt bis -5 °C, damit ein
// Streifen mit nur -0.5 °C nicht schon voll bereift wirkt.
const GROUND_FROST_SPAN = 5;

// Horizontaler Tag/Nacht-+Frost-Verlauf des Bodens -- gemeinsam für den
// Punkt-Modus-Streifen (`drawGround`) und die Path-Modus-Silhouette
// (`drawModelTerrain`), damit beide Modi denselben Bodenton sprechen.
function groundGradient(ctx, grid, view, x) {
  const { pos, surface } = grid;
  const span = x.right - x.left;
  const grad = ctx.createLinearGradient(x.left, 0, x.right, 0);
  let lastOff = -1;
  for (let i = 0; i < pos.length; i++) {
    let off = clamp((x(pos[i]) - x.left) / span, 0, 1);
    if (off <= lastOff) off = Math.min(1, lastOff + 1e-4);
    const dayNight = blend3(GROUND_NIGHT, GROUND_DAY, view.daylight[i]);
    const t2m = surface?.t2m?.[i];
    const frostT = Number.isFinite(t2m) ? clamp(-t2m / GROUND_FROST_SPAN, 0, 1) : 0;
    grad.addColorStop(off, rgbStr(blendRGB(dayNight, hex(GROUND_FROST), frostT)));
    lastOff = off;
  }
  return grad;
}

function drawGround(ctx, grid, view, x, top, h) {
  const span = x.right - x.left;
  ctx.fillStyle = groundGradient(ctx, grid, view, x);
  ctx.fillRect(x.left, top, span, h);

  // Horizontlinie: dunkler Kontaktschatten, wo der Himmel auf den Boden trifft.
  ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x.left, top + 0.5); ctx.lineTo(x.right, top + 0.5); ctx.stroke();
}

// --- AMSL-Projektion + Terrain (Path-Modus) ----------------------------------
//
// Der Path-Modus plottet die Haupttafel in AMSL (Ogimet-Konvention: Gelände
// als Silhouette im Diagramm), der Punkt-Modus weiterhin in AGL. WICHTIG:
// `grid.z` und alles in `derive.js`/`hazards/` BLEIBT AGL relativ zur
// Modell-Orographie -- die Physik-Heuristiken (Nebel-Tops, Wolkenbasis,
// Tropopausensuche ab 5000 m AGL, ...) hängen an dieser Bedeutung, und
// METHODIK 5b erklärt, warum eine Umreferenzierung der DATEN aufs echte
// Gelände physikalisch falsch wäre. Umgerechnet wird ausschließlich die
// RENDER-Geometrie: eine Zelle bei AGL h an Spalte i liegt bei
// AMSL h + grid.elevation[i] (Modell-Orographie der Spalte).

// Stützwert an Position `p`, linear zwischen `xs`-Stützstellen; außerhalb
// konstant. Zustandslos (anders als der frühere Cursor-Interpolator) -- wird
// auch für nicht-aufsteigende Abfolgen gebraucht (Polylinien-Konvertierung).
function interpAt(xs, ys, p) {
  if (!(xs.length > 1) || p <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] >= p) {
      const f = xs[i] > xs[i - 1] ? (p - xs[i - 1]) / (xs[i] - xs[i - 1]) : 0;
      return ys[i - 1] + f * (ys[i] - ys[i - 1]);
    }
  }
  return ys[xs.length - 1];
}

// AMSL-Kopie des Grids (nur `z` verschoben, alles andere per Referenz).
// WeakMap-Cache statt Neubau je draw(): `texture.js` cached die (teure)
// Wolkentextur am Grid-OBJEKT -- ein bei jedem Redraw neues Objekt würde
// diesen Cache wirkungslos machen.
const amslGridCache = new WeakMap();
function amslGrid(grid) {
  let g = amslGridCache.get(grid);
  if (g) return g;
  const { nk } = grid, nt = grid.times.length;
  const z = new Float32Array(grid.z.length);
  for (let i = 0; i < nt; i++) {
    for (let k = 0; k < nk; k++) z[i * nk + k] = grid.z[i * nk + k] + grid.elevation[i];
  }
  g = { ...grid, z };
  amslGridCache.set(grid, g);
  return g;
}

// AMSL-Kopie der View-Geometrie: alle Höhenangaben, die der Renderer direkt
// auf `y` legt (Polylinien, Niederschlags-Tops, Cb-Basis/-Oberrand), um die
// Modell-Orographie an ihrer Pfadposition verschieben. Indexbasierte Felder
// (daylight, cloudFrac, fog, hazards) bleiben unverändert per Referenz --
// die Hazard-Konturen entstehen erst im Renderer via `contour(rgrid, ...)`
// und erben die AMSL-Höhen von dort.
const amslViewCache = new WeakMap();
function amslViewOf(view, grid) {
  let v = amslViewCache.get(view);
  if (v) return v;
  const eAt = (p) => interpAt(grid.pos, grid.elevation, p);
  const cvtPl = (pl) => pl.map((pt) => ({ ...pt, z: pt.z + eAt(pt.t) }));
  v = {
    ...view,
    isotherms: view.isotherms.map(({ tempC, polylines }) => ({ tempC, polylines: polylines.map(cvtPl) })),
    isotachs: view.isotachs.map(({ kt, polylines }) => ({ kt, polylines: polylines.map(cvtPl) })),
    tropopause: cvtPl(view.tropopause),
    precip: view.precip.map((e) => ({
      ...e,
      zTop: e.zTop + eAt(e.t),
      freezingZ: Number.isFinite(e.freezingZ) ? e.freezingZ + eAt(e.t) : e.freezingZ,
    })),
    cb: view.cb.map((c, i) => (c
      ? { ...c, base: c.base + grid.elevation[i], top: c.top + grid.elevation[i] }
      : null)),
  };
  amslViewCache.set(view, v);
  return v;
}

// Deckel der "Gesamthöhe": höchster Tropopausenpunkt der Tafel plus Polster,
// sonst der feste Rückfallwert (s. Konstanten oben). `line` ist die bereits
// projizierte Tropopausen-Polylinie aus `view`/`amslViewOf` -- damit stimmt
// die Bezugshöhe automatisch mit der gezeichneten Achse überein.
function fullRangeTop(line) {
  let top = -Infinity;
  for (const p of line ?? []) if (Number.isFinite(p.z) && p.z > top) top = p.z;
  return Number.isFinite(top) ? top + TROPOPAUSE_HEADROOM_M : FULL_RANGE_FALLBACK_TOP_M;
}

// Ruft `cb(i0, i1)` für jeden zusammenhängenden Abschnitt endlicher Werte auf
// -- Kachel-Lücken (`NaN`, s. `terrain.js`) unterbrechen Fläche/Linie, statt
// falsch durchgezogen zu werden.
function forEachFiniteRun(values, cb) {
  let start = null;
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) {
      if (start == null) start = i;
    } else if (start != null) {
      cb(start, i - 1);
      start = null;
    }
  }
  if (start != null) cb(start, values.length - 1);
}

function lastFiniteIndex(values) {
  for (let i = values.length - 1; i >= 0; i--) if (Number.isFinite(values[i])) return i;
  return null;
}

// Kontaktschatten-Linie zwischen Terrain und Atmosphäre als weißer Halo +
// dunkle Linie (statt eines einfachen halbtransparenten Schwarz) -- MUSS
// auch nachts sichtbar bleiben, wo Boden- (`GROUND_NIGHT`) und Himmelfarbe
// (`NIGHT_COLOR`) beide fast schwarz sind und eine reine Schwarz-auf-Schwarz-
// Linie darin verschwindet (s. Feedback). Gleiche Technik wie die AGL-
// Deckellinie unten.
function terrainEdgePath(pos, i0, i1, yOf, x) {
  const path = new Path2D();
  path.moveTo(x(pos[i0]), yOf(i0));
  for (let i = i0 + 1; i <= i1; i++) path.lineTo(x(pos[i]), yOf(i));
  return path;
}
function strokeTerrainEdge(ctx, path) {
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.65)"; ctx.lineWidth = 2.5; ctx.stroke(path);
  ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 1; ctx.stroke(path);
}

// Modell-Orographie als Silhouette in der Haupttafel (nur Path-Modus, AMSL-
// Achse): `grid.elevation` ist genau der Boden, auf dem die Wetterdaten
// stehen (`height_agl_level*` zählt von hier, s. METHODIK 5b) -- Wolken,
// Vorhänge und Level schließen also konstruktionsbedingt sauber an die
// Silhouette an. Eingefärbt mit demselben Tag/Nacht-+Frost-Verlauf wie der
// Punkt-Modus-Bodenstreifen (`groundGradient`). Läuft NACH allen Inhalts-
// layern (s. Aufrufstelle) -- ein Fill-Aufruf deckt alle Überstände ab,
// statt jeden Layer einzeln zu clippen.
function drawModelTerrain(ctx, grid, view, x, y, mainBot) {
  const { pos, elevation } = grid;
  ctx.fillStyle = groundGradient(ctx, grid, view, x);
  ctx.beginPath();
  ctx.moveTo(x(pos[0]), mainBot);
  for (let i = 0; i < pos.length; i++) ctx.lineTo(x(pos[i]), y(elevation[i]));
  ctx.lineTo(x(pos[pos.length - 1]), mainBot);
  ctx.closePath();
  ctx.fill();
  strokeTerrainEdge(ctx, terrainEdgePath(pos, 0, pos.length - 1, (i) => y(elevation[i]), x));
}

// Echtes Gelände (Mapterhorn, `terrain.js`) als VERGLEICHS-Overlay über der
// Modell-Silhouette -- AMSL auf AMSL, keine Umrechnung mehr nötig. Bewusst
// halbtransparent + gestrichelt statt deckend: es soll die Modell/Real-
// Differenz (METHODIK 5b, z. B. Zugspitze −500 m) sichtbar machen, nicht die
// Modellwelt ersetzen -- die Wetterdaten gelten weiterhin relativ zur
// Modell-Orographie. Wo das echte Gelände ÜBER der Modellkante liegt, steht
// die Füllung als durchscheinender Fels im "Modell-Himmel"; in Tälern
// (real unter Modell) läuft die gestrichelte Linie sichtbar durch die
// Modell-Silhouette. Kachel-Lücken (NaN) bleiben ausgespart -- lieber nichts
// behaupten als falsch zeichnen.
const REAL_TERRAIN_FILL = "rgba(46,36,24,0.35)";
function drawRealTerrainOverlay(ctx, terrain, x, y, mainBot) {
  const { pos, elevation } = terrain;
  forEachFiniteRun(elevation, (i0, i1) => {
    if (i1 === i0) return;
    ctx.beginPath();
    ctx.moveTo(x(pos[i0]), mainBot);
    for (let i = i0; i <= i1; i++) ctx.lineTo(x(pos[i]), y(elevation[i]));
    ctx.lineTo(x(pos[i1]), mainBot);
    ctx.closePath();
    ctx.fillStyle = REAL_TERRAIN_FILL;
    ctx.fill();

    // Gestrichelt (anders als die durchgezogene Modellkante), EIN Strich statt
    // Halo+Kernlinie -- ein Vergleichs-Overlay soll zurückhaltender wirken als
    // die Modellkante selbst (s. Feedback), der Halo machte die Linie zu
    // präsent. Heller, halbtransparenter Ton statt dunkler Kernfarbe: bleibt
    // so auf fast schwarzem Nachthimmel/-boden noch ablesbar, ganz ohne Halo.
    const path = terrainEdgePath(pos, i0, i1, (i) => y(elevation[i]), x);
    ctx.save();
    ctx.lineJoin = "round";
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = "rgba(216,210,198,0.2)"; ctx.lineWidth = 1.3; ctx.stroke(path);
    ctx.restore();
  });
  const last = lastFiniteIndex(elevation);
  if (last != null) {
    ctx.fillStyle = "#d8d2c6"; ctx.font = "600 9px system-ui, sans-serif";
    ctx.textAlign = "right"; ctx.textBaseline = "bottom";
    ctx.fillText("Gelände real", x(pos[last]) - 4, y(elevation[last]) - 3);
  }
}

// Max-Flughöhen-Deckellinie, terrainfolgend: dieselbe Optik wie
// `crosssection.js`s `flightLine` (weißer Halo + `#b5179e` gestrichelt).
// `maxHeightM` ist eine AGL-Angabe (`settings.maxHeight`) und zählt legal
// über REALEM Grund -- deshalb folgt die Linie dem Mapterhorn-Gelände, wenn
// es eingeblendet ist (`terrain`), sonst der Modell-Orographie als bester
// verfügbarer Näherung. Beides ist auf der AMSL-Achse eine simple Addition.
function drawCeiling(ctx, grid, terrain, maxHeightM, x, y) {
  const pos = terrain ? terrain.pos : grid.pos;
  const ground = terrain ? terrain.elevation : grid.elevation;
  ctx.save();
  ctx.lineJoin = "round";
  forEachFiniteRun(ground, (i0, i1) => {
    if (i1 === i0) return;
    const path = new Path2D();
    path.moveTo(x(pos[i0]), y(ground[i0] + maxHeightM));
    for (let i = i0 + 1; i <= i1; i++) path.lineTo(x(pos[i]), y(ground[i] + maxHeightM));
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.setLineDash([]); ctx.stroke(path);
    ctx.strokeStyle = "#b5179e"; ctx.lineWidth = 1.4; ctx.setLineDash([6, 3]); ctx.stroke(path);
  });
  ctx.setLineDash([]);
  const last = lastFiniteIndex(ground);
  if (last != null) {
    ctx.fillStyle = "#b5179e"; ctx.font = "600 10px system-ui, sans-serif";
    ctx.textAlign = "right"; ctx.textBaseline = "bottom";
    ctx.fillText(`Max. Flughöhe ${fmtH(maxHeightM)} AGL`, x(pos[last]) - 4, y(ground[last] + maxHeightM) - 4);
  }
  ctx.restore();
}

// Höhenprofil der Host-App (z. B. eine berechnete Trajektorie) als Linie in
// der Haupttafel -- nur Path-Modus, `profile.z` sind ABSOLUTE Höhen (m AMSL),
// anders als die Deckellinie also keine Boden-Addition. Durchgezogen statt
// gestrichelt, damit Profil und Ceiling unterscheidbar bleiben, wenn beide
// sichtbar sind. NaN-Werte (z. B. der erste Integrationspunkt einer
// Trajektorie ohne diagnostizierte Höhe) unterbrechen die Linie
// (`forEachFiniteRun`); Höhen außerhalb des sichtbaren Bereichs werden über
// `clipPolylineZ` GESCHNITTEN statt von `y()` an den Rand geklemmt (s.
// Kommentarblock "Höhen-Clipping" unten -- sonst Phantom-Flachlinie am
// Panelrand). Der Rect-Clip schneidet zusätzlich Profilpunkte hinter dem
// Chart-Ende ab: nach einem `pathStop` läuft der Pfad der Host-App weiter
// als das Wettergitter, `x()` würde diese Punkte sonst in den Rand zeichnen.
function drawProfile(ctx, profile, x, y, mainTop, mainBot, zMin, zMax) {
  const { pos, z } = profile;
  const color = profile.color || "#b5179e";
  ctx.save();
  ctx.beginPath();
  ctx.rect(x.left, mainTop, x.right - x.left, mainBot - mainTop);
  ctx.clip();
  ctx.lineJoin = "round";
  ctx.setLineDash([]);
  let labelAt = null;
  forEachFiniteRun(z, (i0, i1) => {
    if (i1 === i0) return;
    const pl = [];
    for (let i = i0; i <= i1; i++) pl.push({ t: pos[i], z: z[i] });
    for (const piece of clipPolylineZ(pl, zMin, zMax)) {
      const path = new Path2D();
      path.moveTo(x(piece[0].t), y(piece[0].z));
      for (let k = 1; k < piece.length; k++) path.lineTo(x(piece[k].t), y(piece[k].z));
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.stroke(path);
      ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.stroke(path);
      // Label ans rechte Ende des am weitesten rechts endenden Teilstücks --
      // auch wenn dieses hinter dem Chartrand liegt (Pfad länger als das
      // Wettergitter, s. `pathStop`); die x-Position wird unten geklemmt.
      const end = piece[piece.length - 1];
      if (!labelAt || end.t > labelAt.t) labelAt = end;
    }
  });
  if (labelAt && profile.label) {
    ctx.fillStyle = color; ctx.font = "600 10px system-ui, sans-serif";
    ctx.textAlign = "right"; ctx.textBaseline = "bottom";
    ctx.fillText(profile.label, Math.min(x(labelAt.t), x.right) - 4, y(labelAt.z) - 4);
  }
  ctx.restore();
}

// --- Hazard-Flächen (Vereisung berechnet, s. hazards/icing.js; Turbulenz noch
// Stub -> zeichnet nichts) -----------------------------------------------------

// --- Höhen-Clipping (statt Klemmen) -------------------------------------------
//
// `y()` klemmt jeden Wert außerhalb [zMin, zMax] auf den jeweiligen Panelrand
// (s. `makeYScale`) -- für die Gelände-SILHOUETTE ist das genau richtig (ein
// Gipfel über der aktuellen Fensterobergrenze soll die Fläche bis zum Rand
// ausfüllen, s. `drawModelTerrain`). Für dünne LINIEN mit Randlabel
// (Isothermen/Isotachen/Tropopause) und für Hazard-Symbole wäre eine
// geklemmte Darstellung dagegen FALSCH: eine reale Isotherme bei 5000 m
// erschiene bei auf 300 m gezoomter Ansicht als waagerechte Linie MIT Label
// exakt am oberen Rand -- eine erfundene Information, kein Cutoff (s.
// Feedback: genau das passierte beim Testen des Path-Modus-Zooms). Diese
// Elemente werden deshalb VOR dem Zeichnen auf den sichtbaren Höhenbereich
// geschnitten (Liang-Barsky-artig für offene Linien, Sutherland-Hodgman für
// geschlossene Hazard-Flächen) -- ein Element, das ganz außerhalb liegt,
// verschwindet komplett, statt als Phantomlinie am Rand zu kleben.

// Offene {t,z}-Polylinie auf [zMin, zMax] zuschneiden. Kann in mehrere
// Teilstücke zerfallen (z. B. eine Isotherme, die den sichtbaren Bereich
// zweimal durchläuft) -- deshalb Array-von-Polylinien zurück, nicht eine.
function clipPolylineZ(pl, zMin, zMax) {
  if (pl.length < 2) return [];
  const inRange = (z) => z >= zMin && z <= zMax;
  const cross = (a, b, zb) => {
    const f = (zb - a.z) / (b.z - a.z);
    return { t: a.t + f * (b.t - a.t), z: zb };
  };
  // "Außerhalb" NICHT über ein striktes `<` gegen die jeweilige Grenze
  // bestimmen, sondern exakt komplementär zu `inRange` (inklusive Grenzen) --
  // sonst erkennt ein Punkt GENAU AUF der Grenze fälschlich eine Kreuzung
  // (er ist ja bereits inRange, "kreuzt" also nichts) und erzeugt ein
  // Nullstrecken-Phantomsegment.
  const belowMin = (z) => z < zMin, aboveMax = (z) => z > zMax;
  const out = [];
  let cur = inRange(pl[0].z) ? [pl[0]] : [];
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i];
    // Schnittpunkte mit BEIDEN Grenzen prüfen und entlang der Strecke sortiert
    // abarbeiten -- deckt auch den (bei sehr engem Zoom mögliche) Fall ab, dass
    // eine einzelne Strecke den ganzen sichtbaren Bereich in einem Schritt
    // durchquert (a über zMax, b unter zMin oder umgekehrt).
    const crossings = [];
    if (belowMin(a.z) !== belowMin(b.z)) crossings.push({ f: (zMin - a.z) / (b.z - a.z), pt: cross(a, b, zMin) });
    if (aboveMax(a.z) !== aboveMax(b.z)) crossings.push({ f: (zMax - a.z) / (b.z - a.z), pt: cross(a, b, zMax) });
    crossings.sort((p, q) => p.f - q.f);
    for (const { pt } of crossings) {
      cur.push(pt);
      if (cur.length >= 2) out.push(cur);
      cur = [pt];
    }
    if (inRange(b.z)) cur.push(b); else cur = crossings.length ? [] : cur;
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}

// Sutherland-Hodgman-Clipping einer (implizit geschlossenen) Kontur-Polylinie
// gegen [zMin, zMax] -- zweimal gegen je eine Halbebene. Anders als bei einer
// offenen Linie zerfällt eine Fläche beim Clippen nicht in mehrere Stücke
// (konvex genug für unsere Zwecke: eine einzelne Höhenspanne pro Spalte).
function clipPolygonZ(poly, zMin, zMax) {
  const half = (pts, keep, zb) => {
    if (pts.length < 2) return [];
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], prev = pts[(i - 1 + pts.length) % pts.length];
      const curIn = keep(cur.z, zb), prevIn = keep(prev.z, zb);
      if (curIn) {
        if (!prevIn) {
          const f = (zb - prev.z) / (cur.z - prev.z);
          out.push({ t: prev.t + f * (cur.t - prev.t), z: zb });
        }
        out.push(cur);
      } else if (prevIn) {
        const f = (zb - prev.z) / (cur.z - prev.z);
        out.push({ t: prev.t + f * (cur.t - prev.t), z: zb });
      }
    }
    return out;
  };
  let p = half(poly, (z, zb) => z >= zb, zMin);
  p = half(p, (z, zb) => z <= zb, zMax);
  return p;
}

// Kontur-Umriss statt Zellraster: reicht die Schweregrad-Zeichenkette (none/
// light/moderate/severe) als Zahlenfeld an `contour()` (marching squares,
// dieselbe Funktion wie für die Isotachen) durch und zeichnet je Schwelle
// eine gestrichelt umrandete, leicht gefüllte Fläche -- wie im Referenz-
// Screenshot (gelb umrandete Fläche um den Amboss), nicht als Pixelraster.
// `contour()` polstert das Gitter am Rand (s. dort), damit Flächen, die eine
// Gitterkante durchgehend erfüllen (z. B. Turbulenz schon zur ersten Stunde
// oder am untersten Level), als geschlossene Polylinie zurückkommen, statt
// dass `closePath()` sie mit einer geraden Linie quer durchs Bild schließt.
function drawHazardArea(ctx, grid, hazardArr, styles, x, y) {
  const n = grid.times.length * grid.nk;
  const field = new Float32Array(n);
  for (let ix = 0; ix < n; ix++) field[ix] = HAZARD_LEVELS[hazardArr[ix]] || 0;
  const zMin = y.inv(y.bot), zMax = y.inv(y.top);

  for (const [level, key] of [[1, "light"], [2, "moderate"], [3, "severe"]]) {
    // Auf den sichtbaren Höhenbereich geschnitten (s. `clipPolygonZ`) -- eine
    // Fläche, die ganz außerhalb des aktuellen Zooms liegt, verschwindet damit
    // komplett, statt am Rand geklemmt eine Phantomfläche zu zeigen.
    const polylines = contour(grid, field, level - 0.5)
      .map((pl) => clipPolygonZ(pl, zMin, zMax))
      .filter((pl) => pl.length >= 3);
    if (!polylines.length) continue;
    const color = styles[key];
    for (const pl of polylines) {
      ctx.beginPath();
      pl.forEach((p, i) => {
        const px = x(p.t), py = y(p.z);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fillStyle = `${color}33`;
      ctx.fill();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = color; ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

// --- Vereisung: Symbol in "severe"-Flächen -----------------------------------

// Eigenes Konturfeld nur für "severe" (Schwellen s. hazards/icing.js): ein
// Symbol je zusammenhängender Fläche, an deren (Polylinien-)Schwerpunkt --
// analog zum Cb-Symbol (ein Symbol je Fläche/Zelle statt Textur-Streusaat),
// mit demselben Mindestabstand `GLYPH_MIN_GAP` gegen Überlappung bei
// mehreren knapp benachbarten Flächen.
function drawIcingSevereGlyphs(ctx, grid, hazardArr, x, y) {
  const n = grid.times.length * grid.nk;
  const field = new Float32Array(n);
  for (let ix = 0; ix < n; ix++) field[ix] = hazardArr[ix] === "severe" ? 1 : 0;
  const zMin = y.inv(y.bot), zMax = y.inv(y.top);
  // Geclippter Schwerpunkt statt roher Kontur -- eine Fläche, die ganz
  // außerhalb des Zooms liegt, bekommt kein Symbol (nichts sichtbar, wofür
  // eins stehen könnte); eine teilweise sichtbare bekommt eins innerhalb
  // des sichtbaren Ausschnitts statt am geklemmten Rand.
  const polylines = contour(grid, field, 0.5)
    .map((pl) => clipPolygonZ(pl, zMin, zMax))
    .filter((pl) => pl.length >= 3);
  const size = 20;
  const centers = polylines
    .map((pl) => ({
      cx: pl.reduce((s, p) => s + x(p.t), 0) / pl.length,
      cy: pl.reduce((s, p) => s + y(p.z), 0) / pl.length,
    }))
    .sort((a, b) => a.cx - b.cx);

  let lastX = -Infinity;
  for (const c of centers) {
    if (c.cx - lastX < size * GLYPH_MIN_GAP) continue;
    strokeSymbol(ctx, icingSeverePath(c.cx, c.cy, size), size, ICING_SYMBOL_INK);
    lastX = c.cx;
  }
}

/**
 * Starke Vereisung (Severe Icing). Kartensymbol: Ein weiter Bogen (U-Form),
 * der von zwei parallelen, vertikalen Linien geschnitten wird.
 */
function icingSeverePath(cx, cy, size) {
  const p = new Path2D();
  const w = size * 0.35;
  const curveTopY = cy - size * 0.25;

  // U-förmiger Bogen (mittels quadratischer Bezier-Kurve)
  p.moveTo(cx - w, curveTopY);
  // Kontrollpunkt liegt tiefer, um den schönen runden Bauch zu erzeugen
  p.quadraticCurveTo(cx, cy + size * 0.6, cx + w, curveTopY);

  // Parameter für die beiden vertikalen Linien
  const lineOffset = size * 0.08;
  const lineTopY = cy - size * 0.05;
  const lineBottomY = cy + size * 0.45;

  // Linke vertikale Linie
  p.moveTo(cx - lineOffset, lineTopY);
  p.lineTo(cx - lineOffset, lineBottomY);

  // Rechte vertikale Linie
  p.moveTo(cx + lineOffset, lineTopY);
  p.lineTo(cx + lineOffset, lineBottomY);

  return p;
}

// --- Turbulenz: Symbol in "severe"-Flächen -----------------------------------

// Wie `drawIcingSevereGlyphs` -- ein Symbol je zusammenhängender "severe"-
// Fläche (stärkste TFI-Kategorie) an deren Schwerpunkt, gleicher
// Mindestabstand. Leichtere Kategorien (light/moderate) bleiben reine
// Kontur-Farbfläche ohne Symbol, wie bei Vereisung.
function drawTurbulenceSevereGlyphs(ctx, grid, hazardArr, x, y) {
  const n = grid.times.length * grid.nk;
  const field = new Float32Array(n);
  for (let ix = 0; ix < n; ix++) field[ix] = hazardArr[ix] === "severe" ? 1 : 0;
  const zMin = y.inv(y.bot), zMax = y.inv(y.top);
  const polylines = contour(grid, field, 0.5)
    .map((pl) => clipPolygonZ(pl, zMin, zMax))
    .filter((pl) => pl.length >= 3);
  const size = 20;
  const centers = polylines
    .map((pl) => ({
      cx: pl.reduce((s, p) => s + x(p.t), 0) / pl.length,
      cy: pl.reduce((s, p) => s + y(p.z), 0) / pl.length,
    }))
    .sort((a, b) => a.cx - b.cx);

  let lastX = -Infinity;
  for (const c of centers) {
    if (c.cx - lastX < size * GLYPH_MIN_GAP) continue;
    strokeSymbol(ctx, turbulenceModeratePath(c.cx, c.cy, size), size, TURB_SYMBOL_INK);
    lastX = c.cx;
  }
}

/**
 * Mäßige Turbulenz (Moderate Turbulence), Standard-ICAO-SIGWX-Symbol.
 * Kartensymbol: Waagerechte Linie, die in der Mitte spitz nach oben verläuft
 * (Dach- bzw. Zacken-Form). Hier auf die stärkste TFI-Kategorie ("severe")
 * angewendet -- dasselbe Verfahren wie bei Vereisung, wo ebenfalls nur die
 * höchste Stufe ein Symbol bekommt, kein eigenes Glyph je Zwischenstufe.
 */
function turbulenceModeratePath(cx, cy, size) {
  const p = new Path2D();
  const w = size * 0.4;
  const baseY = cy + size * 0.2;
  const peakY = cy - size * 0.3;
  const peakHalfWidth = size * 0.15;

  // Durchgehender Linienzug von links nach rechts
  p.moveTo(cx - w, baseY);              // Startpunkt ganz links
  p.lineTo(cx - peakHalfWidth, baseY);  // Bis zum linken Fuß der Spitze
  p.lineTo(cx, peakY);                  // Hinauf zur Spitze (Apex)
  p.lineTo(cx + peakHalfWidth, baseY);  // Hinab zum rechten Fuß
  p.lineTo(cx + w, baseY);              // Endpunkt ganz rechts

  return p;
}

// --- Konvektion (TCU/Cb) — Klassifikation in derive.js, s. dort --------------

// Schaft: `drawCbShafts` (texture.js), vor den Wolken gezeichnet, damit die
// weißen Wolkenellipsen darüberliegen (wie im Referenz-GRAMET). Amboss und
// Symbol danach, sie sollen oben liegen.
//
// `kind` aus derive.js bestimmt das Symbol:
//   "cb"  -> C_L 9 (Cumulonimbus capillatus, mit Amboss)
//   "tcu" -> C_L 3 (Cumulonimbus calvus, noch ohne Amboss)
// Streng nach Schlüssel wäre eine Cumulus congestus C_L 2; C_L 3 ist hier
// bewusst gesetzt (so vorgegeben) und passt zur Klassifikation in derive.js
// insofern, als eine ausgelöste, mächtige Zelle ohne vergletscherten Oberrand
// genau der calvus-Stufe entspricht.
// Ein Symbol je Zelle, nicht mehr je Stunde: seit `cbCells` die Läufe in
// einzelne Türme zerlegt, ist die Zelle die zeichnerische Einheit, und die
// Symbole verteilen sich mit den Türmen von selbst. Der Mindestabstand darunter
// ist nur noch die Rückfallebene für sehr schmale Stunden (langer
// Vorhersagezeitraum), wo die Türme selbst schon fast aneinanderstoßen.
const GLYPH_MIN_GAP = 1.4; // Vielfaches der Symbolgröße zwischen zwei Mitten

function drawCbGlyphs(ctx, cells) {
  let lastX = -Infinity;
  for (const c of cells) {
    // Größer als der alte Glyph: die Kartensymbole sind reine Strichzeichnung,
    // unter ~22 px läuft der Halo in die Binnenform und der Umriss verklumpt.
    const size = Math.min(24, c.hw * 1.9);
    if (c.cx - lastX < size * GLYPH_MIN_GAP) continue;
    const cy = c.yTop + (c.yBot - c.yTop) * 0.45;
    strokeSymbol(ctx, c.kind === "cb" ? cl9Path(c.cx, cy, size) : cl3Path(c.cx, cy, size), size);
    lastX = c.cx;
  }
}

/**
 * C_L 9 — Cumulonimbus mit Amboss. Kartensymbol: Große Quellwolkenkuppel
 * auf flacher Basis, darüber ein waagerechter Ambossdeckel, dessen schräge 
 * Flanken direkt auf die Kuppel treffen (siehe image_e7b248.png).
 */
function cl9Path(cx, cy, size) {
  const R = size * 0.42;
  const baseY = cy + R * 0.5;
  const p = new Path2D();

  // Basis mit großer Kuppel (durchgehender Halbkreis)
  p.moveTo(cx - R, baseY);
  p.arc(cx, baseY, R, Math.PI, 0);
  p.lineTo(cx - R, baseY);

  // Amboss (umgedrehtes Trapez auf der Kuppel)
  const topW = R * 0.7;
  const topY = cy - R * 0.9;
  
  // Berührungspunkte der schrägen Ambossflanken auf der Kuppel
  const touchX = R * 0.48;
  const touchY = baseY - Math.sqrt(R * R - touchX * touchX);

  // Deckel und rechte Flanke zeichnen
  p.moveTo(cx - topW, topY);
  p.lineTo(cx + topW, topY);
  p.lineTo(cx + touchX, touchY);
  
  // Linke Flanke zeichnen
  p.moveTo(cx - topW, topY);
  p.lineTo(cx - touchX, touchY);

  return p;
}

/**
 * C_L 3 — Cumulonimbus calvus. Kartensymbol: Große Quellwolkenkuppel
 * auf flacher Basis. Darauf sitzt eine kleinere Kuppel, die durch eine
 * vertikale Linie vom Scheitel der großen bis zum Scheitel der kleinen
 * Kuppel halbiert wird (siehe image_e7aa63.png).
 */
function cl3Path(cx, cy, size) {
  const R = size * 0.42;
  const baseY = cy + R * 0.5;
  const p = new Path2D();

  // Große Basis-Kuppel
  p.moveTo(cx - R, baseY);
  p.arc(cx, baseY, R, Math.PI, 0);
  p.lineTo(cx - R, baseY);

  // Kleine Kuppel on top
  const r2 = R * 0.35; // Radius der aufgesetzten kleinen Kuppel
  
  // Die y-Koordinate, an der die Eckpunkte der kleinen Kuppel den großen Bogen berühren
  const smallCenterY = baseY - Math.sqrt(R * R - r2 * r2);

  // Bogen der kleinen Kuppel
  p.moveTo(cx - r2, smallCenterY);
  p.arc(cx, smallCenterY, r2, Math.PI, 0);

  // Vertikale Linie (Mast) exakt zwischen den beiden Scheitelpunkten
  const largeApexY = baseY - R;
  const smallApexY = smallCenterY - r2;

  p.moveTo(cx, largeApexY);
  p.lineTo(cx, smallApexY);

  return p;
}

// Zweimal stroken: erst breit in Weiß (Halo), dann schmal in Schwarz. Auf der
// gefleckten Schaft- bzw. Wolkentextur ist der Strich sonst kaum auszumachen.
// Der Halo wächst ADDITIV mit der Strichstärke, nicht proportional zur Größe:
// proportional (0.24*size) fraß er bei kleinen Symbolen die Binnenform auf --
// die Sanduhrtaille lief zu, die Kuppel wurde ein weißer Klecks.
function strokeSymbol(ctx, path, size, inkColor = CB_SYMBOL_INK) {
  ctx.save();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  const ink = Math.max(1.2, size * 0.075);
  ctx.strokeStyle = CB_SYMBOL_HALO; ctx.lineWidth = ink + 2.2;
  ctx.stroke(path);
  ctx.strokeStyle = inkColor; ctx.lineWidth = ink;
  ctx.stroke(path);
  ctx.restore();
}

// --- Niederschlag --------------------------------------------------------------

// Symbolabstand in PIXELN — bewusst NICHT in Höhenmetern: die Höhenachse ist
// logarithmisch, gleich große Höhenschritte werden dadurch oben gestaucht und
// unten gedehnt. Bei fester Symbolzahl über die Höhe ballten sich die Symbole
// oben zusammen und rissen darunter kilometerweit auf (ein "-RA" zerfiel in
// Flocken oben, ein paar Tropfen, Lücke, ein Tropfen am Boden — s. Feedback).
// Über die Pixelachse verteilt bleibt der Vorhang in beiden Achsenmodi (log
// wie lin) optisch gleichmäßig. Dichte weiterhin aus der Intensität (mm/h);
// die Stufung ist grob und nicht kalibriert.
// tanh-Kennlinie statt linear, damit sich auch kräftiger Niederschlag noch
// abstuft (linear lief schon ab ~5 mm/h in den Minimalabstand und sah dann
// bei 5 wie bei 50 mm/h aus). RATE_SCALE = Rate, bei der ~76 % der Spanne
// ausgeschöpft sind. Stufung grob, nicht kalibriert.
const PRECIP_SPACING_MAX_PX = 30, PRECIP_SPACING_MIN_PX = 11, PRECIP_RATE_SCALE = 6;
function precipSpacingPx(rateMmH) {
  const r = Math.max(0, Number.isFinite(rateMmH) ? rateMmH : 0.5);
  const span = PRECIP_SPACING_MAX_PX - PRECIP_SPACING_MIN_PX;
  return PRECIP_SPACING_MAX_PX - span * Math.tanh(r / PRECIP_RATE_SCALE);
}

// Streuung der Symbole um ihre Rasterposition, damit der Vorhang nicht wie
// eine gezogene Linie wirkt (s. Wolkenschraffur, die schon so arbeitet).
// X als Anteil der Stundenspalte, Y als Anteil des Symbolabstands -- beide
// bewusst moderat: bei mehr als ~0,35 Spaltenbreite laufen die Vorhänge
// benachbarter Stunden ineinander und die Zuordnung "Vorhang unter dieser
// Stunde" geht verloren. Werte rein optisch gewählt.
const PRECIP_JITTER_X = 0.30, PRECIP_JITTER_Y = 0.32;
const PRECIP_SIZE_MIN = 0.80, PRECIP_SIZE_SPAN = 0.45;

// Zeitliche Verschiebung des Vorhangs, als Anteil der Stundenspalte nach LINKS.
// Open-Meteo gibt `precipitation` als Summe der VORANGEHENDEN Stunde aus: der
// Wert am Zeitstempel t beschreibt t-1h..t. Am Zeitstempel gezeichnet stand der
// Vorhang also am rechten Rand seines Bezugszeitraums; 0,5 setzt ihn auf dessen
// Mitte. Bewusst als Stellschraube herausgezogen -- 0 stellt das alte Verhalten
// wieder her.
// Vorbehalt: `weather_code` gilt momentan (nicht rückwärts akkumuliert), und
// Vorhänge, die nur daraus stammen (Menge unter der Schwelle, s.
// `precipEntries`), werden hier trotzdem mitverschoben -- eine getrennte
// Behandlung würde die Vorhänge benachbarter Stunden ungleich verteilen.
const PRECIP_TIME_SHIFT = 0.5;

// `groundAt` (nur Path-Modus, sonst null): der Vorhang endet dann am lokalen
// Modell-Boden (AMSL-Achse) statt an der Panelunterkante -- der Überstand
// unter die Geländelinie wird zusätzlich von `drawModelTerrain` abgedeckt.
function drawPrecip(ctx, entries, pos, x, y, seed, groundAt = null) {
  const dt = pos.length > 1 ? pos[1] - pos[0] : 3600;
  const colW = Math.max(1, x(pos[0] + dt) - x(pos[0]));
  ctx.save();
  for (const e of entries) {
    // Auf den Rahmen begrenzen: die erste Stunde rutscht sonst mit ihrem
    // halben Versatz links aus dem Chart in die Höhenachse.
    const cx = clamp(x(e.t - PRECIP_TIME_SHIFT * dt), x.left, x.right);
    // Punkt-Modus: knapp innerhalb des Rahmens (Vorhang endet am Boden).
    const pyBot = groundAt ? y(groundAt(e.t)) - 1 : y.bot - 4;
    const pyTop = Math.max(y.top, y(Math.max(0, e.zTop)));
    const span = pyBot - pyTop;
    // Abstand auf die Spanne einrasten, damit der Vorhang exakt von der
    // Wolkenoberkante bis zum Boden reicht (sonst bliebe oben bis zu ein
    // ganzer Symbolabstand frei und der Vorhang wirkte abgeschnitten).
    const steps = span > 0 ? Math.max(1, Math.round(span / precipSpacingPx(e.rate))) : 0;
    const step = steps > 0 ? span / steps : 0;
    // Stundenindex statt Schleifenzähler als Hash-Koordinate: jeder Vorhang
    // würfelt damit unabhängig von allen anderen. Mit einem fortlaufenden
    // PRNG-Strom (wie bei den Wolken) hinge das Muster einer Stunde daran, wie
    // viele Symbole die Stunden davor gezogen haben -- ändert sich deren
    // Symbolzahl (Höhenumschalter), verschöbe sich der ganze Rest mit.
    // Die Symbolzahl je Vorhang hängt weiterhin an der Höhenachse, ein
    // umgeschalteter Vorhang sieht also anders aus -- aber nur er.
    const col = Math.round((e.t - pos[0]) / dt);
    for (let s = 0; s <= steps; s++) {
      // Erstes und letztes Symbol NICHT vertikal versetzen: der Vorhang soll
      // weiterhin exakt an der Wolkenoberkante ansetzen und den Boden
      // erreichen (dieselbe Eigenschaft, die das Einrasten oben herstellt).
      const jy = (s === 0 || s === steps)
        ? 0
        : (hashRand(seed, col, s, 1) - 0.5) * 2 * PRECIP_JITTER_Y * step;
      const py = pyBot - s * step + jy;
      // Seitlich in der Spalte streuen, aber innerhalb des Chartrahmens
      // bleiben -- sonst rutschte die erste/letzte Stunde über die Höhenachse
      // bzw. in den rechten Rand mit den Linien-Labels.
      const jx = (hashRand(seed, col, s, 0) - 0.5) * 2 * PRECIP_JITTER_X * colW;
      const px = clamp(cx + jx, x.left + 3, x.right - 3);
      // Phase aus der Höhe, die dieses Pixel tatsächlich meint.
      const z = y.inv(py);
      // Oberhalb der Nullgradgrenze immer Schnee (physikalisch, unabhängig
      // vom Boden-METAR), darunter immer Regen -- `type` entscheidet nur,
      // wenn keine Nullgradgrenze im Profil gefunden wurde (s. Feedback:
      // "sn" durfte den ganzen Vorhang bis zum Boden einfärben, auch weit
      // unterhalb der Nullgradgrenze).
      const snowHere = Number.isFinite(e.freezingZ) ? z > e.freezingZ : e.type === "sn";
      const size = PRECIP_SIZE_MIN + hashRand(seed, col, s, 2) * PRECIP_SIZE_SPAN;
      const rot = hashRand(seed, col, s, 3);
      // Flocke: Drehung über 60° reicht, ein 3-Strich-Stern ist so periodisch.
      if (snowHere) drawAsterisk(ctx, px, py, 3.2 * size, rot * Math.PI / 3);
      else drawDash(ctx, px, py, 4.5 * size, rot);
    }
  }
  ctx.restore();
}
// Weißes Halo zuerst (wie bei den Isothermen/Isotachen), dann die eigentliche
// Farbe -- sonst geht das Symbol im dunkleren Himmelblau unter (s. Feedback).
const PRECIP_COLOR = "#134a7a";
function drawAsterisk(ctx, cx, cy, r, rot = 0) {
  for (const [stroke, width] of [["#fff", 2.6], [PRECIP_COLOR, 1.2]]) {
    ctx.strokeStyle = stroke; ctx.lineWidth = width;
    for (const deg of [0, 60, 120]) {
      const rad = deg * Math.PI / 180 + rot;
      ctx.beginPath();
      ctx.moveTo(cx - r * Math.cos(rad), cy - r * Math.sin(rad));
      ctx.lineTo(cx + r * Math.cos(rad), cy + r * Math.sin(rad));
      ctx.stroke();
    }
  }
}
// `tilt` in [0,1) variiert die Neigung des Tropfenstrichs (0.15..0.45 der
// Länge seitlich) -- gleichmäßig geneigte Striche lasen sich als Raster.
function drawDash(ctx, cx, cy, len, tilt = 0.5) {
  const dx = len * (0.15 + tilt * 0.3);
  for (const [stroke, width] of [["#fff", 2.8], [PRECIP_COLOR, 1.4]]) {
    ctx.strokeStyle = stroke; ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(cx - dx, cy - len * 0.5);
    ctx.lineTo(cx + dx, cy + len * 0.5);
    ctx.stroke();
  }
}

// --- Linien: Isothermen/Isotachen/Tropopause ---------------------------------

function drawPolyline(ctx, pl, x, y, color, dash, width = 1.4) {
  if (pl.length < 2) return;
  ctx.save();
  ctx.setLineDash(dash);
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#fff"; ctx.lineWidth = width + 1.6;
  pathFor(ctx, pl, x, y); ctx.stroke();
  ctx.strokeStyle = color; ctx.lineWidth = width;
  pathFor(ctx, pl, x, y); ctx.stroke();
  ctx.restore();
}
function pathFor(ctx, pl, x, y) {
  ctx.beginPath();
  pl.forEach((p, i) => {
    const px = x(p.t), py = y(p.z);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
}
// `limitX` = rechte Kante, hinter die das Kästchen nicht laufen darf (CSS-
// Pixel). Vorher stand hier `ctx.canvas.width` -- das sind Geräte-Pixel
// (W * dpr), die Begrenzung hat also nie gegriffen.
function labelBox(ctx, px, py, text, color, limitX) {
  ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "start"; ctx.textBaseline = "middle";
  const w = ctx.measureText(text).width + 8;
  const bx = Math.min(px + 2, limitX - w - 2);
  ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillRect(bx, py - 8, w, 16);
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(bx, py - 8, w, 16);
  ctx.fillStyle = color; ctx.fillText(text, bx + 4, py);
}
function rightmost(polylines) {
  return polylines.reduce((a, b) => (b[b.length - 1].t > a[a.length - 1].t ? b : a));
}

function drawIsotherms(ctx, isotherms, x, y) {
  const zMin = y.inv(y.bot), zMax = y.inv(y.top);
  for (const { tempC, polylines: raw } of isotherms) {
    // Auf den sichtbaren Höhenbereich geschnitten (s. `clipPolylineZ`) --
    // sonst klebt eine Isotherme weit außerhalb des Zooms als Phantomlinie +
    // Label am Panelrand (s. Feedback).
    const polylines = raw.flatMap((pl) => clipPolylineZ(pl, zMin, zMax));
    if (!polylines.length) continue;
    const color = tempC === 0 ? "#1d4c8c" : "#7a1414";
    for (const pl of polylines) drawPolyline(ctx, pl, x, y, color, [5, 3]);
    const last = rightmost(polylines);
    const p = last[last.length - 1];
    labelBox(ctx, x(p.t), y(p.z), `${tempC}°C`, color, x.right + M.r);
  }
}
function drawIsotachs(ctx, isotachs, x, y) {
  const zMin = y.inv(y.bot), zMax = y.inv(y.top);
  for (const { kt, polylines: raw } of isotachs) {
    const polylines = raw.flatMap((pl) => clipPolylineZ(pl, zMin, zMax));
    if (!polylines.length) continue;
    for (const pl of polylines) drawPolyline(ctx, pl, x, y, ISOTACH_COLOR, ISOTACH_DASH, 1.7);
    const last = rightmost(polylines);
    const p = last[last.length - 1];
    labelBox(ctx, x(p.t), y(p.z), `${kt} kt`, ISOTACH_COLOR, x.right + M.r);
  }
}
function drawTropopause(ctx, line, x, y) {
  const zMin = y.inv(y.bot), zMax = y.inv(y.top);
  const polylines = clipPolylineZ(line, zMin, zMax);
  if (!polylines.length) return;
  for (const pl of polylines) drawPolyline(ctx, pl, x, y, "#cc0000", []);
  const last = rightmost(polylines);
  const p = last[last.length - 1];
  labelBox(ctx, x(p.t), y(p.z), "Trop", "#cc0000", x.right + M.r);
}

// --- Achsen --------------------------------------------------------------------

function drawHeightAxis(ctx, y, hMin, hMax, x, lin, amsl = false) {
  const ticks = lin ? niceTicks(hMin, hMax, 6) : niceLogHeights(hMin, hMax);
  ctx.font = "10px system-ui, sans-serif"; ctx.textBaseline = "middle";
  for (const hM of ticks) {
    const py = y(hM);
    ctx.strokeStyle = GRID; ctx.globalAlpha = 0.6; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x.left, py); ctx.lineTo(x.right, py); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = MUTED; ctx.textAlign = "right";
    ctx.fillText(fmtH(hM), x.left - 4, py);
  }
  // Referenzniveau explizit ausweisen -- Path-Modus plottet AMSL, Punkt-Modus
  // AGL (s. Kopfkommentar); ohne Tag wäre die Achse mehrdeutig.
  ctx.fillStyle = MUTED; ctx.font = "600 8px system-ui, sans-serif"; ctx.textAlign = "right";
  ctx.fillText(amsl ? "AMSL" : "AGL", x.left - 4, y.top - 7);
}

// Zeilenbeschriftung im linken Randfeld (gleiche Spalte wie die Höhenachse),
// zweizeilig zentriert auf die Zeilenhöhe.
function drawRowLabel(ctx, lines, rightX, top, height) {
  ctx.font = "9px system-ui, sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  ctx.fillStyle = MUTED;
  const lh = 11, cy = top + height / 2 - (lines.length - 1) * lh / 2;
  lines.forEach((line, i) => ctx.fillText(line, rightX, cy + i * lh));
}

function timeGridLines(ctx, times, x, top, bot) {
  let lastDay = null;
  for (let i = 0; i < times.length; i++) {
    const d = new Date(times[i] * 1000);
    if (d.getMinutes() !== 0) continue;
    const dayKey = d.toDateString();
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      ctx.strokeStyle = "#c9c8c2"; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x(times[i]), top); ctx.lineTo(x(times[i]), bot); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

// Seit die Datenzeilen (Böen/Sicht/SLP/...) jede Stunde statt nur jede zweite
// zeigen (s. Feedback), sollte die Zeitachse mitziehen -- sonst lässt sich
// eine Zwischenstunde nicht mehr genau ablesen. Drei Stufen statt der
// bisherigen zwei (Datum/6-Stunden-Marken), damit 00/06/12/18 weiterhin das
// Auge führen und die neuen Zwischenstunden nicht gleichrangig konkurrieren:
// Datum (fett, am größten) > Hauptstunden 06/12/18 (fett, normal) >
// Zwischenstunden (dünn, klein, gedämpfte Farbe). Kollisionsschutz per
// Messung wie bei den Zahlenzeilen bräuchte es hier nicht -- die zweistelligen
// Stunden sind immer gleich breit und passen bei der aktuellen Stundenbreite
// (`CHART_PX_PER_HOUR`) auch im Kleinschriftgrad problemlos nebeneinander.
function drawTimeAxis(ctx, times, x, yTop, yBot) {
  let lastDay = null;
  ctx.textBaseline = "alphabetic";
  for (let i = 0; i < times.length; i++) {
    const d = new Date(times[i] * 1000);
    if (d.getMinutes() !== 0) continue;
    const h = d.getHours(), dayKey = d.toDateString();
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      ctx.fillStyle = INK; ctx.font = "600 11px system-ui, sans-serif"; ctx.textAlign = "left";
      ctx.fillText(d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }), x(times[i]) + 3, yBot + 12);
    } else if (h === 6 || h === 12 || h === 18) {
      ctx.fillStyle = INK; ctx.font = "600 10px system-ui, sans-serif"; ctx.textAlign = "center";
      ctx.fillText(String(h).padStart(2, "0"), x(times[i]), yBot + 12);
    } else {
      ctx.fillStyle = MUTED; ctx.font = "8px system-ui, sans-serif"; ctx.textAlign = "center";
      ctx.fillText(String(h).padStart(2, "0"), x(times[i]), yBot + 11);
    }
  }
}

// --- Path-Achse (verstrichene Zeit seit Pfadbeginn, Path-Modus) -------------
//
// `grid.pos` ist im Path-Modus keine Kalenderzeit mehr (s. `path.js`
// `posOfPath`), sondern verstrichene Sekunden seit dem ersten Wegpunkt --
// `timeGridLines`/`drawTimeAxis` (Tages-/Stundengrenzen per `Date`) wären
// hier bedeutungslos. `niceTicks` (aus `crosssection.js`, dort für die
// Höhenachse) liefert stattdessen einfach runde Werte über die Spannweite.
const PATH_TICK_COUNT = 8;

function pathGridLines(ctx, grid, x, top, bot) {
  const { pos } = grid;
  const ticks = niceTicks(pos[0], pos[pos.length - 1], PATH_TICK_COUNT);
  ctx.strokeStyle = "#c9c8c2"; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
  for (const t of ticks) {
    ctx.beginPath(); ctx.moveTo(x(t), top); ctx.lineTo(x(t), bot); ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawPathAxis(ctx, grid, x, yTop, yBot) {
  const { pos } = grid;
  const ticks = niceTicks(pos[0], pos[pos.length - 1], PATH_TICK_COUNT);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = INK; ctx.font = "600 10px system-ui, sans-serif"; ctx.textAlign = "center";
  for (const t of ticks) {
    ctx.fillText(fmtElapsed(t), x(t), yBot + 12);
  }
}

// "+45 min" / "+2:15 h" -- verstrichene Zeit seit Pfadbeginn.
function fmtElapsed(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h <= 0) return `+${m} min`;
  return m === 0 ? `+${h} h` : `+${h}:${String(m).padStart(2, "0")} h`;
}

// Path-Modus: sichtbares Ende am rechten Chartrand, wenn der Pfad die
// Modell-Bbox verlassen hat und `fetchGridForPath` (path.js) deshalb keine
// weiteren Spalten mehr geholt hat -- `x.right` liegt exakt auf der letzten
// tatsächlich geplotteten Spalte (s. `x()`-Konstruktion: `p1 = pos[pos.length-1]`
// ist die letzte VOR dem Abbruch gefetchte Position).
function drawPathStopMarker(ctx, x, top, bot, reason) {
  const px = x.right;
  ctx.save();
  ctx.strokeStyle = "#b71c1c"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bot); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#b71c1c"; ctx.font = "600 10px system-ui, sans-serif"; ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(reason, px - 3, top + 3);
  ctx.restore();
}

// --- Hover (DOM-Overlay) -------------------------------------------------------

function setupHover(host, canvas, axis, grid, info) {
  const { x, y, mainTop, mainBot, view, isPath } = info;
  host.style.position = host.style.position || "relative";
  const tip = document.createElement("div");
  tip.className = "gm-tip";
  tip.style.display = "none";
  host.append(tip);
  // Über dem festen Achsenstreifen liegt kein sichtbarer Chart -- Tooltip aus,
  // sonst bliebe der letzte Wert stehen, sobald der Zeiger den Streifen
  // erreicht (der Streifen fängt die Pointer-Events ab).
  axis.addEventListener("pointerenter", () => { tip.style.display = "none"; });

  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (py < mainTop || py > mainBot || px < x.left || px > x.right) { tip.style.display = "none"; return; }
    const p0 = grid.pos[0], p1 = grid.pos[grid.pos.length - 1];
    const frac = (px - x.left) / (x.right - x.left);
    const pGuess = p0 + frac * (p1 - p0);
    let i = 0, best = Infinity;
    for (let j = 0; j < grid.pos.length; j++) {
      const d = Math.abs(grid.pos[j] - pGuess);
      if (d < best) { best = d; i = j; }
    }
    // Achsenwert ist im Path-Modus AMSL (s. `amslGrid`); gesampelt wird auf
    // dem AGL-Grid, also vorher die Modell-Orographie der Spalte abziehen.
    const h = y.inv(py);
    const hAgl = isPath ? h - grid.elevation[i] : h;
    if (isPath && hAgl < 0) {
      // Unterhalb des Modell-Bodens gibt es keine Wetterdaten -- ehrlich
      // sagen statt den untersten Levelwert als "Fels-Temperatur" anzuzeigen.
      tip.style.display = "block";
      tip.style.left = `${px + 12}px`;
      tip.style.top = `${py + 12}px`;
      tip.innerHTML = [
        `<b>${new Date(grid.times[i] * 1000).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" })}</b>`,
        `Höhe ${fmtHeight(h)} AMSL`,
        "unter Modell-Grund",
      ].join("<br>");
      return;
    }
    const s = sampleAt(grid, i, hAgl);
    const dir = s.dir;
    // WW gilt für den Boden (weather_code ist ein Oberflächenfeld), nicht für
    // die gehoverte Höhe -- daher explizit gekennzeichnet.
    const code = grid.surface?.wcode?.[i];
    const ww = Number.isFinite(code)
      ? `${metarWeather(code, fog.toPhenomenon(view.fog?.[i]))} (ww ${String(code).padStart(2, "0")})`
      : "N/A";
    // Menge ebenfalls Boden und zusätzlich rückwärtsgewandt: Open-Meteo gibt
    // `precipitation` als Summe der VORANGEHENDEN Stunde aus, während ww zum
    // Zeitstempel gilt. Beides nebeneinander, damit beim Kalibrieren sichtbar
    // wird, welches der beiden Signale den Vorhang ausgelöst hat (das Gate in
    // `precipEntries` ist ein ODER aus Menge > PRECIP_MIN_RATE und ww).
    // Zwei Nachkommastellen, weil die Schwelle bei 0,05 mm/h liegt.
    const mm = grid.surface?.precip?.[i];
    const cm = grid.surface?.snow?.[i];
    const num = (v, d = 2) => v.toLocaleString("de-DE", { maximumFractionDigits: d });
    const amount = Number.isFinite(mm) ? `${num(mm)} mm` : "N/A";
    const snow = Number.isFinite(cm) && cm > 0 ? ` · Schnee ${num(cm, 1)} cm` : "";
    tip.style.display = "block";
    tip.style.left = `${px + 12}px`;
    tip.style.top = `${py + 12}px`;
    tip.innerHTML = [
      `<b>${new Date(grid.times[i] * 1000).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" })}</b>`,
      isPath
        ? `Höhe ${fmtHeight(h)} AMSL · ${fmtHeight(hAgl)} über Modellgrund`
        : `Höhe ${fmtHeight(h)}`,
      `Temp ${fmtTemp(s.T - 273.15)}`,
      `Wind ${fmtDir(dir)} ${fmtWind(s.spd)}`,
      `Wolken ${Math.round((s.cloudFrac || 0) * 100)} %`,
      `WW (Boden) ${ww}`,
      `Nd (Vorstunde) ${amount}${snow}`,
    ].join("<br>");
  });
  canvas.addEventListener("pointerleave", () => { tip.style.display = "none"; });
}

// --- Helfer --------------------------------------------------------------------

// weather_code als METAR-nahes Kürzel (dieselbe Tabelle wie im Briefing) --
// "NSW"/"N/A" (kein signifikantes Wetter) wird wie im echten METAR weggelassen.
function drawWeatherRow(ctx, grid, view, x, top, height) {
  const { pos, surface } = grid;
  if (!surface?.wcode) return;
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const cy = top + height / 2;
  // Kollisionsschutz an der gemessenen Labelbreite statt einer geschätzten
  // Fixbreite (vorher 30 px pauschal) -- kurze Kürzel wie "RA" passen so
  // enger als lange wie "FZFG", statt beide gleich zu behandeln (s. Feedback
  // zu den Zahlenzeilen, hier dieselbe Idee).
  let lastRight = -Infinity;
  for (let i = 0; i < pos.length; i++) {
    const code = surface.wcode[i];
    if (!Number.isFinite(code)) continue;
    const entry = view?.fog?.[i];
    const label = metarWeather(code, fog.toPhenomenon(entry));
    if (label === "NSW" || label === "N/A") continue;
    const px = x(pos[i]);
    const w = ctx.measureText(label).width;
    if (px - w / 2 < lastRight + 4) continue;
    // Unsichere Befunde (RH-Fallback statt CLC/Kondensat, s. hazards/fog.js)
    // gedämpft statt in der vollen Warnfarbe -- Konfidenz-Konvention wie bei
    // der Wolkenbasislinie im Meteogramm (dort gestrichelt statt Farbe, hier
    // reicht Alpha, weil Text keine Linienart hat).
    ctx.globalAlpha = entry && entry.certain === false ? 0.55 : 1;
    ctx.fillStyle = weatherColor(label);
    ctx.fillText(label, px, cy);
    ctx.globalAlpha = 1;
    lastRight = px + w / 2;
  }
}
function weatherColor(label) {
  if (label.includes("TS")) return "#b71c1c";
  if (label.includes("SN") || label.includes("SG")) return "#1565c0";
  if (label.includes("FZ")) return "#6a1b9a";
  if (label === "FG") return "#616161";
  if (label === "BR") return "#78909c";
  if (label === "HZ") return "#8d6e63";
  return "#01579b";
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function mixHex(a, b, f) {
  const ca = hex(a), cb = hex(b), ff = clamp(f, 0, 1);
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * ff);
  const g = Math.round(ca[1] + (cb[1] - ca[1]) * ff);
  const bl = Math.round(ca[2] + (cb[2] - ca[2]) * ff);
  return `rgb(${r},${g},${bl})`;
}
function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
// RGB-Varianten von `mixHex`/`hex`, für den Bodenstreifen: dort wird in zwei
// Schritten gemischt (Tag/Nacht, dann Richtung Reif), `mixHex` nimmt aber nur
// Hex-Strings entgegen und liefert bereits einen "rgb(...)"-String zurück --
// den könnte man kein zweites Mal durch `hex()` parsen.
function blendRGB(a, b, f) {
  const ff = clamp(f, 0, 1);
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * ff));
}
function blend3(hexA, hexB, f) { return blendRGB(hex(hexA), hex(hexB), f); }
function rgbStr(c) { return `rgb(${c[0]},${c[1]},${c[2]})`; }
