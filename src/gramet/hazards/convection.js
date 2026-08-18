/**
 * Konvektions-Diagnose für die Cb-/TCU-Spalten des GRAMET — Parcel-Theorie auf
 * dem Zeit-Höhen-Gitter (`grid.js`), pro Stunde eine eigene Rechnung.
 *
 * Schwerpunkt CCL (statt LCL): das GRAMET zeigt tagsüber ausgelöste Konvektion,
 * und dafür sind CCL/Auslösetemperatur die passenden Größen —
 *   - CCL  = Schnittpunkt der Mixed-Layer-Isohume (druckgewichtetes Mittel der
 *            untersten 100 hPa, s. `mixedLayerMixingRatio`) mit dem
 *            Umgebungsprofil → physikalische Basis der Quellwolke. Der reine
 *            2-m-Taupunkt allein wäre zu stoßempfindlich: reichert sich die
 *            bodennahste Luft (z. B. nächtlich durch Taubildung) stärker an
 *            als die Schicht knapp darüber, zieht er die CCL künstlich weit
 *            nach unten (s. Feedback: Cb-Basis bei 50 m trotz tlogp-CCL,
 *            das mit derselben Mixed-Layer-Mittelung rechnet, > 600 m).
 *   - TA   = CCL-Temperatur trockenadiabatisch auf Bodenniveau zurückgeführt
 *            → Auslösetemperatur; erst wenn T_2m >= TA reißt die Kappe auf.
 *            Das ersetzt den bisherigen festen CAPE-Schwellwert, weil es die
 *            tatsächliche Sperrschicht aus dem Profil auswertet.
 *   - EL   = Gleichgewichtsniveau: ab CCL feuchtadiabatisch aufwärts, bis der
 *            (virtuell korrigierte) Auftrieb wieder negativ wird → Obergrenze.
 *
 * Die Thermodynamik ist aus `sounding_data/sounding_viewer.html` (MET-Objekt)
 * portiert: Magnus/Mixed-Phase-Sättigungsdampfdruck, RK4-Pseudoadiabate,
 * Auftriebsintegration mit virtueller Temperaturkorrektur (Doswell & Rasmussen
 * 1994). Bewusst als eigener, geschlossener Satz statt über `clouds.js`
 * `esatWater()`: dort stehen leicht andere Magnus-Koeffizienten (17.62/243.12
 * vs. 17.67/243.5), und die portierte Pseudoadiabate ist auf ihren eigenen
 * Koeffizientensatz abgestimmt — Mischen würde die Isohume gegen die
 * Feuchtadiabate verstimmen.
 *
 * Einheiten hier wie in der Quelle: hPa/°C an der Schnittstelle der
 * Thermo-Funktionen, K nur intern; Höhen m AGL wie im übrigen GRAMET.
 */

const KELVIN = 273.15;
const RD = 287.05, CP = 1004.0, G = 9.80665, EPS = 0.622;
const KAPPA = RD / CP;

// Schrittweite der Feuchtadiabate — 5 hPa reichen für RK4 (s. Quelle).
const DP_STEP_HPA = 5;
// Harte Abbruchgrenze der Aufstiegssuche; normalerweise bricht schon der
// Gitterdeckel ab (envSampler liefert dort null).
const P_TOP_HPA = 120;

// --- Thermodynamik (portiert, s. Modulkopf) ----------------------------------

/** Sättigungsdampfdruck über Wasser (Pa), Magnus. */
function esWater(tC) { return 611.2 * Math.exp((17.67 * tC) / (tC + 243.5)); }
/** Sättigungsdampfdruck über Eis (Pa), Murray 1967. */
function esIce(tC) { return 611.2 * Math.exp((21.87 * tC) / (tC + 265.5)); }
/** Mixed-Phase: > 0 °C Wasser, < −40 °C Eis, dazwischen linear (WMO). */
function esMixed(tC) {
  if (tC >= 0) return esWater(tC);
  if (tC <= -40) return esIce(tC);
  const f = -tC / 40;
  return (1 - f) * esWater(tC) + f * esIce(tC);
}

/** Sättigungs-Mischungsverhältnis (kg/kg). Immer über Wasser — der Taupunkt
 *  ist so definiert, und die Isohume muss dazu passen (s. Quelle). */
function mixingRatio(tC, pHpa) {
  const e = esWater(tC);
  return (EPS * e) / Math.max(pHpa * 100 - e, 1);
}

/** Umkehrung: Temperatur (°C), bei der `w` auf `pHpa` gerade gesättigt ist —
 *  das ist die Isohume, entlang derer der CCL gesucht wird. */
function tempFromMixingRatio(w, pHpa) {
  const e = (w * pHpa * 100) / (w + EPS);
  const L = Math.log(Math.max(e / 611.2, 1e-10));
  return (243.5 * L) / (17.67 - L);
}

/** Trockenadiabate: Temperatur (K) von (t0K, p0) nach p. */
function dryAdiabatT(t0K, p0Hpa, pHpa) { return t0K * Math.pow(pHpa / p0Hpa, KAPPA); }

/** dT/dp (K/Pa) entlang der Pseudoadiabate. */
function moistDTdp(tK, pHpa) {
  const tC = tK - KELVIN;
  // Tetens/Magnus nur bis −80 °C belastbar; darunter geht r_s → 0 und die
  // Feuchtadiabate konvergiert ohnehin gegen die Trockenadiabate.
  const esHpa = esMixed(Math.max(tC, -80)) / 100;
  const rs = (EPS * esHpa) / Math.max(pHpa - esHpa, 0.01);
  const lvWater = 2500800 - 2360 * tC;
  const lvIce = 2834000 - 340 * tC;
  const lv = tC >= 0 ? lvWater
    : tC <= -40 ? lvIce
      : (1 + tC / 40) * lvWater + (-tC / 40) * lvIce;
  const pPa = pHpa * 100;
  const num = RD * tK + lv * rs;
  const den = pPa * CP + (pPa * lv * lv * rs * EPS) / (RD * tK * tK);
  return num / den;
}

/** Ein RK4-Schritt der Pseudoadiabate um `dpHpa` (negativ = aufwärts).
 *  Anders als in der Quelle wird schrittweise marschiert statt je Zielniveau
 *  neu integriert — bei ~120 Stunden × ~30 Levels wäre das Neustarten sonst
 *  quadratisch, das Ergebnis ist bei gleicher Schrittweite identisch. */
function moistStep(t0K, p0Hpa, dpHpa) {
  const dpPa = dpHpa * 100;
  const k1 = moistDTdp(t0K, p0Hpa) * dpPa;
  const k2 = moistDTdp(t0K + k1 / 2, p0Hpa + dpHpa / 2) * dpPa;
  const k3 = moistDTdp(t0K + k2 / 2, p0Hpa + dpHpa / 2) * dpPa;
  const k4 = moistDTdp(t0K + k3, p0Hpa + dpHpa) * dpPa;
  return t0K + (k1 + 2 * k2 + 2 * k3 + k4) / 6;
}

/** Spezifische Feuchte (kg/kg) → Mischungsverhältnis (kg/kg). */
function qToMixingRatio(q) {
  return Number.isFinite(q) && q > 0 ? q / Math.max(1 - q, 1e-6) : 0;
}

// --- Profil-Zugriff ----------------------------------------------------------

/**
 * Bodenzustand für die Parcel-Rechnung. Bevorzugt die 2-m-Werte als Anker der
 * Mixed-Layer-Mittelung (s. `mixedLayerMixingRatio`), Druck kommt vom
 * untersten Modelllevel (~10 m AGL) — die Höhendifferenz ist gegenüber der
 * Schrittweite der CCL-Suche vernachlässigbar. Fehlen die 2-m-Werte, tritt
 * das unterste Level als Ganzes an ihre Stelle.
 */
function surfaceState(grid, i) {
  const { nk, surface } = grid;
  const ix = i * nk;
  const pSfc = grid.p[ix] / 100;
  if (!Number.isFinite(pSfc)) return null;

  const tC = surface?.t2m?.[i], tdC = surface?.td2m?.[i];
  if (Number.isFinite(tC) && Number.isFinite(tdC)) {
    // Übersättigung (Td > T) käme nur aus Rundung — auf T kappen.
    const w0 = mixingRatio(Math.min(tdC, tC), pSfc);
    return { w: mixedLayerMixingRatio(grid, i, pSfc, w0), pSfc, tSfcC: tC };
  }
  const tLevC = grid.T[ix] - KELVIN;
  const w0 = qToMixingRatio(grid.qv[ix]);
  if (!Number.isFinite(tLevC) || w0 <= 0) return null;
  return { w: mixedLayerMixingRatio(grid, i, pSfc, w0), pSfc, tSfcC: tLevC };
}

/**
 * Druckgewichtetes Mischungsverhältnis der untersten 100 hPa ("Mixed Layer"),
 * portiert aus `sounding_data/sounding_viewer.html` (dortige CCL-Berechnung).
 * Trapezintegration ab dem 2-m-Punkt (`w0` bei `pSfc`) über die Modelllevel
 * ab k=1 aufwärts — k=0 liegt konstruktionsbedingt praktisch auf `pSfc`
 * (s. `surfaceState`) und würde ohne eigenen Druckabstand nur Rauschen
 * beitragen. Das letzte Intervall wird am 100-hPa-Boden `pFloor` gekappt.
 */
function mixedLayerMixingRatio(grid, i, pSfc, w0) {
  const { nk } = grid;
  const pFloor = pSfc - 100;
  let pPrev = pSfc, wPrev = w0, sumWdp = 0, sumDp = 0;
  for (let k = 1; k < nk; k++) {
    const ix = i * nk + k;
    const pHpa = grid.p[ix] / 100;
    if (!Number.isFinite(pHpa) || pHpa >= pPrev) continue; // kein Fortschritt/ungültig
    const w = qToMixingRatio(grid.qv[ix]);
    const pClip = Math.max(pHpa, pFloor);
    const dp = pPrev - pClip;
    if (dp > 0) {
      sumWdp += ((wPrev + w) / 2) * dp;
      sumDp += dp;
    }
    pPrev = pHpa; wPrev = w;
    if (pHpa <= pFloor) break;
  }
  return sumDp > 0 ? sumWdp / sumDp : w0;
}

/** Umgebungsprofil (T, z, Mischungsverhältnis) an beliebigem Druck, linear
 *  zwischen den Modelllevels. `null` oberhalb des Gitterdeckels. */
function envSampler(grid, i) {
  const { nk } = grid;
  const p = [], t = [], z = [], w = [];
  for (let k = 0; k < nk; k++) {
    const ix = i * nk + k;
    const pv = grid.p[ix] / 100;
    if (!Number.isFinite(pv) || !Number.isFinite(grid.T[ix]) || !Number.isFinite(grid.z[ix])) continue;
    p.push(pv); t.push(grid.T[ix]); z.push(grid.z[ix]); w.push(qToMixingRatio(grid.qv[ix]));
  }
  if (p.length < 2) return null;
  const last = p.length - 1;
  return (pq) => {
    if (pq >= p[0]) return { tK: t[0], z: z[0], w: w[0] };
    if (pq <= p[last]) return null;
    for (let k = 1; k <= last; k++) {
      if (p[k] <= pq) {
        const f = (pq - p[k - 1]) / (p[k] - p[k - 1]);
        return {
          tK: t[k - 1] + f * (t[k] - t[k - 1]),
          z: z[k - 1] + f * (z[k] - z[k - 1]),
          w: w[k - 1] + f * (w[k] - w[k - 1]),
        };
      }
    }
    return null;
  };
}

// --- CCL / TA / EL -----------------------------------------------------------

/**
 * CCL: erstes Niveau, auf dem die Mixed-Layer-Isohume (`w`, s.
 * `mixedLayerMixingRatio`) die Umgebungstemperatur erreicht. Unterhalb ist
 * die Isohume kälter (d < 0), am Schnittpunkt gleich — dort wird linear
 * interpoliert.
 */
function findCcl(grid, i, w, pSfc) {
  const { nk } = grid;
  let prev = null;
  for (let k = 0; k < nk; k++) {
    const ix = i * nk + k;
    const pHpa = grid.p[ix] / 100, tEnvC = grid.T[ix] - KELVIN, zM = grid.z[ix];
    if (!Number.isFinite(pHpa) || !Number.isFinite(tEnvC) || !Number.isFinite(zM)) continue;
    if (pHpa > pSfc + 1) continue; // Level unterhalb des Bodenniveaus
    const d = tempFromMixingRatio(w, pHpa) - tEnvC;
    if (d >= 0) {
      if (!prev) return { z: zM, pHpa, tC: tEnvC }; // schon am Boden gesättigt
      const f = prev.d / (prev.d - d);
      return {
        z: prev.z + f * (zM - prev.z),
        pHpa: prev.p + f * (pHpa - prev.p),
        tC: prev.t + f * (tEnvC - prev.t),
      };
    }
    prev = { d, z: zM, p: pHpa, t: tEnvC };
  }
  return null; // Isohume schneidet das Profil nicht — keine Quellbewölkung
}

/**
 * Ab dem CCL feuchtadiabatisch aufsteigen: CAPE aufintegrieren und das EL als
 * HÖCHSTES Niveau mit positivem Auftrieb bestimmen. Auftrieb virtuell
 * korrigiert (Doswell & Rasmussen 1994).
 *
 * Bricht bewusst NICHT beim ersten Wechsel auf negativen Auftrieb ab -- eine
 * kurze Stabilitätsschicht/CIN-Delle direkt über dem CCL (Interpolationsrauschen
 * oder eine echte, aber dünne Kappe) darf den Aufstieg nicht vorzeitig
 * beenden, wenn der Parcel weiter oben wieder (stärker) aufsteigt. Das war
 * der Grund für ein degeneriertes EL knapp über dem CCL bei sonst
 * hochreichend labilen Profilen (s. Feedback: Cb-Amboss bei 500 m trotz
 * Nullgradgrenze auf 4000 m) -- portiert wie `sounding_viewer.html`, das
 * ebenfalls das gesamte Profil durchsucht und sich nur das jeweils letzte
 * Niveau mit positivem Auftrieb merkt, statt frühzeitig abzubrechen.
 */
function ascendFromCcl(env, ccl) {
  let tPclK = ccl.tC + KELVIN, pCur = ccl.pHpa, zPrev = ccl.z;
  let cape = 0, elZ = NaN, elTC = NaN;

  for (let p = pCur - DP_STEP_HPA; p >= P_TOP_HPA; p -= DP_STEP_HPA) {
    const e = env(p);
    if (!e) break; // Gitterdeckel
    const tNextK = moistStep(tPclK, pCur, p - pCur);
    const tvPcl = tNextK * (1 + 0.608 * mixingRatio(tNextK - KELVIN, p));
    const tvEnv = e.tK * (1 + 0.608 * e.w);
    const buoy = (G * (tvPcl - tvEnv) / tvEnv) * (e.z - zPrev);
    if (buoy > 0) {
      cape += buoy; elZ = e.z; elTC = e.tK - KELVIN;
    }
    tPclK = tNextK; pCur = p; zPrev = e.z;
  }
  return { elZ, elTC, cape };
}

/**
 * Pro Stunde `{ cclZ, cclT, taC, tSfcC, elZ, elT, cape }` oder `null`, wenn
 * sich kein CCL bestimmen lässt — reine Parcel-Größen ohne Tuning-Parameter.
 *
 * Den Auslöse-Vergleich (T_2m gegen TA) macht bewusst `derive.js`: dort liegen
 * alle einstellbaren GRAMET-Schwellen beisammen, und der Vergleich braucht
 * einen Zuschlag, der nicht aus der Parcel-Theorie folgt (s. dort). `tSfcC`
 * wird deshalb mitgegeben — es ist nicht immer `surface.t2m`, sondern fällt
 * bei fehlenden 2-m-Werten auf das unterste Modelllevel zurück (s.
 * `surfaceState`), und der Vergleich muss dieselbe Größe verwenden.
 */
export function computeColumns(grid) {
  const { times } = grid;
  const out = new Array(times.length).fill(null);
  for (let i = 0; i < times.length; i++) {
    const sfc = surfaceState(grid, i);
    if (!sfc) continue;
    const ccl = findCcl(grid, i, sfc.w, sfc.pSfc);
    if (!ccl) continue;
    const env = envSampler(grid, i);
    const asc = env ? ascendFromCcl(env, ccl) : { elZ: NaN, elTC: NaN, cape: 0 };
    const taC = dryAdiabatT(ccl.tC + KELVIN, ccl.pHpa, sfc.pSfc) - KELVIN;
    out[i] = {
      cclZ: ccl.z, cclT: ccl.tC, taC, tSfcC: sfc.tSfcC,
      elZ: asc.elZ, elT: asc.elTC, cape: asc.cape,
    };
  }
  return out;
}
