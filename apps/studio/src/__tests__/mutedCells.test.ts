/**
 * Every muted table cell is muted (ALM Studio Polish 5 T3). ".table td" sets the cell ink at 0,1,1 and
 * outranks ".muted" at 0,1,0, so a td.muted cell printed in the body ink: the Targets page's unused cells and runoff
 * row, a muted family cell on the chart of accounts, and then the Govern purpose cell (since Polish 7 T2 a muted span
 * inside the Component cell, which ".muted" inks itself). One rule at the table's own weight sets
 * the muted ink for any muted cell, after ".table td:first-child" (the same weight) so a muted first cell is muted
 * too. The absence rule keeps only its face. Rule texts are restated here; the drive reads the computed inks.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../../design/components.css", import.meta.url), "utf8");

describe("a muted table cell", () => {
  it("takes the muted ink, after the first-cell ink it must outrank", () => {
    const rule = ".table td.muted { color: var(--muted); }";
    const anchor = ".table td:first-child { color: var(--ink); font-weight: 500; }";
    expect(CSS).toContain(rule);
    // The anchor first: a missing anchor is indexOf -1, and any rule would sit after it (Polish 6 T5).
    expect(CSS).toContain(anchor);
    expect(CSS.indexOf(rule)).toBeGreaterThan(CSS.indexOf(anchor));
  });
  it("leaves the absence cell rule its face alone", () => {
    expect(CSS).not.toMatch(/td\.num\.muted[^{}]*\{[^}]*color/);
  });
});
