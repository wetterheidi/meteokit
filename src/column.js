/**
 * Vertikale Säule am Operationspunkt: holt alle Modell-Level (u, v, T, Höhe)
 * in einem Request und interpoliert sie auf ein logarithmisches Höhengitter —
 * die Datengrundlage der Cross-Sections. Wind wird intern in m/s, Temperatur
 * in °C geführt (Anzeige-Einheiten via units.js im Renderer).
 */

import { getModel } from "./config.js";
import { cloudFraction } from "./clouds.js";
import { lastFiniteIndex, horizonParams } from "./weather.js";

const KMH_TO_MS = 1 / 3.6;

// Kern-Level-Variablen (immer verfügbar) vs. optionale Wolken-Diagnose-Felder
// (cloud_water/ice/cover_level{l} — Michaels direktes Modell-Output, erst seit
// 2026 auf beiden Instanzen live). Scheitert der Request mit den optionalen
// Feldern, wird einmalig ohne sie wiederholt (Muster wie SURFACE_OPTIONAL in
// weather.js) — der Sundqvist-Fallback in clouds.js greift dann automatisch.
function levelVars(nLevels, includeCloudDiag) {
  // pressure_msl (Meeresniveau, kein Level-Suffix): fürs GRAMET-Meteogramm
  // (SLP-Zeile) — kommt von derselben Instanz wie die Level-Daten, kein
  // separater Request nötig.
  const vars = ["pressure_msl"];
  for (let l = 1; l <= nLevels; l++) {
    vars.push(`wind_u_component_level${l}`, `wind_v_component_level${l}`,
      `temperature_level${l}`, `height_agl_level${l}`, `relative_humidity_level${l}`,
      `pressure_level${l}`, `wind_w_level${l}`, `specific_humidity_level${l}`);
    if (includeCloudDiag) {
      vars.push(`cloud_water_level${l}`, `cloud_ice_level${l}`, `cloud_cover_level${l}`);
    }
  }
  return vars;
}

// Transportseitige Fehler, bei denen ein zweiter Versuch Sinn ergibt -- allen
// voran 429: eine Säule ist eine schwere Anfrage (bis 120 Level x 11
// Variablen), und ein Pfad holt bis zu `maxCols` davon, da winkt die Instanz
// zwischendurch schon mal ab. Diese Unterscheidung MUSS vor dem
// Wolken-Fallback in `fetchColumn` greifen: der schickt sonst bei jedem
// beliebigen Fehler sofort eine zweite, gleich teure Anfrage hinterher --
// bei einer Überlastung genau das Falsche, und die daraus entstehende
// Fehlermeldung nennt dann auch noch die falsche Ursache.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRIES = 3;
const RETRY_BASE_MS = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryFetchColumn(lat, lon, model, horizon, vars, fetchImpl) {
  const params = new URLSearchParams({
    latitude: round5(lat), longitude: round5(lon),
    hourly: vars.join(","), models: model.apiModel,
    timeformat: "unixtime", ...horizonParams(horizon),
    cell_selection: "nearest",
  });
  let resp;
  try {
    resp = await fetchImpl(`${model.apiBase}/v1/forecast?${params}`);
  } catch (err) {
    // Netzwerkabbruch: genauso vorübergehend wie ein 503.
    return { error: `Netzwerkfehler: ${err.message}`, retryable: true };
  }
  const retryable = RETRYABLE_STATUS.has(resp.status);
  const retryAfterMs = Number(resp.headers?.get?.("retry-after")) * 1000 || 0;
  const body = await resp.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { error: `Serverfehler: ${body.slice(0, 150)}`, retryable, retryAfterMs };
  }
  if (!resp.ok || data.error) {
    return { error: apiErrorText(resp.status, data.reason), retryable, retryAfterMs };
  }
  return { data };
}

// Die nackte Statuszahl sagt niemandem etwas, der vor der Karte sitzt -- und
// gerade 429/503 sind die Fälle, in denen "nochmal in einer Minute" die
// richtige Handlungsanweisung ist statt "irgendwas ist kaputt".
function apiErrorText(status, reason) {
  if (status === 429) return "Server überlastet (zu viele Anfragen) — bitte kurz warten";
  if (status >= 500) return `Server vorübergehend nicht erreichbar (${status})`;
  if (reason) return `API: ${reason.slice(0, 150)}`;
  return `API-Fehler ${status}`;
}

/** `tryFetchColumn` mit Wiederholung bei vorübergehenden Fehlern (exponentiell
 *  wachsende Wartezeit plus Zufallsanteil, damit die parallel laufenden
 *  Säulen eines Pfades nicht im Gleichtakt erneut anklopfen). Ein `Retry-After`
 *  des Servers hat Vorrang vor der eigenen Schätzung. */
async function fetchColumnWithRetry(lat, lon, model, horizon, vars, fetchImpl) {
  let result;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    result = await tryFetchColumn(lat, lon, model, horizon, vars, fetchImpl);
    if (!result.error || !result.retryable || attempt === RETRIES) return result;
    const backoff = RETRY_BASE_MS * 2 ** attempt + Math.random() * RETRY_BASE_MS;
    await sleep(Math.max(result.retryAfterMs || 0, backoff));
  }
  return result;
}

/** Rohe Säule (Level von unten nach oben) am Punkt über den Zeithorizont --
 *  `horizon`: Vorhersagetage (Zahl, wie bisher) oder `{ startDate, endDate }`
 *  für einen expliziten Datumsbereich inkl. Vergangenheit (s. `weather.js`
 *  `horizonParams()`). */
export async function fetchColumn(lat, lon, modelKey, horizon, fetchImpl = fetch.bind(globalThis)) {
  const model = getModel(modelKey);

  let result = await fetchColumnWithRetry(lat, lon, model, horizon, levelVars(model.nLevels, true), fetchImpl);
  // Ohne die optionalen Wolkenfelder nur dann erneut versuchen, wenn der
  // Fehler wirklich an den Variablen liegen kann -- eine Überlastung (s.
  // `RETRYABLE_STATUS`) hat `fetchColumnWithRetry` bereits ausgesessen, ein
  // weiterer Versuch würde sie nur verlängern.
  if (result.error && !result.retryable) {
    result = await fetchColumnWithRetry(lat, lon, model, horizon, levelVars(model.nLevels, false), fetchImpl);
  }
  if (result.error) throw new Error(result.error);
  const data = result.data;

  const H = data.hourly, time = H.time, T = time.length;
  // Level von unten (l = nLevels, ~10 m) nach oben (l = 1) einsortieren.
  // wind_w (Vertikalgeschwindigkeit) kommt nativ in m/s (Faktor 1), anders als
  // u/v in km/h. specific_humidity q_v sowie cloud_water/ice (QW/QI) kommen in
  // g/kg → kg/kg (Faktor 0.001) für die Dampfdruck-/Kondensatrechnung
  // (clouds.js). cloud_cover (CLC) bleibt in % wie relative_humidity. Alle für
  // die Wolken-Diagnose — QW/QI/CLC fehlen (NaN), wenn die Instanz sie (noch)
  // nicht führt; clouds.js fällt dann automatisch auf die RH-Heuristik zurück.
  const h = [], u = [], v = [], t = [], rh = [], p = [], w = [], q = [], qw = [], qi = [], clc = [];
  for (let l = model.nLevels; l >= 1; l--) {
    h.push(toArr(H[`height_agl_level${l}`], T, 1));
    u.push(toArr(H[`wind_u_component_level${l}`], T, KMH_TO_MS));
    v.push(toArr(H[`wind_v_component_level${l}`], T, KMH_TO_MS));
    t.push(toArr(H[`temperature_level${l}`], T, 1));
    rh.push(toArr(H[`relative_humidity_level${l}`], T, 1));
    p.push(toArr(H[`pressure_level${l}`], T, 1));
    w.push(toArr(H[`wind_w_level${l}`], T, 1));
    q.push(toArr(H[`specific_humidity_level${l}`], T, 1e-3));
    qw.push(toArr(H[`cloud_water_level${l}`], T, 1e-3));
    qi.push(toArr(H[`cloud_ice_level${l}`], T, 1e-3));
    clc.push(toArr(H[`cloud_cover_level${l}`], T, 1));
  }
  const pmsl = toArr(H.pressure_msl, T, 1);

  // `time` reicht immer bis zum angefragten forecast_days-Horizont, auch wenn
  // das Modell (z. B. ICON-D2, ~48 h) real kürzer vorhersagt — die Level-
  // Variablen werden für die überzähligen Stunden nur mit null aufgefüllt statt
  // das Array zu kürzen. Auf den tatsächlichen LEVEL-Horizont zurückschneiden,
  // sonst zeigen GRAMET/Cross-Section eine "leere" Verlängerung bis zum
  // gewählten Zeithorizont. NUR das unterste Level als Indikator -- `pmsl`
  // (SLP) ist bei ICON Global KEIN verlässlicher Indikator: Michaels
  // Level-Server führt es (per Stichprobe 2026-08) über die volle
  // Modelllaufzeit weiter, während die eigentlichen Level-Variablen
  // (Temperatur/Druck/Wind) schon bei +36 h auf null springen -- mit `pmsl`
  // im Indikator würde der Cut fälschlich bis zum SLP-Horizont reichen.
  const cut = lastFiniteIndex(t[0]) + 1;
  const trim = (arr) => (cut < arr.length ? arr.slice(0, cut) : arr);
  const trimLevels = (byLevel) => (cut < T ? byLevel.map(trim) : byLevel);

  // `model` mitgeführt für modellspezifische Konstanten in clouds.js
  // (RH_CRIT_Z_REF unterscheidet sich zwischen ICON-D2/EU, s. dort).
  return {
    time: trim(time),
    h: trimLevels(h), u: trimLevels(u), v: trimLevels(v), t: trimLevels(t), rh: trimLevels(rh),
    p: trimLevels(p), w: trimLevels(w), q: trimLevels(q), qw: trimLevels(qw), qi: trimLevels(qi), clc: trimLevels(clc),
    pmsl: trim(pmsl), nLevels: h.length, elevation: data.elevation, model: modelKey,
  };
}

/**
 * Auf ein Höhengitter interpolierte Felder für die Cross-Section.
 * grid "log" (Standard, dicht am Boden) für die Gesamthöhe, "lin" (gleichmäßig)
 * für den Zoom bis zur Flughöhe mit feiner vertikaler Auflösung.
 * @returns { time, targetH (m AGL, aufsteigend), spd[k][i] (m/s), dir[k][i] (° Herkunft),
 *            temp[k][i] (°C), freezing[i] (m AGL | null) }
 */
export function buildField(col, capM = 8000, nTarget = 44, grid = "log") {
  const { time, h, u, v, t, rh, w, p, q, qw, qi, clc, model } = col;
  const T = time.length;
  const hMin = Math.max(10, firstFinite(h[0]) || 10);
  const targetH = grid === "lin" ? linspace(hMin, capM, nTarget) : logspace(hMin, capM, nTarget);

  // Richtung/Betrag je REALEM Level einmal ableiten, dann getrennt auf die
  // Zielhöhen interpolieren: Betrag linear, Richtung über den kürzeren Bogen
  // (`lerpAngle`) -- NICHT rohe u/v-Interpolation mit anschließender
  // Ableitung (frühere Version). Grund (s. Nutzerfeedback): bei zwei ähnlich
  // schwachen, aber entgegengesetzt gerichteten Leveln verläuft die Gerade in
  // u/v-Raum nahe am Nullpunkt -- das erfindet eine Flaute zwischen den
  // Leveln, die die Daten nicht hergeben (Artefakt in der Farbfläche), und
  // macht die gezeichnete Drehrichtung vom Zufall der Vektorgeometrie
  // abhängig statt einer bewussten "kürzerer Weg"-Wahl. Dieselbe Korrektur
  // wie in windspinne.js.
  const nLevels = u.length;
  const dirLv = [], spdLv = [];
  for (let k = 0; k < nLevels; k++) {
    dirLv.push(new Float64Array(T));
    spdLv.push(new Float64Array(T));
    for (let i = 0; i < T; i++) {
      spdLv[k][i] = Math.hypot(u[k][i], v[k][i]);
      dirLv[k][i] = (Math.atan2(-u[k][i], -v[k][i]) * 180 / Math.PI + 360) % 360;
    }
  }

  const spd = [], dir = [], temp = [], rhc = [], cloud = [];
  for (let k = 0; k < nTarget; k++) {
    spd.push(new Float64Array(T)); dir.push(new Float64Array(T)); temp.push(new Float64Array(T));
    rhc.push(new Float64Array(T)); cloud.push(new Float64Array(T));
  }
  const freezing = new Float64Array(T).fill(NaN);

  for (let i = 0; i < T; i++) {
    // Höhen dieser Stunde von unten nach oben.
    const hi = h.map((a) => a[i]);
    for (let k = 0; k < nTarget; k++) {
      const br = bracket(hi, targetH[k]);
      const tt = lerp(t, br, i), rr = lerp(rh, br, i);
      const ww = w ? lerp(w, br, i) : NaN;
      const pp = p ? lerp(p, br, i) : NaN, qq = q ? lerp(q, br, i) : NaN;
      const qwq = qw ? lerp(qw, br, i) : NaN, qiq = qi ? lerp(qi, br, i) : NaN;
      const clcq = clc ? lerp(clc, br, i) : NaN;
      spd[k][i] = lerp(spdLv, br, i);
      dir[k][i] = lerpAngle(dirLv[br.k0][i], dirLv[br.k1][i], br.f);
      temp[k][i] = tt;
      rhc[k][i] = rr;
      cloud[k][i] = cloudFraction({ q: qq, p: pp, t: tt, rh: rr, qw: qwq, qi: qiq, clc: clcq, model }, targetH[k], ww);
    }
    // Nullgradgrenze: unterster Übergang T ≥ 0 → < 0 nach oben.
    freezing[i] = zeroCrossing(hi, t, i);
  }
  return { time, targetH, spd, dir, temp, rh: rhc, cloud, freezing };
}

/**
 * Rohe Säule zur Stunde `i` linear auf die AGL-Zielhöhe `ht` (m) interpolieren.
 * T/RH linear, Druck logarithmisch in der Höhe, Wind als Richtung (kürzerer
 * Bogen, `lerpAngle`) + Betrag (linear) statt roher u/v-Interpolation (s.
 * `buildField` Doc-Kommentar für den Grund). Unter dem untersten Level wird
 * geklammert (wie in windfield.js). Wind in m/s, T/RH/p in SI/hPa.
 */
export function sampleColumnAtHeight(col, i, ht) {
  const hi = col.h.map((a) => a[i]);
  const br = bracket(hi, ht);
  const val = (byLevel) => (byLevel ? lerp(byLevel, br, i) : null);
  let p = null;
  if (col.p) {
    const a = col.p[br.k0][i], b = col.p[br.k1][i];
    p = a > 0 && b > 0
      ? Math.exp(Math.log(a) + br.f * (Math.log(b) - Math.log(a)))
      : lerp(col.p, br, i);
  }
  const dirAt = (k) => (Math.atan2(-col.u[k][i], -col.v[k][i]) * 180 / Math.PI + 360) % 360;
  const spdAt = (k) => Math.hypot(col.u[k][i], col.v[k][i]);
  return {
    h: ht,
    dir: lerpAngle(dirAt(br.k0), dirAt(br.k1), br.f),
    spd: spdAt(br.k0) + br.f * (spdAt(br.k1) - spdAt(br.k0)),
    t: val(col.t), rh: val(col.rh), p, w: val(col.w), q: val(col.q),
    qw: val(col.qw), qi: val(col.qi), clc: val(col.clc), model: col.model,
  };
}

/** Kürzester Bogen zwischen zwei Windrichtungen (Grad, 0-360): Δ auf ±180°
 *  geklammert, bevor interpoliert wird -- s. `buildField` Doc-Kommentar.
 *  Dieselbe Funktion (bewusst separat gehalten, kein Modul-Import) auch in
 *  `windspinne.js`. */
export function lerpAngle(a0, a1, f) {
  const delta = ((a1 - a0 + 540) % 360) - 180;
  return (a0 + delta * f + 360) % 360;
}

/**
 * Säule (mehrere Tage, ein Ort) auf einen einzelnen Levelquerschnitt zur
 * Zielzeit `tTargetSec` reduziert -- für den GRAMET-Path-Modus (`grid.js`
 * `gridFromWaypoints`, `resample.js` `resamplePath`), wo pro Wegpunkt eine
 * eigene Mehrstunden-Säule geholt, aber nur ein Zeitpunkt daraus gebraucht
 * wird. Echte lineare Zeitinterpolation zwischen den beiden Nachbarstunden
 * in `col.time` (`bracketTime`, gleiches Bracket/Lerp-Muster wie `bracket()`/
 * `lerp()` oben für die Höhe) -- außerhalb des abgedeckten Zeitraums wird auf
 * den jeweiligen Rand geklammert.
 */
export function sliceColumnAtTime(col, tTargetSec) {
  if (!col.time.length) return null;
  const { i0, i1, f } = bracketTime(col.time, tTargetSec);
  const nk = col.nLevels;
  const pick = (byLevel) => {
    if (!byLevel) return null;
    const out = new Float64Array(nk);
    for (let k = 0; k < nk; k++) {
      const a = byLevel[k][i0], b = byLevel[k][i1];
      out[k] = a + f * (b - a);
    }
    return out;
  };
  return {
    h: pick(col.h), u: pick(col.u), v: pick(col.v), t: pick(col.t), rh: pick(col.rh),
    p: pick(col.p), w: pick(col.w), q: pick(col.q), qw: pick(col.qw), qi: pick(col.qi), clc: pick(col.clc),
  };
}

// --- Helfer ----------------------------------------------------------------

function bracket(hi, ht) {
  const L = hi.length;
  if (ht <= hi[0]) return { k0: 0, k1: 0, f: 0 };
  let k = 1;
  while (k < L && hi[k] < ht) k++;
  if (k >= L) return { k0: L - 1, k1: L - 1, f: 0 };
  const f = (ht - hi[k - 1]) / (hi[k] - hi[k - 1]);
  return { k0: k - 1, k1: k, f };
}
function lerp(arrByLevel, br, i) {
  const a = arrByLevel[br.k0][i], b = arrByLevel[br.k1][i];
  return a + br.f * (b - a);
}
// Wie `bracket()`, nur auf der Zeitachse statt der Höhe -- Ränder klammern
// statt zu extrapolieren (Ziel außerhalb der Säule => nächstliegende Stunde).
function bracketTime(time, t) {
  const T = time.length;
  if (t <= time[0]) return { i0: 0, i1: 0, f: 0 };
  let i = 1;
  while (i < T && time[i] < t) i++;
  if (i >= T) return { i0: T - 1, i1: T - 1, f: 0 };
  const f = (t - time[i - 1]) / (time[i] - time[i - 1]);
  return { i0: i - 1, i1: i, f };
}
function zeroCrossing(hi, tByLevel, i) {
  for (let k = 0; k < hi.length - 1; k++) {
    const t0 = tByLevel[k][i], t1 = tByLevel[k + 1][i];
    if (t0 >= 0 && t1 < 0) {
      const f = t0 / (t0 - t1);
      return hi[k] + f * (hi[k + 1] - hi[k]);
    }
  }
  return NaN; // durchweg über oder unter 0 im Fenster
}

function logspace(a, b, n) {
  const la = Math.log(a), lb = Math.log(b), out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.exp(la + (lb - la) * i / (n - 1));
  return out;
}
function linspace(a, b, n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = a + (b - a) * i / (n - 1);
  return out;
}
function toArr(src, T, factor) {
  const out = new Float64Array(T);
  for (let i = 0; i < T; i++) out[i] = src?.[i] == null ? NaN : src[i] * factor;
  return out;
}
function firstFinite(a) { for (const x of a) if (Number.isFinite(x)) return x; return null; }
function round5(x) { return Math.round(x * 1e5) / 1e5; }
