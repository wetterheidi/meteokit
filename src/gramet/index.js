/**
 * Öffentliche Oberfläche des GRAMET-Datenteils (`meteokit/gramet`).
 *
 * Alles, was hier nicht re-exportiert wird, ist bibliotheksintern und darf
 * sich ohne Rücksicht auf einbettende Apps ändern -- insbesondere
 * `derive.js`, `render.js`, `texture.js`, `terrain.js` und `hazards/*`
 * (deren `computeGrid`-Funktionen). Das Zeichnen übernimmt die Web Component
 * `meteokit/components/gramet-panel`, nicht die Host-App.
 *
 * Punktmodus (droneforecast): `gridFromColumn()` aus einer Säule von
 * `meteokit/column`. Path-Modus (trajectories): `fetchGridForPath()` holt die
 * Säulen entlang der Wegpunkte selbst.
 */

export { fetchGrid, gridFromColumn, gridFromWaypoints, idx, sampleAt, derive } from "./grid.js";
export { fetchGridForPath, posOfPath } from "./path.js";
