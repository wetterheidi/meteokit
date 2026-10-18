/**
 * Boden-Nebel/Dunst-Diagnose (FG/BR/HZ) — ein SPALTEN-Phänomen (eine
 * Klassifikation + eine Obergrenze pro Stunde), anders als Vereisung/
 * Turbulenz kein Zellwert. Ausgabeform folgt darum `cbColumns()` in
 * `derive.js` (Array `{...} | null`, ein Eintrag je Stunde), NICHT
 * `icing.computeGrid()`.
 *
 * SICHTWEITE ALS PRIMÄRES KRITERIUM (Handbuch Flugwetterdienste, Band Obs):
 *   FG: Sicht < 1000 m (immer, unabhängig von RH — Ausnahme BCFG, die WW
 *       nicht unterscheidet, s. u.)
 *   BR: 1000–5000 m UND RH ≥ 80 %
 *   HZ: 1000–5000 m UND RH < 80 %
 * `grid.surface.visibility` (Open-Meteo/ICON-Modelldiagnose, dieselbe Größe,
 * die auch im Briefing angezeigt wird) ist damit der Wahrheitsanker — nicht
 * mehr eine reine RH-Schwelle ohne Sichtbezug. Das behebt zwei Probleme der
 * ersten Fassung:
 *  - RH ≥ 60 % allein sagt fast nichts über Sicht aus (an einem feuchten
 *    Sommertag mit bester Sicht schnell erreicht) — führte zu BR/HZ an
 *    Stunden, an denen das Modell selbst (Briefing-Sichtspalte) >10 km Sicht
 *    zeigte.
 *  - Widerspricht `weather_code` (45/48 = Nebel) der modelleigenen Sicht
 *    (>5000 m), gewinnt jetzt die Sicht — WW wird nur noch konsultiert, wenn
 *    gar keine Sichtweite vorliegt.
 * Dieselbe Priorität/Schwellen gelten jetzt col-nativ über `clouds.js`
 * `classifyFog()` auch für Meteogramm, Go-No-Go-Tabelle und Briefing — vorher
 * hingen diese noch am alten `weather_code`/Kondensat-Trigger ohne Sichtbezug
 * und konnten der hier beschriebenen GRAMET-Diagnose widersprechen (Nebel-
 * Zelle über Stunden, an denen die Sicht laut Modell längst wieder gut war).
 *
 * Priorität je Stunde, jeweils NUR wenn das unterste Level (k=0, ~10 m AGL)
 * den Schwellwert erreicht (Bodenkontakt-Pflicht — sonst würde erhöhter
 * Nebel/erhöhte Feuchte fälschlich als Bodenphänomen gezeigt):
 *
 *  1. Kondensat direkt (qw+qi > FOG_QW_MIN, mirrors `classifyFog()` aus
 *     `clouds.js`, hier grid-nativ statt Column-Objekt, da `grid.qw`/`qi`
 *     ohnehin schon flache Arrays sind) → FG, sicher, mit echter Obergrenze
 *     (Höhen-Scan) — stärkstes physikalisches Signal, geht der Sichtweiten-
 *     Diagnose bewusst vor (direkter Nachweis von Flüssigwasser/Eis am
 *     Boden schlägt eine abgeleitete/parametrisierte Sichtdiagnose).
 *  2. `cloudFrac >= CF_BKN` → FG, mit echter Obergrenze; sicher nur, wenn CLC
 *     (Tier 1 der `cloudFraction()`-Kaskade) das trägt — kommt der Wert
 *     stattdessen aus dem RH-Sundqvist-Fallback (Tier 3; der bodennahe
 *     Dunst-Guard ist unter der aktuellen Kalibrierung laut `clouds.js`
 *     FAKTISCH INAKTIV), gilt das als unsicher.
 *  3. Sonst, wenn `visibility[i]` vorhanden ist:
 *     a. < FG_VIS_MAX_M → FG, sicher. Die Sicht selbst ist ein Bodenwert ohne
 *        Höhenprofil -- die Obergrenze kommt stattdessen aus der feuchten
 *        Grundschicht, gekappt an der Basis einer aufliegenden Wolke
 *        (`moistTop`, s. dort), `topFrom: "rh"`.
 *     b. ≤ HAZE_VIS_MAX_M → BR (RH ≥ BR_HZ_RH_SPLIT) oder HZ (sonst), beide
 *        sicher (Sicht UND RH sind reale Modellfelder, kein Fallback).
 *     c. sonst kein Befund — AUCH wenn RH hoch ist oder `weather_code`
 *        Nebel meldet (s. Priorität 4): die Sicht ist hier die Wahrheit.
 *  4. Sonst (keine Sichtweite verfügbar — Modelle ohne `visibility`, z. B.
 *     ICON Global):
 *     a. `weather_code` 45/48 → FG, unsicher, Obergrenze wie 3a aus der
 *        feuchten Grundschicht (`metarWeather()`-Fallback, ebenso in
 *        `classifyFog()`).
 *     b. Sicht aus T/RH am untersten Level geschätzt (`clouds.js`
 *        `estimateVisibilityFromHumidity()`, Doran et al. 1999) ≤
 *        HAZE_VIS_MAX_M → BR, unsicher, mit `visEst`. Nie HZ (trockener
 *        Dunst ist ohne Sichtfeld nicht diagnostizierbar), nie FG (Schätzung
 *        nach unten auf FG_VIS_MAX_M begrenzt). Ersetzt den früheren reinen
 *        RH-Fallback (≥ 60 % → HZ), der bei ICON Global fast jede Nacht Dunst
 *        zeigte.
 *  5. sonst kein Befund (`null`).
 *
 * `topFrom` sagt, woher `top` stammt: "condensate" (1.), "cloud" (2.) oder
 * "rh" (3a/4a). Die Darstellung (render.js `hazeRange`) nutzt nur "rh": bei
 * 1./2. zeigt die Wolkentextur die Schicht ohnehin, und deren Oberkante ist die
 * der GANZEN bodenberührenden Wolke (Hochnebel/Stratus leicht >1000 m), nicht
 * die eines Nebels im Fliegersinn.
 *
 * Alle RH-/Sicht-Schwellen sind wie an anderer Stelle im Wolkenmodul
 * PLATZHALTER bzw. direkt aus dem Handbuch übernommen, nicht gegen echte
 * Beobachtungen an dieser App kalibriert (s. METHODIK.md-Vorbehalte in
 * clouds.js).
 */

// Schwellen (Sicht in m, RH-Split in %) leben in `clouds.js`, EINE Quelle für
// beide Instanzen derselben Klassifikation (hier grid-nativ für GRAMET, dort
// `classifyFog()` col-nativ für Meteogramm/Go-No-Go/Briefing) -- zwei Kopien
// derselben Handbuch-Schwellen würden sonst leise auseinanderlaufen (genau
// das war vorher der Fall, s. Feedback). Re-exportiert, damit `render.js`
// (`fog.FG_VIS_MAX_M` etc., Namespace-Import) unverändert weiterläuft.
import {
  CF_BKN, FOG_QW_MIN,
  FG_VIS_MAX_M, HAZE_VIS_MAX_M, BR_HZ_RH_SPLIT, estimateVisibilityFromHumidity,
} from "../../clouds.js";
export { FG_VIS_MAX_M, HAZE_VIS_MAX_M, BR_HZ_RH_SPLIT };

const KELVIN = 273.15;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Feuchte Grundschicht für die FG-Obergrenze ohne Wolkensignal am Boden: die
// Schicht ab k=0 gilt als Nebelschicht, solange RH >= min(FOG_TOP_RH, RH am
// untersten Level) bleibt. Das `min` hält die Schicht auch bei FG mit weniger
// als FOG_TOP_RH am Boden auswertbar (Sicht-FG bei z. B. 91 %, ICON-D2-Fall
// 18.10.26 12 UTC) -- die Schicht reicht dann so weit, wie es mindestens so
// feucht bleibt wie am Boden. Typischer Abschluss ist die Inversion, an der
// RH sprunghaft fällt (im selben Fall 100 % -> 65 % binnen eines Levels).
// PLATZHALTER, nicht kalibriert -- gewählt nach Augenschein an diesem Fall.
const FOG_TOP_RH = 95; // %

/** Kondensat (qw+qi, kg/kg) an einer Gitterzelle; NaN-Eingänge zählen als 0. */
function condensateAt(grid, ix) {
  return (grid.qw[ix] || 0) + (grid.qi[ix] || 0);
}

/**
 * Obergrenze (m AGL) der Schicht ab k=0, solange `getValue(ix) >= threshold`
 * hält — linear zur Schwelle interpoliert am ersten Unterschreiten (gleiches
 * Muster wie `crossHeight()` in `clouds.js`). Aufrufer garantiert, dass die
 * Schwelle bei k=0 bereits erreicht ist.
 */
function scanTop(grid, i, threshold, getValue) {
  const { nk } = grid;
  let top = null;
  for (let k = 0; k < nk; k++) {
    const ix = i * nk + k;
    const v = getValue(ix);
    if (!Number.isFinite(v)) break;
    if (v >= threshold) { top = grid.z[ix]; continue; }
    if (top != null && k > 0) {
      const ix0 = ix - 1;
      const v0 = getValue(ix0), z0 = grid.z[ix0], z1 = grid.z[ix];
      top = v0 !== v ? z0 + (threshold - v0) / (v - v0) * (z1 - z0) : z0;
    }
    break;
  }
  return top;
}

/**
 * Obergrenze (m AGL) der feuchten Grundschicht, s. FOG_TOP_RH -- höchstens bis
 * zur Basis einer darüberliegenden Wolke (Kondensat > FOG_QW_MIN bzw.
 * cloudFrac >= CF_BKN, dieselben Kriterien wie 1./2.). Ohne diese Kappung
 * liefe der RH-Scan bei Nebel unter tiefem Stratus durch die gesättigte Wolke
 * bis zu deren Oberkante (ICON-D2-Fall 18.10.26 00 UTC: Stratus ab ~110 m,
 * RH >= 95 % bis ~2200 m); die Wolke selbst zeigt im GRAMET die Wolkentextur.
 * `null` ohne RH am Boden.
 */
function moistTop(grid, cloudFrac, i) {
  const { nk } = grid;
  const rh0 = grid.rh[i * nk];
  if (!Number.isFinite(rh0)) return null;
  const top = scanTop(grid, i, Math.min(FOG_TOP_RH, rh0), (ix) => grid.rh[ix]);
  for (let k = 1; k < nk; k++) {
    const ix = i * nk + k;
    if (top != null && grid.z[ix - 1] >= top) break; // Feuchteschicht endet vorher
    const isCond = condensateAt(grid, ix) > FOG_QW_MIN;
    if (!isCond && !(cloudFrac[ix] >= CF_BKN)) continue;
    // Wolkenbasis linear zur auslösenden Schwelle zwischen k-1 und k.
    const get = isCond ? (j) => condensateAt(grid, j) : (j) => cloudFrac[j];
    const thr = isCond ? FOG_QW_MIN : CF_BKN;
    const v0 = get(ix - 1), v1 = get(ix), z0 = grid.z[ix - 1], z1 = grid.z[ix];
    const base = v1 !== v0 ? z0 + clamp((thr - v0) / (v1 - v0), 0, 1) * (z1 - z0) : z0;
    return top == null ? base : Math.min(top, base);
  }
  return top;
}

/**
 * Klassifikation einer einzelnen Stunde. `cloudFrac` kommt von `derive.js`
 * (`d.cloudFrac`, dieselbe Größe wie Wolkenbasis/Cb/Vereisung) statt hier neu
 * berechnet zu werden.
 * @returns {{type: "FG"|"BR"|"HZ", top: number|null, topFrom?: "condensate"|"cloud"|"rh", certain: boolean, freezing: boolean, visEst?: number} | null}
 */
export function classifyColumn(grid, cloudFrac, i) {
  const { nk } = grid;
  const ix0 = i * nk;
  const freezing = grid.T[ix0] - KELVIN <= 0;

  if (condensateAt(grid, ix0) > FOG_QW_MIN) {
    return { type: "FG", top: scanTop(grid, i, FOG_QW_MIN, (ix) => condensateAt(grid, ix)), topFrom: "condensate", certain: true, freezing };
  }
  if (cloudFrac[ix0] >= CF_BKN) {
    const certain = Number.isFinite(grid.clc[ix0]);
    return { type: "FG", top: scanTop(grid, i, CF_BKN, (ix) => cloudFrac[ix]), topFrom: "cloud", certain, freezing };
  }

  const vis = grid.surface?.visibility?.[i];
  const rh0 = grid.rh[ix0];
  if (Number.isFinite(vis)) {
    if (vis < FG_VIS_MAX_M) return { type: "FG", top: moistTop(grid, cloudFrac, i), topFrom: "rh", certain: true, freezing };
    if (vis <= HAZE_VIS_MAX_M) {
      const type = Number.isFinite(rh0) && rh0 >= BR_HZ_RH_SPLIT ? "BR" : "HZ";
      return { type, top: null, certain: true, freezing: false };
    }
    return null; // Sicht > HAZE_VIS_MAX_M -- gilt auch gegen einen widersprüchlichen wcode/RH (s. o.)
  }

  const wcode = grid.surface?.wcode?.[i];
  if (wcode === 45 || wcode === 48) {
    return { type: "FG", top: moistTop(grid, cloudFrac, i), topFrom: "rh", certain: false, freezing };
  }
  const visEst = estimateVisibilityFromHumidity(grid.T[ix0] - KELVIN, rh0);
  if (visEst <= HAZE_VIS_MAX_M) {
    return { type: "BR", top: null, certain: false, freezing: false, visEst };
  }
  return null;
}

/** Klassifikation über den gesamten Zeitraum, ein Eintrag je Stunde. */
export function computeColumns(grid, cloudFrac) {
  const { times } = grid;
  const out = [];
  for (let i = 0; i < times.length; i++) out.push(classifyColumn(grid, cloudFrac, i));
  return out;
}

/**
 * Klassifikations-Eintrag → `metarWeather()`-Phänomen-Objekt
 * (`{fog, freezing, mist, haze}`, s. `briefing.js`). Liefert AUCH für
 * `entry === null` ein echtes (nur leeres) Objekt, nicht `null` — die
 * Unterscheidung "Diagnose gelaufen, nichts gefunden" (leeres Objekt) vs.
 * "Diagnose gar nicht gelaufen" (`null`, z. B. Spalte nicht geladen) ist
 * genau das, worauf `metarWeather()` seine Vorrangregel stützt: nur ein
 * ECHTES leeres Ergebnis darf einen widersprüchlichen `weather_code` (45/48)
 * überstimmen.
 */
export function toPhenomenon(entry) {
  return {
    fog: entry?.type === "FG",
    mist: entry?.type === "BR",
    haze: entry?.type === "HZ",
    freezing: entry?.freezing ?? false,
  };
}
