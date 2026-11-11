/**
 * The phone band's shell rules (ALM Studio phone 1). Studio tests have no layout engine, so this pins the rules by source; the review's probe measures
 * them at 390 px and holds the desktop measures to their baseline. Rule texts are restated here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../../design/components.css", import.meta.url), "utf8");
const APP_CSS = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
const OPEN = "@media (max-width: 900px) {";

/** The rules inside every block that opens with `open`, one string per rule, whitespace collapsed, and the rest. */
function split(css: string, open: string): { inside: string[]; outside: string[]; start: number } {
  const inside: string[] = [];
  let rest = "";
  let from = 0;
  const start = css.indexOf(open);
  for (let i = start; i !== -1; i = css.indexOf(open, from)) {
    let depth = 1;
    let j = i + open.length;
    for (; depth > 0; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
    }
    for (const m of css.slice(i + open.length, j - 1).matchAll(/[^{}]+\{[^{}]*\}/g)) inside.push(clean(m[0]));
    rest += css.slice(from, i);
    from = j;
  }
  rest += css.slice(from);
  const outside = [...rest.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/[^{}]+\{[^{}]*\}/g)].map((m) => clean(m[0]));
  return { inside, outside, start };
}
const clean = (rule: string) => rule.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();

const { inside: band, outside, start } = split(CSS, OPEN);

describe("the phone band in components.css", () => {
  it("is one block, after the compact top-bar block (1279 px), so its pill and theme rules win over the compact ones", () => {
    expect(CSS.split(OPEN)).toHaveLength(2);
    // The compact top-bar block is the last `max-width: 1279px` block and the one that holds `.topbar {` (top bar 1);
    // the assistant rail's block at the same break comes before the base top-bar rules.
    const compact = CSS.lastIndexOf("@media (max-width: 1279px) {");
    expect(compact).toBeGreaterThan(-1);
    expect(CSS.slice(compact, CSS.indexOf("\n}", compact))).toContain(".topbar { gap: var(--sp-2); }");
    expect(start).toBeGreaterThan(compact);
    // The page sweep's phone block is app.css's own (phoneSweep.test.ts): one block, the file's last.
    expect(APP_CSS.split(OPEN)).toHaveLength(2);
  });
  it("hides the new chrome at every width outside the band, so the desktop render and its accessibility tree hold", () => {
    const touching = outside.filter((r) => /\.ctx-(button|scrim|sheet)/.test(r));
    expect(touching).toEqual([".ctx-button, .ctx-scrim, .ctx-sheet-head { display: none; }"]);
  });
  it("lays the app out as one column and drops the assistant strip", () => {
    for (const r of [
      ".app, .app.app-strip { --phone-bar: 52px; --phone-mods: 40px; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr); }",
      ".app > .assist-strip { display: none; }",
    ]) expect(band).toContain(r);
  });
  it("makes the top bar a 52 px row over a 40 px module row, the wordmark ALM Studio alone, the context button on the right", () => {
    for (const r of [
      ".topbar { grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: var(--phone-bar) var(--phone-mods); gap: 0; height: auto; padding: 0; }",
      ".wordmark { grid-column: 1; grid-row: 1; justify-self: start; padding-left: var(--sp-4); }",
      ".wordmark-brand { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }",
      ".wordmark-product { color: var(--ink); font-weight: 600; }",
      ".ctx-button { display: inline-flex; grid-column: 2; grid-row: 1; align-items: center; gap: 6px; height: 36px; margin-right: var(--sp-3); padding: 0 10px; border: 1px solid var(--line-2); border-radius: 999px; background: var(--surface); color: var(--ink); font: inherit; font-size: var(--fs-2); white-space: nowrap; cursor: pointer; }",
      ".ctx-button .mono { font-size: var(--fs-1); color: var(--ink-2); }",
    ]) expect(band).toContain(r);
  });
  it("hides the section bar and the rail on a phone: the crumb chip and the sheet take their place, so nothing scrolls sideways (Piece E2)", () => {
    for (const r of [
      ".modbar { display: none; }",
      ".app > .rail { display: none; }",
    ]) expect(band).toContain(r);
    // The rows the old chip row and module tabs set are gone from the band.
    expect(band.filter((r) => /^\.(rail-item|rail-group|rail nav|mod )/.test(r) || r.includes("overflow-x: auto"))).toEqual([]);
    expect(band.filter((r) => r.includes("aria-current=\"true\""))).toEqual([]);
  });
  it("sets the crumb chip as one full-width row under the bar, Section then Screen, with a chevron and no sideways overflow", () => {
    const chip = band.find((r) => r.startsWith(".nav-chip {"))!;
    expect(chip).toBeDefined();
    for (const part of ["display: flex;", "grid-column: 1 / -1;", "grid-row: 2;", "justify-content: space-between;", "min-width: 0;", "cursor: pointer;"]) expect(chip).toContain(part);
    expect(chip).not.toContain("overflow-x");
    expect(band.some((r) => r.startsWith(".nav-chip::after {"))).toBe(true);
  });
  it("lists the seven sections with their screens in the sheet, each item wrapping anywhere, the current one marked", () => {
    for (const r of [
      ".section-sheet { display: grid; gap: var(--sp-3); }",
      ".section-sheet-group { display: grid; gap: 2px; }",
      ".section-sheet-item { display: block; min-width: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-1); color: var(--ink-2); text-decoration: none; font-size: var(--fs-3); overflow-wrap: anywhere; }",
      ".section-sheet-item[aria-current=\"page\"] { background: var(--accent-wash); color: var(--accent); font-weight: 600; }",
    ]) expect(band).toContain(r);
  });
  it("hides the crumb chip and the section list at every width outside the band", () => {
    expect(outside.filter((r) => /\.(nav-chip|section-sheet)/.test(r))).toEqual([".nav-chip, .section-sheet { display: none; }"]);
  });
  it("cuts a long workspace name in the context button at 16 characters, behind an ellipsis", () => {
    expect(band).toContain(".ctx-button .mono { max-width: 16ch; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }");
  });
  it("turns the context group into a bottom sheet over a scrim, shown only while open", () => {
    for (const r of [
      ".topbar-ctx { display: none; }",
      ".topbar-ctx[data-open=\"true\"] { position: fixed; left: 0; right: 0; bottom: 0; z-index: 31; display: grid; grid-template-columns: minmax(0, 1fr); align-items: stretch; justify-content: stretch; gap: var(--sp-2); max-height: 85vh; overflow-y: auto; overscroll-behavior: contain; padding: var(--sp-2) var(--sp-4) calc(var(--sp-5) + env(safe-area-inset-bottom)); background: var(--surface); border-top: 1px solid var(--line); border-radius: var(--r-3) var(--r-3) 0 0; box-shadow: var(--shadow-2); }",
      ".ctx-scrim[data-open=\"true\"] { display: block; position: fixed; inset: 0; z-index: 30; background: var(--shade); opacity: .32; }",
      ".ctx-sheet-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); }",
    ]) expect(band).toContain(r);
  });
  it("sets each pill as a full-width row with its key, its menu in the flow of the sheet so nothing clips it", () => {
    for (const r of [
      ".topbar-ctx .pill-menu-wrap { display: grid; min-width: 0; }",
      ".topbar-ctx .pill { width: 100%; height: 44px; padding: 0 var(--sp-3); gap: var(--sp-3); justify-content: space-between; font-size: var(--fs-3); }",
      ".topbar-ctx .pill-select .pill-key { display: inline; }",
      ".topbar-ctx .pill-menu { position: static; margin-top: var(--sp-1); max-height: 40vh; overflow-y: auto; box-shadow: none; }",
      ".topbar-ctx .pill-menu a { white-space: normal; overflow-wrap: anywhere; }",
      ".topbar-ctx .pill-status-reason { position: static; width: auto; max-width: none; margin-top: var(--sp-1); box-shadow: none; }",
    ]) expect(band).toContain(r);
  });
  it("shows the three-button theme switch across the sheet and hides the cycle button", () => {
    for (const r of [
      ".topbar-ctx .seg { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }",
      ".topbar-ctx .seg button { font-size: var(--fs-3); padding: var(--sp-2) 0; }",
      ".topbar-ctx .theme-cycle { display: none; }",
    ]) expect(band).toContain(r);
  });
  it("pads the head band and the content 16 px and sets the page title one size down", () => {
    for (const r of [
      ".app .content { padding: var(--sp-4); }",
      ".app .head-band { padding: var(--sp-4) var(--sp-4) 0; }",
      ".page-title { font-size: var(--fs-5); }",
    ]) expect(band).toContain(r);
  });
});
