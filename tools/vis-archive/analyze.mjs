#!/usr/bin/env node
/**
 * Auswertung des Sichtweiten-Archivs: rechnet ICONs Sichtdiagnose
 * (`iconVisibility()` aus src/visibility.js) aus den archivierten
 * Eingangsgrößen nach und vergleicht mit der Original-Modellsicht.
 *
 *   node analyze.mjs --data DIR [--model icon_d2|icon_eu] [--variants 1,2,3]
 *                    [--worst N] [--csv OUT.csv] [--exclude-days D,D]
 *                    [--subgrid a,b[,c]] [--fit-subgrid]
 *                    [--precip] [--precip-timing now|next|mean|min] [--rain-factor F]
 *                    [--fit-precip]
 *
 * --vis-source    Herkunft der Referenz-Sicht: own (Default), public oder all.
 *                 Dateien ohne die Spalte zählen als own. `public` passt nach
 *                 Stand 2026-11-08 nicht sicher zu den Flächen (README).
 * --exclude-days  UTC-Tage, die nicht ausgewertet werden (Default: die
 *                 DWD-Störung 10.–12.10.2026, s. DEFAULT_EXCLUDE_DAYS).
 * --subgrid a,b[,c] Ersatz für subskaliges Wolkenwasser (s. iconVisibility).
 * --fit-subgrid   a, b per Gittersuche bestimmen (Variante 3, trockene
 *                 Stunden, Ziel: größter Anteil ≤ 10 % Abweichung).
 * --precip        Regen/Schnee aus Bodenraten (hydroFromSurfaceRates).
 *                 Zeitbezug der Rate: now = Stunde bis t, next = Stunde ab t,
 *                 mean = Mittel beider, min = kleinere der beiden (Default;
 *                 Regen zur Zeit t nur, wenn er vorher und nachher fällt).
 * --fit-precip    rainFactor und Zeitbezug per Gittersuche (Stunden mit
 *                 gitterskaligem Regen, ohne Schnee, Subgrid-Ersatz an).
 *
 * DIR ist eine lokale Kopie von /apps/vis-archive/data (s. README).
 *
 * Getrennt ausgewertet:
 *  - "trocken": in der Stunde und der folgenden kein Niederschlag. Dort
 *    fehlen nur qr/qs/qg nicht, die Nachrechnung muss nahezu exakt sein.
 *  - "Niederschlag": alle übrigen Stunden. Hier rechnen wir (noch) ohne
 *    Regen/Schnee/Graupel, die Abweichung zeigt deren Anteil.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { iconVisibility, hydroFromSurfaceRates, SUBGRID_FIT } from "../../src/visibility.js";

// Tage mit unvollständigen DWD-Läufen: Modellflächen und Sichtfeld passen
// dort nicht zusammen (DWD-Störung 10.–12.10.2026). Mit --exclude-days ""
// lassen sie sich wieder einbeziehen.
const DEFAULT_EXCLUDE_DAYS = ["2026-10-10", "2026-10-11", "2026-10-12"];

function parseArgs(argv) {
  const a = { data: null, model: "icon_d2", variants: [1, 2, 3], worst: 10, csv: null,
    excludeDays: DEFAULT_EXCLUDE_DAYS, subgrid: null, fitSubgrid: false,
    precip: false, precipTiming: "min", rainFactor: undefined, fitPrecip: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--data") a.data = argv[++i];
    else if (k === "--model") a.model = argv[++i];
    else if (k === "--variants") a.variants = argv[++i].split(",").map(Number);
    else if (k === "--worst") a.worst = Number(argv[++i]);
    else if (k === "--csv") a.csv = argv[++i];
    else if (k === "--vis-source") a.visSource = argv[++i];
    else if (k === "--exclude-days") a.excludeDays = argv[++i].split(",").filter(Boolean);
    else if (k === "--subgrid") { const [x, y, z] = argv[++i].split(",").map(Number); a.subgrid = { a: x, b: y, ...(Number.isFinite(z) ? { c: z } : {}) }; }
    else if (k === "--fit-subgrid") a.fitSubgrid = true;
    else if (k === "--precip") a.precip = true;
    else if (k === "--precip-timing") a.precipTiming = argv[++i];
    else if (k === "--rain-factor") a.rainFactor = Number(argv[++i]);
    else if (k === "--fit-precip") a.fitPrecip = true;
    else throw new Error(`Unbekanntes Argument: ${k}`);
  }
  if (!a.data) throw new Error("--data DIR fehlt");
  return a;
}

async function readRows(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".csv")).sort();
  const rows = [];
  for (const f of files) {
    const [head, ...lines] = (await readFile(join(dir, f), "utf8")).trim().split("\n");
    const cols = head.split(",");
    for (const l of lines) {
      const vals = l.split(",");
      const r = {};
      cols.forEach((c, i) => {
        r[c] = c === "station" || c === "time" || c === "vis_source" ? vals[i] : vals[i] === "" ? NaN : Number(vals[i]);
      });
      rows.push(r);
    }
  }
  return rows;
}

function nLevels(row) {
  let n = 0;
  while (`temperature_k${n}` in row) n++;
  return n;
}

function columnFromRow(r, nl) {
  const levels = [];
  for (let k = 0; k < nl; k++) {
    levels.push({
      z: r[`height_agl_k${k}`],
      p: r[`pressure_k${k}`] * 100,
      T: r[`temperature_k${k}`] + 273.15,
      qv: r[`specific_humidity_k${k}`] / 1000,
      qc: r[`cloud_water_k${k}`] / 1000,
      qi: r[`cloud_ice_k${k}`] / 1000,
      u: r[`wind_u_component_k${k}`] / 3.6,
      v: r[`wind_v_component_k${k}`] / 3.6,
      clc: r[`cloud_cover_k${k}`] / 100,
    });
  }
  return { levels, time: Date.parse(`${r.time}:00Z`), lat: r.grid_lat, lon: r.grid_lon };
}

// Bodenraten [mm/h] für hydroFromSurfaceRates: nur gitterskalig (`rain` =
// rain_gsp, `snowfall` = snow_gsp · 0,7 cm, s. docs/SICHTWEITE.md). Die
// Werte sind Summen der vorangehenden Stunde; ICON nutzt Momentanwerte zur
// Zeit t, daher wahlweise die Stunde davor, danach oder das Mittel.
function ratesFor(r, nx, timing) {
  const at = (x) => ({ rain: x?.rain ?? NaN, snow: (x?.snowfall ?? NaN) / 0.7 });
  const a = at(r), b = at(nx);
  const pick = (k) => {
    if (timing === "now") return a[k];
    if (timing === "next") return b[k];
    if (!Number.isFinite(b[k])) return a[k];
    return timing === "min" ? Math.min(a[k], b[k]) : (a[k] + b[k]) / 2;
  };
  return { rain: pick("rain"), snow: pick("snow") };
}

const isWet = (r) => !(r.precipitation === 0 && r.rain === 0 && r.showers === 0 && r.snowfall === 0);

const VIS_CLASSES = [
  ["< 1 km", 0, 1000], ["1–5 km", 1000, 5000], ["5–10 km", 5000, 10000],
  ["10–30 km", 10000, 30000], ["≥ 30 km", 30000, Infinity],
];

function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stats(items) {
  const n = items.length;
  if (!n) return "   –";
  const err = items.map((x) => Math.abs(x.calc / x.icon - 1));
  const within = (t) => ((100 * err.filter((e) => e <= t).length) / n).toFixed(1).padStart(5);
  const mlog = median(items.map((x) => Math.abs(Math.log(x.calc / x.icon))));
  return `n=${String(n).padStart(6)}  ≤2 %:${within(0.02)} %  ≤10 %:${within(0.1)} %  ` +
    `≤30 %:${within(0.3)} %  Median |ln|=${mlog.toFixed(3)}`;
}

/** Gittersuche für a, b des Subgrid-Wolkenwassers (Variante 3, trocken). */
function fitSubgrid(rows, nl, nextOf) {
  const cols = rows
    .filter((r) => !isWet(r) && !(nextOf(r) ? isWet(nextOf(r)) : true))
    .map((r) => ({ col: columnFromRow(r, nl), icon: r.visibility }));
  const score = (sg) => {
    let ok = 0, ok15 = 0, n15 = 0;
    for (const { col, icon } of cols) {
      const e = Math.abs(iconVisibility(col, { variant: 3, subgrid: sg }).vis / icon - 1);
      if (e <= 0.1) ok++;
      if (icon >= 1000 && icon < 5000) { n15++; if (e <= 0.1) ok15++; }
    }
    return { all: ok / cols.length, k15: ok15 / n15 };
  };
  const base = score(null);
  console.log(`Ohne Subgrid: ≤10 % ${(100 * base.all).toFixed(1)} %, 1–5 km ${(100 * base.k15).toFixed(1)} % (n=${cols.length})`);
  let best = null;
  for (let ia = 0; ia <= 16; ia++) {
    const a = 1e-3 * 10 ** (ia / 8); // 1e-3 … 1e-1
    for (let b = 0.5; b <= 3.001; b += 0.25) {
      const s = score({ a, b });
      if (!best || s.all > best.s.all) best = { a, b, s };
    }
  }
  console.log(`Bestes Gitter: a=${best.a.toExponential(2)} b=${best.b.toFixed(2)}: ` +
    `≤10 % ${(100 * best.s.all).toFixed(1)} %, 1–5 km ${(100 * best.s.k15).toFixed(1)} %`);
}

/** Gittersuche für rainFactor und Zeitbezug (Variante 3, Regenstunden). */
function fitPrecip(rows, nl, nextOf) {
  const sel = rows.filter((r) => {
    const nx = nextOf(r);
    return nx && (r.rain > 0 || nx.rain > 0) && r.snowfall === 0 && nx.snowfall === 0;
  }).map((r) => ({ r, nx: nextOf(r), col: columnFromRow(r, nl), icon: r.visibility }));
  const score = (timing, rainFactor) => {
    let ok = 0, ok30 = 0;
    for (const x of sel) {
      if (timing) x.col.hydro = hydroFromSurfaceRates(ratesFor(x.r, x.nx, timing), { rainFactor });
      else delete x.col.hydro;
      const e = Math.abs(iconVisibility(x.col, { variant: 3, subgrid: SUBGRID_FIT }).vis / x.icon - 1);
      if (e <= 0.1) ok++;
      if (e <= 0.3) ok30++;
    }
    return { p10: ok / sel.length, p30: ok30 / sel.length };
  };
  const fmt = (s) => `≤10 % ${(100 * s.p10).toFixed(1)} %, ≤30 % ${(100 * s.p30).toFixed(1)} %`;
  console.log(`Regenstunden: n=${sel.length}; ohne Niederschlagsanteil: ${fmt(score(null))}`);
  let best = null;
  for (const timing of ["now", "next", "mean", "min"]) {
    for (let i = -8; i <= 8; i++) {
      const f = 2 ** (i / 4); // 0,25 … 4
      const s = score(timing, f);
      if (!best || s.p10 > best.s.p10) best = { timing, f, s };
    }
    const s1 = score(timing, 1);
    console.log(`  ${timing.padEnd(4)} rainFactor 1: ${fmt(s1)}`);
  }
  console.log(`Bestes Gitter: ${best.timing}, rainFactor ${best.f.toFixed(2)}: ${fmt(best.s)}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const rows = (await readRows(join(args.data, args.model)))
    .filter((r) => Number.isFinite(r.visibility) && Number.isFinite(r.temperature_k0))
    .filter((r) => !args.excludeDays.includes(r.time.slice(0, 10)))
    .filter((r) => args.visSource === "all" || (r.vis_source || "own") === (args.visSource ?? "own"));
  if (!rows.length) throw new Error("keine Zeilen mit Sicht und Modellflächen");
  const nl = nLevels(rows[0]);

  // Niederschlag in der Folgestunde (Stundensumme endet zur Folgezeit)
  const byKey = new Map(rows.map((r) => [`${r.station}|${r.time}`, r]));
  const nextOf = (r) => {
    const t = new Date(Date.parse(`${r.time}:00Z`) + 3600e3).toISOString().slice(0, 16);
    return byKey.get(`${r.station}|${t}`);
  };

  if (args.fitSubgrid) return fitSubgrid(rows, nl, nextOf);
  if (args.fitPrecip) return fitPrecip(rows, nl, nextOf);

  const results = {}; // variant -> [{...}]
  for (const v of args.variants) results[v] = [];
  let skipped = 0;
  for (const r of rows) {
    const nx = nextOf(r);
    const wet = isWet(r) || (nx ? isWet(nx) : true);
    const col = columnFromRow(r, nl);
    if (args.precip) {
      col.hydro = hydroFromSurfaceRates(ratesFor(r, nx, args.precipTiming),
        args.rainFactor != null ? { rainFactor: args.rainFactor } : {});
    }
    // Alle Varianten oder keine, damit die Ergebnislisten zeilengleich bleiben
    let outs;
    try {
      outs = args.variants.map((v) => iconVisibility(col, { variant: v, subgrid: args.subgrid }));
    } catch {
      skipped++;
      continue;
    }
    args.variants.forEach((v, j) => results[v].push({
      station: r.station, time: r.time, wet, icon: r.visibility, calc: outs[j].vis, out: outs[j],
    }));
  }

  console.log(`Modell ${args.model}: ${rows.length} Stunden, ${nl} Flächen, ` +
    `${rows[0].time.slice(0, 10)} bis ${rows.at(-1).time.slice(0, 10)}` +
    (skipped ? `, ${skipped} Rechnungen übersprungen` : ""));
  for (const v of args.variants) {
    const all = results[v];
    const dry = all.filter((x) => !x.wet);
    const wet = all.filter((x) => x.wet);
    console.log(`\nVariante ${v}`);
    console.log(`  trocken       ${stats(dry)}`);
    console.log(`  Niederschlag  ${stats(wet)}`);
    for (const [label, lo, hi] of VIS_CLASSES) {
      console.log(`  trocken ${label.padEnd(9)} ${stats(dry.filter((x) => x.icon >= lo && x.icon < hi))}`);
    }
    for (const lim of ["rh", "hydro"]) {
      console.log(`  trocken, begrenzt durch ${lim.padEnd(5)} ${stats(dry.filter((x) => x.out.limitedBy === lim))}`);
    }
  }

  // Größte Abweichungen der besten Variante (trocken)
  const best = args.variants
    .map((v) => ({ v, m: median(results[v].filter((x) => !x.wet).map((x) => Math.abs(Math.log(x.calc / x.icon)))) }))
    .sort((a, b) => a.m - b.m)[0].v;
  const worst = results[best].filter((x) => !x.wet)
    .sort((a, b) => Math.abs(Math.log(b.calc / b.icon)) - Math.abs(Math.log(a.calc / a.icon)))
    .slice(0, args.worst);
  console.log(`\nGrößte Abweichungen trocken, Variante ${best}:`);
  for (const x of worst) {
    const o = x.out;
    console.log(`  ${x.station.padEnd(16)} ${x.time}  ICON ${String(x.icon).padStart(6)}  ` +
      `calc ${String(Math.round(x.calc)).padStart(6)}  visRh ${Math.round(o.visRh)}  ` +
      `visHydro ${Math.round(o.visHydro)}  RH ${o.rhmax.toFixed(1)}  inv ${o.invfac.toFixed(2)}  ` +
      `shear ${o.shearFac.toFixed(2)}  βc ${o.beta.c.toFixed(2)} βi ${o.beta.i.toFixed(2)}`);
  }

  if (args.csv) {
    const head = ["station", "time", "wet", "icon", ...args.variants.flatMap((v) => [`calc_v${v}`, `limit_v${v}`])];
    const lines = results[args.variants[0]].map((x, i) => [x.station, x.time, x.wet ? 1 : 0, x.icon,
      ...args.variants.flatMap((v) => [Math.round(results[v][i].calc), results[v][i].out.limitedBy])].join(","));
    await writeFile(args.csv, [head.join(","), ...lines].join("\n") + "\n");
    console.log(`\nCSV: ${args.csv}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
