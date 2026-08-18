/** Anzeige-Einheiten (intern wird durchgehend SI gerechnet: m, m/s, °C). */

const FT_PER_M = 3.28084;
const KT_PER_MS = 1.94384;

export const unitState = { height: "m", wind: "kmh", temp: "c" };

export function setUnits({ height, wind, temp } = {}) {
  if (["m", "ft"].includes(height)) unitState.height = height;
  if (["kmh", "ms", "kt"].includes(wind)) unitState.wind = wind;
  if (["c", "f"].includes(temp)) unitState.temp = temp;
}

export function fmtHeight(m) {
  if (m == null || !Number.isFinite(m)) return "–";
  return unitState.height === "ft" ? `${Math.round(m * FT_PER_M)} ft` : `${Math.round(m)} m`;
}

export function heightUnit() {
  return unitState.height === "ft" ? "ft" : "m";
}

export function heightToDisplay(m) {
  return unitState.height === "ft" ? m * FT_PER_M : m;
}

export function heightFromDisplay(v) {
  return unitState.height === "ft" ? v / FT_PER_M : v;
}

export function fmtWind(ms) {
  if (ms == null || !Number.isFinite(ms)) return "–";
  switch (unitState.wind) {
    case "ms": return `${ms.toFixed(1)} m/s`;
    case "kt": return `${Math.round(ms * KT_PER_MS)} kt`;
    default: return `${Math.round(ms * 3.6)} km/h`;
  }
}

export function windUnit() {
  return unitState.wind === "ms" ? "m/s" : unitState.wind === "kt" ? "kt" : "km/h";
}

/** m/s → Anzeigeeinheit als Zahl (für Achsen/Skalen). */
export function windToDisplay(ms) {
  switch (unitState.wind) {
    case "ms": return ms;
    case "kt": return ms * KT_PER_MS;
    default: return ms * 3.6;
  }
}

/** °C → Anzeigeeinheit als Zahl (für Achsen/Skalen). */
export function tempToDisplay(c) {
  return unitState.temp === "f" ? c * 9 / 5 + 32 : c;
}

export function tempUnit() {
  return unitState.temp === "f" ? "°F" : "°C";
}

export function fmtTemp(c) {
  if (c == null || !Number.isFinite(c)) return "–";
  return unitState.temp === "f" ? `${Math.round(c * 9 / 5 + 32)} °F` : `${Math.round(c)} °C`;
}

/** Windrichtung (Herkunft, °) als 16-teilige Kompassrose. */
const COMPASS = ["N", "NNO", "NO", "ONO", "O", "OSO", "SO", "SSO",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
/** Grad ICAO-konform auf 10° gerundet, 0° (Windstille-Konvention) wird zu 360°. */
function roundDirIcao(norm) {
  const r = Math.round(norm / 10) * 10 % 360;
  return r === 0 ? 360 : r;
}
export function fmtDir(deg) {
  if (deg == null || !Number.isFinite(deg)) return "–";
  const norm = ((deg % 360) + 360) % 360;
  const i = Math.round(norm / 22.5) % 16;
  return `${COMPASS[i]} ${roundDirIcao(norm)}°`;
}

/** Windrichtung als dreistellige Gradzahl ohne Kompass-Buchstabe (ddd°),
 *  für die kompakte „ddd° ff"-Notation in „Aktuelle Bedingungen". ICAO-konform
 *  auf 10° gerundet; was dabei auf 0° fiele, wird als 360° gemeldet (0° ist
 *  laut Konvention Windstille, keine Richtung). */
export function fmtDirPadded(deg) {
  if (deg == null || !Number.isFinite(deg)) return "–––°";
  const norm = ((deg % 360) + 360) % 360;
  return `${String(roundDirIcao(norm)).padStart(3, "0")}°`;
}
