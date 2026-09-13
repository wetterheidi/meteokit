# airspace-cache

Node-Skript, das einmal monatlich weltweit alle openAIP-Luftraumdaten
abholt und als statische GeoJSON-Dateien ablegt -- Grundlage für den
Cache-Server, den `meteokit/airspace` (s. `../../src/airspace/`) abfragt.

## Warum ein eigener Cache statt Live-Abfrage?

openAIPs Core-API (`api.core.openaip.net/api/airspaces`) ist laut eigener
Doku "mainly intended for export use-cases, not for regular queries... very
compute intensive". Live-Tests (2026-09-12, in DZMaster) bestätigten das:
größere Bbox-Anfragen liefern 408 (Timeout), danach 429 (Rate-Limit) -- und
bei 429 fehlen sogar die CORS-Header, sodass der Browser das nur als
undurchsichtigen "Failed to fetch" meldet, nicht als lesbaren Status.

Ein monatlicher Bulk-Export (passt zum realen AIRAC-Zyklus von 28 Tagen) ist
dagegen genau der Anwendungsfall, für den die API gedacht ist. Drei Apps
(DZMaster, droneforecast, trajectories) teilen sich damit einen Datenstand,
ohne dass jede einzeln gegen die Live-API rennt.

## Funktionsweise

`fetch-airspaces.mjs` rastert die Welt in Grid-Zellen (Default 2°×2°),
fragt pro Zelle vollständig paginiert ab (mit Verzögerung + Retry-Backoff
bei 408/429), und schreibt jede nicht-leere Zelle als
`tiles/{latFloor}_{lonFloor}.geojson` (FeatureCollection). Eine `meta.json`
beschreibt den Lauf (`generatedAt`, `cellSizeDeg`, `cellCount`,
`totalFeatures`).

Reines Node ≥18 (globales `fetch`, `fs/promises`), keine npm-Abhängigkeiten
-- kein `npm install` auf dem Server nötig, das Skript einfach dorthin
kopieren und mit `node` ausführen.

Schreibt zuerst in `<out>.staging`, swapped danach atomar (`rename`) in
`<out>` -- der Cache-Server liefert nie einen halb-geschriebenen Zwischenstand
aus, auch während eines mehrstündigen Laufs nicht.

## Lokaler Test

```bash
OPENAIP_API_KEY=... node fetch-airspaces.mjs \
  --out /tmp/airspace-test \
  --test-bbox 11,47.94,11.4,48.07
```

`--test-bbox minLon,minLat,maxLon,maxLat` beschränkt den Lauf auf eine
einzelne, kleine Region statt des mehrtägigen Welt-Grids.

**Rate-Limit, empirisch ermittelt (2026-09-13):** Die Core-API ist deutlich
strenger als vermutet. 1,5s zwischen Requests führte fast durchgehend zu 429,
selbst 15s brachte noch ~40% 429-Treffer. `REQUEST_DELAY_MS = 20000` (20s) ist
der aktuell eingestellte Kompromiss, plus der bestehende Retry-Backoff bei
429/408 als Netz. Bei 16200 Zellen (2°-Grid) macht das einen vollständigen
Weltlauf zu einer **Sache von Tagen, nicht Stunden** -- für einen monatlichen,
unbeaufsichtigten Cronjob unkritisch, aber beim ersten manuellen Anstoßen
wichtig zu wissen.

## Server-Setup (Hetzner, `root@178.104.206.136`)

Bereits eingerichtet (Stand 2026-09-13):

1. Node 18.19.1 via `apt install nodejs` (Ubuntu 24.04 liefert das in den
   Standard-Paketquellen, kein externes Repo nötig).
2. Skript liegt unter `/apps/airspace-cache/fetch-airspaces.mjs`.
3. API-Key liegt in `/apps/airspace-cache/.env` (chmod 600, nicht im Repo).
4. Ausgabeverzeichnis `/apps/airspace-cache/data/`, ausgeliefert vom
   `airspace.wetterheidi.de`-Vhost (s. unten).
5. Cronjob (monatlich, 1. um 03:00 Uhr):
   ```
   0 3 1 * * cd /apps/airspace-cache && set -a && . .env && set +a && /usr/bin/node fetch-airspaces.mjs --out /apps/airspace-cache/data >> /var/log/airspace-cache.log 2>&1
   ```
6. nginx-Vhost `airspace.wetterheidi.de`: **öffentlich, kein Pförtner-Gate**
   (wird von mehreren Apps per `fetch()` aus dem Browser angesprochen), mit
   `Access-Control-Allow-Origin: *` auf den ausgelieferten Dateien (offene,
   nicht-sensible Geodaten) und moderatem `Cache-Control` (z. B. eine Woche).
   Vhost-Anlage sonst analog zu den bestehenden `deploy-hetzner.sh`-Skripten
   in droneforecast/trajectories/DZMaster (idempotent, Let's-Encrypt-Zertifikat
   beim ersten Lauf).

## Client-seitiger Vertrag

- `GET /meta.json` → `{ generatedAt, cellSizeDeg, cellCount, totalFeatures }`
- `GET /tiles/{latFloor}_{lonFloor}.geojson` → `FeatureCollection` für diese
  Zelle, oder `404` wenn dort keine Luftraumdaten liegen.

`meteokit/airspace` berechnet die passenden Zellschlüssel selbst aus dem
aktuellen Kartenausschnitt (`Math.floor(lat/cellSizeDeg)*cellSizeDeg`).
