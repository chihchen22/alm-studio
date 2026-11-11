/**
 * The vol surface explorer (ALM Studio Polish 10 T4): one selection and one pinned flag shared by the 3D surface, the two slices and the grid. The pure
 * selection rules are tested here, and the markup of the first selection on the Market fixture's cap and swaption
 * grids: the slice titles, the context lines, the ATM line, the ringed grid cell and its highlighted headers. Drag,
 * hover and click run in the browser (the drive checks them). Expected texts are restated.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { capGrid, pct, sig, swaptionGrid, type VolGrid } from "@alm/reader";
import { firstSel, nextSel, VolExplorer } from "../charts/VolExplorer";
import { SNAP } from "./fixtures/market";

const APP_CSS = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
const years = (y: number) => `${sig(y, 4)}y`;
const CAP = capGrid(SNAP.capVolSurface);
const SWAPTION = swaptionGrid(SNAP.swaptionVolSurface);
const cap = () => renderToStaticMarkup(<VolExplorer grid={CAP} kind="cap" rowFormat={years} colFormat={(k) => pct(k, 2)} title="Cap normal vol" />);
const count = (html: string, s: string) => html.split(s).length - 1;

describe("the explorer's selection", () => {
  it("starts on the fifth expiry, or the last of a shorter grid, and the middle column, unpinned", () => {
    const rows = (n: number): VolGrid => ({ rows: Array.from({ length: n }, (_, k) => k + 1), cols: [1, 2, 3, 4, 5], cells: [], atm: null, min: 0, max: 0 });
    expect(firstSel(rows(15))).toEqual({ i: 4, j: 2, pinned: false });
    expect(firstSel(rows(2))).toEqual({ i: 1, j: 2, pinned: false });
  });
  it("moves on a hover only while unpinned; a click pins, a click on the pinned quote unpins, a click elsewhere pins there", () => {
    const free = { i: 4, j: 2, pinned: false };
    expect(nextSel(free, "hover", 1, 1)).toEqual({ i: 1, j: 1, pinned: false });
    expect(nextSel(free, "hover", 4, 2)).toBe(free);
    const pinned = nextSel(free, "pin", 3, 3);
    expect(pinned).toEqual({ i: 3, j: 3, pinned: true });
    expect(nextSel(pinned, "hover", 0, 0)).toBe(pinned);
    expect(nextSel(pinned, "pin", 3, 3)).toEqual({ i: 3, j: 3, pinned: false });
    expect(nextSel(pinned, "pin", 0, 1)).toEqual({ i: 0, j: 1, pinned: true });
  });
});

describe("VolExplorer", () => {
  it("names the canvas for the surface and its stored quotes, and says how to pin", () => {
    const html = cap();
    // The fixture's cap grid: 2 expiries by 2 strikes, 3 stored quotes (one missing), the ATM column aside.
    expect(html).toContain('aria-label="Cap normal vol surface, 2 expiries by 2 strikes, 3 stored quotes; drag to turn it, hover to read a quote, click to pin it"');
    expect(html).toContain('<p class="vx-pin" aria-live="polite">Hover to read. Click a point to pin it.</p>');
  });

  it("slices the cap at the selected expiry and strike: the row in the ink over the other rows, the column over the other columns, the ATM line dashed", () => {
    const html = cap();
    expect(html).toContain('<div class="vx-slice-title">Smile at the 2y expiry</div>');
    expect(html).toContain('<div class="vx-slice-title">Term structure at the 4.00% strike</div>');
    expect(html).toContain('stroke="var(--ink)"');
    expect(html).toContain('stroke="var(--series-2)"');
    expect(html).toContain('stroke="var(--muted)" stroke-dasharray="6 4"');
    // One other row behind the smile, one other column behind the term structure.
    expect(count(html, 'class="lp-ctx"')).toBe(2);
    expect(html).not.toContain("lp-legend");
  });

  it("names the swaption slices by swap tenor and expiry", () => {
    const html = renderToStaticMarkup(<VolExplorer grid={SWAPTION} kind="swaption" rowFormat={years} colFormat={years} title="Swaption normal vol" />);
    expect(html).toContain('<div class="vx-slice-title">Across swap tenors at the 5y expiry</div>');
    expect(html).toContain('<div class="vx-slice-title">Across expiries for the 10y swap</div>');
    expect(html).toContain('aria-label="Swaption normal vol surface, 2 expiries by 2 swap tenors, 4 stored quotes;');
  });

  it("rings the selected grid cell, highlights its row and column headers, and marks the cells on its row and column", () => {
    const html = cap();
    expect(html).toContain('<div class="hm-cell hm-lo hm-x hm-at" data-i="1" data-j="1" style="background:var(--seq-1)" title="2y, 4.00%: 63.7 bp">63.7</div>');
    expect(html).toContain('<div class="hm-row hm-on">2y</div>');
    expect(html).toContain('<div class="hm-col hm-on">4.00%</div>');
    expect(html).toContain('<div class="hm-cell unobs hm-x" data-i="0" data-j="1" title="1y, 4.00%: Unobservable, no quote stored">');
    // The ATM column is no surface vertex: it carries no index and no selection class.
    expect(html).toContain('<div class="hm-col">ATM</div>');
    expect(html).toContain('<div class="hm-cell unobs" title="2y, ATM: Unobservable, no quote stored">');
  });

  it("ticks the cap's strikes on an even step: every 2% from -2% on a -2% to 7% grid (Polish 10 Task 5, F7)", () => {
    const cols = [-0.02, -0.015, -0.01, 0, 0.01, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.07];
    const grid: VolGrid = { rows: [1, 2], cols, cells: [cols.map(() => 100), cols.map(() => 90)], atm: null, min: 90, max: 100 };
    const html = renderToStaticMarkup(<VolExplorer grid={grid} kind="cap" rowFormat={years} colFormat={(k) => pct(k, 2)} title="Cap normal vol" />);
    // The smile's x ticks: -2%, 0%, 2%, 4%, 6%; no odd whole percent, no quarter.
    const ticks = [...html.matchAll(/text-anchor="middle">([^<]*%)<\/text>/g)].map((m) => m[1]);
    expect(ticks).toEqual(["-2%", "0%", "2%", "4%", "6%"]);
  });

  it("falls back to the stored strikes, printed to 2 decimals, when a cap grid holds no whole-percent strike (Polish 11, Minor 4)", () => {
    const cols = [0.015, 0.025, 0.035];
    const grid: VolGrid = { rows: [1, 2], cols, cells: [cols.map(() => 100), cols.map(() => 90)], atm: null, min: 90, max: 100 };
    const html = renderToStaticMarkup(<VolExplorer grid={grid} kind="cap" rowFormat={years} colFormat={(k) => pct(k, 2)} title="Cap normal vol" />);
    const ticks = [...html.matchAll(/text-anchor="middle">([^<]*%)<\/text>/g)].map((m) => m[1]);
    expect(ticks).toEqual(["1.50%", "2.50%", "3.50%"]);
  });

  it("draws no ATM line on the term structure when every stored ATM quote is missing, as the grid shows no ATM column (Polish 11, T4 review Minor 3)", () => {
    const cols = [0.03, 0.04];
    const grid: VolGrid = { rows: [1, 2], cols, cells: [[100, 95], [90, 85]], atm: [null, null], min: 85, max: 100 };
    const html = renderToStaticMarkup(<VolExplorer grid={grid} kind="cap" rowFormat={years} colFormat={(k) => pct(k, 2)} title="Cap normal vol" />);
    expect(html).not.toContain('stroke="var(--muted)" stroke-dasharray="6 4"');
    expect(html).not.toContain(">ATM<");
    // One stored ATM quote is enough for both.
    const one = renderToStaticMarkup(<VolExplorer grid={{ ...grid, atm: [null, 92] }} kind="cap" rowFormat={years} colFormat={(k) => pct(k, 2)} title="Cap normal vol" />);
    expect(one).toContain('stroke="var(--muted)" stroke-dasharray="6 4"');
    expect(one).toContain('<th scope="col" class="num">ATM</th>');
  });

  it("plots the selected expiry's stored quotes as the ink smile and the selected strike's as the term structure (Polish 11)", () => {
    // The fixture's first selection is the 2y expiry (row 1) and the 4.00% strike (column 1): 2y stores 68.0 bp at 3%
    // and 63.7 bp at 4%; the 4% column stores nothing at 1y and 63.7 at 2y; the ATM stores 63.5 at 1y only.
    const html = cap();
    expect(html).toContain('<thead><tr><th scope="col">Point</th><th scope="col" class="num">2y expiry</th></tr></thead><tbody><tr><th scope="row">3.00% strike</th><td class="num lvl">68.0 bp</td></tr><tr><th scope="row">4.00% strike</th><td class="num lvl">63.7 bp</td></tr></tbody>');
    expect(html).toContain('<thead><tr><th scope="col">Point</th><th scope="col" class="num">4.00% strike</th><th scope="col" class="num">ATM</th></tr></thead><tbody><tr><th scope="row">1y expiry</th><td class="num lvl">Unobservable</td><td class="num lvl">63.5 bp</td></tr><tr><th scope="row">2y expiry</th><td class="num lvl">63.7 bp</td><td class="num lvl">Unobservable</td></tr></tbody>');
  });

  it("prints only the grid's Unobservable line for an empty surface", () => {
    const empty: VolGrid = { rows: [], cols: [], cells: [], atm: null, min: 0, max: 0 };
    const html = renderToStaticMarkup(<VolExplorer grid={empty} kind="cap" rowFormat={years} colFormat={years} title="Cap normal vol" />);
    expect(html).toContain("The snapshot stores no quote on this surface.");
    expect(html).not.toContain("canvas");
  });

  it("lays the surface and the slices side by side, stacked under 820 px of card width, and dims the grid off the selection", () => {
    for (const rule of [
      ".vx-top { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr); gap: var(--sp-4); align-items: start; }",
      "@container (max-width: 820px) { .vx-top { grid-template-columns: minmax(0, 1fr); } }",
      ".hm-hov .hm-cell { opacity: .55; }",
      ".hm-hov .hm-cell.hm-x { opacity: 1; }",
      ".hm-cell.hm-at { position: relative; z-index: 1; opacity: 1; box-shadow: 0 0 0 2px var(--ink), 0 0 0 4px var(--surface); }",
    ]) expect(APP_CSS).toContain(rule);
  });
});
