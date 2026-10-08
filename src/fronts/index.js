/**
 * Objektive Frontenanalyse (`meteokit/fronts`) -- im Aufbau.
 *
 * Stand: Feldabruf auf einer Druckfläche aus Modellleveln, θe/θw und
 * Gitterwerkzeuge. Detektion (TFP nach Hewson 1998) und Klassifikation folgen.
 */

export { fetchPlaneField } from "./field.js";
export { thetaE, thetaWFromThetaE, thetaFields, esHpa } from "./thermo.js";
export { gaussianSmooth, gradient, isolineSegments } from "./grid.js";
