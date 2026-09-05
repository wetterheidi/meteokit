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
 *
 * ENTRAINMENT (elZDiluted/ecape): Das obige EL ist ein UNDILUTED Parcel --
 * real mischen Cumulus-Updrafts Umgebungsluft ein und verlieren dadurch
 * Auftrieb, sodass der tatsächlich erreichte Oberrand niedriger liegt. Genau
 * das fehlte bisher: die Cb-Spalte sprang beim Auslösen (T_2m >= TA) sofort
 * auf den vollen undiluted EL, statt sich -- wie eine reale Quellwolke von
 * Cu humilis über Cu mediocris zu Cu congestus -- erst mit wachsender
 * Instabilität tiefer zu entwickeln.
 *
 * Ein erster Anlauf hierzu (Peters et al. 2023, Eq. 18, mit einer aus der
 * stundenweisen Grenzschichttiefe abgeleiteten Entrainmentrate) scheiterte an
 * echten Fällen: die dort nötige Radius-Skalierung extrapoliert bei den in
 * der Praxis üblichen flachen Grenzschichten (10er Meter) weit außerhalb des
 * im Paper geprüften Bereichs und liefert dann unsinnige Werte (mal
 * Totalunterdrückung, mal ein von Epsilon praktisch unabhängiger Restterm,
 * der trotz extremer Verdünnung fast bis zum undiluted EL reicht) --
 * s. Git-Historie/Konversation, nicht weiter verfolgt.
 *
 * Stattdessen jetzt: Gregory (2001, "Estimation of entrainment rate in
 * simple models of convective clouds", Q. J. R. Meteorol. Soc. 127, 53-72).
 * Kerngedanke: die Entrainmentrate ist keine von außen geschätzte Größe,
 * sondern ergibt sich selbstkonsistent aus dem Auftrieb B und der
 * Updraft-kinetischen-Energie w² des Parcels selbst,
 *   epsilon = C * B / w²                                            (Eq. 3)
 *   d(w²)/dz = 2a*B - 2*epsilon*w²                                   (Eq. 2)
 *   dh_u/dz = epsilon * (h_e - h_u)                                  (Eq. 1)
 * (h = "moist static energy", wie bei Peters et al.; dieselbe Grundform).
 * Damit braucht es keine externe Längenskala mehr (kein Extrapolations-
 * problem): früh, wenn B und w² beide klein sind, ist Epsilon groß (rasche
 * Verdünnung, Cu humilis); mit wachsendem B/w² im Tagesverlauf sinkt Epsilon
 * (Cu med -> TCU/Cb) -- genau der gesuchte, aus der Parcel-Dynamik selbst
 * folgende Übergang. Del Genio & Wu (2010, "The Role of Entrainment in the
 * Diurnal Cycle of Continental Convection", J. Climate 23, 2722-2738) haben
 * dieses Schema an cloud-resolving-WRF-Simulationen des flach-zu-tief-
 * Übergangs KONTINENTALER (nicht ozeanisch-tropischer) Konvektion als beste
 * unter mehreren getesteten Parametrisierungen bestätigt -- die für unseren
 * Fall (mitteleuropäisches Tageskonvektion) einschlägige Referenz.
 *
 * Die Koeffizienten C und a sowie die Kappung von Epsilon sind NICHT aus
 * einer Abbildung abgelesen (Del Genio & Wu geben ihr eigenes, diagnostisch
 * angepasstes C(z) nur grafisch, nicht als Formel), sondern aus einer
 * echten, dokumentierten Implementierung von Gregory (2001) im operationellen
 * Chikira-Sugiyama-Cumulusschema (Chikira & Sugiyama 2010, J. Atmos. Sci. 67,
 * 2171-2193) übernommen: physics/CONV/Chikira_Sugiyama/cs_conv.F90,
 * github.com/NCAR/ccpp-physics (NOAA/NCAR Common Community Physics Package).
 * Von dort: CLMD=0.60 ("entrainment efficiency", = C), PA=0.15 (Auftrieb ->
 * Updraft-KE-Faktor, = a), sowie die Kappung ELAMIN=0/ELAMAX=4e-3 m^-1 und
 * die Dämpfungslängenskala TAUZ=1e4 m der w²-Fortschreibung -- diese Kappung
 * ist es, die das Problem des ersten Anlaufs strukturell vermeidet: Epsilon
 * kann dort gar nicht mehr auf physikalisch bedeutungslose Werte explodieren.
 * `ascendFromCclEntraining` ist ein Prädiktor-Korrektor-Schritt je Level, wie
 * dort implementiert, nur ohne dessen Eis-/Niederschlags-/Ensemble-Anteile
 * (die unser einfaches Ein-Parcel-Modell nicht führt) und mit unserer
 * eigenen, im übrigen Modul bereits verwendeten Auftriebsformel (virtuelle
 * Temperatur, ohne Kondensatlast -- s. Modulkopf oben zu `ascendFromCcl`)
 * statt der dortigen vollen Wolkenwasserbilanz. Die Updraft-Start-KE an der
 * CCL (GREGORY_W2_SEED) ist NICHT aus der Quelle übernommen -- die hat dafür
 * ein eigenes Wolkenbasis-Geschwindigkeitsspektrum, das hier nicht
 * nachgebildet wird -- sondern ein kleiner, als Auslöse-Regularisierung
 * gekennzeichneter Platzhalter (s. dort).
 *
 * "Erster Nulldurchgang" vs. "ganzes Profil scannen" (bis 2026-09-05 offene
 * Frage): für `elZDiluted` beantwortet sich das aus genau dieser KE-Bilanz,
 * nicht heuristisch. Die Schleife bricht nicht beim ersten negativen Auftrieb
 * ab, sondern erst, wenn `w2` unter `GREGORY_WCCRT` fällt (s. o.) -- eine
 * dünne Stabilitätsschicht/Kappe wird also automatisch durchstoßen, wenn die
 * bis dahin aufgebaute Updraft-KE dafür reicht, sonst bricht der Aufstieg dort
 * tatsächlich ab. Das ist dieselbe Physik, die Gregory (2001) Eq. 2 für die
 * KE-Fortschreibung vorschreibt, hier nur konsequent bis zum Abbruch
 * angewendet -- kein Widerspruch mehr zwischen den beiden Lesarten, weil
 * beide Fälle (Durchstoßen vs. echtes Ende) aus derselben Bilanz herausfallen.
 * `elZFirstCross`/`elTFirstCross` (zusätzlich zu `elZ`/`elZDiluted`) halten
 * nur den ERSTEN Nulldurchgang separat fest -- rein diagnostisch, um an echten
 * Profilen (s. `diagnose-convection.mjs` in droneforecast) zu sehen, wie oft
 * `elZDilutedFirstCross` überhaupt von `elZDiluted` abweicht, also wie oft in
 * der Praxis eine Kappe durchstoßen wird. Fließt NICHT ins Rendering
 * (`derive.js` konsumiert weiterhin nur `elZDiluted`).
 */

const KELVIN = 273.15;
const RD = 287.05, CP = 1004.0, G = 9.80665, EPS = 0.622;
const KAPPA = RD / CP;

// Schrittweite der Feuchtadiabate — 5 hPa reichen für RK4 (s. Quelle).
const DP_STEP_HPA = 5;
// Harte Abbruchgrenze der Aufstiegssuche; normalerweise bricht schon der
// Gitterdeckel ab (envSampler liefert dort null).
const P_TOP_HPA = 120;

// Entrainment (Gregory 2001 / Chikira & Sugiyama 2010), s. Modulkopf
// ("ENTRAINMENT") für Herleitung/Quellen.
const LV_REF = 2500800;      // J/kg, Lv am Tripelpunkt (wie bei Peters et al. 2023, Annahme 4)
const GREGORY_CLMD = 0.60;   // "entrainment efficiency" C in epsilon=C*B/w² (CLMD in cs_conv.F90)
const GREGORY_PA = 0.15;     // Auftrieb->Updraft-KE-Faktor a in d(w²)/dz=2aB-... (PA in cs_conv.F90)
const GREGORY_CLMDPA = GREGORY_CLMD * GREGORY_PA;
const GREGORY_CLMP = (1 - GREGORY_CLMD) * (2 * GREGORY_PA);
const GREGORY_TAUZ_M = 1.0e4;  // m, Dämpfungslängenskala der w²-Fortschreibung (TAUZ in cs_conv.F90)
const GREGORY_ELAMIN = 0;      // m^-1, untere Kappung von epsilon (ELAMIN in cs_conv.F90)
const GREGORY_ELAMAX = 4.0e-3; // m^-1, obere Kappung von epsilon (ELAMAX in cs_conv.F90)
const GREGORY_WCCRT = 1.0e-6;  // m²/s², Mindest-Updraft-KE (WCCRT in cs_conv.F90); darunter endet der Aufstieg
// Start-KE an der CCL -- Platzhalter-Regularisierung, nicht aus der Quelle (s. Modulkopf).
const GREGORY_W2_SEED = 0.01;  // m²/s² (w0 ~ 0.1 m/s)

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
 *
 * EL wird beim Vorzeichenwechsel linear auf den exakten Nulldurchgang
 * INNERHALB des 5-hPa-Schritts interpoliert, statt (wie bis 2026-09-05) auf
 * dessen Levelende zu runden -- analog zur Korrektur in `sounding_data`
 * (Commits 214c509/5df2cad, dort zwischen echten Sondierungslevels statt
 * RK4-Zwischenschritten, gleiches Prinzip). Unsere Schrittweite ist zwar
 * schon feiner als ein rohes Modelllevel, aber bei den oft nur wenige
 * hundert Meter tiefen verdünnten Türmen (s. `ascendFromCclEntraining`) ist
 * ein Bias von bis zu ~5 hPa proportional trotzdem spürbar. CAPE bleibt
 * unverändert schrittweise aufintegriert (wie in `sounding_data`, das
 * ebenfalls nur die EL-Position, nicht die CAPE-Summe, nachträglich
 * korrigiert).
 */
function ascendFromCcl(env, ccl) {
  let tPclK = ccl.tC + KELVIN, pCur = ccl.pHpa, zPrev = ccl.z;
  let cape = 0, elZ = NaN, elTC = NaN;
  let elZFirst = NaN, elTFirst = NaN; // erster Nulldurchgang, rein diagnostisch (s. Modulkopf)
  let buoyPrev = 0; // Auftriebsbeschleunigung am unteren Schrittrand; an der CCL per Definition 0

  for (let p = pCur - DP_STEP_HPA; p >= P_TOP_HPA; p -= DP_STEP_HPA) {
    const e = env(p);
    if (!e) break; // Gitterdeckel
    const tNextK = moistStep(tPclK, pCur, p - pCur);
    const tvPcl = tNextK * (1 + 0.608 * mixingRatio(tNextK - KELVIN, p));
    const tvEnv = e.tK * (1 + 0.608 * e.w);
    const buoyNow = (G * (tvPcl - tvEnv)) / tvEnv; // Auftriebsbeschleunigung am oberen Schrittrand
    const dz = e.z - zPrev;
    const buoy = buoyNow * dz;
    if (buoy > 0) {
      cape += buoy; elZ = e.z; elTC = tNextK - KELVIN;
    } else if (buoyPrev > 0) {
      // Vorzeichenwechsel in diesem Schritt: exakten Nulldurchgang interpolieren.
      const f = buoyPrev / (buoyPrev - buoyNow);
      elZ = zPrev + f * dz;
      elTC = (tPclK + f * (tNextK - tPclK)) - KELVIN;
      if (!Number.isFinite(elZFirst)) { elZFirst = elZ; elTFirst = elTC; }
    }
    tPclK = tNextK; pCur = p; zPrev = e.z; buoyPrev = buoyNow;
  }
  return { elZ, elTC, cape, elZFirst, elTFirst };
}

function clip(x, lo, hi) { return Math.min(Math.max(x, lo), hi); }

/**
 * Sättigte Parcel-Temperatur (°C) zu gegebener "moist static energy" `hTarget`
 * auf Druck `pHpa`/Höhe `zM` -- Newton-Inversion von
 * `h = CP*T + LV_REF*qsat(T,p) + G*z` (Eq. 9 bei Peters et al., hier mit der
 * bereits vorhandenen Sättigungsfunktion `mixingRatio`). `tGuessC` als
 * Startwert (Vorgänger-Level) macht 2-3 Iterationen genug.
 */
function tempFromSaturatedMse(hTarget, pHpa, zM, tGuessC) {
  let tC = tGuessC;
  for (let it = 0; it < 6; it++) {
    const w = mixingRatio(tC, pHpa);
    const h = CP * (tC + KELVIN) + LV_REF * w + G * zM;
    const dT = 0.5;
    const dwdT = (mixingRatio(tC + dT, pHpa) - w) / dT;
    const dhdT = CP + LV_REF * dwdT;
    const tCNew = tC + (hTarget - h) / dhdT;
    if (Math.abs(tCNew - tC) < 0.01) return tCNew;
    tC = tCNew;
  }
  return tC;
}

/**
 * Ein Level-Schritt der Gregory-Verdünnung (s. Modulkopf "ENTRAINMENT"): `h`
 * um `eps*(h_env-h)*dz` verdünnen (Eq. 1), daraus die Parcel-Temperatur und
 * ihren (virtuell korrigierten) Auftrieb an diesem Level bestimmen.
 */
function stepLevelEntraining(hPrev, eps, dz, e, pHpa, tGuessC) {
  const hEnv = CP * e.tK + LV_REF * e.w + G * e.z; // Umgebungs-MSE, tatsächliche Feuchte (Eq. 10)
  const h = hPrev + eps * (hEnv - hPrev) * dz;
  const tC = tempFromSaturatedMse(h, pHpa, e.z, tGuessC);
  const tvPcl = (tC + KELVIN) * (1 + 0.608 * mixingRatio(tC, pHpa));
  const tvEnv = e.tK * (1 + 0.608 * e.w);
  const buoy = (G * (tvPcl - tvEnv)) / tvEnv;
  return { tC, buoy, h };
}

/**
 * Wie `ascendFromCcl`, aber mit selbstkonsistenter Gregory-Entrainmentrate
 * (s. Modulkopf "ENTRAINMENT") statt des undiluted Profils -- das reale,
 * durchmischungsbegrenzte Pendant zu EL/CAPE. Prädiktor-Korrektor je Level,
 * wie in `cs_conv.F90` (s. Modulkopf): erst Entrainmentrate/Verdünnung/
 * Auftrieb am unteren Levelrand schätzen (Prädiktor), damit die Updraft-KE
 * `w2` fortschreiben, daraus am oberen Levelrand die Entrainmentrate erneut
 * bestimmen (Korrektor) und die Verdünnung damit wiederholen.
 *
 * Der Aufstieg endet, sobald `w2` unter `GREGORY_WCCRT` fällt (Updraft ohne
 * kinetische Energie) oder das Gitter endet -- nicht erst am Gitterdeckel
 * wie beim undiluted Profil, weil ein entrainment-geschwächter Updraft real
 * schon vorher "ausbeult". EL wird wie in `ascendFromCcl` auf den exakten
 * Nulldurchgang innerhalb des Schritts interpoliert statt auf dessen
 * Levelende gerundet -- hier besonders relevant, weil die verdünnten Türme
 * oft nur wenige hundert Meter tief sind.
 */
function ascendFromCclEntraining(env, ccl) {
  let tPclC = ccl.tC, pCur = ccl.pHpa, zPrev = ccl.z;
  let hPrev = CP * (ccl.tC + KELVIN) + LV_REF * mixingRatio(ccl.tC, ccl.pHpa) + G * ccl.z;
  let buoyPrev = 0; // an der CCL per Definition neutral (Parcel = Umgebung)
  let w2 = GREGORY_W2_SEED;
  let ecape = 0, elZ = NaN, elTC = NaN;
  let elZFirst = NaN, elTFirst = NaN; // erster Nulldurchgang, rein diagnostisch (s. Modulkopf)

  for (let p = pCur - DP_STEP_HPA; p >= P_TOP_HPA; p -= DP_STEP_HPA) {
    if (w2 <= GREGORY_WCCRT) break; // Updraft ohne kinetische Energie -- Ende
    const e = env(p);
    if (!e) break; // Gitterdeckel
    const dz = e.z - zPrev;

    // Prädiktor.
    const elarm1 = clip((GREGORY_CLMDPA * buoyPrev) / w2, GREGORY_ELAMIN, GREGORY_ELAMAX);
    const step1 = stepLevelEntraining(hPrev, elarm1, dz, e, p, tPclC);
    const buoyAvg1 = (buoyPrev + step1.buoy) / 2;
    let w2New = buoyAvg1 > 0
      ? (w2 + GREGORY_CLMP * dz * buoyAvg1) / (1 + dz / GREGORY_TAUZ_M)
      : (w2 + GREGORY_PA * 2 * dz * buoyAvg1) / (1 + dz / GREGORY_TAUZ_M + 2 * dz * GREGORY_ELAMIN);
    w2New = Math.max(w2New, 0);

    // Korrektor: Entrainmentrate mit dem neuen w² neu bestimmen, Verdünnung wiederholen.
    const elarm2 = w2New > 0
      ? clip((GREGORY_CLMDPA * step1.buoy) / w2New, GREGORY_ELAMIN, GREGORY_ELAMAX)
      : 0;
    const elar = (elarm1 + elarm2) / 2;
    const step2 = stepLevelEntraining(hPrev, elar, dz, e, p, step1.tC);

    const buoyAvg2 = (buoyPrev + step2.buoy) / 2;
    const buoyInc = buoyAvg2 * dz;
    if (buoyInc > 0) {
      ecape += buoyInc; elZ = e.z; elTC = step2.tC;
    } else if (buoyPrev > 0) {
      // Vorzeichenwechsel in diesem Schritt: exakten Nulldurchgang interpolieren
      // (s. `ascendFromCcl` für dieselbe Korrektur/Begründung).
      const f = buoyPrev / (buoyPrev - step2.buoy);
      elZ = zPrev + f * dz;
      elTC = tPclC + f * (step2.tC - tPclC);
      if (!Number.isFinite(elZFirst)) { elZFirst = elZ; elTFirst = elTC; }
    }

    hPrev = step2.h; buoyPrev = step2.buoy; w2 = w2New; tPclC = step2.tC;
    pCur = p; zPrev = e.z;
  }
  return { elZ, elTC, ecape, elZFirst, elTFirst };
}

/**
 * Pro Stunde `{ cclZ, cclT, taC, tSfcC, elZ, elT, cape, elZFirstCross,
 * elTFirstCross, elZDiluted, elTDiluted, ecape, elZDilutedFirstCross,
 * elTDilutedFirstCross }` oder `null`, wenn sich kein CCL bestimmen lässt --
 * reine Parcel-Größen ohne freie Tuning-Parameter. `elZ`/`elT`/`cape` sind
 * das undiluted Profil (s. `ascendFromCcl`); `elZDiluted`/`elTDiluted`/
 * `ecape` das entrainment-gedämpfte Pendant (s. `ascendFromCclEntraining`,
 * Modulkopf "ENTRAINMENT") -- Letzteres ist die für Zeichnung/Symbolik
 * gedachte, realistischere Größe, ersteres bleibt zur Provenienz/Diagnose
 * erhalten. Die `*FirstCross`-Felder sind der jeweils ERSTE Nulldurchgang
 * (statt des finalen, KE-geprüften Oberrands) -- rein diagnostisch, s.
 * Modulkopf "ENTRAINMENT", nicht für Rendering gedacht.
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
    const asc = env
      ? ascendFromCcl(env, ccl)
      : { elZ: NaN, elTC: NaN, cape: 0, elZFirst: NaN, elTFirst: NaN };
    const ascDil = env
      ? ascendFromCclEntraining(env, ccl)
      : { elZ: NaN, elTC: NaN, ecape: 0, elZFirst: NaN, elTFirst: NaN };
    const taC = dryAdiabatT(ccl.tC + KELVIN, ccl.pHpa, sfc.pSfc) - KELVIN;
    out[i] = {
      cclZ: ccl.z, cclT: ccl.tC, taC, tSfcC: sfc.tSfcC,
      elZ: asc.elZ, elT: asc.elTC, cape: asc.cape,
      elZFirstCross: asc.elZFirst, elTFirstCross: asc.elTFirst,
      elZDiluted: ascDil.elZ, elTDiluted: ascDil.elTC, ecape: ascDil.ecape,
      elZDilutedFirstCross: ascDil.elZFirst, elTDilutedFirstCross: ascDil.elTFirst,
    };
  }
  return out;
}
