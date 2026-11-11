/**
 * The shell's phone pieces as pure functions (ALM Studio phone 1): the context sheet's open and close, the
 * context button's run tail, and the chip row's scroll that brings the current page's chip into view.
 */
import { PILL_NONE } from "./SelectPill";

/**
 * What the context sheet hears: open, close (the scrim, the close button, Escape, a route change, leaving the phone
 * band) or toggle (the context button).
 */
export type CtxSheetEvent = "open" | "close" | "toggle";

/** The sheet's reducer: open or not, after one event. */
export function ctxSheet(open: boolean, event: CtxSheetEvent): boolean {
  return event === "toggle" ? !open : event === "open";
}

/**
 * The class document.body carries while the sheet is open, or null while it is shut (phone 2). Its rule, inside the
 * phone band only, holds the page behind the sheet still, so a drag on the scrim does not scroll the document.
 */
export function sheetBodyClass(open: boolean): string | null {
  return open ? "ctx-sheet-open" : null;
}

/** The context button's run: an ellipsis and the id's last seven characters, the whole id when that is all it has, or none. */
export function runTail(run: string | undefined): string {
  if (run === undefined || run === "") return PILL_NONE;
  return run.length <= 7 ? run : `…${run.slice(-7)}`;
}

/**
 * The chip row's scrollLeft that brings a chip into view with the least movement, `pad` px inside the row's edges
 * (inline nearest). A chip already in view keeps the scroll; a chip wider than the room starts at the left pad.
 * Boxes are viewport rectangles, the chip's measured at the current scroll.
 */
export function chipScrollLeft(scrollLeft: number, view: { left: number; right: number }, chip: { left: number; right: number }, pad: number): number {
  const room = view.right - view.left - 2 * pad;
  if (chip.left < view.left + pad || chip.right - chip.left > room) return Math.max(0, scrollLeft + chip.left - view.left - pad);
  if (chip.right > view.right - pad) return scrollLeft + chip.right - view.right + pad;
  return scrollLeft;
}

/**
 * Tab and Shift+Tab in the open sheet (aria-modal): the index among its `n` focusables to move focus to when the key
 * would leave the sheet, or null to let the browser move it. `at` is the focused element's index, -1 when focus is
 * outside the sheet, which brings it back in (Tab to the first, Shift+Tab to the last).
 */
export function trapTab(n: number, at: number, back: boolean): number | null {
  if (n === 0) return null;
  if (at === -1) return back ? n - 1 : 0;
  if (back && at === 0) return n - 1;
  if (!back && at === n - 1) return 0;
  return null;
}
