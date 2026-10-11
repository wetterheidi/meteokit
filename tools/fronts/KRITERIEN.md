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
| Kontrast ≥ 4 K | T850 an der Linie minus 300 km kälterseitig, Rampe 2–4 K, als **Faktor**; an freien Linienenden unter 3,5 K Schnitt | ✓ `activity.js`, `detect.js` |
| Rinne, zyklonale Krümmung | ∂²p/∂n² des Bodendrucks, Maximum im Fenster zur warmen Seite = Bodenposition | ✓ |
| Konvergenz, Windsprung | Konvergenz und Vorticity des ~10-m-Winds ±100 km um die Bodenposition | ✓ |
| Sprung der Tendenz | Δp(3 h) 150 km hinter minus 150 km vor der Bodenposition | ✓ (braucht Vortermin) |
| Wetter | max. Niederschlag oder tiefe Wolken × w700 zwischen 850-Linie und Bodenposition | ✓ |
| keine Front unter Absinkinversion | indirekt: kein Wetter, keine Rinne → Aktivität ≈ 0 | ✓ indirekt |
| Typ | Verlagerung zwischen Terminen, sonst geostrophischer Querwind | 850-hPa-Querwind ✓, Rest geplant |
| Bodenposition | Kalt- und quasistationäre Fronten zur stärksten Bodendruckrinne auf der warmen Seite verschieben (bei schwacher Rinne zum typischen Versatz hin gemischt, entlang der Linie geglättet), **vor** der Okklusionsanalyse; Warmfronten bleiben | ✓ `detectFronts` (`position: "surface"`) |
| Okklusion | Okklusionspunkt (Ende einer Kalt-/Warmfront an einer Front des anderen Typs, ≤ 350 km), Okklusion entlang der **Rückenachse der Schichtdicke 500/1000** (Scheitel des Warmluftkeils) vom Okklusionspunkt bis vor den Tiefkern, sonst entlang θw 700 bzw. des Frontasts; alle drei Fronten treffen sich im Okklusionspunkt | ✓ `occlusion.js` |
| Darstellung schwacher Fronten | `activity_class` active / weak (gestrichelt) / none (entfällt) | ✓ |

**Schichtdicke 500/1000 hPa aus Modellleveln** (umgesetzt in
`fetchPlaneField` mit `thickness: true`). Die Schichtdicke ist das
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
  geführt, dort treffen sich alle drei Fronten. Dazu biegt das Linienende
  weich ein: Die Punkte im letzten Abschnitt (doppelte Lückenlänge,
  mindestens 150 km) werden mit einem Smoothstep-Gewicht verschoben. Es
  wird also kein gerades, abknickendes Verbindungsstück angehängt.
- Noch offen:
  - Okklusionen ohne passende TFP-Linie, etwa um den Kern des
    Ostsee-Tiefs um 00 UTC.
  - Den Charakter (Kalt-/Warmfront) aus der Verlagerung bestimmen statt
    vom Ast zu übernehmen.
  - Die Schichtdicke 500/1000 hPa als eigentliches Kriterium.

**Okklusion entlang der Schichtdicke** (Stand 2026-10-09, Fall bis 15 UTC):

- Gegenprobe der Schichtdicke: ±6 gpm gegen die öffentlichen
  ICON-EU-Felder, über den Alpen −43 gpm (Extrapolation bis 1000 hPa).
- Rückenachsen: Hesse-Matrix der geglätteten Schichtdicke (σ 150 km),
  λ₁ < −6 gpm/(100 km)². Achsenstücke, deren Enden höchstens 80 km
  auseinanderliegen und ohne Knick ineinander übergehen, werden
  zusammengefügt. Ohne das zerfiel die Okklusionsachse um 12 UTC an einem
  Vorzeichenwechsel der Eigenvektoren in zwei Teile.
- Die Okklusion läuft vom Okklusionspunkt entlang der Achse, beginnend beim
  ersten Achsenpunkt in Laufrichtung, bis 150 km vor das Tief. Das Tief
  darf bis 1600 km entfernt sein; 1200 km waren für das Islandtief um
  12 UTC zu wenig.
- Die Geometrie wird auf der **ganzen Linie** bestimmt, also auch auf
  Stücken ohne Wetter. Der Okklusionsast ist in 850 hPa oft schwach (12 UTC
  als `none` eingestuft) und wurde vorher weggefiltert, bevor der
  Okklusionspunkt gesucht war.
- Ergebnis 12 UTC: Die Okklusion läuft von der nördlichen Nordsee über die
  Färöer nach Nordwesten, wie bei KNMI. Der Okklusionspunkt liegt aber bei
  57,3/5 statt bei etwa 54/5 (KNMI, DWD). Er wird aus der 850-hPa-Kaltfront
  bestimmt, und die liegt 50–250 km hinter der Bodenkaltfront. Die
  Schichtdickenachse reicht bis 54/6, folgt also dem Analytiker →
  Verschiebung auf die Bodenposition (offen).
- Knick am Okklusionspunkt: Die Okklusion setzt die Kaltfront fort, die
  Warmfront setzt mit Knick an (s. unten).

**Bodenposition** (Fall 2026-10-09):

- Verfahren: Je Stützpunkt wird die Lage der stärksten Bodendruckrinne im
  Fenster auf der warmen Seite bestimmt (Kaltfront 0–250 km,
  quasistationär −100–300 km). Bei schwacher Rinne (Krümmung unter
  0,1–0,5 hPa/(100 km)²) wird zum typischen Versatz hin gemischt
  (Kaltfront 120 km, quasistationär 50 km). Der Versatz wird entlang der
  ganzen Linie geglättet (400 km, stetig über Typwechsel). Dann wird jeder
  Punkt senkrecht zur Zone verschoben, und zwar **vor** der
  Okklusionsanalyse, damit der Okklusionspunkt aus den Bodenfronten
  entsteht.
- **Warmfronten werden nicht verschoben.** Der Versatz aus dem Leitfaden
  (250–450 km) erzeugte am Testfall Haken und eine Warmfront parallel zur
  Okklusion (Ostsee-Tief). Die warme Kante der 850-hPa-Zone lag dort schon
  an der Bodenwarmfront der Analysen. An weiteren Fällen prüfen.
- Ergebnis Island-System: Okklusionspunkt 00 UTC 58,8/−4,5, 06 UTC 57,6/0,
  12 UTC 55,5/6,8 (KNMI/DWD 12 UTC etwa 54/5, vorher 57,3/5). Die Kaltfront
  liegt um 12 UTC noch etwa 100 km nördlich der KNMI-Linie, vorher waren
  es rund 250 km.
- Nebenwirkung, behoben: Die verschobenen Linien kamen sich an neuen
  Stellen nahe, dadurch entstanden Scheinokklusionen. Dagegen helfen zwei
  Regeln. Erstens muss eine Okklusion zu einem Tief hin zeigen
  (Winkelkosinus ≥ 0,3); maßgeblich ist das Tief, auf das sie zuläuft,
  nicht das nächste. Zweitens gibt es pro Tief höchstens eine Okklusion
  (engster Anschluss gewinnt). Liegt das Tief jenseits des Gebietsrands
  (Islandtief 00 UTC), genügt ein **Randtief**: ein Druckminimum am Rand
  im Sektor ±60° um die Okklusionsrichtung, mindestens 8 hPa unter dem
  Okklusionspunkt.

## 10 Zeichenregeln aus der Referenzanalyse (2026-10-09 12 UTC)

Die Projektleitung hat die Fronten für 12 UTC selbst analysiert. Daraus
und aus ihren Anmerkungen stammen diese Regeln:

- **„Fronten spannen sich wie Segel im Wind auf.“** Kehrtwenden und
  Zickzack gibt es nicht.
  - Rohlinien werden an Richtungsänderungen über 100° geteilt (Sehnen
    ±60 km um jeden Stützpunkt). Am Testfall entfernt das Haarnadeln von
    172° und 117°.
  - Die Okklusion wird geglättet (laufendes Mittel 150 km, zwei Durchgänge).
  - Zur Kontrolle dient die stärkste Richtungsänderung je 75 km. Übrig sind
    41–61°, nur noch am Okklusionspunkt und am Spiralende.
- **Okklusionspunkt am stärksten Druckfall** (vgl. K1: Zentrum des
  isallobarischen Tiefs) **und an der Warmluftschale.** Er wird zum Minimum
  der 3-h-Tendenz verschoben. Dabei gelten drei Bedingungen:
  - Kandidaten liegen höchstens 100 km von der Keilachse, der die
    Okklusion folgt.
  - Sie liegen nicht mehr als 30 km hinter dem Okklusionsbeginn.
  - Es gibt einen Abstandsmalus von 0,15 hPa/3 h je 100 km.

  Ohne die Achsenbindung sprang der Punkt am Ostsee-Tief in den
  Druckfall vor der Warmfront bzw. auf die Achse des Warmsektors. Liegt
  der neue Punkt nahe an einer Front, wird diese gekürzt, statt
  zurückgebogen zu werden (sonst entsteht ein Haken).
- **Okklusion setzt die Kaltfront ohne Knick fort, die Warmfront knickt
  ab.** Der Okklusionsast stammt aus derselben TFP-Linie wie die Warmfront
  und setzte deshalb diese fort, der Knick zur Kaltfront lag bei
  44–104°. Jetzt verlässt die Okklusion den Punkt in Richtung der
  Kaltfront-Tangente und geht über 300 km weich in den Keilverlauf über.
  Kaltfront und Okklusion werden um den Punkt gemeinsam geglättet
  (±500 km), die Warmfront biegt danach in den neuen Punkt ein.
- **Okklusion spiralig bis an den Kern, Druck zum Kern hin fallend.** Ab
  dem Ende der Keilachse geht es in 50-km-Schritten weiter. Jeder Schritt
  nimmt die kleinste Linksdrehung (gegen den Uhrzeigersinn, höchstens 60°),
  bei der der Bodendruck fällt und der Abstand zum Kern um mindestens 8 km
  abnimmt. Insgesamt sind höchstens 200° Drehung erlaubt, Schluss ist
  80 km vor dem Kern. Läuft die Keilachse am Kern vorbei, endet der Lauf
  dort, wo sie sich wieder entfernt, und die Spirale übernimmt.

Ergebnis 12 UTC im Vergleich zur Referenzanalyse:

| | Okklusionspunkt | Bemerkung |
|---|---|---|
| Island-System | 57,6/5,1 (Referenz ≈ 57/2–5) | Okklusion über die Färöer und um den Kern ✓ |
| Ostsee-Tief | 62,4/26,2 (Referenz ≈ 62,5/25) | Okklusion um die Nordseite in den Kern ✓ |

### Zweite Rückmeldung zur Referenzanalyse (12 UTC)

- **Glättung 90 km** statt 120 km trifft den Fall am besten. Das ist jetzt
  der Standard (`sigmaKm`). Fronten und Aktivitätsklassen bleiben dabei
  stabil, alle Fehltreffer im Süden bleiben `none`.
- **Charakter der Okklusion:** Er ist in der Praxis kaum bestimmbar.
  Synoptiker zeichnen einheitlich so, dass die Kaltfront kontinuierlich in
  die Okklusion übergeht und die Warmfront abknickt. Das ist die einzige
  Zeichenweise, eine Bestimmung des Charakters entfällt.
- **Kaltfront durchzeichnen, wo noch Niederschlag fällt:** Lücken zwischen
  Fronten gleichen Typs werden geschlossen (`postprocess.js`, `closeGaps`),
  wenn drei Bedingungen gelten: höchstens 600 km Lücke, die Enden zeigen
  aufeinander zu (cos ≥ 0,6), entlang der Lücke fallen mindestens 0,1 mm/h.
  Das Verbindungsstück ist ein kubischer Bogen entlang beider
  Endtangenten. Am Testfall schließt das die 450-km-Lücke südlich von
  Großbritannien; die Kaltfront läuft durchgehend 2500 km vom Atlantik bis
  zum Okklusionspunkt.
- **Segelform:** Rohlinien werden schon an scharfen Ecken geteilt (über 70°
  auf ±100 km), nicht erst an Kehrtwenden. Zum Schluss werden alle Fronten
  geglättet (laufendes Mittel 150 km, zwei Durchgänge, Endpunkte fest).
- **Ostsee-Warmfront knickt am Okklusionspunkt zu heftig:** Es gab drei
  Ursachen, alle behoben.
  1. Die Verschiebung des Punkts zum stärksten Druckfall zog ihn um 250 km
     nach Südosten. Sie ist jetzt **standardmäßig aus** (`opRefine`), denn
     mit 90 km Glättung liegt der geometrisch bestimmte Punkt ohnehin am
     stärksten Druckfall (Island 57/5,4, Tendenzminimum 57,5/5).
  2. Eine freie gemeinsame Glättung von Kaltfront und Okklusion verschob den
     Punkt in die Innenseite des Winkels. Jetzt bleibt er dabei fest
     (`smoothAroundFixed`).
  3. Die Warmfront wurde als Ganzes zum Punkt gebogen. Jetzt wird sie am
     nächstgelegenen Punkt gekürzt und mit einem kurzen Bogen angeschlossen
     (`attach`).

  Ergebnis: Der Ostsee-Okklusionspunkt liegt um 12 UTC bei 62,5/25,1
  (Referenz ≈ 62,5/25).
- **Ostsee-Warmfront biegt im Osten nach Süden ab:** Die Biegung ist ein
  allmählicher 90°-Bogen über rund 350 km. Der Südast hat Niederschlag
  (≈ 1 mm/h) und eine Rinne, nur der T850-Kontrast nimmt ab und lässt sich
  am Gebietsrand nicht mehr bestimmen. Entscheidung der Projektleitung:
  über den Kontrast abschneiden. Umsetzung (`detect.js`, `byActivity`):
  Fällt der entlang der Linie geglättete T850-Kontrast zu einem **freien**
  Linienende hin unter 3,5 K (`contrastMin`) oder ist er nicht bestimmbar,
  endet die Front dort, auch mit Wetter. Frei heißt: keine andere Rohlinie
  näher als 350 km (`contrastFreeKm`). Am Okklusionspunkt ist der Kontrast
  in 850 hPa oft klein, global angewendet zerfielen beide Okklusionen.
  Ergebnis 12 UTC: Die Warmfront endet bei 62/39 statt 59/40. Bewusst
  unter den 4 K des Leitfadens: Mit 4 K fiele die Kaltfront Sardinien–
  Algerien (08.10. 18/21 UTC, KNMI zeichnet sie) weg, die mit 3,8 K
  Kontrast, 0,6 mm/h und Aktivität 0,69 klar Wetter hat.
- **Symbole auf der falschen Seite** (Island-Kaltfront): Beim Schließen
  einer Lücke wurde die Seitenangabe falsch gespiegelt, wenn das längere
  Stück das zweite war. Behoben; eine Prüfung gegen θw bestätigt die warme
  Seite aller Fronten an allen Terminen.
- **Ligurientief:** Referenz ist die KNMI-Analyse.

### Handanalyse 09.10. 12 UTC (Referenzdatei)

Die Handanalyse liegt in `tools/fronts/reference/2026-10-09T12.geojson`.
Vergleich mit `compare.mjs`: alle Fronten getroffen (±150 km), mittlerer
Abstand 21 km. Abweichungen je Front, mittel/max in km, vor → nach den
Korrekturen unten:

| Front | vorher | nachher |
|---|---|---|
| Island Warmfront | 19/66 | 19/66 |
| Island Kaltfront | 17/80 | 15/77 |
| Island Okklusion | 24/110 | 18/85 |
| Ostsee Kaltfront | 43/100 | 42/73 |
| Ostsee Warmfront | 37/91 | 37/91 |
| Ostsee Okklusion | 70/117 | 49/93 |

Befunde:

- **Fronten in der Rinne:** Alle drei Fronten des Ostseetiefs liegen in der
  Handanalyse genau im Isobarenknick (Rinne bei 0 bis −50 km). Das
  Niederschlagsmaximum liegt bei der Kaltfront 50–100 km dahinter, bei der
  Warmfront 50–150 km davor, bei der Okklusion auf der Linie. Die
  automatische Ostsee-Kaltfront liegt 30–90 km zu weit vorn. Ein einfaches
  Einrasten in die Rinne (±100–150 km) hilft der Ostsee-Warmfront
  (37 → 18 km), verschlechtert aber Island: Dort liegt die Rinne 150–250 km
  im Warmsektor, die Handanalyse folgt dem Niederschlag. Nicht übernommen;
  Rinne und Niederschlag gemeinsam abzuwägen, ist offen.
- **Knick am Okklusionspunkt:** In der Handanalyse knickt die Kaltfront in
  die Okklusion um 15–23° (auf 100 km), die Warmfront um 40–60°. Die
  Automatik hatte es umgekehrt (Kaltfront 39° bzw. 87°, Warmfront 12° bzw.
  31°). Ursache 1: Die Okklusion hatte doppelte Punkte und Lücken bis
  180 km, der tangentiale Start griff kaum. Jetzt wird sie vorher
  gleichmäßig verdichtet. Ursache 2: Die Glättungen mittelten nach
  Punktzahl und zogen ungleich verteilte Punkte zu Klumpen mit Sprüngen
  zusammen; jetzt wird entlang der Bogenlänge gemittelt (`smoothAlong`).
  Ein Knick von etwa 70° an der Ostsee bleibt: Der automatische Punkt
  liegt rund 100 km nordwestlich des handanalysierten (61,6/25,7) auf der
  einbiegenden Kaltfront, die Okklusion läuft von dort direkt nach
  Südwesten zum Kern. Vom Punkt der Handanalyse aus setzt die Okklusion die
  Kaltfront fast gerade fort. **Umgesetzt** (`slideAlongCold`): Der Punkt
  wird entlang der Kaltfront bis 150 km zurückgelegt (`opSlideKm`), dorthin,
  wo der Knick zwischen Kaltfront und Richtung zum Okklusionsverlauf
  (200 km voraus) am kleinsten ist, mit 10° Strafe je 100 km
  (`opSlidePen`). Die Okklusion läuft von dort direkt in ihren Verlauf, die
  Warmfront wird angeschlossen. Damit der Anschluss keinen Haken bildet,
  wählt `attach` den Warmfrontpunkt, von dem aus die Front schon auf den
  Punkt zeigt (statt einfach den nächsten). `occlusion_slide_km` nennt die
  Strecke. Ergebnis 12 UTC (mittel/max km): Island Warmfront 14/33,
  Kaltfront 12/37, Okklusion 13/45; Ostsee unverändert (Kaltfront 42,
  Warmfront 42, Okklusion 53), gesamt 26 km. An der Ostsee rutscht der
  Punkt bis an die Grenze von 150 km, weil die automatische Kaltfront dort
  60 km zu weit vorn liegt; Kaltfront und Okklusion gehen jetzt ohne Knick
  ineinander über.

### Einzelparameterfronten (Vorgehen der Projektleitung, Prototyp)

Vorgehen bei unklarer Lage: je eine Front nach Niederschlag, Drucktendenz,
Windsprung/Isobarenknick, Temperatursprung, θe 850 hPa usw. zeichnen und
optisch über alle mitteln. Prototyp: Für jeden Frontpunkt wird quer zur
Front (±200 km) die Lage jedes Parameters bestimmt: Maximum Niederschlag,
stärkster Tendenzsprung in Zugrichtung, stärkste Krümmung des Bodendrucks,
Maximum der Konvergenz (10 m), stärkster Anstieg von T2m bzw. θe 850 hPa.

Lage der Parameter relativ zur Handanalyse 09.10. 12 UTC (Median ±
mittlere Abweichung, km, positiv = warme Seite):

| Parameter | Kaltfront | Warmfront | Okklusion |
|---|---|---|---|
| Isobarenknick | −20 ± 51 | +10 ± 40 | −40 ± 41 |
| Konvergenz | −30 ± 66 | +40 ± 40 | −30 ± 56 |
| Niederschlag | −50 ± 68 | −80 ± 60 | +40 ± 51 |
| Tendenzsprung | −90 ± 28 | +120 ± 43 | +40 ± 114 |
| T2m-Anstieg | −120 ± 61 | −50 ± 54 | +110 ± 125 |
| θe-Gradient 850 hPa | −140 ± 40 | −130 ± 18 | −150 ± 32 |

Isobarenknick und Konvergenz liegen am nächsten an der Handanalyse. Der
θe-Gradient in 850 hPa liegt stets 130–150 km auf der kalten Seite, aber
mit kleiner Streuung (Frontneigung). Ein ungewichtetes Mittel aller
Parameter verschlechtert das Ergebnis (56 statt 26 km). Gewichtet und um
den typischen Versatz korrigiert: am selben Fall kalibriert 27 km, über
Kreuz (Island ↔ Ostsee) schlechter als ohne (Ostsee 46 statt 44, Island 26
statt 13). Nur die Ostsee-Okklusion gewinnt in allen Varianten (53 →
33–37 km). Fazit: Für übertragbare Versätze und Gewichte braucht es
weitere Handanalysen lehrbuchhafter Tiefs; bis dahin nicht übernommen.

### Jede Front hängt an einem Tiefkern (Vorgabe 10.10.)

Jede Front muss mit einem analysierten Tiefkern verbunden sein, direkt oder
über die Okklusion eines teilokkludierten Tiefs. Umsetzung
`requireLowLink` (postprocess.js), s. README. Wirkung an den Fällen:

- 09.10. 12 UTC: keine Änderung.
- Entfallen: Atlantik-Kaltfrontstücke am Westrand (09.10. 03–09 UTC), die
  Kaltfront Sardinien–Algerien (08.10. 15–21 UTC, ~350 km vom Genuatief,
  ihre Verbindung fehlt), die Fronten am Schwarzen Meer (10.10.).
- Entfallen, obwohl die Referenzkarten sie zeigen, weil die Verbindung in
  der Analyse fehlt: die Welle über Großbritannien (06.10.; Haupttief
  967 hPa bei 69/36 am Nordrand, dort sucht `findLows` nicht; die Welle bei
  Wales ist im Modell offen, kein Minimum auch bei 0,5 hPa Tiefe), die
  Kaltfront über Frankreich (10.10.; Anschluss über Dänemark fehlt), die
  Island-Warm- und Kaltfront 09.10. 15 UTC (dort fehlt die Okklusion).

### Genuatief 09.10. 12 UTC (Handanalyse)

Handanalyse: Kaltfront Algerien – südlich Sardinien – Tyrrhenisches Meer –
Rom – La Spezia (Okklusionspunkt 44,4/10,4), Warmfront Poebene – nördliche
Adria – Bosnien, Okklusion von Genua westlich und südlich um den Kern
(42,5/8). Erfahrung der Projektleitung: bei Genuatiefs sind die
Luftmassenkontraste wesentlich geringer als bei Polarfronttiefs.

Signale quer zu den handanalysierten Linien (±150 km):

- Kaltfront: T850-Kontrast 5–6 K über Algerien/Tunesien, 2–3 K an
  Italien, 1 K am Okklusionspunkt. Niederschlagsmaximum 10–20 km neben der
  Linie (0,7–1,1 mm/h). Zwischen Rom und La Spezia keine eigene
  Niederschlagsachse (Niederschlag 200 km östlich am Apennin).
- Warmfront: 850 hPa im Gelände maskiert, 700 hPa ~1 K; Niederschlag auf
  der Linie. Advektion 850 hPa +1,5 bis +2,3 K/10 h über der Adria.
- Okklusion: kein Temperaturkontrast, kräftige Rinne 20–40 km neben der
  Linie.

TFP findet dort nichts, auch nicht in 700 hPa (mit gelockerten Masken nur
59 % der Kaltfront und 49 % der Warmfront in 150 km). Niederschlagsachsen
treffen Kaltfront 96 %/28 km, Warmfront 92 %/42 km, Okklusion 59 %/41 km
(Anteil in 100 km/mittlerer Abstand).

Erster Ansatz `precipfronts.js` (s. README), Stand: an 09.10. 12 UTC
Treffer 75 → 82 %, nur Lage 75 → 89 %, Fehlalarm 1 → 12 %. Probleme:

- Die Achse Algerien–Tunesien folgt der Kaltfront bis vor Neapel und biegt
  dort um 50° nach Osten zum Ionischen Meer ab; sie liegt 450 km vom Kern
  und bleibt ohne Anschluss. Eine Eckenschwelle von 45° teilt sie, macht
  das Band aber zur Okklusion (Fehlalarm 24 %).
- Das Band über Mittelitalien (42–43° N) wird zur Warmfront, die Warmfront
  der Handanalyse liegt in der Poebene (45° N).
- An anderen Terminen entstehen plausible (10.10. 09 UTC Ostseewelle) und
  fragliche Fronten (06.10. Biskaya-Tief, 09.10. 15 UTC Islandtief ohne
  Okklusion). Deshalb vorerst abgeschaltet (`precipFronts: false`), in der
  Debug-Seite zum Ansehen eingeschaltet.

Rückmeldung der Projektleitung zum Ergebnis der Niederschlagsachsen:
synoptisch seltsam, die Kaltfront fehlt, die Warmfront ist doppelt.
Hinweis: bei schwachen Fronten hilft eine Isobarenanalyse von 1 zu 1 hPa
(Debug-Seite: Isobaren 5/2/1 hPa).

Test Isobarenknick (Anteil der Handanalyse in 100 km / mittlerer Abstand):

- Rinnenachsen (Hesse-Matrix von −p, 40 km): Genua-Okklusion 92 %/50,
  Kaltfront 48 %/51, Warmfront 37 %/71; am Genuatief stark vom Gelände
  geprägt (Lee-Rinnen an Korsika und Apennin).
- Krümmung der Isobaren κ = ∇·(∇p/|∇p|) (Druck 40 km geglättet, Achsen
  maximaler zyklonaler Krümmung): Island/Ostsee 87–100 % in 28–50 km,
  Genua-Okklusion 90 %/38, Kaltfront 66 %/64, Warmfront 51 %/53. Das
  bestätigt den Isobarenknick als Frontmerkmal, aber mit viel Rauschen
  (80 000 km Achsen im Gebiet), vor allem orographisch.

Rückmeldung: Die Knicklinien passen so gut wie gar nicht, am ehesten die
hinter der handanalysierten Kaltfront; die übrigen am Genuatief sind
Artefakte. Zwischen Rom und La Spezia folgt die Front keinem Knick. Der
Fall ist wichtig: Fronten mit schwachem Kontrast sind nördlich der Alpen,
besonders im Sommer, häufig.

Sprünge quer zu den Genua-Linien (Lage des stärksten Sprungs über ±60 km,
km, + = warme Seite):

- Kaltfront: θe 850 hPa auf ganzer Länge −40 bis −140 km (4,5–7,6 K),
  auch zwischen Rom und La Spezia; Niederschlag auf der Linie bis Rom.
  Die Grenze ist eine Feuchtegrenze (θe), T850 nur 2–3 K.
- Warmfront: θe 850 hPa −40 bis −90 km; über der Adria Taupunkt-, θe- und
  T-Sprung in 2 m auf der Linie (in der Poebene orographisch).
- Okklusion: Windscherung 10 m (bis 12 m/s auf 120 km) 40–60 km neben der
  Linie.

Warum die TFP dort nichts liefert (θw; θe gleich): Die Zone ist im Süden
da (K1/K2 erfüllt, θe-Gradient 3,4–4,4 K/100 km), aber die Maske schaltet
an der Schwelle ständig ein und aus, die Stücke bleiben unter 400 km.
Zwischen Rom und La Spezia ist das Feld NaN: der Apennin ist maskiert, und
Glättung und Gradient weiten die Lücke auf 150–200 km. Versuchsoptionen
(standardmäßig aus): `thermo: "thE"` (TFP auf θe) und `maskRunKm` (Masken
mit Hysterese über die Linie gemittelt). Mit `maskRunKm: 300` entsteht die
Kaltfront Tunesien–Süditalien (Kontrast 4,2 K, 0,74 mm/h, auf 850 hPa im
Mittel 93 km vor der Handanalyse), wird aber als quasistationär typisiert
(Querwind schwach) und fällt über die Anschlussregel weg: ihr Nordende
liegt 450 km vom Kern, die Verbindung über Rom fehlt (Apennin-Lücke).

**Geländelücken und schwache Fronten (Erprobung).** Neue Optionen in
`detectFronts`, standardmäßig aus, in der Debug-Seite als Bündel
„Schwache Fronten“:

- `fillTerrain`: θw unter Grund und bodennah harmonisch auffüllen
  (Laplace, wie eine über das Gebirge gespannte Membran) statt NaN. Damit
  laufen Linien über Apennin und Alpen weiter.
- `maskGapKm: 150`: kurze Lücken der Masken K1/K2 entlang der Nulllinie
  überbrücken (schonender als `maskRunKm`, das am 08.10. 15 UTC das
  Islandsystem kostete).
- `windMin: 0.5`: Querwind für Kalt-/Warmfront ab 0,5 m/s (die Advektion
  von θ quer zur Front ist Querwind mal Gradient, also derselbe Test).
- `activity.contrastRamp: [1.5, 3.5]`: Kontrastfaktor ab 1,5 K (Genua:
  2–3 K). Ein θe-Kontrast (`activity.contrastE`) taugt nicht: Fehlalarm
  44 %, Feuchtegrenzen überall.

Ergebnis 09.10. 12 UTC mit dem Bündel: Treffer 75 → 85 %, nur Lage 91 %,
Fehlalarm 1 → 20 %, Abstand 31 km. Am Genuatief: Okklusion um den Kern
(100 % in 100 km, 57 km), Warmfront Poebene – Adria (80 %, 52 km), Anschluss
an die bis Kroatien verlängerte Ostsee-Kaltfront (wie KNMI; in der
Handanalyse endet sie bei 46,6/27,7 und zählt deshalb als Fehlalarm).
Die Kaltfront fehlt noch: das Südband Algerien–Tunesien–Sizilien liegt
100–150 km südlich der Handanalyse, das Stück Neapel – Rom – Okklusionspunkt
bleibt kurz und ohne Verbindung.

Nebenwirkungen: 10.10. 03/06 UTC erscheinen die Kaltfront über Frankreich
und die Ostseewelle mit Okklusion (passt eher zu den Referenzkarten);
08.10. 12/15 UTC fällt das Islandsystem weg (sein Tief liegt am Westrand,
die Okklusion zum Randtief bildet sich nicht mehr, Anschlussregel), und
`fillTerrain` erzeugt eine Kaltfront Schweden – Alpen – Algerien (die
schleifende Front an den Alpen, aber zu lang).

**Rückmeldung zum Bündel (09.10. 12 UTC):** Genua-Okklusion und
-Warmfront vertretbar. Die Ostsee-Kaltfront **nicht** bis Kroatien
verlängern: keine Wettererscheinungen entlang dieses Stücks, und eine
Kaltfront, die in die Warmfront des nächsten Tiefs übergeht, zeichnet die
Projektleitung nur bei einer Zyklonenfamilie. Das Genuatief hat einen
eigenen Entstehungsgrund. Die Genua-Kaltfront orientiert sich am
Niederschlag, der mit dem Vorderrand der θe-Drängung zusammenfällt.

Umsetzung (Optionen, standardmäßig aus, im Bündel enthalten):

- `activity.weatherMin: 0.2`: Front nur, wo das geglättete Wettermaß
  (Niederschlag oder tiefe Wolken mit Hebung) mindestens 0,2 erreicht.
  Streicht die Verlängerung nach Kroatien. Als allgemeine Vorgabe
  (Schwelle 0,3) kostet es Treffer (75 → 71 %): Es kappt auch trockene
  Abschnitte, die die Handanalyse zeichnet (Atlantikausläufer der
  Islandkaltfront).
- `activity.sfcPrecipWeight: 1` und `surfaceDefaultKm: {cold: 0}`:
  Bodenposition dort, wo Rinne und Niederschlag zusammen am stärksten sind,
  ohne Pauschalversatz. Ohne Bündel gemischt: Ostsee-Kaltfront 40 → 27 km,
  Islandkaltfront 12 → 26 km, schleifende Front 08.10. 41 → 55 km.

Ergebnis mit dem ganzen Bündel: 09.10. 12 UTC Treffer 94 %, nur Lage
100 %, Fehlalarm 6 %, 32 km (Genua-Kaltfront 65 % in 100 km, 60 km;
Warmfront 78 %, 51 km; Okklusion 100 %, 57 km). 08.10. 18 UTC (Teilanalyse,
nur die schleifende Front geprüft): 70 % / 76 % / 32 % / 47 km gegenüber
68 % / 68 % / 19 % / 41 km ohne Bündel. Die Automatik führt die Kaltfront
quer durch die Alpen zum Genuatief (ähnlich KNMI); die Handanalyse lässt
sie als quasistationäre Front am Alpennordrand nach Westen schleifen.

**Dritte Rückmeldung (09.10. 12 UTC und 08.10.):**

- Island und Ostsee passen gut, „damit kann man arbeiten“.
- Genua: das durchgezogene und das gestrichelte Kaltfrontstück
  zusammengesetzt wäre vertretbar. Umgesetzt im Lückenschluss: seitlich
  versetzte, parallel laufende Enden bis 200 km (`overlapKm`) werden
  gekürzt, bis die Lücke überwiegend in Laufrichtung liegt, dann
  verbunden. Ergebnis: eine durchgehende Kaltfront Algerien – Tunesien –
  Tyrrhenisches Meer – Okklusionspunkt bei Ancona, rund 100 km östlich
  parallel zur Handanalyse.
- Islandkaltfront: durchgezogen, weil entlang der Front immer wieder
  schwacher Niederschlag fällt und alle anderen Kriterien deutlich
  ansprechen. Umgesetzt: Wetterpflicht über 800 km gemittelt
  (`weatherSmoothKm`), als Vorgabe `weatherMin: 0.2`. Kostet an den
  Referenzen nichts mehr und streicht weiter die trockene Verlängerung der
  Ostsee-Kaltfront (endet bei 46,1/26,8, Handanalyse 46,6/27,7).
- Alpen: Kaltfronten aus Nord/Nordwest verlagern wegen der Orographie nie
  ungehindert nach Süden. Sie bleiben nördlich der Alpen hängen, es
  entsteht eine Stausituation mit Druckanstieg (deshalb greift dort kein
  Isobarenknick), und die Front wellt am Alpennordrand. Am 08.10. entstand
  durch den relativ niedrigeren Druck südlich der Alpen das Genuatief.
  Umgesetzt: `terrainCut` (im Bündel), keine Linienabschnitte über Gelände
  unter 850 hPa. 08.10. 18 UTC mit Bündel: Fehlalarm 32 → 20 %, die
  Kaltfront endet am Nordostrand der Alpen (47,9/15,0). Das schleifende
  Stück am Alpennordrand nach Westen (Handanalyse bis 47,3/7,2) entsteht
  nicht: die gefüllten Werte spannen den Übergang über das ganze Gebirge,
  die warme Kante liegt über oder südlich der Alpen. Dafür eine eigene
  Regel (`staufronts.js`, `stauFronts`, im Bündel): Endet eine Kaltfront
  höchstens 150 km vom Geländerand, läuft sie als quasistationäre Front am
  Rand entlang weiter, solange das Stau-Signal anhält (Druckanstieg
  ≥ 1,5 hPa/3 h und Niederschlag ≥ 0,3 mm/h, Aussetzer bis 100 km), und nur
  am Nordrand (der Lauf endet, wo der Rand nach Süden abbiegt). Entlang der
  handanalysierten Linie: Druckanstieg +3 bis +4,5 hPa/3 h, Niederschlag
  0,6–1,1 mm/h, Kaltluft im Vorland. Ergebnis 08.10. 18 UTC mit Bündel:
  Treffer 100 %, Fehlalarm 14 %, 46 km; das schleifende Stück reicht bis
  46,3/6,3 (Handanalyse 47,3/7,2). Entsteht nur am 08.10. (12, 15, 18 UTC),
  an keinem anderen Testtermin.

### Handanalyse 10.10. 06 UTC (Teilanalyse)

Analysiert: Skagerraktief (Okklusion stärker am Niederschlag orientiert,
Kaltfront dort durchgezeichnet, wo die Automatik gestrichelt war) und
Russlandtief (der Übergang von Warm- zu Kaltfront muss im Tiefkern
liegen; danach Isobarenknick bei 1 hPa, Niederschlag und Drucktendenz).
Referenz `reference/2026-10-10T06.geojson` (`partial`); eine schwache
Kaltfront, ein Rest der Automatik parallel zur durchgezeichneten, wurde
entfernt.

Ergebnis (Treffer / Fehlalarm / Abstand): Vorgabe 19 % / 5 % / 46 km,
Bündel „Schwache Fronten“ 100 % / 0 % / 33 km. Über alle drei
Referenztage mit Bündel: 96 % / 5 % / 34 km, nur Lage 100 %.

Umgesetzt:

- **Übergang im Tiefkern** (`junctionToCore`, Vorgabe): Treffen sich Warm-
  und Kaltfront höchstens 300 km vom Kern eines Tiefs ohne Okklusion, wird
  der Treffpunkt in den Kern gelegt, beide Fronten folgen weich (über
  max(400 km, 2 × Weg)). Russlandtief: Übergang vorher 110 km
  nordnordöstlich des Kerns; Kaltfront 72 → 45 km, Warmfront 79 → 41 km;
  10.10. gesamt 33 → 26 km, an den anderen Tagen keine Verschlechterung.
- **Okklusion am Niederschlag** (`post.occPrecip`, aus): je Punkt quer zur
  Linie zum Niederschlagsmaximum (bis `occPrecipKm`), geglättet, am
  Okklusionspunkt fest. Mittlerer Abstand der Okklusionen (Island /
  Ostsee / Genua / Skagerrak): ohne 13 / 53 / 57 / 77 km, 60 km Suchweite
  31 / 28 / 43 / 55 km, 150 km 43 / 49 / 51 / 52 km. Hilft allen außer
  Island; noch nicht eingeschaltet (Rückfrage).

### Vorgaben umgestellt (2026-10-10, Entscheidung der Projektleitung)

Das Bündel „Schwache Fronten“ und die Okklusion am Niederschlag sind
Vorgabe: `fillTerrain`, `terrainCut`, `stauFronts`, `maskGapKm: 100`,
`windMin: 0.5`, `activity.contrastRamp: [1.5, 3.5]`,
`activity.sfcPrecipWeight: 1`, `surfaceDefaultKm: {cold: 0, stationary: 0}`,
`post.occPrecip` mit `occPrecipKm: 60` (dazu schon vorher `weatherMin: 0.2`
und `junctionToCore`). `maskGapKm` von 150 auf 100: mit 150 entstand am
09.10. 06 UTC eine zweite, parallele Warmfront nördlich der Ostsee-
Warmfront (mit falscher Symbolseite); an den Referenzen ändert 100 nichts.
Ergebnis über die drei Referenztage: Treffer 96 %, nur Lage 99 %,
Fehlalarm 5 %, 32 km (vorher 61 % / 64 % / 4 % / 25 km). Die
Seitenprüfung gegen θw meldet an allen Terminen keine Abweichung mehr;
Knicke über 40° nur an den Spiralenden der Okklusionen am Kern. Bekannte
Nebenwirkung: Islandsystem 08.10. 12/15 UTC fällt weg (Randtief).

### Offene Punkte aus dem Fall 10.10. 06 UTC (zurückgestellt)

Vergleich mit DWD, KNMI und GeoSphere. Getroffen werden die Warmfront der
Ostseewelle und ein Teil der Kaltfront des Finnland-Tiefs.

- **Front Biskaya – Frankreich – Benelux – Dänemark fehlt:** In 850 hPa ist
  der θw-Gradient breit und diffus, auch ohne Masken entsteht keine Linie;
  T850-Kontrast nur 3–4 K. In 700 hPa ist sie deutlich, ebenso die
  Kaltfront über Tunesien. Idee: 700 hPa als zweite Analysefläche, wo
  850 hPa diffus oder maskiert ist (hilft womöglich auch bei der
  schleifenden Front an den Alpen, 08.10.).
- **Atlantikfront mit Wellen:** viel Wetter (1,6 mm/h, Konvergenz, Rinne),
  aber am Westrand des ICON-EU-Gebiets, der Kontrast ist dort nicht
  bestimmbar.
- **Keine Okklusionen** an Finnland-, Nordsee- und Ostseetief.
- **Symbolseite:** Am 10.10. 03 UTC weichen zwei kurze Fronten (Tunesien,
  Okklusionspunkt südliche Ostsee) nach der Verschiebung auf die
  Bodenposition von der θw-Prüfung ab, in der Lage auf 850 hPa nicht.
  Vermutlich ein Fehlalarm der Prüfung, noch zu bestätigen.


### ICON Global außen, Brücken (2026-10-11, Entscheidung der Projektleitung)

Anlass: Welle über Großbritannien am 06.10. 18 UTC (DWD-Analyse). Sie hängt
am Tief nördlich von Norwegen, das außerhalb des ICON-EU-Gebiets liegt.

**Modell.** ICON Global allein (25–78° N, 50° W–60° E) traf an den
Referenzen ebenso viel (94 % / 99 %), hatte im ICON-EU-Gebiet aber 18 statt
5 % Fehlalarme: die Ostsee-Kaltfront lief am 09.10. über den Balkan bis in
die Genua-Warmfront (ausgeschlossen, keine Zyklonenfamilie), die
Russland-Warmfront bog weit nach Süden. Vermutlich ist der Niederschlag von
ICON Global flächiger und erfüllt die Wetterpflicht leichter. Entscheidung:
die Felder vor der Analyse zusammensetzen (`mergeFields`), ICON-EU innen,
ICON Global außen, Übergang 2,5°. Innen bleibt die Abstimmung gültig.

Was das größere Gebiet zusätzlich auslöste und wie es behoben ist:

- **Scheinokklusionspunkt im Kern:** Am Russlandtief (10.10. 06 UTC)
  treffen sich Warm- und Kaltfront im Kern (Lücke 0 km). Das galt als
  Okklusionspunkt und griff das 1400 km entfernte Skagerraktief; weil der
  engste Anschluss gewinnt, verdrängte es dessen echte Okklusion. Neu:
  Treffpunkt höchstens 150 km von einem Kern = offenes Tief, kein
  Okklusionspunkt (`coreSkipKm`). 250 km verwarf schon den echten Punkt am
  Skagerraktief (rund 270 km vom Kern, 03 UTC).
- **Riesenokklusion:** Um 03 UTC lag der Treffpunkt am Russlandtief 230 km
  vom Kern, die Kaltfront wurde zu einer 3900 km langen Okklusion bis zum
  Schwarzen Meer. Neu: Okklusionen über 2500 km entfallen (`occMaxKm`;
  längste echte: Island 09.10. 12 UTC, 1780 km).
- **Doppellinie:** Nördlich der Islandokklusion (09.10. 12 UTC) lief eine
  schwache Warmfront im Median 20 km neben der Okklusion; im
  ICON-EU-Ausschnitt war sie am Nordrand abgeschnitten und unter der
  Mindestlänge. Neu: `dropDuplicates` (70 % der Punkte höchstens 100 km
  neben einer stärkeren Front).
- **Geländefüllung:** Die harmonische Füllung über Skandinavien hing am
  Nordrand des ICON-EU-Ausschnitts; mit ICON Global außen ändert sie sich
  (Ursache der geänderten Linienführung am Skagerrak, nicht falsch).

Ergebnis (zusammengesetzt, ausgewertet im ICON-EU-Gebiet): Treffer 94 %,
nur Lage 98 %, Fehlalarm 11 %, 32 km; ICON-EU allein unverändert 96 % /
99 % / 5 % / 32 km. Der Rest geht fast ganz auf das Russlandtief östlich
von 40° E zurück: am 09.10. läuft die Warmfront weiter nach Süden, am 10.10.
06 UTC wird es ein okkludiertes System mit dem Okklusionspunkt bei 50° E.
Beides liegt dort, wo die Handanalysen auf ICON-EU nicht zeichnen konnten.
Das Islandsystem 08.10. 12/15 UTC ist jetzt vollständig da (Tief 63° N
32° W).

**Brücken** (Vorgabe wie vorgeschlagen, Schwelle ggf. nachjustieren):
Stücke ohne Wetter mit im Mittel mindestens 4 K Kontrast dürfen eine
aktive Front mit einem Tief verbinden, auch mehrere hintereinander; sie
werden schwach mit `bridge: true`. An den Fällen entsteht damit keine
Brücke. Am 06.10. 18 UTC reicht es auch mit 1,5 K nicht: Die Kette von der
Kaltfront England–Atlantik (5 K) über Nordsee (4,6 K), Ostsee und Litauen
(1,6–2,0 K) reißt bei 57° N 33° E rund 400 km vor dem nächsten Stück ab,
keine Linie kommt dem Barentssee-Tief näher als 300 km. Die Kaltfront
entfällt deshalb weiter über die Anschlussregel.

### Handanalyse 06.10. 18 UTC (vollständig, Blindtest)

Erste vollständige Referenz über das zusammengesetzte Gebiet. Die
Projektleitung zeichnet nur das fast ganz okkludierte Barentssee-Tief
(Okklusion spiralig zum Kern, Okklusionspunkt bei 60° N 45° E, kurze
Warm- und Kaltfront nach Süden). Die Linie ohne Wetter südlich Irland –
England – deutsch-dänische Grenze – Nordpolen ist eine Luftmassengrenze,
keine Front (allenfalls gestrichelt ohne Symbole; der DWD zeichnet sie als
Front). Die Kaltfront England–Atlantik zeichnet sie nicht; dass die
Anschlussregel sie verwirft, ist also richtig.

Ergebnis: 0 % Treffer, 100 % Fehlalarm (nur 275 km: schwache Warmfront am
Biskayatief). Die TFP findet am Barentssee-Tief Linien nahe der
Handanalyse (0,4–0,7 mm/h), aber mit 1,6–1,7 K Kontrast; die
Kontrastrampe [1,5; 3,5] K macht sie zu "none". Mit [0,5; 3] K: Treffer
06.10. 68 %, aber Fehlalarm dort 46 % (u. a. Warmfront bei Island) und am
10.10. 19 statt 8 %. Die Tiefe des Barentssee-Tiefs (12,5 hPa gegen den
500-km-Ring) hebt sich kaum von den übrigen Tiefs ab (8–11 hPa).
Offen: Wie lassen sich Fronten eines Systems in Auflösung mit wenig
Kontrast, aber Wetter halten, ohne anderswo Fehlalarme zu erzeugen?

### Zentraltiefs (2026-10-11, Idee der Projektleitung)

Abgrenzung alternder Tiefs über die Neigung der Achse Boden → Höhe: Junge
Tiefs sind stromaufwärts (meist nach Westen) geneigt, Zentraltiefs stehen
senkrecht, sterbende Tiefs kurz stromabwärts geneigt. Umsetzung ohne neue
Daten: Z500 ≈ 8 m/hPa · (MSLP − 1000) + Schichtdicke 500/1000, Minimum im
Umkreis von 700 km um das Bodentief (am Rand des Suchkreises = kein
geschlossenes Höhentief).

| Tief | Achse | Tiefe | Deutung |
|---|---|---|---|
| Barentssee 06.10. 18 UTC | 68 km | 12,5 hPa | Zentraltief, in Auflösung (Handanalyse) |
| Nordmeer 05.10. 12 UTC | 67 km | 8,2 hPa | Zentraltief |
| Karasee 08.10. 18 / 09.10. 12 UTC | 33 / 58 km | 10,6 / 9,3 hPa | Zentraltief |
| Island 09.10. 12 UTC | 113 km nach NW | 7,5 hPa | fast senkrecht |
| Ostsee 09.10. 12 UTC | 176 km nach SSE | 10,5 hPa | stromab geneigt |
| Genua 09.10. 12 UTC | 69 km | < 6 hPa | jung, unter abgeschnürtem Höhentief |
| Nordsee 10.10. 06 UTC | 346 km nach W | 5,5 hPa | jung |
| Russland 10.10. 06 UTC, Island und Skandinavien 08.10. | kein Höhentief | | jung, offene Welle |

Regel: Zentraltief = Achse ≤ 150 km und Tiefe ≥ 8 hPa (ohne die Tiefe galt
das Genuatief als Zentraltief, der Fehlalarm am 09.10. stieg von 11 auf
14 %). Für Linienpunkte bis 1800 km davon: Kontrastrampe [0,5; 3] K,
Mindestkontrast an freien Enden 1 K. Ergebnis: 08.–10.10. unverändert,
06.10. 18 UTC Treffer 0 → 68 %, nur Lage 78 %, Fehlalarm 33 %, 95 km
(Biskaya-Warmfront 243 km, Nordteil der Okklusion 532 km östlich um den
Kern). Mit 1500 km nur 53 %, weil die Linien bis 1700 km vom Kern reichen.
Gesamt 90 % / 95 % / 13 % / 38 km. Am 05.10. entstehen damit am
Nordmeertief Fronten; dort steht die Handanalyse noch aus.

### 06.10. 18 UTC verfeinert: Spirale am Kern, Okklusionspunkt

Rückmeldung der Projektleitung: Lage der Okklusion gut, am Kern aber
weiter spiralig herumführen, um die Niederschläge nahe am Kern
einzufangen. Die Spirale lief bis zur Höchstlänge (1500 km) in rund 330 km
Abstand um den Kern, weil sie je 50-km-Schritt nur 8 km einwärts musste;
die Handanalyse zieht ab 500 km Abstand stetig bis in den Kern. Mit
`spiralInwardKm: 25`: 06.10. Treffer 68 → 84 %, nur Lage 78 → 93 %,
Fehlalarm 33 → 18 %; 09.10. Treffer 95 → 94 %, 32 → 35 km; übrige
unverändert. Gesamt 93 % / 97 % / 12 % / 41 km. Die Wahl der Richtung mit
dem meisten Niederschlag (`spiralPrecip`) ändert mit Drehungsabzug nichts,
ohne Abzug fallen die Treffer am 09.10. auf 88 % (bleibt aus).

Okklusionspunkt: automatisch geometrisch (Ende einer Front trifft die
andere, Ecke der Restlinie, dann bis 150 km entlang der Kaltfront zurück,
damit die Okklusion sie ohne Knick fortsetzt); `opRefine` (stärkster
Druckfall entlang der Rückenachse) greift hier nicht, weil die Okklusion
dem Frontast folgt. Die Handanalyse setzt den Punkt nach dem stärksten
Druckfall, 240 km nordnordöstlich (60,3° N 45,2° E). Entlang der Okklusion
ist der 3-h-Druckfall ein flaches Plateau (−3,1 bis −3,2 hPa zwischen 59
und 62,5° N); der automatische Punkt liegt an dessen Südrand (−2,5 hPa),
der Handpunkt darin (−2,5 hPa in der 60-km-Glättung). Der stärkste Fall
insgesamt liegt am Kern (−4,2 hPa, das Tief vertieft sich bzw. zieht).

Umgesetzt (`opFall`, Vorgabe, Zustimmung der Projektleitung: der Punkt
rutscht so auch in den stärksten Niederschlag, ebenfalls ein übliches
Kriterium): Nach dem Zurücklegen entlang der Kaltfront rückt der Punkt
entlang der Okklusion bis 400 km zum stärksten 3-h-Druckfall vor (Abzug
0,15 hPa je 100 km, mindestens 0,3 hPa Gewinn); die Kaltfront läuft auf dem
bisherigen Okklusionsweg bis zum neuen Punkt weiter, die Warmfront wird
angeschlossen. 06.10. 18 UTC: Punkt 239 km vor auf 60,0° N 46,1° E (Hand:
60,3° N 45,2° E, rund 50 km), Niederschlag am Punkt 0,9 → 2,4 mm/h;
Treffer 84 → 94 %, 91 → 76 km. Alle anderen Okklusionspunkte der Fälle
bleiben (kein deutlich stärkerer Fall). Zwei Einschränkungen nach der
Seitenprüfung: nur solange die Okklusion örtlich höchstens 30° von der
Kaltfrontrichtung abweicht, und nur wenn die Kaltfront als ganzes Stück
zurückgeschrieben wird (in der Restkette verschob das Neuverteilen der
Punkte die Stückgrenzen; am Russlandtief 10.10. 09 UTC lag ein Stück mit
falscher Symbolseite auf der Verlängerung). Gesamt 94 % / 97 % / 11 % /
39 km.
