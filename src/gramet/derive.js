/**
 * Leitet aus dem Zeit-Höhen-Gitter (`grid.js`) alles ab, was `render.js`
 * zeichnet: Isothermen, Isotachen, Tropopause, Tag/Nacht-Verlauf, Wolkenbasis,
 * Niederschlag, Hazard-Durchreichung. Alles in (Zeitindex/Unixzeit, Höhe m
 * AGL) — die Pixel-Projektion ist Sache des Renderers.
 */

import { derive as deriveGrid } from "./grid.js";
import { CF_FEW, CF_BKN } from "../clouds.js";
import { sunAltitude } from "../astro.js";
import { metarWeather } from "../briefing.js";
import * as icing from "./hazards/icing.js";
import * as turbulence from "./hazards/turbulence.js";
import * as convection from "./hazards/convection.js";
import * as fog from "./hazards/fog.js";

const KELVIN = 273.15;
const KT_PER_MS = 1.94384;
const FOG_BASE_M = 30; // m AGL — mirrors clouds.js FOG_BASE_M (nicht exportiert)
const ISOTHERM_MAX_JUMP_M = 1500; // m je Spaltenschritt, s. METHODIK/Plan
const ISOTHERM_THRESHOLDS_C = [0, -20, -40];
const ISOTACH_THRESHOLDS_KT = [50, 75, 100];

// Konvektions-Spalten (TCU/Cb): primär Parcel-Theorie aus `hazards/
// convection.js` (CCL als Basis, Auslösetemperatur als Trigger, EL als
// Obergrenze) plus `weather_code` als hartes Modellsignal -- TS => Cb,
// SH/+SH => mindestens TCU. Die folgenden CAPE-/Updraft-Schwellen sind nur
// noch Auffangpfad, falls beides nichts liefert (z. B. CCL nicht bestimmbar);
// sie sind wie bisher NICHT kalibriert.
const CB_CAPE_MIN_JKG = 300;
const CB_UPDRAFT_MIN_MS = 3;
// Ersatz-Oberrand, wenn weder ein EL noch ein vergletschertes Wolkenniveau
// noch überhaupt eine Wolkenspur im Profil gefunden wird (z. B. Gewitter nur
// via weather_code gemeldet) -- NICHT der Modelldeckel, s. PRECIP_FALLBACK_TOP_M.
const CB_FALLBACK_TOP_M = 6000;
// Cb-Abgrenzung: der Oberrand muss vergletschert sein (Amboss besteht aus
// Eis) UND nah genug an die Tropopause reichen, dass sich die Wolke dort
// ausbreitet. Sonst bleibt es TCU (Cumulus congestus, keine Ambossandeutung).
const CB_GLACIATION_C = -20;
const CB_TROPOPAUSE_GAP_M = 1200;
// Rein thermisch ausgelöste Konvektion (ohne SH/TS im weather_code) bekommt
// erst ab dieser Mächtigkeit (EL - CCL) eine Spalte -- flache Schönwetter-
// Cumulusfelder sind keine TCU. Nicht kalibriert.
const TCU_MIN_DEPTH_M = 1500;
// "Towering"-Hürde: der Oberrand muss um diesen Betrag ÜBER der 0-°C-Grenze
// liegen, sonst entsteht überhaupt keine Konvektionsspalte -- weder Schaft noch
// Symbol. Eine Quellwolke, die die Frostgrenze kaum erreicht, ist schlicht
// Cumulus; sie als TCU zu plotten ist meteorologisch falsch, und in labilen
// Lagen verschmolzen genau diese Randstunden den Nachmittag zu einem
// durchgehenden Block (s. Feedback). 5000 ft entsprechen bei Standardgradient
// grob dem -10-°C-Niveau, also dem Beginn nennenswerter Vereisung im Turm.
// Vorgabe, nicht kalibriert. Wirkt zusätzlich zu TCU_MIN_DEPTH_M: dort geht es
// um die Gesamtmächtigkeit CCL->EL, hier um die Lage des Oberrands.
const TCU_MIN_ABOVE_FREEZING_M = 1524; // 5000 ft
// Zuschlag beim Vergleich T_2m gegen die Auslösetemperatur (`convection.js`
// liefert TA roh). `t2m` ist ein Gitterzellen-MITTEL, Konvektion startet aber
// aus den wärmsten Thermikblasen -- überadiabatische Bodenschicht, besonnte
// Hänge und subskalige Heterogenität lassen sie 0,5-2 K wärmer aufsteigen als
// das Zellmittel. Dazu kommt, dass TA selbst rund die Hälfte des
// 2-m-Taupunktfehlers erbt (±1 K in Td -> ∓0,55 K in TA, gemessen). Alle
// Effekte zeigen in dieselbe Richtung: ein striktes T_2m >= TA löst
// systematisch zu spät aus, und bei trockener Konvektion (weather_code meldet
// dann NSW, kein SH) ist dieser Pfad der einzige Weg zur Spalte. Nicht
// kalibriert.
const TRIGGER_EXCESS_K = 1;

// Fällt keine Wolke im CF_FEW-Sinn im Profil auf (Niederschlag aber laut
// weather_code/Menge gemeldet), Ersatz-Obergrenze für den Niederschlags-
// vorhang -- NICHT der Modelldeckel (führte zum "bis in die Stratosphäre"-
// Artefakt, s. Feedback). Grobe Annahme für flachen Nieselregen/Sprühregen.
const PRECIP_FALLBACK_TOP_M = 2000;
// Unterhalb dieser Menge (mm/h) gilt Niederschlag als nicht mehr relevant für
// den Vorhang, selbst wenn weather_code noch "-RA" o.ä. meldet (Rundungsreste).
const PRECIP_MIN_RATE = 0.05;

export function deriveView(grid) {
  const d = deriveGrid(grid);
  const isotherms = ISOTHERM_THRESHOLDS_C.map((tempC) => ({ tempC, polylines: isothermPolylines(grid, tempC) }));
  const isotachs = ISOTACH_THRESHOLDS_KT.map((kt) => ({ kt, polylines: contour(grid, d.wspd, kt / KT_PER_MS) }));
  const tropopauseLine = tropopause(grid);
  const daylightArr = daylight(grid);
  const nt = grid.times.length;
  const cloudBase = new Float32Array(nt);
  for (let i = 0; i < nt; i++) cloudBase[i] = cloudBaseAt(grid, d.cloudFrac, i);
  // Einmal berechnen und an precipEntries/cbColumns weiterreichen -- deren
  // metarWeather()-Aufrufe sollen dasselbe FG/BR/HZ-Ergebnis sehen wie die
  // Wetter-Zeile, nicht mit einer zweiten Berechnung auseinanderlaufen.
  const fogCols = fog.computeColumns(grid, d.cloudFrac);

  return {
    isotherms,
    isotachs,
    tropopause: tropopauseLine,
    daylight: daylightArr,
    cloudFrac: d.cloudFrac,
    cloudBase,
    precip: precipEntries(grid, cloudBase, fogCols),
    cb: cbColumns(grid, d.cloudFrac, cloudBase, tropopauseLine, fogCols),
    fog: fogCols,
    hazards: {
      icing: icing.computeGrid(grid, d.cloudFrac),
      turbulence: turbulence.computeGrid(grid, d.ri, d.shear2, d.nm),
    },
  };
}

// --- Isothermen (spaltenweise Kreuzungssuche, s. Plan) ----------------------

function isothermPolylines(grid, thresholdC) {
  const thrK = thresholdC + KELVIN;
  const { nk, pos } = grid, nt = pos.length;
  const active = []; // { line:[{t,z}], lastZ, lastI }
  const finished = [];

  for (let i = 0; i < nt; i++) {
    const zs = columnCrossings(grid, i, thrK);
    const usedZ = new Array(zs.length).fill(false);

    for (const a of active) {
      if (a.lastI !== i - 1) continue; // schon geschlossen (Lücke im Vorschritt)
      let bestJ = -1, bestD = Infinity;
      for (let j = 0; j < zs.length; j++) {
        if (usedZ[j]) continue;
        const dist = Math.abs(zs[j] - a.lastZ);
        if (dist < bestD) { bestD = dist; bestJ = j; }
      }
      if (bestJ >= 0 && bestD < ISOTHERM_MAX_JUMP_M) {
        usedZ[bestJ] = true;
        a.line.push({ t: pos[i], z: zs[bestJ] });
        a.lastZ = zs[bestJ]; a.lastI = i;
      }
    }
    for (const a of active) if (a.lastI < i && a.line.length > 1) finished.push(a.line);
    for (let ai = active.length - 1; ai >= 0; ai--) if (active[ai].lastI < i) active.splice(ai, 1);
    for (let j = 0; j < zs.length; j++) {
      if (!usedZ[j]) active.push({ line: [{ t: pos[i], z: zs[j] }], lastZ: zs[j], lastI: i });
    }
  }
  for (const a of active) if (a.line.length > 1) finished.push(a.line);
  return finished;
}

function columnCrossings(grid, i, thrK) {
  const { nk } = grid;
  const zs = [];
  for (let k = 0; k < nk - 1; k++) {
    const ix0 = i * nk + k, ix1 = i * nk + k + 1;
    const T0 = grid.T[ix0], T1 = grid.T[ix1];
    if (!Number.isFinite(T0) || !Number.isFinite(T1)) continue;
    if ((T0 >= thrK) !== (T1 >= thrK)) {
      const f = (thrK - T0) / (T1 - T0);
      zs.push(grid.z[ix0] + f * (grid.z[ix1] - grid.z[ix0]));
    }
  }
  return zs;
}

// --- Isotachen (marching squares) --------------------------------------------

// Weit unter jeder realistischen Schwelle (Hazard-Level max 2,5; Isotachen
// max ~51 m/s), aber FINIT -- eine Randposition, an der zwei Ecken (eine
// reale, eine Phantom-Ecke, s. `contour()`) auf denselben Punkt fallen,
// ergäbe mit `-Infinity` in `edgePoint()` sonst `Infinity/Infinity = NaN`.
const OUTSIDE_FIELD = -1e6;

/**
 * Generische Konturlinien-Extraktion auf einem (Zeit x Level)-Feld — auch für
 * spätere Hazard-Flächenumrisse wiederverwendbar (s. Plan).
 *
 * Rand-Padding: eine Phantomreihe/-spalte rund ums Gitter (`i`/`k` außerhalb
 * `[0,nt)`/`[0,nk)`) mit Wert `OUTSIDE_FIELD`, aber auf DERSELBEN Position
 * wie der jeweils angrenzende Randpunkt (`pos()` klemmt den Index, kein
 * extrapolierter Ort). Ohne das würde eine Fläche, die eine Gitterkante
 * "durchgehend" erfüllt (kein echter Kreuzungspunkt im Inneren -- z. B. ein
 * Hazard, der schon zur ersten Stunde oder am untersten Level vorliegt),
 * eine offene Polylinie erzeugen; `drawHazardArea()` schließt offene
 * Polylinien beim Füllen mit einer geraden Linie quer durchs Bild
 * (sichtbares Artefakt, s. Feedback). Mit Padding entsteht an jeder solchen
 * Kante stattdessen ein echter Kreuzungspunkt GENAU auf dem Gitterrand
 * (reale und Phantom-Position fallen zusammen, die Interpolation kollabiert
 * unabhängig vom Mischungsfaktor auf diesen Punkt) -- die Fläche schließt
 * sich sauber am Rand statt quer durchs Bild.
 */
export function contour(grid, field, threshold) {
  const { nk, pos: posArr } = grid, nt = posArr.length;
  const segments = [];

  const val = (i, k) => (i < 0 || i >= nt || k < 0 || k >= nk) ? OUTSIDE_FIELD : field[i * nk + k];
  const pos = (i, k) => {
    const ci = clampIdx(i, nt), ck = clampIdx(k, nk);
    return { t: posArr[ci], z: grid.z[ci * nk + ck] };
  };

  for (let i = -1; i < nt; i++) {
    for (let k = -1; k < nk; k++) {
      const v00 = val(i, k), v10 = val(i + 1, k), v11 = val(i + 1, k + 1), v01 = val(i, k + 1);
      if (![v00, v10, v11, v01].every(Number.isFinite)) continue;
      const p00 = pos(i, k), p10 = pos(i + 1, k);
      const p11 = pos(i + 1, k + 1), p01 = pos(i, k + 1);

      const bottom = crossesEdge(v00, v10, threshold) ? edgePoint(threshold, v00, v10, p00, p10) : null;
      const right = crossesEdge(v10, v11, threshold) ? edgePoint(threshold, v10, v11, p10, p11) : null;
      const top = crossesEdge(v01, v11, threshold) ? edgePoint(threshold, v01, v11, p01, p11) : null;
      const left = crossesEdge(v00, v01, threshold) ? edgePoint(threshold, v00, v01, p00, p01) : null;
      const crossing = [bottom, right, top, left].filter(Boolean);
      if (crossing.length === 2) { segments.push(crossing); continue; }
      if (crossing.length === 4) {
        // Sattelfall (zwei gegenüberliegende Ecken über der Schwelle): Paarung
        // über den Zellmittelwert entscheiden (asymptotic decider).
        const center = (v00 + v10 + v11 + v01) / 4;
        const b00 = v00 >= threshold, b11 = v11 >= threshold;
        const highDiagonal = b00 && b11;
        if (highDiagonal === (center >= threshold)) {
          segments.push([bottom, left]); segments.push([top, right]);
        } else {
          segments.push([bottom, right]); segments.push([top, left]);
        }
      }
    }
  }
  return chainSegments(segments);
}

function clampIdx(i, n) { return i < 0 ? 0 : i >= n ? n - 1 : i; }

function crossesEdge(va, vb, threshold) { return (va >= threshold) !== (vb >= threshold); }
function edgePoint(threshold, va, vb, pa, pb) {
  const f = (threshold - va) / (vb - va);
  return { t: pa.t + f * (pb.t - pa.t), z: pa.z + f * (pb.z - pa.z) };
}

// Segmente (je zwei Endpunkte) zu Polylinien verketten. Ein innerer Kreuzungs-
// punkt wird von genau zwei Nachbarzellen mit identischen Eingabewerten
// berechnet -> bitgleich, daher reicht ein einfacher String-Schlüssel.
function chainSegments(segments) {
  const key = (p) => `${p.t}|${p.z}`;
  const pointMap = new Map();
  segments.forEach((seg, si) => {
    for (const end of [0, 1]) {
      const k = key(seg[end]);
      if (!pointMap.has(k)) pointMap.set(k, []);
      pointMap.get(k).push({ si, end });
    }
  });
  const used = new Array(segments.length).fill(false);
  const polylines = [];
  const extend = (chain, forward) => {
    for (;;) {
      const p = forward ? chain[chain.length - 1] : chain[0];
      const candidates = pointMap.get(key(p)) || [];
      const next = candidates.find(({ si }) => !used[si]);
      if (!next) return;
      used[next.si] = true;
      const other = segments[next.si][next.end === 0 ? 1 : 0];
      if (forward) chain.push(other); else chain.unshift(other);
    }
  };
  for (let si = 0; si < segments.length; si++) {
    if (used[si]) continue;
    used[si] = true;
    const chain = [segments[si][0], segments[si][1]];
    extend(chain, true);
    extend(chain, false);
    polylines.push(chain);
  }
  return polylines;
}

// --- Tropopause (WMO-Kriterium) ----------------------------------------------

function tropopause(grid) {
  const { nk, pos } = grid, nt = pos.length;
  const line = [];
  for (let i = 0; i < nt; i++) {
    let foundZ = NaN;
    for (let k = 0; k < nk; k++) {
      const ix = i * nk + k, z = grid.z[ix];
      if (!Number.isFinite(z) || z < 5000 || !Number.isFinite(grid.T[ix])) continue;
      const zLimit = z + 2000;
      let ok = true, reachedLimit = false;
      for (let k2 = k + 1; k2 < nk; k2++) {
        const ix2 = i * nk + k2, zz = grid.z[ix2];
        // Fehlende Höhe ODER Temperatur brechen ab, statt eine NaN-Lapse-Rate
        // zu bilden -- `NaN > 2` ist immer false, würde `ok` also fälschlich
        // `true` lassen und am Ende der Forecast-Reichweite eine Tropopause
        // auf dem ersten (meist niedrigen) Level vortäuschen.
        if (!Number.isFinite(zz) || !Number.isFinite(grid.T[ix2])) break;
        if (zz > zLimit) { reachedLimit = true; break; }
        const lapseKPerKm = -(grid.T[ix2] - grid.T[ix]) / (zz - z) * 1000;
        if (lapseKPerKm > 2) { ok = false; break; }
      }
      // Kein Level bis zur 2-km-Grenze erreicht (Gitter endet zu früh oder
      // Temperaturdaten fehlen ab hier) -> kein Treffer, sonst Fehlalarm am
      // Domänendeckel.
      if (ok && reachedLimit) { foundZ = z; break; }
    }
    if (Number.isFinite(foundZ)) line.push({ t: pos[i], z: foundZ });
  }
  return smooth3(line);
}

function smooth3(line) {
  if (line.length < 3) return line;
  const out = [line[0]];
  for (let i = 1; i < line.length - 1; i++) {
    out.push({ t: line[i].t, z: (line[i - 1].z + line[i].z + line[i + 1].z) / 3 });
  }
  out.push(line[line.length - 1]);
  return out;
}

// --- Tag/Nacht ---------------------------------------------------------------

// Kontinuierlicher Faktor: 1 oberhalb 0° Sonnenhöhe, 0 unterhalb -12°
// (nautische Dämmerung), dazwischen linear.
function daylight(grid) {
  const { times, lat, lon } = grid;
  const out = new Float32Array(times.length);
  for (let i = 0; i < times.length; i++) {
    const alt = sunAltitude(times[i] * 1000, lat[i], lon[i]);
    out[i] = alt >= 0 ? 1 : alt <= -12 ? 0 : (alt + 12) / 12;
  }
  return out;
}

// --- Wolkenbasis + Niederschlag ----------------------------------------------

// Unterkante des untersten zusammenhängenden Bereichs mit cloudFrac >= CF_FEW
// (mirrors clouds.js `lowestCloudBase`, hier direkt auf dem schon berechneten
// Gitter-cloudFrac statt erneuter cloudFraction()-Aufrufe).
function cloudBaseAt(grid, cloudFrac, i) {
  const { nk } = grid;
  let prevH = null, prevCf = null;
  for (let k = 0; k < nk; k++) {
    const ix = i * nk + k, h = grid.z[ix];
    if (!Number.isFinite(h)) continue;
    const cf = cloudFrac[ix];
    if (cf >= CF_FEW && prevCf != null && prevCf < CF_FEW && prevH != null) {
      const f = (CF_FEW - prevCf) / (cf - prevCf);
      const base = prevH + f * (h - prevH);
      if (base >= FOG_BASE_M) return base;
    } else if (cf >= CF_FEW && prevCf == null && h >= FOG_BASE_M) {
      return h;
    }
    prevH = h; prevCf = cf;
  }
  return NaN;
}

// Obergrenze der zusammenhängenden Wolkenschicht ab `baseH`: kleine, trockene
// Zwischenschichten (< CLOUD_TOP_GAP_TOLERANCE_M) werden überbrückt, damit
// z. B. eine dünne bodennahe Feuchteschicht nicht fälschlich als eigene,
// flache "Wolke" von der eigentlich regnenden Schicht darüber abgeschnitten
// wird (führte zu Niederschlagsvorhängen, die weit unter der sichtbaren
// Wolke endeten, s. Feedback) — eine ECHTE, größere Lücke (z. B. zu isoliert
// darüberliegendem Cirrus) beendet die Schicht aber weiterhin.
const CLOUD_TOP_GAP_TOLERANCE_M = 1200;
function cloudTopAt(grid, cloudFrac, i, baseH) {
  if (!Number.isFinite(baseH)) return NaN;
  const { nk } = grid;
  let top = baseH, lastCloudH = baseH;
  for (let k = 0; k < nk; k++) {
    const ix = i * nk + k, h = grid.z[ix];
    if (!Number.isFinite(h) || h < baseH) continue;
    const cf = cloudFrac[ix];
    if (cf >= CF_FEW) { lastCloudH = h; top = h; }
    else if (h - lastCloudH > CLOUD_TOP_GAP_TOLERANCE_M) break;
  }
  return top;
}

// Höchstes Level im GESAMTEN Profil mit CF >= CF_FEW (nicht nur die unterste,
// zusammenhängende Schicht wie `cloudTopAt`) -- robuster Fallback, wenn die
// Basis-Erkennung nichts findet, aber irgendwo im Profil doch Wolke steckt.
function anyCloudTopAt(grid, cloudFrac, i) {
  const { nk } = grid;
  let top = NaN;
  for (let k = 0; k < nk; k++) {
    const ix = i * nk + k;
    if (cloudFrac[ix] >= CF_FEW) top = grid.z[ix];
  }
  return top;
}

function freezingHeightAt(grid, i) {
  const { nk } = grid;
  for (let k = 0; k < nk - 1; k++) {
    const ix0 = i * nk + k, ix1 = i * nk + k + 1;
    const T0 = grid.T[ix0] - KELVIN, T1 = grid.T[ix1] - KELVIN;
    if (T0 >= 0 && T1 < 0) {
      const f = T0 / (T0 - T1);
      return grid.z[ix0] + f * (grid.z[ix1] - grid.z[ix0]);
    }
  }
  return NaN;
}

/**
 * Niederschlagseintrag je Stunde: `weather_code` (als METAR-Kürzel, dieselbe
 * Tabelle wie die Wetter-Zeile) entscheidet OB und ALS WAS gezeichnet wird,
 * die Menge (`precipitation`, mm/h) nur, wie DICHT (Intensität). Vorher war
 * die Menge allein das Gate (>0,1 mm/h) -- bei sehr leichtem Niederschlag
 * rundet die Menge oft auf ~0, obwohl weather_code ihn noch meldet, was die
 * Wetter-Zeile und den gezeichneten Vorhang auseinanderlaufen ließ (s.
 * Feedback). Phase (Regen/Schnee) kommt jetzt ebenfalls aus dem METAR-Kürzel
 * (SN/SG/FZ...), nicht mehr nur aus `snowfall > 0`.
 */
function precipEntries(grid, cloudBase, fogCols) {
  const out = [];
  const { times, pos, surface } = grid;
  if (!surface) return out;
  const cloudFrac = deriveGrid(grid).cloudFrac;
  for (let i = 0; i < times.length; i++) {
    const label = Number.isFinite(surface.wcode?.[i])
      ? metarWeather(surface.wcode[i], fog.toPhenomenon(fogCols[i])) : "N/A";
    const amt = surface.precip[i];
    const hasAmount = Number.isFinite(amt) && amt > PRECIP_MIN_RATE;
    const hasWx = label !== "NSW" && label !== "N/A";
    // Nebel/Diesigkeit/Dunst sind kein Niederschlag -- ohne diesen Ausschluss
    // bekäme jede reine BR/HZ-Stunde (kein `hasAmount`, aber `hasWx` durch das
    // Label) fälschlich einen Niederschlagsvorhang.
    const isFogOnly = label === "FG" || label === "FZFG" || label === "BR" || label === "HZ";
    if (!hasAmount && (!hasWx || isFogOnly)) continue;

    const freezingZ = freezingHeightAt(grid, i);
    // Oberkante des Vorhangs: zusammenhängende Schicht ab der Basis
    // (`cloudTopAt`, jetzt mit Lückentoleranz, s. dort). Nur wenn gar keine
    // Basis gefunden wurde (Niederschlag laut weather_code/Menge, aber keine
    // Wolke im CF_FEW-Sinn erkannt), Ersatz über die höchste Wolkenspur im
    // ganzen Profil bzw. einen festen Fallback -- NICHT einfach das Maximum
    // aus beidem, sonst reißt der Vorhang bis zu unverbundenem Cirrus weit
    // darüber (nächstes Artefakt, s. Feedback-Iteration).
    const top = cloudTopAt(grid, cloudFrac, i, cloudBase[i]);
    const anyTop = anyCloudTopAt(grid, cloudFrac, i);
    const zTop = Number.isFinite(top) ? top : Number.isFinite(anyTop) ? anyTop : PRECIP_FALLBACK_TOP_M;
    // `snowfall` nur als Fallback, wenn der METAR-Code gar keine Aussage
    // macht (`!hasWx`) -- sonst überstimmt ein einzelner, oft marginaler
    // Modellwert einen expliziten "RA"/"SHRA"-Code (s. Feedback: Schnee bis
    // zum Boden bei 23°C Bodentemperatur und Nullgradgrenze auf 4000m).
    const isSnow = label.includes("SN") || label.includes("SG")
      || (!hasWx && Number.isFinite(surface.snow[i]) && surface.snow[i] > 0);
    // Nominale Mindestrate, wenn nur weather_code (nicht die Menge) den
    // Niederschlag anzeigt -- sonst bliebe der Vorhang trotz "-RA" unsichtbar.
    const rate = hasAmount ? amt : 0.3;
    out.push({ t: pos[i], zTop, freezingZ, type: isSnow ? "sn" : "ra", rate });
  }
  return out;
}

/**
 * Konvektions-Spalten (TCU/Cumulonimbus). Liefert pro Stunde `null` oder
 * `{ base, top, kind }` mit `kind = "tcu" | "cb"` (m AGL) für Schaft und Glyph
 * im Renderer.
 *
 * OB eine Spalte entsteht, entscheiden drei Wege:
 *   1. `weather_code` — TS (Gewitter) oder SH/+SH (Schauer) sind direkte
 *      Modellaussagen über konvektiven Charakter und damit das verlässlichste
 *      Signal; sie gelten unabhängig davon, ob unsere Parcel-Rechnung auslöst.
 *   2. Thermische Auslösung aus `hazards/convection.js` (T_2m >= TA) mit
 *      hinreichender Mächtigkeit CCL->EL.
 *   3. Auffangpfad mit den alten, unkalibrierten CAPE-/Updraft-Schwellen, wenn
 *      1. und 2. nichts liefern (z. B. CCL nicht bestimmbar).
 *
 * WIE HOCH sie reicht: EL aus der Parcel-Rechnung, sonst (Fallback-Kette) der
 * höchste vergletscherte Wolkenlevel, sonst irgendeine Wolkenspur, sonst
 * `CB_FALLBACK_TOP_M` — bewusst nie der Modelldeckel (s. `precipEntries`).
 * Basis: CCL, ersatzweise die allgemeine Wolkenbasis.
 *
 * Über allen drei Wegen liegt die Towering-Hürde: der Oberrand muss
 * `TCU_MIN_ABOVE_FREEZING_M` über der 0-°C-Grenze stehen. Sie ist ein hartes
 * Veto — eine Stunde, die daran scheitert, bekommt gar keinen Eintrag, also
 * auch keinen Schaft. Ihr Schauer bleibt trotzdem sichtbar: er läuft über die
 * normale Wolkendarstellung und `precipEntries`.
 *
 * TCU vs. Cb: Cb nur bei TS im weather_code oder wenn der Oberrand
 * vergletschert (T <= CB_GLACIATION_C) UND tropopausennah ist — also dort, wo
 * sich tatsächlich ein Amboss ausbreiten kann. +SH zählt bewusst NICHT als
 * Cb-Signal: Schauerintensität allein belegt keinen vergletscherten Oberrand.
 */
function cbColumns(grid, cloudFrac, cloudBase, tropopauseLine, fogCols) {
  const { nk, times, pos, surface } = grid;
  const conv = convection.computeColumns(grid);
  const out = [];
  for (let i = 0; i < times.length; i++) {
    let maxAbsW = 0, deepTop = NaN;
    for (let k = 0; k < nk; k++) {
      const ix = i * nk + k;
      const w = grid.w[ix];
      if (Number.isFinite(w) && Math.abs(w) > maxAbsW) maxAbsW = Math.abs(w);
      if (cloudFrac[ix] >= CF_BKN && (grid.T[ix] - KELVIN) <= CB_GLACIATION_C) {
        const z = grid.z[ix];
        if (!Number.isFinite(deepTop) || z > deepTop) deepTop = z;
      }
    }
    const label = Number.isFinite(surface?.wcode?.[i])
      ? metarWeather(surface.wcode[i], fog.toPhenomenon(fogCols[i])) : "N/A";
    const wxThunder = label.includes("TS");
    const wxShower = label.includes("SH");
    const cape = surface?.cape ? surface.cape[i] : NaN;
    const capeSignal = Number.isFinite(cape) && cape >= CB_CAPE_MIN_JKG && Number.isFinite(deepTop);
    const updraftSignal = maxAbsW >= CB_UPDRAFT_MIN_MS;

    const c = conv[i];
    const anyTop = anyCloudTopAt(grid, cloudFrac, i);
    const top = Number.isFinite(c?.elZ) ? c.elZ
      : Number.isFinite(deepTop) ? deepTop
        : Number.isFinite(anyTop) ? anyTop : CB_FALLBACK_TOP_M;
    // Basis muss unter dem Oberrand liegen -- bei hochbasiger Konvektion ohne
    // EL kann der Fallback-Oberrand sonst unter dem CCL landen und der Schaft
    // würde invertiert gezeichnet. Dann lieber die allgemeine Wolkenbasis.
    const base = [c?.cclZ, cloudBase[i], 0].find((b) => Number.isFinite(b) && b < top) ?? 0;
    // Thermische Auslösung: T_2m erreicht die Auslösetemperatur (mit Zuschlag,
    // s. TRIGGER_EXCESS_K). Zusätzlich Mächtigkeit gefordert -- ein flaches
    // Cu-Feld ist noch keine TCU. Mit SH/TS im weather_code entfällt beides.
    const triggered = Number.isFinite(c?.taC) && c.tSfcC >= c.taC - TRIGGER_EXCESS_K;
    const thermalSignal = triggered && top - base >= TCU_MIN_DEPTH_M;

    if (!wxThunder && !wxShower && !thermalSignal && !capeSignal && !updraftSignal) {
      out.push(null); continue;
    }

    // Towering-Hürde (s. TCU_MIN_ABOVE_FREEZING_M). TS im weather_code hebelt
    // sie aus: ein gemeldetes Gewitter ohne vereisten Oberrand ist ein
    // Widerspruch, in dem unsere Oberrand-Schätzung (Fallback-Kette bis hinab
    // zu CB_FALLBACK_TOP_M) die unsicherere Größe ist -- die Zelle ganz zu
    // unterschlagen wäre der größere Fehler.
    const freezingZ = convectiveFreezingHeightAt(grid, i);
    const towering = Number.isFinite(freezingZ) && top - freezingZ >= TCU_MIN_ABOVE_FREEZING_M;
    if (!towering && !wxThunder) {
      out.push(null); continue;
    }

    const topTC = tempAtHeight(grid, i, top);
    const glaciated = Number.isFinite(topTC) && topTC <= CB_GLACIATION_C;
    const tropZ = tropAt(tropopauseLine, pos[i]);
    const nearTropopause = Number.isFinite(tropZ) && tropZ - top < CB_TROPOPAUSE_GAP_M;
    const kind = wxThunder || (glaciated && nearTropopause) ? "cb" : "tcu";
    out.push({ base, top, kind });
  }
  return out;
}

/**
 * 0-°C-Grenze (m AGL) für die Towering-Prüfung. `freezingHeightAt` sucht die
 * Kreuzung von warm nach kalt und liefert NaN, wenn es keine gibt -- für den
 * Niederschlagsvorhang ist das richtig so (keine Schneefallgrenze im Bild),
 * hier braucht es eine Entscheidung: liegt schon der Boden im Frost, ist die
 * Grenze 0 m AGL und die ganze Wolke zählt als vereist. Bleibt das Profil bis
 * zum Gitterdeckel über 0 °C, gibt es keine Frostgrenze und damit auch keinen
 * vereisten Turm -- dann NaN, die Hürde schlägt zu.
 */
function convectiveFreezingHeightAt(grid, i) {
  const z = freezingHeightAt(grid, i);
  if (Number.isFinite(z)) return z;
  const { nk } = grid;
  for (let k = 0; k < nk; k++) {
    const T = grid.T[i * nk + k];
    if (Number.isFinite(T)) return T - KELVIN < 0 ? 0 : NaN;
  }
  return NaN;
}

/** Umgebungstemperatur (°C) in Höhe `zM` (m AGL), linear zwischen Levels. */
function tempAtHeight(grid, i, zM) {
  const { nk } = grid;
  let prevZ = NaN, prevT = NaN;
  for (let k = 0; k < nk; k++) {
    const ix = i * nk + k, z = grid.z[ix], T = grid.T[ix];
    if (!Number.isFinite(z) || !Number.isFinite(T)) continue;
    if (z >= zM) {
      if (!Number.isFinite(prevZ)) return T - KELVIN;
      const f = (zM - prevZ) / (z - prevZ);
      return prevT + f * (T - prevT) - KELVIN;
    }
    prevZ = z; prevT = T;
  }
  return Number.isFinite(prevT) ? prevT - KELVIN : NaN; // oberhalb des Gitters
}

/** Tropopausenhöhe zur Zeit `t` aus der (ggf. lückenhaften) Polylinie;
 *  NaN außerhalb des erfassten Bereichs. Spiegelt `tropAt()` in render.js —
 *  dort für die Amboss-Platzierung, hier für die TCU/Cb-Abgrenzung. */
function tropAt(line, t) {
  if (!line || line.length < 2) return NaN;
  if (t <= line[0].t) return line[0].t === t ? line[0].z : NaN;
  for (let i = 1; i < line.length; i++) {
    if (line[i].t >= t) {
      const a = line[i - 1], b = line[i];
      if (t - a.t > 2 * (b.t - a.t || 1)) return NaN; // Lücke in der Linie
      const f = (t - a.t) / (b.t - a.t);
      return a.z + f * (b.z - a.z);
    }
  }
  return NaN;
}
