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
gekürzt; verbunden wird nur, wenn die warme Luft auf beiden Stücken auf
derselben Seite liegt. Zum Schluss werden alle Fronten geglättet. **Offenes Tief** (`junctionToCore`, Vorgabe): Treffen sich
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
Linienpunkte 800–1800 km vom Zentraltief (nahe am Kern zeichnet die
Projektleitung keine Fronten, 05.10. 12 UTC) gelten die Kontrastrampe
[0,5; 3] K statt [1,5; 3,5] K und 1 K statt 3,5 K Mindestkontrast an
freien Enden. Die Debug-Seite zeigt Zentraltiefs mit Ring, die Achse im
Tooltip.

**Werdende Teil- und Randtiefs** (`findWaveLows`, `waveLows`, Vorgabe seit
2026-10-12): lokale Minima der 3-h-Drucktendenz bis −3 hPa mit
zyklonalem Wirbel in 850 hPa ab 5·10⁻⁵ s⁻¹, höchstens 1250 km von einem
analysierten Tief (`wave.nearLowKm`, bis 12.10. 900 km; zyklogenetisch:
stärkster Druckfall am Okklusionspunkt bzw. im Vorfeld eines Teiltiefs),
zählen als Anker der Anschlussregel (`properties.waves`). 05.10. 12 UTC:
Treffer 0 → 38 %, übrige Referenzen unverändert. Ohne die Nähe zu einem
Tief griff eine Atlantikwelle am Westrand (06.10., Fehlalarm 13 → 33 %).

**Entstehende Teiltiefs** (seit 2026-10-12): liegt unter dem
Druckfallminimum (bis 150 km, `wave.minKm`) ein Minimum des auf 50 km
geglätteten Bodendrucks (`wave.minSmoothKm`, Tiefe ab 1 hPa), entfällt die
Nähe zu einem Tief (`genesis: true`): geschlossene Isobare plus
Zyklogenese. Welle 12.10. 06 UTC bei 50° N 18° W (997 hPa, −3,9 hPa/3 h,
8·10⁻⁵ s⁻¹), unter rund 100 flachen Minima der sechs Fälle das einzige mit
beiden Signalen.

**Zusammengesetzte Felder** (`mergeFields` in `src/fronts/field.js`, seit
2026-10-11): ICON-EU deckt im Norden und Westen nicht genug ab; Tiefs bei
Island, Grönland oder über der Barentssee lagen am Rand oder außerhalb, und
ihre Fronten fielen über die Anschlussregel weg. ICON Global allein hatte an
den Referenzen dreimal so viele Fehlalarme (18 statt 5 %), weil sein
Niederschlag flächiger ist und die Wetterpflicht leichter erfüllt. Deshalb
werden die Felder vor der Analyse zusammengesetzt: ICON-EU im eigenen
Gebiet, ICON Global außen (25–78° N, 80° W–60° E; bis 2026-10-12 nur bis 50° W, dann fehlte
das Tief bei Goose Bay am 06.10.), auf dem gemeinsamen
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
offenes Tief und kein Okklusionspunkt. Konkurrieren mehrere Punkte um ein
Tief, gewinnt der näher am Tief (`cutRank: "lowDist"`; vorher der engste
Anschluss, dann verdrängte am Goose-Bay-Tief ein kleiner Punkt an der
Labradorküste das Hauptsystem). Okklusionen über 2500 km
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
- Randtief vor Norwegen 05.10. 12 UTC (ohne geschlossene Isobare) wird
  nicht erkannt, seine Fronten fallen über die Anschlussregel weg.
- 09.10. 12 UTC: Die Atlantik-Kaltfront endet bei 28° W, die Handanalyse
  führt sie bis 43° W; Kaltfront am Karasee-Tief (Nordrand) und
  Russland-Warmfront nach Süden sind Fehlalarme.
- Russlandtief 10.10. 06 UTC: Okklusion und Kaltfront wie in der neuen
  Handanalyse, aber die Warmfront läuft mit Haken nördlich parallel zur
  Okklusion zurück statt nach Südosten.
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
Der Abruf selbst steckt in `src/fronts/cases.js` (`fetchCase`, Gebiete in
`CASE_DOMAINS`); die laufende Analyse (s. unten) nutzt denselben Code.

Optionen:

- `--step` in Stunden, Default 3
- `--pressures`, Default `850,700`
- `--model`, `--res`, `--bbox latMin,latMax,lonMin,lonMax`, `--out`

ICON Global für die Zusammensetzung (Level 96–120, Schichtdicke 88–95):

```bash
node tools/fronts/fetch-case.mjs --model icon_global --bbox 25,78,-80,60 \
  --start 2026-10-06T06:00 --end 2026-10-06T18:00 --name 2026-10-06
```

Debug-Seite und `compare.mjs` setzen eine ICON-EU-Fixture mit der
ICON-Global-Fixture gleichen Namens zusammen.

**Höhenwind** (seit 2026-10-12, Versuch): `--upper` holt nur 500 hPa
(T, q, u, v, w) aus den oberen Modellleveln (ICON-EU 36–54, ICON Global
84–100), ohne Oberfläche und Schichtdicke, nach
`fixtures/<model>_upper_<Name>.json.gz` (gleiches Raster wie die Fixture
gleichen Namens; rund 10 s je Termin bei ICON-EU, 0,8 MB je Fall). Die
Debug-Seite hängt die Fläche als `levels[500]` an die Termine, für die
Vorticity-Advektion. Die Dateien liegen vorerst nur lokal (`.gitignore`),
bis entschieden ist, ob der Versuch etwas bringt; wer sie braucht, holt sie
mit den Befehlen unten neu.

```bash
node tools/fronts/fetch-case.mjs --upper --start 2026-10-11T21:00 --end 2026-10-12T12:00 --name 2026-10-12
node tools/fronts/fetch-case.mjs --upper --model icon_global --bbox 25,78,-80,60 \
  --start 2026-10-11T21:00 --end 2026-10-12T12:00 --name 2026-10-12
```

**Dauer** (gemessen 2026-10-11): ein Termin rund 150 Variablen je Punkt
(Level 50–70 bzw. 96–120 plus Oberfläche und Druck der Level für die
Schichtdicke). ICON-EU (137×81 Punkte) braucht etwa **11 s**, ICON Global
über 25–78° N, 50° W–60° E (221×107 Punkte) etwa **25 s**, bis 80° W
(281×107) rund 25–30 s (30 Termine in gut 10 min, 2026-10-12). Die
Levelhöhen über Grund sind zeitlich konstant und werden nur beim ersten
Termin geholt. Am 2026-10-09 dauerte ein ICON-EU-Termin noch 3 min; der
Server ist seither deutlich schneller. Damit ist eine Vorberechnung im Cron
über Modelllevel machbar (rund 40 s je Termin für beide Modelle); die
Messung schwankt aber mit dem Serverausbau. ICON Global gibt es nur auf
dem eigenen Server, nicht auf dem Ausweichserver. Der Server hält die
Historie nur begrenzt (Stand 2026-10-12: zurück bis 29.09., rund zwei
Wochen), Fälle also zeitnah sichern.

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
| `icon_eu_2026-10-12.json.gz` | 11.10. 21 UTC – 12.10. 12 UTC, 3-stündlich | alle Termine +0 h (abgerufen 12.10.). Blindtest ohne vorherige Abstimmung: Hoch über Mitteleuropa, Tiefs vor Grönland und über dem Baltikum. Handanalyse 06 UTC folgt |
| `icon_global_<Name>.json.gz` | wie die ICON-EU-Fixture gleichen Namens | 25–78° N, 80° W–60° E (281×107), alle Termine +0 h (abgerufen 12.10.), für die Zusammensetzung |
| `icon_eu_upper_<Name>.json.gz`, `icon_global_upper_<Name>.json.gz` | wie die Fixture gleichen Namens | nur 500 hPa (T, q, u, v, w), abgerufen 12.10. für alle sechs Fälle; Versuch zur Vorticity-Advektion, zusammen rund 12 MB, nur lokal (nicht im Repo) |
| `icon_eu_850_2026100900_an.json` u. a. | ein Termin | Format v1, nur 850 hPa, aus dem Spike. Die Debug-Seite liest sie weiterhin |

## Laufende Analyse (`run-analysis.mjs`, seit 2026-10-13)

Grundlage der Webanwendung (synoptix.wetterheidi.de, Phase 1: Pipeline und
Archiv). Der Job holt zu den synoptischen Hauptterminen 00/06/12/18 UTC
die Felder, rechnet die Fronten und legt beides ab:

```bash
node tools/fronts/run-analysis.mjs --out tools/fronts/live   # lokal; live/ ist in .gitignore
```

- **Regelmäßig aufrufen** (auf dem Server alle 3 h, s. unten). Bearbeitet werden
  alle Haupttermine der letzten 24 h (`--lookback`), für die ICON-EU den Lauf
  zum Termin schon hat. Fertige Termine werden übersprungen, und eine Sperre
  (`<out>/.lock`) verhindert überlappende Läufe.
- **Vorläufig → endgültig.** ICON-EU liegt rund 4 h nach dem Termin auf dem
  Server, ICON Global erst nach rund 8 h (gemessen 13.10.). Bis dahin kommt der
  Außenbereich aus dem vorigen Global-Lauf (Vorhersage +6 h), und der Termin
  hat den Status `preliminary`. Ist der Global-Lauf da, holt ein späterer
  Aufruf ICON Global neu und setzt `final`.
- **Felder und Fronten getrennt.** Je Termin werden die Fixtures (Format v2,
  wie unter `fixtures/`; Vortermin −3 h für die Drucktendenz) und die
  Fronten als GeoJSON abgelegt (`keepInactive`, mit `properties.algo_version`).
  `algo_version` ist eine Prüfsumme über `src/fronts/*.js`. Ändert sich der
  Code, rechnet der Job die Termine im Fenster neu; `--redetect` rechnet das
  ganze Archiv ohne neuen Abruf.
- **Vorhersagen vorbereitet.** `--horizon 48` holt zusätzlich die Termine bis
  +48 h (3-stündlich) und rechnet für jeden die Fronten. Default ist 0, also nur
  die Analyse.
- **Aufbewahrung.** `--keep-days` (Default 60) löscht ältere Termine. Ein Termin
  braucht rund 3 MB (ICON-EU 0,7, ICON Global 1,7, Höhenflächen 0,7,
  Fronten 0,07), also rund 0,75 GB für 60 Tage. `--no-upper` lässt die
  Höhenflächen (500 hPa) weg.
- **Dauer.** Gemessen 13.10.: rund 2 min je Termin (ICON-EU 20 s, ICON Global
  55 s, Höhenflächen 15 + 35 s). Die Abrufe laufen nacheinander.
- `--time 2026-10-13T06:00` holt genau diesen Termin neu.

Ablage:

```
<out>/latest.json                    neuester Termin: id, status, path, Fronten
<out>/index.json                     alle Termine, neuester zuerst
<out>/runs/<id>/run.json             Status, Läufe beim Abruf, Version, Dauer
<out>/runs/<id>/icon_eu_<id>.json.gz (+ icon_global_, icon_eu_upper_, icon_global_upper_)
<out>/runs/<id>/fronts_<YYYY-MM-DDTHH>.geojson
```

mit `<id>` = Analysetermin `YYYY-MM-DDTHH`. Alle Dateien werden atomar
geschrieben (`.tmp`, dann umbenennen), `run.json` zuletzt. Ein Termin
gilt erst als vorhanden, wenn es `run.json` gibt. Die archivierten Fixtures
lassen sich direkt als Testfälle nutzen, z. B. in `fixtures/` kopieren
oder `compare.mjs --fixtures <out>/runs/<id>`.

## Webanwendung synoptix (seit 2026-10-13)

https://synoptix.wetterheidi.de, geschützt über den Pförtner (Tool
`synoptix`). Die Startseite ist die Oberfläche `tools/fronts/` (s. unten) und
zeigt den neuesten Termin. Die Dateien dazu liegen in
`deploy/`:

| Datei | Zweck |
|---|---|
| `deploy-synoptix.sh` | Einspielen (`… rollback` holt den vorherigen Stand zurück). Verlangt committete `src/` und `tools/fronts/` |
| `synoptix.wetterheidi.de` | nginx-Vhost; `/tools/fronts/live/` zeigt auf das Archiv `/apps/synoptix/data` |
| `synoptix-analysis.service` | Job als `www-data`, `MemoryMax=350M`, `Nice=10` |
| `synoptix-analysis.timer` | alle 3 h um :30 UTC (01:30, 04:30, …, 22:30) |

Auf dem Server liegen die App in `/apps/synoptix/app` (vorheriger Stand in
`app.prev`) und das Archiv in `/apps/synoptix/data`. Das Deploy-Skript
fasst das Archiv nicht an. Ausgeliefert werden auch `fixtures/` und
`reference/`, die Testfälle lassen sich also online ansehen.
Ersteinrichtung: das Zertifikat mit `certbot certonly --nginx -d
synoptix.wetterheidi.de` holen, dann deployen.

**Zeitplan.** Der Server (2 Kerne, kein Swap) ist durch die
TLogPViewer-Downloads (`tlogp-d2eu.timer`, ab :15 alle 3 h, Dauer bis
1 h 45 min) gut die Hälfte der Zeit voll ausgelastet. Ein Testlauf
mittendrin brauchte 90 min statt weniger Minuten (13.10.). Der Job läuft
deshalb in den ruhigen Fenstern um :30, und das passt zur Verfügbarkeit
der Läufe:

| Termin | ICON-EU da (~T+4 h) | vorläufig um | ICON Global da (~T+8 h) | endgültig um |
|---|---|---|---|---|
| 00 UTC | ~04:00 | 04:30 | ~08:00 | 10:30 |
| 06 UTC | ~10:00 | 10:30 | ~14:00 | 16:30 |
| 12 UTC | ~16:00 | 16:30 | ~20:00 | 22:30 |
| 18 UTC | ~22:00 | 22:30 | ~02:00 | 04:30 |

Kommt ein ICON-EU-Lauf mehr als 30 min später, verschiebt sich die vorläufige
Analyse um 3 h.

**Speicher.** Gemessen 13.10. auf dem Server: Spitze 176 MB für einen Termin, 215 MB beim Nachholen von vier Terminen; rund 4 CPU-Minuten und 3 min Laufzeit
je Termin. Die Grenze `MemoryMax` sorgt dafür, dass bei Speichermangel nur der
Job beendet wird, nicht andere Dienste.

Betrieb:

```bash
ssh root@178.104.206.136 systemctl start synoptix-analysis     # Lauf von Hand
ssh root@178.104.206.136 journalctl -u synoptix-analysis -n 50 # Protokoll
ssh root@178.104.206.136 systemctl list-timers synoptix-analysis.timer
```

## Oberfläche: Synoptix und Debug-Seite

```bash
python3 -m http.server 8765    # im Repo-Root
# http://127.0.0.1:8765/tools/fronts/                (Synoptix, neuester Termin der laufenden Analyse)
# http://127.0.0.1:8765/tools/fronts/?fixture=fixtures/icon_eu_2026-10-09.json.gz
# http://127.0.0.1:8765/tools/fronts/debug.html      (Fronten-Debug)
```

Seit 2026-10-13 gibt es eine Oberfläche, `index.html` mit `app.js`.
`debug.html` leitet auf `index.html?debug=1` weiter (alte Links mit
`?fixture=…&step=…` bleiben gültig). Mit `debug` heißt die Seite
„Fronten-Debug“ und zeigt zusätzliche Werkzeuge zur Abstimmung der
Automatik (Elemente `.debug-only`): Kandidaten ohne Masken, also die rohen
TFP-Nulllinien vor allen Filtern, und der Schalter „Fronten in Bodenlage“.
Ohne Häkchen läuft dort die ganze Analyse auf der Lage in der Druckfläche;
weil Lückenschluss, Okklusionen und Anschluss an Tiefs danach kommen, ergibt
das andere Okklusionspunkte und Fronttypen und ist nicht an den
Handanalysen abgestimmt. Synoptix zeigt immer die Bodenfronten
(Entscheidung 13.10.: maßgeblich sind die Bodenfronten, die Neigung muss
nicht eigens gezeichnet werden).

Ohne Angabe lädt die Seite den neuesten Termin der laufenden Analyse aus
`live/` neben der Seite (`fixture=latest`, ein anderes Verzeichnis mit
`?live=…`), sonst die Fixture vom 09.10. Archivierte Termine stehen mit
Status oben in der Liste „Daten“. Die Fronten rechnet die Seite wie immer
selbst, mit den eingestellten Schwellen.

Die Seite bietet eine Auswahl von Termin und Druckfläche. „ICON Global
außen“ (Vorgabe an) lädt zur ICON-EU-Fixture die ICON-Global-Fixture
gleichen Namens und setzt die Felder zusammen; die Termine sind dann die,
die beide haben. Fronten werden mit den üblichen Symbolen gezeichnet
(Okklusionen violett), Tiefs als rotes T mit Kerndruck.

**Schattierung** als Knopfraster nach Themen; die Tasten `,` und `.`
schalten zurück bzw. vor (die Wahl steht in der URL als `field=`).
Wo die Druckfläche unter Grund liegt, ist die Karte grau.

- Druckfläche: θe, θw, T, |∇θw|, TFP, Frontogenese nach Petterssen
  (`frontogenesis` in `src/fronts/frontogenesis.js`, aus θw und Wind der
  Analysefläche mit derselben Glättung, K/(100 km · 3 h); rot Frontogenese,
  blau Frontolyse; der Tooltip einer Front zeigt den Mittelwert entlang
  der Linie; bisher nur Anzeige, keine Regel)
- Boden: 3-h-Drucktendenz, Niederschlag, Gesamtbewölkung, tiefe Wolken
- 700 hPa: w und Spread
- Höhe: Schichtdicke 500/1000 hPa und zyklogenetische Hinweise
  (`src/fronts/cyclogenesis.js`, bisher nur Anzeige): Z500 (Z1000
  hypsometrisch aus dem Bodendruck plus Schichtdicke), Vorticity-Advektion
  und Vorticity in 500 hPa aus dem echten Wind (nur mit Höhenwind-Daten),
  3-h-Änderung der Vorticity der gewählten Druckfläche

**Isolinien**: beliebig viele zugleich, je mit eigenem Abstand und Stil:
Isobaren (Vorgabe 5 hPa; fein aufgelöst zeigen sie die Knicke schwacher
Fronten), Isohypsen der gewählten Druckfläche, θe, θw, Schichtdicke und
Z500. Die Isohypsen rechnet `geopotentialLevel` (`derive.js`)
hypsometrisch vom Boden aus, weil der Server keine Geopotentialfelder der
Druckflächen liefert. Stichprobe 09.10. 00 UTC gegen die offiziellen
ICON-EU-Felder von Open-Meteo: Abweichung unter 1 gpdm in 850 und 700 hPa
(Berlin, München, Atlantik).

Dazu kommen Windpfeile auf der Druckfläche und bei ~10 m, die
Warmluftzungen (Rückenachsen der Schichtdicke bzw. θw 700), die
Knicklinien der Isobaren (Achsen maximaler zyklonaler
Isobarenkrümmung) und optional die Linien ohne Wetter. Die Fronten stehen
in Bodenlage: Kalt- und quasistationäre Fronten sind von der Lage in der
Druckfläche zur warmen Seite verschoben (s. oben, Bodenposition). Die Schwellen K1,
K2, Mindestlänge, Windschwelle und die Glättung σ stehen unter
„Einstellungen der Analyse“ (eingeklappt). Das Ergebnis kann als GeoJSON
gespeichert werden. Der Kasten „Werte“ unten links auf der Karte zeigt die
Punktwerte unter der Maus (einklappbar). Als Hintergrund dienen Küsten und
Ländergrenzen (Natural Earth über `world-atlas`), keine Kachelkarte und
damit kein API-Key. Leaflet, `topojson-client` und die Grenzdaten kommen
aus dem Netz. Das ist nur für diese Oberfläche so, die Bibliothek selbst
hat keine Abhängigkeiten.

**Aufbau** (seit 2026-10-13, Phase 2 von synoptix): `app.js` enthält nur
die Bedienung (Seitenleiste, Laden, URL, Ablage von Entwürfen und
Referenzen). Zeichnen und Rechnen liegen in `src/fronts/map/`
(`meteokit/fronts/map`), damit die synoptix-App dieselben Bausteine nutzt:

| Modul | Inhalt |
|---|---|
| `scales.js` | Farbskalen der Schattierung (`SCALES`, `colorAt`), Legende |
| `derive.js` | abgeleitete Felder ohne DOM: θe/θw/T/\|∇θw\| (`thermoDerived`), Tendenz, Niederschlag, w700, Spread, Schichtdicke, Z500, PVA (`caseDerived`), Isohypsen der Druckfläche (`geopotentialLevel`), Knicklinien, Mittel entlang einer Linie |
| `layers.js` | Leaflet-Ebenen: Schattierung, Isolinien, Isobaren, Windpfeile, Fronten mit Symbolen und Tooltip, Tiefs |
| `editor.js` | Handanalyse: `createFrontEditor` (Zeichnen, Punkte ziehen/einfügen/löschen, Undo, Tastatur), Spline, GeoJSON |

Leaflet wird als Parameter übergeben (wie bei `meteokit/airspace`). Der
Editor speichert nichts selbst: Er meldet Änderungen über `onChange`, und
die Seite legt den Entwurf im Browser ab. Beim Umbau war die Seite in 40
Einstellungen pixelgleich mit dem vorherigen Stand (Canvas-Prüfsummen).

### Handanalyse und Vergleich

Im Abschnitt „Handanalyse“ der Oberfläche lassen sich Fronten zeichnen
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
„ICON Global außen“ das zusammengesetzte Gebiet; `partial`, `note` und
`exclude` der geladenen Referenz bleiben beim Speichern erhalten); ältere Referenzen ohne
Angabe gelten als auf ICON-EU gezeichnet. `--model` rechnet nur auf einem
Modell, `--clip` legt das ausgewertete Gebiet fest, `--fixtures` und
`--refs` nehmen Fixtures bzw. Referenzen aus einem anderen Verzeichnis. `--rim 5` spart einen
Randstreifen (Grad) aus, in Referenz und Automatik: am Rand kann die
Handanalyse nicht beurteilen, wie es jenseits des Gebiets weitergeht.
Ausschlussgebiete der Referenz (`properties.exclude`, Liste von
`{latMin, latMax, lonMin, lonMax, note}`, von Hand eingetragen) zählen
weder in Referenz noch Automatik: Systeme, die die Analystin bewusst offen
lässt (Dipoltief 12.10.).

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
