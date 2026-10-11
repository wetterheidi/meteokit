# fronts – Werkzeuge zur objektiven Frontenanalyse

Im Aufbau. Ziel: Fronten aus ICON-Feldern in 850 hPa nach der TFP-Methode
(Hewson 1998) bestimmen und als GeoJSON an Apps liefern, z. B. dronecast.
Gerechnet wird auf zusammengesetzten Feldern: ICON-EU innen, ICON Global
außen (s. unten).
Kernmodul ist `src/fronts/` (`meteokit/fronts`). Hier liegen Abrufskript,
Debug-Seite und Testfälle.

## Stand (Spike, 2026-10-08)

- `fetchPlaneField` holt die Modelllevel 50–70 (ICON Global 96–120) sowie das unterste Level per
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

## Detektion (`detectFronts`, Stand 2026-10-10)

`src/fronts/detect.js` arbeitet in diesen Schritten:

1. θw berechnen. Wo die Fläche unter Grund liegt oder weniger als 25 hPa
   darüber, wird θw harmonisch aus der Umgebung aufgefüllt (`fillTerrain`),
   damit Linien nicht am Gebirge abreißen.
2. θw mit einer Gauß-Glättung von σ = 90 km glätten.
3. TFP = −∇|∇θw|·n̂ berechnen.
4. Die Frontlinie ist die Nulllinie von ∇TFP·n̂, also die warme Kante der
   Frontalzone.
5. Masken anwenden: K1 verlangt TFP > 0,1 K/(100 km)², K2 verlangt
   |∇θw| + m/√2·TFP > 0,8 K/100 km. Lücken der Masken bis 100 km entlang
   der Linie werden überbrückt (`maskGapKm`).
6. Abschnitte über Gelände unter 850 hPa entfernen (`terrainCut`): Fronten
   laufen nicht über die Alpen. Linien verketten, an scharfen Ecken teilen
   („wie Segel“) und alles unter 400 km verwerfen.
7. Den Typ aus dem Querwind in 850 hPa bestimmen: über +0,5 m/s Kaltfront,
   unter −0,5 m/s Warmfront, dazwischen quasistationär (`windMin`). Eine
   Linie, deren Typ wechselt, wird in Stücke zerlegt.

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

Daraus ergibt sich `activity = Kontrast · (½ Wetter + ½ Dynamik)`, der
Kontrastfaktor steigt von 1,5 bis 3,5 K (`contrastRamp`, kontrastarme
Tiefs wie das Genuatief haben 2–3 K). Zudem
gilt die Wetterpflicht (`weatherMin` 0,2): Das Wettermaß, über 800 km
entlang der Front gemittelt, muss sie erreichen; gelegentlicher schwacher
Niederschlag genügt. Der Wert
wird entlang der Linie geglättet. Die Linie wird dann in die Klassen
`active`, `weak` und `none` geteilt. Stücke der Klasse `none` gibt
`detectFronts` nur mit `keepInactive: true` aus. An freien Linienenden
(keine andere Linie näher als 350 km) endet die Front, wo der Kontrast
unter 3,5 K fällt. Die Drucktendenz braucht
den Vortermin als `prev`. Ergebnis am Testfall: Alle Fehltreffer über
Nordafrika und Iberien fallen weg, die Hauptfronten bleiben (Details in
[KRITERIEN.md](KRITERIEN.md)).

**Bodenposition**: Standardmäßig (`position: "surface"`) werden Kalt- und
quasistationäre Fronten von der 850-hPa-Lage zur warmen Seite verschoben,
dorthin, wo Bodendruckrinne und Niederschlag zusammen am stärksten sind
(`sfcPrecipWeight`); ohne erkennbare Rinne gibt es keinen Pauschalversatz
(`surfaceDefaultKm` 0). Warmfronten werden nicht verschoben (s.
KRITERIEN.md).
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
fällt; seitlich versetzte, parallele Enden (bis 200 km) werden vorher
gekürzt. Zum Schluss werden alle Fronten geglättet. **Offenes Tief** (`junctionToCore`, Vorgabe): Treffen sich
Warm- und Kaltfront höchstens 300 km vom Kern eines Tiefs ohne Okklusion,
wird der Übergang in den Tiefkern gelegt (`core_junction: true`).
**Okklusion am Niederschlag** (`post.occPrecip`, Vorgabe): die Okklusion
quer zur Linie bis 60 km zum Niederschlagsmaximum rücken, am
Okklusionspunkt fest. **Jede Front hängt an
einem Tiefkern** (`requireLowLink`, Vorgabe der Projektleitung): direkt
oder über ihr Frontsystem, bei teilokkludierten Tiefs über die Okklusion.
Fronten gelten als verbunden, wenn ein Ende höchstens 150 km von der
anderen Linie entfernt liegt; ein System ist angeschlossen, wenn eine
seiner Fronten näher als 300 km an einem Tiefkern liegt oder seine
Okklusion zu einem Randtief führt. Systeme ohne Anschluss werden zu
`activity_class: "none"` mit `unlinked: true` (abschaltbar mit
`post: { lowLink: false }`). **Brücken** (`post.bridges`, Vorgabe der
Projektleitung 2026-10-11): Erreicht ein System mit einer aktiven Front den
Anschluss nur über Stücke ohne Wetter, die im Mittel mindestens 4 K
Kontrast haben (`bridgeContrastMin`), werden diese Stücke schwach mit
`bridge: true` (frontolytisch, dieselbe Zyklonenfamilie). Mehrere solche
Stücke dürfen aufeinander folgen. **Doppellinien** (`dropDuplicates`):
liegt eine Front zu mindestens 70 % ihrer Punkte höchstens 100 km neben
einer stärkeren (Okklusion vor aktiv vor schwach), entfällt sie
(`duplicate: true`).

**Zentraltiefs** (`markCentralLows`, `activity.central`, Vorgabe seit
2026-10-11, Idee der Projektleitung): Alternde Tiefs verschmieren Kontraste
und Frontkriterien. Junge Tiefs sind vom Boden zur Höhe stromaufwärts
geneigt, Zentraltiefs stehen senkrecht. Z500 ≈ 8 m/hPa · (MSLP − 1000) +
Schichtdicke 500/1000; liegt das Z500-Minimum höchstens 150 km vom
Bodentief und ist das Tief mindestens 8 hPa tief (gegen den 500-km-Ring),
gilt es als Zentraltief (`central: true`, `tilt_km`). Die Tiefe trennt
junge Tiefs unter einem abgeschnürten Höhentief ab (Genuatief). Für
Linienpunkte bis 1800 km vom Zentraltief gelten die Kontrastrampe
[0,5; 3] K statt [1,5; 3,5] K und 1 K statt 3,5 K Mindestkontrast an
freien Enden. Die Debug-Seite zeigt Zentraltiefs mit Ring, die Achse im
Tooltip.

**Zusammengesetzte Felder** (`mergeFields` in `src/fronts/field.js`, seit
2026-10-11): ICON-EU deckt im Norden und Westen nicht genug ab; Tiefs bei
Island, Grönland oder über der Barentssee lagen am Rand oder außerhalb, und
ihre Fronten fielen über die Anschlussregel weg. ICON Global allein hatte an
den Referenzen dreimal so viele Fehlalarme (18 statt 5 %), weil sein
Niederschlag flächiger ist und die Wetterpflicht leichter erfüllt. Deshalb
werden die Felder vor der Analyse zusammengesetzt: ICON-EU im eigenen
Gebiet, ICON Global außen (25–78° N, 50° W–60° E), auf dem gemeinsamen
0,5°-Raster mit einem linearen Übergang über 2,5° zum ICON-EU-Rand. Innen
bleibt die Abstimmung an ICON-EU gültig, und an der Nahtstelle entstehen
keine Brüche in den Linien.

```js
const field = mergeFields(fieldAt(eu, n, 850), fieldAt(global, m, 850));
const fc = detectFronts(field, { prev: mergeFields(…Vortermin…) });
```

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

**Schleifende Fronten am Gebirgsrand** (`stauFronts`,
`src/fronts/staufronts.js`, Vorgabe): Endet eine Kaltfront höchstens
150 km vor dem Gebirge, läuft sie als quasistationäre Front am Nordrand
weiter, solange Druckanstieg (≥ 1,5 hPa/3 h) und Niederschlag
(≥ 0,3 mm/h) den Stau anzeigen; `method: "stau"`.

Die Vorgaben für Gelände und schwache Kontraste (Geländefüllung,
Geländeschnitt, Maskenlücken, Querwind 0,5 m/s, Kontrast ab 1,5 K,
Bodenposition nach Rinne und Niederschlag, schleifende Fronten, Okklusion
am Niederschlag) gelten seit 2026-10-10; sie wurden an drei Handanalysen
geprüft (Treffer 61 → 96 %, s. KRITERIEN.md). Die früheren Werte lassen
sich einzeln zurückstellen, z. B. `fillTerrain: false`, `windMin: 2`,
`surfaceDefaultKm: {cold: 120, stationary: 50}`. Weiter in Erprobung
(aus): `thermo: "thE"` (TFP auf θe), `maskRunKm` (Masken über die Linie
gemittelt), `activity.contrastE` (θe-Kontrast).

Die Okklusion muss zu einem Tief hin zeigen (auch zu einem Randtief
jenseits des Gebiets), pro Tief gibt es höchstens eine. Liegt der
Treffpunkt höchstens 150 km von einem Tiefkern (`coreSkipKm`), ist es ein
offenes Tief und kein Okklusionspunkt. Okklusionen über 2500 km
(`occMaxKm`) entfallen; beides kam erst mit dem größeren Gebiet vor
(Russlandtief 10.10.).

Am Okklusionspunkt gelten die Zeichenregeln der Referenzanalyse
(KRITERIEN.md, Abschnitt 10):

- Optional (`opRefine`, standardmäßig aus): den Punkt zum stärksten
  3-h-Druckfall entlang des Warmluftkeils verschieben.
- Die Okklusion setzt die Kaltfront ohne Knick fort, die Warmfront knickt
  ab. Dafür wird der Punkt bei Bedarf bis 150 km entlang der Kaltfront
  zurückgelegt (`opSlideKm`).
- Danach rückt der Punkt entlang der Okklusion bis 400 km zum stärksten
  3-h-Druckfall vor (`opFall`, Vorgabe seit 2026-10-11; Abzug 0,15 hPa je
  100 km, mindestens 0,3 hPa stärker), solange die Okklusion dort höchstens
  30° von der Richtung der Kaltfront abweicht. Kalt- und Warmfront reichen
  bis zum neuen Punkt. So setzt auch die Handanalyse den Punkt, er liegt
  damit meist auch im stärksten Niederschlag. Nur wenn die Kaltfront als
  ganzes Stück zurückgeschrieben wird.
- Die Okklusion läuft spiralig gegen den Uhrzeigersinn bis 80 km vor den
  Kern, der Druck fällt dabei zum Kern hin. Je 50-km-Schritt rückt sie
  mindestens 25 km näher an den Kern (`spiralInwardKm`); mit 8 km kreiste
  sie am Barentssee-Tief weit außen. Optional (`spiralPrecip`, aus) wählt
  sie unter den zulässigen Richtungen die mit dem meisten Niederschlag.
- Fronten machen keine Kehrtwenden („wie Segel“). Die Tiefs stehen in
`properties.lows` der FeatureCollection.

Noch offen:

- Genuatief: Okklusion und Warmfront vertretbar, die Kaltfront liegt rund
  100 km östlich parallel zur Handanalyse, der Okklusionspunkt bei Ancona
  statt La Spezia.
- Welle 06.10. 18 UTC: Die Kaltfront England–Atlantik hängt an keinem
  Tief und entfällt. Die Kette ohne Wetter über Nordsee und Ostsee hat nur
  im ersten Stück 4,6 K, sonst 1,6–2,0 K, und reißt 400 km vor dem
  Barentssee-Tief ab. Auch mit 1,5 K entsteht keine Brücke. Der DWD
  zeichnet durch.
- Russlandtief 10.10. 06 UTC: Mit ICON Global außen liegt der
  Okklusionspunkt bei 50° E, außerhalb des Gebiets der Handanalyse
  (Okklusion statt Warmfront entlang 64° N). Synoptisch zu prüfen.
- Seitenprüfung: vier Okklusionen und eine Kaltfront außerhalb des
  ICON-EU-Gebiets (Grönland, Nordmeer, Barentssee, Russland) widersprechen
  der θw-Seite; innen keine Abweichung.
- Okklusionen ohne passende TFP-Linie.
- Zurückgestellt: den Typ aus der Verlagerung zwischen den Terminen
  bestimmen. Die Bestimmung über den Querwind in 850 hPa trifft den
  Testfall, hilfreich wäre die Verlagerung vor allem bei schleifenden
  Fronten.
- Russlandtief 10.10. 06 UTC: die Warmfront liegt im Osten bis 120 km zu
  weit nördlich.
- Die Islandokklusion verliert durch die Ausrichtung am Niederschlag
  (13 → 31 km); prüfen, ob sie anders zu legen ist.

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

ICON Global für die Zusammensetzung (Level 96–120, Schichtdicke 88–95):

```bash
node tools/fronts/fetch-case.mjs --model icon_global --bbox 25,78,-50,60 \
  --start 2026-10-06T06:00 --end 2026-10-06T18:00 --name 2026-10-06
```

Debug-Seite und `compare.mjs` setzen eine ICON-EU-Fixture mit der
ICON-Global-Fixture gleichen Namens zusammen.

**Dauer** (gemessen 2026-10-11): ein Termin rund 150 Variablen je Punkt
(Level 50–70 bzw. 96–120 plus Oberfläche und Druck der Level für die
Schichtdicke). ICON-EU (137×81 Punkte) braucht etwa **11 s**, ICON Global
über 25–78° N, 50° W–60° E (221×107 Punkte) etwa **25 s**. Die
Levelhöhen über Grund sind zeitlich konstant und werden nur beim ersten
Termin geholt. Am 2026-10-09 dauerte ein ICON-EU-Termin noch 3 min; der
Server ist seither deutlich schneller. Damit ist eine Vorberechnung im Cron
über Modelllevel machbar (rund 40 s je Termin für beide Modelle); die
Messung schwankt aber mit dem Serverausbau. ICON Global gibt es nur auf
dem eigenen Server, nicht auf dem Ausweichserver. Der Server hält nur etwa
eine Woche Historie, Fälle also zeitnah sichern.

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
| `icon_eu_2026-10-05.json.gz` | 05.10. 00–21 UTC, 3-stündlich | alle Termine +0 h (abgerufen 11.10.). Testfall der Projektleitung, noch ohne Handanalyse; Tief im Nordmeer (12 UTC 70° N 6° E, 975 hPa) |
| `icon_eu_2026-10-06.json.gz` | 06.10. 06–18 UTC, 3-stündlich | alle Termine +0 h (abgerufen 11.10.). Wellende Front über Großbritannien, Barentssee-Tief. Vergleichskarten: DWD und KNMI 12 UTC, DWD 18 UTC |
| `icon_eu_2026-10-08.json.gz` | 08.10. 09–21 UTC, 3-stündlich | alle Termine +0 h. Schleifende Kaltfront an den Alpen, Island- und Ostsee-Tief. Vergleichskarten: DWD und KNMI 12/18 UTC |
| `icon_eu_2026-10-09.json.gz` | 08.10. 18 UTC – 09.10. 15 UTC, 3-stündlich | 18–12 UTC Analyse, 15 UTC +0 h aus dem 15-UTC-Lauf. Island-Tief mit Okklusion, Ostsee-Tief, Ligurien-Tief. Vergleichskarten: DWD 00/12 UTC, KNMI und GeoSphere 00/06/12 UTC |
| `icon_eu_2026-10-10.json.gz` | 10.10. 00–09 UTC, 3-stündlich | 00–06 UTC Analyse, 09 UTC +3 h. Lehrbuchnahe Tiefs: Finnland-/Russlandtief, Ostseewelle mit Skagerraktief, Nordseetief, Wellen auf der Atlantikfront, Tief über Tunesien. Vergleichskarten: DWD, KNMI, GeoSphere 06 UTC; Handanalyse 06 UTC (Skagerrak- und Russlandtief) |
| `icon_global_<Name>.json.gz` | wie die ICON-EU-Fixture gleichen Namens | 25–78° N, 50° W–60° E, alle Termine +0 h (abgerufen 11.10.), für die Zusammensetzung |
| `icon_eu_850_2026100900_an.json` u. a. | ein Termin | Format v1, nur 850 hPa, aus dem Spike. Die Debug-Seite liest sie weiterhin |

## Debug-Seite

```bash
python3 -m http.server 8765    # im Repo-Root
# http://127.0.0.1:8765/tools/fronts/debug.html?fixture=fixtures/icon_eu_2026-10-09.json.gz
```

Die Seite bietet eine Auswahl von Termin und Druckfläche. „ICON Global
außen“ (Vorgabe an) lädt zur ICON-EU-Fixture die ICON-Global-Fixture
gleichen Namens und setzt die Felder zusammen; die Termine sind dann die,
die beide haben. Fronten werden mit den üblichen Symbolen gezeichnet (Okklusionen violett), Tiefs als rotes T mit Kerndruck. Als Schattierung
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

Wurden nur einige Fronten eines Termins geprüft, bekommt die Referenz
`properties.partial: true`; `compare.mjs` zählt Fehlalarme dann nur im
Umkreis von 300 km um die geprüften Linien (Beispiel 08.10. 18 UTC: nur die
schleifende Front an den Alpen). „Automatik übernehmen“ hängt schon
übernommene Linien nicht erneut an.

Ablauf für eine neue Handanalyse: Die heruntergeladene Rohfassung kommt
nach `docs/Testfronten/` (lokale Ablage, per `.gitignore` nicht im Repo).
Ins Repo kommt nur die bereinigte Fassung in `tools/fronts/reference/`:
ungeprüfte, aus der Automatik übernommene Linien entfernt, bei
Teilanalysen `partial: true` und eine `note`, was geprüft wurde.

Unter den Knöpfen steht der Vergleich der Automatik mit der Handanalyse am
aktuellen Termin, mit den aktuellen Reglern. Er zählt das ganze geladene Gebiet;
bei zusammengesetzten Feldern zählen Fronten außerhalb einer nur auf
ICON-EU gezeichneten Referenz als Fehlalarm. Über alle Referenzen zugleich
rechnet das Skript:

```bash
node tools/fronts/compare.mjs                  # Standardparameter
node tools/fronts/compare.mjs '{"sigmaKm":100}' --tol 150
node tools/fronts/compare.mjs --no-merge        # nur ICON-EU
node tools/fronts/compare.mjs --model icon_global --clip 30,70,-23.5,44.5
```

Standardmäßig setzt das Skript die Felder zusammen (ICON-EU innen, ICON
Global außen), wenn es eine ICON-Global-Fixture mit dem Termin gibt, und
wertet nur das Gebiet aus, auf dem die Referenz gezeichnet ist: Die
Debug-Seite speichert es seit 2026-10-11 als `properties.domain` (mit
„ICON Global außen“ das zusammengesetzte Gebiet); ältere Referenzen ohne
Angabe gelten als auf ICON-EU gezeichnet. `--model` rechnet nur auf einem
Modell, `--clip` legt das ausgewertete Gebiet fest, `--fixtures` und
`--refs` nehmen Fixtures bzw. Referenzen aus einem anderen Verzeichnis.

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
