/**
 * Host-Fallback für die Open-Meteo-Instanzen (`meteokit/apifetch`).
 *
 * Seit 2026-09 liegen ICON-D2/-EU/-Global auf einem neuen Server
 * (`API_BASE` in config.js); die bisherigen Instanzen bleiben als Fallback
 * (`model.apiFallbacks`). Alle Instanzen sind identisch aufgebaut -- nur die
 * Basis-URL unterscheidet sich --, also kann jeder Request unverändert gegen
 * den nächsten Host wiederholt werden.
 *
 * Fällt ein Host für einen Endpunkt aus (Netzwerkfehler, HTTP ≠ 2xx, bei
 * `fetchJsonWithFallback` zusätzlich unlesbares JSON / `error` / Validierung
 * fehlgeschlagen), rückt er für COOLDOWN_MS ans Ende der Reihenfolge -- so
 * zahlt nicht jeder Folge-Request den Umweg über einen toten Host, und nach
 * Ablauf wird der bevorzugte Host automatisch wieder zuerst probiert. Der
 * Schlüssel ist Host + Pfad + `sourceKey`, weil Ausfälle endpunkt- bzw.
 * modellspezifisch sein können (z. B. neuer Server ohne DEM90 → nur
 * `/v1/elevation` betroffen; ICON Global auf einem Host kaputt, D2 nicht).
 *
 * Zusätzlich wird je `sourceKey` festgehalten, welcher Host zuletzt
 * erfolgreich geliefert hat (`getApiSources`/`onApiSourceChange`) -- damit
 * eine App anzeigen kann, woher die Daten tatsächlich stammen.
 */

const COOLDOWN_MS = 5 * 60 * 1000;
const failedAt = new Map(); // `${base}|${path}|${sourceKey}` -> Zeitstempel
const sources = new Map(); // sourceKey -> { key, base, preferred, fallback, at }
const listeners = new Set();

const isAbort = (err, signal) => signal?.aborted || err?.name === "AbortError";
const failKey = (base, path, sourceKey) => `${base}|${path}|${sourceKey ?? ""}`;

/** Bevorzugter Host + Fallbacks eines Modells, ohne Duplikate. */
export function modelApiBases(model) {
  return [...new Set([model.apiBase, ...(model.apiFallbacks || [])].filter(Boolean))];
}

function orderBases(bases, path, sourceKey) {
  const now = Date.now();
  const healthy = [];
  const cooling = [];
  for (const b of new Set(bases.filter(Boolean))) {
    const t = failedAt.get(failKey(b, path, sourceKey));
    (t != null && now - t < COOLDOWN_MS ? cooling : healthy).push(b);
  }
  return [...healthy, ...cooling];
}

function markFailed(base, path, sourceKey) {
  failedAt.set(failKey(base, path, sourceKey), Date.now());
}

function recordSource(sourceKey, base, bases, path) {
  failedAt.delete(failKey(base, path, sourceKey));
  if (sourceKey == null) return;
  const preferred = bases[0];
  const prev = sources.get(sourceKey);
  const entry = { key: sourceKey, base, preferred, fallback: base !== preferred, at: Date.now() };
  sources.set(sourceKey, entry);
  if (prev?.base !== base) for (const cb of listeners) cb(entry, getApiSources());
}

/**
 * Wie `fetch(base + pathAndQuery)`, aber über mehrere Hosts in
 * Prioritätsreihenfolge. Gibt die erste erfolgreiche (2xx) Response zurück.
 * Schlagen alle fehl, kommt die letzte Fehler-Response zurück (damit der
 * Aufrufer wie bisher Status/`reason` auswerten kann) bzw. -- wenn kein Host
 * überhaupt geantwortet hat -- wird der letzte Netzwerkfehler geworfen.
 * Abbrüche (AbortSignal) werden nie auf den nächsten Host umgeleitet.
 *
 * @param {string[]} bases        Hosts, bevorzugter zuerst.
 * @param {string} pathAndQuery   z. B. "/v1/forecast?latitude=…"
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl]  Default: globales fetch.
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.sourceKey]    Schlüssel für Quellenanzeige/Cooldown
 *   (z. B. Modellschlüssel "icon_d2" oder "elevation").
 */
export async function fetchWithFallback(bases, pathAndQuery, { fetchImpl, signal, sourceKey } = {}) {
  const doFetch = fetchImpl || fetch.bind(globalThis);
  const path = pathAndQuery.split("?")[0];
  let lastResp = null;
  let lastErr = null;
  for (const base of orderBases(bases, path, sourceKey)) {
    try {
      const resp = await doFetch(`${base}${pathAndQuery}`, signal ? { signal } : undefined);
      if (resp.ok) {
        recordSource(sourceKey, base, bases, path);
        return resp;
      }
      lastResp = resp;
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      lastErr = err;
    }
    markFailed(base, path, sourceKey);
  }
  if (lastResp) return lastResp;
  throw lastErr || new Error("Kein API-Host konfiguriert");
}

/**
 * Wie `fetchWithFallback`, liefert aber direkt das geparste JSON und weicht
 * zusätzlich aus, wenn die Antwort kein gültiges JSON ist, ein `error`-Feld
 * trägt oder `validate(data)` false liefert (Beispiel: der neue Server
 * antwortet auf `/v1/elevation` mit `{"elevation":[nan]}` -- HTTP 200, aber
 * kein JSON). Wirft, wenn kein Host brauchbare Daten liefert.
 * Mit `withBase: true` kommt `{ data, base }` zurück (liefernder Host) --
 * nötig, wenn parallele Abrufe den Host je Ergebnis kennen müssen.
 */
export async function fetchJsonWithFallback(bases, pathAndQuery, { fetchImpl, signal, sourceKey, validate, withBase } = {}) {
  const doFetch = fetchImpl || fetch.bind(globalThis);
  const path = pathAndQuery.split("?")[0];
  let lastErr = null;
  for (const base of orderBases(bases, path, sourceKey)) {
    try {
      const resp = await doFetch(`${base}${pathAndQuery}`, signal ? { signal } : undefined);
      const body = await resp.text();
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error(`Serverfehler: ${body.slice(0, 180)}`);
      }
      if (!resp.ok || data.error) {
        const e = new Error(data.reason ? `API-Fehler: ${String(data.reason).slice(0, 180)}` : `API-Fehler ${resp.status}`);
        e.status = resp.status;
        throw e;
      }
      if (validate && !validate(data)) throw new Error("Unbrauchbare Antwort");
      recordSource(sourceKey, base, bases, path);
      return withBase ? { data, base } : data;
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      lastErr = err;
    }
    markFailed(base, path, sourceKey);
  }
  throw lastErr || new Error("Kein API-Host konfiguriert");
}

/** Zuletzt erfolgreich genutzter Host je `sourceKey`. */
export function getApiSources() {
  return [...sources.values()];
}

/** Callback bei Wechsel des liefernden Hosts; gibt eine Abmeldefunktion zurück. */
export function onApiSourceChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
