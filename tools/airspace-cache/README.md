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
   0 3 1 * * cd /apps/airspace-cache && set -a && . ./.env && set +a && /usr/bin/node fetch-airspaces.mjs --out /apps/airspace-cache/data >> /var/log/airspace-cache.log 2>&1
   ```
6. nginx-Vhost `airspace.wetterheidi.de`: **öffentlich, kein Pförtner-Gate**
   (wird von mehreren Apps per `fetch()` aus dem Browser angesprochen), mit
   `Access-Control-Allow-Origin: *` auf den ausgelieferten Dateien (offene,
   nicht-sensible Geodaten) und moderatem `Cache-Control` (z. B. eine Woche).
   Vhost-Anlage sonst analog zu den bestehenden `deploy-hetzner.sh`-Skripten
   in droneforecast/trajectories/DZMaster (idempotent, Let's-Encrypt-Zertifikat
   beim ersten Lauf).

## Prüfen, ob ein Lauf geklappt hat

```bash
./check-airspace-cache.sh            # Default-Host root@178.104.206.136
```

Prüft öffentlich `meta.json` (Alter, Mindestumfang Zellen/Features) und
Stichproben-Kacheln aus datendichten Regionen, per SSH dann: ob der Cron-Lauf
dieses Monats überhaupt ins Log geschrieben hat, ob gerade ein Lauf aktiv ist,
Staging-Reste nach Absturz, `data.failed-cells.txt` und das Log-Ende. Exit-Code
0 = OK, 1 = Warnung, 2 = Fehler. Ein "Fertig" im Log allein reicht nicht -- so
endete auch der fehlerhafte Lauf vom September.

**Vorfall 2026-10-01:** Der Oktober-Lauf startete laut syslog, schrieb aber
nichts ins Log. Ursache: cron nutzt `/bin/sh` (dash), und dort sucht `. .env`
ohne Schrägstrich nur im `$PATH`, nicht im aktuellen Verzeichnis -- die
`&&`-Kette brach vor `node` ab, und da die Log-Umleitung nur am `node`-Befehl
hängt, blieb das Log unverändert. Richtig ist `. ./.env` (Cronzeile oben
korrigiert).

## Vorfall 2026-09-13..17: falsch-leere Regionen durch missverstandenes 404

Der erste komplette Welt-Lauf lief vom 13. bis 17.9. und meldete sich als
"Fertig: 5270 Zellen, 23739 Features" -- aber Mitteleuropa, große Teile der
USA und weitere datendichte Regionen blieben leer. Ursache: Log-Analyse zeigte
zwei riesige zusammenhängende Blöcke fehlgeschlagener Zellen (u. a.
durchgehend von Zelle 12958 bis zum letzten Grid-Eintrag 16200) -- die API
hat ab einem bestimmten Punkt im mehrtägigen Lauf **jede** Anfrage mit HTTP
404 statt Daten beantwortet (vermutlich ein Tages-/Laufkontingent, das nicht
als 429 signalisiert wird). Ein Direkttest derselben Bbox zwei Tage später
lieferte anstandslos HTTP 200 mit Daten -- die Sperre war also vorübergehend.

Der eigentliche Bug: Das Skript hat 404 wie eine legitime "keine Daten hier"-
Antwort behandelt. Das ist falsch -- die API liefert für tatsächlich leere
Bboxen ein reguläres 200 mit leerem `items`-Array; 404 ist immer ein
Fehlersignal. Dadurch wurden über 4800 Zellen fälschlich als leer
veröffentlicht, ohne dass der Lauf das als Fehler erkannte.

**Fix (in `fetch-airspaces.mjs`):**
- 404 zählt jetzt wie 408/429 zum Retry-mit-Backoff.
- Ein `CONSECUTIVE_FAILURE_LIMIT` (10) bricht den ganzen Lauf ab, sobald zu
  viele Zellen in Folge endgültig scheitern -- statt einen Großteil der Welt
  fälschlich als leer zu deployen, bleibt bei einem Abbruch der bisherige
  Live-Stand unverändert (kein Swap).
- Jede endgültig gescheiterte Zelle (auch ohne Abbruch) landet in
  `<out>.failed-cells.txt` (eine Bbox pro Zeile).
- Neue Betriebsart `--cells-file PATH`: liest Bboxen aus einer solchen Datei
  statt des vollen Welt-Grids und schreibt sie **direkt** ins bereits live
  ausgelieferte `--out`-Verzeichnis (kein Staging/Swap, reine Ergänzung),
  regeneriert danach `meta.json` durch Auszählen aller vorhandenen Kacheln.
  Gedacht für genau diesen Fall: gezielt nachholen, was in einem früheren
  Lauf fehlgeschlagen ist, sobald die Störung vorbei ist.

**Sofortmaßnahme (2026-09-19):** Die 4856 aus dem Log extrahierten
fehlgeschlagenen Bboxen wurden per `--cells-file` gegen den weiterhin live
ausgelieferten Datenstand nachgeholt (Direkttest zeigte, die API funktionierte
zu diesem Zeitpunkt wieder normal).

## Möglicher Optimierungsschritt: Delta-Updates statt Vollabgleich

Die Core-API unterstützt einen `updatedAfter`-Parameter (z. B.
`?updatedAfter=2026-08-13`), der tatsächlich filtert -- live verifiziert
(2026-09-13): ohne Parameter `totalCount: 31885`, mit `updatedAfter` für die
letzten 30 Tage `totalCount: 3588`, mit einem Zukunftsdatum `totalCount: 0`.
Ein monatlicher Lauf müsste damit potenziell nur noch ca. 3600 statt 31885
Einträge holen -- und das **ohne bbox-Rasterung**, also nur wenige
Hundert-Einträge-Seiten statt 16200 Zellen-Anfragen. Das würde den Lauf von
Tagen auf Minuten verkürzen.

**Zwei offene Punkte, die das nicht trivial machen:**

1. **Löschungen werden nicht erfasst.** Live getestet (2026-09-13): weder ein
   `deleted=true`-Parameter noch ein Bulk-"was wurde gelöscht"-Endpunkt
   existieren -- die API ignoriert unbekannte Query-Parameter einfach still
   (auch ein frei erfundener Parameter liefert HTTP 200 ohne Fehler, das ist
   kein Beleg für echte Filterung). Es gibt nur eine Änderungshistorie pro
   einzelnem Datensatz auf der openAIP-Website
   (`openaip.net/data/airspaces/<id>/rfc/history`), keinen API-Feed für alle
   Löschungen seit einem Datum. Ein reiner Delta-Sync würde also entfernte
   Lufträume nie aus dem Cache räumen -- weiterhin nötig: in größeren
   Abständen (z. B. quartalsweise) ein kompletter Vollabgleich, um Verwaiste
   zu entfernen.
2. **Das Grid-Zellen-Modell passt nicht 1:1.** Aktuell schreibt das Skript
   pro Zelle eine komplette Datei (einfacher atomarer Swap). Ein Delta-Update
   müsste stattdessen aus der Geometrie jedes geänderten Features die
   betroffene(n) Zelle(n) berechnen und die bestehende Zell-Datei gezielt
   aktualisieren (per `_id` ersetzen/hinzufügen) -- spürbar mehr Komplexität
   als der jetzige Ansatz.

Da der aktuelle Vollabgleich unbeaufsichtigt läuft und niemanden stört, ist
das vorerst zurückgestellt -- als Kandidat, falls der monatliche Cronjob mal
störend auffällt.

## Client-seitiger Vertrag

- `GET /meta.json` → `{ generatedAt, cellSizeDeg, cellCount, totalFeatures }`
- `GET /tiles/{latFloor}_{lonFloor}.geojson` → `FeatureCollection` für diese
  Zelle, oder `404` wenn dort keine Luftraumdaten liegen.

`meteokit/airspace` berechnet die passenden Zellschlüssel selbst aus dem
aktuellen Kartenausschnitt (`Math.floor(lat/cellSizeDeg)*cellSizeDeg`).
