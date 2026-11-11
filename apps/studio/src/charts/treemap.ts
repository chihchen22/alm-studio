/**
 * Squarified treemap (Bruls, Huizing and van Wijk 2000). Display layout only:
 * the rectangles place served values on screen; no value is derived from them.
 * Items are laid out largest first, in rows along the shorter side of the
 * remaining box; a row grows while adding the next item does not worsen its
 * worst aspect ratio, then the box shrinks by the row and the next row starts.
 */
export interface TreeItem { key: string; value: number }
export interface TreeRect { key: string; value: number; x: number; y: number; w: number; h: number }

/** The worst aspect ratio in a row of areas laid along a side of length `side`. */
function worst(areas: number[], side: number): number {
  const s = areas.reduce((a, b) => a + b, 0);
  let out = 0;
  for (const r of areas) out = Math.max(out, (side * side * r) / (s * s), (s * s) / (side * side * r));
  return out;
}

/** Squarified treemap over a w by h box. Items with value <= 0 (or not a number) are omitted and returned in `omitted`. */
export function squarify(items: TreeItem[], w: number, h: number): { rects: TreeRect[]; omitted: TreeItem[] } {
  const omitted = items.filter((i) => !(i.value > 0));
  const kept = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = kept.reduce((s, i) => s + i.value, 0);
  const rects: TreeRect[] = [];
  if (kept.length === 0 || !(w > 0) || !(h > 0)) return { rects, omitted };
  const scale = (w * h) / total;
  let x = 0, y = 0, W = w, H = h;

  const place = (row: TreeItem[]) => {
    const areas = row.map((i) => i.value * scale);
    const rowArea = areas.reduce((a, b) => a + b, 0);
    if (W >= H) {
      // Short side is the height: a vertical strip at the left of the box.
      const stripW = rowArea / H;
      let cy = y;
      row.forEach((item, k) => { const ch = areas[k] / stripW; rects.push({ key: item.key, value: item.value, x, y: cy, w: stripW, h: ch }); cy += ch; });
      x += stripW; W -= stripW;
    } else {
      // Short side is the width: a horizontal strip at the top of the box.
      const stripH = rowArea / W;
      let cx = x;
      row.forEach((item, k) => { const cw = areas[k] / stripH; rects.push({ key: item.key, value: item.value, x: cx, y, w: cw, h: stripH }); cx += cw; });
      y += stripH; H -= stripH;
    }
  };

  let row: TreeItem[] = [];
  let i = 0;
  while (i < kept.length) {
    const side = Math.min(W, H);
    const next = [...row, kept[i]];
    if (row.length === 0 || worst(next.map((r) => r.value * scale), side) <= worst(row.map((r) => r.value * scale), side)) {
      row = next;
      i++;
    } else {
      place(row);
      row = [];
    }
  }
  if (row.length > 0) place(row);
  return { rects, omitted };
}
