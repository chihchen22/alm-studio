/**
 * By kind keeps its identity columns in view (ALM Studio Polish 6 T2). Family, Selector and Parameter are sticky at
 * widths each page sizes from its own longest text, header label included (Task 6 fix I2), each left offset the sum
 * of the widths before it, with an opaque background that the row hover still reaches and a line on the Parameter
 * cell's right edge; their header cells stick top and left above the set headers; a set header wraps at its hyphens
 * and puts Edit on its own line. Studio tests have no layout engine, so this pins the widths, the rules and the
 * markup; the drive measures the columns at 1440 px. Widths, rule and markup texts are restated here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet } from "@alm/engine";
import { byKindModel, identityWidths } from "../assumptions/byKindModel";
import { ByKindView } from "../pages/assumptions/ByKindPage";

const APP_CSS = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../../design/components.css", import.meta.url), "utf8");

describe("identityWidths, By kind's identity widths per page", () => {
  // Each width, in px, is the column's longest text at the 12 px cell size (a mono character 0.61 em, a body-face
  // character 0.55 em, a header-label character 0.75 em), rounded up, plus 24 px of cell padding, plus 1 px on
  // Parameter for the line on its right edge.
  const row = (familyId: string, selector: string, path: string) => ({ key: `${familyId}|${path}`, familyId, selector, path, cells: [] });
  it("sizes the Decay page from its longest values: dda, lcr-category: retail-other, params.buckets[0].repBalance", () => {
    const rows = [
      row("dda", "whole family", "params.closureSteady"),
      row("mma", "lcr-category: retail-other", "params.buckets[0].repBalance"),
    ];
    // Family: the label (6 x 0.75 x 12 = 54) outruns dda (3 x 0.61 x 12 = 21.96). Selector: 26 x 0.55 x 12 = 171.6.
    // Parameter: 28 x 0.61 x 12 = 204.96.
    expect(identityWidths(rows)).toEqual({ w1: 78, w2: 196, w3: 230 });
  });
  it("sizes the commitment page's Family from commit-liquidity-nonfinancial", () => {
    // Family: 29 x 0.61 x 12 = 212.28. Selector: whole family (12 x 0.55 x 12 = 79.2) outruns its label (72).
    // Parameter: rampRates[2] (12 x 0.61 x 12 = 87.84) outruns its label (9 x 0.75 x 12 = 81).
    expect(identityWidths([row("commit-liquidity-nonfinancial", "whole family", "rampRates[2]")])).toEqual({ w1: 237, w2: 104, w3: 113 });
  });
  it("falls back to the header labels when no row is longer", () => {
    // 54 + 24, 72 + 24, 81 + 25.
    expect(identityWidths([row("a", "b", "c")])).toEqual({ w1: 78, w2: 96, w3: 106 });
    expect(identityWidths([])).toEqual({ w1: 78, w2: 96, w3: 106 });
  });
});

describe("By kind's identity columns", () => {
  it("stick at the page's widths, each left offset the sum of the widths before it, 240, 168 and 232 px the fallbacks", () => {
    expect(APP_CSS).toContain(".by-kind th:nth-child(-n+3), .by-kind td:nth-child(-n+3) { position: sticky; z-index: 1; background: var(--surface); }");
    expect(APP_CSS).toContain(".by-kind th:nth-child(1), .by-kind td:nth-child(1) { left: 0; width: var(--w1, 240px); min-width: var(--w1, 240px); }");
    expect(APP_CSS).toContain(".by-kind th:nth-child(2), .by-kind td:nth-child(2) { left: var(--w1, 240px); width: var(--w2, 168px); min-width: var(--w2, 168px); }");
    expect(APP_CSS).toContain(".by-kind th:nth-child(3), .by-kind td:nth-child(3) { left: calc(var(--w1, 240px) + var(--w2, 168px)); width: var(--w3, 232px); min-width: var(--w3, 232px); border-right: 1px solid var(--line-2); }");
  });
  it("stick their header cells to the top as well, above the set headers", () => {
    expect(APP_CSS).toContain(".table-wrap thead th { position: sticky; top: 0; background: var(--surface); }");
    expect(APP_CSS).toContain(".by-kind th:nth-child(-n+3) { z-index: 2; }");
  });
  it("leave the row hover to the table's rule, which outranks the sticky background (0,2,3 over 0,2,1)", () => {
    expect(CSS).toContain(".table tbody tr:hover td { background: var(--surface-2); }");
    expect(APP_CSS).not.toMatch(/\.by-kind[^{}]*:hover/);
  });
});

describe("a By kind set header", () => {
  it("wraps at its hyphens and puts Edit on its own line", () => {
    expect(APP_CSS).toContain(".by-kind th:nth-child(n+4) { white-space: normal; }");
    expect(APP_CSS).toContain(".by-kind th:nth-child(n+4) a { display: block; }");
  });
  it("sits on the header band's floor, as every By kind header cell does, so each Edit is on one line (Task 6 fix M1)", () => {
    // Scoped to the By kind table: .table th sets no vertical-align anywhere else.
    expect(APP_CSS).toContain(".by-kind th { vertical-align: bottom; }");
    expect(CSS).not.toMatch(/\.table th[^{}]*\{[^}]*vertical-align/);
  });
  it("sits in the by-kind table, which carries the page's identity widths; the header and the row markup are otherwise as before", () => {
    const set = {
      schemaVersion: "1.0.0", id: "demo-behavioral-v1", label: "Demo",
      bindings: [{ familyId: "dda", overlay: { kind: "nmd-decay", params: { closureSteady: 0.75 } }, modelVersion: "kernel-nmd-decay-1" }],
    } as unknown as AssumptionSet;
    const html = renderToStaticMarkup(<ByKindView ws="ws-a" kinds={["nmd-decay"]} model={byKindModel([set], ["nmd-decay"])} query={{}} />);
    expect(html).toContain(
      '<table class="table by-kind" style="--w1:78px;--w2:104px;--w3:172px"><thead><tr><th scope="col">Family</th><th scope="col">Selector</th><th scope="col">Parameter</th><th scope="col" class="num" title="Demo">demo-behavioral-v1 <a href="#/ws/ws-a/assumptions/sets?set=demo-behavioral-v1" aria-label="Edit demo-behavioral-v1">Edit</a></th></tr></thead>',
    );
    expect(html).toContain('<tr><th scope="row" class="mono">dda</th><td class="words">whole family</td><td class="mono">params.closureSteady</td><td class="num words" title="0.75">0.75</td></tr>');
  });
});
