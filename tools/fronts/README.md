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

Es gibt aber auch **Fehltreffer ohne Wetter** über Nordafrika, Südspanien
und dem östlichen Mittelmeer. Okklusionen erscheinen als Warmfront.
Die Fronten des Ligurientiefs fehlen.

Noch offen:

- **Wetter- und Dynamikkriterium.** Eine Front ist eine Luftmassengrenze
  *mit Wetter*, deshalb sollen keine Linien quer durch Hochs laufen.
  Geplant sind Niederschlag, Bewölkung, w in 700 hPa, Konvergenz und
  Bodendruckrinne, als Attribut `activity` je Segment.
- Schließen von Lücken zwischen Linienstücken.
- Okklusionen.

## Testfall sichern

```bash
node tools/fronts/fetch-field.mjs --time 2026-10-09T00:00
```

Das Skript schreibt nach `fixtures/<model>_<hPa>_<YYYYMMDDHH>_<an|fcNN>.json`.
`_an` heißt, die Stunde stammt aus dem Lauf zu diesem Termin (+0 h).
`_fcNN` heißt, das Feld wurde vorher abgerufen und ist eine
NN-h-Vorhersage aus dem letzten Lauf. Der Server hält nur etwa eine Woche
Historie, interessante Fälle also zeitnah sichern. Optionen: `--model`,
`--res`, `--pressure`, `--bbox latMin,latMax,lonMin,lonMax`, `--out`.

## Debug-Seite

```bash
python3 -m http.server 8765    # im Repo-Root
# http://127.0.0.1:8765/tools/fronts/debug.html?fixture=fixtures/icon_eu_850_2026100900_fc06.json
```

Die Seite zeigt θe, θw, T, |∇θw| oder TFP als Schattierung, wahlweise mit
Isolinien, Windpfeilen und Orographiemaske. Darüber liegen die detektierten
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
