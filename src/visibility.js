/**
 * Sichtweitendiagnose nach ICON (`compute_field_visibility` in
 * `src/atm_phy_nwp/mo_opt_nwp_diagnostics.f90`, Release icon-2026.10).
 * Herleitung, Quellen und Abweichungen: docs/SICHTWEITE.md.
 *
 * Die Funktion rechnet die Routine möglichst wörtlich nach. Was Open-Meteo
 * nicht liefert (Regen, Schnee, Graupel auf Modellflächen), wird als
 * Massenkonzentration von außen übergeben; ohne Angabe zählt es als null.
 */

import { sunAltitude } from "./astro.js";

// Konstanten wie in ICON (src/physics_granules/common/mo_granules_phys.f90)
const RD = 287.04;          // J/(kg K)
const RV = 461.51;          // J/(kg K)
const CPD = 1004.64;        // J/(kg K)
const TMELT = 273.15;       // K
const C1ES = 610.78;        // Pa   — Tetens über Wasser
const C3LES = 17.269;
const C4LES = 35.86;        // K
const RDV = RD / RV;
const O_M_RDV = 1 - RDV;
const VTMPC1 = RV / RD - 1;
const RD_O_CPD = RD / CPD;
const P0REF = 100000;       // Pa
const H950_STANDARD = 540.3130233; // m über Grund (mo_nwp_phy_init.f90)

// Extinktion β [1/km] = a · C^b, C in g/m³ (Werte aus dem Code, nicht aus
// dem veralteten Kommentarblock dort)
const A_C = 144.7, B_C = 0.88;   // Wolkenwasser
const A_I = 327.8, B_I = 1.0;    // Wolkeneis
const A_R = 2.24, B_R = 0.75;    // Regen
const A_S_WET = 6.0, A_S_DRY = 10.0, B_S = 1.0; // Schnee
const A_G = 4.0, B_G = 0.75;     // Graupel

const TOP_LEV = 3;          // Hydrometeore: Maximum über die untersten 3 Flächen
const VISRH_CLIP_KM = 1.0;  // Untergrenze Feuchteterm
const VIS_MAX_KM = 90.0;
const KOSCHMIEDER = -Math.log(0.02); // 2 % Kontrastschwelle

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Sättigungsdampfdruck über Wasser [Pa], T in K (ICON `esat_water`). */
export function esatWater(T) {
  return T > C4LES + 1e-6 ? C1ES * Math.exp((C3LES * (T - TMELT)) / (T - C4LES)) : 0;
}

/** RH [%] wie ICON: aus p [Pa], qv [kg/kg], T [K], auf 100 % begrenzt. */
export function rhIcon(p, qv, T) {
  const pv = (p * qv) / (RDV + O_M_RDV * qv);
  return 100 * Math.min(1, pv / esatWater(T));
}

function virtualTemp(lv) {
  return lv.T * (1 + VTMPC1 * lv.qv - (lv.qc ?? 0) - (lv.qi ?? 0));
}

function thetaV(lv) {
  return virtualTemp(lv) * Math.pow(P0REF / lv.p, RD_O_CPD);
}

/** Luftdichte [kg/m³] aus p, T, qv (und Kondensat-Last). */
function density(lv) {
  return lv.p / (RD * virtualTemp(lv));
}

/** Feuchteterm [km] Variante 1/2: SYNOP-Fit Deutschland 11/2021, RH in %. */
function visRhSynopFit(rh) {
  let v;
  if (rh <= 40) v = 88950.37269485 - 327.73380915 * rh;
  else if (rh <= 98.2) {
    v = 2.74158753e-4 * rh ** 5 - 8.04508715e-2 * rh ** 4 + 9.4148139 * rh ** 3
      - 5.78127237e2 * rh ** 2 + 1.82682914e4 * rh - 1.54588988e5;
  } else v = -1171.04931497 * rh + 117111.72541055;
  return v / 1000;
}

/**
 * ICON-Sichtdiagnose für eine Säule.
 *
 * @param {object} col
 * @param {object[]} col.levels  Modellflächen von unten (k0 = unterste), je
 *   `{ z, p, T, qv, qc, qi, u, v }`: z m über Grund, p Pa, T K, q in kg/kg,
 *   u/v m/s. Für Variante 3 bis über 540 m nötig, sonst mindestens 3.
 * @param {number} [col.cosZenith]  Kosinus des Sonnenzenitwinkels; ersatzweise
 *   aus `time` (ms), `lat`, `lon` berechnet.
 * @param {object} [col.hydro]  Massenkonzentrationen [g/m³] von Regen, Schnee,
 *   Graupel `{ Cr, Cs, Cg }` (Ersatz für fehlende qr/qs/qg); Default 0.
 * @param {object} [opts]
 * @param {1|2|3} [opts.variant=3]  `itune_vis_diag`
 * @returns {{ vis: number, visRh: number, visHydro: number, limitedBy: string,
 *   rhmax: number, invfac: number, shearFac: number,
 *   beta: { c: number, i: number, r: number, s: number, g: number } }}
 *   Sichtweiten in m, β in 1/km.
 */
export function iconVisibility(col, { variant = 3 } = {}) {
  const L = col.levels;
  if (!L || L.length < TOP_LEV) throw new Error("mindestens 3 Modellflächen nötig");

  // I) Feuchteterm
  const rhmax = Math.max(rhIcon(L[0].p, L[0].qv, L[0].T), rhIcon(L[1].p, L[1].qv, L[1].T));
  let visrh, invfac = 1;
  if (variant === 3) {
    // k950: oberste Fläche unter 540 m über Grund
    let k950 = -1;
    for (let k = 0; k < L.length; k++) if (L[k].z < H950_STANDARD) k950 = k;
    if (k950 < 0 || k950 === L.length - 1) {
      throw new Error("Variante 3 braucht Flächen bis über 540 m über Grund");
    }
    invfac = 5 / Math.max(5, thetaV(L[k950]) - thetaV(L[2]));
    const r = rhmax / 100;
    visrh = (90 - 257.44 * r + 471.29 * r ** 2 - 301.85 * r ** 3) * invfac;
  } else {
    visrh = visRhSynopFit(rhmax);
  }
  visrh = Math.max(visrh, VISRH_CLIP_KM);

  const shear = Math.hypot(L[2].u - L[0].u, L[2].v - L[0].v);
  const shearFac = clamp((shear - 4) / 2, 0, 1);
  if (visrh < 10) visrh += (10 - visrh) * shearFac;

  // II) Hydrometeore
  let Cc = 0, Ci = 0;
  for (let k = 0; k < TOP_LEV; k++) {
    const rho = density(L[k]);
    Cc = Math.max(Cc, (L[k].qc ?? 0) * rho * 1000);
    Ci = Math.max(Ci, (L[k].qi ?? 0) * rho * 1000);
  }
  const { Cr = 0, Cs = 0, Cg = 0 } = col.hydro ?? {};
  const tempFac = clamp(L[0].T - 271.15, 0, 1);
  const aS = A_S_DRY * (1 - tempFac) + A_S_WET * tempFac;
  const beta = {
    c: A_C * Cc ** B_C,
    i: A_I * Ci ** B_I,
    r: A_R * Cr ** B_R,
    s: aS * Cs ** B_S,
    g: A_G * Cg ** B_G,
  };
  const betaSum = beta.c + beta.i + beta.r + beta.s + beta.g + 1e-10;
  let vis = Math.min(VIS_MAX_KM, KOSCHMIEDER / betaSum);

  // Tag/Nacht
  let czen = col.cosZenith;
  if (czen == null) czen = Math.sin((sunAltitude(col.time, col.lat, col.lon) * Math.PI) / 180);
  const visNight = variant === 1
    ? 1.69 * (vis / 1.609) ** 0.86 * 1.609
    : vis * clamp((vis / 0.05) ** 0.25, 1.25, 2.25);
  const zenFac = clamp(czen, 0, 0.1) / 0.1;
  vis = zenFac * vis + (1 - zenFac) * visNight;

  return {
    vis: Math.min(vis, visrh) * 1000,
    visRh: visrh * 1000,
    visHydro: vis * 1000,
    limitedBy: vis < visrh ? "hydro" : "rh",
    rhmax, invfac, shearFac, beta,
  };
}
