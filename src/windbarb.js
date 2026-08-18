/**
 * WMO-Windfieder (Kreis = Kalmen, Schaft + Fähnchen für 5/10/50 kt) — EIN Ort
 * für die Symbolgeometrie, gemeinsam genutzt vom Kartenlayer (windoverlay.js,
 * ~44px große Marker) und den Zeit-Charts (Meteogramm/Cross-Section, deutlich
 * kleinere Symbole, damit stündliche statt 3-stündliche Auflösung passt). Alle
 * Maße sind proportional zu `size` (Fraktionen unten aus den ursprünglichen
 * Fixwerten bei size=44 zurückgerechnet: SHAFT 18px, BW 10px, BS 4.5px, SW 2px,
 * HALO +3.5px) — der Kartenlayer bleibt damit optisch unverändert.
 *
 * `windBarbMarkup()` liefert NUR die innere Markup (kein umschließendes
 * `<svg>`), damit Aufrufer sie sowohl in ein eigenes Icon-SVG (Leaflet-
 * divIcon im Kartenlayer, reines String-Templating) als auch direkt in ein
 * bestehendes Chart-SVG einbetten können (`placeWindBarb()`, DOM-basiert).
 */

const NS = "http://www.w3.org/2000/svg";

// Ziel-Pixeldichte für Meteogramm/Cross-Section: Panelbreite wächst mit der
// Stundenzahl (statt in die Containerbreite gequetscht zu werden), damit
// stündliche Fiedern bei jedem Vorhersagehorizont lesbar bleiben — lange
// Horizonte scrollen dafür horizontal (Container hat overflow:auto).
// An CHART_BARB_SIZE gekoppelt (nicht fix): sonst würden sich benachbarte
// Fiedern bei größerem Symbol berühren/überlappen, v. a. deren Kalmen-Ringe
// bzw. Fähnchen bei Wind quer zur Zeitachse.
export const CHART_BARB_SIZE = 25;
export const CHART_PX_PER_HOUR = Math.round(CHART_BARB_SIZE * 1.1);

/** Herkunft/Geschwindigkeit (kt) als Fieder-Markup, Ursprung = Symbolzentrum,
 *  unrotiert zeigt der Schaft nach oben. `side`: 1 = Nordhalbkugel, -1 = Süd
 *  (Fiedern gespiegelt). */
export function windBarbMarkup(spdKt, dirFromDeg, { size = 44, side = 1, color = "#0b1220", halo = "#ffffff" } = {}) {
  const SHAFT = size * 0.409, BW = size * 0.227, BS = size * 0.102;
  const SW = Math.max(1, size * 0.045), HALO = SW + size * 0.08;

  if (spdKt < 2.5) {
    const r1 = size * 0.091, r2 = size * 0.182;
    const ring = (stroke, sw) => `<circle cx="0" cy="0" r="${r1}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`
      + `<circle cx="0" cy="0" r="${r2}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
    return `<g>${ring(halo, HALO)}${ring(color, SW)}</g>`;
  }

  let rem = Math.round(spdKt / 5) * 5;
  const penn = Math.floor(rem / 50); rem -= penn * 50;
  const full = Math.floor(rem / 10); rem -= full * 10;
  const half = rem >= 5 ? 1 : 0;

  const buildMarks = (sc, sw) => {
    let out = "", y = -SHAFT;
    for (let i = 0; i < penn; i++) {
      const y0 = y, y1 = y + BS * 2;
      out += `<polygon points="0,${y0} 0,${y1} ${side * BW},${(y0 + y1) / 2}" fill="${sc}" stroke="none"/>`;
      y += BS * 2 + 1;
    }
    for (let i = 0; i < full; i++) {
      out += `<line x1="0" y1="${y}" x2="${side * BW}" y2="${y}" stroke="${sc}" stroke-width="${sw}" stroke-linecap="round"/>`;
      y += BS;
    }
    if (half) out += `<line x1="0" y1="${y}" x2="${side * BW * 0.5}" y2="${y}" stroke="${sc}" stroke-width="${sw}" stroke-linecap="round"/>`;
    return out;
  };

  const haloG = `<circle cx="0" cy="0" r="${size * 0.057}" fill="${halo}"/>`
    + `<line x1="0" y1="0" x2="0" y2="${-SHAFT}" stroke="${halo}" stroke-width="${HALO}" stroke-linecap="round"/>`
    + buildMarks(halo, HALO);

  return `<g transform="rotate(${dirFromDeg})">`
    + haloG
    + `<circle cx="0" cy="0" r="${size * 0.045}" fill="${color}"/>`
    + `<line x1="0" y1="0" x2="0" y2="${-SHAFT}" stroke="${color}" stroke-width="${SW}" stroke-linecap="round"/>`
    + buildMarks(color, SW)
    + `</g>`;
}

const parser = new DOMParser();

/** Fertiges, positioniertes `<g>`-Element für ein bestehendes Chart-SVG (DOM),
 *  zentriert auf (cx, cy). */
export function placeWindBarb(cx, cy, spdKt, dirFromDeg, opts) {
  const markup = windBarbMarkup(spdKt, dirFromDeg, opts);
  const doc = parser.parseFromString(`<svg xmlns="${NS}">${markup}</svg>`, "image/svg+xml");
  const inner = document.importNode(doc.documentElement.firstElementChild, true);
  const wrap = document.createElementNS(NS, "g");
  wrap.setAttribute("transform", `translate(${cx},${cy})`);
  wrap.appendChild(inner);
  return wrap;
}
