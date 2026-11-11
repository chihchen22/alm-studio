/**
 * The notes say what the rules do (ALM Studio Polish 5 T5). After Polish 4 a top-bar select pill cuts
 * its value from the start, the none and status pills never shrink and the three-button switch hides below 1280px (top bar 1);
 * the base cycle button rules hold at every width, so they sit above the compact block's comment, unchanged; words
 * sets the 12px one-line size and no face. Comment and rule texts are restated here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../../design/components.css", import.meta.url), "utf8");
// The leaf cell and its note moved to format/LeafCell.tsx (Polish 6 T5).
const LEAF_CELL = readFileSync(new URL("../format/LeafCell.tsx", import.meta.url), "utf8");

describe("the notes in the Studio CSS and the leaf cell", () => {
  it("place the base cycle button rules above the compact block's comment, their text unchanged", () => {
    const base =
      ".theme-cycle { display: none; flex: none; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-2); color: var(--ink-2); cursor: pointer; transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast); }";
    const hover = ".theme-cycle:hover { border-color: var(--line-2); color: var(--ink); }";
    const note = "/* Below 1280px the top bar is compact (Polish 3 T1; top bar 1).";
    expect(CSS).toContain(base);
    expect(CSS).toContain(hover);
    expect(CSS.indexOf(hover)).toBeLessThan(CSS.indexOf(note));
    expect(CSS.indexOf(base)).toBeLessThan(CSS.indexOf(hover));
  });
  it("describe the top bar as it is after Polish 4", () => {
    expect(CSS).not.toContain("ends its value in an ellipsis");
    expect(CSS).toContain("its value is cut from its start behind a leading ellipsis");
    expect(CSS).toContain("A failed-list status pill and a pill that reads none never shrink.");
    expect(CSS).toContain("below 1280px it is hidden and one cycle button stands in");
    expect(CSS).toContain("This block comes after the compact top-bar block (1279px), so its pill and");
  });
  it("say that words sets the 12px one-line size and no face", () => {
    expect(CSS).not.toContain("A words cell (body face)");
    expect(CSS).toContain("the face comes from the cell's other class");
    expect(LEAF_CELL).not.toContain("(words and mono share that rule)");
    expect(LEAF_CELL).toContain("words sets only the 12 px one-line size, so a figure takes its face from num");
  });
});
