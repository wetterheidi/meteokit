/**
 * Generische Bodenwerte-Zeile für Zahlenwerte (Temperatur/Taupunkt, Böen, ...)
 * — ein Row-Typ für beliebige Serien, damit neue Zeilen ohne neuen
 * Zeichencode ergänzt werden können (s. Plan, "generisches Row-System").
 */

export const NUMBER_ROW_HEIGHT = 34;

/**
 * @param series [{ values: Float32Array, fmt: (v)=>string, color }]
 * gestapelt untereinander in der Zeile (z. B. T über Taupunkt).
 *
 * Kollisionsschutz an der TATSÄCHLICHEN Textbreite (`ctx.measureText`) statt
 * einer geschätzten Fixbreite (vorher `minGapPx`, ein Pauschalwert fürs
 * jeweils breiteste denkbare Label) -- so wird nur so viel übersprungen, wie
 * die konkreten Werte wirklich brauchen. Erst das, zusammen mit den seit
 * Kurzem einheitenlosen Zellen (Einheit steht im Zeilenlabel), lässt die
 * meisten Zeilen jede Stunde statt nur jede zweite zeigen (s. Feedback).
 */
export function drawNumberRow(ctx, pos, x, top, height, series, opts = {}) {
  const padPx = opts.padPx ?? 4; // Mindestabstand zwischen benachbarten Labels
  const lineH = height / (series.length + 1);
  ctx.font = opts.font ?? "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  let lastRight = -Infinity;
  for (let i = 0; i < pos.length; i++) {
    const px = x(pos[i]);
    // Mehrere gestapelte Werte teilen sich dieselbe Spalte (horizontal) --
    // für die Kollision zählt nur die breiteste der (vorhandenen) Zeilen.
    const texts = series.map((s) => {
      const v = s.values[i];
      return Number.isFinite(v) ? s.fmt(v) : null;
    });
    if (texts.every((t) => t == null)) continue;
    const w = Math.max(...texts.filter((t) => t != null).map((t) => ctx.measureText(t).width));
    if (px - w / 2 < lastRight + padPx) continue;
    series.forEach((s, row) => {
      const t = texts[row];
      if (t == null) return;
      ctx.fillStyle = s.color ?? "#0b1220";
      ctx.fillText(t, px, top + lineH * (row + 1));
    });
    lastRight = px + w / 2;
  }
}
