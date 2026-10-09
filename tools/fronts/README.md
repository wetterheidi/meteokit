# fronts – Werkzeuge zur objektiven Frontenanalyse

Im Aufbau. Ziel: Fronten aus ICON-EU-Feldern in 850 hPa nach der TFP-Methode
(Hewson 1998) bestimmen und als GeoJSON an Apps liefern, z. B. dronecast.
Kernmodul ist `src/fronts/` (`meteokit/fronts`). Hier liegen Abrufskript,
Debug-Seite und Testfälle.

## Stand (Spike, 2026-10-08)

- `fetchPlaneField` holt die Modelllevel 55–70 sowie das unterste Level per
  Mehrpunkt-POST vom Modelllevel-Server und interpoliert linear in ln p auf
  die Zieldruckfläche. Der Server liefert **keine Druckflächen-Variablen**
  (`temperature_850hPa` u. ä. kommen als `null`), deshalb wird selbst
  interpoliert.
- **Orographiemaske:** Wo der Druck am untersten Level (~10 m AGL) kleiner
  als die Zielfläche ist, liegt diese unter Grund (`below = 1`, Werte NaN).
- Stichprobe gegen die offiziellen 850-hPa-Felder der öffentlichen Instanz
  (8 Punkte, 2026-10-09 00 UTC): T auf 0,1 K gleich, RH ±1 %, Wind ±1 km/h
  und ±2°.
- Ein 0,5°-Raster über 30–70° N, 23,5° W bis 44,5° E hat 137×81 Punkte und
  braucht 19 Requests, zusammen rund 8 s.
- θe nach Bolton (1980). θw wird exakt als Umkehrung von θe bei
  Sättigung in 1000 hPa berechnet (s. `src/fronts/thermo.js`).

## Detektion (`detectFronts`, Stand 2026-10-09)

`src/fronts/detect.js` arbeitet in diesen Schritten:

1. θw berechnen und maskieren, wo die Fläche unter Grund liegt oder weniger
   als 25 hPa darüber.
2. θw mit einer Gauß-Glättung von σ = 120 km glätten.
3. TFP = −∇|∇θw|·n̂ berechnen.
4. Die Frontlinie ist die Nulllinie von ∇TFP·n̂, also die warme Kante der
   Frontalzone.
5. Masken anwenden: K1 verlangt TFP > 0,1 K/(100 km)², K2 verlangt
   |∇θw| + m/√2·TFP > 0,8 K/100 km.
6. Linien verketten und alles unter 400 km verwerfen.
7. Den Typ aus dem Querwind in 850 hPa bestimmen: über +2 m/s Kaltfront,
   unter −2 m/s Warmfront, dazwischen quasistationär. Eine Linie, deren Typ
   wechselt, wird in Stücke zerlegt.

Die Ausgabe ist eine GeoJSON-FeatureCollection. Jedes Feature trägt
`front_type`, `level`, `valid_time`, `length_km`, `gradient`, `tfp`,
`cross_wind` sowie `warm_side` und `motion_side` für die Symbole.

**Erste Kalibrierung** am Fall 2026-10-09 00/06 UTC gegen die Karten von
DWD, KNMI und GeoSphere. Die Startschwellen 0,3/1,5 fanden nur zwei Fronten.
Mit 0,1/0,8 werden gefunden:

- die Warmfront Schottland–England–Kanal bzw. Nordsee–Belgien–Bretagne,
- die atlantische Kaltfront,
- die Warmfront über Finnland,
- die Kaltfront Ostsee–Polen–Alpen.

Die TFP-Methode allein liefert aber auch **Fehltreffer ohne Wetter** über Nordafrika, Südspanien
und dem östlichen Mittelmeer. Diese sortiert das Wetterkriterium aus (s. unten).
Okklusionen erscheinen als Warmfront.
Die Fronten des Ligurientiefs fehlen.

Die synoptischen Kriterien aus den DWD-Kompendien und wie sie umgesetzt
werden (Stand und Plan) stehen in [KRITERIEN.md](KRITERIEN.md).

**Wetter- und Dynamikkriterium** (`src/fronts/activity.js`, Stand
2026-10-09): Jeder Stützpunkt wird bewertet nach

- T850-Kontrast,
- Rinne im Bodendruck, die zugleich die Bodenposition auf der warmen Seite
  liefert,
- Konvergenz und Vorticity des ~10-m-Winds,
- Sprung der 3-h-Tendenz,
- Niederschlag, tiefen Wolken und w700.

Daraus ergibt sich `activity = Kontrast · (½ Wetter + ½ Dynamik)`. Der Wert
wird entlang der Linie geglättet. Die Linie wird dann in die Klassen
`active`, `weak` und `none` geteilt. Stücke der Klasse `none` gibt
`detectFronts` nur mit `keepInactive: true` aus. Die Drucktendenz braucht
den Vortermin als `prev`. Ergebnis am Testfall: Alle Fehltreffer über
Nordafrika und Iberien fallen weg, die Hauptfronten bleiben (Details in
[KRITERIEN.md](KRITERIEN.md)).

Noch offen:

- **Okklusionen**: Tiefzentren, Warmluftzunge in θw bzw. in der
  Schichtdicke, Okklusionspunkt.
- Die Frontlinie auf die geschätzte Bodenposition verschieben (der Versatz
  ist schon als `criteria.sfc_offset_km` verfügbar).
- Den Typ aus der Verlagerung zwischen den Terminen bestimmen.
- Lücken zwischen Linienstücken schließen.
- Fronten des Ligurientiefs: zu wenig θw-Gradient in 850 hPa, das Gelände
  ist maskiert.

## Testfälle (Fixtures)

Ein Testfall umfasst mehrere Termine, Druckflächen und Oberflächenfelder.
Mehrere Termine braucht es für Drucktendenz und Frontverlagerung.

```bash
node tools/fronts/fetch-case.mjs --start 2026-10-08T18:00 --end 2026-10-09T12:00 --name 2026-10-09
```

Das Skript schreibt nach `fixtures/<model>_<name>.json.gz` (gzip, Format v2).

Optionen:

- `--step` in Stunden, Default 3
- `--pressures`, Default `850,700`
- `--model`, `--res`, `--bbox latMin,latMax,lonMin,lonMax`, `--out`

**Dauer:** Ein Termin umfasst rund 140 Variablen je Punkt (Level 50–70 plus
Oberfläche) und braucht etwa **2,5 min**. Der Fall oben mit 7 Terminen hat
19 min gedauert. Zum Vergleich: 80 Variablen je Punkt brauchten 8 s. Für
einen Betrieb im Cron ist der Weg über Modelllevel daher zu teuer. Dort
wären Druckflächen auf dem Server oder die `.om`-Dateien auf S3 besser
(s. unten). Der Server hält nur etwa eine Woche Historie, Fälle also
zeitnah sichern.

Format v2:

```
{ version: 2, model, res, lat0, lon0, nx, ny, pressures, stepH, times,
  lastRunAtFetch, fetchedAt, units,
  steps: [ { validTime, leadH,           // leadH 0 = aus dem Lauf zu diesem Termin
             levels: { 850: {T,q,u,v,w,below}, 700: {…} },
             psfc, u10, v10,             // unterstes Modelllevel (~10 m)
             sfc: { pressure_msl, precipitation, rain, showers, cloud_cover,
                    cloud_cover_low/mid/high, temperature_2m, dew_point_2m, cape } } ] }
```

Arrays sind row-major (j·nx+i, Süd→Nord, West→Ost), `null` steht für fehlend.
`fieldAt(fixture, step, pressure)` aus `meteokit/fronts` liefert einen
Termin in der Form, die `detectFronts` erwartet.

Vorhandene Fälle:

| Datei | Termine | Bemerkung |
|---|---|---|
| `icon_eu_2026-10-09.json.gz` | 08.10. 18 UTC – 09.10. 12 UTC, 3-stündlich | 18–06 UTC Analyse, 09 und 12 UTC +3/+6 h. Island-Tief mit Okklusion, Ostsee-Tief, Ligurien-Tief. Vergleichskarten: DWD 00 UTC, KNMI und GeoSphere 00/06 UTC |
| `icon_eu_850_2026100900_an.json` u. a. | ein Termin | Format v1, nur 850 hPa, aus dem Spike. Die Debug-Seite liest sie weiterhin |

## Debug-Seite

```bash
python3 -m http.server 8765    # im Repo-Root
# http://127.0.0.1:8765/tools/fronts/debug.html?fixture=fixtures/icon_eu_2026-10-09.json.gz
```

Die Seite bietet eine Auswahl von Termin und Druckfläche. Als Schattierung
stehen zur Wahl:

- θe, θw, T, |∇θw|, TFP
- 3-h-Drucktendenz
- Niederschlag
- Gesamtbewölkung und tiefe Wolken
- w und Spread in 700 hPa

Dazu kommen Isobaren (5 hPa), Isolinien, Windpfeile auf der Fläche und bei
~10 m sowie die Orographiemaske. Darüber liegen die detektierten
Fronten mit den üblichen Symbolen. Die Schwellen K1, K2, Mindestlänge und
Windschwelle sind live einstellbar. Optional lassen sich alle Kandidaten
ohne Masken in Grau einblenden. Das Ergebnis kann als GeoJSON gespeichert
werden. Glättung σ und Deckkraft lassen
sich per Schieberegler einstellen, beim Überfahren mit der Maus erscheinen
die Punktwerte. Als Hintergrund dienen Küsten und Ländergrenzen (Natural
Earth über `world-atlas`), keine Kachelkarte und damit kein API-Key. Leaflet,
`topojson-client` und die Grenzdaten kommen aus dem Netz. Das ist nur für
diese Debug-Seite so, die Bibliothek selbst hat keine Abhängigkeiten.

## Alternative Datenquelle

Im Open-Meteo-Bucket auf AWS
(`https://openmeteo.s3.amazonaws.com/index.html#data/dwd_icon_eu/`) liegen
die ICON-EU-Druckflächen direkt vor, ohne API-Limits. Das Format ist das
eigene `.om`-Format von Open-Meteo, man bräuchte also einen Reader. Das ist
eine Option für einen späteren Server-Cron.
