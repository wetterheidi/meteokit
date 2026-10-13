/**
 * Kartenanzeige der Frontenanalyse (`meteokit/fronts/map`) -- im Aufbau,
 * gemeinsame Grundlage von Debug-Seite (tools/fronts/debug.html) und
 * synoptix-App. Leaflet wird als Parameter übergeben.
 *
 * - scales.js: Farbskalen der Schattierung, Legende
 * - derive.js: abgeleitete Felder (ohne DOM)
 * - layers.js: Leaflet-Ebenen (Schattierung, Isolinien, Isobaren, Wind, Fronten, Tiefs)
 * - editor.js: Handanalyse (Fronten zeichnen und bearbeiten)
 */

export { SCALES, colorAt, paintScale, scaleTicks } from "./scales.js";
export { gridOf, prevField, thermoDerived, caseDerived, geopotentialLevel, spread, kinkLines, meanAlong } from "./derive.js";
export {
  fieldOverlay, isolineLayer, isobarLayer, windArrows, addFront, addAutoFronts, addLows,
  frontTooltip, featureLatLngs, RED, BLUE, PURPLE,
} from "./layers.js";
export { createFrontEditor, spline, decimate, lineProps, lineFeatures, linesFromGeoJSON, flipSide } from "./editor.js";
