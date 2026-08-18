/**
 * Kompakte Astronomie für Sonne/Mond ohne Abhängigkeiten (nach Paul Schlyter,
 * "Computing planetary positions"). Genauigkeit für Auf-/Untergang ~1–2 min,
 * für die Mondphase ~1 %. Reicht für ein Meteogramm.
 *
 * Öffentlich: moonRiseSetEvents(), moonPhase(), sunRiseSet() (v. a. zur Prüfung).
 */

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const sin = (x) => Math.sin(x * D2R);
const cos = (x) => Math.cos(x * D2R);
const asin = (x) => Math.asin(Math.max(-1, Math.min(1, x))) * R2D;
const atan2 = (y, x) => Math.atan2(y, x) * R2D;
const rev = (x) => x - Math.floor(x / 360) * 360;

// Schlyter-Tageszahl d: Epoche 1999-12-31 00:00 UT.
function dayNumber(ms) {
  return ms / 86400000 + 2440587.5 - 2451543.5;
}

// Sonne: mittlere Länge Ls (für Sternzeit) und Äquatorialkoordinaten.
function sun(d) {
  const w = 282.9404 + 4.70935e-5 * d;
  const M = rev(356.0470 + 0.9856002585 * d);
  const e = 0.016709 - 1.151e-9 * d;
  const E = M + e * R2D * sin(M) * (1 + e * cos(M));
  const xv = cos(E) - e, yv = Math.sqrt(1 - e * e) * sin(E);
  const v = atan2(yv, xv), r = Math.sqrt(xv * xv + yv * yv);
  const lon = rev(v + w);
  const ecl = 23.4393 - 3.563e-7 * d;
  const xs = r * cos(lon), ys = r * sin(lon);
  const xe = xs, ye = ys * cos(ecl), ze = ys * sin(ecl);
  return { RA: rev(atan2(ye, xe)), Dec: atan2(ze, Math.sqrt(xe * xe + ye * ye)), Ls: rev(w + M), lon, M };
}

// Mond: Äquatorialkoordinaten (mit den wichtigsten Störungen) und ekliptikale
// Länge für die Phase.
function moon(d) {
  const s = sun(d);
  const N = rev(125.1228 - 0.0529538083 * d);
  const i = 5.1454;
  const w = rev(318.0634 + 0.1643573223 * d);
  const a = 60.2666, e = 0.054900;
  const M = rev(115.3654 + 13.0649929509 * d);
  let E = M + e * R2D * sin(M) * (1 + e * cos(M));
  for (let k = 0; k < 2; k++) E = E - (E - e * R2D * sin(E) - M) / (1 - e * cos(E));
  const xv = a * (cos(E) - e), yv = a * Math.sqrt(1 - e * e) * sin(E);
  const v = atan2(yv, xv), r = Math.sqrt(xv * xv + yv * yv);
  const xh = r * (cos(N) * cos(v + w) - sin(N) * sin(v + w) * cos(i));
  const yh = r * (sin(N) * cos(v + w) + cos(N) * sin(v + w) * cos(i));
  const zh = r * (sin(v + w) * sin(i));
  let lon = atan2(yh, xh), lat = atan2(zh, Math.sqrt(xh * xh + yh * yh));

  // Störterme (Schlyter): Evektion, Variation, jährliche Gleichung u. a.
  const Ms = s.M, Mm = M, Ls = s.Ls, Lm = rev(N + w + M);
  const Dp = rev(Lm - Ls), F = rev(Lm - N);
  lon += -1.274 * sin(Mm - 2 * Dp) + 0.658 * sin(2 * Dp) - 0.186 * sin(Ms)
       - 0.059 * sin(2 * Mm - 2 * Dp) - 0.057 * sin(Mm - 2 * Dp + Ms) + 0.053 * sin(Mm + 2 * Dp)
       + 0.046 * sin(2 * Dp - Ms) + 0.041 * sin(Mm - Ms) - 0.035 * sin(Dp)
       - 0.031 * sin(Mm + Ms) - 0.015 * sin(2 * F - 2 * Dp) + 0.011 * sin(Mm - 4 * Dp);
  lat += -0.173 * sin(F - 2 * Dp) - 0.055 * sin(Mm - F - 2 * Dp) - 0.046 * sin(Mm + F - 2 * Dp)
       + 0.033 * sin(F + 2 * Dp) + 0.017 * sin(2 * Mm + F);

  const ecl = 23.4393 - 3.563e-7 * d;
  const xe = cos(lat) * cos(lon);
  const ye = cos(lat) * sin(lon) * cos(ecl) - sin(lat) * sin(ecl);
  const ze = cos(lat) * sin(lon) * sin(ecl) + sin(lat) * cos(ecl);
  return { RA: rev(atan2(ye, xe)), Dec: asin(ze), lon, sunLon: s.lon };
}

// Topozentrische Höhe (grob geozentrisch) eines Körpers in Grad.
function altitude(ms, lat, lon, bodyFn) {
  const d = dayNumber(ms);
  const b = bodyFn(d);
  const Ls = sun(d).Ls;
  const UT = ((ms / 3600000) % 24 + 24) % 24;
  const GMST0 = rev(Ls + 180) / 15;           // Stunden
  const LST = GMST0 + UT + lon / 15;           // Stunden, östl. Länge positiv
  const HA = rev(LST * 15 - b.RA);
  return asin(sin(lat) * sin(b.Dec) + cos(lat) * cos(b.Dec) * cos(HA));
}

// Auf-/Untergänge im Fenster durch Nulldurchgänge der Höhe (10-min-Raster,
// linear interpoliert). h0 = Höhe des Zentrums bei Auf-/Untergang.
function riseSet(bodyFn, startMs, endMs, lat, lon, h0) {
  const step = 600000;
  const ev = [];
  let prev = altitude(startMs, lat, lon, bodyFn) - h0, pt = startMs;
  for (let t = startMs + step; t <= endMs; t += step) {
    const cur = altitude(t, lat, lon, bodyFn) - h0;
    if (prev < 0 && cur >= 0) ev.push({ t: interp(pt, prev, t, cur), type: "rise" });
    else if (prev >= 0 && cur < 0) ev.push({ t: interp(pt, prev, t, cur), type: "set" });
    prev = cur; pt = t;
  }
  return ev;
}
function interp(t0, v0, t1, v1) {
  return Math.round(t0 + (t1 - t0) * (-v0) / (v1 - v0));
}

// Für den Mond: geozentrische Zentrumshöhe bei Auf-/Untergang ≈ +0.125°
// (Halbmesser − Refraktion + Parallaxe). Sonne: −0.833° (oberer Rand).
const H0_MOON = 0.125, H0_SUN = -0.833;

export function moonRiseSetEvents(startMs, endMs, lat, lon) {
  return riseSet(moon, startMs, endMs, lat, lon, H0_MOON);
}

export function sunRiseSet(startMs, endMs, lat, lon) {
  return riseSet(sun, startMs, endMs, lat, lon, H0_SUN);
}

/** Sonnenhöhe (geozentrisch, Grad) zu einem Zeitpunkt — Grundlage für den
 *  kontinuierlichen Tag/Nacht-Verlauf im GRAMET-Meteogramm (statt binärer
 *  Auf-/Untergangs-Intervalle wie im normalen Meteogramm). */
export function sunAltitude(ms, lat, lon) {
  return altitude(ms, lat, lon, sun);
}

const PHASE_NAMES = [
  "Neumond", "zunehmende Sichel", "erstes Viertel", "zunehmender Mond",
  "Vollmond", "abnehmender Mond", "letztes Viertel", "abnehmende Sichel",
];

export function moonPhase(ms) {
  const m = moon(dayNumber(ms));
  const age = rev(m.lon - m.sunLon);            // 0 Neu, 180 Voll
  const illum = (1 - cos(age)) / 2;
  return {
    illum, waxing: age < 180, ageDeg: age,
    name: PHASE_NAMES[Math.round(age / 45) % 8],
  };
}
