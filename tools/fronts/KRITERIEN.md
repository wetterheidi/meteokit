# Frontkriterien und ihre Umsetzung

Arbeitsgrundlage für die objektive Frontenanalyse in `src/fronts/`. Die
Kriterien stammen aus DWD-Ausbildungskompendien und sind hier sinngemäß
zusammengefasst, nicht wörtlich zitiert. Die Kompendien liegen nicht im
Repo. Kürzel:

| Kürzel | Kompendium |
|---|---|
| K7-M | 2.9.5-K7 Merkmale zur Festlegung der Fronten in der Bodenwetterkarte (Herzog) |
| K3-R | 2.9.5-K3 Regeln über die Bewegung und Entwicklung der Fronten (Leese) |
| K4 | 2.9.5-K4 Fronten (Kästner, 2003) |
| K1 | 2.10.3-K1 Analyse der Bodenwetterkarte |
| K5 | 2.10.2-K5 Analyse der Höhenwetterkarte |
| K7-L | 2.10.2-K7 Leitfaden zur Wetterkartenanalyse (2007) |
| K3-AK | 2.10.3-K3 Ana- und Katafront |
| K17 | 2.11.2-K17 Synoptische und synoptisch-numerische Methoden der Wettervorhersage |

Leitsatz (Projektvorgabe): **Eine Front ist eine Luftmassengrenze mit
Wetter.** Ein Gradientband allein ist noch keine Front.

## 1 Definition und Lage

- Die Front ist die Grenze der baroklinen Übergangszone **zur warmen Seite
  hin**. Am Boden liegt sie in einer Konvergenz mit zyklonalem Windsprung
  (K4, K7-M). Die TFP-Linie bildet genau diese warme Kante ab.
- Die Isothermen drängen sich auf der **kalten** Seite der Front (K1,
  K7-L).
- **Versatz zwischen 850 hPa und Boden** durch die Frontneigung (mittlere
  Neigung 1:150, Kaltfront bis 1:50, Warmfront bis 1:300; K1). Die
  850-hPa-Warmfront liegt 250–450 km *vor* der Bodenwarmfront, die
  850-hPa-Kaltfront 50–250 km *hinter* der Bodenkaltfront (K7-L).
  → Um die Bodenposition zu finden, sucht man von der 850-Linie aus zur
  warmen Seite hin nach der Rinne im Bodendruck und dem Windsprung.
- Mindestkontrast in 850 hPa: 4 K. Schwache Fronten haben 4–6 K, kräftige
  6–12 K, im Extremfall bis 20 K (K7-L).
  → Den Kontrast quer zur Zone integrieren, als Schwelle und als Maß für
  die Stärke.

## 2 Druckfeld und Wind (Hauptkriterien)

- Eine Front liegt **immer in einer Rinne tiefen Drucks**. Die Isobaren
  haben an der Front einen zyklonalen Knick, sie können dort nur Trogform
  annehmen (K1, K7-L).
- Eine Front mit antizyklonaler Isobarenkrümmung **und** Windsprung gibt
  es nicht. In Hochdruckgebieten liegen im Allgemeinen keine Fronten; wenn
  doch, sind die Isobaren dort zyklonal ausgebuchtet (K7-M).
  → Die Krümmung des Bodendrucks quer zur Linie muss zyklonal sein. Das ist
  das **Kriterium gegen Scheinfronten im Hoch**.
- Am Boden springt der Wind zyklonal, entlang der Front herrscht zyklonale
  Scherung. Die frontnormale Komponente ist auf beiden Seiten gleich
  gerichtet und meist konvergent (K1, K7-L).
  → Konvergenz und Scherung des Winds in ~10 m in einem Streifen um die
  Linie auswerten.
- Eine Absinkinversion, die die 850-hPa-Fläche schneidet, drängt dort die
  Isothermen, ohne dass es eine Front gibt (K7-L).
  → Absinken (w700 < 0), trockene Luft in 700 hPa (großer Spread) und
  antizyklonale Krümmung zusammen sprechen gegen eine Front.

## 3 Drucktendenz (3 h)

- An der Front springt die Tendenz (Unstetigkeit 0. Ordnung). Die
  Isallobaren verlaufen frontparallel und sind an Kaltfronten besonders
  dicht (K1).
- Typische Muster vor/hinter der Front (K7-M, K7-L):
  - üblich: deutlicher Fall vorn, schwacher Fall oder Anstieg hinten
  - seltener: schwacher Anstieg vorn, starker Anstieg hinten
  - unmöglich: starker Anstieg vorn, starker Fall hinten
- Eine Kaltfront liegt meist entlang der Null-Isallobare (K7-M).
- Störfaktor: die tägliche Doppelwelle des Luftdrucks mit 0,2–0,3 hPa,
  Maxima um 10 und 22 Uhr, Minima um 4 und 16 Uhr Ortszeit. Morgens wird
  Anstieg über- und Fall unterbewertet, mittags umgekehrt (K1). Die
  03-UTC-Karte überbewertet Fall, die 06-UTC-Karte Anstieg (K7-L).
  → Den **Sprung** der Tendenz über die Linie bewerten, nicht ihren
  absoluten Wert.
- Vorsicht: Auch Schauer und Tröge erzeugen Passagetendenzen (K7-M).

## 4 Wetter

- Fronten sind meist mit geschlossener tiefer Bewölkung und Niederschlag
  verbunden. Wolken und Regen gibt es aber auch ohne Front (K1, K7-L).
- Warmfront:
  - Niederschlagsband 100–300 km breit **vor** der Front
  - tiefste Wolkenuntergrenze und größte Bedeckung mit tiefen Wolken an
    der Front
  - dahinter oft trocken, Nieseln möglich (K7-M, K1)
- Kaltfront:
  - Anafront: breites Band hinter der Front
  - Katafront: schmales Band an der Front mit Schauern, dahinter
    Aufheiterung (K7-L, K3-AK)
- Hebung: Bei der Anafront gleitet die Warmluft auf, bei der Katafront
  gleitet sie ab und ist deutlich weniger wetterwirksam (K3-AK, K4).
  → Hebung in 700 hPa (w > 0) und Niederschlag oder Bewölkung in einem
  **asymmetrischen** Streifen um die Linie auswerten: bei Warmfronten auf
  der kalten Seite davor, bei Kaltfronten an oder hinter der Linie.

## 5 Typ und Verlagerung

- Der Typ ergibt sich aus der Temperaturänderung beim Durchgang: kälter
  heißt Kaltfront, wärmer heißt Warmfront (K1). Objektiv entspricht das
  der Zugrichtung relativ zur warmen Seite.
- Zuggeschwindigkeit, gemessen an der frontnormalen Komponente des
  **geostrophischen Bodenwinds**:
  - Kaltfronten 70–90 % (K3-R), nahe dem Tiefzentrum etwa 80 %, weiter
    weg bis 100 % (K17)
  - Warmfronten 60–80 % (K3-R, K17)
  → Typ besser aus der Verlagerung zwischen zwei Terminen bestimmen.
  Ersatzweise aus dem geostrophischen Bodenwind quer zur Linie statt aus
  dem 850-hPa-Wind.
- Isobarenparallele Fronten verlagern sich langsam in Richtung des
  stärksten Druckfalls. Ist die Tendenz gleichmäßig verteilt, ist die Front
  stationär (K3-R, K17). Eine stationäre Front liegt meist in einem scharf
  ausgeprägten Trog (K3-R).
- **Typwechsel entlang einer Linie:** Eine Kaltfront geht an der Achse
  eines (auch schwachen) Hochdruckkeils in eine Warmfront über. Eine
  Warmfront geht an einem Tiefzentrum in eine Kaltfront über (K1).
  → Prüfregel für unsere Stückelung nach Typ.
- Die Lage einer Front muss zur Lage am Vortermin und zum Wind passen (K1).
  → Verfolgung über die Termine.

## 6 Entwicklung (Frontogenese, Frontolyse)

- In antizyklonalen Gebieten lösen sich Fronten auf bzw. werden stationär
  (K3-R).
- Eine Front, die sich einem Tiefdrucktrog nähert, verschärft sich. Eine
  Front, die sich von ihm entfernt, löst sich auf (K3-R).
- Gebirge bremsen Fronten. Eine Kaltfront, die sich einer Gebirgskette
  nähert, kann sich verschärfen (K3-R).
- Rasch wandernde Kaltfronten neigen zur Auflösung (K3-R).
- Eine stationäre Front verschärft sich, wenn die isallobarischen
  Gradienten zur Front hin zeigen (K3-R).
- Schwache, sich bildende oder auflösende Fronten werden unterbrochen
  gezeichnet (K7-L).
  → Darstellung von Segmenten mit geringer `activity` gestrichelt statt
  weglassen.

## 7 Okklusionen

- Entstehen, wenn Kalt- und Warmfront zusammenwachsen. Über der Okklusion
  liegt eine vom Boden abgehobene Warmluftschale (K1).
- In der relativen Topographie 500/1000 hPa läuft die Okklusion **durch
  den Scheitel eines Warmluftkeils ohne Isohypsendrängung**. Die
  Kaltfront liegt dagegen gleich hinter dem Scheitel in der Drängungszone
  (K1).
  → Okklusion = Achse einer **Warmluftzunge** (Rücken in θw bzw. in der
  Schichtdicke).
- Zwei Arten (K1, K7-L):
  - Kaltfrontcharakter: Die Okklusion setzt die Kaltfront fort, die
    Warmfront knickt ab.
  - Warmfrontcharakter: Die Okklusion geht ohne Knick in die Warmfront
    über, die Kaltfront bildet einen Winkel.
- Der **Okklusionspunkt** (Kaltfront trifft Warmfront) fällt oft mit dem
  Zentrum eines 3-h-isallobarischen Tiefs zusammen (K1). Der stärkste
  Druckfall liegt 100–200 km vor dem Okklusionspunkt, die Okklusion selbst
  liegt nahe der Null-Isallobare (K7-M).
- Die Okklusion wird **spiralig um das Tiefzentrum** geführt, nicht hinein.
  Der stärkste Windsprung im Kern des Tiefs ist kein Okklusionskriterium
  (K4). Hilfsmittel nach K4:
  - 3-h-Tendenz (Druckfall unter der abgehobenen Warmluft)
  - Warmluftzunge in der Schichtdicke 500/1000 hPa
  - Isentropenanalyse in 700 hPa
  - tiefste Wolken und Niederschlag
- Ein Jetstream kreuzt den Frontenzug im Okklusionspunkt (K5, K7-L).
- Verwechslungsgefahr mit der Troglinie einer Kaltluftzunge. Das Wetter
  ist fast gleich, unterscheiden lassen sie sich nur über die
  Schichtdicke 500/1000 (K1).
- Alte Okklusionen werden oft zu Höhenkaltfronten (K1). Viele Kaltfronten,
  die Süddeutschland erreichen, sind eigentlich Okklusionskaltfronten (K4).

## 8 Was keine Front ist

- **Troglinie:** Windsprung, Schauerlinie und Isobarenknick, aber keine
  frontale Drängung der 850-hPa-Isothermen. Der Wind dreht stetig statt
  sprunghaft. Sie bewegt sich langsamer, als der Wind erwarten lässt
  (K7-M, K7-L, K1).
- **Konvergenz- und Böenlinien** (Squall line) bis 300 km vor
  Kaltfronten: kein frontaler Luftmassengegensatz (K7-L, K1).
- Küstenkonvergenzen, Seewindfronten u. ä. gehören nicht in eine
  synoptische Karte (K7-L).
- Orographische Isobaren (Föhntrog, Staukeil) sind kein frontaler Knick
  (K1).

## 9 Umsetzung (Stand und Plan)

| Kriterium | Größe im Code | Stand |
|---|---|---|
| warme Kante der Zone | TFP-Linie, Masken K1/K2 | ✓ `detectFronts` |
| Kontrast ≥ 4 K | T850 an der Linie minus 300 km kälterseitig, Rampe 2–4 K, als **Faktor** | ✓ `activity.js` |
| Rinne, zyklonale Krümmung | ∂²p/∂n² des Bodendrucks, Maximum im Fenster zur warmen Seite = Bodenposition | ✓ |
| Konvergenz, Windsprung | Konvergenz und Vorticity des ~10-m-Winds ±100 km um die Bodenposition | ✓ |
| Sprung der Tendenz | Δp(3 h) 150 km hinter minus 150 km vor der Bodenposition | ✓ (braucht Vortermin) |
| Wetter | max. Niederschlag oder tiefe Wolken × w700 zwischen 850-Linie und Bodenposition | ✓ |
| keine Front unter Absinkinversion | indirekt: kein Wetter, keine Rinne → Aktivität ≈ 0 | ✓ indirekt |
| Typ | Verlagerung zwischen Terminen, sonst geostrophischer Querwind | 850-hPa-Querwind ✓, Rest geplant |
| Bodenposition | Rinne zur warmen Seite hin suchen | Versatz als `criteria.sfc_offset_km`, Linie selbst noch nicht verschoben |
| Okklusion | Okklusionspunkt (Ende einer Kalt-/Warmfront an einer Front des anderen Typs, ≤ 350 km), vom Warmsektor wegzeigender Ast = Okklusion, Verlängerung entlang des θw-Rückens in 700 hPa bis vor den Tiefkern, alle drei Fronten treffen sich im Okklusionspunkt | ✓ `occlusion.js` |
| Darstellung schwacher Fronten | `activity_class` active / weak (gestrichelt) / none (entfällt) | ✓ |

**Schichtdicke 500/1000 hPa aus Modellleveln.** Die Schichtdicke ist das
Hauptkriterium für Okklusionen. Sie lässt sich ohne Geopotential
bestimmen: ICON-Level haben feste Höhen über Grund (`height_agl_level{N}`
ist zeitlich konstant), und z(500) − z(1000) ist die Differenz der auf die
beiden Druckflächen interpolierten Höhen über Grund. Die Geländehöhe hebt
sich dabei weg. Wo 1000 hPa unter Grund liegt, muss extrapoliert werden.
Dazu braucht es zusätzlich `pressure_level` etwa der Level 35–49
(Stichprobe: Level 48 ≈ 530 hPa).

**Aktivität, erste Kalibrierung** (Fall 2026-10-09, 21–09 UTC):

- Alle Hauptfronten sind durchgehend `active` mit Aktivität 0,7–0,95. Sie
  haben T850-Kontrast 4,4–6,5 K, Niederschlag 0,3–2 mm/h, Konvergenz
  1,2–3 · 10⁻⁵ s⁻¹ und einen Tendenzsprung bis 2,5 hPa/3 h.
- Alle Gradientbänder über Nordafrika, Iberien und dem östlichen
  Mittelmeer bewertet die Aktivität mit 0–0,2, also `none`. Ihr
  T850-Kontrast liegt bei −0,7 bis 2,7 K, sie sind reine Feuchtegrenzen.
  Das 4-K-Kriterium trennt hier allein schon fast vollständig.
- Warmfronten haben oft einen kleinen Tendenzsprung, das passt zum
  Kompendium (hinter der Warmfront schwacher Fall).

**Okklusionen, Grundfassung** (Fall 2026-10-09):

- Islandtief: Von 00 bis 12 UTC wird jeweils eine Okklusion vom
  Okklusionspunkt bei Nordschottland Richtung Island gefunden. Der Punkt
  wandert mit der Zeit nach Osten (59/−4,6 → 59/−1 → 57,5/2,2). Das passt
  zu KNMI (00 UTC Nordschottland, 06 UTC schottische Ostküste).
- Ostsee-Tief: Um 06 und 09 UTC wird eine kurze Okklusion bis vor den
  Kern gefunden. Um 00 UTC wechseln Warm- und Kaltfront im Tiefkern auf
  einer Linie den Typ (Bild einer offenen Welle), deshalb gibt es dort
  keine Okklusion.
- Ein **Zungentest** (θw steigt auf der warmen Seite an und fällt danach
  wieder ab) wurde verworfen. Er schlägt auch an Kaltfronten an, weil auch
  Warmsektoren begrenzt sind.
- Verlängerung entlang der Warmluftzunge: Endet der Okklusionsast vor dem
  Kern, geht es weiter entlang der nächsten θw-Rückenachse in 700 hPa. Die
  Achsen kommen aus der Hesse-Matrix: λ₁ < −0,3 K/(100 km)², Gradient
  entlang des Eigenvektors gleich null. Die Verlängerung läuft in
  Fortsetzungsrichtung bis 150 km vor das Tief, höchstens 1200 km weit und
  ohne scharfe Knicke. Am Islandtief reicht die Okklusion so bis an die
  Nordostküste Islands (06 UTC 1086 km statt 527 km).
- Die zuführende Kalt- bzw. Warmfront wird bis an den Okklusionspunkt
  verlängert, dort treffen sich alle drei Fronten. Liegt ihr Ende weit
  entfernt (bis 350 km), entsteht ein sichtbarer Knick im
  Verbindungsstück. Das ist kosmetisch und noch offen.
- Noch offen:
  - Okklusionen ohne passende TFP-Linie, etwa um den Kern des
    Ostsee-Tiefs um 00 UTC.
  - Den Charakter (Kalt-/Warmfront) aus der Verlagerung bestimmen statt
    vom Ast zu übernehmen.
  - Die Schichtdicke 500/1000 hPa als eigentliches Kriterium.
