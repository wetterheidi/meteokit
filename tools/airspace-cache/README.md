# airspace-cache

Node-Skript, das einmal monatlich weltweit alle openAIP-Luftraumdaten
abholt und als statische GeoJSON-Dateien ablegt -- Grundlage für den
Cache-Server, den `meteokit/airspace` (s. `../../src/airspace/`) abfragt.
Daneben holt `fetch-airports.mjs` die Flugplätze samt Funkfrequenzen (s.
Abschnitt unten).

## Warum ein eigener Cache statt Live-Abfrage?

openAIPs Core-API (`api.core.openaip.net/api/airspaces`) ist laut eigener
Doku "mainly intended for export use-cases, not for regular queries... very
compute intensive". Live-Tests (2026-09-12, in DZMaster) bestätigten das:
größere Bbox-Anfragen liefern 408 (Timeout), danach 429 (Rate-Limit) -- und
bei 429 fehlen sogar die CORS-Header, sodass der Browser das nur als
undurchsichtigen "Failed to fetch" meldet, nicht als lesbaren Status.

Ein monatlicher Bulk-Export (passt zum realen AIRAC-Zyklus von 28 Tagen) ist
dagegen genau der Anwendungsfall, für den die API gedacht ist. Mehrere Apps
teilen sich damit einen Datenstand, ohne dass jede einzeln gegen die Live-API
rennt: DZMaster, droneforecast und trajectories (Luftraum-Layer über
`meteokit/airspace`) sowie SkyEar (Repo `Radio`), dessen Flugfunk-Reiter die
Funkfrequenzen von Flugplätzen und Lufträumen im Umkreis des Standorts
auflistet.

## Funktionsweise

`fetch-airspaces.mjs` blättert den gesamten `/api/airspaces`-Bestand durch
(rund 35 000 Lufträume, also ca. 70 Seiten à 500, 20 s Pause zwischen
Anfragen -- ein Lauf dauert damit etwa eine halbe Stunde) und verteilt jeden
Luftraum selbst auf alle 2°×2°-Zellen, die seine Bounding-Box schneidet. Jede
nicht-leere Zelle wird als `tiles/{latFloor}_{lonFloor}.geojson`
(FeatureCollection) geschrieben. Ein Luftraum über mehreren Zellen steht in
jeder davon (wie früher, als die API pro Zell-Bbox abgefragt wurde). Polygone
über die Datumsgrenze werden in zwei Längenbereiche aufgeteilt statt als Band
um die ganze Welt. Eine `meta.json` beschreibt den Lauf (`generatedAt`,
`cellSizeDeg`, `cellCount`, `totalFeatures` = Features summiert über alle
Kacheln, `airspaceCount` = eindeutige Lufträume).

Bis Oktober 2026 hat das Skript stattdessen 16 200 Zell-Bboxen einzeln
abgefragt (mehrtägiger Lauf). Das geht nicht mehr, s. "Vorfall 2026-11-01".

Abgefragte Felder: `name,icaoClass,type,activity,geometry,upperLimit,
lowerLimit,country,frequencies` (`frequencies` seit 2026-11).

Koordinaten werden auf 5 Nachkommastellen gerundet (seit 2026-11, max.
0,56 m Versatz). Die bis zu 15 Stellen der API sind Umrechnungsartefakte:
Ein Drittel sind exakt ganze Bogensekunden aus der AIP (Auflösung ≈ 31 m),
der Rest berechnete Kreisbogen-Stützpunkte. Spart gepackt ca. 25 % pro
Kachel (48_10: 123 → 91 kB). Properties bleiben ungerundet.

Reines Node ≥18 (globales `fetch`, `fs/promises`), keine npm-Abhängigkeiten
-- kein `npm install` auf dem Server nötig, das Skript einfach dorthin
kopieren und mit `node` ausführen.

Schreibt zuerst in `<out>.staging`, swapped danach atomar (`rename`) in
`<out>` -- der Cache-Server liefert nie einen halb-geschriebenen Zwischenstand
aus.

**Speicher und Datenmenge (gemessen 2026-11-01):** Der Bestand umfasst
32 191 Lufträume mit ~560 MB JSON; die API liefert Brotli-komprimiert (eine
Seite: 16,6 MB → 4,8 MB), ein Lauf überträgt also grob 150--200 MB, und zwar
zwischen Server und openAIP -- die eigene Internetleitung ist nur für den
SSH-Befehl zum Starten beteiligt. Weil der Server nur ~1 GB RAM frei hat,
hängt das Skript jede Seite sofort an Zell-Teildateien
(`<out>.staging/tiles/{key}.part`) an und schließt diese erst am Ende zu
FeatureCollections ab; im Speicher bleiben nur die aktuelle Seite und die
gesehenen `_id`s. Plattenbedarf während des Swaps: alter plus neuer Stand
(je ~1 GB).

Absicherungen (beide Skripte):
- 404/408/429 werden mit Backoff wiederholt (404 ist bei dieser API nie
  "keine Daten", s. Vorfall September). Scheitert eine Seite nach allen
  Retries, bricht der Lauf ab, der alte Stand bleibt live -- einfach komplett
  wiederholen.
- Liegen am Ende weniger als 98 % des von der API gemeldeten `totalCount`
  vor, ebenfalls Abbruch ohne Swap.
- Einträge werden nach `_id` dedupliziert (falls sich der Bestand während
  des Blätterns verschiebt).

## Flugplätze und Funkfrequenzen (`fetch-airports.mjs`)

Zweites Skript nach demselben Muster für `/api/airports` mit den Feldern
`name,icaoCode,type,geometry,frequencies` (Stand 2026-11-01: 46 831
Flugplätze, 94 Seiten). Flugplätze sind Punkte und landen in genau einer
Zelle `tiles/{latFloor}_{lonFloor}.geojson`.

Genutzt von SkyEar (Repo `Radio`, `web/app.js`, Abschnitt „Flugfunk:
Frequenzen in der Nähe“): Es lädt die Flugplatz- und Luftraumkacheln rund um
den Standort direkt im Browser und zeigt die Frequenzen im Band 118–137 MHz.
Von den Lufträumen nutzt es dafür das Feld `frequencies`.

**Wichtig: eigenes Ausgabeverzeichnis, nicht unter `data/`.** Der atomare
Swap von `fetch-airspaces.mjs` ersetzt `data/` komplett -- ein
`data/airports/` würde dabei jeden Monat gelöscht.

## Lokaler Test

```bash
OPENAIP_API_KEY=... node fetch-airspaces.mjs --out /tmp/airspace-test --max-pages 2
OPENAIP_API_KEY=... node fetch-airports.mjs  --out /tmp/airports-test --max-pages 2
```

`--max-pages N` holt nur die ersten N Seiten; die Vollständigkeitsprüfung
entfällt dann. Eine Einschränkung auf eine Region gibt es nicht mehr, weil die
API `bbox` blockiert.

**Rate-Limit, empirisch ermittelt (2026-09-13):** Die Core-API ist deutlich
strenger als vermutet. 1,5s zwischen Requests führte fast durchgehend zu 429,
selbst 15s brachte noch ~40% 429-Treffer. `REQUEST_DELAY_MS = 20000` (20s) ist
der aktuell eingestellte Kompromiss, plus Retry-Backoff als Netz.

## Server-Setup (Hetzner, `root@178.104.206.136`)

Bereits eingerichtet (Stand 2026-09-13):

1. Node 18.19.1 via `apt install nodejs` (Ubuntu 24.04 liefert das in den
   Standard-Paketquellen, kein externes Repo nötig).
2. Skript liegt unter `/apps/airspace-cache/fetch-airspaces.mjs` (seit
   2026-11-01 die Version ohne Bbox; die alte liegt daneben als
   `fetch-airspaces.mjs.bak-2026-10`. Erster Lauf der neuen Version steht
   noch aus).
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
   Seit 2026-11-01 außerdem `default_type application/geo+json` (nginx kennt
   `.geojson` nicht und lieferte sonst `application/octet-stream`) und gzip
   für `application/geo+json`/`application/json` (`gzip_comp_level 5`,
   `gzip_vary on`): Luftraum-Kacheln schrumpfen damit auf ca. ¼ (48_10:
   424 → 123 kB), Flugplatz-Kacheln auf ca. ⅙. Bewusst `default_type` statt
   `types { ... }` -- ein `types`-Block im Server ersetzt die ganze
   `mime.types`-Liste, dann käme auch `meta.json` als `octet-stream`.
   Sicherung der Vhost-Datei vor der Änderung:
   `/root/airspace.wetterheidi.de.bak-gzip-2026-11`.
   Vhost-Anlage sonst analog zu den bestehenden `deploy-hetzner.sh`-Skripten
   in droneforecast/trajectories/DZMaster (idempotent, Let's-Encrypt-Zertifikat
   beim ersten Lauf).

**Flugplätze (Stand 2026-11-01):**

1. Erledigt: `fetch-airports.mjs` liegt unter `/apps/airspace-cache/` (nutzt
   dieselbe `.env`), erster manueller Lauf am 2026-11-01 nach
   `/apps/airspace-cache/airports/`, Log in `/var/log/airports-cache.log`.
2. Erledigt (2026-11-01): im bestehenden Vhost
   (`/etc/nginx/sites-available/airspace.wetterheidi.de`) unter `/airports/`
   ausgeliefert. Direkt nach dem `location / { ... }`-Block eingefügt; die
   CORS-/Cache-Header stehen dort auf `server`-Ebene und werden geerbt,
   solange der neue Block kein eigenes `add_header` hat:
   ```nginx
   location /airports/ {
       alias /apps/airspace-cache/airports/;
   }
   ```
   Danach `nginx -t && systemctl reload nginx`.
3. Erledigt (2026-11-01): Cronjob vor dem Luftraumlauf (nicht parallel, sonst teilen sich
   beide das Rate-Limit):
   ```
   0 1 1 * * cd /apps/airspace-cache && set -a && . ./.env && set +a && /usr/bin/node fetch-airports.mjs --out /apps/airspace-cache/airports >> /var/log/airports-cache.log 2>&1
   ```

## Prüfen, ob ein Lauf geklappt hat

```bash
./check-airspace-cache.sh            # Default-Host root@178.104.206.136
```

Prüft für Lufträume und Flugplätze getrennt öffentlich `meta.json` (Alter,
Mindestumfang Zellen/Features) und Stichproben-Kacheln aus datendichten
Regionen, per SSH dann jeweils: ob der Cron-Lauf
dieses Monats überhaupt ins Log geschrieben hat, ob gerade ein Lauf aktiv ist,
Staging-Reste nach Absturz und das Log-Ende. Exit-Code
0 = OK, 1 = Warnung, 2 = Fehler. Ein "Fertig" im Log allein reicht nicht -- so
endete auch der fehlerhafte Lauf vom September.

**Vorfall 2026-10-01:** Der Oktober-Lauf startete laut syslog, schrieb aber
nichts ins Log. Ursache: cron nutzt `/bin/sh` (dash), und dort sucht `. .env`
ohne Schrägstrich nur im `$PATH`, nicht im aktuellen Verzeichnis -- die
`&&`-Kette brach vor `node` ab, und da die Log-Umleitung nur am `node`-Befehl
hängt, blieb das Log unverändert. Richtig ist `. ./.env` (Cronzeile oben
korrigiert).

## Vorfall 2026-11-01: Cloudflare blockiert `bbox`

Der November-Lauf brach nach 10 Zellen ab: jede Anfrage lieferte HTTP 403 --
aber nicht die JSON-Fehlerantwort der API, sondern eine Cloudflare-Sperrseite
(HTML mit `cdn-cgi`-Challenge). Eingegrenzt vom Server aus (mit gültigem Key):

| Anfrage | Ergebnis |
|---|---|
| `?limit=1` | 200 |
| `?limit=1&fields=...` | 200 |
| `?limit=1&country=DE` | 200 |
| `?limit=1&bbox=11,48,11.5,48.5` (auch `%2C`-kodiert) | 403 Cloudflare |
| `?limit=1&pos=48.2,11.2&dist=20000` | 403 Cloudflare |

Geo-Abfragen sind also gesperrt, reines Blättern nicht. Beide Skripte holen
deshalb seither den gesamten Bestand ohne Geo-Parameter und verteilen ihn
selbst auf die Zellen. Damit entfielen auch `--test-bbox`, `--cells-file`,
`<out>.failed-cells.txt` und `CONSECUTIVE_FAILURE_LIMIT` aus dem
September-Fix (s. unten) -- bei einem halbstündigen Lauf wird nach einem
Fehler einfach komplett wiederholt.

Nebenbefund: Ein ungültiger Key liefert HTTP 404 `"Failed to load user
permissions"`. Das könnte auch die 404-Welle vom September erklären.

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

**Fix (in `fetch-airspaces.mjs`, seit 2026-11 größtenteils durch den Umbau
ohne Bbox ersetzt -- geblieben ist: 404 zählt als Fehler):**
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
Ein monatlicher Lauf müsste damit nur noch ca. 3600 statt ~35 000 Einträge
holen. Seit dem Umbau ohne Bbox (2026-11) dauert der Vollabgleich aber nur
noch ca. eine halbe Stunde -- der Gewinn wäre also klein.

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
2. **Inkrementelles Schreiben.** Das Skript schreibt jede Zelle komplett neu
   (einfacher atomarer Swap). Ein Delta-Update müsste die bestehenden
   Zell-Dateien gezielt aktualisieren (per `_id` ersetzen/hinzufügen) --
   spürbar mehr Komplexität als der jetzige Ansatz.

Deshalb zurückgestellt.

## Client-seitiger Vertrag

- `GET /meta.json` → `{ generatedAt, cellSizeDeg, cellCount, totalFeatures,
  airspaceCount }` (`airspaceCount` seit 2026-11)
- `GET /tiles/{latFloor}_{lonFloor}.geojson` → `FeatureCollection` für diese
  Zelle, oder `404` wenn dort keine Luftraumdaten liegen.

`meteokit/airspace` berechnet die passenden Zellschlüssel selbst aus dem
aktuellen Kartenausschnitt (`Math.floor(lat/cellSizeDeg)*cellSizeDeg`).

Flugplätze analog unter `/airports/`:

- `GET /airports/meta.json` → `{ generatedAt, cellSizeDeg, cellCount, totalFeatures }`
- `GET /airports/tiles/{latFloor}_{lonFloor}.geojson` → `FeatureCollection`
  aus Punkt-Features mit `properties` `{ _id, name, icaoCode, type,
  frequencies }`, oder `404` wenn in der Zelle kein Flugplatz liegt.
  `type` und die Einträge in `frequencies` sind openAIPs numerische Codes
  (unverändert durchgereicht).

**Kompression (erledigt 2026-11-01):** nginx lieferte `.geojson` als
`application/octet-stream` und damit ungepackt aus (Luftraumkachel bis
~0,5 MB; SkyEar brauchte bei 200 km Umkreis anfangs bis zu 36 s). Seitdem
gzip im Vhost, s. Server-Setup Punkt 6 -- 48_10 kommt jetzt mit 123 kB
statt 424 kB an (ab dem nächsten Luftraumlauf mit gerundeten Koordinaten
ca. 91 kB).
