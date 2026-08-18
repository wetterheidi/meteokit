/**
 * Gemeinsames Wolkenmodul — Single Source of Truth für alle abgeleiteten
 * Wolkengrößen (Cross-Section-Heatmap, Meteogramm-Ceiling, Go/No-Go-Tabelle,
 * Briefing-METAR). Kern ist EINE höhenabhängige Wolkenfraktion `cloudFraction()`,
 * dreistufig nach bester verfügbarer Quelle (`cfAt`/`buildField` bündeln die
 * Eingänge je Level):
 *  1. `clc` (ICONs Modell-Bedeckungsgrad, direktes Level-Output von Michael) —
 *     wird 1:1 übernommen, wenn vorhanden.
 *  2. `qw`/`qi` (Wolkenwasser/-eis) — Kondensat-basiertes CF, wenn `clc` fehlt.
 *  3. Sonst der ursprüngliche Sundqvist-Fallback aus der Feuchte (q_v/RH):
 *     a. Feuchte-Referenz aus der spezifischen Feuchte q_v (prognostisch, ohne
 *        Referenz-Annahme): Dampfdruck e aus (q, p), daraus effektive RH über
 *        die Mischphase (Wasser→Eis, unter −35 °C reines Eis). Macht Cirren
 *        sichtbar. Fehlt q, Rückfall auf die Modell-RH (die unter 0 °C bereits
 *        eis-referenziert ist — per q-Validierung bestätigt).
 *     b. RH_crit: höhenabhängig (Grenzschicht niedriger, frei höher), im
 *        Eisast eis-referenziert abgesenkt, plus Vertikalwind-Modifikation
 *        (Aufwind senkt, Absinken hebt die kritische Feuchte).
 *     c. CF = Sundqvist(RH_eff, RH_crit).
 *  4. Vertikales Clustering → Schichten, Ceiling und unterste Basis (stufen-
 *     unabhängig, arbeitet nur auf der fertigen CF-Kurve).
 *
 * Daneben, unabhängig von der CF-Kurve:
 *  - `classifyFog()`: Nebel/Dunst-Diagnose (FG/BR/HZ) col-native, mit der
 *    Sichtweite als primärem Kriterium (Kondensat/Wolkenanteil am Boden gehen
 *    voran, `weather_code` ist nur Fallback ohne Sichtwert) — dieselbe
 *    Priorität wie die grid-native Variante `gramet/hazards/fog.js`
 *    `classifyColumn()` für GRAMET, damit Meteogramm/Go-No-Go/Briefing nicht
 *    der GRAMET-Diagnose widersprechen (s. METHODIK.md 4.3).
 */

// --- Kalibrierung ------------------------------------------------------------
//
// ⚠️ WICHTIGE ERINNERUNG — REGELMÄSSIG NEU PRÜFEN ⚠️
// RH_CRIT_SURF/MID/Z_REF/ICE unten sind KEINE Startwerte mehr, sondern gegen
// echtes CLC von Michaels Instanz gefittet (`scripts/calibrate-clouds.mjs`,
// dort ausführen für eine neue Messung). ABER: Datenbasis war nur EIN
// Kalendermonat (August 2026, mitteleuropäischer Sommer). Vor blindem
// Vertrauen bei anderen Wetterlagen (Winterinversion, Herbstnebel, Frühjahr,
// andere Jahreszeiten allgemein) UNBEDINGT `scripts/calibrate-clouds.mjs`
// erneut laufen lassen und mit den Werten hier vergleichen — s. METHODIK.md
// 4.1 für die volle Herleitung und die bekannten Einschränkungen.
const RH_SAT = 100;          // % — Sättigung (in der jeweiligen Referenz) → CF = 1
const RH_CRIT_SURF = 96;     // % — kritische RH in der Grenzschicht (wasser-ref.)
const RH_CRIT_MID = 83;      // % — kritische RH in der freien Troposphäre (wasser-ref.)
// Höhe, ab der RH_CRIT_MID gilt — modellspezifisch (unterschiedliche
// Grenzschichtauflösung), je eigens gefittet. `col.model` fehlt (z. B. externe
// Aufrufer ohne Säule) ⇒ DEFAULT (grober Mittelwert aus der Gesamtstichprobe).
const RH_CRIT_Z_REF_BY_MODEL = { icon_d2: 300, icon_eu: 1200 };
const RH_CRIT_Z_REF_DEFAULT = 950; // m AGL
const RH_CRIT_ICE = 96.5;    // % — kritische RH im Eisast (eis-referenziert)
const ICE_T_FULL = -35;      // °C — darunter reine Eisphase (RH_i)

// Vertikalwind-Dynamik (Punkt 3). PLATZHALTER — die Schwellen kalibriert der
// Nutzer separat: W_SCALE = w-Skala des tanh (m/s), CRIT_W_MAX = maximale
// crit-Absenkung/-Anhebung (%-Punkte).
const W_SCALE = 0.1;         // m/s
const CRIT_W_MAX = 8;        // %-Punkte

// Bedeckungsgrad-Schwellen (CF → Okta). BKN beginnt bei CF = 0.5 — dieselbe
// Schwelle wie die (ICAO-)Ceiling-Definition. FEW = unterste markante Schicht.
export const CF_FEW = 0.10, CF_SCT = 0.25, CF_BKN = 0.50, CF_OVC = 0.90;

// Bodennaher Dunst-/Nebel-Guard. In den untersten Z_SURF_M ist hohe RH meist
// nur optischer Dunst, keine Wolke → RH_crit dort auf RH_CRIT_SURF_GUARD
// anheben (RH < ~90 % ⇒ CF = 0). Gesättigte Schichten mit Basis < FOG_BASE_M
// berühren den Boden = Nebel: aus Wolken-Layern/Ceiling ausgenommen, getragen
// von `classifyFog()` (s. u.) — siehe METHODIK.md 4.3.
const Z_SURF_M = 150;            // m AGL — Dicke der bodennahen Dunstschicht
const RH_CRIT_SURF_GUARD = 90;   // % — Mindest-RH_crit direkt am Boden
const FOG_BASE_M = 30;           // m AGL — darunter gilt eine Basis als Nebel

// Physikalische Nebelerkennung (`classifyFog()`, s. u.): nennenswertes
// Kondensat (QW+QI) im untersten Level (k=0, ~10 m AGL — Bodenkontakt-
// Pflicht, sonst würde erhöhter Nebel/erhöhte Feuchte fälschlich als
// Bodenphänomen gezeigt) gilt als Nebel — direkter als die RH-Heuristik, die
// bodennah nur über den Dunst-Guard zwischen Dunst und Wolke unterscheidet.
// PLATZHALTER wie die QCOND_SCALE_*-Konstanten oben (unvalidiert, s.
// METHODIK.md 4.1/4.3). Exportiert (statt wie `FOG_BASE_M` nur gespiegelt):
// `hazards/fog.js` braucht dieselbe Kondensat-Schwelle für die grid-native
// Prüfung, zwei Kopien desselben Platzhalterwerts würden sonst leise
// auseinanderlaufen.
export const FOG_QW_MIN = 1e-5;    // kg/kg — Kondensat-Schwelle für „Nebel vorhanden"

// Sicht-/RH-Schwellen für `classifyFog()` (Handbuch Flugwetterdienste, Band
// Obs) — dieselben Werte, die `gramet/hazards/fog.js` `classifyColumn()` für
// die grid-native GRAMET-Diagnose importiert. EINE Quelle, damit die beiden
// Pfade nicht leise auseinanderlaufen (genau das war vorher der Fall: das
// Meteogramm/die Go-No-Go-Hazardzeile hingen noch am alten `weather_code`-
// Trigger ohne Sichtbezug, während GRAMET schon sichtbasiert klassifizierte —
// s. Feedback).
export const FG_VIS_MAX_M = 1000;      // m — Sicht darunter ⇒ FG, unabhängig von RH
export const HAZE_VIS_MAX_M = 5000;    // m — 1000–5000 m ⇒ BR/HZ, sonst kein Befund
export const BR_HZ_RH_SPLIT = 80;      // % — RH-Split BR (≥) vs. HZ (<) im Sichtband
// Nur für den seltenen Fall ohne Sichtweitendaten: reiner RH-Fallback.
export const BR_RH_FALLBACK_MIN = 90;  // %
export const HZ_RH_FALLBACK_MIN = 60;  // %

// Kondensat-Skalen für die QW/QI-Stufe (Stufe 2, s. u.): getrennt für Wasser
// und Eis, NICHT eine gemeinsame Skala — Eis erzeugt bei gleicher Masse mehr
// Bedeckungsgrad als Wasser. Quelle für die Asymmetrie (Faktor ~4, nicht nur
// die Größenordnung 1e-5 kg/kg selbst): Grundner et al. 2024 (JAMES, "Data-
// Driven Equation Discovery of a Cloud Cover Parameterization"), deren
// per-Regression gefundener Kondensat-Term CF ~ 1/(qc/a₈ + qi/a₉) mit
// a₈≈1,16 mg/kg (Wasser), a₉≈0,31 mg/kg (Eis) ein Verhältnis a₈/a₉≈3,8 ergibt.
// WICHTIGER VORBEHALT (per Prüfung, s. METHODIK.md 4.1): dieser Wert stammt
// aus einem ML-Ersatzschema für ~80-km-Klimamodellauflösung (trainiert gegen
// kilometerskalige Referenzsimulationen), NICHT aus dem operationellen ICON-
// D2/EU-Schema, das unser `clc` tatsächlich liefert — nur die Richtung
// (Eis sensitiver) ist direkt begründet, nicht die absolute Größe. Eigene
// Regression gegen echte CLC-Werte von Michaels Instanz ergab je nach Methode
// Verhältnisse zwischen ~7,6 und ~13 (s. METHODIK.md) — beide Werte bleiben
// daher PLATZHALTER, die Grundner-Ratio ist nur die Startannahme.
const QCOND_SCALE_WATER = 2e-5; // kg/kg
const QCOND_SCALE_ICE = 5e-6;   // kg/kg — ~4x kleiner/sensitiver als Wasser

/** Wolkenfraktion aus Kondensatgehalt (Stufe 2, s. `cloudFraction`): getrennte
 *  Sättigungs-Skalen für Wasser/Eis (s. o.), additiv kombiniert. Erfordert
 *  KEINE Höhen-/Temperatur-Gate-Logik — die Formel ist unabhängig davon
 *  korrekt, ob `qw` und `qi` gleichzeitig auftreten (im Mischphasenbereich
 *  −35…0 °C, s. `iceFraction`, ist das sogar der Regelfall, z. B. unterkühltes
 *  Flüssigwasser + Eis in Altocumulus). */
function condensateFraction(qw, qi) {
  const termW = qw > 0 ? qw / QCOND_SCALE_WATER : 0;
  const termI = qi > 0 ? qi / QCOND_SCALE_ICE : 0;
  return clamp(1 - Math.exp(-(termW + termI)), 0, 1);
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// --- Feuchte-Referenz (aus q_v, Eis-Korrektur) ------------------------------

const EPS = 0.622; // R_d/R_v — Molmassenverhältnis Wasserdampf/trockene Luft

/** Sättigungsdampfdruck über Wasser (hPa), Magnus/WMO. */
function esatWater(tC) { return 6.112 * Math.exp((17.62 * tC) / (243.12 + tC)); }
/** Sättigungsdampfdruck über Eis (hPa), WMO. */
function esatIce(tC) { return 6.112 * Math.exp((22.46 * tC) / (272.62 + tC)); }

/** Wasserdampf-Partialdruck (hPa) aus spezifischer Feuchte q (kg/kg) und
 *  Luftdruck p (hPa): `e = q·p / (ε + q·(1−ε))`. */
export function vaporPressure(qKgKg, pHpa) {
  if (!Number.isFinite(qKgKg) || !Number.isFinite(pHpa) || qKgKg <= 0) return NaN;
  return (qKgKg * pHpa) / (EPS + qKgKg * (1 - EPS));
}

/** Eisanteil der Mischphase: 0 bei ≥ 0 °C (nur Wasser), 1 bei ≤ −35 °C (nur
 *  Eis), linear dazwischen. */
export function iceFraction(tC) {
  if (!Number.isFinite(tC) || tC >= 0) return 0;
  return clamp((0 - tC) / (0 - ICE_T_FULL), 0, 1);
}

/**
 * Effektive relative Feuchte (%) als Wolken-Referenz — vorzugsweise aus der
 * spezifischen Feuchte q_v (prognostisch, ohne Referenz-Annahme): Dampfdruck e
 * aus (q, p), bezogen auf einen über die Mischphase geblendeten Sättigungsdampf-
 * druck (Wasser→Eis, stetig, bei α = 1 reines Eis). Fehlt q, Rückfall auf die
 * modellseitige RH `rhModel` (die unter 0 °C bereits eis-referenziert ist — per
 * q-Validierung an Michaels Instanz bestätigt), OHNE zusätzlichen Boost, damit
 * nicht doppelt korrigiert wird.
 * @param hum { q?: kg/kg, p?: hPa, rh?: % } — Feuchte-Eingänge des Levels
 */
export function effectiveRH(hum, tC) {
  const e = vaporPressure(hum?.q, hum?.p);
  if (!Number.isFinite(e) || !Number.isFinite(tC)) {
    return Number.isFinite(hum?.rh) ? hum.rh : NaN; // Fallback: Modell-RH roh
  }
  const a = iceFraction(tC);
  const eMix = (1 - a) * esatWater(tC) + a * esatIce(tC);
  return eMix > 0 ? 100 * e / eMix : NaN;
}

// --- kritische Feuchte + Wolkenfraktion -------------------------------------

/** Wasser-referenzierte kritische RH (%) nach Höhe: RH_CRIT_SURF am Boden,
 *  linear auf RH_CRIT_MID bei RH_CRIT_Z_REF (modellspezifisch, s. o.), darüber
 *  konstant. WICHTIG: mit den gefitteten Werten fällt die Kurve von der Höhe
 *  0 mit RH_CRIT_SURF an — höher als RH_CRIT_MID, ANDERS als früher (Grenz-
 *  schicht sinkt dann Richtung freie Troposphäre statt zu steigen, s.
 *  METHODIK.md 4.1 für die physikalische Deutung). */
function critWarm(zAgl, model) {
  const z = Number.isFinite(zAgl) ? Math.max(0, zAgl) : 0;
  const zref = RH_CRIT_Z_REF_BY_MODEL[model] ?? RH_CRIT_Z_REF_DEFAULT;
  return RH_CRIT_SURF + (RH_CRIT_MID - RH_CRIT_SURF) * Math.min(1, z / zref);
}

/**
 * Kritische relative Feuchte (%) für die Wolkenbildung auf Höhe z, in DERSELBEN
 * Referenz wie `effectiveRH` (im Eisast eis-referenziert). Die Eisabsenkung
 * folgt der Temperatur (α = `iceFraction`), nicht einer festen Höhe — greift
 * daher im Winter korrekt schon tiefer. Vertikalwind `w` (m/s, positiv aufwärts)
 * senkt (Aufwind) bzw. hebt (Absinken) die Schwelle. `model` ("icon_d2"/
 * "icon_eu", optional) wählt die modellspezifische `RH_CRIT_Z_REF`.
 */
export function criticalRH(zAgl, tC, w, model) {
  const a = iceFraction(tC);
  let crit = (1 - a) * critWarm(zAgl, model) + a * RH_CRIT_ICE;
  // Bodennaher Dunst-Guard: war ursprünglich dafür da, RH_crit nahe am Boden
  // über das allgemeine Profil anzuheben (Dunst ≠ Wolke). Mit dem gefitteten
  // RH_CRIT_SURF (96 %, s. o.) liegt `critWarm` am Boden bereits über dem
  // Guard-Wert (90 %) — der Guard ist unter der aktuellen Kalibrierung daher
  // FAKTISCH INAKTIV (der `max()` unten greift nie zugunsten von `guard`).
  // Bewusst NICHT entfernt: strukturelle Sicherheitsnetz, falls RH_CRIT_SURF
  // künftig wieder sinkt (z. B. nach einer Rekalibrierung mit mehr Daten).
  const z = Number.isFinite(zAgl) ? Math.max(0, zAgl) : 0;
  if (z < Z_SURF_M) {
    const guard = RH_CRIT_SURF_GUARD + (critWarm(Z_SURF_M, model) - RH_CRIT_SURF_GUARD) * (z / Z_SURF_M);
    crit = Math.max(crit, guard);
  }
  if (Number.isFinite(w)) crit -= CRIT_W_MAX * Math.tanh(w / W_SCALE);
  return crit;
}

/**
 * Wolkenfraktion 0…1 eines Levels, dreistufig — beste verfügbare Quelle:
 *  1. `clc` (Modell-Bedeckungsgrad, % — Michaels direktes Level-Output):
 *     `CF = clc / 100`. ICONs eigene Diagnose inkl. Subskalen-Bewölkung,
 *     schlägt jede Feuchte-Heuristik — wird 1:1 übernommen.
 *  2. `qw`/`qi` (Wolkenwasser/-eis, kg/kg, ohne `clc`): `CF` aus dem
 *     Kondensatgehalt (`condensateFraction()`, getrennte Wasser-/Eis-Skalen,
 *     s. u.) — gröber als CLC (Grid-Mittel, keine Subskalen-Wolken; laut DWD-
 *     Doku ist `clc` sogar mit einer ANDEREN, subskalen-bewussten Kondensat-
 *     variante konsistent als der grid-scale `qw`/`qi`, den wir bekommen —
 *     s. METHODIK.md 4.1), aber physikalisch direkter als die RH-Schätzung.
 *  3. Sonst Sundqvist-Fallback (gegen echtes CLC kalibriert, s. Konstanten-
 *     Block oben — ⚠️ nur ein Monat Daten, regelmäßig neu prüfen): `hum`
 *     bündelt die Feuchte-Eingänge ({ q, p, t, rh, model }); q_v ist die
 *     bevorzugte Basis (siehe `effectiveRH`), t die Temperatur (°C), `model`
 *     wählt die modellspezifische `RH_CRIT_Z_REF`. Feuchte-Referenz/
 *     Eis-Korrektur (1), phasen-/windabhängiges RH_crit (2), Sundqvist (3).
 * z in m AGL, w optional (m/s, nur für Stufe 3 relevant).
 */
export function cloudFraction(hum, zAgl, w) {
  if (Number.isFinite(hum?.clc)) return clamp(hum.clc / 100, 0, 1);
  if (Number.isFinite(hum?.qw) || Number.isFinite(hum?.qi)) {
    return condensateFraction(hum?.qw || 0, hum?.qi || 0);
  }
  const tC = hum?.t;
  const rhEff = effectiveRH(hum, tC);
  if (!Number.isFinite(rhEff)) return 0;
  const rhc = criticalRH(zAgl, tC, w, hum?.model);
  if (rhEff <= rhc || rhc >= RH_SAT) return 0;
  const cf = 1 - Math.sqrt(Math.max(0, (RH_SAT - rhEff) / (RH_SAT - rhc)));
  return clamp(cf, 0, 1);
}

/** Okta-nahe Bedeckungskategorie aus einer Wolkenfraktion, oder null (< FEW). */
export function oktaCategory(cf) {
  if (!Number.isFinite(cf) || cf < CF_FEW) return null;
  if (cf < CF_SCT) return "FEW";
  if (cf < CF_BKN) return "SCT";
  if (cf < CF_OVC) return "BKN";
  return "OVC";
}

// CF eines Levels aus der Säule (bündelt den Zugriff auf q/p/T/RH sowie die
// optionalen Stufe-1/2-Felder qw/qi/clc und w).
function cfAt(col, k, i) {
  const hum = {
    q: col.q?.[k]?.[i], p: col.p?.[k]?.[i], t: col.t?.[k]?.[i], rh: col.rh?.[k]?.[i],
    qw: col.qw?.[k]?.[i], qi: col.qi?.[k]?.[i], clc: col.clc?.[k]?.[i], model: col.model,
  };
  return cloudFraction(hum, col.h[k][i], col.w?.[k]?.[i]);
}
// Höhe, in der CF (linear zwischen zwei Leveln) den Schwellwert kreuzt.
function crossHeight(h0, cf0, h1, cf1, thr) {
  if (cf1 === cf0) return h0;
  return h0 + (thr - cf0) / (cf1 - cf0) * (h1 - h0);
}

// --- Ceiling / Basis / Schichten --------------------------------------------

/**
 * Unterste Höhe (m AGL) ≥ `minBaseM`, an der die Wolkenfraktion `thr` von unten
 * erreicht — über das GESAMTE Profil interpoliert, oder null. Kein harter
 * Höhen-Cutoff (ICAO-konform); `minBaseM` überspringt eine bodenberührende
 * (Nebel-)Schicht und sucht die nächste Schicht darüber.
 */
function lowestCrossing(col, i, thr, minBaseM = 0) {
  let prevH = null, prevCf = null;
  for (let k = 0; k < col.nLevels; k++) {
    const h = col.h[k][i];
    if (!Number.isFinite(h)) continue;
    const cf = cfAt(col, k, i);
    if (cf >= thr && prevCf != null && prevCf < thr && prevH != null) {
      const base = crossHeight(prevH, prevCf, h, cf, thr);
      if (base >= minBaseM) return base;        // sonst: Nebel überspringen, weiter suchen
    } else if (cf >= thr && prevCf == null && h >= minBaseM) {
      return h; // unterstes Level bereits gesättigt und über der Nebel-Grenze
    }
    prevH = h; prevCf = cf;
  }
  return null;
}

/**
 * Operationelles Ceiling (ICAO) zur Stunde `i`: unterste Höhe im gesamten
 * Profil mit `CF ≥ CF_BKN` (BKN/OVC), ohne Höhen-Cutoff. `cloud_cover_low`
 * (`ccLowPct`) gatet NICHT, sondern liefert nur die Konfidenz. null, wenn
 * nirgends BKN erreicht wird.
 * @returns {{ baseM: number, confident: boolean } | null}
 */
export function cloudCeiling(col, i, { coverThresh = CF_BKN, ccLowPct = null } = {}) {
  const baseM = lowestCrossing(col, i, coverThresh, FOG_BASE_M);
  if (baseM == null) return null;
  return { baseM, confident: Number.isFinite(ccLowPct) && ccLowPct > 50 };
}

/**
 * Untergrenze der untersten markanten Wolkenschicht (m AGL): unterstes
 * `CF ≥ CF_FEW` im Profil (auch FEW/SCT), über der Nebel-Grenze — für
 * Situationsbild/Briefing. null, wenn das Profil praktisch wolkenfrei ist.
 */
export function lowestCloudBase(col, i) {
  return lowestCrossing(col, i, CF_FEW, FOG_BASE_M);
}

/**
 * Nebel/Dunst-Diagnose (FG/BR/HZ) zur Stunde `i`, col-native Gegenstück zu
 * `gramet/hazards/fog.js` `classifyColumn()` (dort grid-native für GRAMETs
 * Höhenschnitt) — SICHTWEITE ALS PRIMÄRES KRITERIUM, exakt dieselbe Priorität
 * und dieselben Schwellen wie dort (s. ausführliche Herleitung im Kopf-
 * kommentar von `hazards/fog.js`):
 *  1. Kondensat direkt am untersten Level (`qw+qi > FOG_QW_MIN`) → FG, sicher
 *     — stärkstes physikalisches Signal, geht der Sichtdiagnose bewusst vor.
 *  2. Bodennahe Wolkenfraktion `cfAt(col,0,i) ≥ CF_BKN` → FG; sicher nur, wenn
 *     `clc` das trägt (sonst RH-Sundqvist-Fallback, unsicher).
 *  3. Sonst, wenn `visibility` vorhanden ist: < FG_VIS_MAX_M → FG; ≤
 *     HAZE_VIS_MAX_M → BR (RH ≥ BR_HZ_RH_SPLIT) oder HZ; sonst kein Befund —
 *     AUCH wenn `wcode` Nebel meldet (die Sicht ist hier die Wahrheit).
 *  4. Sonst (keine Sichtweite verfügbar): `wcode` 45/48 → FG, unsicher; RH-
 *     Fallback für BR/HZ, unsicher.
 *  5. sonst kein Befund (`null`).
 *
 * `freezing`: unterkühlter Nebel (T ≤ 0 °C im untersten Level) — friert auf
 * Oberflächen (Rotorblätter!) auf, relevanter Hazard über die reine
 * Sichtbehinderung hinaus.
 *
 * @param {number} [visibility] Sicht (m), i. d. R. `surface.vars.visibility[i]`
 * @param {number} [wcode] `weather_code[i]`, nur Fallback ohne Sichtwert
 * @returns {{type: "FG"|"BR"|"HZ", certain: boolean, freezing: boolean} | null}
 */
export function classifyFog(col, i, visibility, wcode) {
  const t0 = col.t?.[0]?.[i];
  const freezing = Number.isFinite(t0) && t0 <= 0;

  const qw0 = col.qw?.[0]?.[i], qi0 = col.qi?.[0]?.[i];
  if ((qw0 || 0) + (qi0 || 0) > FOG_QW_MIN) return { type: "FG", certain: true, freezing };

  const cf0 = cfAt(col, 0, i);
  if (cf0 >= CF_BKN) return { type: "FG", certain: Number.isFinite(col.clc?.[0]?.[i]), freezing };

  const rh0 = col.rh?.[0]?.[i];
  if (Number.isFinite(visibility)) {
    if (visibility < FG_VIS_MAX_M) return { type: "FG", certain: true, freezing };
    if (visibility <= HAZE_VIS_MAX_M) {
      const type = Number.isFinite(rh0) && rh0 >= BR_HZ_RH_SPLIT ? "BR" : "HZ";
      return { type, certain: true, freezing: false };
    }
    return null; // Sicht > HAZE_VIS_MAX_M -- gilt auch gegen einen widersprüchlichen wcode/RH
  }

  if (wcode === 45 || wcode === 48) return { type: "FG", certain: false, freezing };
  if (Number.isFinite(rh0) && rh0 >= BR_RH_FALLBACK_MIN) return { type: "BR", certain: false, freezing: false };
  if (Number.isFinite(rh0) && rh0 >= HZ_RH_FALLBACK_MIN) return { type: "HZ", certain: false, freezing: false };
  return null;
}

/**
 * Wolkenschichten zur Stunde `i` als METAR-nahe Liste `{ baseM, cover, cf }`
 * von unten nach oben. Eine Schicht ist ein zusammenhängender Levelblock mit
 * `CF ≥ CF_FEW`; Basis = interpolierte Höhe des Schwellenübertritts, Bedeckung =
 * CF-Maximum im Block. Bis `capM` (12 km, damit auch Cirrus erscheint),
 * höchstens `maxLayers` (die untersten) — OHNE „nur zunehmende Bedeckung"-
 * Filter, damit eine dünnere hohe Schicht über einer tieferen nicht verschluckt
 * wird.
 */
export function cloudLayers(col, i, { capM = 12000, maxLayers = 4 } = {}) {
  const layers = [];
  // Bodenberührende Schichten (Basis < FOG_BASE_M) sind Nebel, keine gemeldete
  // Wolkenschicht — sie tragen die Sicht/weather_code, nicht die Wolken-Spalte.
  const push = (baseM, cf) => { if (baseM >= FOG_BASE_M) layers.push({ baseM, cover: oktaCategory(cf), cf }); };
  let inLayer = false, baseM = null, maxCf = 0, prevH = null, prevCf = null;
  for (let k = 0; k < col.nLevels; k++) {
    const h = col.h[k][i];
    if (!Number.isFinite(h)) continue;
    if (h > capM) break;
    const cf = cfAt(col, k, i);
    if (cf >= CF_FEW) {
      if (!inLayer) {
        baseM = (prevCf != null && prevCf < CF_FEW && prevH != null)
          ? crossHeight(prevH, prevCf, h, cf, CF_FEW) : h;
        inLayer = true; maxCf = cf;
      } else if (cf > maxCf) { maxCf = cf; }
    } else if (inLayer) {
      push(baseM, maxCf);
      inLayer = false;
      if (layers.length >= maxLayers) return layers;
    }
    prevH = h; prevCf = cf;
  }
  if (inLayer) push(baseM, maxCf);
  return layers.slice(0, maxLayers);
}

// --- LCL-Fallback (Bodenpaket) ---------------------------------------------

/** Wolkenbasis nach Espy (m AGL) aus 2-m-Feldern, oder null bei fehlender
 *  tiefer Bewölkung (`cloud_cover_low < 25 %`). Reine Bodenpaket-Näherung —
 *  Fallback, wenn keine Modell-Säule vorliegt. */
export function cloudBaseAgl(tC, tdC, ccLowPct) {
  const cc = ccLowPct ?? 0;
  if (cc < 25 || !Number.isFinite(tC) || !Number.isFinite(tdC)) return null;
  return Math.max(0, 125 * (tC - tdC));
}

// --- Bedeckungsgrad nach Stockwerk (Kartenlayer) ----------------------------

// Grenzen tief/mittel/hoch (m AGL) — Startwerte nach gängiger synoptischer
// Konvention (tief < 2 km, hoch > 6,5 km), noch nicht an METAR validiert.
export const CLOUD_BAND_LOW_MAX_M = 2000;
export const CLOUD_BAND_HIGH_MIN_M = 6500;

/**
 * Bedeckungsgrad je Stockwerk (tief/mittel/hoch, CF 0…1) zur Stunde `i` —
 * für die flächige Kartendarstellung (Graustufen je Stockwerk). Baut auf
 * `cloudLayers()` auf (SINGLE SOURCE OF TRUTH, s. o.): je Stockwerk das
 * CF-Maximum ALLER dort liegenden Schichten. `maxLayers` bewusst groß, damit
 * eine hohe Schicht nicht von mehreren tieferen aus der Liste verdrängt wird
 * (anders als das METAR-nahe `cloudLayers()`-Default `maxLayers=4`).
 */
export function bandCoverage(col, i, { capM = 12000 } = {}) {
  const layers = cloudLayers(col, i, { capM, maxLayers: 20 });
  let low = 0, mid = 0, high = 0;
  for (const l of layers) {
    if (l.baseM < CLOUD_BAND_LOW_MAX_M) low = Math.max(low, l.cf);
    else if (l.baseM < CLOUD_BAND_HIGH_MIN_M) mid = Math.max(mid, l.cf);
    else high = Math.max(high, l.cf);
  }
  return { low, mid, high };
}

/**
 * Kombiniert die unterste Wolkenschicht (`cloudLayers()`, erste Schicht) mit
 * dem LCL-Fallback für die Meteogramm-Wolkenbasis. Liegt eine Schicht aus dem
 * Höhenprofil vor (`lowestLayer`, aus `cloudLayers(col, i, {maxLayers: 1})[0]`),
 * bestimmt DEREN Basis die Höhe; die Liniendarstellung folgt ihrer Okta-
 * Kategorie — durchgezogen bei BKN/OVC (CF ≥ CF_BKN), gestrichelt bei FEW/SCT.
 * Fehlt die Säule, greift die LCL-Schätzung (Espy) — deren Kategorie ist
 * unbekannt, daher immer gestrichelt. null, wenn beides fehlt.
 */
export function refineCloudBase(tC, tdC, ccLowPct, lowestLayer) {
  if (lowestLayer && Number.isFinite(lowestLayer.baseM)) {
    return { baseM: lowestLayer.baseM, confident: (lowestLayer.cf ?? 0) >= CF_BKN };
  }
  const lcl = cloudBaseAgl(tC, tdC, ccLowPct);
  if (lcl == null) return null;
  return { baseM: lcl, confident: false };
}
