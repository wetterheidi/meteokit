/**
 * Turbulenz-Diagnose — Turbulence-Flag-Index (TFI) = g(Ri) · s(|dV/dz|),
 * pro Zelle. Deckt bewusst NUR das Flugband oberhalb 10 m ab (dynamische +
 * thermische Instabilität aus Scherung/Stabilität, `grid.js` `derive()`
 * liefert `shear2`/`n2`/`ri` bereits pro Modellschicht) -- Bodenböigkeit ist
 * schon durch die Böen-Zeile (gonogo.js) und das Böen-Overlay abgedeckt,
 * beide bewusst nicht auf Flughöhe hochgerechnet (s. METHODIK.md "Böen").
 * Eine reine Böen-Neuverpackung als Turbulenz-Zeile wäre Doppelung; der
 * Mehrwert liegt genau oberhalb 10 m, wo es laut METHODIK.md keine Böen auf
 * Modell-Leveln gibt.
 *
 * g(Ri): 1 für Ri <= 0,25 (Miles-Howard-Schwelle, Kelvin-Helmholtz-Instabil-
 * ität), linear auf 0 bei Ri >= 1,0 (darüber gilt Turbulenz als zunehmend
 * unwahrscheinlich). Ri < 0 (dθ/dz < 0, Tagesthermik/labile Schichtung)
 * fällt automatisch in den "<= 0,25"-Zweig -- ein Index deckt damit
 * mechanische UND thermische Turbulenz ab, ohne zwei getrennte Diagnosen.
 *
 * s(|dV/dz|): Scher-Gate. Ri ist ein Verhältnis und wird numerisch instabil,
 * wenn die Scherung gegen 0 geht (dann ist meist auch dθ/dz klein, Ri
 * "springt") -- `grid.js` `derive()` fängt die reine Division bereits ab
 * (`ri = NaN` bei `shear2 <= 1e-8`), das ersetzt aber NICHT das physikalische
 * Gate hier: eine völlig ruhige, schwach stabile Schicht braucht trotzdem
 * eine explizite Ausblendung, sonst flaggt sie als Turbulenz. 0 unterhalb
 * ~0,02 s⁻¹ (≈ 2 m/s je 100 m), linear auf 1 ab ~0,05 s⁻¹ -- nur dynamisch
 * signifikante Schichten zählen. Das Gate wird VOR `g(Ri)` ausgewertet und
 * bei 0 sofort zurückgegeben: sonst würde `g(NaN) * 0 = NaN` statt 0
 * herauskommen, wenn `ri` wegen der Division-durch-~0-Absicherung NaN ist
 * (genau der Fall, den das Gate eigentlich abfangen soll).
 *
 * Schwellen (Ri-Fenster wie TFI-Kategorien) NICHT kalibriert -- Platzhalter
 * wie an anderer Stelle im Modul, s. METHODIK.md.
 *
 * Bekannte Grenzen (METHODIK.md 7.7): der TFI sieht keine feuchte/konvektive
 * Instabilität (nur trockenes theta -- Cb/TCU-Türme bleiben deshalb i. d. R.
 * ohne Kontur, das ist eine Diagnoselücke, kein "unauffällig").
 *
 * w(V): Windstärke-Gate (Ergänzung nach Praxis-Check, 2026-08-04 im Gespräch
 * aufgefallen -- s. IDEEN.md "Turbulenz als eigene Zeile"). `g(Ri)` und
 * `s(|dV/dz|)` sind beides reine Onset-Kriterien (sagen NUR, dass sich
 * Kelvin-Helmholtz-Wellen bilden KÖNNEN, nichts über die resultierende
 * Intensität) und sättigen beide schnell auf 1 -- ohne Korrektur wäre
 * "severe" schon bei knapp erfülltem Ri- UND Scher-Kriterium erreichbar,
 * unabhängig von der absoluten Windgeschwindigkeit (beobachtet: bodennahe
 * "severe"-Flächen bei durchweg <= 10 kt Wind, meteorologisch als reines
 * Scherungssignal plausibel, aber als Kategorie "stark" zu alarmierend). `w`
 * wirkt deshalb NICHT als weiterer multiplikativer Faktor auf den ganzen
 * Index (das würde auch "light"/"moderate" bei jedem Kalmenfall unter den
 * Tisch fallen lassen), sondern kappt nur den Anteil OBERHALB der
 * "moderate"-Schwelle: 0 unterhalb 5 m/s (≈ 10 kt), linear auf 1 ab 10 m/s
 * (≈ 19 kt). Bei Windstille bleibt "moderate" also weiterhin erreichbar,
 * "severe" braucht zusätzlich spürbaren Wind. Schwellen selbst ein erster
 * Ansatz, ausdrücklich zur Nachjustierung vorgesehen.
 */

const RI_CRIT = 0.25;   // Miles-Howard-Schwelle -- g(Ri) = 1 bis hierhin (inkl. Ri < 0)
const RI_MAX = 1.0;     // ab hier g(Ri) = 0

const SHEAR_GATE_LO = 0.02; // s^-1 -- s() = 0 unterhalb
const SHEAR_GATE_HI = 0.05; // s^-1 -- s() = 1 ab hier

const WIND_GATE_LO = 5;  // m/s (≈ 10 kt) -- w() = 0 unterhalb
const WIND_GATE_HI = 10; // m/s (≈ 19 kt) -- w() = 1 ab hier

// Gemeinsame Kategorie-Schwellen für alle Verbraucher (GRAMET, Go/No-Go).
// "light" ist ein weicherer Karten-Onset (analog Vereisung), kollabiert in
// `tfiStatus` in "green" -- Go/No-Go kennt keine Ampelfarbe für "Spur von
// Turbulenz".
const TFI_LIGHT = 0.15, TFI_MODERATE = 0.30, TFI_SEVERE = 0.60;

function sShear(shear2) {
  if (!Number.isFinite(shear2)) return 0;
  const shear = Math.sqrt(shear2);
  if (shear <= SHEAR_GATE_LO) return 0;
  if (shear >= SHEAR_GATE_HI) return 1;
  return (shear - SHEAR_GATE_LO) / (SHEAR_GATE_HI - SHEAR_GATE_LO);
}

function gRi(ri) {
  if (!Number.isFinite(ri)) return 0;
  if (ri <= RI_CRIT) return 1;
  if (ri >= RI_MAX) return 0;
  return (RI_MAX - ri) / (RI_MAX - RI_CRIT);
}

function wWind(windSpeed) {
  if (!Number.isFinite(windSpeed)) return 0;
  if (windSpeed <= WIND_GATE_LO) return 0;
  if (windSpeed >= WIND_GATE_HI) return 1;
  return (windSpeed - WIND_GATE_LO) / (WIND_GATE_HI - WIND_GATE_LO);
}

/**
 * Turbulence-Flag-Index (0..1) einer Schicht -- reine Funktion von Ri,
 * Scherquadrat (beide aus `grid.js` `derive()`) und mittlerer Windgeschwin-
 * digkeit der Schicht (m/s, komponentenweise aus u/v der beiden Rand-Level
 * gemittelt, s. Aufrufer), unabhängig von Grid/Zeitachse/Rendering.
 * Scher-Gate zuerst (s. Modulkopf) -- vermeidet `NaN * 0` bei der
 * Ri-Divisionsschutz-NaN. Windstärke-Gate NUR auf den Anteil oberhalb
 * `TFI_MODERATE` angewandt (s. Modulkopf) -- "moderate" bleibt bei
 * Windstille erreichbar, nur "severe" braucht zusätzlich spürbaren Wind.
 */
export function tfiAt(ri, shear2, windSpeed) {
  const s = sShear(shear2);
  if (s === 0) return 0;
  const raw = gRi(ri) * s;
  if (raw <= TFI_MODERATE) return raw;
  return TFI_MODERATE + (raw - TFI_MODERATE) * wWind(windSpeed);
}

/** TFI (0..1) -> Kategorie, gemeinsame Schwellen für alle Verbraucher. */
export function tfiCategory(tfi) {
  if (!Number.isFinite(tfi) || tfi < TFI_LIGHT) return "none";
  if (tfi < TFI_MODERATE) return "light";
  if (tfi < TFI_SEVERE) return "moderate";
  return "severe";
}

/**
 * Untere TFI-Schwelle der Kategorie von `tfi` -- 0 bei "none" (kein
 * Turbulenzband). Für Go/No-Go: die Höhengrenzen des Bands der stärksten
 * Turbulenz sind dort definiert, wo der TFI diese Schwelle kreuzt (analog
 * `ipiCategoryFloor` in icing.js), s. `turbulenceBandMaxAt` in app.js.
 */
export function tfiCategoryFloor(tfi) {
  const cat = tfiCategory(tfi);
  if (cat === "severe") return TFI_SEVERE;
  if (cat === "moderate") return TFI_MODERATE;
  if (cat === "light") return TFI_LIGHT;
  return 0;
}

/**
 * TFI (0..1) -> Go/No-Go-Ampel (green/yellow/red), s. gonogo.js. Dieselben
 * Schwellen wie `tfiCategory` (TFI_MODERATE/TFI_SEVERE) -- nur auf drei statt
 * vier Stufen zusammengefasst (none/light -> green), analog `ipiStatus` in
 * icing.js.
 */
export function tfiStatus(tfi) {
  if (!Number.isFinite(tfi) || tfi < TFI_MODERATE) return "green";
  if (tfi < TFI_SEVERE) return "yellow";
  return "red";
}

// Mittlere Windgeschwindigkeit einer Schicht (Level k/k+1): komponentenweise
// gemittelt, Betrag erst danach gebildet (wie `windfield.js`, METHODIK.md
// Abschnitt 1), nicht die beiden Level-Beträge gemittelt.
function layerWindSpeed(grid, i, k) {
  const ix0 = i * grid.nk + k, ix1 = ix0 + 1;
  return Math.hypot((grid.u[ix0] + grid.u[ix1]) / 2, (grid.v[ix0] + grid.v[ix1]) / 2);
}

/**
 * Pro Gitterzelle (nt*nk) die Hazard-Kategorie für die GRAMET-Kontur. Anders
 * als bei Vereisung (`icing.js` `computeGrid`, Punktgrößen T/cloudFrac
 * direkt an jedem Level aus der DMO bzw. daraus abgeleitet) sind Ri/Scherung
 * KEIN Modell-/API-Wert, sondern eine zentrale Differenz zwischen den u/v/T/p-
 * Werten zweier benachbarter Modell-Level (`grid.js` `derive()`) -- deshalb
 * nur AUF DEN SCHICHTEN zwischen zwei Leveln definiert (`nm = nk-1`
 * Zwischenwerte), nicht AN einem einzelnen Level. Ein Level erbt daher das
 * Maximum der beiden angrenzenden Schichten (unten/oben) -- Rand-Level (k=0
 * bzw. k=nk-1) haben nur eine angrenzende Schicht. `ri`/`shear2` kommen als
 * bereits abgeleitete Arrays herein (wie `cloudFrac` bei icing.js) statt hier
 * erneut berechnet zu werden; die Windgeschwindigkeit fürs Windstärke-Gate
 * (s. Modulkopf) wird dagegen direkt aus `grid.u`/`grid.v` gebildet, da sie
 * nur hier gebraucht wird.
 */
export function computeGrid(grid, ri, shear2, nm) {
  const { nk, times } = grid, nt = times.length;
  const out = new Array(nt * nk);
  for (let i = 0; i < nt; i++) {
    for (let k = 0; k < nk; k++) {
      let tfi = -1; // Sentinel: keine angrenzende Schicht -> "none"
      if (k > 0) {
        tfi = Math.max(tfi, tfiAt(ri[i * nm + k - 1], shear2[i * nm + k - 1], layerWindSpeed(grid, i, k - 1)));
      }
      if (k < nm) {
        tfi = Math.max(tfi, tfiAt(ri[i * nm + k], shear2[i * nm + k], layerWindSpeed(grid, i, k)));
      }
      out[i * nk + k] = tfiCategory(tfi < 0 ? NaN : tfi);
    }
  }
  return out;
}
