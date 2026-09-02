/** Anzeige-Zeitzone für alle Zeitangaben (intern immer Epochensekunden UTC).
 *  "loc" = Ortszeit des Browsers (JS-Date-Default), "utc" = UTC/Zulu.
 *  Analog zu `units.js` (`unitState`/`setUnits`): ein Modul-globaler Zustand,
 *  den der Host per `setTimeZone` aus den Nutzereinstellungen setzt, und den
 *  alle zeitanzeigenden Komponenten (Meteogramm, Cross-Section, GRAMET) lesen. */

export const timeState = { zone: "loc" };

export function setTimeZone(zone) {
  if (["loc", "utc"].includes(zone)) timeState.zone = zone;
}

export function getTimeZone() {
  return timeState.zone;
}

/** Kurzes Kürzel für Achsen-/Kopfbeschriftungen ("loc" | "UTC"). */
export function zoneTag() {
  return timeState.zone === "utc" ? "UTC" : "loc";
}

function tzOpt() {
  return timeState.zone === "utc" ? { timeZone: "UTC" } : {};
}

/** Stunde/Minute/Tag eines Zeitpunkts in der aktuell gewählten Anzeigezone. */
export function zHours(d) {
  return timeState.zone === "utc" ? d.getUTCHours() : d.getHours();
}
export function zMinutes(d) {
  return timeState.zone === "utc" ? d.getUTCMinutes() : d.getMinutes();
}
export function zDate(d) {
  return timeState.zone === "utc" ? d.getUTCDate() : d.getDate();
}
export function zMonth(d) {
  return timeState.zone === "utc" ? d.getUTCMonth() : d.getMonth();
}
export function zFullYear(d) {
  return timeState.zone === "utc" ? d.getUTCFullYear() : d.getFullYear();
}

/** Gruppierschlüssel für "gleicher Kalendertag" in der Anzeigezone (Tagesgrenzen
 *  von Achsen-/Tabellenspalten, s. GRAMET `drawTimeAxis`/`gonogotable.js`). */
export function zDayKey(d) {
  return `${zFullYear(d)}-${zMonth(d)}-${zDate(d)}`;
}

/** `Date#toLocaleString`/`toLocaleDateString`, zonenbewusst (de-DE, `opts` wie gewohnt). */
export function fmtClock(d, opts = {}) {
  return d.toLocaleString("de-DE", { ...opts, ...tzOpt() });
}
export function fmtDate(d, opts = {}) {
  return d.toLocaleDateString("de-DE", { ...opts, ...tzOpt() });
}

/** "HH:MM" in der Anzeigezone. */
export function fmtHHMM(d) {
  return `${String(zHours(d)).padStart(2, "0")}:${String(zMinutes(d)).padStart(2, "0")}`;
}

/** "TT.MM." in der Anzeigezone (Achsen-Tagesmarken). */
export function fmtDDMM(d) {
  return `${String(zDate(d)).padStart(2, "0")}.${String(zMonth(d) + 1).padStart(2, "0")}.`;
}

/** "TT.MM.JJ HH:MM" in der Anzeigezone (kompakte Zeitstempel, z. B. Kartenlayer). */
export function fmtDDMMYYHHMM(d) {
  const yy = String(zFullYear(d)).slice(-2);
  return `${fmtDDMM(d)}${yy} ${fmtHHMM(d)}`;
}
