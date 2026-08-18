/**
 * Wolkendarstellung nach der Ogimet-GRAMET-Technik: viele kleine, flache
 * Ellipsen, jede erst weiß gefüllt UND DANN grau umrandet, in zufälliger
 * Reihenfolge übereinander.
 *
 * Der ganze Look hängt an dieser Reihenfolge. Weil jede Ellipse ihre Kontur
 * sofort nach ihrer Füllung zieht, übermalen die Füllungen späterer Ellipsen
 * die Ränder früherer. Innen bleiben nur vereinzelte graue Fetzen stehen (die
 * charakteristische Fleckigkeit), am Rand der Wolkenmasse überlebt die Kontur
 * und bildet die ausgefranste, handgezeichnete Silhouette. Zeichnete man erst
 * alle Füllungen und dann alle Ränder, entstünde ein Gitterbild -- also NICHT
 * die beiden Durchgänge trennen. Aus demselben Grund muss die Zeichenreihen-
 * folge gemischt sein: läuft sie zeilenweise, übermalt systematisch immer die
 * untere Reihe die obere und es sieht aus wie Dachschindeln.
 *
 * Zweite Zutat ist die Maske. Säßen die Ellipsen strikt in Gitterzellen mit
 * `cloudFrac` über der Schwelle, zeichneten sich die Zellkanten als Rechtecke
 * ab. Stattdessen wird `cloudFrac` bilinear in den PIXELRAUM interpoliert und
 * die Schwelle mit zwei Oktaven Value-Noise gestört. Die Ellipsendichte
 * skaliert mit dem Überschuss über der Schwelle: dünne Bewölkung wird licht
 * und löchrig, der blaue Hintergrund schimmert durch die Lücken und erzeugt
 * die Tiefenwirkung ganz ohne Schatten.
 *
 * Anders als die Vorgängerversion (Striche, direkt gezeichnet) läuft das über
 * ein Offscreen-Canvas mit Cache: die Ellipsenzahl liegt bei durchgehender
 * Bewölkung im hohen 4- bis 5-stelligen Bereich, und `render.js` baut bei
 * JEDER State-Änderung (Layer-Toggle, Hover-Resize) den ganzen Canvas neu auf.
 * Gecacht wird über die Chartgeometrie + Höhenband, ein Layer-Toggle blittet
 * also nur noch. Cache am `grid`-Objekt (WeakMap): neue Daten -> neues Gitter
 * -> automatisch neue Textur, ohne Invalidierungslogik.
 */

import { CF_FEW } from "../clouds.js";
import { hashSeed, mulberry32, valueNoise } from "./noise.js";

/**
 * Kalibrierparameter -- Namen, Einheiten und Wirkung identisch zum
 * Wolken-Tuner (`wolken-tuner.html`), damit dessen JSON hier 1:1 eingesetzt
 * werden kann. `seed` fehlt bewusst: der Seed kommt aus Ort + Zeitreihenstart,
 * sonst wäre das Muster nicht mehr an die Daten gebunden.
 *
 * Die Werte hier entsprechen dem Stand vor der Kalibrierung. Die Tuner-
 * Voreinstellungen weichen ab (density 30, threshold 0.30, gain 2.2,
 * noiseScale 0.025, noiseAmp 0.18) -- beim Übernehmen unbedingt `threshold`
 * beachten, s. dort.
 */
const TUNING = {
  // Ellipsenform: flach und breit, das Seitenverhältnis macht den
  // Wolkencharakter aus.
  wMin: 8, wMax: 24,        // Breite in px
  hMin: 3, hMax: 6,         // Höhe in px

  // Dichte in der Zählweise des Tuners (Versuche = density * 800 auf dessen
  // 960x560-Fläche); unten auf die tatsächliche Chartfläche umgerechnet, der
  // Reglerwert wirkt hier also genauso wie dort.
  density: 35,

  // Ab welcher Wolkenfraktion überhaupt gezeichnet wird. ACHTUNG, das ist
  // keine reine Optik: Vorgabe ist die meteorologische FEW-Schwelle aus
  // `clouds.js`. Zieht man sie auf den Tuner-Vorgabewert 0.30 hoch,
  // verschwinden SCT-Schichten (0.25) vollständig aus dem Chart.
  threshold: CF_FEW,

  // Steilheit der Annahmekennlinie: p = min(1, (frac - threshold) * gain).
  // 1/gain ist die Spanne über der Schwelle bis zur vollen Dichte --
  // 1.33 entspricht "voll ab Bedeckung 0.85".
  gain: 1 / 2.5,

  // Maskenstörung: zwei Oktaven Value-Noise auf die Schwelle. `noiseScale`
  // ist die Frequenz in 1/px (Kehrwert der Wellenlänge: 0.0385 ~ 26 px),
  // `noiseAmp` die Amplitude in cloudFrac-Einheiten.
  noiseScale: 1 / 26, noiseAmp: 0.15,

  // Kontur.
  gray: 150, grayAlpha: 0.6, strokeWidth: 2,
};

const SPOT_FILL = "#fff";

// --- Licht/Schatten -----------------------------------------------------
//
// Lichtquelle von oben angenommen (wie am Tag): der Wolkenoberrand bleibt in
// der unveränderten `fill`-Farbe -- voll besonnt lässt sich ohnehin nicht
// heller darstellen als der Ausgangston (bei reinem Weiß erst recht nicht).
// Zur Basis hin wird pro Ellipse zu einem dunkleren, leicht ins Kühle
// gezogenen Schattenton gemischt (`shadeMix`), abgeleitet aus `fill` selbst
// -- kein zweiter Tuning-Parameter nötig, eine eingesetzte Tuner-JSON muss
// weiterhin nur `fill` ändern, der Schatten zieht automatisch mit.
//
// `SHADE_GAMMA` > 1 hält den oberen Teil einer Wolke überwiegend hell und
// zieht den Übergang zur Basis zusammen -- bei glatt linearer Mischung (t^1)
// wirkte die ganze Fläche gleichmäßig grau statt licht/schattig.
const SHADE_GAMMA = 3.0;

/** Höhenanteil `cy` zwischen `top` und `bot` als Schattierungsfaktor [0,1]. */
function edgeShadeT(top, bot, cy) {
  const span = bot - top;
  const raw = span > 1 ? (cy - top) / span : 0;
  return Math.pow(clamp(raw, 0, 1), SHADE_GAMMA);
}

/** Hex-Fill (3- oder 6-stellig) in {r,g,b}. */
function baseRGB(hex) {
  if (hex.length === 4) {
    return {
      r: parseInt(hex[1] + hex[1], 16),
      g: parseInt(hex[2] + hex[2], 16),
      b: parseInt(hex[3] + hex[3], 16),
    };
  }
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** Mischt von `base` (t=0, voll beschienen) zu dessen Schattenton (t=1). */
function shadeMix(base, t) {
  const sr = base.r * 0.55, sg = base.g * 0.60, sb = Math.min(255, base.b * 0.68 + 15);
  const r = Math.round(base.r + (sr - base.r) * t);
  const g = Math.round(base.g + (sg - base.g) * t);
  const b = Math.round(base.b + (sb - base.b) * t);
  return `rgb(${r},${g},${b})`;
}

// Zweite Oktave auf krummem Frequenzverhältnis (wie im Tuner): bei glatt 2.0
// fielen beide Rauschgitter aufeinander und man sähe wieder ein Raster.
const FBM_OCTAVE = 2.1, FBM_W1 = 0.65, FBM_W2 = 0.35;

// Umrechnung der Tuner-Dichte auf eine flächenbezogene Größe. Der Tuner
// verteilt `density * 800` Versuche über sein festes 960x560-Canvas; hier ist
// die Chartfläche variabel, also wird auf Versuche je 1000 px² normiert.
// Flächenbezug ist ohnehin zwingend: Modell-Level liegen am Boden dicht und
// oben weit auseinander, die Höhenachse staucht zusätzlich (log) bzw. streckt
// (lin). Zählte man je Gitterzelle, schwankte die sichtbare Dichte um Faktor
// ~35 über die Achse (am Boden ~5x dünner als in 10 km).
const TUNER_CANVAS_PX2 = 960 * 560;
const spotsPer1000px2 = () => TUNING.density * 800 / TUNER_CANVAS_PX2 * 1000;

// Auflösung der Maske in der Senkrechten (Pixel je Stützzeile). Bewusst
// unabhängig von der Dichte, damit sich beim Drehen an `density` nicht auch
// die Maskenschärfe ändert.
const MASK_ROW_PX = 4;

const cacheByGrid = new WeakMap();

/**
 * Zeichnet die Wolken in den Haupt-Canvas-Kontext (aus dem Cache geblittet,
 * bei Bedarf vorher offscreen aufgebaut).
 */
export function drawClouds(ctx, grid, cloudFrac, x, y) {
  const w = Math.max(1, Math.round(x.right - x.left));
  const h = Math.max(1, Math.round(y.bot - y.top));
  // Der Mittenwert unterscheidet log- von lin-Achse (gleiche Ränder, andere
  // Kennlinie) -- ohne ihn träfe der Cache beim Umschalten fälschlich zu.
  const key = [w, h, grid.times.length,
    y.inv(y.top).toFixed(2), y.inv((y.top + y.bot) / 2).toFixed(2), y.inv(y.bot).toFixed(2),
  ].join("|");

  let entry = cacheByGrid.get(grid);
  if (!entry || entry.key !== key) {
    entry = { key, canvas: paintOffscreen(grid, cloudFrac, x, y, w, h) };
    cacheByGrid.set(grid, entry);
  }
  ctx.drawImage(entry.canvas, x.left, y.top, w, h);
}

function paintOffscreen(grid, cloudFrac, x, y, w, h) {
  const dpr = window.devicePixelRatio || 1;
  const off = document.createElement("canvas");
  off.width = Math.round(w * dpr);
  off.height = Math.round(h * dpr);
  const octx = off.getContext("2d");
  octx.scale(dpr, dpr);
  // Im Offscreen liegt der Ursprung auf der linken oberen Chartecke; die
  // Skalen x()/y() rechnen weiterhin in Chartkoordinaten.
  octx.translate(-x.left, -y.top);
  paintClouds(octx, grid, cloudFrac, x, y);
  return off;
}

function paintClouds(ctx, grid, cloudFrac, x, y) {
  const { meta, times } = grid;
  const rng = mulberry32(hashSeed(`${meta.lat},${meta.lon},${meta.elevation},${times[0]}`));
  const noiseSeed = hashSeed(`noise:${meta.lat},${meta.lon},${times[0]}`);
  const mask = buildMask(grid, cloudFrac, x, y);

  // Kandidatenfläche über die Chartfläche hinaus erweitern, um die halbe
  // maximale Ellipsengröße: sonst fehlen am Rand die Ellipsen, deren
  // Mittelpunkt knapp draußen liegt, und die Randzone wäre systematisch
  // dünner als das Innere. Der Clip beim Zeichnen schneidet den Überstand ab.
  const padX = TUNING.wMax / 2, padY = TUNING.hMax / 2;
  const rx0 = x.left - padX, ry0 = y.top - padY;
  const rw = (x.right - x.left) + 2 * padX, rh = (y.bot - y.top) + 2 * padY;
  const attempts = Math.round(spotsPer1000px2() * rw * rh / 1000);

  const fillBase = baseRGB(SPOT_FILL);

  ctx.save();
  // Ellipsen sind bis `wMax` breit -- ohne Clip ragten sie über die Höhenachse
  // und in den rechten Rand mit den Linien-Labels.
  ctx.beginPath();
  ctx.rect(x.left, y.top, x.right - x.left, y.bot - y.top);
  ctx.clip();
  ctx.lineWidth = TUNING.strokeWidth;

  // Positionen gleichverteilt ziehen (nicht auf einem Raster): damit ist die
  // Zeichenreihenfolge von sich aus räumlich zufällig. Das ist Bedingung für
  // den Überdeckungseffekt -- liefe sie zeilenweise, übermalte systematisch
  // die spätere Reihe die frühere und es sähe aus wie Dachschindeln.
  for (let i = 0; i < attempts; i++) {
    const cx = rx0 + rng() * rw, cy = ry0 + rng() * rh;
    const base = mask.at(cx, cy);
    // Rauschen ausblenden, wo gar keine Wolke ist: additiv allein kann es die
    // Schwelle aus klarer Luft heraus überschreiten und Wolkenfetzen im Nichts
    // erfinden (passiert, sobald `noiseAmp` an `threshold` heranreicht -- bei
    // den Tuner-Vorgaben 0.18 < 0.30 nicht, bei unserer FEW-Schwelle 0.10
    // sehr wohl). Unterhalb der Schwelle läuft die Amplitude linear aus, an
    // der Kante wirkt sie voll -- genau dort soll sie ja ausfransen.
    const noiseGate = Math.min(1, base / TUNING.threshold);
    const frac = base + TUNING.noiseAmp * noiseGate * maskNoise(noiseSeed, cx, cy);
    if (frac <= TUNING.threshold) continue;
    // Dichte skaliert mit dem Überschuss über der Schwelle: dünne Bewölkung
    // wird licht und löchrig statt gleichmäßig blass.
    if (rng() >= Math.min(1, (frac - TUNING.threshold) * TUNING.gain)) continue;

    const ew = TUNING.wMin + rng() * (TUNING.wMax - TUNING.wMin);
    const eh = TUNING.hMin + rng() * (TUNING.hMax - TUNING.hMin);
    const t = mask.shadeAt(cx, cy);
    ctx.fillStyle = shadeMix(fillBase, t);
    // Kontur zieht mit: an der besonnten Oberkante hell/unauffällig, zur
    // beschatteten Basis hin bis zu 40 Graustufen dunkler.
    const strokeGray = TUNING.gray - Math.round(40 * t);
    ctx.strokeStyle = `rgba(${strokeGray},${strokeGray},${strokeGray},${TUNING.grayAlpha})`;
    ctx.beginPath();
    ctx.ellipse(cx, cy, ew / 2, eh / 2, 0, 0, Math.PI * 2);
    ctx.fill();   // Reihenfolge fill -> stroke JE Ellipse, siehe Kopfkommentar.
    ctx.stroke();
  }
  ctx.restore();
}

// --- Cb/TCU: Schaft und Amboss -----------------------------------------------

/**
 * Konvektion wird als EINZELNE ZELLEN gezeichnet, nicht als durchgehende Säule
 * über den ganzen konvektiven Zeitraum. Ein labiler Nachmittag liefert leicht
 * acht bis zehn Stunden am Stück; als ein Gebiet gezeichnet wurde daraus ein
 * kompakter sandfarbener Block über den halben Chart (s. Feedback). Das ist
 * auch fachlich schief: eine Gewitterzelle lebt 30-60 Minuten, was das Modell
 * über Stunden zeigt, ist eine FOLGE von Zellen, kein einzelnes Gebilde.
 *
 * `cbCells` legt deshalb über jeden Lauf einen Zellrhythmus (gesetzter Seed,
 * s. CB_CELL_*): Zellmitten wandern in Abständen von ein bis knapp drei
 * Stundenbreiten durch den Lauf, jede Zelle ist knapp eine Stundenbreite breit.
 * Dazwischen bleibt Lücke, der Hintergrund kommt durch, die Türme stehen
 * einzeln. Der Lauf als Ganzes bleibt trotzdem ablesbar: die Zellen füllen
 * genau seine Zeitspanne.
 *
 * WAS DAS HEISST: die Zahl der Türme ist NICHT die Zahl der konvektiven
 * Stunden, und eine Lücke zwischen zwei Türmen bedeutet NICHT, dass es dort
 * keine Konvektion gibt. Die stundenscharfe Aussage steht in der Wetter-Zeile
 * und im Niederschlagsvorhang; der Schaft zeigt Charakter und Zeitraum.
 *
 * Jede Zelle wird als SILHOUETTE gezeichnet, nicht als Rechteck mit rundum
 * gleicher Franse -- drei Kanten, drei Charaktere:
 *
 *   - UNTERKANTE hart und waagerecht abgeschnitten. Kondensationsniveau ist
 *     eine Fläche, keine Zufallsgrenze; eine ausgefranste Cb-Basis gibt es in
 *     der Natur nicht. Umgesetzt als Clip auf die Basislinie (nicht als
 *     Abstandsrampe) -- so werden auch die Ellipsen, deren Mittelpunkt knapp
 *     darüber liegt, sauber gekappt statt darunter herauszuhängen.
 *   - OBERKANTE als Blumenkohlkuppe aus zwei bis drei überlappenden Kuppeln
 *     (`cellTopEdge`, untere Einhüllende). Die Auslenkung geht nur nach UNTEN,
 *     nie über den Modelloberrand hinaus -- sonst stieße der Schaft durch den
 *     flachen Ambossdeckel.
 *   - SEITEN weich, über Rampe + Rauschen.
 *
 * Der Amboss ist eine eigene Region mit umgekehrter Härte (flacher Deckel oben,
 * weiche Unterseite) und sitzt seitlich über die Zelle hinaus -- s.
 * `drawCbAnvils`. Er bekommt bewusst KEINE Lücke aufgezwungen: benachbarte
 * Ambosse dürfen zu einem Schirm verschmelzen, das ist an einem Gewittertag
 * genau das Bild. Getrennt sind die Türme darunter.
 */

/**
 * Kalibrierparameter des Cb-Schafts, Bedeutung wie in `TUNING` (Tuner-
 * Konvention). Eigener Satz, weil der Schaft anders aussehen muss als die
 * Schichtbewölkung: Inneres praktisch deckend (im Original schimmert dort
 * KEIN Blau durch, s. Referenz-Screenshot), Ellipsen etwas kleiner, Rauschen
 * gröber und kräftiger, damit die Säulenränder die typischen Beulen bekommen.
 */
const CB_TUNING = {
  wMin: 6, wMax: 14, hMin: 3, hMax: 6,
  // ~5-fache Überdeckung im Inneren -> Restlöcher < 1 %.
  density: 90,
  // Die Schaft-"Maske" ist eine Abstandsrampe (s. `paintRegion`): 1 tief im
  // Inneren, 0.5 exakt auf der weichen Kante, 0 eine Fransenbreite draußen.
  // threshold 0.5 legt die sichtbare Kante also auf die Geometrie, das
  // Rauschen verschiebt sie lokal um bis zu +-noiseAmp Rampeneinheiten.
  // gain ist an noiseAmp GEKOPPELT: 1/(1 - threshold - noiseAmp) ist der
  // kleinste Wert, bei dem das Innere (ramp = 1) auch beim ungünstigsten
  // Rauschwert (-noiseAmp) gesättigt bleibt -- darunter stanzt das koharente
  // Rauschen Löcher in den Schaft (bei einer nur ~28 px schmalen Säule liegt
  // fast alles im Fransenband, das fiel sofort auf). Wer noiseAmp erhöht,
  // muss gain mitziehen.
  threshold: 0.5, gain: 1 / (1 - 0.5 - 0.3),
  noiseScale: 1 / 14, noiseAmp: 0.3,
  // Halbe Breite der Abstandsrampe in px (Kante +- fringePx).
  fringePx: 9,
  fill: "#e9d5b5", gray: 130, grayAlpha: 0.75, strokeWidth: 1,
};

/**
 * Amboss: gleiche Technik, aber vergletschert -- heller (fast weiß, mit einem
 * Rest Sandton, damit er sich vom reinen Weiß der Schichtbewölkung absetzt),
 * flachere und breitere Ellipsen für den faserigen Cirrus-Charakter, gröberes
 * und schwächeres Rauschen (die Ambossränder wehen aus, sie beulen nicht).
 */
const ANVIL_TUNING = {
  wMin: 8, wMax: 20, hMin: 3, hMax: 5,
  density: 70,
  threshold: 0.5, gain: 1 / (1 - 0.5 - 0.25),
  noiseScale: 1 / 18, noiseAmp: 0.25,
  fringePx: 8,
  fill: "#f3ebdc", gray: 140, grayAlpha: 0.7, strokeWidth: 1,
};

// Ambossgeometrie in Pixeln. Die Ausladung skaliert mit der STUNDENBREITE (und
// ist zusätzlich an der Lauflänge gedeckelt, s. Aufrufstelle): würde sie an der
// Lauflänge hängen, bekäme eine sechsstündige Gewitterlage einen absurd weit
// ausgezogenen Deckel. Die Dicke skaliert mit der Schafttiefe, gedeckelt, damit
// flache Zellen keinen Deckel im Verhältnis 1:1 bekommen.
const ANVIL_DEPTH_FRAC = 0.22, ANVIL_DEPTH_MIN = 16, ANVIL_DEPTH_MAX = 60;
const ANVIL_FLARE_CELLS = 0.9, ANVIL_FLARE_MIN = 18, ANVIL_FLARE_MAX = 80;
// Restdicke an der Ambossspitze (Anteil der vollen Dicke) -- die Unterseite
// läuft nach außen keilförmig aus, das ist die Ambossform.
const ANVIL_TIP_FRAC = 0.15;
// Wie weit die Ambossunterseite höchstens nach unten gezogen wird, um an einen
// tiefer liegenden Schaftoberrand anzuschließen (Vielfaches der Dicke).
const ANVIL_MAX_DROP = 2.5;
// Der Ambossdeckel liegt um diesen Betrag ÜBER dem höchsten Schaftoberrand:
// dessen weiche Kante streut um +-noiseAmp*2*fringePx plus halbe Ellipse nach
// oben, und genau diese Fusseln sollen nicht über dem flachen Deckel stehen.
const ANVIL_OVERSHOOT = CB_TUNING.noiseAmp * 2 * CB_TUNING.fringePx + CB_TUNING.hMax / 2;

// Farbe der nachgezogenen Wolkenbasis -- dunkler als die Schaftfüllung, wie die
// beschattete Unterseite einer Konvektionswolke.
const CB_BASE_LINE = "rgba(108,92,72,0.85)";

// --- Zellrhythmus ------------------------------------------------------------
// Alle Angaben als [min, max] in STUNDENBREITEN (Pixelabstand zweier
// Stundenmitten), aus dem Lauf-Seed gezogen. Zwei Bedingungen gleichzeitig:
//   - Der Abstand muss deutlich über der Summe zweier halber Zellbreiten
//     liegen, sonst schließt sich die Lücke und der Block ist zurück. Im
//     ungünstigsten Fall bleiben hier 2.2 - 2*0.75 = 0.7 Stundenbreiten Luft.
//   - Die Zelle muss breit genug sein, um als Turm zu lesen. Bei ~30 px je
//     Stunde und einem 12 km tiefen Schaft (mehrere hundert Pixel) wirkte eine
//     halbe Stundenbreite wie ein Stab, nicht wie eine Quellwolke. Breiter als
//     hier geht nicht, ohne die Zeitdauer zu verfälschen.
// Nicht kalibriert, rein optisch gewählt.
const CB_CELL_SPACING_H = [2.2, 3.4];
const CB_CELL_HALFWIDTH_H = [0.5, 0.75];
// Einrückung der ersten Zellmitte ab Laufbeginn -- ohne sie klebte die erste
// Zelle immer an der Laufkante und der Rhythmus sähe getaktet aus.
const CB_CELL_FIRST_H = [0.45, 0.85];
// Läufe bis zu dieser Länge (in Stundenbreiten) bekommen genau eine, mittig
// gesetzte Zelle -- bei zwei Stunden Konvektion sind zwei Türme mit Lücke
// bereits eine Überzeichnung.
const CB_CELL_SINGLE_MAX_H = 1.5;
// Absolute Untergrenzen in Pixeln. Bei langen Vorhersagezeiträumen schrumpft
// die Stundenbreite auf wenige Pixel; ohne Boden würden Türme schmaler als ihr
// eigenes Randrauschen (+-noiseAmp*2*fringePx ~ 5 px) und verkämen zu Fusseln.
const CB_CELL_MIN_HALFWIDTH_PX = 7;
const CB_CELL_MIN_SPACING_PX = 26;

/**
 * Zellmitten und -breiten eines Laufs. Rein aus (Seed, Laufgrenzen,
 * Stundenbreite) -- deterministisch, damit Schaft, Amboss und Symbol dieselbe
 * Zerlegung sehen.
 */
function cellLayout(seed, X0, X1, hourPx) {
  const rng = mulberry32(seed ^ 0x5bf03635);
  const span = X1 - X0;
  const pickHW = () => Math.max(CB_CELL_MIN_HALFWIDTH_PX,
    hourPx * (CB_CELL_HALFWIDTH_H[0] + (CB_CELL_HALFWIDTH_H[1] - CB_CELL_HALFWIDTH_H[0]) * rng()));
  const single = () => [{ cx: (X0 + X1) / 2, hw: Math.min(span / 2, pickHW()) }];

  if (span <= hourPx * CB_CELL_SINGLE_MAX_H) return single();

  const out = [];
  let cx = X0 + hourPx * (CB_CELL_FIRST_H[0] + (CB_CELL_FIRST_H[1] - CB_CELL_FIRST_H[0]) * rng());
  while (cx < X1) {
    out.push({ cx, hw: pickHW() });
    cx += Math.max(CB_CELL_MIN_SPACING_PX,
      hourPx * (CB_CELL_SPACING_H[0] + (CB_CELL_SPACING_H[1] - CB_CELL_SPACING_H[0]) * rng()));
  }
  // Kann bei extrem schmalen Stunden passieren (Einrückung > Laufbreite) -- ein
  // Lauf ganz ohne Zelle wäre verschwundene Konvektion.
  return out.length ? out : single();
}

/**
 * Konvektionszellen aus dem Stundenarray `cb` (aus `derive.js`,
 * `{base, top, kind}` je Stunde oder null). EINMAL berechnen und an
 * `drawCbShafts`, `drawCbAnvils` und die Symbolzeichnung im Renderer
 * weiterreichen -- Amboss und Symbol müssen exakt auf demselben Turm sitzen,
 * eine zweite unabhängige Ziehung würde sie versetzen.
 *
 * Seed je Lauf aus Ort + Startstunde: Läufe würfeln unabhängig voneinander
 * (gleiche Überlegung wie beim Niederschlag, s. `render.js` `drawPrecip`).
 */
export function cbCells(grid, cb, x, y) {
  if (!cb) return [];
  const { meta, times, pos } = grid;
  const dt = pos.length > 1 ? pos[1] - pos[0] : 3600;
  const cells = [];

  for (const [i, j] of runsOf(cb, (c) => !!c)) {
    const pts = [];
    for (let k = i; k <= j; k++) {
      pts.push({ cx: x(pos[k]), yT: y(cb[k].top), yB: y(Math.max(0, cb[k].base)) });
    }
    const X0 = x(pos[i] - dt / 2), X1 = x(pos[j] + dt / 2);
    const hourPx = pts.length > 1 ? (pts[1].cx - pts[0].cx) : (X1 - X0);
    const runSeed = hashSeed(`cb:${meta.lat},${meta.lon},${times[i]}`);

    for (const { cx, hw } of cellLayout(runSeed, X0, X1, hourPx)) {
      const x0 = cx - hw, x1 = cx + hw;
      // Zelle erbt den Oberrand der Stunden, über denen sie steht: der
      // höchste (kleinstes y) im überdeckten Bereich, damit die Kuppe nicht
      // unter einen benachbarten, höheren Modellwert rutscht.
      const yTop = Math.min(edgeAt(pts, "yT", x0), edgeAt(pts, "yT", cx), edgeAt(pts, "yT", x1));
      // Stunde, die der Zellmitte am nächsten liegt -- sie bestimmt Typ (Amboss
      // ja/nein), Symbol UND die Basis.
      let hour = i;
      for (let k = i; k <= j; k++) {
        if (Math.abs(pts[k - i].cx - cx) < Math.abs(pts[hour - i].cx - cx)) hour = k;
      }
      // Basis waagerecht auf Höhe der zugeordneten Stunde -- keine
      // Interpolation mehr zwischen Nachbarstunden, sonst kippt die
      // Unterkante einer einzelnen Wolke schräg, was unrealistisch aussieht
      // (s. Feedback). Zwischen Zellen verschiedener Stunden ergibt sich die
      // Stufe von selbst, ganz ohne eigene Stufenfunktion.
      const yBot = pts[hour - i].yB;
      const bot = () => yBot;
      // Seed je ZELLE, nicht je Lauf: sonst trügen alle Türme eines Nachmittags
      // dieselbe Kuppelform und dasselbe Randrauschen.
      const seed = hashSeed(`cbcell:${meta.lat},${meta.lon},${times[i]}:${Math.round(cx)}`);
      cells.push({
        hour, t: pos[hour], kind: cb[hour].kind,
        cx, hw, x0, x1, yTop, yBot, hourPx, seed,
        top: cellTopEdge(seed, yTop, cx, hw),
        bot,
      });
    }
  }
  return cells;
}

/**
 * Schäfte der Zellen zeichnen. Kein Offscreen-Cache wie bei den Schichtwolken:
 * die Zellen sind klein (wenige tausend Ellipsen selbst bei einem
 * durchkonvektiven Tag).
 */
export function drawCbShafts(ctx, cells, x, y) {
  ctx.save();
  clipChart(ctx, x, y);
  setSpotStyle(ctx, CB_TUNING);
  for (const cell of cells) paintCell(ctx, cell);
  ctx.restore();
}

function paintCell(ctx, cell) {
  const { x0, x1, yTop, yBot, seed, top, bot } = cell;
  if (!(x1 > x0) || !(yBot > yTop)) return;

  paintRegion(ctx, seed, CB_TUNING, { x0, x1, hardBot: true, salt: [2, 3], top, bot });

  // Die harte Kante zusätzlich als Linie nachziehen: der Clip allein
  // hinterlässt eine Treppe aus angeschnittenen Ellipsenrändern, erst der
  // Strich macht daraus die eine, durchgehende Wolkenbasis.
  ctx.save();
  ctx.beginPath();
  for (let s = 0; s <= 4; s++) {
    const px = x0 + (x1 - x0) * s / 4;
    if (s === 0) ctx.moveTo(px, bot(px)); else ctx.lineTo(px, bot(px));
  }
  ctx.strokeStyle = CB_BASE_LINE;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

/**
 * Ambosse über die Cb-Läufe legen. Bewusst ein eigener Durchgang NACH den
 * Schichtwolken (s. `render.js`): der Amboss liegt definitionsgemäß im
 * Cirrus-Stockwerk, würde er wie der Schaft vor den Wolken gezeichnet, malte
 * ihn das weiße Ellipsenfeld dort sofort wieder zu und die Form wäre weg.
 *
 * Läufe hier nur über `kind === "cb"`: TCU haben per Definition keinen Amboss.
 * Ein Lauf aus tcu,tcu,cb,cb bekommt also nur über der Cb-Hälfte einen Deckel.
 *
 * Zellen, deren Oberrand von der Höhenskala an die Chartdecke gekappt wurde
 * (`cell.yTop <= y.top`, s. `makeYScale`-Clamp), bekommen KEINEN Amboss: der
 * echte Modelloberrand liegt dann bei oder über der aktuell angezeigten
 * Höhengrenze (Flughöhe im Zoom, sonst Gitterdeckel), und der Amboss säße
 * fälschlich direkt auf dieser Grenze, als reichte die Wolke nicht weiter
 * hinauf. Schaft und Symbol bleiben -- die Wolke ist oben schlicht
 * abgeschnitten (s. Feedback).
 */
export function drawCbAnvils(ctx, cells, x, y) {
  ctx.save();
  clipChart(ctx, x, y);
  setSpotStyle(ctx, ANVIL_TUNING);

  for (const cell of cells) {
    if (cell.kind !== "cb" || cell.yTop <= y.top + 0.5) continue;
    const { x0: X0, x1: X1, hourPx, yBot } = cell;
    // Deckel über den höchsten Modellwert der Zelle: die weiche Kante der Kuppe
    // streut nach oben (s. ANVIL_OVERSHOOT), diese Fusseln sollen nicht über
    // dem flachen Deckel stehen.
    const yTop = cell.yTop - ANVIL_OVERSHOOT;
    // Die Ambossunterseite folgt der Kuppe DIESER Zelle -- deshalb kommt `top`
    // aus dem Zellobjekt und wird nicht neu gezogen.
    const shaft = cell;
    if (!(X1 > X0) || !(yBot > yTop)) continue;

    const depth = clamp(ANVIL_DEPTH_FRAC * (yBot - yTop), ANVIL_DEPTH_MIN, ANVIL_DEPTH_MAX);
    // An der Zellbreite gedeckelt, sonst bekäme ein schmaler Turm einen Deckel
    // dreimal so breit wie er selbst (Pilz statt Amboss).
    const flare = clamp(Math.min(ANVIL_FLARE_CELLS * hourPx, 0.75 * (X1 - X0)),
      ANVIL_FLARE_MIN, ANVIL_FLARE_MAX);
    // Unterseite: über dem Schaft volle Dicke, nach außen keilförmig auf die
    // Spitzendicke auslaufend (Exponent < 1 -> konkav, wie ein echter Amboss).
    // Über dem Schaft zusätzlich bis auf dessen Turmkante heruntergezogen,
    // sonst klaffte über jeder Einkerbung ein blauer Spalt.
    const bot = (cx) => {
      const t = cx < X0 ? (X0 - cx) / flare : cx > X1 ? (cx - X1) / flare : 0;
      const wedge = yTop + depth * (1 - (1 - ANVIL_TIP_FRAC) * Math.pow(clamp(t, 0, 1), 0.65));
      if (t > 0) return wedge;
      return Math.min(Math.max(wedge, shaft.top(cx)), yTop + ANVIL_MAX_DROP * depth);
    };

    paintRegion(ctx, cell.seed ^ 0x1f123bb5, ANVIL_TUNING, {
      x0: X0 - flare, x1: X1 + flare, hardTop: true, salt: [4, 5],
      top: () => yTop, bot,
    });
  }
  ctx.restore();
}

/**
 * Oberkante EINER Zelle als Blumenkohlkuppe: zwei bis drei überlappende
 * Kuppeln (Ellipsenbögen), die Kante ist deren UNTERE EINHÜLLENDE (Minimum in
 * y). Bewusst nicht eine glatte Halbkugel -- die verrät sich sofort als
 * gezeichnete Form; die Einhüllende gibt runde Kuppen mit scharfen Kerben
 * dazwischen, genau die Kontur eines Quellturms.
 *
 * Alle Maße skalieren mit der halben ZELLBREITE, nicht mit der Schafttiefe.
 * Die Tiefe wäre hier die falsche Bezugsgröße: ein 12 km hoher Turm ist auf der
 * gestauchten Höhenachse mehrere hundert Pixel tief, eine daran gekoppelte
 * Kuppelamplitude liefe über einen 30 px breiten Turm zu einer Nadelspitze aus.
 * An der Breite gekoppelt bleibt die Kuppe rund, egal wie hoch der Turm ist.
 *
 * Wichtig: die Auslenkung geht nur nach UNTEN (kein Punkt liegt über `yT`, dem
 * gerechneten Oberrand). Ein Scheitel ÜBER dem Modellwert würde den flachen
 * Ambossdeckel durchstoßen, der genau darauf sitzt.
 */
function cellTopEdge(seed, yT, cx, hw) {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const n = 2 + Math.floor(rng() * 2);
  const domes = [];
  for (let d = 0; d < n; d++) {
    const u = n === 1 ? 0 : -1 + 2 * d / (n - 1);
    domes.push({
      cx: cx + u * hw * 0.55 + (rng() - 0.5) * hw * 0.2,
      // Halbe Kuppelbreite so, dass die äußerste Kuppel (Mitte bei 0.55*hw)
      // über die Zellflanke bei hw hinausreicht -- sonst bliebe dort ein
      // abgeschnittener Absatz statt einer Rundung.
      w: hw * (0.65 + 0.4 * rng()),
      a: hw * (0.55 + 0.45 * rng()),
      // Scheitel dürfen nur nach unten abweichen (s. Ambossdeckel oben).
      y: yT + hw * 0.3 * rng(),
    });
  }
  // Wo keine Kuppel greift (jenseits der Flanken), liegt die Kante auf
  // Schulterhöhe -- deutlich unter den Scheiteln, damit die Region dort ausläuft.
  const shoulder = yT + hw * 1.1;
  return (px) => {
    let best = shoulder;
    for (const d of domes) {
      const u = (px - d.cx) / d.w;
      if (u <= -1 || u >= 1) continue;
      const yq = d.y + d.a * (1 - Math.sqrt(1 - u * u));
      if (yq < best) best = yq;
    }
    return best;
  };
}

/**
 * Ellipsentextur in ein Gebiet zwischen zwei x-abhängigen Kanten füllen.
 *
 * `reg.hardTop`/`reg.hardBot` schalten die jeweilige Kante von "weich" auf
 * "hart": weiche Kanten gehen über die Abstandsrampe + Rauschen (sie fransen
 * aus, deshalb wird auch über die Kante hinaus gestreut), harte Kanten stehen
 * im CLIP-Pfad und schneiden die Ellipsen exakt auf der Geometrie ab. Der
 * Clip-Pfad folgt darum nur den harten Kanten; in den weichen Richtungen ist
 * er großzügig um die Fransenbreite aufgeweitet.
 */
function paintRegion(ctx, seed, T, reg) {
  const { x0, x1, top, bot, hardTop = false, hardBot = false, salt = [2, 3] } = reg;
  const rng = mulberry32(seed);
  const pad = T.fringePx + T.wMax / 2;
  const xL = x0 - pad, xR = x1 + pad;
  if (!(xR > xL)) return;

  // Kanten abtasten: sie sind nichtlinear (Türme, Ambosskeil), Bounding-Box
  // und Clip-Pfad brauchen sie also diskretisiert.
  const SAMPLES = 96;
  const xs = new Float64Array(SAMPLES + 1);
  const tops = new Float64Array(SAMPLES + 1), bots = new Float64Array(SAMPLES + 1);
  let yMin = Infinity, yMax = -Infinity;
  for (let s = 0; s <= SAMPLES; s++) {
    const cx = xL + (xR - xL) * s / SAMPLES;
    xs[s] = cx; tops[s] = top(cx); bots[s] = bot(cx);
    if (tops[s] < yMin) yMin = tops[s];
    if (bots[s] > yMax) yMax = bots[s];
  }
  // Jenseits einer harten Kante lohnt nur noch eine halbe Ellipse Streubreite
  // (weiter draußen liegende Mittelpunkte ragen ohnehin nicht mehr herein).
  const ry0 = yMin - (hardTop ? T.hMax / 2 : pad);
  const ry1 = yMax + (hardBot ? T.hMax / 2 : pad);
  if (!(ry1 > ry0)) return;

  ctx.save();
  ctx.beginPath();
  if (hardTop) {
    ctx.moveTo(xs[0], tops[0]);
    for (let s = 1; s <= SAMPLES; s++) ctx.lineTo(xs[s], tops[s]);
  } else { ctx.moveTo(xL, ry0); ctx.lineTo(xR, ry0); }
  if (hardBot) for (let s = SAMPLES; s >= 0; s--) ctx.lineTo(xs[s], bots[s]);
  else { ctx.lineTo(xR, ry1); ctx.lineTo(xL, ry1); }
  ctx.closePath();
  ctx.clip();

  // Einmal je Region (nicht je Ellipse) aus `T.fill` abgeleitet -- bleibt so
  // exakt synchron mit einer eingesetzten Tuner-JSON, s. Kopfkommentar zu
  // `shadeMix`.
  const fillBase = baseRGB(T.fill);

  const attempts = Math.round(T.density * 800 / TUNER_CANVAS_PX2 * (xR - xL) * (ry1 - ry0));
  for (let i = 0; i < attempts; i++) {
    const cx = xL + rng() * (xR - xL), cy = ry0 + rng() * (ry1 - ry0);
    // Vorzeichenbehafteter Abstand zu den WEICHEN Kanten (innen positiv), als
    // Rampe auf [0,1]: 0.5 exakt auf der Kante, s. Kommentar an
    // CB_TUNING.threshold. Harte Kanten bleiben außen vor -- dort soll die
    // Dichte bis zur Schnittlinie voll bleiben, gekappt wird per Clip.
    let d = Math.min(cx - x0, x1 - cx);
    if (!hardTop) d = Math.min(d, cy - top(cx));
    if (!hardBot) d = Math.min(d, bot(cx) - cy);
    const ramp = clamp(0.5 + d / (2 * T.fringePx), 0, 1);
    // Rauschen bewusst UNGEDÄMPFT addiert (anders als bei den Schichtwolken):
    // es soll die Kante verschieben -- Beulen nach außen, Kerben nach innen,
    // Reichweite +-noiseAmp * 2 * fringePx Pixel. Das Innere schützt nicht
    // eine Dämpfung, sondern die gain-Kopplung (s. CB_TUNING): selbst beim
    // ungünstigsten Rauschwert bleibt die Annahme dort bei 1. Fetzen im
    // Nichts kann es ebenfalls nicht geben, solange noiseAmp < threshold.
    const v = ramp + T.noiseAmp * regionNoise(seed, cx, cy, T.noiseScale, salt);
    if (v <= T.threshold) continue;
    if (rng() >= Math.min(1, (v - T.threshold) * T.gain)) continue;

    const ew = T.wMin + rng() * (T.wMax - T.wMin);
    const eh = T.hMin + rng() * (T.hMax - T.hMin);
    // Schattierung entlang derselben Kanten wie die Dichterampe: Schaft hell
    // an der Kuppe, dunkler zur harten Basislinie; Amboss hell am flachen
    // Deckel, dunkler zum Keil hin.
    ctx.fillStyle = shadeMix(fillBase, edgeShadeT(top(cx), bot(cx), cy));
    ctx.beginPath();
    ctx.ellipse(cx, cy, ew / 2, eh / 2, 0, 0, Math.PI * 2);
    ctx.fill();   // fill -> stroke je Ellipse, wie bei den Schichtwolken.
    ctx.stroke();
  }
  ctx.restore();
}

/** Aufeinanderfolgende Stunden mit `pred` zu Läufen `[i, j]` zusammenfassen. */
function runsOf(arr, pred) {
  const runs = [];
  for (let i = 0; i < arr.length; i++) {
    if (!pred(arr[i])) continue;
    let j = i;
    while (j + 1 < arr.length && pred(arr[j + 1])) j++;
    runs.push([i, j]);
    i = j;
  }
  return runs;
}

/** Stützwert `key` an der Stelle `cx`, linear; außerhalb konstant. */
function edgeAt(pts, key, cx) {
  if (cx <= pts[0].cx) return pts[0][key];
  for (let k = 1; k < pts.length; k++) {
    if (pts[k].cx >= cx) {
      const a = pts[k - 1], b = pts[k];
      return a[key] + (cx - a.cx) / (b.cx - a.cx) * (b[key] - a[key]);
    }
  }
  return pts[pts.length - 1][key];
}

function clipChart(ctx, x, y) {
  ctx.beginPath();
  ctx.rect(x.left, y.top, x.right - x.left, y.bot - y.top);
  ctx.clip();
}

function setSpotStyle(ctx, T) {
  ctx.fillStyle = T.fill;
  ctx.strokeStyle = `rgba(${T.gray},${T.gray},${T.gray},${T.grayAlpha})`;
  ctx.lineWidth = T.strokeWidth;
}

// Eigene Oktav-Salts je Region (Schaft 2/3, Amboss 4/5), damit die Rauschfelder
// desselben Seeds nicht miteinander korrelieren.
function regionNoise(seed, px, py, s, salt) {
  const a = valueNoise(seed, px * s, py * s, salt[0]);
  const b = valueNoise(seed, px * s * FBM_OCTAVE, py * s * FBM_OCTAVE, salt[1]);
  return (FBM_W1 * a + FBM_W2 * b - 0.5) * 2;
}

// --- Maske: cloudFrac bilinear im Pixelraum ----------------------------------

/**
 * `cloudFrac` auf ein pixelbezogenes Zwischengitter umtasten: Spalten sind die
 * Zeitschritte, Zeilen liegen äquidistant in PIXELN (nicht in Metern). Die
 * Höhenachse ist nichtlinear und die Modell-Level sind ungleich verteilt --
 * beides wird damit einmalig aufgelöst, danach ist `at()` reine Bilinear-
 * interpolation und billig genug für zehntausende Abfragen.
 */
function buildMask(grid, cloudFrac, x, y) {
  const { nk, times } = grid, nt = times.length;
  const rows = Math.max(2, Math.ceil((y.bot - y.top) / MASK_ROW_PX) + 1);
  const table = new Float32Array(nt * rows);
  for (let r = 0; r < rows; r++) {
    const z = y.inv(y.top + r * MASK_ROW_PX);
    for (let i = 0; i < nt; i++) table[i * rows + r] = fracInColumn(grid, cloudFrac, i, z, nk);
  }

  // Ober-/Unterkante der Bewölkung je Spalte (in Pixeln), einmalig aus
  // derselben Tabelle abgeleitet -- Grundlage für `shadeAt`. Eine Spalte ohne
  // Wolke bleibt auf Höhe `y.top` stehen (Spannweite 0); dort liefert
  // `edgeShadeT` t=0, was ohnehin egal ist, weil dort keine Ellipse gezeichnet
  // wird (dieselbe `threshold`-Schwelle gilt beim Zeichnen).
  const edgeTop = new Float32Array(nt), edgeBot = new Float32Array(nt);
  for (let i = 0; i < nt; i++) {
    let rTop = -1, rBot = -1;
    for (let r = 0; r < rows; r++) {
      if (table[i * rows + r] > TUNING.threshold) {
        if (rTop < 0) rTop = r;
        rBot = r;
      }
    }
    edgeTop[i] = y.top + (rTop < 0 ? 0 : rTop) * MASK_ROW_PX;
    edgeBot[i] = y.top + (rBot < 0 ? 0 : rBot) * MASK_ROW_PX;
  }

  const spanX = x.right - x.left;
  return {
    at(px, py) {
      const fi = clamp((px - x.left) / spanX * (nt - 1), 0, nt - 1);
      const fr = clamp((py - y.top) / MASK_ROW_PX, 0, rows - 1);
      const i0 = Math.floor(fi), r0 = Math.floor(fr);
      const i1 = Math.min(i0 + 1, nt - 1), r1 = Math.min(r0 + 1, rows - 1);
      const ft = fi - i0, fz = fr - r0;
      const a = table[i0 * rows + r0], b = table[i1 * rows + r0];
      const c = table[i0 * rows + r1], d = table[i1 * rows + r1];
      return (a + (b - a) * ft) * (1 - fz) + (c + (d - c) * ft) * fz;
    },
    shadeAt(px, py) {
      const i = Math.round(clamp((px - x.left) / spanX * (nt - 1), 0, nt - 1));
      return edgeShadeT(edgeTop[i], edgeBot[i], py);
    },
  };
}

/** cloudFrac einer Zeitspalte auf Höhe `z` (linear zwischen den Levels). */
function fracInColumn(grid, cloudFrac, i, z, nk) {
  const base = i * nk;
  if (z <= grid.z[base]) return cloudFrac[base];
  let k = 1;
  while (k < nk && grid.z[base + k] < z) k++;
  if (k >= nk) return 0; // oberhalb des obersten Levels: keine Wolke
  const z0 = grid.z[base + k - 1], z1 = grid.z[base + k];
  const f = z1 > z0 ? (z - z0) / (z1 - z0) : 0;
  return cloudFrac[base + k - 1] + f * (cloudFrac[base + k] - cloudFrac[base + k - 1]);
}

// --- Value-Noise --------------------------------------------------------------

// Bewusst im PIXELRAUM (nicht in Zeit/Höhe): die Franserei am Wolkenrand soll
// über den ganzen Chart gleich grob aussehen, unabhängig davon, wie stark die
// Höhenachse an dieser Stelle staucht.
function maskNoise(seed, px, py) {
  const s = TUNING.noiseScale;
  const a = valueNoise(seed, px * s, py * s, 0);
  const b = valueNoise(seed, px * s * FBM_OCTAVE, py * s * FBM_OCTAVE, 1);
  return (FBM_W1 * a + FBM_W2 * b - 0.5) * 2; // nullsymmetrisch, [-1,1]
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
