/**
 * Objektive Frontenanalyse (`meteokit/fronts`) -- im Aufbau.
 *
 * Stand: Feldabruf auf einer Druckfläche aus Modellleveln, θe/θw,
 * Gitterwerkzeuge, TFP-Detektion mit Klassifikation (kalt/warm/stationär).
 * Wetter-/Dynamikkriterium und Okklusionen folgen.
 */

export { fetchPlaneField, fieldAt, DEFAULT_SURFACE } from "./field.js";
export { thetaE, thetaWFromThetaE, thetaFields, esHpa } from "./thermo.js";
export { gaussianSmooth, gradient, isolineSegments, chainSegments, sampleBilinear, lineLengthKm, distKm } from "./grid.js";
export { detectFronts, frontFields, DETECT_DEFAULTS } from "./detect.js";
