/**
 * Deterministischer Zufall für die GRAMET-Texturen (Wolkenschraffur,
 * Niederschlagsvorhang). Gemeinsam, damit beide Darstellungen dieselbe
 * Seed-Konvention teilen: Ort + Zeitreihenstart -> gleiches Muster bei jedem
 * Re-Render derselben Daten (`render.js` zeichnet bei jeder State-Änderung neu).
 *
 * Zwei Varianten, bewusst nebeneinander:
 *  - `mulberry32` als fortlaufender Strom -- kompakt, wenn die Zeichenreihenfolge
 *    ohnehin fest ist (Wolken: jede Zelle zieht der Reihe nach).
 *  - `hashRand` als ortsgebundener Hash -- gibt für dieselbe Koordinate immer
 *    denselben Wert, unabhängig davon, wie viele Symbole vorher gezeichnet
 *    wurden. Nötig, wo die Zahl der vorherigen Ziehungen vom View-State abhängt
 *    (Niederschlag: die Symbolzahl je Vorhang hängt an der Höhenachse, ein
 *    Strom würde beim Umschalten das ganze Muster durchwürfeln).
 */

/** FNV-1a über eine Zeichenkette -- erzeugt den Seed aus Ort/Zeit. */
export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Fortlaufender PRNG-Strom (mulberry32), Werte in [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ortsgebundener Zufallswert in [0,1) aus (seed, a, b, salt). `salt`
 * unterscheidet mehrere unabhängige Werte an derselben Koordinate
 * (x-Versatz, y-Versatz, Größe, Neigung...). Avalanche-Schritte wie bei
 * murmur3 finalize, damit benachbarte a/b/salt dekorrelieren.
 */
export function hashRand(seed, a, b, salt = 0) {
  let h = seed >>> 0;
  h = Math.imul(h ^ (a | 0), 0x27d4eb2d) >>> 0;
  h = Math.imul(h ^ (b | 0), 0x165667b1) >>> 0;
  h = Math.imul(h ^ (salt | 0), 0x85ebca6b) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Value-Noise in [0,1]: Zufallswerte auf einem Einheitsgitter, dazwischen mit
 * Smoothstep interpoliert -- also stetig und ohne sichtbare Gitterkanten, im
 * Gegensatz zu punktweisem Zufall. `x`/`y` sind Gittereinheiten (der Aufrufer
 * teilt die Pixel durch die gewünschte Wellenlänge), `octave` trennt mehrere
 * unabhängige Rauschfelder.
 */
export function valueNoise(seed, x, y, octave = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = smoothstep(x - x0), fy = smoothstep(y - y0);
  const v00 = hashRand(seed, x0, y0, octave), v10 = hashRand(seed, x0 + 1, y0, octave);
  const v01 = hashRand(seed, x0, y0 + 1, octave), v11 = hashRand(seed, x0 + 1, y0 + 1, octave);
  return (v00 + (v10 - v00) * fx) * (1 - fy) + (v01 + (v11 - v01) * fx) * fy;
}

function smoothstep(t) { return t * t * (3 - 2 * t); }
