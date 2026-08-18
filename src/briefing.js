/**
 * Weather Briefing (Anlehnung an das DZMaster-Briefing): eine druckbare
 * HTML-Seite für den aktuellen Tag mit einer Oberflächentabelle (limitierende
 * Faktoren, Wolken/Wetter im METAR-Stil) und stündlichen Höhentabellen aus
 * Michaels Modell-Leveln bis zur eingestellten max. Flughöhe.
 *
 * Höhenraster adaptiv (an Modellauflösung + Drohnenrelevanz angelehnt):
 *   ≤ 300 m → 25 m · 300–1000 m → 50 m · > 1000 m → 100 m,
 * beginnend bei 0 m (= unterstes Level) und immer mit der max. Flughöhe als
 * letzter Zeile.
 */

import { sampleColumnAtHeight } from "./column.js";
import { cloudFraction, cloudLayers, classifyFog } from "./clouds.js";
import { toPhenomenon } from "./gramet/hazards/fog.js";
import {
  windToDisplay, tempToDisplay, heightToDisplay,
  windUnit, tempUnit, heightUnit,
} from "./units.js";

const KMH_TO_MS = 1 / 3.6;

// --- öffentliches API -------------------------------------------------------

/**
 * Baut das komplette, in sich geschlossene Briefing-Dokument (für Druck / „Als
 * PDF speichern" in einem eigenen Fenster/iframe). Enthält HEAD mit @media
 * print-Regeln und die Überschrift; der eigentliche Inhalt kommt aus
 * buildBriefingContent().
 * @param {object} opts – siehe buildBriefingContent()
 */
export function buildBriefingHtml(opts) {
  return HEAD
    + `<div class="container"><h1>DroneForecast — Weather Briefing</h1>`
    + buildBriefingContent(opts)
    + `</div></body></html>`;
}

/**
 * Baut den Briefing-Inhalt als HTML-Fragment (ohne <html>/<head>/<body> und
 * ohne die H1-Überschrift) – so, dass er direkt in das Briefing-Overlay
 * eingehängt werden kann. Für den Druck wird derselbe Inhalt von
 * buildBriefingHtml() in ein vollständiges Dokument gewickelt.
 * @param {object} opts
 * @param {object} opts.surface  Rückgabe von fetchSurface()
 * @param {object} opts.col      Rohe Säule von fetchColumn()
 * @param {{lat:number, lon:number}} opts.point
 * @param {string} opts.modelLabel
 * @param {number} opts.maxHeightM  max. Flughöhe (m AGL)
 * @param {number} opts.loadedAt    Ladezeitpunkt (ms) – Default für den Tag,
 *   falls selectedDate fehlt, und Basis für die „heute"/„morgen"-Bezeichnung
 * @param {string} [opts.selectedDate]  gewählter Vorhersagetag (YYYY-MM-DD,
 *   UTC) – z. B. aus dem Tages-Select im Briefing-Overlay; ohne Angabe der
 *   Tag von loadedAt (bisheriges Verhalten: „heute")
 */
export function buildBriefingContent({ surface, col, point, modelLabel, maxHeightM, loadedAt, selectedDate }) {
  const todayYmd = new Date(loadedAt).toISOString().slice(0, 10);
  const day = selectedDate || todayYmd;
  const isSelectedDay = (sec) => new Date(sec * 1000).toISOString().slice(0, 10) === day;
  const dayLabel = relativeDayLabel(day, todayYmd);

  const sfcIdx = surface.time.map((s, i) => (isSelectedDay(s) ? i : -1)).filter((i) => i >= 0);
  const colIdxByTime = new Map(col.time.map((s, i) => [s, i]));
  const colIdx = col.time.map((s, i) => (isSelectedDay(s) ? i : -1)).filter((i) => i >= 0);

  const heights = briefingHeights(maxHeightM);
  const wu = windUnit(), tu = tempUnit(), hu = heightUnit();
  const created = new Date(loadedAt).toISOString().slice(0, 16).replace("T", " ") + "Z";

  let html = `<div class="header-info">
      <p><strong>Position:</strong> ${point.lat.toFixed(4)}°N ${point.lon.toFixed(4)}°E · Gitterhöhe ${Math.round(col.elevation)} m NN</p>
      <p><strong>Modell:</strong> ${modelLabel}</p>
      <p><strong>Vorhersagetag:</strong> ${day} (${dayLabel}) · <strong>erstellt:</strong> ${created}</p>
      <p><strong>Max. Flughöhe:</strong> ${Math.round(heightToDisplay(maxHeightM))} ${hu} AGL</p>
    </div>`;

  if (!sfcIdx.length) {
    return html + `<div class="section"><p>Keine Daten für diesen Tag geladen — ggf. den Vorhersagehorizont in den Einstellungen ("Horizont") erhöhen.</p></div>`;
  }

  // --- Oberflächentabelle ---------------------------------------------------
  html += `<div class="section">
    <h2>Oberfläche (${dayLabel}, stündlich)</h2>
    <table><thead><tr>
      <th>Datum</th><th>Zeit (Z)</th><th>Wind Dir (°)</th><th>Wind (${wu})</th>
      <th>Sicht (m)</th><th>Wetter</th><th>Wolken</th><th>Temp (${tu})</th>
    </tr></thead><tbody>`;

  const at = (name, i) => (surface.vars[name] ? surface.vars[name][i] : null);
  for (const i of sfcIdx) {
    const sec = surface.time[i];
    const ci = colIdxByTime.get(sec);
    const clouds = ci != null ? metarCloudsForHour(col, ci) : "N/A";
    const fogEntry = ci != null ? classifyFog(col, ci, at("visibility", i), at("weather_code", i)) : null;
    const phenomenon = ci != null ? toPhenomenon(fogEntry) : null;
    html += `<tr>
      <td>${ymdUTC(sec)}</td>
      <td>${hhmmZ(sec)}</td>
      <td>${metarDir(at("wind_direction_10m", i))}</td>
      <td>${windGust(at("wind_speed_10m", i), at("wind_gusts_10m", i))}</td>
      <td>${metarVis(at("visibility", i))}</td>
      <td>${metarWeather(at("weather_code", i), phenomenon)}</td>
      <td>${clouds}</td>
      <td>${fmtNum(tempToDisplay(at("temperature_2m", i)), 0)}</td>
    </tr>`;
  }
  html += `</tbody></table></div>`;

  // --- Höhentabellen je Stunde ---------------------------------------------
  html += `<div class="section">
    <h2>Höhendaten (${dayLabel}, stündlich, bis ${Math.round(heightToDisplay(maxHeightM))} ${hu} AGL)</h2>`;

  for (const i of colIdx) {
    const sec = col.time[i];
    html += `<h3>${ymdUTC(sec)} ${hhmmZ(sec)}</h3>
      <table><thead><tr>
        <th>h (${hu} AGL)</th><th>p (hPa)</th><th>T (${tu})</th><th>Dew (${tu})</th>
        <th>Dir (°)</th><th>Spd (${wu})</th><th>RH (%)</th><th>Wolken (%)</th>
      </tr></thead><tbody>`;

    for (const hM of heights) {
      const s = sampleColumnAtHeight(col, i, hM);
      const spdMs = s.spd;
      const dir = s.dir;
      const dew = dewFromRhT(s.rh, s.t);
      html += `<tr>
        <td>${Math.round(heightToDisplay(hM))}</td>
        <td>${fmtNum(s.p, 1)}</td>
        <td>${fmtNum(tempToDisplay(s.t), 1)}</td>
        <td>${fmtNum(dew == null ? null : tempToDisplay(dew), 1)}</td>
        <td>${metarDir(dir)}</td>
        <td>${fmtNum(windToDisplay(spdMs), 1)}</td>
        <td>${fmtNum(s.rh, 0)}</td>
        <td>${fmtNum(cloudFraction({ q: s.q, p: s.p, t: s.t, rh: s.rh, qw: s.qw, qi: s.qi, clc: s.clc, model: s.model }, hM, s.w) * 100, 0)}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }

  html += `</div>
    <div class="footer">
      Höhendaten: DWD ICON Modell-Level via open-meteo.mah.priv.at · Oberfläche via open-meteo.com.
      Wolken/Wetter METAR-nah aus dem Modell abgeleitet (Heuristik), keine Beobachtung.
      Keine amtliche Flugwetterberatung — Verantwortung beim Piloten.
    </div>`;
  return html;
}

// --- Höhenraster ------------------------------------------------------------

/** Adaptives AGL-Höhenraster (m) von 0 bis maxHeightM, inkl. maxHeightM. */
export function briefingHeights(maxHeightM) {
  const bands = [
    { upTo: 300, step: 25 },
    { upTo: 1000, step: 50 },
    { upTo: Infinity, step: 100 },
  ];
  const out = [0];
  let h = 0;
  while (h < maxHeightM) {
    const step = bands.find((b) => h < b.upTo).step;
    const next = h + step;
    if (next >= maxHeightM) break;
    out.push(next);
    h = next;
  }
  out.push(maxHeightM);
  return out;
}

// --- METAR-nahe Formatierung ------------------------------------------------

const WMO_TO_TAF = {
  0: "NSW", 1: "NSW", 2: "NSW", 3: "NSW",
  45: "FG", 48: "FZFG",
  51: "-DZ", 53: "DZ", 55: "+DZ", 56: "-FZDZ", 57: "FZDZ",
  61: "-RA", 63: "RA", 65: "+RA", 66: "-FZRA", 67: "FZRA",
  71: "-SN", 73: "SN", 75: "+SN", 77: "SG",
  80: "-SHRA", 81: "SHRA", 82: "+SHRA", 83: "-SHRASN", 85: "-SHSN", 86: "SHSN",
  95: "TSRA", 96: "TSGR", 99: "+TSGR",
};
/**
 * METAR-nahes Wettersymbol aus `weather_code` — korrigiert um den
 * sichtbasierten Bodenbefund `phenomenon` (`clouds.js` `classifyFog()` bzw.
 * `gramet/hazards/fog.js` `toPhenomenon()`): meldet weather_code KEIN
 * signifikantes Wetter, liefert der Befund aber Nebel/Diesigkeit/Dunst, wird
 * FG/FZFG/BR/HZ ergänzt (Priorität FG > BR > HZ, das schwerste Phänomen
 * gewinnt). Zeigt weather_code bereits etwas Schwereres (Gewitter,
 * Niederschlag), bleibt das unverändert — nichts wird darübergestülpt.
 *
 * SONDERFALL FG/FZFG: `weather_code` 45/48 gilt NICHT automatisch, sobald ein
 * `phenomenon`-Objekt vorliegt (auch ein leeres, s. `toPhenomenon()`) — dann
 * entscheidet die sichtbasierte Diagnose, nicht der rohe Code (der sonst
 * einer per Sicht widerlegten Nebelmeldung widersprechen könnte, s. Feedback:
 * Meteogramm/Briefing zeigten "FG" über Stunden, in denen GRAMETs
 * Sichtdiagnose längst kein Nebel mehr sah). Nur OHNE jedes `phenomenon`
 * (Spalte nicht geladen) bleibt der rohe Code die einzige Quelle.
 *
 * `phenomenon` mit den Feldnamen `fog`/`freezing`/`mist`/`haze` — bestehende
 * Aufrufer (nur `fog`/`freezing` setzend) funktionieren unverändert weiter.
 */
export function metarWeather(code, phenomenon = null) {
  const c = parseInt(code, 10);
  const w = Number.isNaN(c) ? "N/A" : (WMO_TO_TAF[c] || "N/A");
  const isFogFamily = w === "FG" || w === "FZFG";
  if (w !== "NSW" && w !== "N/A" && !(isFogFamily && phenomenon)) return w;
  if (phenomenon?.fog) return phenomenon.freezing ? "FZFG" : "FG";
  if (phenomenon?.mist) return "BR";
  if (phenomenon?.haze) return "HZ";
  return isFogFamily ? "NSW" : w;
}

/** Windrichtung METAR: auf 10° gerundet, 360 für Nord, dreistellig. */
function metarDir(deg) {
  const d = parseFloat(deg);
  if (Number.isNaN(d)) return "N/A";
  let r = Math.round(d / 10) * 10;
  if (r === 0 || r >= 360) r = 360;
  return String(r).padStart(3, "0");
}

/** Sicht (m) mit METAR-Rundung -- auch von der GRAMET-Sicht-Zeile genutzt
 *  (s. render.js), damit beide Darstellungen dieselbe Rundung zeigen. */
export function metarVis(m) {
  const v = parseFloat(m);
  if (Number.isNaN(v)) return "N/A";
  if (v >= 10000) return ">10000";
  if (v >= 5000) return String(Math.round(v / 1000) * 1000);
  return String(Math.round(v / 100) * 100);
}

/** „Spd G Böe" in der eingestellten Windeinheit (Eingaben in km/h). */
function windGust(spdKmh, gustKmh) {
  const s = spdKmh == null ? null : Math.round(windToDisplay(spdKmh * KMH_TO_MS));
  const g = gustKmh == null ? null : Math.round(windToDisplay(gustKmh * KMH_TO_MS));
  if (s == null) return "N/A";
  return g == null ? `${s}` : `${s} G ${g}`;
}

/**
 * METAR-nahe Wolkenzeile für eine Stunde: ALLE Schichten (tief, mittelhoch,
 * hoch) aus dem Modell-RH-Profil via clouds.js `cloudLayers` — nicht nur die
 * unterste, und ohne den früheren „nur zunehmende Bedeckung"-Filter, damit eine
 * dünnere hohe Schicht über einer tieferen nicht verschluckt wird. Format
 * `FEW 900ft, BKN 4000ft` in Anzeigeeinheit, „SKC" wenn frei.
 */
function metarCloudsForHour(col, i) {
  const layers = cloudLayers(col, i);
  if (!layers.length) return "SKC";
  return layers.map((l) => {
    const disp = heightUnit() === "ft"
      ? Math.round(heightToDisplay(l.baseM) / 100) * 100
      : Math.round(l.baseM / 50) * 50;
    return `${l.cover} ${disp}${heightUnit()}`;
  }).join(", ");
}

// --- physikalische Helfer ---------------------------------------------------

/** Taupunkt (°C) aus RH (%) und T (°C) via Magnus (über Wasser). */
function dewFromRhT(rh, tC) {
  if (!Number.isFinite(rh) || rh <= 0 || !Number.isFinite(tC)) return null;
  const es = 611.2 * Math.exp((17.62 * tC) / (243.12 + tC));
  const e = (rh / 100) * es;
  if (e <= 0) return null;
  const ln = Math.log(e / 611.2);
  return (243.12 * ln) / (17.62 - ln);
}

// --- Formatierung / Zeit ----------------------------------------------------

function fmtNum(x, digits) {
  return typeof x === "number" && Number.isFinite(x) ? x.toFixed(digits) : "N/A";
}
function ymdUTC(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}
/** „heute"/„morgen" relativ zu todayYmd, sonst das Datum selbst (YYYY-MM-DD, beide UTC). */
function relativeDayLabel(ymd, todayYmd) {
  const diffDays = Math.round((Date.parse(ymd) - Date.parse(todayYmd)) / 86400000);
  if (diffDays === 0) return "heute";
  if (diffDays === 1) return "morgen";
  return ymd;
}
function hhmmZ(sec) {
  return new Date(sec * 1000).toISOString().slice(11, 16).replace(":", "") + "Z";
}

const HEAD = `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8">
<title>DroneForecast — Weather Briefing</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; }
  .container { max-width: 1000px; margin: 20px auto; padding: 20px; }
  h1, h2, h3 { color: #1c5cab; border-bottom: 2px solid #3a8fd0; padding-bottom: 8px; }
  h3 { font-size: 1em; border-bottom-width: 1px; margin-top: 24px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 0.9em; }
  th, td { padding: 6px 10px; border: 1px solid #ddd; text-align: left; }
  th { background-color: #f2f2f2; font-weight: bold; }
  tr:nth-child(even) { background-color: #f9f9f9; }
  .header-info { background-color: #eef2f6; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
  .header-info p { margin: 4px 0; }
  .section { margin-top: 32px; }
  .footer { margin-top: 32px; font-size: 0.8em; color: #777; }
  @media print {
    body { font-size: 10pt; }
    .container { margin: 0; padding: 0; max-width: 100%; }
    h1, h2, h3 { page-break-after: avoid; }
    table { page-break-inside: auto; }
    tr { page-break-inside: avoid; }
  }
</style></head><body>`;
