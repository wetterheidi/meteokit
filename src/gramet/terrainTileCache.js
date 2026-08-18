/**
 * Minimaler IndexedDB-Wrapper für rohe Mapterhorn-Kachel-Bytes (WebP-Blobs),
 * s. `terrain.js`. Bewusst nicht generisch (kein KV-Store für beliebige Daten)
 * -- nur das, was die Terrain-Kachel-Ebene braucht.
 *
 * Kein TTL: anders als die stündlichen Wettermodell-Läufe (s. TTL in
 * windoverlay.js/cloudoverlay.js/gustoverlay.js) ändert sich Gelände praktisch
 * nie -- eine einmal gecachte Kachel bleibt gültig.
 */

const DB_NAME = "gramet-terrain";
const DB_VERSION = 1;
const STORE = "tiles";

let dbPromise = null;

function openTerrainDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function getCachedTile(key) {
  const db = await openTerrainDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function putCachedTile(key, blob) {
  const db = await openTerrainDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
