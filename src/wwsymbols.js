/**
 * Handgezeichnete WMO-Wettersymbole (SVG-Markup) für METAR-artige wx-Strings
 * ('RA', '+TSRA', '-SHSN', 'FZFG', …) — portiert aus METEOMAPs Beobachtungs-
 * Kartenlayer (dort für echte METAR/SYNOP-Meldungen gebaut), hier EIN Ort für
 * alle Apps, die dieselben Symbole brauchen (Kartenlayer, Charts).
 *
 * `wxSymbolMarkup()` liefert wie `windbarb.js`s `windBarbMarkup()` NUR die
 * innere Markup (keine umschließende `<svg>`) in einem festen Koordinatenraum
 * (`WX_SYMBOL_VIEWBOX`) — Aufrufer wrappen sie selbst (Leaflet-divIcon:
 * String-Templating; Chart-SVG: `placeWxSymbol()`, DOM-basiert), dieselbe
 * Aufteilung wie beim Windfieder-Modul.
 *
 * `wmoWeatherCodeToWx()`/`wmoWeatherCategory()` übersetzen Open-Meteos
 * reduzierten `weather_code`-Satz (WMO-Tabelle 4677, NICHT die volle SYNOP-
 * 00-99-ww-Tabelle echter Beobachtungen) in einen wx-String bzw. eine von
 * sieben Wetterkategorien (fog/drizzle/rain/freezing/snow/showers/thunder) —
 * dieselben Kategorie-Grenzen wie in droneforecasts Meteogramm-Ribbon
 * (`wwCat()`), damit Kartenlayer und Ribbon dieselbe Diagnose zeigen.
 */

const NS = "http://www.w3.org/2000/svg";

// Fester Koordinatenraum, in dem alle Primitiven unten zeichnen — Aufrufer
// legen die sichtbare Größe über die eigene `<svg width/height viewBox="...">`
// fest (Original-Prototyp hatte hier fix width/height="22" im Wrapper, ohne
// den Aufrufer die Größe wählen zu lassen; hier bewusst nicht wiederholt).
export const WX_SYMBOL_VIEWBOX = "0 0 34 34";

const WX_CLR = {
  liq: "#00e090", // grün  – flüssiger Niederschlag (RA, DZ, SH)
  snow: "#e0a0ff", // lila  – fester Niederschlag (SN, SG, IC)
  haz: "#ff4444", // rot   – Gefahren (FZ, TS, GR, SQ, FC)
  fog: "#ffb000", // gelb  – Nebel / Sichteinschränkung (FG, BR, HZ)
  dust: "#d4a050", // braun – Staub / Sand (DU, SA, PO)
};

// -- Basis-Formen (Primitiven) ------------------------------------------------

function dot(cx, cy, clr, r = 2.6) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${clr}"/>`;
}

function comma(cx, cy, clr) {
  return `<circle cx="${cx}" cy="${cy}" r="1.8" fill="${clr}"/>` +
    `<path d="M${cx},${cy + 1.5} C${cx + 3},${cy + 4} ${cx + 1},${cy + 8} ${cx - 1},${cy + 8}" stroke="${clr}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
}

function star(cx, cy, clr, r = 4.5) {
  return [0, 60, 120].map((a) => {
    const rd = (a * Math.PI) / 180, dx = r * Math.cos(rd), dy = r * Math.sin(rd);
    return `<line x1="${(cx - dx).toFixed(1)}" y1="${(cy - dy).toFixed(1)}" x2="${(cx + dx).toFixed(1)}" y2="${(cy + dy).toFixed(1)}" stroke="${clr}" stroke-width="1.8" stroke-linecap="round"/>`;
  }).join("");
}

// Dreiecke (Basis immer unten)
function triFilled(cx, cy, clr, s = 6) { // GR (Hagel) - komplett gefüllt
  return `<polygon points="${cx},${cy - s * 0.8} ${cx - s},${cy + s * 0.7} ${cx + s},${cy + s * 0.7}" fill="${clr}" stroke="${clr}" stroke-width="1"/>`;
}

function triEmpty(cx, cy, clr, s = 6) { // GS (Graupel) - leer
  return `<polygon points="${cx},${cy - s * 0.8} ${cx - s},${cy + s * 0.7} ${cx + s},${cy + s * 0.7}" fill="none" stroke="${clr}" stroke-width="1.8" stroke-linejoin="round"/>`;
}

function triDot(cx, cy, clr, s = 6) { // PL/PE (Eiskörner) - leer mit Punkt
  return triEmpty(cx, cy, clr, s) + `<circle cx="${cx}" cy="${cy + s * 0.2}" r="1.5" fill="${clr}"/>`;
}

function vcParens(clr) {
  return `<path d="M8,4 Q2,17 8,30 M26,4 Q32,17 26,30" stroke="${clr}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
}

// -- Positionsraster für Intensität -------------------------------------------

function precipPos(intens) {
  if (intens === "light") return [[12, 17], [22, 17]]; // 2 nebeneinander
  if (intens === "moderate") return [[17, 12], [12, 21], [22, 21]]; // Dreieck
  return [[17, 8], [11, 17], [23, 17], [17, 26]]; // heavy = Raute
}

// -- Komplexe Bausteine --------------------------------------------------------

function tsBolt(clr, heavy = false) { // WMO-Blitz (TS)
  const yTop = 12;
  const vert = `<line x1="10" y1="${yTop}" x2="10" y2="30" stroke="${clr}" stroke-width="2.2" stroke-linecap="round"/>`;

  if (heavy) {
    // Schweres Gewitter (+TS): ein Blitz mit extra Zickzack (ww=97/99)
    const zigzag = `<polyline points="8,${yTop} 26,${yTop} 18,17 24,21 15,26 25,30" stroke="${clr}" stroke-width="2.2" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`;
    const arrow = `<polyline points="20,30 25,30 25,25" stroke="${clr}" stroke-width="2.2" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`;
    return vert + zigzag + arrow;
  }
  // Normales Gewitter (TS): einfacher Zickzack
  const zigzag = `<polyline points="8,${yTop} 26,${yTop} 16,21 26,30" stroke="${clr}" stroke-width="2.2" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`;
  const arrow = `<polyline points="21,30 26,30 26,25" stroke="${clr}" stroke-width="2.2" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`;
  return vert + zigzag + arrow;
}

function showerTri(clr, intens) { // Schauer-Dreieck (Spitze unten)
  const tri = `<polygon points="10,13 24,13 17,29" fill="none" stroke="${clr}" stroke-width="2" stroke-linejoin="round"/>`;
  let bars = "";
  if (intens === "moderate") bars = `<line x1="13" y1="20" x2="21" y2="20" stroke="${clr}" stroke-width="2"/>`;
  if (intens === "heavy") bars = `<line x1="12" y1="18" x2="22" y2="18" stroke="${clr}" stroke-width="2"/><line x1="14" y1="23" x2="20" y2="23" stroke="${clr}" stroke-width="2"/>`;
  return tri + bars;
}

function fogLines(type, clr) {
  const line = (y, dash = false) => `<line x1="5" y1="${y}" x2="29" y2="${y}" stroke="${clr}" stroke-width="2.2" stroke-linecap="round" ${dash ? 'stroke-dasharray="7,5"' : ""}/>`;
  const splitLine = (y) => `<path d="M5,${y} L14,${y} M20,${y} L29,${y}" stroke="${clr}" stroke-width="2.2" stroke-linecap="round"/>`;

  if (type === "BR") return line(13) + line(21);
  if (type === "MIFG") return line(13, true) + line(21);
  if (type === "BCFG") return splitLine(11) + line(17) + splitLine(23); // oben/unten Lücke, Mitte durchgezogen
  if (type === "PRFG") return splitLine(11) + line(17) + line(23); // nur oben Lücke
  if (type === "FZFG") return line(11) + line(17) + line(23) + `<polyline points="12,11 17,23 22,11" stroke="${clr}" stroke-width="2.2" fill="none" stroke-linejoin="round"/>`;
  return line(11) + line(17) + line(23); // normal FG
}

function freezingS(intens, isRain, clr) {
  // Liegendes S (Tilde)
  const sPath = `<path d="M6,17 C6,7 17,7 17,17 C17,27 28,27 28,17" stroke="${clr}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
  const leftDrop = isRain ? dot(11.5, 12, clr) : comma(11.5, 12, clr);
  const rightDrop = isRain ? dot(22.5, 22, clr) : comma(22.5, 22, clr);
  // Bei leicht (-) nur links, bei moderat/stark beidseitig
  return sPath + leftDrop + (intens === "light" ? "" : rightDrop);
}

function snowCross(clr, isDrifting) {
  // Waagerechter Pfeil nach rechts
  const hLine = `<path d="M6,17 L26,17 M21,12 L26,17 L21,22" stroke="${clr}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  // Senkrechter Pfeil (isDrifting = DRSN = Spitze oben | BLSN = Spitze unten)
  const vLine = isDrifting
    ? `<path d="M16,27 L16,7 M11,12 L16,7 L21,12" stroke="${clr}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="M16,7 L16,27 M11,22 L16,27 L21,22" stroke="${clr}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  return hLine + vLine;
}

function dustStorm(clr, heavy = false) {
  // Stehendes S
  const sPath = `<path d="M22,10 C22,5 12,5 12,11 C12,16 22,18 22,23 C22,29 12,29 12,24" stroke="${clr}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
  const arrows = heavy
    ? `<path d="M7,14 L24,14 M7,20 L24,20 M20,9 L27,17 L20,25" stroke="${clr}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` // Doppelpfeil (=>)
    : `<path d="M9,17 L25,17 M21,13 L25,17 L21,21" stroke="${clr}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`; // einfacher Pfeil (->)
  return sPath + arrows;
}

function dustDevil(clr) { // PO (Dust Devil) - 3-fache Spirale
  const path = "M12,24 C12,30 22,30 22,24 C22,18 12,22 12,16 C12,22 22,22 22,16 C22,10 12,14 12,8 C12,14 22,14 22,8";
  return `<path d="${path}" stroke="${clr}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
}

// -- Hauptbauer ----------------------------------------------------------------

/** METAR-artiger wx-String ('RA', '+TSRA', '-SHSN', 'FZFG', …) → innere
 *  SVG-Markup im `WX_SYMBOL_VIEWBOX`-Koordinatenraum, oder `null` wenn der
 *  String kein zeichenbares Wetter enthält (z. B. 'CAVOK', leer). */
export function wxSymbolMarkup(wxStr) {
  if (!wxStr || wxStr === "CAVOK") return null;
  const wx = wxStr.toUpperCase().trim();
  const heavy = wx.includes("+");
  const light = wx.includes("-");
  const intens = heavy ? "heavy" : light ? "light" : "moderate";
  const isVC = wx.includes("VC");
  const { liq, snow, haz, fog, dust } = WX_CLR;

  // 1. Extreme Gefahren
  if (wx.includes("FC")) return `<path d="M7,7 C17,10 17,20 12,28 M27,7 C17,10 17,20 22,28" stroke="${haz}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
  if (wx.includes("SQ")) return `<path d="M8,10 L17,28 L26,10 Q17,16 8,10 Z" stroke="${haz}" stroke-width="2.4" fill="none" stroke-linejoin="round"/>`;
  if (wx.includes("PO")) return dustDevil(dust); // PO und VCPO: gleiches Spiralensymbol ohne Klammern

  // 2. Gewitter (TS)
  if (wx.includes("TS")) {
    // VCTS: Blitz ohne Gewitter an der Station (ww=13)
    if (isVC && !wx.includes("SH") && !wx.includes("RA") && !wx.includes("SN") && !wx.includes("GR") && !wx.includes("GS") && !wx.includes("PL") && !wx.includes("PE") && !wx.includes("DZ")) {
      return `<polyline points="23,8 13,18 21,27" stroke="${haz}" stroke-width="2.2" fill="none" stroke-linejoin="round" stroke-linecap="round"/>` +
        `<polyline points="16,27 21,27 21,22" stroke="${haz}" stroke-width="2.2" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`;
    }

    let inner = tsBolt(haz, heavy);
    if (wx.includes("RA")) inner += dot(17, 4.5, liq, 2.5);
    else if (wx.includes("SN")) inner += star(17, 5, snow, 3.5);
    else if (wx.includes("GR")) inner += triFilled(17, 6, haz, 3.5);
    else if (wx.includes("GS")) inner += triEmpty(17, 6, haz, 3.5);
    else if (wx.includes("PL") || wx.includes("PE")) inner += triDot(17, 6, haz, 3.5);
    else if (wx.includes("DZ")) inner += comma(17, 4.5, liq);

    if (isVC && !wx.includes("SH")) return inner + vcParens(haz);
    return inner;
  }

  // 3. Schauer (SH)
  if (wx.includes("SH") || (isVC && (wx.includes("RA") || wx.includes("SN") || wx.includes("GR")))) {
    let sColor = wx.includes("SN") ? snow : liq;
    if (wx.includes("GR") || wx.includes("GS") || wx.includes("PL") || wx.includes("PE")) sColor = haz;

    let inner = showerTri(sColor, intens);
    if (wx.includes("GR")) inner += triFilled(17, 6, haz, 3.5);
    else if (wx.includes("GS")) inner += triEmpty(17, 6, haz, 3.5);
    else if (wx.includes("PL") || wx.includes("PE")) inner += triDot(17, 6, haz, 3.5);
    else if (wx.includes("SN")) inner += star(17, 6, snow, 3.5);
    else if (wx.includes("RA") || !wx.includes("SH")) inner += dot(17, 6, liq, 2.5);

    if (isVC) return inner + vcParens(sColor);
    return inner;
  }

  // 4. Gefrierend (FZ)
  if (wx.includes("FZ")) {
    if (wx.includes("RA")) return freezingS(intens, true, haz);
    if (wx.includes("DZ")) return freezingS(intens, false, haz);
    if (wx.includes("FG")) return fogLines("FZFG", haz);
  }

  // 5. Fester Niederschlag (grob)
  if (wx.includes("PL") || wx.includes("PE")) {
    return `<polygon points="17,9 9,25 25,25" fill="none" stroke="${haz}" stroke-width="2.2" stroke-linejoin="round"/>` +
      `<circle cx="17" cy="20" r="2.5" fill="${haz}"/>`;
  }
  if (wx.includes("GR")) {
    return `<polygon points="17,9 9,25 25,25" fill="${haz}" stroke="${haz}" stroke-width="2" stroke-linejoin="round"/>`;
  }
  if (wx.includes("GS")) {
    return `<polygon points="17,9 9,25 25,25" fill="none" stroke="${haz}" stroke-width="2.2" stroke-linejoin="round"/>`;
  }

  // -- Schnee-Typen --
  if (wx.includes("IC")) {
    return `<line x1="5" y1="17" x2="29" y2="17" stroke="${snow}" stroke-width="2.4" stroke-linecap="round"/>` +
      `<line x1="12" y1="10" x2="22" y2="24" stroke="${snow}" stroke-width="2.2" stroke-linecap="round"/>` +
      `<line x1="22" y1="10" x2="12" y2="24" stroke="${snow}" stroke-width="2.2" stroke-linecap="round"/>`;
  }
  if (wx.includes("SG")) {
    return `<line x1="5" y1="17" x2="29" y2="17" stroke="${snow}" stroke-width="2.4" stroke-linecap="round"/>` +
      `<polygon points="17,7 9,21 25,21" fill="none" stroke="${snow}" stroke-width="2.2" stroke-linejoin="round"/>`;
  }

  // 6. Mischniederschlag & Drift (MUSS vor "reiner Regen/Schnee" stehen)
  if (wx.includes("RASN") || wx.includes("SNRA")) {
    return star(17, 8, snow, 4) + dot(17, 17, liq, 3) + star(17, 26, snow, 4);
  }
  if (wx.includes("RADZ") || wx.includes("DZRA")) {
    return dot(17, 8, liq, 3) + comma(17, 17, liq) + dot(17, 26, liq, 3);
  }

  // 7. Schneetreiben (Kreuz-Pfeile)
  if (wx.includes("BLSN")) return snowCross(snow, false);
  if (wx.includes("DRSN")) {
    const inner = snowCross(snow, true);
    return isVC ? inner + vcParens(snow) : inner;
  }

  // 8. Reiner Regen/Schnee/Niesel & Virga
  if (wx.includes("SN")) return precipPos(intens).map(([x, y]) => star(x, y, snow)).join("");
  if (wx.includes("RA")) return precipPos(intens).map(([x, y]) => dot(x, y, liq)).join("");
  if (wx.includes("DZ")) return precipPos(intens).map(([x, y]) => comma(x, y, liq)).join("");
  if (wx.includes("VIRGA")) {
    return `<path d="M10,19 C14,26 20,26 24,19" stroke="${liq}" stroke-width="2.2" fill="none" stroke-linecap="round"/>` + dot(17, 12, liq);
  }

  // 9. Sichtbehinderungen (Nebel etc.)
  if (wx.includes("MIFG")) return fogLines("MIFG", fog);
  if (wx.includes("BCFG")) return fogLines("BCFG", fog);
  if (wx.includes("PRFG")) return fogLines("PRFG", fog);
  if (wx.includes("VCFG")) return fogLines("VCFG", fog) + vcParens(fog);
  if (wx.includes("FG")) return fogLines("FG", fog);
  if (wx.includes("BR")) return fogLines("BR", fog);
  if (wx.includes("HZ")) return `<path d="M8,17 C8,10 17,10 17,17 C17,24 26,24 26,17 C26,10 17,10 17,17 C17,24 8,24 8,17" stroke="${fog}" stroke-width="2" fill="none"/>`;

  // 10. Rauch, Staub & Sand
  if (wx.includes("FU") || wx.includes("VA")) {
    return `<path d="M8,26 L8,10 C8,6 14,6 14,10 C14,14 20,14 20,10 C20,6 26,6 26,10" stroke="#999" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
  }
  if (wx.includes("SS") || wx.includes("DS") || wx.includes("DRSA") || wx.includes("DRDU")) {
    const inner = dustStorm(dust, heavy);
    return isVC ? inner + vcParens(dust) : inner;
  }
  if (wx.includes("BLDU") || wx.includes("BLSA") || wx.includes("SA") || wx.includes("BLPY") || wx.includes("VCSA")) {
    const sPath = "M22,10 C22,5 12,5 12,11 C12,16 22,18 22,23 C22,29 12,29 12,24";
    const inner = `<path d="${sPath}" stroke="${dust}" stroke-width="2.2" fill="none" stroke-linecap="round"/>` +
      `<line x1="17" y1="4" x2="17" y2="30" stroke="${dust}" stroke-width="2.2" stroke-linecap="round"/>`;
    return isVC ? inner + vcParens(dust) : inner;
  }
  if (wx.includes("DU")) {
    const sPath = "M22,10 C22,5 12,5 12,11 C12,16 22,18 22,23 C22,29 12,29 12,24";
    const inner = `<path d="${sPath}" stroke="${dust}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
    return isVC ? inner + vcParens(dust) : inner;
  }

  return null;
}

const parser = new DOMParser();

/** Fertiges, positioniertes `<g>`-Element für ein bestehendes Chart-SVG (DOM),
 *  zentriert auf (cx, cy), skaliert von `WX_SYMBOL_VIEWBOX` (34×34) auf
 *  `opts.size` Pixel. `null` wenn `wxStr` kein zeichenbares Symbol ergibt. */
export function placeWxSymbol(cx, cy, wxStr, { size = 22 } = {}) {
  const inner = wxSymbolMarkup(wxStr);
  if (!inner) return null;
  const doc = parser.parseFromString(`<svg xmlns="${NS}"><g>${inner}</g></svg>`, "image/svg+xml");
  const imported = document.importNode(doc.documentElement.firstElementChild, true);
  const scale = size / 34;
  const wrap = document.createElementNS(NS, "g");
  wrap.setAttribute("transform", `translate(${cx},${cy}) scale(${scale}) translate(-17,-17)`);
  wrap.appendChild(imported);
  return wrap;
}

// -- Open-Meteo weather_code (WMO-Tabelle 4677, reduzierter Satz) --------------

const WMO_CODE_TO_WX = {
  45: "FG", 48: "FZFG",
  51: "-DZ", 53: "DZ", 55: "+DZ",
  56: "-FZDZ", 57: "+FZDZ",
  61: "-RA", 63: "RA", 65: "+RA",
  66: "-FZRA", 67: "+FZRA",
  71: "-SN", 73: "SN", 75: "+SN", 77: "SG",
  80: "-SHRA", 81: "SHRA", 82: "+SHRA",
  85: "-SHSN", 86: "+SHSN",
  95: "TS", 96: "TSGR", 99: "+TSGR",
};

/** Open-Meteo `weather_code` → METAR-artiger wx-String für `wxSymbolMarkup()`,
 *  oder `null` für 0-3 (klar/bewölkt, kein zeichenbares Wetter) bzw.
 *  unbekannte Codes. Bewusst NICHT die volle SYNOP-ww-Tabelle (00-99) echter
 *  Beobachtungen — Open-Meteos Satz ist eine andere, kleinere WMO-Tabelle. */
export function wmoWeatherCodeToWx(code) {
  return WMO_CODE_TO_WX[code] ?? null;
}

/** Open-Meteo `weather_code` → eine von sieben Wetterkategorien
 *  (`fog|drizzle|rain|freezing|snow|showers|thunder`), `null` für 0-3/
 *  unbekannt. Kanonische Grenzwerte für alle Verbraucher (Kartenlayer,
 *  Meteogramm-Ribbon). */
export function wmoWeatherCategory(code) {
  if (code == null) return null;
  if (code === 45 || code === 48) return "fog";
  if (code >= 95) return "thunder";
  if (code === 56 || code === 57 || code === 66 || code === 67) return "freezing";
  if ((code >= 80 && code <= 82) || code === 85 || code === 86) return "showers";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 61 && code <= 65) return "rain";
  if (code >= 51 && code <= 55) return "drizzle";
  return null;
}
