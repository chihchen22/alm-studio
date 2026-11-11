/**
 * The top bar below 1280px (ALM Studio Polish 3 T1; the break moved from 1200px to 1280px in
 * top bar 1). Studio tests have no layout engine, so this pins the rules; the drive measures the bar at 1024, 1100,
 * 1200, 1244 and 1279 px. Rule texts are restated here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../../design/components.css", import.meta.url), "utf8");

/** The rules of every block that opens with `open`, one list per block, one string per rule, whitespace collapsed. */
function blocks(css: string, open: string): string[][] {
  const out: string[][] = [];
  for (let i = css.indexOf(open); i !== -1; i = css.indexOf(open, i + 1)) {
    let depth = 1;
    let j = i + open.length;
    for (; depth > 0; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
    }
    out.push([...css.slice(i + open.length, j - 1).matchAll(/[^{}]+\{[^{}]*\}/g)].map((m) => m[0].replace(/\s+/g, " ").trim()));
  }
  return out;
}

/** The rules of the compact top-bar block: the `@media (max-width: 1279px)` block that holds the `.topbar` rule (the
 * assistant rail's block at the same break holds none). */
function rulesBelow1280(css: string): string[] {
  return blocks(css, "@media (max-width: 1279px) {").filter((b) => b.some((r) => r.startsWith(".topbar {"))).flat();
}

describe("the top bar below 1280px", () => {
  const rules = rulesBelow1280(CSS);
  it("opens its compact block at 1279px, one block, and keeps no top-bar rule at 1199px (top bar 1)", () => {
    const compact = blocks(CSS, "@media (max-width: 1279px) {").filter((b) => b.some((r) => r.startsWith(".topbar {")));
    expect(compact).toHaveLength(1);
    const at1199 = blocks(CSS, "@media (max-width: 1199px) {").flat();
    expect(at1199.filter((r) => /\.topbar|\.mod\b|\.seg\b|\.theme-cycle|\.pill/.test(r))).toEqual([]);
  });
  it("hides the key word of a select pill only, so a failed-list pill keeps Plan or Run", () => {
    expect(rules.filter((r) => r.includes(".pill-key"))).toEqual([".topbar-ctx .pill-select .pill-key { display: none; }"]);
  });
  it("makes room for two failed pills with their keys: tighter gaps and sides, 12px pill text, a one-button theme switch", () => {
    for (const r of [
      ".topbar { gap: var(--sp-2); }",
      ".mod { padding: 0 var(--sp-2); }",
      ".topbar-ctx { gap: var(--sp-1); }",
      ".topbar-ctx .pill { padding: 0 var(--sp-2); gap: var(--sp-1); font-size: var(--fs-1); }",
      ".topbar-ctx .pill .mono { font-size: var(--fs-1); }",
      ".topbar-ctx .seg { display: none; }",
      ".topbar-ctx .theme-cycle { display: inline-flex; }",
    ]) expect(rules).toContain(r);
  });
  it("keeps no rule for the three-button switch's size below 1280px, where it is hidden (Polish 4 T2)", () => {
    expect(rules.filter((r) => r.includes(".seg"))).toEqual([".topbar-ctx .seg { display: none; }"]);
  });
  it("still never shrinks a failed-list pill, so Unobservable stays whole", () => {
    expect(CSS).toContain(".topbar-ctx .pill-status, .topbar-ctx .pill-menu-wrap:has(> .pill-status) { flex: none; }");
  });
  it("drops the workspace switcher's cut-off text below 1280px, where the name and the type badge keep the room (Piece E2); the meta line still prints it", () => {
    expect(rules.filter((r) => r.includes(".switcher-cutoff"))).toEqual([".topbar-ctx .switcher-cutoff { display: none; }"]);
  });
});
