/**
 * Vereisungs-Diagnose — Icing-Potential-Index (IPI) = f_T(T) * cloudFrac,
 * pro Zelle. Physik bewusst als reine Funktion (`ipiAt`) von den Verbrauchern
 * getrennt: GRAMET (`computeGrid`, hier) kategorisiert pro Gitterzelle für die
 * Kontur-Fläche (s. render.js `drawHazardArea`/`HAZARD_LEVELS`), Go/No-Go
 * wendet `ipiAt`/`ipiStatus` auf ein Bandmaximum zwischen 10 m und der
 * Flughöhe an (`icingBandMaxAt` in app.js, analog `windBandMaxAt`) — dieselbe
 * Physik, dieselben Schwellen, zwei unabhängige Reduktionen.
 *
 * f_T: weiches Trapez statt harter 0…−15-Box — Onset 0…−2 °C (Klareis am
 * gefährlichsten knapp unter 0, großer Tropfen/hoher LWC), Kernfenster
 * −2…−15 °C (maximale SLW-Häufigkeit), Vergletscherung −15…T_ICE_ONLY_C.
 * `cloudFrac` (statt einer eigenen RH-Schwelle) übernimmt "ist die Zelle in
 * der Wolke" von der bereits kalibrierten Wolkenfraktion (`clouds.js`,
 * gemeinsame Definition mit Wolkenbasis/Cb in `derive.js`) — keine zweite,
 * unkalibrierte RH-Heuristik.
 *
 * Schwellen (T- wie IPI-seitig) NICHT kalibriert — Platzhalter wie an
 * anderer Stelle im Modul, s. METHODIK.md. T_ICE_ONLY_C bewusst gleich
 * `CB_GLACIATION_C` aus derive.js gehalten (dort nicht exportiert, daher kein
 * Import — sonst zirkulär, da derive.js bereits icing.js importiert), damit
 * nicht zwei verschiedene Vergletscherungstemperaturen im selben Modul
 * auseinanderdriften.
 */

const KELVIN = 273.15;

const T_ONSET_C = 0;          // °C — ab hier beginnt Unterkühlung
const T_ONSET_FULL_C = -2;    // °C — Onset abgeschlossen, f_T = 1
const T_CORE_BOTTOM_C = -15;  // °C — Kernfenster-Ende, Vergletscherung beginnt
const T_ICE_ONLY_C = -20;     // °C — praktisch nur noch Eiskristalle, f_T = 0

// Gemeinsame Kategorie-Schwellen für alle Verbraucher (GRAMET, Go/No-Go).
const IPI_LIGHT = 0.15, IPI_MODERATE = 0.30, IPI_SEVERE = 0.45;

/** Temperaturfenster-Faktor (0..1), s. Modulkopf. */
function fT(tC) {
  if (!Number.isFinite(tC) || tC >= T_ONSET_C) return 0;
  if (tC >= T_ONSET_FULL_C) return (T_ONSET_C - tC) / (T_ONSET_C - T_ONSET_FULL_C);
  if (tC >= T_CORE_BOTTOM_C) return 1;
  if (tC >= T_ICE_ONLY_C) return (tC - T_ICE_ONLY_C) / (T_CORE_BOTTOM_C - T_ICE_ONLY_C);
  return 0;
}

/**
 * Icing-Potential-Index (0..1) an einem Punkt — reine Funktion, unabhängig
 * von Grid/Zeitachse/Rendering. `cloudFrac` fehlt/NaN wird als 0 behandelt
 * (kein Befund), nie stillschweigend als "in der Wolke".
 */
export function ipiAt(tC, cloudFrac) {
  const cf = Number.isFinite(cloudFrac) ? cloudFrac : 0;
  return fT(tC) * cf;
}

/** IPI (0..1) -> Kategorie, gemeinsame Schwellen für alle Verbraucher. */
export function ipiCategory(ipi) {
  if (!Number.isFinite(ipi) || ipi < IPI_LIGHT) return "none";
  if (ipi < IPI_MODERATE) return "light";
  if (ipi < IPI_SEVERE) return "moderate";
  return "severe";
}

/**
 * Untere IPI-Schwelle der Kategorie von `ipi` -- 0 bei "none" (kein
 * Vereisungsband). Für Go/No-Go: die Höhengrenzen des Bands der stärksten
 * Vereisung sind dort definiert, wo der IPI diese Schwelle kreuzt (analog
 * `crossHeight` in clouds.js für Wolkenbasis/-obergrenze), s.
 * `icingBandMaxAt` in app.js.
 */
export function ipiCategoryFloor(ipi) {
  const cat = ipiCategory(ipi);
  if (cat === "severe") return IPI_SEVERE;
  if (cat === "moderate") return IPI_MODERATE;
  if (cat === "light") return IPI_LIGHT;
  return 0;
}

/**
 * IPI (0..1) -> Go/No-Go-Ampel (green/yellow/red), s. gonogo.js. Dieselben
 * Schwellen wie `ipiCategory` (IPI_MODERATE/IPI_SEVERE) -- nur auf drei statt
 * vier Stufen zusammengefasst (none/light -> green), da Go/No-Go keine
 * Ampelfarbe für "Spur von Vereisung" kennt.
 */
export function ipiStatus(ipi) {
  if (!Number.isFinite(ipi) || ipi < IPI_MODERATE) return "green";
  if (ipi < IPI_SEVERE) return "yellow";
  return "red";
}

/**
 * Pro Gitterzelle (nt*nk) die Hazard-Kategorie für die GRAMET-Kontur.
 * `cloudFrac` kommt von `derive.js` (`d.cloudFrac`, dieselbe Größe wie
 * Wolkenbasis/Cb) statt hier neu berechnet zu werden.
 */
export function computeGrid(grid, cloudFrac) {
  const n = grid.times.length * grid.nk;
  const out = new Array(n);
  for (let ix = 0; ix < n; ix++) {
    const tC = grid.T[ix] - KELVIN;
    out[ix] = ipiCategory(ipiAt(tC, cloudFrac[ix]));
  }
  return out;
}
