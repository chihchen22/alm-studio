/**
 * By kind ends on a whole row (ALM Studio Polish 7 T3). The table box ends on the bottom edge of the last body row that fits whole inside the .table-wrap cap
 * (560 px); a table shorter than the cap keeps its natural height. Studio tests have no layout engine and effects do
 * not run under the server render, so the arithmetic is a pure function pinned here with literal heights, and the
 * page's measure is pinned by its source: a layout effect, an observer on the table, and its disconnect. The drive
 * measures the cut on the four pages. Heights, rule and source texts are restated here. Since Polish 8 T2 the function
 * and the hook live in one shared module (layout/wholeRows.ts), which By kind and the Govern inventory both use: the
 * measure's pins read that module, and the page's pins read how By kind calls it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet } from "@alm/engine";
import { byKindModel } from "../assumptions/byKindModel";
import { wholeRowsHeight } from "../layout/wholeRows";
import { ByKindView } from "../pages/assumptions/ByKindPage";

const APP_CSS = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../pages/assumptions/ByKindPage.tsx", import.meta.url), "utf8");
const HOOK = readFileSync(new URL("../layout/wholeRows.ts", import.meta.url), "utf8");
const MODEL = readFileSync(new URL("../assumptions/byKindModel.ts", import.meta.url), "utf8");
const COMPONENTS_CSS = readFileSync(new URL("../../design/components.css", import.meta.url), "utf8");

// n rows of h px, then a last row 1 px shorter (a table's last row has no bottom line), as on the seeded pages.
const rows = (n: number, h: number) => [...Array.from({ length: n - 1 }, () => h), h - 1];
// n rows alternating a and b px.
const alternating = (n: number, a: number, b: number) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? a : b));

describe("wholeRowsHeight, the By kind box's height", () => {
  it("ends on the last row that fits whole under 560 px, with the seeded pages' headers and rows", () => {
    // Decay, dark: header 107, 35 px rows; 107 + 12 x 35 = 527, and a 13th row would end at 562.
    expect(wholeRowsHeight(107, rows(81, 35), 560)).toBe(527);
    // Prepay, light: header 89, 43 px rows; 89 + 10 x 43 = 519, and an 11th would end at 562.
    expect(wholeRowsHeight(89, rows(23, 43), 560)).toBe(519);
    // Renewal and draws, dark: header 53; 53 + 14 x 35 = 543, and a 15th would end at 578.
    expect(wholeRowsHeight(53, rows(24, 35), 560)).toBe(543);
  });
  it("adds mixed 35 and 34 px rows in their order", () => {
    // Header 89, then 35 + 34 six times to 503, then 35 to 538; the next row, 34, would end at 572.
    expect(wholeRowsHeight(89, alternating(23, 35, 34), 560)).toBe(538);
    // Led by 34: 89 + 6 x 69 = 503, then 34 to 537; the next row, 35, would end at 572.
    expect(wholeRowsHeight(89, alternating(23, 34, 35), 560)).toBe(537);
  });
  it("keeps a table that fits at its natural height", () => {
    // Deposit repricing, dark: 89 + 4 x 35 + 34 = 263.
    expect(wholeRowsHeight(89, rows(5, 35), 560)).toBeNull();
    // A table exactly as tall as the cap fits.
    expect(wholeRowsHeight(50, [255, 255], 560)).toBeNull();
  });
  it("leaves room for the frame, a sideways scrollbar that takes space", () => {
    // Room 560 - 15 = 545: 107 + 12 x 35 = 527 fits and a 13th would end at 562; the box is 527 + 15 = 542.
    expect(wholeRowsHeight(107, rows(81, 35), 560, 15)).toBe(542);
    // Room 560 - 17 = 543: Prepay, dark, drops its 13th row (89 + 13 x 35 = 544); 89 + 12 x 35 = 509, box 526.
    expect(wholeRowsHeight(89, rows(23, 35), 560)).toBe(544);
    expect(wholeRowsHeight(89, rows(23, 35), 560, 17)).toBe(526);
  });
  it("keeps the cap when not even the first row fits whole", () => {
    expect(wholeRowsHeight(540, [35, 35], 560)).toBe(560);
  });
});

describe("the By kind page's measure", () => {
  it("sizes the box after layout and again whenever the table's box changes size, then lets go", () => {
    expect(HOOK).toContain('const useLayoutBeforePaint = typeof document === "undefined" ? useEffect : useLayoutEffect;');
    expect(HOOK).toContain('box.style.maxHeight = "";');
    expect(HOOK).toContain("const cap = parseFloat(getComputedStyle(box).maxHeight);");
    expect(HOOK).toContain("wholeRowsHeight(head.getBoundingClientRect().height, rows, cap, box.offsetHeight - box.clientHeight)");
    expect(HOOK).toContain("    fit();\n");
    expect(HOOK).toContain("watch.observe(table);");
    expect(HOOK).toContain("}, [wrap, key]);");
    // By kind calls the shared hook on its model and holds no copy of it (Polish 8 T2).
    expect(PAGE).toContain('import { useWholeRows } from "../../layout/wholeRows";');
    expect(PAGE).toContain("useWholeRows(wrap, model);");
    expect(PAGE).toContain('<div className="table-wrap" ref={wrap}>');
    expect(PAGE).not.toContain("useLayoutBeforePaint");
    expect(MODEL).not.toContain("wholeRowsHeight");
  });
  it("watches the box too, so a resize that adds or drops a sideways scrollbar re-fits it (Polish 7 Task 4 I2)", () => {
    // The table stops resizing at its min-content width, so only the box's own size change reports the scrollbar.
    expect(HOOK).toContain("watch.observe(table);\n    watch.observe(box);\n    return () => {");
    // One observer, one disconnect: the fit writes only the box's max-height and lands on the same px each time.
    expect(HOOK.match(/new ResizeObserver\(/g)?.length).toBe(1);
    expect(HOOK.match(/watch\.disconnect\(\)/g)?.length).toBe(1);
  });
  it("re-fits one animation frame after the observer's notice, so a resize raises no loop error; cleanup cancels the frame (Polish 8 T3)", () => {
    // The first fit stays synchronous, in the layout effect, before the observer exists: the code order, not a comment.
    const code = HOOK.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code.indexOf("    fit();\n")).toBeGreaterThan(-1);
    expect(code.indexOf("    fit();\n")).toBeLessThan(code.indexOf("const watch = new ResizeObserver("));
    // The observer only asks for a frame: the fit's max-height write never lands inside the observer's callback.
    expect(HOOK).toContain("const watch = new ResizeObserver(() => {\n      cancelAnimationFrame(frame);\n      frame = requestAnimationFrame(fit);\n    });");
    expect(HOOK).not.toContain("new ResizeObserver(fit)");
    expect(HOOK).toContain("return () => {\n      cancelAnimationFrame(frame);\n      watch.disconnect();\n    };");
    expect(HOOK.match(/requestAnimationFrame\(/g)?.length).toBe(1);
    expect(HOOK.match(/cancelAnimationFrame\(frame\)/g)?.length).toBe(2);
  });
  it("builds its model once per loaded sets and kinds, so the fit runs again only when the model changes (Polish 8 T3)", () => {
    expect(PAGE).toContain("const model = useMemo(() => (sets === null ? null : byKindModel(sets, kinds)), [sets, kinds]);");
    expect(PAGE).toContain("<ByKindView ws={props.ws} kinds={kinds} model={model} query={props.query} />");
    expect(PAGE).not.toContain("model={byKindModel(");
  });
  it("keeps the 560 px cap and the sticky header on every table box, and the server render unstyled", () => {
    expect(APP_CSS).toContain(".table-wrap { overflow: auto; max-height: 560px; }");
    expect(APP_CSS).toContain(".table-wrap thead th { position: sticky; top: 0; background: var(--surface); }");
    const set = {
      schemaVersion: "1.0.0", id: "demo-behavioral-v1", label: "Demo",
      bindings: [{ familyId: "dda", overlay: { kind: "nmd-decay", params: { closureSteady: 0.75 } }, modelVersion: "kernel-nmd-decay-1" }],
    } as unknown as AssumptionSet;
    const html = renderToStaticMarkup(<ByKindView ws="ws-a" kinds={["nmd-decay"]} model={byKindModel([set], ["nmd-decay"])} query={{}} />);
    expect(html).toContain('<div class="table-wrap"><table class="table by-kind" style="--w1:78px;--w2:104px;--w3:172px">');
  });
});

describe("the By kind row count (Polish 7 Task 4 I3, ruling 2026-09-29)", () => {
  // One stored set binding nmd-decay on dda with the given params: one body row per param.
  const view = (params: Record<string, number>) => {
    const set = {
      schemaVersion: "1.0.0", id: "demo-behavioral-v1", label: "Demo",
      bindings: [{ familyId: "dda", overlay: { kind: "nmd-decay", params }, modelVersion: "kernel-nmd-decay-1" }],
    } as unknown as AssumptionSet;
    return renderToStaticMarkup(<ByKindView ws="ws-a" kinds={["nmd-decay"]} model={byKindModel([set], ["nmd-decay"])} query={{}} />);
  };
  it("prints the model's row count as one plain text line under the table, inside the card, above the source", () => {
    const three = view({ closureSteady: 0.75, maxRateDecay: 3, regimeAlpha: 0.5 });
    expect(three.match(/<tr>/g)?.length).toBe(4); // the header row and 3 body rows
    expect(three).toContain('</table></div><p class="table-foot">3 rows</p><p class="card-foot">Source: /api/assumption-sets and /api/assumption-sets/:id bindings[].overlay</p></section>');
  });
  it("says 1 row for one", () => {
    const one = view({ closureSteady: 0.75 });
    expect(one).toContain('</table></div><p class="table-foot">1 row</p><p class="card-foot">');
    expect(one).not.toContain("1 rows");
  });
  it("uses the muted 12 px foot: text only, no fade and no shadow (bar line 11)", () => {
    expect(COMPONENTS_CSS).toContain(".table-foot { font-size: var(--fs-1); color: var(--muted); padding: var(--sp-3) var(--sp-3) var(--sp-1); }");
    expect(APP_CSS).not.toMatch(/\.table-foot[^{}]*\{[^}]*(shadow|gradient|mask|opacity)/);
    expect(COMPONENTS_CSS).not.toMatch(/\.table-foot[^{}]*\{[^}]*(shadow|gradient|mask|opacity)/);
  });
});
