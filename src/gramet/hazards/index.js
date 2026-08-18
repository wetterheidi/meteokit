/**
 * Öffentliche Oberfläche der Gefahren-Indizes (`meteokit/gramet/hazards`).
 *
 * Punktweise Auswertung + Kategorisierung für Icing (IPI) und Turbulenz
 * (TFI) -- das nutzt droneforecast in `app.js` für die limitierenden
 * Faktoren, unabhängig vom GRAMET-Chart.
 *
 * Bewusst NICHT hier: die `computeGrid()`-Funktionen beider Module (gleicher
 * Name, kollidieren; sie sind Teil der internen Renderkette) sowie
 * `convection.js`/`fog.js`, die nur `derive.js` intern braucht.
 */

export { ipiAt, ipiCategory, ipiCategoryFloor, ipiStatus } from "./icing.js";
export { tfiAt, tfiCategory, tfiCategoryFloor, tfiStatus } from "./turbulence.js";
