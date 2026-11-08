# Sichtweite: eigene Parametrisierung (Arbeitsstand)

Hintergrund: Der DWD entfernt VIS nach dem 30.11.2026 aus den
ICON-Open-Data-Lieferungen (s. `tools/vis-archive/README.md`). Ziel ist eine
eigene, nachvollziehbar dokumentierte Sichtdiagnose aus Feldern, die
Open-Meteo weiter liefert, abgeglichen gegen die Original-Modellsicht, solange
es sie gibt.

Dieses Dokument hält zuerst fest, **wie ICON selbst die Sicht berechnet**,
weil das die Referenz ist, gegen die wir abgleichen. Die eigentliche
Parametrisierung, Kalibrierung und Verifikation folgen hier, sobald sie
stehen.

## 1. Die ICON-Sichtdiagnose

**Quelle (gelesen):** ICON-Quellcode, Release icon-2026.10 (Commit
`7de8533`, 30.10.2026), `src/atm_phy_nwp/mo_opt_nwp_diagnostics.f90`,
Routine `compute_field_visibility`. Repository
<https://gitlab.dkrz.de/icon/icon-model> (BSD-3-Lizenz). Die Database
Reference des DWD (`docs/icon_database_main.pdf`) beschreibt VIS nur als
„Near surface visibility in m“ (seit Version 2.3.1, 23.04.2024, für ICON-EU
und ICON-D2).

**Herkunft laut Code-Kommentar:** RUC-Routine CALVIS (S. Benjamin,
NOAA/FSL, 1999–2003), aufbauend auf Stoelinga & Warner (Eta-Modell). Beim DWD
angepasst durch T. Göcke: 03/2022 RH-Abhängigkeit nach Gultepe et al. (2009),
03/2023 RH-Abhängigkeit per Fit an SYNOP-Daten über Deutschland (11/2021).
Die zitierten Primärquellen (Kunkel 1984, Stoelinga & Warner, Gultepe et al.
2009, Stallabrass 1985, Rutledge & Hobbs 1983, Kuchera) habe ich **nicht**
gelesen; die Angaben unten stammen ausschließlich aus dem Code.

Die Sicht ist das Minimum aus zwei Teilen, einem Feuchteterm und einem
Hydrometeorterm.

### 1.1 Feuchteterm (Dunst)

RH wird aus qv, p, T über Wasser berechnet (auf 100 % begrenzt), auf den
untersten drei Flächen; verwendet wird `rhmax = max(RH(nlev), RH(nlev−1))`,
also das Maximum der **untersten zwei** Flächen.

Zwei Varianten, gewählt über den Namelist-Schalter `itune_vis_diag`
(`mo_nwp_tuning_nml.f90`: Default **1**; Kommentar in
`mo_nwp_tuning_config.f90`: 1 = erste operationelle Fassung, 2 = optimierter
Tag-Nacht-Faktor, 3 = (2) plus neu abgestimmte RH-Abhängigkeit):

- **Variante 1 und 2** (Fit an SYNOP Deutschland 11/2021), RH in %, Sicht
  in m:
  - RH ≤ 40: `visrh = 88950.37 − 327.734·RH`
  - 40 < RH ≤ 98,2: Polynom 5. Grades
    `2.74158753e-4·RH⁵ − 8.04508715e-2·RH⁴ + 9.4148139·RH³ − 578.127237·RH² + 18268.2914·RH − 154588.988`
  - RH > 98,2: `visrh = −1171.049·RH + 117111.725`
- **Variante 3** (G. Zängl), RH als Bruchteil:
  `visrh = (90 − 257.44·RH + 471.29·RH² − 301.85·RH³) · invfac` [km],
  Stützstellen laut Kommentar 90 km bei RH 0, 40 km bei 0,6, 20 km bei 0,9,
  2 km bei 1,0.
  `invfac = 5 / max(5, θv(k950) − θv(nlev−2))` mindert die Sicht unter
  Inversionen (Dunst in der Grenzschicht). k950 ist die oberste Fläche unter
  540,3 m über Grund (`h950_standard`, `mo_nwp_phy_init.f90`).

Danach in beiden Varianten:

- Untergrenze 1 km (`visrh_clip`).
- Scherungsterm: `shear = |v(nlev−2) − v(nlev)|`;
  `shear_fac = clamp((shear − 4)/2, 0, 1)`; liegt `visrh` unter 10 km, wird
  es um `(10 − visrh)·shear_fac` angehoben. Wind mischt Dunst also weg
  (Begründung im Code: Kuchera).

**Welche Variante der DWD in ICON-D2/-EU operationell fährt, steht nicht im
Code** (die Namelists der operationellen Läufe sind nicht Teil des
Repositorys). Das klären wir empirisch mit dem Archiv, beide Varianten
lassen sich nachrechnen.

### 1.2 Hydrometeorterm

Massenkonzentration C = q·ρ [g/m³], jeweils das **Maximum über die untersten
drei Flächen** (`top_lev = 3`). Extinktion β [km⁻¹]:

| Spezies | Code | Herkunft laut Kommentar |
|---|---|---|
| Wolkenwasser | `144.7 · C^0.88` | Kunkel (1984) |
| Wolkeneis | `327.8 · C^1.0` | Plättchen nach Rutledge & Hobbs (1983) |
| Regen | `2.24 · C^0.75` | Marshall-Palmer, N₀ = 8·10⁶ m⁻⁴ |
| Schnee | `a_s · C^1.0`, a_s = 10 (T ≤ −2 °C) bis 6 (T ≥ −1 °C), linear dazwischen | Stallabrass (1985) |
| Graupel | `4.0 · C^0.75` | Schätzung Brown & Benjamin (1999) |

Achtung: Der Kommentarblock im Code nennt für Schnee `10.36·C^0.7776` und
für Graupel `8.0·C^0.75`. Gerechnet wird mit den Parametern oben, die
Kommentare sind veraltet.

Wolkenwasser und -eis: Bei Kopplung der effektiven Radien an die Strahlung
(`icpl_rad_reff = 1`) enthalten die Gesamtfelder Regen/Schnee/Graupel mit;
die Routine zieht diese wieder ab („qc_pure“, „qi_pure“).

Koschmieder mit **2 % Kontrastschwelle**: `vis = min(90 km, −ln(0.02)/β)`
= 3,912/β. (Nicht die 5 % der MOR-Definition.)

**Tag/Nacht:** Nachts wird die Hydrometeorsicht vergrößert:

- Variante 1: `vis_night = 1.69 · (vis/1.609)^0.86 · 1.609` (Rasmussen 2003)
- Varianten 2/3: `vis_night = vis · clamp((vis/0.05)^0.25, 1.25, 2.25)`

Übergang über den Kosinus des Sonnenzenitwinkels: `zen_fac = clamp(cos z, 0, 0.1)/0.1`,
`vis = zen_fac·vis + (1 − zen_fac)·vis_night`. Voller Tagwert also erst ab
etwa 5,7° Sonnenhöhe.

**Ergebnis:** `VIS = min(vis_hydrometeore, visrh)` in m.

### 1.3 Erste Nachrechnung (Brocken, ICON-D2, 07.11.2026)

Am 07.11. um 12 UTC meldete ICON-D2 am Brocken 460 m Sicht, obwohl
`cloud_water_k0 = 0` war. Der Feuchteterm kann wegen der 1-km-Untergrenze
nicht darunter liegen, also muss es der Hydrometeorterm sein. Tatsächlich
hat k2 (≈ 74 m über Grund) Wolkenwasser. Nachgerechnet mit
ρ = p/(R_d·T·(1 + 0,608·qv)) und dem Maximum über k0–k2, ohne Niederschlag:

| Zeit | C_max [g/m³] | Tagwert | Nacht V1 | Nacht V2/3 | ICON-VIS |
|---|---|---|---|---|---|
| 12 UTC (Tag) | 0,040 | **460 m** | 926 m | 800 m | 460 m |
| 18 UTC (Nacht) | 0,200 | 111 m | 274 m | **139 m** | 140 m |

Beide Werte treffen. Daraus folgt, vorläufig für zwei Stunden an einer
Station:

- `cloud_water_level{N}` vom Server ist das Feld, das die Routine verwendet
  (zumindest ohne Niederschlag).
- ICON-D2 läuft operationell mit **Variante 2 oder 3**, nicht mit 1. Ob 2
  oder 3, entscheidet erst der Feuchteterm (in Stunden ohne Hydrometeore).
- Open-Meteo speichert VIS mit 20-m-Auflösung (139 → 140 m).

### 1.4 Nachrechnung über das ganze Archiv (Stand 2026-11-08)

`src/visibility.js` (`iconVisibility()`) rechnet die Routine nach,
`tools/vis-archive/analyze.mjs` vergleicht sie mit der Modellsicht. Daten:
05.10.–07.11.2026 ohne die Tage der DWD-Störung 10.–12.10. (unvollständige
Läufe, Modellflächen und Sichtfeld passen dort nicht zusammen), 24
Stationen, 13 Modellflächen, ohne Regen/Schnee/Graupel (fehlen auf dem
Server). „Trocken“ = kein Niederschlag in der Stunde und der folgenden.

Median der relativen Abweichung |ln(calc/ICON)|, trockene Stunden:

| Modell | Variante 1 | Variante 2 | Variante 3 |
|---|---|---|---|
| ICON-D2 (n = 15 807) | 0,383 | 0,342 | **0,006** |
| ICON-EU (n = 14 450) | 0,372 | 0,367 | **0,025** |

**Beide Modelle laufen operationell mit `itune_vis_diag = 3`.** In D2
liegen 74 % der trockenen Stunden auf 2 % genau, bei ICON-Sicht ≥ 30 km
99,5 %. In Niederschlagsstunden ist der Median trotz fehlender
Regen/Schnee/Graupel-Anteile nur 1,4 % (D2) bzw. 5,8 % (EU).

Wo es nicht passt (D2, Variante 3, trocken):

| ICON-Sicht | ≤ 10 % Abweichung | typisch |
|---|---|---|
| < 1 km | 46 % | Median calc/ICON 0,98, aber breite Streuung |
| 1–5 km | 3 % | wir rechnen 2,6-mal zu hoch (Median) |
| 5–10 km | 62 % | |
| ≥ 10 km | 99–100 % | |

ICON-EU liegt in allen Klassen schlechter (≥ 30 km: 97 %, 10–30 km: 76 %,
< 1 km: 12 % innerhalb 10 %).

**Ursache für 1–5 km: subskaliges Wolkenwasser.** ICON nimmt `tot_ptr(iqc)`
(gitterskalig + subskalig aus dem Wolkenbedeckungsschema), der Server liefert
offenbar nur das gitterskalige QC. Beleg: In den Stunden, die wir deutlich zu
hoch rechnen, ist in 68 % Wolkenbedeckung auf k0–k2 vorhanden, aber
`cloud_water` = 0; in den gut getroffenen Stunden nur in 5 %. Bei RH 95–98 %
erzeugt ICON also subskaliges Wasser, das die Sicht auf 1–4 km drückt,
während unser reiner Feuchteterm 5–10 km ergibt.

DWD-Open-Data (ICON-D2, geprüft 2026-11-08) hat auf Modellflächen `qc`,
`qi`, `qr`, `qs`, `qg` und `clc`, aber kein subskaliges bzw. Gesamt-
Wolkenwasser (nur vertikal integriert: `tqc_dia`, `tqi_dia`). ICON-EU hat
auf Modellflächen nur `qc`, `qi`, `clc`. Das Wolkenschema selbst (KOE-Schema,
M. Köhler; turbulente Varianz, Konvektion, Stratocumulus) ist nicht mit
vertretbarem Aufwand nachzubauen.

Die Tage 10.–12.10. fielen zuerst durch viele grobe Abweichungen auf (Nebel
in unserer Rechnung bei ICON-Sicht über 20 km und umgekehrt). Ursache laut
Heidi: DWD-Störung mit unvollständigen Läufen. Sie sind deshalb aus der
Auswertung ausgenommen (`DEFAULT_EXCLUDE_DAYS` in `analyze.mjs`).

### 1.5 Ersatz für das subskalige Wolkenwasser

Rückgerechnet aus der ICON-Sicht (Tagwert über die Umkehrung des
Nachtfaktors, dann β und C über Kunkel) zeigt sich in D2, trocken, wo ICON
durch Hydrometeore begrenzt ist:

| Wolkenbedeckung k0–k2 (max.) | gitterskaliges qc = 0 |
|---|---|
| < 0,2 | immer |
| 0,2–0,5 | immer |
| 0,5–0,8 | in der Hälfte der Fälle |
| ≥ 0,8 | nie |

Das nötige Wasser wächst etwa mit qsat · clc^1,3 (Mediane je Klasse).
Ansatz, je Fläche k0–k2:

    qc_eff = max(qc, a · qsat(T, p) · clc^b)

a und b per Gittersuche (`analyze.mjs --fit-subgrid`, Ziel: größter Anteil
trockener Stunden mit ≤ 10 % Abweichung). Ergebnis: D2 a = 0,01, b = 2,0;
EU a = 0,01, b = 1,75. Mit b = 2 auch für EU praktisch gleich gut (73,1 statt
73,3 %), daher **ein Satz für beide: a = 0,01, b = 2** (`SUBGRID_FIT` in
`src/visibility.js`). Das ist eine rein empirische Anpassung an ICONs
KOE-Wolkenschema, keine physikalische Herleitung.

Wirkung (trocken, Anteil ≤ 10 % / ≤ 30 % Abweichung):

| | ohne | mit Ersatz |
|---|---|---|
| D2 gesamt | 86,8 / 91,6 % | 89,9 / 97,9 % |
| D2 1–5 km | 2,7 / 5,9 % | 35,8 / 83,8 % |
| D2 < 1 km | 45,6 / 82,1 % | 50,7 / 91,1 % |
| EU gesamt | 71,4 / 81,9 % | 73,1 / 85,6 % |
| EU 1–5 km | 3,0 / 9,1 % | 17,1 / 41,0 % |

**Warum EU schlechter bleibt:** Die größten EU-Abweichungen sind Fälle mit
viel gitterskaligem Wolkenwasser (Nebel in unserer Rechnung), bei denen die
ICON-Sicht trotzdem 6–25 km beträgt (z. B. LOWI, LSZH). Einen Zeitversatz
zwischen den Feldern gibt es nicht (Abweichung bei 0 h Versatz klar am
kleinsten, D2 wie EU). Vermutung, nicht geprüft: ICON-EU kommt vom DWD auf
ein reguläres Gitter interpoliert, und die Interpolation einer stark
nichtlinearen Größe wie der Sicht passt nicht zur Sicht aus interpolierten
Eingangsfeldern, besonders bei kleinräumigem Nebel.

### 1.6 Ersatz für Regen und Schnee aus Bodenraten

**Welche Raten:** ICON hat qr/qs/qg nur für gitterskaligen Niederschlag;
konvektiver ist ein diagnostischer Fluss ohne Gehalt in der Luft und geht in
die Sichtdiagnose nicht ein. Open-Meteo bildet die ICON-Felder so ab
(Quellcode `Sources/App/Icon/IconVariableDownloadable.swift` und
`IconReader.swift`, Stand Juni 2026): `rain` = `rain_gsp`, `showers` =
`rain_con`, `snowfall` [cm] = `snow_gsp` [mm] · 0,7. Verwendet werden daher
nur `rain` und `snowfall / 0,7`. Graupel als Rest `precipitation − rain −
showers − Schnee` ist im Archiv praktisch null (±0,4 mm, Rundung) und bleibt
außen vor.

**Regen:** Massenkonzentration aus der Marshall-Palmer-Verteilung mit
derselben Annahme wie ICONs Regenkoeffizient (N₀ = 8·10⁶ m⁻⁴) und
Λ = 4,1 mm⁻¹ · R^−0,21 (Marshall & Palmer 1948, aus dem Gedächtnis zitiert,
nicht im Original gelesen): W = π ρ_w N₀ / Λ⁴ = 0,089 · R^0,84 g/m³
(nachgerechnet). `hydroFromSurfaceRates()` in `src/visibility.js`.

**Zeitbezug:** Die Raten sind Summen der vorangehenden Stunde, ICON nutzt
den Gehalt zur Zeit t. Bester Bezug: **min(Summe bis t, Summe ab t)** –
Regen liegt zur Zeit t in der Luft, wenn er vorher und nachher fällt.

**Bestätigung:** In Stunden, in denen der Regen die ICON-Sicht begrenzt
(ICON mindestens 15 % unter unserer Rechnung ohne Niederschlag), liegt der
zurückgerechnete nötige Faktor auf W im Median bei 0,9 (D2) bzw. 1,2 (EU).
Die Marshall-Palmer-Ableitung passt also ohne Anpassung; die Streuung ist
groß (Quartile etwa Faktor 2 auseinander). Über alle Niederschlagsstunden
(Variante 3, Subgrid-Ersatz an), Anteil ≤ 10 % / ≤ 30 % Abweichung:

| | ohne Regenanteil | Mittel, Faktor 1 | **Minimum, Faktor 1** |
|---|---|---|---|
| D2 (n = 1857) | 75,9 / 85,7 % | 61,9 / 84,5 % | **73,6 / 89,1 %** |
| EU (n = 3166) | 61,1 / 76,7 % | 58,1 / 80,4 % | **61,5 / 81,7 %** |

**Schnee:** C = S / (3,6 · v_s) mit v_s = 1 m/s als Platzhalter. Im Archiv
gibt es bis 07.11. kaum gitterskaligen Schnee (D2: 1 Stunde, EU: 6).
Kalibrieren bzw. prüfen, sobald Fälle vorliegen, und v_s mit einer Quelle
belegen.

## 2. Was wir davon nachbauen können

| ICON-Eingang | über Open-Meteo verfügbar? |
|---|---|
| T, p, qv untere Flächen | ja (`temperature_`, `pressure_`, `specific_humidity_level{N}`) |
| qc, qi untere drei Flächen | ja (`cloud_water_`, `cloud_ice_level{N}`); **offen:** Gesamt- oder gitterskaliges Feld, und mit oder ohne beigemischten Niederschlag |
| qr, qs, qg | **nein** (auf dem Server getestet 2026-11-08) – nur Raten am Boden (`rain`, `showers`, `snowfall`, `precipitation`, Stundensummen) |
| u, v auf nlev und nlev−2 | ja (`wind_u/v_component_level{N}`, km/h) |
| θv auf k950 | ja, aus T, p, qv der entsprechenden Fläche |
| ρ | ja, aus p, T, qv |
| cos Sonnenzenit | berechenbar aus Ort und Zeit |

Daraus ergibt sich der Plan:

1. Feuchteterm, Scherung, Inversionsfaktor, Wolkenwasser/-eis und Tag/Nacht
   **wie ICON** rechnen.
2. Für Regen und Schnee die Massenkonzentration aus der gitterskaligen
   Bodenrate schätzen (umgesetzt, s. 1.6; Schnee noch ungeprüft).
3. Gegen das Archiv prüfen: zuerst nur die Stunden ohne Niederschlag (dort
   sollte die Nachrechnung fast exakt stimmen, sonst stimmt eine Annahme zu
   qc/qi oder der Variante nicht), danach die Niederschlagsstunden.

Diese Variante hat den Vorteil, dass sie auch für ICON Global funktioniert,
soweit dort die Modellflächen-Felder vorliegen.

## 3. Offene Punkte

- ~~Operationelle Einstellung von `itune_vis_diag`~~: Variante 3 für D2 und
  EU (1.4).
- `cloud_water_level{N}` auf dem Server ist gitterskaliges QC (1.4).
  Subskaliges Wolkenwasser: empirischer Ersatz aus der Wolkenbedeckung (1.5).
  Offen: Temperaturabhängigkeit (Eis-Anteil bei T < 0 °C), Prüfung an den
  Daten bis 30.11.
- `qr`, `qs`, `qg`: Für ICON-D2 gäbe es sie in den DWD-Open-Data, sie werden
  aber bewusst **nicht** zusätzlich geholt (Entscheidung 2026-11-08): Für
  ICON-EU muss ohnehin aus Bodenraten geschätzt werden, ein Verfahren für
  beide Modelle ist einfacher zu pflegen und zu dokumentieren, und Regen
  dämpft die Sicht nur schwach (Schnee stärker). Neu bewerten, falls die
  Schätzung bei Schnee schlecht abschneidet.
- Ob die Routine sich zwischen dem beim DWD laufenden Stand und icon-2026.10
  unterscheidet. Die Release Notes von icon-2026.04 nennen eine Überarbeitung
  der Sicht- und Ceiling-Diagnose „to better match SYNOP observations“.
