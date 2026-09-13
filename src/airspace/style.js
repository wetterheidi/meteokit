/**
 * Styling/Popup-Helfer für openAIP-Luftraum-GeoJSON-Features
 * (`{ properties: { name, icaoClass, type, activity, upperLimit, lowerLimit } }`).
 * Datenquellen-unabhängig -- arbeitet nur auf diesen Properties, egal ob sie
 * vom eigenen Cache-Server oder (theoretisch) direkt von openAIP kommen.
 */

// icaoClass: 0=A,1=B,2=C,3=D,4=E,5=F,6=G,8=Unclassified/Special-Use-Airspace
// (offiziell dokumentiert im OpenAPI-Schema von api.core.openaip.net).
const ICAO_CLASS_LABELS = { 0: "A", 1: "B", 2: "C", 3: "D", 4: "E", 5: "F", 6: "G", 8: "SUA" };
const ICAO_CLASS_COLORS = { 0: "#0057b8", 1: "#0057b8", 2: "#c800c8", 3: "#0057b8", 4: "#c800c8", 5: "#888", 6: "#888" };
const ICAO_CLASS_DASHED = new Set([3, 4, 5, 6]);

// type-Enum ebenfalls aus dem OpenAPI-Schema; nur die für Farbgebung
// relevanten Einträge sind eingefärbt, der Rest fällt auf Grau zurück.
const TYPE_LABELS = {
  0: "Other", 1: "Restricted", 2: "Danger", 3: "Prohibited", 4: "CTR", 5: "TMZ", 6: "RMZ", 7: "TMA",
  8: "TRA", 9: "TSA", 10: "FIR", 11: "UIR", 12: "ADIZ", 13: "ATZ", 14: "MATZ", 15: "Airway", 16: "MTR",
  17: "Alert Area", 18: "Warning Area", 19: "Protected Area", 20: "HTZ", 21: "Gliding Sector", 22: "TRP",
  23: "TIZ", 24: "TIA", 25: "MTA", 26: "CTA", 27: "ACC Sector", 28: "Aerial Sporting/Recreational Activity",
  29: "Low Altitude Overflight Restriction", 30: "MRT", 31: "TFR", 32: "VFR Sector", 33: "FIS Sector",
  34: "LTA", 35: "UTA", 36: "MCTR",
};
const TYPE_COLORS = {
  1: "#c81e1e", 2: "#b45f06", 3: "#8b0000", // Restricted, Danger, Prohibited
  4: "#1155a3", 5: "#1155a3", 6: "#1155a3", 7: "#1155a3", // CTR, TMZ, RMZ, TMA
  17: "#b45f06", 18: "#b45f06", // Alert/Warning Area
};
// activity 1 = "Parachuting Activity" -- für Fallschirmsprung-Apps naturgemäß
// die wichtigste Kategorie, deshalb unabhängig von Klasse/Typ hervorgehoben.
const PARACHUTE_ACTIVITY = 1;
const PARACHUTE_COLOR = "#c81e1e";

export function airspaceStyle(feature) {
  const p = feature.properties;
  const isParachuteArea = p.activity === PARACHUTE_ACTIVITY;
  let color = (p.icaoClass !== 8 && ICAO_CLASS_COLORS[p.icaoClass]) || TYPE_COLORS[p.type] || "#888";
  if (isParachuteArea) color = PARACHUTE_COLOR;

  return {
    color,
    weight: isParachuteArea ? 2.5 : p.icaoClass === 1 ? 2.5 : p.icaoClass === 2 ? 2 : 1.3,
    opacity: 0.85,
    fillOpacity: isParachuteArea ? 0.08 : 0,
    fillColor: color,
    dashArray: ICAO_CLASS_DASHED.has(p.icaoClass) ? "6 4" : null,
  };
}

// unit 1=FT, 6=FL; referenceDatum 0=GND, 1=MSL, 2=STD (immer bei FL, daher kein
// eigenes Label nötig). Cross-validiert an echten Datensätzen (z.B. "BIRKEN-75
// UGR. 5500FT" -> {value:5500, unit:1}, "GAMOLA-95 UGR. FL65" -> {value:65,
// unit:6}), da die numerischen Enum-Werte selbst nicht im API-Schema stehen.
export function formatLimit(limit) {
  if (!limit) return "?";
  const { value, unit, referenceDatum } = limit;
  if (unit === 6) return `FL${value}`;
  if (referenceDatum === 0) return value === 0 ? "GND" : `${value} ft GND`;
  if (referenceDatum === 1) return `${value} ft MSL`;
  return `${value}`;
}

export function airspacePopup(feature) {
  const p = feature.properties;
  const cls = ICAO_CLASS_LABELS[p.icaoClass] || TYPE_LABELS[p.type] || "";
  const lower = formatLimit(p.lowerLimit);
  const upper = formatLimit(p.upperLimit);
  return `<b>${p.name || "Luftraum"}</b>${cls ? ` (${cls})` : ""}<br>${lower} – ${upper}`;
}
