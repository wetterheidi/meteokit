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
2. θw mit einer Gauß-Glättung von σ = 90 km glätten.
3. TFP = −∇|∇θw|·n̂ berechnen.
4. Die Frontlinie ist die Nulllinie von ∇TFP·n̂, also die warme Kante der
   Frontalzone.
5. Masken anwenden: K1 verlangt TFP > 0,1 K/(100 km)², K2 verlangt
   |∇θw| + m/√2·TFP > 0,8 K/100 km.
6. Linien verketten, an scharfen Ecken teilen („wie Segel“) und alles unter
   400 km verwerfen.
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
`detectFronts` nur mit `keepInactive: true` aus. An freien Linienenden
(keine andere Linie näher als 350 km) endet die Front, wo der Kontrast
unter 3,5 K fällt. Die Drucktendenz braucht
den Vortermin als `prev`. Ergebnis am Testfall: Alle Fehltreffer über
Nordafrika und Iberien fallen weg, die Hauptfronten bleiben (Details in
[KRITERIEN.md](KRITERIEN.md)).

**Bodenposition**: Standardmäßig (`position: "surface"`) werden Kalt- und
quasistationäre Fronten von der 850-hPa-Lage zur Bodendruckrinne auf der
warmen Seite verschoben, Warmfronten nicht (s. KRITERIEN.md).
`properties.level` ist dann `"surface"`, der Versatz steht in
`surface_offset_km`. Mit `position: "analysis"` bleibt die Lage in der
Analysefläche.

**Okklusionen und Tiefs** (`src/fronts/occlusion.js`): `findLows` sucht
Minima im geglätteten Bodendruck mit mindestens 3 hPa Tiefe gegenüber
einem Ring von 500 km. Am Gebietsrand darf der Ring teilweise fehlen. Am
Okklusionspunkt trifft das Ende einer Kalt- oder Warmfront (höchstens
350 km entfernt) auf eine Front des anderen Typs. Dort wird der Ast, der
vom Warmsektor wegzeigt, als `front_type: "occluded"` abgetrennt. Seine
Geometrie folgt der Rückenachse des Warmluftkeils (`ridgeLines`): bevorzugt
aus der Schichtdicke 500/1000, sonst aus θw in 700 hPa. Sie reicht vom
Okklusionspunkt bis vor den Tiefkern. Ohne passende Achse bleibt der
Frontast. Die zuführende Kalt- bzw. Warmfront biegt weich
bis an den Okklusionspunkt ein, damit sich dort alle drei Fronten treffen.
`occlusion_character` nennt nur den Typ des Stücks, von dem die
Okklusion ihre Eigenschaften übernimmt; den Charakter bestimmt die Analyse
nicht (Zeichenregel, s. KRITERIEN.md). **Nachbearbeitung** (`src/fronts/postprocess.js`): Lücken zwischen Fronten
gleichen Typs werden geschlossen, wenn entlang der Lücke Niederschlag
fällt. Zum Schluss werden alle Fronten geglättet. **Jede Front hängt an
einem Tiefkern** (`requireLowLink`, Vorgabe der Projektleitung): direkt
oder über ihr Frontsystem, bei teilokkludierten Tiefs über die Okklusion.
Fronten gelten als verbunden, wenn ein Ende höchstens 150 km von der
anderen Linie entfernt liegt; ein System ist angeschlossen, wenn eine
seiner Fronten näher als 300 km an einem Tiefkern liegt oder seine
Okklusion zu einem Randtief führt. Systeme ohne Anschluss werden zu
`activity_class: "none"` mit `unlinked: true` (abschaltbar mit
`post: { lowLink: false }`).

**Fronten aus Niederschlagsachsen** (`src/fronts/precipfronts.js`, in
Erprobung, `precipFronts: true`, in der Debug-Seite per Häkchen, standardmäßig aus): für Tiefs
mit schwachem Luftmassenkontrast (Genuatief), an denen nach der
TFP-Analyse keine Front liegt (500 km). Rückenachsen des Niederschlags im
Umkreis von 1000 km, an Gabelungen und Ecken geteilt, geglättet; Stücke
ab 250 km mit mindestens 0,3 mm/h. Typ aus der Temperaturadvektion
(850 hPa, im Gelände 700 hPa). Begleitbänder von TFP-Fronten entfallen.
Danach eigene Lücken- und Okklusionsanalyse, dann dieselbe Glättung und
Anschlussregel. Kennzeichen `method: "precip"`, Kriterien `precip` und
`advection_k10h`.

**Schwache Fronten (Erprobung, standardmäßig aus):** `fillTerrain`
(Geländelücken in θw harmonisch füllen), `maskGapKm` (kurze Maskenlücken
überbrücken), dazu `windMin` und `activity.contrastRamp` niedriger; in der
Debug-Seite als Bündel „Schwache Fronten“. Ebenfalls in Erprobung:
`thermo: "thE"` (TFP auf θe), `maskRunKm` (Masken über die Linie gemittelt),
`activity.contrastE` (θe-Kontrast). Stand und Messungen in KRITERIEN.md.

Die Okklusion muss zu einem Tief hin zeigen (auch zu einem Randtief
jenseits des Gebiets), pro Tief gibt es höchstens eine.

Am Okklusionspunkt gelten die Zeichenregeln der Referenzanalyse
(KRITERIEN.md, Abschnitt 10):

- Optional (`opRefine`, standardmäßig aus): den Punkt zum stärksten
  3-h-Druckfall entlang des Warmluftkeils verschieben.
- Die Okklusion setzt die Kaltfront ohne Knick fort, die Warmfront knickt
  ab. Dafür wird der Punkt bei Bedarf bis 150 km entlang der Kaltfront
  zurückgelegt (`opSlideKm`).
- Die Okklusion läuft spiralig gegen den Uhrzeigersinn bis 80 km vor den
  Kern, der Druck fällt dabei zum Kern hin.
- Fronten machen keine Kehrtwenden („wie Segel“). Die Tiefs stehen in
`properties.lows` der FeatureCollection.

Noch offen:

- Fronten des Genuatiefs (Referenz: Handanalyse 09.10. 12 UTC, KNMI).
  Erster Ansatz über Niederschlagsachsen, noch unvollständig (s.
  KRITERIEN.md).
- Okklusionen ohne passende TFP-Linie.
- Zurückgestellt: den Typ aus der Verlagerung zwischen den Terminen
  bestimmen. Die Bestimmung über den Querwind in 850 hPa trifft den
  Testfall, hilfreich wäre die Verlagerung vor allem bei schleifenden
  Fronten.
- Fall 10.10. 06 UTC: Front Biskaya – Dänemark fehlt (in 850 hPa diffus,
  in 700 hPa deutlich), keine Okklusionen an den Lehrbuchtiefs; Details in
  KRITERIEN.md. Zurückgestellt, bis 09.10. 12 UTC abgeschlossen ist.
- Lage des Okklusionspunkts und der Fronten relativ zu Rinne und
  Niederschlag (Handanalyse 09.10. 12 UTC, KRITERIEN.md).

## Testfälle (Fixtures)

Ein Testfall umfasst mehrere Termine, Druckflächen und Oberflächenfelder.
Mehrere Termine braucht es für Drucktendenz und Frontverlagerung.

```bash
node tools/fronts/fetch-case.mjs --start 2026-10-08T18:00 --end 2026-10-09T15:00 --name 2026-10-09
```

Das Skript schreibt nach `fixtures/<model>_<name>.json.gz` (gzip, Format v2).

Optionen:

- `--step` in Stunden, Default 3
- `--pressures`, Default `850,700`
- `--model`, `--res`, `--bbox latMin,latMax,lonMin,lonMax`, `--out`

**Dauer:** Ein Termin umfasst rund 150 Variablen je Punkt (Level 50–70 plus
Oberfläche, Druck der Level 40–49 für die Schichtdicke) und braucht etwa
**3 min**. Die Levelhöhen über Grund sind zeitlich konstant und werden nur
beim ersten Termin geholt. Zum Vergleich: 80 Variablen je Punkt brauchten 8 s. Für
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
             thickness,                  // Schichtdicke 500/1000 hPa [gpm]
             sfc: { pressure_msl, precipitation, rain, showers, cloud_cover,
                    cloud_cover_low/mid/high, temperature_2m, dew_point_2m, cape } } ] }
```

Arrays sind row-major (j·nx+i, Süd→Nord, West→Ost), `null` steht für fehlend.
`fieldAt(fixture, step, pressure)` aus `meteokit/fronts` liefert einen
Termin in der Form, die `detectFronts` erwartet.

Vorhandene Fälle:

| Datei | Termine | Bemerkung |
|---|---|---|
| `icon_eu_2026-10-06.json.gz` | 06.10. 06–15 UTC, 3-stündlich | alle Termine +0 h. Wellende Front über Großbritannien. Vergleichskarten: DWD und KNMI 12 UTC |
| `icon_eu_2026-10-08.json.gz` | 08.10. 09–21 UTC, 3-stündlich | alle Termine +0 h. Schleifende Kaltfront an den Alpen, Island- und Ostsee-Tief. Vergleichskarten: DWD und KNMI 12/18 UTC |
| `icon_eu_2026-10-09.json.gz` | 08.10. 18 UTC – 09.10. 15 UTC, 3-stündlich | 18–12 UTC Analyse, 15 UTC +0 h aus dem 15-UTC-Lauf. Island-Tief mit Okklusion, Ostsee-Tief, Ligurien-Tief. Vergleichskarten: DWD 00/12 UTC, KNMI und GeoSphere 00/06/12 UTC |
| `icon_eu_2026-10-10.json.gz` | 10.10. 00–09 UTC, 3-stündlich | 00–06 UTC Analyse, 09 UTC +3 h. Lehrbuchnahe Tiefs: Finnland-Tief mit Okklusion, Ostseewelle, Nordseetief, Wellen auf der Atlantikfront, Tief über Tunesien. Vergleichskarten: DWD, KNMI, GeoSphere 06 UTC |
| `icon_eu_850_2026100900_an.json` u. a. | ein Termin | Format v1, nur 850 hPa, aus dem Spike. Die Debug-Seite liest sie weiterhin |

## Debug-Seite

```bash
python3 -m http.server 8765    # im Repo-Root
# http://127.0.0.1:8765/tools/fronts/debug.html?fixture=fixtures/icon_eu_2026-10-09.json.gz
```

Die Seite bietet eine Auswahl von Termin und Druckfläche. Fronten werden mit den üblichen Symbolen gezeichnet (Okklusionen violett), Tiefs als rotes T mit Kerndruck. Als Schattierung
stehen zur Wahl:

- θe, θw, T, |∇θw|, TFP
- 3-h-Drucktendenz
- Schichtdicke 500/1000 hPa
- Niederschlag
- Gesamtbewölkung und tiefe Wolken
- w und Spread in 700 hPa

Dazu kommen Isobaren (5, 2 oder 1 hPa; fein aufgelöst zeigen sie die Knicke schwacher Fronten), die Knicklinien der Isobaren (Achsen maximaler zyklonaler Isobarenkrümmung), Isolinien, Windpfeile auf der Fläche und bei
~10 m, die Warmluftzungen (Rückenachsen der Schichtdicke bzw. θw 700) sowie die Orographiemaske. Darüber liegen die detektierten
Fronten mit den üblichen Symbolen. Die Schwellen K1, K2, Mindestlänge und
Windschwelle sind live einstellbar. Optional lassen sich alle Kandidaten
ohne Masken in Grau einblenden. Das Ergebnis kann als GeoJSON gespeichert
werden. Glättung σ und Deckkraft lassen
sich per Schieberegler einstellen, beim Überfahren mit der Maus erscheinen
die Punktwerte. Als Hintergrund dienen Küsten und Ländergrenzen (Natural
Earth über `world-atlas`), keine Kachelkarte und damit kein API-Key. Leaflet,
`topojson-client` und die Grenzdaten kommen aus dem Netz. Das ist nur für
diese Debug-Seite so, die Bibliothek selbst hat keine Abhängigkeiten.

### Handanalyse und Vergleich

Im Abschnitt „Handanalyse“ der Debug-Seite lassen sich Fronten zeichnen
und als Referenz für den jeweiligen Termin speichern:

- **Neue Front:** Typ wählen (kalt, warm, Okklusion, quasistationär,
  wahlweise schwach), dann mit Klicks Stützpunkte setzen. Doppelklick oder
  Enter beendet die Linie, Esc bricht ab. Gezeichnet wird ein glatter
  Spline (centripetaler Catmull-Rom) durch die Stützpunkte.
- **Bearbeiten:** Front anklicken. Dann lassen sich Punkte ziehen, ein
  Klick auf die Linie fügt einen Punkt ein, ein Rechtsklick auf einen Punkt
  löscht ihn. Typ und „schwach“ wirken auf die ausgewählte Front, „Seite ⇄“
  dreht die Symbole um. Entf löscht die Front, Strg/Cmd+Z macht rückgängig.
  Die Symbolseite wird beim Zeichnen aus θw bestimmt.
- **Automatik übernehmen:** Die aktiven und schwachen Fronten der Automatik
  werden zu bearbeitbaren Linien (Stützpunkte etwa alle 150 km), als
  Ausgangspunkt für Korrekturen.
- **Speichern:** Der Arbeitsstand bleibt pro Termin im Browser
  (`localStorage`). „Referenz speichern“ lädt `<Termin>.geojson` herunter,
  z. B. `2026-10-09T12.geojson`. Die Datei gehört nach
  `tools/fronts/reference/`, von dort lädt die Seite sie beim Wechsel auf
  den Termin automatisch, solange kein Browser-Entwurf existiert
  („Entwurf verwerfen“ lädt die Datei neu). „Datei laden …“ liest auch eine
  exportierte Automatik-Analyse.

Das Format ist eine FeatureCollection wie bei `detectFronts`
(`front_type`, `activity_class`, `warm_side`, `motion_side`), dazu die
Stützpunkte in `control_points` und `properties.valid_time`.

Unter den Knöpfen steht der Vergleich der Automatik mit der Handanalyse am
aktuellen Termin, mit den aktuellen Reglern. Über alle Referenzen zugleich
rechnet das Skript:

```bash
node tools/fronts/compare.mjs                  # Standardparameter
node tools/fronts/compare.mjs '{"sigmaKm":100}' --tol 150
```

Maße (`tools/fronts/compare.js`, längengewichtet, Abtastung 25 km):

- **Treffer:** Anteil der Referenzfronten, bei denen höchstens 150 km
  entfernt eine automatische Front gleichen Typs liegt.
- **Nur Lage:** dasselbe mit Fronten beliebigen Typs.
- **Fehlalarm:** Anteil der automatischen Fronten ohne Referenzfront
  gleichen Typs in 150 km.
- **Abstand:** mittlerer Abstand der getroffenen Referenzpunkte.

## Alternative Datenquelle

Im Open-Meteo-Bucket auf AWS
(`https://openmeteo.s3.amazonaws.com/index.html#data/dwd_icon_eu/`) liegen
die ICON-EU-Druckflächen direkt vor, ohne API-Limits. Das Format ist das
eigene `.om`-Format von Open-Meteo, man bräuchte also einen Reader. Das ist
eine Option für einen späteren Server-Cron.
