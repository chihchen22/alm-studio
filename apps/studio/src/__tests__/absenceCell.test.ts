/**
 * An absence cell keeps the body face in both themes (ALM Studio Polish 4 T3). A td.num.muted cell states that a value is
 * absent ("Not bound" and "Not stored" on By kind, "No roll-up served" on the chart of accounts): words, not a
 * figure, so the dark theme's mono figure face does not reach it. It also takes the muted ink: ".table td" sets the
 * cell ink and outranks ".muted", so the class alone never took effect (Task 5 fix M1). Numeric header cells keep the
 * theme's figure face. Rule texts are restated here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../../design/components.css", import.meta.url), "utf8");

describe("an absence cell", () => {
  it("takes the body face, after the figure-face rule it outranks; its ink is the td.muted rule's (Polish 5 T3)", () => {
    const rule = ".table td.num.muted { font-family: var(--font); }";
    expect(CSS).toContain(rule);
    expect(CSS.indexOf(rule)).toBeGreaterThan(CSS.indexOf(".num, .stat-value, .table .num { font-family: var(--font-num); }"));
  });
  it("leaves numeric header cells in the figure face", () => {
    expect(CSS).not.toMatch(/th\.num[^{}]*\{[^}]*font-family/);
  });
});
