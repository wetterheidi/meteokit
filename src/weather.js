import { SURFACE_API_BASE, getModel, SURFACE_CORE, SURFACE_OPTIONAL, elevationApiBases } from "./config.js";
import { fetchWithFallback, fetchJsonWithFallback, modelApiBases } from "./apifetch.js";

/**
 * Zeithorizont eines Forecast-Requests als Query-Parameter: eine Zahl wird
 * wie bisher zu `forecast_days` (Fenster ab jetzt), ein Objekt
 * `{ startDate, endDate }` ("YYYY-MM-DD", UTC) zu `start_date`/`end_date` --
 * nötig für Zeitfenster in der Vergangenheit (Rückwärtstrajektorien im
 * GRAMET-Path-Modus, s. `gramet/path.js`), die `forecast_days` nicht
 * abdecken kann. Die beiden Formen schließen sich API-seitig aus, deshalb
 * wird immer nur eine gesendet.
 */
export function horizonParams(horizon) {
  return horizon && typeof horizon === "object"
    ? { start_date: horizon.startDate, end_date: horizon.endDate }
    : { forecast_days: String(horizon) };
}

/**
 * Holt die stündlichen Oberflächen-/Standardvariablen (limitierende Faktoren)
 * für einen Punkt über den Vorhersagehorizont. Optionale Variablen, die das
 * Modell nicht anbietet, werden bei einem Fehler automatisch weggelassen.
 * `horizon`: Vorhersagetage (Zahl) oder Datumsbereich, s. `horizonParams()`.
 *
 * Quellen (s. config.js, SURFACE_API_BASE):
 *  1. Primär die Modelllevel-Hosts (`modelApiBases(model)`, neuer Server
 *     zuerst) -- Single-Level-Felder desselben Laufs wie die Modelllevel-Daten.
 *  2. Felder, die dort durchgehend null sind (z. B. precipitation_probability),
 *     werden gezielt von der öffentlichen Instanz ergänzt.
 *  3. Liefert die ganze Host-Kette nichts Brauchbares, kommt alles von der
 *     öffentlichen Instanz (bisheriges Verhalten).
 *
 * Geländehöhe: `elevation` im Ergebnis ist die DEM90-Höhe des Punkts (Basis
 * u. a. für den Orographie-Vergleich Modell vs. Gelände). Der neue Server hat
 * kein DEM und würde ohne Vorgabe auf die Modellhöhe rechnen -- deshalb wird
 * die DEM-Höhe vorab geholt (`elevationApiBases()`) und als `elevation`
 * mitgeschickt, so dass auch das T2m-Downscaling wie bisher auf die echte
 * Geländehöhe erfolgt (Stichprobe: dann wertgleich mit der öffentlichen
 * Instanz). Schlägt der DEM-Abruf fehl, bleibt es bei der Server-Höhe und
 * `elevationIsDem` ist false.
 *
 * Rückgabe: { time: number[] (unixtime, s), units: {}, vars: { name: (number|null)[] },
 *   elevation, elevationIsDem, nights, varSources: { name: host } }
 */
export async function fetchSurface(lat, lon, modelKey, horizon, fetchImpl = fetch.bind(globalThis)) {
  const model = getModel(modelKey);
  const dem = await fetchDemElevation(lat, lon, fetchImpl);

  const query = (vars) => {
    const params = new URLSearchParams({
      latitude: round5(lat),
      longitude: round5(lon),
      hourly: vars.join(","),
      daily: "sunrise,sunset",
      models: model.apiModel,
      timeformat: "unixtime",
      ...horizonParams(horizon),
      cell_selection: "nearest",
    });
    if (dem != null) params.set("elevation", String(dem));
    return `/v1/forecast?${params}`;
  };
  // Ein Host "liefert", wenn die Kernvariable echte Werte hat -- ein Host mit
  // kaputter Ingestion antwortet sonst mit HTTP 200 und lauter null.
  const hasData = (d) => (d.hourly?.temperature_2m || []).some(Number.isFinite);

  // Erst mit allen Variablen versuchen; scheitert der Request an einer nicht
  // verfügbaren Optionalen, ohne die Kernvariablen erneut anfragen.
  const allVars = [...SURFACE_CORE, ...SURFACE_OPTIONAL];
  const primaryBases = modelApiBases(model);
  let data = null;
  let host = null;
  for (const vars of [allVars, SURFACE_CORE]) {
    try {
      ({ data, base: host } = await fetchJsonWithFallback(primaryBases, query(vars), {
        fetchImpl, sourceKey: "surface", validate: hasData, withBase: true,
      }));
      break;
    } catch { /* nächste Variante / öffentliche Instanz */ }
  }
  if (!data) {
    data = await tryFetch(`${SURFACE_API_BASE}${query(allVars)}`, fetchImpl)
      || await tryFetch(`${SURFACE_API_BASE}${query(SURFACE_CORE)}`, fetchImpl);
    host = SURFACE_API_BASE;
  }
  if (!data) throw new Error("Oberflächendaten konnten nicht geladen werden");

  const varSources = {};
  for (const key of Object.keys(data.hourly || {})) if (key !== "time") varSources[key] = host;

  // Auf dem Primärhost durchgehend leere Felder von der öffentlichen Instanz
  // ergänzen (nur diese Felder -- spart Kontingent der gemeterten Instanz).
  if (host !== SURFACE_API_BASE) {
    const empty = allVars.filter((v) => !(data.hourly?.[v] || []).some(Number.isFinite));
    if (empty.length) {
      const extra = await tryFetch(`${SURFACE_API_BASE}${query(empty)}`, fetchImpl);
      if (extra) mergeHourly(data, extra, empty, varSources, SURFACE_API_BASE);
    }
  }

  const hourly = data.hourly || {};
  const time = hourly.time || [];
  const vars = {};
  for (const key of Object.keys(hourly)) {
    if (key === "time") continue;
    vars[key] = hourly[key];
  }
  // Sonnenauf-/-untergänge (unixtime, s) für die Nachtschattierung.
  const daily = data.daily || {};
  const nights = [];
  const sr = daily.sunrise || [], ss = daily.sunset || [];
  for (let i = 0; i < Math.min(sr.length, ss.length); i++) {
    nights.push({ sunrise: sr[i], sunset: ss[i] });
  }

  // `time` reicht immer bis zum angefragten forecast_days-Horizont, auch wenn
  // das Modell (z. B. ICON-D2, ~48 h) real kürzer vorhersagt — die API füllt
  // den Rest der Kernvariable mit null statt das Array zu kürzen. Auf den
  // echten Modellhorizont zurückschneiden, sonst zeigen Meteogramm & Co. eine
  // "leere" Verlängerung bis zum gewählten Zeithorizont.
  const cut = vars.temperature_2m ? lastFiniteIndex(vars.temperature_2m) + 1 : time.length;
  const trim = (arr) => (cut < arr.length ? arr.slice(0, cut) : arr);
  const trimmedVars = {};
  for (const key of Object.keys(vars)) trimmedVars[key] = trim(vars[key]);

  return {
    time: trim(time),
    units: data.hourly_units || {},
    vars: trimmedVars,
    elevation: dem ?? data.elevation,
    elevationIsDem: dem != null,
    nights,
    varSources,
  };
}

/**
 * Initialisierungszeitpunkt des aktuell verfügbaren Modelllaufs (z. B.
 * der "00-UTC-Lauf"), unabhängig von Ort/Höhe. Quelle: der Modelllevel-Host
 * (`model.apiBase`, bei Ausfall `model.apiFallbacks`, siehe config.js) — deren statisches Meta-JSON je Datensatz liefert
 * `last_run_initialisation_time` (unixtime s). Nicht die öffentliche
 * OpenMeteo-Instanz (`SURFACE_API_BASE`); "Open-Meteo" bezeichnet hier nur
 * das API-/Datenformat, das auch Michaels Server verwenden.
 * Liefert null bei Fehler (z. B. Netzwerk), damit der Infobutton im Panel
 * nicht das gesamte Laden blockiert.
 */
export async function fetchModelRunInit(modelKey, fetchImpl = fetch.bind(globalThis)) {
  const model = getModel(modelKey);
  try {
    const resp = await fetchWithFallback(modelApiBases(model), `/data/${model.dataset}/static/meta.json`, {
      fetchImpl, sourceKey: model.apiModel,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return Number.isFinite(data.last_run_initialisation_time) ? data.last_run_initialisation_time : null;
  } catch {
    return null;
  }
}

/**
 * Ergänzt `names` in `data.hourly` aus `extra.hourly`, zeitstempelgenau (die
 * Zeitachsen beider Instanzen sind bei gleichem Horizont identisch, aber
 * nicht darauf verlassen). Nur Felder, die in `extra` echte Werte haben.
 */
function mergeHourly(data, extra, names, varSources, host) {
  const t = data.hourly?.time || [];
  const et = extra.hourly?.time || [];
  const idx = new Map(et.map((ts, i) => [ts, i]));
  for (const name of names) {
    const src = extra.hourly?.[name];
    if (!src || !src.some(Number.isFinite)) continue;
    data.hourly[name] = t.map((ts) => (idx.has(ts) ? src[idx.get(ts)] ?? null : null));
    if (extra.hourly_units?.[name]) (data.hourly_units ||= {})[name] = extra.hourly_units[name];
    varSources[name] = host;
  }
}

// DEM90-Höhe je Punkt (statisch) -- im Speicher gecacht, weil fetchSurface
// z. B. beim Neuladen/Modellwechsel wiederholt für denselben Punkt läuft.
const demCache = new Map();
async function fetchDemElevation(lat, lon, fetchImpl) {
  const key = `${round5(lat)},${round5(lon)}`;
  if (demCache.has(key)) return demCache.get(key);
  const first = (d) => (Array.isArray(d.elevation) ? d.elevation[0] : d.elevation);
  try {
    const params = new URLSearchParams({ latitude: round5(lat), longitude: round5(lon) });
    const d = await fetchJsonWithFallback(elevationApiBases(), `/v1/elevation?${params}`, {
      fetchImpl, sourceKey: "elevation", validate: (x) => Number.isFinite(first(x)),
    });
    demCache.set(key, first(d));
    return first(d);
  } catch {
    return null; // nicht cachen -- nächster Aufruf versucht es erneut
  }
}

async function tryFetch(url, fetchImpl) {
  try {
    const resp = await fetchImpl(url);
    const body = await resp.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return null; // Fehler als Klartext -> Fallback
    }
    if (!resp.ok || data.error) return null;
    return data;
  } catch {
    return null;
  }
}

/** Index der Zeitreihe, der der Wanduhr am nächsten liegt (nie in der
 *  Vergangenheit, solange Zukunft vorhanden ist). */
export function nearestFutureIndex(timeSec, nowMs = Date.now()) {
  const now = nowMs / 1000;
  if (!timeSec.length) return -1;
  for (let i = 0; i < timeSec.length; i++) {
    if (timeSec[i] >= now - 1800) return i; // bis 30 min zurück gilt noch als "jetzt"
  }
  return timeSec.length - 1;
}

/** Index der Zeitreihe, der einem beliebigen Zeitpunkt am nächsten liegt
 *  (symmetrisch, darf in der Vergangenheit landen). Für die Masterzeit: das
 *  Stundenraster des Modells rastet auf die nächste verfügbare Stunde. */
export function nearestIndex(timeSec, tMs) {
  if (!timeSec.length) return -1;
  const t = tMs / 1000;
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < timeSec.length; i++) {
    const diff = Math.abs(timeSec[i] - t);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
    else if (timeSec[i] > t) break; // Zeitreihe ist aufsteigend – ab hier nur größer
  }
  return best;
}

/** Wie `nearestIndex`, aber liefert `null` statt eines (ggf. weit entfernten)
 *  Index, wenn keine Zeit innerhalb `toleranceSec` liegt. Zum robusten
 *  Abgleichen zweier unabhängig auf ihren jeweils echten Horizont getrimmter
 *  Zeitreihen (z. B. Modell-Level-Säule `column.js` vs. Oberflächenreihe
 *  hier) — bei ICON Global enden die Level-Daten real bei +36 h, die
 *  Oberflächenwerte laufen über die volle Modelllaufzeit weiter. */
export function nearestIndexOrNull(timeSec, tMs, toleranceSec = 1800) {
  if (!timeSec.length) return null;
  const i = nearestIndex(timeSec, tMs);
  return i >= 0 && Math.abs(timeSec[i] - tMs / 1000) <= toleranceSec ? i : null;
}

function round5(x) {
  return Math.round(x * 1e5) / 1e5;
}

/** Letzter Index, an dem mindestens eine der übergebenen Kernreihen noch einen
 *  endlichen Wert hat — jenseits davon liefert das Modell nur noch null (der
 *  angefragte forecast_days-Horizont reicht weiter als der reale Modelllauf).
 *  Genutzt, um Zeitreihen auf den tatsächlich verfügbaren Zeitraum zu kürzen. */
export function lastFiniteIndex(...arrays) {
  let last = -1;
  for (const arr of arrays) {
    if (!arr) continue;
    for (let i = arr.length - 1; i > last; i--) {
      if (Number.isFinite(arr[i])) { last = i; break; }
    }
  }
  return last;
}
