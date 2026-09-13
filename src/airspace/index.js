/**
 * Weltweiter Luftraum-Overlay (openAIP-Daten). Läuft ausschließlich gegen
 * einen eigenen Cache-Server (statische, in Grid-Zellen aufgeteilte GeoJSON-
 * Dateien, monatlich per Cronjob aus openAIPs Core-API gezogen --
 * `tools/airspace-cache/`) statt gegen openAIPs Live-API: Deren
 * `/api/airspaces`-bbox-Endpunkt ist laut eigener Doku "mainly intended for
 * export use-cases, not for regular queries" und antwortet bei größeren
 * Bboxen mit 408/429 -- bei 429 sogar ohne CORS-Header, was der Browser als
 * undurchsichtigen "Failed to fetch" statt eines lesbaren Status meldet.
 * Live-Viewport-Abfragen aus dem Browser sind damit nicht robust machbar
 * (verifiziert 2026-09-12 in DZMaster, dort wieder ausgebaut).
 *
 * `L` (der Leaflet-Namespace) wird als Parameter übergeben statt importiert:
 * meteokit hat bewusst keine Abhängigkeiten, alle einbettenden Apps laden
 * Leaflet bereits per CDN-Script-Tag als globales `L`.
 */

import { airspaceStyle, airspacePopup } from "./style.js";

const DEFAULT_BASE_URL = "https://airspace.wetterheidi.de";

/** Alle Grid-Zellschlüssel ("{latFloor}_{lonFloor}"), die die Bounds schneiden. */
function cellsForBounds(bounds, cellSizeDeg) {
  const keys = [];
  const latStart = Math.floor(bounds.getSouth() / cellSizeDeg) * cellSizeDeg;
  const lonStart = Math.floor(bounds.getWest() / cellSizeDeg) * cellSizeDeg;
  for (let lat = latStart; lat < bounds.getNorth(); lat += cellSizeDeg) {
    for (let lon = lonStart; lon < bounds.getEast(); lon += cellSizeDeg) {
      keys.push(`${lat}_${lon}`);
    }
  }
  return keys;
}

/**
 * Erstellt den Overlay. Gibt `{ group, attach, detach }` zurück -- `group`
 * wird als Overlay-Control-Eintrag registriert, `attach`/`detach` beim
 * `overlayadd`/`overlayremove`-Event der Host-Karte aufgerufen (dasselbe
 * Enable/Disable-Muster wie z.B. DZMasters Radar-Overlay).
 *
 * Kein Rate-Limit, keine Zoom-/Bbox-Gates nötig (anders als beim verworfenen
 * Live-Ansatz) -- der Cache-Server liefert statische Dateien. Einmal
 * geladene Zellen bleiben für die Dauer der Session im Speicher (auch
 * 404-Zellen, als "keine Daten hier"-Marker), keine Eviction nötig.
 *
 * @param {typeof globalThis.L} leaflet - die Leaflet-Namespace-Instanz (`window.L`)
 * @param {{ baseUrl?: string }} [options]
 */
export function createAirspaceOverlay(leaflet, options = {}) {
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const group = leaflet.layerGroup();
  const loadedCells = new Set();
  let cellSizeDeg = null; // aus meta.json, erst nach dem ersten attach() bekannt
  let moveHandler = null;

  async function ensureMeta() {
    if (cellSizeDeg != null) return;
    const res = await fetch(`${baseUrl}/meta.json`);
    if (!res.ok) throw new Error(`meta.json: HTTP ${res.status}`);
    cellSizeDeg = (await res.json()).cellSizeDeg;
  }

  async function loadCell(key) {
    if (loadedCells.has(key)) return;
    loadedCells.add(key);
    try {
      const res = await fetch(`${baseUrl}/tiles/${key}.geojson`);
      if (res.status === 404) return; // Zelle ohne Luftraumdaten -- kein Fehler
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geojson = await res.json();
      leaflet.geoJSON(geojson, {
        style: airspaceStyle,
        onEachFeature: (feature, layer) => layer.bindPopup(airspacePopup(feature)),
      }).addTo(group);
    } catch (err) {
      loadedCells.delete(key); // Netzwerkfehler: beim nächsten moveend erneut versuchen
      console.warn(`meteokit/airspace: Zelle ${key} konnte nicht geladen werden:`, err);
    }
  }

  async function loadVisibleCells(map) {
    try {
      await ensureMeta();
    } catch (err) {
      console.warn("meteokit/airspace: meta.json nicht erreichbar, Overlay bleibt leer:", err);
      return;
    }
    for (const key of cellsForBounds(map.getBounds(), cellSizeDeg)) loadCell(key);
  }

  return {
    group,
    attach(map) {
      moveHandler = () => loadVisibleCells(map);
      map.on("moveend", moveHandler);
      loadVisibleCells(map);
    },
    detach(map) {
      if (moveHandler) map.off("moveend", moveHandler);
      moveHandler = null;
      group.clearLayers();
      loadedCells.clear();
    },
  };
}
