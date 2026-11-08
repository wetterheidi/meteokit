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

// Ersatz für ICONs subskaliges Wolkenwasser (Open-Meteo liefert nur das
// gitterskalige QC): qc = max(qc, a · q* · clc^b) mit
// q* = 5 g/kg · (qsat / 5 g/kg)^c. Empirisch per Gittersuche gegen die
// ICON-Sicht kalibriert (05.10.–07.11.2026 ohne 10.–12.10., trockene
// Stunden). c = 0,5 statt 1 beseitigt einen Fehler bei Frost (ICON dämpft
// bei Kälte stärker als qsat-proportional). Ein Satz für D2 und EU, s.
// docs/SICHTWEITE.md 1.5 und 1.7.
export const SUBGRID_FIT = Object.freeze({ a: 0.012, b: 2.0, c: 0.5 });

// Niederschlags-Ersatz, s. hydroFromSurfaceRates(). rainFactor 1 = reine
// Marshall-Palmer-Ableitung, gegen die ICON-Sicht bestätigt (keine
// Anpassung nötig, wenn als Rate das Minimum der Stundensummen vor und nach
// t verwendet wird, s. docs/SICHTWEITE.md 1.6). vSnow/vGraupel sind
// Platzhalter (typische Fallgeschwindigkeiten, Quelle noch zu belegen), bis
// Schneefälle im Archiv vorliegen.
export const PRECIP_FIT = Object.freeze({ rainFactor: 1.0, vSnow: 1.0, vGraupel: 2.0 });

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
 * Ersatz für die in Open-Meteo fehlenden Regen-/Schnee-/Graupelgehalte auf
 * Modellflächen: Massenkonzentration [g/m³] aus Bodenraten [mm/h,
 * Wasseräquivalent]. Nur gitterskaliger Niederschlag zählt, weil ICONs
 * qr/qs/qg nur ihn enthalten (konvektiver Niederschlag ist dort ein
 * diagnostischer Fluss ohne Gehalt in der Luft).
 *
 *  - Regen: Marshall-Palmer-Verteilung mit N₀ = 8·10⁶ m⁻⁴ (dieselbe Annahme
 *    wie ICONs Regen-Extinktion) und Λ = 4,1 mm⁻¹ · R^−0,21:
 *    W = π ρ_w N₀ / Λ⁴ = 0,089 · R^0,84. `rainFactor` skaliert das für die
 *    Kalibrierung.
 *  - Schnee, Graupel: C = Rate / (3,6 · v) mit einer mittleren
 *    Fallgeschwindigkeit v [m/s] (Massenfluss = Gehalt · Fallgeschwindigkeit).
 *    Defaults sind Platzhalter, bis Fälle im Archiv vorliegen, s.
 *    docs/SICHTWEITE.md.
 *
 * Als Rate empfohlen: min(Summe der Stunde vor t, Summe der Stunde nach t),
 * s. docs/SICHTWEITE.md 1.6.
 *
 * @param {{ rain?: number, snow?: number, graupel?: number }} rates mm/h
 * @param {{ rainFactor?: number, vSnow?: number, vGraupel?: number }} [opts]
 * @returns {{ Cr: number, Cs: number, Cg: number }} g/m³
 */
export function hydroFromSurfaceRates({ rain = 0, snow = 0, graupel = 0 } = {},
  { rainFactor = PRECIP_FIT.rainFactor, vSnow = PRECIP_FIT.vSnow, vGraupel = PRECIP_FIT.vGraupel } = {}) {
  const pos = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
  return {
    Cr: rainFactor * 0.089 * pos(rain) ** 0.84,
    Cs: pos(snow) / (3.6 * vSnow),
    Cg: pos(graupel) / (3.6 * vGraupel),
  };
}

/**
 * ICON-Sichtdiagnose für eine Säule.
 *
 * @param {object} col
 * @param {object[]} col.levels  Modellflächen von unten (k0 = unterste), je
 *   `{ z, p, T, qv, qc, qi, u, v, clc }`: z m über Grund, p Pa, T K, q in
 *   kg/kg, u/v m/s, clc Wolkenbedeckung 0–1 (nur mit `opts.subgrid`). Für
 *   Variante 3 bis über 540 m nötig, sonst mindestens 3.
 * @param {number} [col.cosZenith]  Kosinus des Sonnenzenitwinkels; ersatzweise
 *   aus `time` (ms), `lat`, `lon` berechnet.
 * @param {object} [col.hydro]  Massenkonzentrationen [g/m³] von Regen, Schnee,
 *   Graupel `{ Cr, Cs, Cg }` (Ersatz für fehlende qr/qs/qg); Default 0.
 * @param {object} [opts]
 * @param {1|2|3} [opts.variant=3]  `itune_vis_diag`
 * @param {{a: number, b: number, c?: number}} [opts.subgrid]  Ersatz für
 *   ICONs subskaliges Wolkenwasser, das Open-Meteo nicht liefert (nur das
 *   gitterskalige QC): je Fläche qc = max(qc, a · q* · clc^b),
 *   q* = 5 g/kg · (qsat / 5 g/kg)^c (ohne c: q* = qsat). Ohne Angabe wird
 *   qc unverändert verwendet. Kalibrierter Satz: `SUBGRID_FIT`.
 * @returns {{ vis: number, visRh: number, visHydro: number, limitedBy: string,
 *   rhmax: number, invfac: number, shearFac: number,
 *   beta: { c: number, i: number, r: number, s: number, g: number } }}
 *   Sichtweiten in m, β in 1/km.
 */
export function iconVisibility(col, { variant = 3, subgrid = null } = {}) {
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
    let qc = L[k].qc ?? 0;
    if (subgrid && L[k].clc > 0) {
      const qsat = (RDV * esatWater(L[k].T)) / L[k].p;
      // optionaler Exponent c auf qsat, bezogen auf 5 g/kg (c = 1: linear)
      const qs = subgrid.c == null ? qsat : 0.005 * (qsat / 0.005) ** subgrid.c;
      qc = Math.max(qc, subgrid.a * qs * L[k].clc ** subgrid.b);
    }
    Cc = Math.max(Cc, qc * rho * 1000);
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

// ---------------------------------------------------------------------------
// Anwendungsschicht: Sicht-Zeitreihe aus einer Modellflächen-Säule.
// ---------------------------------------------------------------------------

/** So viele unterste Modellflächen braucht die Diagnose: k950 (oberste Fläche
 *  unter 540 m) liegt über Bergen in ICON-D2 bei ≈ k11 (Brocken), daher 13. */
export const VIS_N_LEVELS = 13;

const VIS_LEVEL_API = [
  "height_agl", "pressure", "temperature", "specific_humidity",
  "cloud_water", "cloud_ice", "cloud_cover", "wind_u_component", "wind_v_component",
];

/**
 * Open-Meteo-Variablennamen (hourly) der untersten `VIS_N_LEVELS` Flächen
 * für `visibilitySeries()`, z. B. für Apps, die Modellflächen selbst abrufen
 * (IDSSEML). Dazu kommen die Oberflächenfelder `rain` und `snowfall`.
 * @param {number} nLevels Flächenzahl des Modells (D2 65, EU 74, Global 120)
 */
export function visibilityRequestVars(nLevels) {
  const vars = [];
  for (let k = 0; k < VIS_N_LEVELS; k++) {
    for (const v of VIS_LEVEL_API) vars.push(`${v}_level${nLevels - k}`);
  }
  return vars;
}

/**
 * Säule im Format von `fetchColumn()` (column.js) aus einer Open-Meteo-
 * Rohantwort (`data.hourly`), nur die untersten `VIS_N_LEVELS` Flächen.
 * Einheiten wie column.js: h m, u/v m/s, t °C, p hPa, q/qw/qi kg/kg, clc %.
 */
export function columnFromHourly(hourly, nLevels) {
  const arr = (name, f) => (hourly[name] ?? []).map((x) => (x == null ? NaN : x * f));
  const col = { time: hourly.time, h: [], u: [], v: [], t: [], p: [], q: [], qw: [], qi: [], clc: [] };
  for (let k = 0; k < VIS_N_LEVELS; k++) {
    const l = nLevels - k;
    col.h.push(arr(`height_agl_level${l}`, 1));
    col.u.push(arr(`wind_u_component_level${l}`, 1 / 3.6));
    col.v.push(arr(`wind_v_component_level${l}`, 1 / 3.6));
    col.t.push(arr(`temperature_level${l}`, 1));
    col.p.push(arr(`pressure_level${l}`, 1));
    col.q.push(arr(`specific_humidity_level${l}`, 1e-3));
    col.qw.push(arr(`cloud_water_level${l}`, 1e-3));
    col.qi.push(arr(`cloud_ice_level${l}`, 1e-3));
    col.clc.push(arr(`cloud_cover_level${l}`, 1));
  }
  return col;
}

/**
 * Sicht für eine Stunde mit den Standardeinstellungen der Anwendungsschicht:
 * Variante 3, Subgrid-Ersatz `SUBGRID_FIT`, Niederschlagsersatz aus
 * gitterskaligen Bodenraten. Gemeinsamer Kern von `visibilitySeries()` und
 * dem GRAMET-Gitter (gramet/grid.js).
 *
 * @param {object[]} levels  wie bei `iconVisibility()` (von unten, SI, clc 0–1)
 * @param {object} at  `{ time (ms), lat, lon }` oder `{ cosZenith }`, dazu
 *   `rain` und `snow` als Raten [mm/h Wasseräquivalent] zur Zeit t
 *   (empfohlen: min(Summe bis t, Summe ab t), s. docs/SICHTWEITE.md 1.6)
 * @returns {ReturnType<typeof iconVisibility> | null}  null, wenn die Flächen
 *   nicht bis über 540 m reichen
 */
export function diagnoseVisibility(levels, { time, lat, lon, cosZenith, rain = 0, snow = 0 } = {}) {
  try {
    return iconVisibility({
      levels, time, lat, lon, cosZenith,
      hydro: hydroFromSurfaceRates({ rain, snow }),
    }, { variant: 3, subgrid: SUBGRID_FIT });
  } catch {
    return null;
  }
}

/**
 * Sichtweite je Stunde nach ICON-Diagnose (Variante 3) mit den kalibrierten
 * Ersatzansätzen für subskaliges Wolkenwasser und Niederschlag
 * (docs/SICHTWEITE.md). Die Werte gelten für die Modell-Gitterzelle; die
 * Einschätzung des DWD-Flugwetterdienstes, dass ICON-Sichtfelder nicht für
 * VFR-Sichtvorhersagen geeignet sind, gilt für diese Nachbildung genauso.
 *
 * @param {object} col  Säule im Format von `fetchColumn()` oder
 *   `columnFromHourly()`: Flächen von unten, mindestens bis über 540 m.
 *   `col.time` als Unix-Sekunden oder ISO-Strings (UTC).
 * @param {object} [surface]  Oberflächenfelder, indexgleich zu `col.time`:
 *   `rain` (mm, Summe der Vorstunde, gitterskalig = Open-Meteo `rain`) und
 *   `snowfall` (cm, Open-Meteo `snowfall`). Fehlen sie, zählt kein
 *   Niederschlag.
 * @param {{ lat: number, lon: number }} pos  für den Sonnenstand
 * @returns {{ vis: number[], visRh: number[], visHydro: number[],
 *   limitedBy: (string|null)[] }}  Sicht in m, NaN wo Eingänge fehlen
 */
export function visibilitySeries(col, surface = {}, { lat, lon }) {
  const n = col.time.length;
  const nl = Math.min(col.t.length, VIS_N_LEVELS);
  const out = { vis: [], visRh: [], visHydro: [], limitedBy: [] };
  const rain = surface.rain ?? [];
  const snow = surface.snowfall ?? [];
  // Rate zur Zeit i: Minimum der Stundensumme bis i und ab i (= Summe bei i+1)
  const rateAt = (a, i, f = 1) => {
    const x = a[i], y = a[i + 1];
    if (!Number.isFinite(x)) return 0;
    return (Number.isFinite(y) ? Math.min(x, y) : x) * f;
  };
  for (let i = 0; i < n; i++) {
    const levels = [];
    let ok = true;
    for (let k = 0; k < nl; k++) {
      const lv = {
        z: col.h[k][i], p: col.p[k][i] * 100, T: col.t[k][i] + 273.15,
        qv: col.q[k][i], qc: col.qw?.[k]?.[i] ?? 0, qi: col.qi?.[k]?.[i] ?? 0,
        u: col.u[k][i], v: col.v[k][i], clc: (col.clc?.[k]?.[i] ?? 0) / 100,
      };
      if (![lv.z, lv.p, lv.T, lv.qv, lv.u, lv.v].every(Number.isFinite)) { ok = false; break; }
      if (!Number.isFinite(lv.qc)) lv.qc = 0;
      if (!Number.isFinite(lv.qi)) lv.qi = 0;
      if (!Number.isFinite(lv.clc)) lv.clc = 0;
      levels.push(lv);
    }
    const ti = col.time[i];
    const r = ok ? diagnoseVisibility(levels, {
      // Zeit als Unix-Sekunden (timeformat=unixtime, wie in meteokit) oder
      // ISO-String (Open-Meteo-Default, UTC ohne Zonenangabe)
      time: typeof ti === "number" ? ti * 1000
        : Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(ti) ? ti : `${ti}Z`),
      lat, lon, rain: rateAt(rain, i), snow: rateAt(snow, i, 1 / 0.7),
    }) : null;
    out.vis.push(r ? r.vis : NaN);
    out.visRh.push(r ? r.visRh : NaN);
    out.visHydro.push(r ? r.visHydro : NaN);
    out.limitedBy.push(r ? r.limitedBy : null);
  }
  return out;
}
