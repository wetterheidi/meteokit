/**
 * Kinematische Frontogenese nach Petterssen (horizontal, ohne Vertikal-
 * bewegung und diabatische Terme): Änderung des Betrags des θw-Gradienten
 * durch das Windfeld der Analysefläche,
 *
 *   F = d|∇θ|/dt = −(1/|∇θ|) · [ θx² ux + θx θy (uy + vx) + θy² vy ]
 *
 * F > 0 Frontogenese (die Zone verschärft sich), F < 0 Frontolyse. Zerlegt
 * entspricht das ½|∇θ| (D cos 2β − δ) mit Deformation D, Divergenz δ und
 * Winkel β zwischen Dehnungsachse und Isentropen.
 *
 * Erwartet `frontFields` (θw `tau` und Wind `u`, `v` mit derselben Glättung)
 * und gibt F in K/(100 km · 3 h) zurück. Bisher nur Anzeige auf der
 * Debug-Seite (Idee der Projektleitung 12.10.: Frontenden, alternde Fronten,
 * Front vs. Luftmassengrenze).
 */

import { gradient } from "./grid.js";

/** (m/s)/(100 km) · 3 h -> dimensionslos: 1e-5 s⁻¹ · 10800 s. */
const PER_3H = 1e-5 * 10800;

export function frontogenesis(ff) {
  const { g, tau, u, v } = ff;
  const th = gradient(tau, g), du = gradient(u, g), dv = gradient(v, g);
  const n = g.nx * g.ny, out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const tx = th.gx[k], ty = th.gy[k], G = th.mag[k];
    out[k] = G > 1e-6
      ? (-(tx * tx * du.gx[k] + tx * ty * (du.gy[k] + dv.gx[k]) + ty * ty * dv.gy[k]) / G) * PER_3H
      : NaN;
  }
  return out;
}
