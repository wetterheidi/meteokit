/**
 * Geländehöhen-Profil entlang eines Flugpfads über Mapterhorn-Terrainkacheln
 * (https://github.com/mapterhorn/mapterhorn) -- unabhängig vom Wettermodell,
 * daher eine eigene Datei statt Teil von `path.js`. Rein lesend/berechnend,
 * kein Bezug zu Wetterdaten.
 *
 * Kachelquelle: `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`, Terrarium-
 * kodiert, 512x512 px (nicht die üblichen 256 -- offiziell in der
 * Mapterhorn-Migrationsanleitung bestätigt). Globale Abdeckung bereits ab
 * Zoom 0-12 über eine einzige "planet"-Kachelquelle; regional feiner
 * (z13-17) nur für ausgewählte Gebiete. `TERRAIN_ZOOM = 12` reicht für unseren
 * Zweck (deutlich feiner als das Wettermodellgitter von ~2 km, weltweit ohne
 * Kachel-Loch-Risiko) -- s. Diskussion, leicht änderbar.
 *
 * Zwei-Ebenen-Cache: In-Memory (`Map`, bereits dekodierte Höhenraster,
 * session-lang) vor IndexedDB (`terrainTileCache.js`, rohe WebP-Bytes,
 * persistent -- Gelände ändert sich praktisch nie, anders als die stündlichen
 * Wettermodell-Läufe, die den TTL-Cache bei den Overlays begründen).
 */

import { getCachedTile, putCachedTile } from "./terrainTileCache.js";
import { posOfPath } from "./path.js";

export const TERRAIN_ZOOM = 12;
const TILE_SIZE = 512;

export const TERRAIN_ATTRIBUTION = {
  label: "Gelände: Mapterhorn",
  url: "https://mapterhorn.com/attribution",
};

// Default-Kadenz fürs Geländeprofil ("etwa minütlich", s. Diskussion) --
// UNABHÄNGIG davon, wie dicht der Aufrufer die `waypoints` liefert (z. B.
// gröber bei einer Trajektorienberechnung mit größerem Zeitschritt). Gelände
// hat nichts mit der Sampling-Dichte des Aufrufers zu tun, deshalb wird hier
// selbst nachverdichtet statt sich auf dessen Auflösung zu verlassen.
const DEFAULT_TERRAIN_INTERVAL_SEC = 60;

// Lineare Zwischenpunkte (Lat/Lon/Zeit) zwischen den vom Aufrufer gelieferten
// `waypoints`, wenn deren Abstand `intervalSec` überschreitet -- Geländehöhe
// braucht kein exaktes Kurvenfolgen zwischen zwei Wegpunkten, eine gerade
// Verbindung ist für die Sampling-Auflösung ausreichend (die eigentliche
// Flugkurve kommt ohnehin vom Aufrufer, hier geht es nur darum, WIE OFT
// entlang ihr eine Kachel abgefragt wird).
function densifyWaypoints(waypoints, intervalSec) {
  if (!(intervalSec > 0)) return waypoints;
  const out = [waypoints[0]];
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    const steps = Math.floor((b.t - a.t) / intervalSec);
    for (let s = 1; s < steps; s++) {
      const f = (s * intervalSec) / (b.t - a.t);
      out.push({ lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon), t: a.t + s * intervalSec });
    }
    out.push(b);
  }
  return out;
}

/** Standard-Web-Mercator-Kachel-/Pixel-Koordinaten für einen Punkt. */
export function lonLatToTilePixel(lon, lat, z, tileSize = TILE_SIZE) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tileX = Math.floor(x), tileY = Math.floor(y);
  const px = Math.min(tileSize - 1, Math.floor((x - tileX) * tileSize));
  const py = Math.min(tileSize - 1, Math.floor((y - tileY) * tileSize));
  return { tileX, tileY, px, py };
}

// Terrarium-Decodeformel: elevation = R*256 + G + B/256 - 32768.
function decodeTerrarium(imageData) {
  const { data, width, height } = imageData;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
  }
  return out;
}

const memCache = new Map(); // "z/x/y" -> Float32Array(TILE_SIZE*TILE_SIZE) | null (Fehler)

async function decodeTileBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return decodeTerrarium(imageData);
}

/**
 * Liefert das dekodierte Höhenraster einer Kachel (Float32Array, Zeilenweise,
 * TILE_SIZE*TILE_SIZE) oder `null` bei Fetch-/Decode-Fehler -- kein Throw,
 * der Aufrufer wertet `null` als Lücke im Profil.
 */
export async function getTerrainTile(z, x, y, fetchImpl = fetch.bind(globalThis)) {
  const key = `${z}/${x}/${y}`;
  if (memCache.has(key)) return memCache.get(key);

  try {
    let blob = await getCachedTile(key);
    if (!blob) {
      const resp = await fetchImpl(`https://tiles.mapterhorn.com/${key}.webp`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      blob = await resp.blob();
      putCachedTile(key, blob).catch(() => {}); // Cache-Schreibfehler sind nicht fatal
    }
    const decoded = await decodeTileBlob(blob);
    memCache.set(key, decoded);
    return decoded;
  } catch {
    memCache.set(key, null);
    return null;
  }
}

/**
 * Geländehöhen-Profil für eine Wegpunktliste (dieselbe Form wie
 * `path.js` `fetchGridForPath` sie erhält -- VOR der Fetch-Policy-Ausdünnung,
 * Gelände hat nichts mit der Modellauflösung zu tun). Wird intern per
 * `densifyWaypoints` auf `opts.terrainIntervalSec` (Default
 * `DEFAULT_TERRAIN_INTERVAL_SEC`, "etwa minütlich") nachverdichtet --
 * unabhängig davon, wie grob der Aufrufer selbst sampelt.
 * @returns { pos: Float64Array, elevation: Float32Array (NaN bei Lücke),
 *   gaps: Array<{fromPos, toPos}> }
 */
export async function fetchTerrainProfile(waypoints, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const dense = densifyWaypoints(waypoints, opts.terrainIntervalSec ?? DEFAULT_TERRAIN_INTERVAL_SEC);
  const pos = posOfPath(dense);
  const elevation = new Float32Array(dense.length);

  for (let i = 0; i < dense.length; i++) {
    const wp = dense[i];
    const { tileX, tileY, px, py } = lonLatToTilePixel(wp.lon, wp.lat, TERRAIN_ZOOM);
    const tile = await getTerrainTile(TERRAIN_ZOOM, tileX, tileY, fetchImpl);
    elevation[i] = tile ? tile[py * TILE_SIZE + px] : NaN;
  }

  const gaps = [];
  let gapStart = null;
  for (let i = 0; i < elevation.length; i++) {
    if (Number.isNaN(elevation[i])) {
      if (gapStart == null) gapStart = i;
    } else if (gapStart != null) {
      gaps.push({ fromPos: pos[gapStart], toPos: pos[i - 1] });
      gapStart = null;
    }
  }
  if (gapStart != null) gaps.push({ fromPos: pos[gapStart], toPos: pos[pos.length - 1] });

  return { pos: Float64Array.from(pos), elevation, gaps };
}
