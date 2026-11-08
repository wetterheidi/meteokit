# vis-archive

Node-Skript, das täglich die ICON-D2/-EU-Modellsicht (`visibility`) samt
aller Eingangsgrößen für eine eigene Sichtparametrisierung sowie METARs für
eine feste Stationsliste sichert.

## Warum?

Der DWD entfernt den Parameter VIS nach dem **30.11.2026** aus allen
Open-Data-Lieferungen der ICON-Modellkette. Bei ICON-EU und ICON-D2(-EPS)
wird VIS gar nicht erst in das neue URL-Schema übernommen. Begründung des
Flugwetterdienstes: Die VIS-Felder sind nicht geeignet, Sichtweiten nach
VFR/SERA vorherzusagen. Damit liefert auch Open-Meteo (und unser eigener
Server) keine Sicht mehr. Betroffen sind Dronecast (Punktvorhersage), GRAMET
(Sichtzeile, FG/BR/HZ-Diagnose in `src/gramet/hazards/fog.js` und
`src/clouds.js`) und später IDSSEML.

Geplant ist eine eigene Parametrisierung (Extinktion aus Wolkenwasser,
Niederschlag und Feuchte, Umrechnung über Koschmieder). Dieses Archiv ist
die Vergleichsbasis: Solange ICON VIS noch liefert, liegen Modellsicht und
alle Eingangsgrößen **aus demselben Modellzustand** nebeneinander. Schwerpunkt
ist der Vergleich mit der Modellsicht; METARs (und später SYNOPs) sind die
zweite Referenz, deren Aussagekraft aber durch die Modellfehler selbst
begrenzt ist.

## Was gesichert wird

Stationen: `stations.json` (24 Stück: 21 Flugplätze in DE/AT/CH, davon 20 mit
METAR, mit
unterschiedlichem Charakter -- Küste, Tiefland, Becken, Täler, Seen,
Mittelgebirge, Alpenvorland, Inneralpin -- plus drei Bergstationen ohne
METAR: Brocken, Fichtelberg, Hohenpeißenberg).

**Modelle** (`icon_d2`, `icon_eu`, Quelle `open-meteo.wetterheidi.de`),
stündlich, eine CSV pro Modell und UTC-Tag (`data/<modell>/YYYY-MM-DD.csv`):

- Oberfläche: `visibility`, `temperature_2m`, `relative_humidity_2m`,
  `dew_point_2m`, `precipitation`, `rain`, `showers`, `snowfall`,
  `weather_code`, `cloud_cover`, `cloud_cover_low`, `wind_speed_10m`,
  `wind_gusts_10m`, `pressure_msl`, `surface_pressure`, `snowfall_height`,
  `freezing_level_height`.
- Die elf untersten Modellflächen (`_k0` = unterste, ca. 10 m über Grund,
  bis `_k10` ≈ 600 m in D2 bzw. ≈ 1100 m in EU): `height_agl`, `pressure`,
  `temperature`, `relative_humidity`, `specific_humidity`, `cloud_water`,
  `cloud_ice`, `cloud_cover`, `wind_u_component`, `wind_v_component`. Bei
  Open-Meteo ist der *größte* Level-Index die unterste Fläche (D2: 65,
  EU: 74). Umfang und Wind richten sich nach ICONs eigener Sichtdiagnose
  (Scherung zwischen k0 und k2, θv auf der Fläche unter 540 m), s.
  `docs/SICHTWEITE.md`. Die erste Fassung vom 08.11. hatte nur fünf Flächen
  ohne Wind; der Bestand ab 05.10. wurde am selben Tag mit elf Flächen neu
  geholt. Regen-, Schnee- und Graupelgehalt auf Modellflächen liefert der
  Server nicht.
- `grid_lat/lon/elev`: Gitterpunkt, den Open-Meteo gewählt hat. Abgerufen mit
  `elevation=nan`, also **ohne Höhenkorrektur**, damit T/RH zur selben
  Gitterzelle gehören wie die Modellsicht. Bei Bergstationen weicht die
  Gitterhöhe deutlich ab (Brocken: 942 m statt 1135 m in D2).
- Einheiten stehen in `data/meta.json` (u. a. `cloud_water` und
  `specific_humidity` in g/kg, `precipitation`/`rain`/`showers` in mm,
  `snowfall` in cm, jeweils Summe der vorangehenden Stunde).

Die Werte sind Open-Meteos „Best Match“ der Vergangenheit (jede Stunde aus
dem jüngsten Lauf, der sie abdeckt, also kurze Vorhersagezeiten). Für den
Vergleich Parametrisierung ↔ Modellsicht genügt das, weil beide aus demselben
Modellzustand stammen.

Geschrieben werden nur vollständige, vergangene UTC-Tage. Eine bestehende
Tagesdatei wird nur ersetzt, wenn der neue Abruf mindestens genauso viele
Sichtwerte enthält (der Server lässt alte Tage herausrollen, einzelne
Stationsabrufe können scheitern).

**METAR** (aviationweather.gov), eine JSONL-Datei pro UTC-Tag
(`data/metar/YYYY-MM-DD.jsonl`), dedupliziert über ICAO + Zeit + Rohmeldung.
Gespeichert sind `rawOb` und die wichtigsten geparsten Felder. Achtung:
`visib` ist in Statute Miles (`"6+"` = ≥ 10 km); für die Auswertung besser die
Sicht aus `rawOb` lesen. Die API liefert pro Anfrage höchstens 400 Meldungen
und hält etwa einen Monat Historie (Stand 2026-11-08: zurück bis 09.10.),
deshalb wird je Station in 72-h-Fenstern abgefragt.

Bayreuth (EDQD) führt aviationweather.gov gar nicht (HTTP 204 ohne Inhalt,
Stand 2026-11-08), die Station steht deshalb mit `"metar": false` in der
Liste und liefert nur Modelldaten. Leere Antworten (204) gelten im Skript als
„keine Meldungen“, nicht als Fehler.

**SYNOP** wird nicht archiviert: Die stündliche Sicht der DWD-Stationen gibt
es im CDC (`climate/hourly/visibility/recent/`, Stationskennung `dwdId` in
`stations.json`) rückwirkend für rund 500 Tage, sie lässt sich also bei der
Auswertung nachladen. Für AT/CH-Stationen gibt es dort nichts.

MeteoMap (Repo `METEOMAP`, gleicher Server) entschlüsselt SYNOPs, hilft hier
aber wenig: Seine Datenbank hält nur 12 h, und die deutschen SYNOPs über
OGIMET enthalten keine Sicht (Gruppe `iRiXhVV` endet auf `//`, z. B.
Frankfurt `454//`, Stand 2026-11-08). Sicht über OGIMET gibt es dort vor
allem für AT (Graz 11240, Innsbruck-Flughafen 11120, Linz 11010,
Klagenfurt 11231); die AT-Plätze sind über METAR ohnehin abgedeckt.

## Aufruf

```bash
node fetch-vis-archive.mjs --out DIR [--past-days N] [--metar-hours H] \
                           [--only models|metar] [--stations ID,ID]
```

- `--past-days N`: Modelltage zurück (Default 3, max. 92).
- `--metar-hours H`: METAR-Stunden zurück (Default 36).
- `--only`: nur Modelle oder nur METAR.
- `--stations`: nur diese IDs (zum Testen).

Reines Node ≥18, keine npm-Abhängigkeiten.

Lokaler Test:

```bash
node fetch-vis-archive.mjs --out /tmp/vis-test --past-days 2 --stations EDDM,LOWG,BROCKEN
```

## Server-Setup (Hetzner, `root@178.104.206.136`)

Eingerichtet am 2026-11-08:

1. Skript und `stations.json` unter `/apps/vis-archive/`. Nach Änderungen
   beide Dateien per `scp` dorthin kopieren.
2. Daten unter `/apps/vis-archive/data/`, **nicht** öffentlich ausgeliefert.
   Holen zur Auswertung:
   `rsync -av root@178.104.206.136:/apps/vis-archive/data/ ./vis-data/`
3. Cronjob (täglich 04:30 UTC, Server läuft in UTC):
   ```
   30 4 * * * cd /apps/vis-archive && /usr/bin/node fetch-vis-archive.mjs --out /apps/vis-archive/data --past-days 3 >> /var/log/vis-archive.log 2>&1
   ```
   Sicherung der Crontab davor: `/root/crontab.bak-vis-archive-2026-11-08`.
4. Backfill am 2026-11-08: Modelle mit `--past-days 45`. Der Server hatte
   Sicht ab 05.10.2026, also 34 Tage (05.10.–07.11.), je 24 Stationen, ca.
   11 MB. METAR mit `--only metar --metar-hours 720`: 31 Tage (09.10.–08.11.),
   1440 Meldungen je H24-Platz, bei ETHA/ETSB/ETSN (nicht durchgehend
   besetzt) 780–880.

Datenmenge: ca. 400 kB pro Modell und Tag (elf Flächen; 29 MB für den Backfill 05.10.–07.11.).

## Nach dem 30.11.2026

Danach fehlt `visibility`. Die Eingangsgrößen bleiben trotzdem nützlich, um
die Parametrisierung gegen METAR/SYNOP weiter zu prüfen. Ob der Cronjob dann
weiterläuft oder abgeschaltet wird, ist noch zu entscheiden.
