// apps/studio/src/layout/wholeRows.ts
/**
 * A table box that ends on a whole row (Polish 7 T3; one shared module since Polish 8 T2): the pure height and the hook that applies it
 * after layout. By kind and the Govern inventory use it; every other .table-wrap keeps its 560 px cap as it is.
 */
import { useEffect, useLayoutEffect, type RefObject } from "react";

/**
 * A table box's height, in px, so the box ends on the bottom edge of the last body row that fits whole under the cap.
 * The header comes first, then the body rows in order while the running sum stays within the cap less the frame (the
 * box's own height outside its content: a sideways scrollbar when one takes room). Null when the whole table fits, so
 * the box keeps its natural height; the cap when not even the first row fits whole. The page passes heights it
 * measured after layout: body rows differ by theme and by content, a table's last row by a px, and the header's
 * height depends on how its labels wrap, so no constant is exact.
 */
export function wholeRowsHeight(headerPx: number, rowPx: number[], capPx: number, framePx = 0): number | null {
  const room = capPx - framePx;
  if (headerPx + rowPx.reduce((sum, h) => sum + h, 0) <= room) return null;
  let used = headerPx;
  let fits = 0;
  for (const h of rowPx) {
    if (used + h > room) break;
    used += h;
    fits += 1;
  }
  return fits === 0 ? capPx : used + framePx;
}

/**
 * A layout effect in the browser, so the box is sized before the first paint; a plain effect where there is no
 * document (the tests' server render runs neither, and React warns on a layout effect there). Exported for the charts,
 * which measure their width the same way (Polish 10 T1).
 */
export const useLayoutBeforePaint = typeof document === "undefined" ? useEffect : useLayoutEffect;

/**
 * Ends a table box on a whole row. After layout, and again whenever the table's box changes size (its rows or columns
 * change, or a window resize reflows its cells) or the box's own size changes (a resize that adds or drops a sideways
 * scrollbar once the table sits at its min-content width and no longer resizes; Polish 7 Task 4 I2), the box's
 * max-height is cleared back to the .table-wrap cap (app.css, 560 px), the header and each body row are measured, and
 * the box is set to end on the last row that fits whole (wholeRowsHeight); a table shorter than the cap keeps its
 * natural height. Only the box's max-height changes, so a sticky header and sticky columns stay put. The fit is
 * idempotent: its own max-height write lands on the same px when it runs again, so the observer settles after one
 * more pass. `key` is what the table is built from (the page's model or rows): a new key fits again.
 */
export function useWholeRows(wrap: RefObject<HTMLDivElement>, key: unknown): void {
  useLayoutBeforePaint(() => {
    const box = wrap.current;
    const table = box?.querySelector("table");
    if (!box || !table || !table.tHead) return;
    const head = table.tHead;
    const fit = () => {
      box.style.maxHeight = "";
      const cap = parseFloat(getComputedStyle(box).maxHeight);
      if (!Number.isFinite(cap)) return;
      const rows = Array.from(table.tBodies[0]?.rows ?? [], (tr) => tr.getBoundingClientRect().height);
      const px = wholeRowsHeight(head.getBoundingClientRect().height, rows, cap, box.offsetHeight - box.clientHeight);
      if (px !== null) box.style.maxHeight = `${px}px`;
    };
    fit();
    // The observer's re-fit waits one animation frame, so the fit's own max-height write never lands inside the
    // observer's callback and a resize raises no "ResizeObserver loop completed" window error; the first fit above
    // stays synchronous, before the first paint. A newer notice replaces a pending frame, and cleanup cancels it
    // (Polish 8 T3).
    let frame = 0;
    const watch = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    watch.observe(table);
    watch.observe(box);
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
    };
  }, [wrap, key]);
}
