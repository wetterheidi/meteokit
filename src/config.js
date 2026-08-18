/**
 * Datenquellen-Konfiguration der Bibliothek (`meteokit/config`).
 *
 * Die Defaults unten sind sofort einsatzfähig (Michaels Open-Meteo-Instanzen
 * für Modelllevel, die öffentliche Instanz für Oberflächenfelder) -- eine App,
 * die nichts konfiguriert, verhält sich exakt wie droneforecast bisher.
 *
 * ZWEI GETRENNTE QUELLEN, das ist fachlich zwingend:
 *
 *  - MODELLLEVEL (`MODELS[].apiBase`, genutzt von `column.js`/`fetchColumn`
 *    und damit von der gesamten GRAMET-Kette): braucht eine Instanz, die die
 *    nativen ICON-Level als `wind_u_component_level{N}`, `height_agl_level{N}`
 *    usw. ausliefert. Die öffentliche api.open-meteo.com kann das NICHT --
 *    sie kennt nur Oberflächen- und Druckflächen-Variablen.
 *  - OBERFLÄCHE (`SURFACE_API_BASE`, genutzt von `weather.js`/`fetchSurface`):
 *    läuft gegen die öffentliche, gemeterte Instanz. Bewusst getrennt, um
 *    Quellen im selben Datensatz nicht zu vermischen.
 *
 * Anpassen über `configure()` -- EINMALIG beim App-Start, vor dem ersten
 * Datenabruf:
 *
 *     import { configure, MODELS } from "meteokit/config";
 *     configure({ surfaceApiBase: "https://api.open-meteo.com" });
 */

// Modell-Level-Daten (u/v/T/RH/… auf nativen ICON-Leveln): Michaels Instanz.
export const API_BASE = "https://open-meteo.mah.priv.at";
// ICON Global (Modelllevel) läuft seit 2026-08 auf einem eigenen Server
// (Absprache mit Michael): die dwd_icon-Ingestion auf API_BASE ist kaputt
// (meta.json liefert 500, Modelllevel-Felder kommen durchgehend null zurück).
// ICON-D2/ICON-EU bleiben unverändert auf API_BASE. Siehe MODELS.icon_global
// unten sowie dasselbe Vorgehen im TLogPViewer (fetch_sounding_openmeteo.py).
export const API_BASE_ICON_GLOBAL = "https://open-meteo-temp.mah.priv.at";

// Oberflächen-/Single-Level-Felder (Niederschlag, Böen, CAPE, Bewölkung, …):
// `weather.js` (fetchSurface, Basis des "Jetzt"-Blocks/Meteogramms) holt
// aktuell PAUSCHAL ALLES von hier, der öffentlichen, gemeterten Instanz —
// trotz gleichem ICON-Modell nicht Michaels Instanz, um Vermischung von
// Quellen im selben Datensatz zu vermeiden (siehe SURFACE_CORE/-OPTIONAL).
// Michaels Instanz (Downloadgruppe "heidiVars", API_BASE) liefert per
// Stichprobe (2026-08) tatsächlich mit echten Werten: temperature_2m,
// relative_humidity_2m, dew_point_2m, precipitation, weather_code,
// wind_gusts_10m, visibility, cape, snowfall. Als NULL (nicht Teil der
// Downloadgruppe): cloud_cover*, wind_speed_10m, wind_direction_10m,
// precipitation_probability, freezing_level_height — für diese bleibt die
// öffentliche Instanz ohnehin nötig. gustoverlay.js nutzt diesen Split
// bereits gezielt für wind_gusts_10m (primär API_BASE, Fallback hierher).
//
// `let` statt `const`, damit `configure({ surfaceApiBase })` es umhängen kann;
// ES-Modul-Live-Bindings sorgen dafür, dass importierende Module den neuen
// Wert sehen. Deshalb den Wert NICHT beim Modulstart in eine eigene Konstante
// kopieren, sondern erst beim Abruf lesen (so macht es `weather.js`).
export let SURFACE_API_BASE = "https://api.open-meteo.com";

// Levelzählung der API: N=1 oberstes, N=nLevels unterstes Modelllevel (~10 m AGL).
// `apiBase` je Modell (statt eines globalen API_BASE), weil ICON Global auf
// einem anderen Server liegt als ICON-D2/ICON-EU (s. API_BASE_ICON_GLOBAL).
//
// Bewusst ein `const`-Objekt, dessen INHALT `configure({ models })` ersetzt --
// so bleiben bestehende `import { MODELS }` gültig, ohne dass jede Lesestelle
// auf einen Getter umgestellt werden muss.
export const MODELS = {
  icon_d2: {
    apiModel: "icon_d2",
    dataset: "dwd_icon_d2",
    label: "ICON-D2 (~2,2 km, Mitteleuropa)",
    apiBase: API_BASE,
    grid: 0.02,
    gridMeters: 2200,
    nLevels: 65,
    bbox: { latMin: 43.18, latMax: 58.08, lonMin: -3.94, lonMax: 20.34 },
  },
  icon_eu: {
    apiModel: "icon_eu",
    dataset: "dwd_icon_eu",
    label: "ICON-EU (~6,5 km, Europa)",
    apiBase: API_BASE,
    grid: 0.0625,
    gridMeters: 6500,
    nLevels: 74,
    bbox: { latMin: 29.5, latMax: 70.5, lonMin: -23.5, lonMax: 62.5 },
  },
  // Grid per Stichprobe ermittelt (nearest-neighbor-Sprünge alle 0,125° in
  // lat/lon, ausgerichtet auf Vielfache von 0,125 ab 0) — Open-Meteo regridded
  // das native icosahedrische ICON-Global-Gitter (~13 km) auf dieses reguläre
  // 0,125°-Raster. bbox global, da kein Ausschnitt wie bei D2/EU.
  icon_global: {
    apiModel: "icon_global",
    dataset: "dwd_icon",
    label: "ICON (~13 km, global)",
    apiBase: API_BASE_ICON_GLOBAL,
    grid: 0.125,
    gridMeters: 13915,
    nLevels: 120,
    bbox: { latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 },
  },
};

// Oberflächen-/Standardvariablen (stündlich) für die limitierenden Faktoren.
// Kern = überall vorhanden; optional = je nach Modell ggf. nicht verfügbar,
// wird bei Fehler automatisch weggelassen (siehe weather.js).
export let SURFACE_CORE = [
  "temperature_2m",
  "relative_humidity_2m",
  "dew_point_2m",
  "precipitation",
  "weather_code",
  "cloud_cover",
  "cloud_cover_low",
  "cloud_cover_mid",
  "cloud_cover_high",
  "wind_speed_10m",
  "wind_gusts_10m",
  "wind_direction_10m",
];
export let SURFACE_OPTIONAL = [
  "precipitation_probability",
  "visibility",
  "cape",
  "freezing_level_height",
  "snowfall", // Niederschlagsphase im GRAMET-Meteogramm (meteokit/gramet)
];

/**
 * Datenquellen der Bibliothek anpassen. Einmalig beim App-Start aufrufen,
 * VOR dem ersten Datenabruf -- laufende Fetches ziehen nicht nach.
 *
 * @param {object}  [opts]
 * @param {object}  [opts.models]           Ersetzt den Modellkatalog KOMPLETT
 *   (nicht zusammengeführt -- wer nur ein Modell ändern will, baut sich das
 *   neue Objekt aus dem bestehenden `MODELS` zusammen). Jeder Eintrag braucht
 *   mindestens `apiModel`, `apiBase`, `nLevels`, `grid`, `bbox`.
 * @param {string}  [opts.surfaceApiBase]   Instanz für die Oberflächenfelder.
 * @param {string[]} [opts.surfaceCore]     Immer angefragte Oberflächenvariablen.
 * @param {string[]} [opts.surfaceOptional] Variablen, die bei Fehler entfallen dürfen.
 */
export function configure({ models, surfaceApiBase, surfaceCore, surfaceOptional } = {}) {
  if (models) {
    for (const key of Object.keys(MODELS)) delete MODELS[key];
    Object.assign(MODELS, models);
  }
  if (surfaceApiBase) SURFACE_API_BASE = surfaceApiBase;
  if (surfaceCore) SURFACE_CORE = [...surfaceCore];
  if (surfaceOptional) SURFACE_OPTIONAL = [...surfaceOptional];
}

/**
 * Modelldefinition zu einem Schlüssel -- mit der Fehlerprüfung, die zuvor in
 * `column.js`, `weather.js` und `gramet/path.js` je einmal ausgeschrieben war.
 */
export function getModel(key) {
  const model = MODELS[key];
  if (!model) throw new Error(`Unbekanntes Modell: ${key}`);
  return model;
}
