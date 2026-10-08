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

Noch offen: TFP, Frontlinien, Masken, Klassifikation, GeoJSON-Ausgabe und
der Vergleich mit den Analysekarten von DWD, GeoSphere und KNMI.

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

Die Seite zeigt θe, θw, T oder |∇θw| als Schattierung, wahlweise mit
Isolinien, Windpfeilen und Orographiemaske. Glättung σ und Deckkraft lassen
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
