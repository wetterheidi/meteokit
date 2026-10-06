# meteokit

Wiederverwendbare Wetter-Webkomponenten und -Kernmodule für meine Anwendungen
(droneforecast, trajectories, …). Reines ES-Modul-Vanilla-JS: **kein Build-Schritt,
keine externen Abhängigkeiten.** Die einbettenden Apps bündeln mit Vite.

Herkunft: herausgelöst aus `droneforecast` (Commit `14e1cf9`, August 2026), wo GRAMET
ursprünglich entstanden ist.

## Einbinden

Die Bibliothek wird **nicht** über npm veröffentlicht, sondern als lokaler Pfad
eingebunden. Beide Repos müssen dafür nebeneinander liegen:

```
~/Documents/Git/
  meteokit/
  droneforecast/
  trajectories/
```

In der App:

```jsonc
// package.json
"dependencies": { "meteokit": "file:../meteokit" }
```

```js
// vite.config.js
import { fileURLToPath, URL } from "node:url";
const meteokit = fileURLToPath(new URL("../meteokit", import.meta.url));

export default defineConfig({
  // Vite prebundelt node_modules mit esbuild – das kennt Vite-eigene Import-
  // Suffixe wie `?inline` (gramet-panel.js) nicht. Als Quellpaket ausschließen.
  optimizeDeps: { exclude: ["meteokit"] },
  // Der `file:`-Symlink zeigt aus dem Projekt-Root heraus; ohne diese Freigabe
  // verweigert der Dev-Server das Ausliefern.
  server: { fs: { allow: [".", meteokit] } },
});
```

Danach `npm install` bzw. `bun install` — das legt einen **Symlink**, keine Kopie.
Änderungen an meteokit sind also sofort in allen Apps sichtbar; kein Publish,
kein Re-Install im Alltag.

## Öffentliche Oberfläche

Verbindlich ist die `exports`-Map in `package.json`. Was dort nicht steht, ist
intern und darf sich jederzeit ändern — auch wenn die Datei im Repo sichtbar ist.

| Import | Inhalt |
|---|---|
| `meteokit/components/gramet-panel` | Web Component `<gramet-panel>` (Seiteneffekt: registriert sich selbst) |
| `meteokit/gramet` | `fetchGridForPath`, `retimeGridForPath`, `posOfPath`, `gridFromColumn`, `gridFromWaypoints`, `sampleAt`, `derive`, `idx`, `fetchGrid` |
| `meteokit/gramet/hazards` | `ipiAt`/`tfiAt` + Kategorisierung (Icing, Turbulenz) |
| `meteokit/gramet/render` | `renderGramet`, `exportPng` — Low-Level-Zeichnen auf ein eigenes Canvas. Nur für Sonderfälle (z. B. Debug-Seiten); der empfohlene Weg ist `<gramet-panel>`. |
| `meteokit/config` | `configure`, `getModel`, `MODELS`, `API_BASE`, `SURFACE_*` |
| `meteokit/modelpick` | `pickModel`, `candidateModels` — bestes Modell am Punkt (feinstes zuerst, Bbox + echte Datenabdeckung geprüft) |
| `meteokit/units` | Einheiten-Singleton: `setUnits`, `fmtWind`, `fmtHeight`, … |
| `meteokit/column` | `fetchColumn`, `buildField`, `sampleColumnAtHeight`, `sliceColumnRange`, … |
| `meteokit/weather` | `fetchSurface`, `fetchModelRunInit`, `nearestIndex`, … |
| `meteokit/clouds` | Wolken-/Nebeldiagnostik: `cloudLayers`, `cloudCeiling`, `classifyFog`, … |
| `meteokit/briefing` | `buildBriefingHtml`, `metarWeather`, … |
| `meteokit/crosssection` | `renderCrossSection` |
| `meteokit/astro` | `sunRiseSet`, `moonPhase`, … |
| `meteokit/windbarb` | `windBarbMarkup`, `placeWindBarb` |

## Datenquellen konfigurieren

Die Defaults funktionieren ohne Zutun. Eine App, die andere Instanzen braucht,
ruft `configure()` **einmalig beim Start, vor dem ersten Datenabruf**:

```js
import { configure } from "meteokit/config";
configure({ surfaceApiBase: "https://api.open-meteo.com" });
```

Wichtig — zwei getrennte Quellen, das ist keine Willkür:

- **Modelllevel** (`MODELS[].apiBase`) treibt `fetchColumn` und damit die ganze
  GRAMET-Kette. Das braucht eine Instanz mit nativen ICON-Leveln
  (`wind_u_component_level{N}`, `height_agl_level{N}`, …). **Die öffentliche
  api.open-meteo.com kann das nicht** — sie kennt nur Oberflächen- und
  Druckflächen-Variablen.
- **Oberfläche** (`SURFACE_API_BASE`) treibt `fetchSurface` und läuft bewusst
  gegen die öffentliche Instanz.

## `<gramet-panel>` verwenden

Die Komponente kapselt Ableitung und Rendering vollständig (Shadow DOM, keine
globalen DOM-IDs, keine Host-App-Settings). Die App liefert nur Daten und hört
auf Events.

```js
import "meteokit/components/gramet-panel";
import { fetchGridForPath, posOfPath } from "meteokit/gramet";

const panel = document.querySelector("gramet-panel");
const { grid, terrain, pathStop } = await fetchGridForPath(waypoints, "icon_d2", 3);

panel.update({
  grid,
  terrain,
  pathStop,
  maxHeight: null,          // null = keine Flughöhen-Deckellinie (Path-Modus)
  profile: { pos: posOfPath(waypoints), z: waypoints.map((w) => w.z) },
});

panel.addEventListener("settingschange", (e) => save(e.detail)); // { range, layers, xAxis }
panel.addEventListener("close", () => host.hidden = true);
```

Darstellungszustand lebt in der Komponente; **Persistenz ist Sache der Host-App**
(`settingschange` mitschreiben, beim nächsten Öffnen über `update()` zurückgeben).

Path-Modus-Extras: Umschalter „Zeit | Strecke" im Kopf (`xAxis: "time" |
"dist"`, in `update()` und im `settingschange`-Detail); die Strecke kommt aus
`profile.dist` (m je Profilpunkt), ersatzweise aus den Gitterspalten.
`profile.speed` (m/s je Profilpunkt, z. B. eine
windkorrigierte Groundspeed der Host-App) erscheint als eigene Zeile „GS".
`retimeGridForPath(prev, waypoints, opts)` setzt dieselben Säulen eines
`fetchGridForPath()`-Ergebnisses mit neuen Wegpunkt-Zeiten neu zusammen (kein
Netzwerk; `null` = Säulen decken die neuen Zeiten nicht ab, neu laden). Der
Pfad endet mit `pathStop` am Modellrand, an Datenlöchern und am realen Ende
der Vorhersage-Zeitreihe.

Ladezustände: `panel.loading = "…"` ersetzt den Chart durch eine Meldung (auch
für Fehler, daher ohne Spinner); `panel.loading = { text: "Lade …", spinner: true }`
zeigt dieselbe Meldung mit Lade-Spinner. `panel.busy = "Lade …"` legt einen
Hinweis mit Spinner ÜBER den weiterhin sichtbaren Chart; `update()` löscht
beides.

## Eine weitere Komponente aufnehmen

1. Dateien nach `src/` verschieben (Ordnerstruktur der Quell-App beibehalten,
   dann stimmen die relativen Importe untereinander weiter).
2. Eintrag in die `exports`-Map von `package.json` — nur das, was Apps wirklich
   brauchen. Bei mehreren Dateien eine `index.js` als Barrel anlegen (Muster:
   `src/gramet/index.js`).
3. Importe in den Apps umbiegen; die alten Dateien dort **löschen**, nicht
   liegen lassen.
4. Prüfen, dass nichts auf App-spezifische Konfiguration zurückgreift — was
   konfigurierbar sein muss, gehört in `configure()`.

Naheliegende nächste Kandidaten: `windspinne-panel`, `meteogram`.

Die Leaflet-Overlays sind seit 2026-09 dabei, angefangen mit `meteokit/airspace`
(weltweiter openAIP-Luftraum-Layer, s. `src/airspace/`) -- eingebunden in
droneforecast, trajectories und DZMaster (upper_winds_open_meteo). Nutzt einen
eigenen Cache-Server statt openAIPs Live-API (s. `tools/airspace-cache/README.md`
für den Hintergrund).
