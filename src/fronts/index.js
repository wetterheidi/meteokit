/**
 * Objektive Frontenanalyse (`meteokit/fronts`) -- im Aufbau.
 *
 * Stand: Feldabruf auf einer Druckfläche aus Modellleveln, θe/θw,
 * Gitterwerkzeuge, TFP-Detektion mit Klassifikation (kalt/warm/stationär).
 * Wetter-/Dynamikkriterium (activity.js) und Okklusionen (occlusion.js).
 */

export { fetchPlaneField, fieldAt, mergeFields, DEFAULT_SURFACE } from "./field.js";
export { thetaE, thetaWFromThetaE, thetaFields, esHpa } from "./thermo.js";
export { gaussianSmooth, gradient, isolineSegments, chainSegments, sampleBilinear, lineLengthKm, distKm } from "./grid.js";
export { detectFronts, frontFields, DETECT_DEFAULTS } from "./detect.js";
export { activityFields, assessPoints, activityClass, ACTIVITY_DEFAULTS } from "./activity.js";
export { findLows, markCentralLows, markOcclusions, ridgeLines, OCCLUSION_DEFAULTS } from "./occlusion.js";
export { closeGaps, smoothFeatures, smoothPolyline, requireLowLink, dropDuplicates, junctionToCore, POSTPROCESS_DEFAULTS } from "./postprocess.js";
export { precipFronts, PRECIP_FRONT_DEFAULTS } from "./precipfronts.js";
export { stauFronts, STAU_DEFAULTS } from "./staufronts.js";
export { frontogenesis } from "./frontogenesis.js";
