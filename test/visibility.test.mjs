// Tests für src/visibility.js (node --test). Hintergrund: docs/SICHTWEITE.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  iconVisibility, hydroFromSurfaceRates, esatWater, rhIcon,
  visibilityRequestVars, columnFromHourly, visibilitySeries, VIS_N_LEVELS,
} from "../src/visibility.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/vis-brocken-d2.json", import.meta.url)));
const near = (a, b, rel, msg) => assert.ok(Math.abs(a / b - 1) <= rel, `${msg}: ${a} vs ${b}`);

// Einfache Säule: 13 Flächen 10…800 m, isotherm, ohne Wolken, ohne Wind.
function simpleColumn({ T = 283.15, rh = 50, u = 0, qc = 0, clc = 0 } = {}) {
  const levels = [];
  for (let k = 0; k < 13; k++) {
    const z = 10 + k * 65;
    const p = 100000 * Math.exp(-z / 8000);
    const e = (rh / 100) * esatWater(T);
    const qv = (0.622 * e) / (p - 0.378 * e);
    levels.push({ z, p, T, qv, qc: k < 3 ? qc : 0, qi: 0, u: k === 2 ? u : 0, v: 0, clc: k < 3 ? clc : 0 });
  }
  return { levels, cosZenith: 1 };
}

test("RH wie ICON aus p, qv, T", () => {
  const c = simpleColumn({ rh: 80 });
  near(rhIcon(c.levels[0].p, c.levels[0].qv, c.levels[0].T), 80, 0.01, "RH");
});

test("Feuchteterm Variante 3: Stützstellen des Polynoms", () => {
  // Kommentar im ICON-Code: 90 km bei RH 0, 40 km bei 0,6, 20 km bei 0,9, 2 km bei 1
  for (const [rh, km] of [[60, 40], [90, 20], [100, 2]]) {
    const r = iconVisibility(simpleColumn({ rh }));
    near(r.visRh, km * 1000, 0.03, `RH ${rh}`);
  }
});

test("Scherung über 6 m/s hebt den Feuchteterm auf 10 km", () => {
  const r = iconVisibility(simpleColumn({ rh: 100, u: 6 }));
  near(r.visRh, 10000, 1e-9, "visRh");
});

test("Koschmieder 2 % mit Wolkenwasser (Tag)", () => {
  const c = simpleColumn({ rh: 100, qc: 0.2e-3 });
  const r = iconVisibility(c);
  const rho = c.levels[0].p / (287.04 * c.levels[0].T * (1 + (461.51 / 287.04 - 1) * c.levels[0].qv - 0.2e-3));
  const C = 0.2e-3 * rho * 1000;
  near(r.visHydro, (-Math.log(0.02) / (144.7 * C ** 0.88)) * 1000, 1e-6, "visHydro");
  assert.equal(r.limitedBy, "hydro");
});

test("Nachtfaktor Variante 3 begrenzt auf 1,25…2,25", () => {
  const day = iconVisibility({ ...simpleColumn({ rh: 100, qc: 0.2e-3 }), cosZenith: 1 });
  const night = iconVisibility({ ...simpleColumn({ rh: 100, qc: 0.2e-3 }), cosZenith: -1 });
  const f = night.visHydro / day.visHydro;
  assert.ok(f >= 1.25 && f <= 2.25, `Faktor ${f}`);
});

test("Marshall-Palmer: 1 mm/h Regen ≈ 0,089 g/m³", () => {
  near(hydroFromSurfaceRates({ rain: 1 }).Cr, 0.089, 1e-9, "Cr");
  assert.equal(hydroFromSurfaceRates({ rain: -1 }).Cr, 0);
});

function levelsAt(col, i) {
  return col.t.map((_, k) => ({
    z: col.h[k][i], p: col.p[k][i] * 100, T: col.t[k][i] + 273.15, qv: col.q[k][i],
    qc: col.qw[k][i], qi: col.qi[k][i], u: col.u[k][i], v: col.v[k][i], clc: col.clc[k][i] / 100,
  }));
}

test("Brocken 07.11.2026, 12 und 18 UTC: exakte ICON-Nachrechnung ohne Ersatzansätze", () => {
  // Gitterskaliges Wolkenwasser auf k2 bestimmt die Sicht; ohne Subgrid- und
  // Niederschlagsersatz muss die Routine ICON exakt treffen (bis auf die
  // 20-m-Speicherauflösung von Open-Meteo).
  const col = columnFromHourly(fx.hourly, fx.nLevels);
  for (const i of [1, 4]) {
    const r = iconVisibility({ levels: levelsAt(col, i), time: Date.parse(`${fx.hourly.time[i]}Z`), lat: fx.lat, lon: fx.lon });
    near(r.vis, fx.hourly.visibility[i], 0.02, fx.hourly.time[i]);
    assert.equal(r.limitedBy, "hydro");
  }
});

test("Brocken 07.11.2026: visibilitySeries im Rahmen der Kalibrierung", () => {
  // Mit Subgrid-Ersatz (empirisch, s. docs/SICHTWEITE.md 1.5/1.7) sind
  // Abweichungen bis ~20 % normal.
  const col = columnFromHourly(fx.hourly, fx.nLevels);
  const s = visibilitySeries(col, fx.hourly, { lat: fx.lat, lon: fx.lon });
  fx.hourly.time.forEach((t, i) => near(s.vis[i], fx.hourly.visibility[i], 0.2, t));
});

test("visibilityRequestVars / columnFromHourly passen zusammen", () => {
  const vars = visibilityRequestVars(fx.nLevels);
  assert.equal(vars.length, VIS_N_LEVELS * 9);
  for (const v of vars) assert.ok(v in fx.hourly, v);
  const col = columnFromHourly(fx.hourly, fx.nLevels);
  assert.equal(col.t.length, VIS_N_LEVELS);
  near(col.u[0][0], fx.hourly[`wind_u_component_level${fx.nLevels}`][0] / 3.6 || 1, 1e-9, "u km/h→m/s");
});

test("fehlende Eingänge ergeben NaN statt eines Fehlers", () => {
  const hourly = structuredClone(fx.hourly);
  hourly[`temperature_level${fx.nLevels}`][0] = null;
  const s = visibilitySeries(columnFromHourly(hourly, fx.nLevels), {}, { lat: fx.lat, lon: fx.lon });
  assert.ok(Number.isNaN(s.vis[0]));
  assert.ok(Number.isFinite(s.vis[1]));
});
