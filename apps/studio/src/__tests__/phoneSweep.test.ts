/**
 * The page sweep on a phone (ALM Studio phone 1 Task 2). One block at the end of app.css, which loads last, so its rules win over both stylesheets. Studio
 * tests have no layout engine: this pins the rules; the review's 390 px probe measures them, and the desktop
 * probe holds every box above 900 px (band 900). Rule texts are restated here.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CatalogRunInputs, CatalogRunListItem } from "@alm/reader";
import { AuditView } from "../pages/govern/GovernPages";

const APP_CSS = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
const OPEN = "@media (max-width: 900px) {";

function band(css: string): string[] {
  const i = css.indexOf(OPEN);
  let depth = 1;
  let j = i + OPEN.length;
  for (; depth > 0; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}") depth--;
  }
  expect(css.slice(j).trim()).toBe("");
  return [...css.slice(i + OPEN.length, j - 1).replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/[^{}]+\{[^{}]*\}/g)].map((m) => m[0].replace(/\s+/g, " ").trim());
}

const rules = band(APP_CSS);
const has = (list: string[]) => { for (const r of list) expect(rules).toContain(r); };

describe("the page sweep's phone block in app.css", () => {
  it("drops every grid of two or more columns to one, and half-width cards to full width", () => {
    has([
      ".grid-2, .grid-3 { grid-template-columns: minmax(0, 1fr); }",
      ".content > .side, .content > .half { grid-column: 1 / -1; }",
    ]);
  });
  it("stacks a key-value list, label above value", () => {
    has([
      ".kv { grid-template-columns: minmax(0, 1fr); gap: var(--sp-1) 0; }",
      ".kv dd + dt { margin-top: var(--sp-2); }",
    ]);
  });
  it("wraps long mono ids and hashes anywhere outside tables, a button's included", () => {
    // A card head's actions wrap at every width now (band 900), so their rule is in the base, not here (phoneGate).
    has([
      ".kv dd.mono, .kv dd .mono, .card-foot .mono, .card-title .mono, .card-desc .mono, .head-meta .mono, figcaption .mono, .btn .mono { overflow-wrap: anywhere; min-width: 0; }",
      ".content .btn { max-width: 100%; height: auto; min-height: 32px; padding-top: var(--sp-1); padding-bottom: var(--sp-1); text-align: left; }",
      ".content .btn .mono { white-space: normal; line-height: 1.3; }",
    ]);
  });
  it("keeps table cells on one line inside their sideways scroller, the first column sticky", () => {
    has([
      ".table-wrap .table th, .table-wrap .table td { white-space: nowrap; }",
      ".viz-table { overflow-x: auto; }",
      ".viz-table:not([open]) > :not(summary) { display: none; }",
      ".table-wrap .table th:first-child, .viz-table .table th:first-child { position: sticky; left: 0; z-index: 3; background: var(--surface); }",
      ".table-wrap .table td:first-child, .viz-table .table td:first-child { position: sticky; left: 0; z-index: 1; background: var(--surface); }",
      ".table-wrap .table .row-link.is-selected td:first-child { background: linear-gradient(var(--accent-wash), var(--accent-wash)), var(--surface); }",
    ]);
  });
  it("sizes the sticky first column to its content, capped at the phone 1 bound, and lets it wrap, so it never covers the value columns nor is squeezed by them (final review Finding 1, phone 2)", () => {
    // The cap, calc(45vw - 16px): 159.5 px at 390, 48% of a 332 px table-card scroller and 52% of a 308 px plain-card
    // one; 146 px at 360 (52.5% of 278); 389 px at 900 (47.6% of 818, the 900 px window less its 16 px sides, the
    // card's 24 px pads and its 1 px borders). The share falls as the window widens, so it is always under the probe's
    // 55% from 360 to 900 px. A table laid out at its max-content width is never squeezed, so each column takes its
    // max-content contribution, which for the first is its one-line width clamped by its max-width: a 64 px Point
    // column stays 64 px, not 160.
    has([
      ".table-wrap .table:not(.inventory), .viz-table .table { width: max-content; }",
      ".table-wrap .table th:first-child, .table-wrap .table td:first-child, .viz-table .table th:first-child, .viz-table .table td:first-child { width: auto; min-width: 0; max-width: calc(45vw - 16px); white-space: normal; overflow-wrap: anywhere; }",
    ]);
    // The phone 1 rule that fixed every first column at the cap is gone from every table but the inventory.
    expect(rules.filter((r) => r.includes("min-width: calc(45vw - 16px)"))).toEqual([
      ".table-wrap .inventory th:first-child, .table-wrap .inventory td:first-child { width: calc(45vw - 16px); min-width: calc(45vw - 16px); }",
    ]);
  });
  it("keeps the inventory at the phone 1 layout: a full-width table whose Consumes and Produces wrap between ids, its Component column fixed at the cap and after the shared rule, which it outranks by order", () => {
    // Laid out at max-content, the inventory's .mono.wrap cells would each take one line; its Component column holds
    // prose, so it would sit at the cap anyway.
    const shared = rules.indexOf(".table-wrap .table th:first-child, .table-wrap .table td:first-child, .viz-table .table th:first-child, .viz-table .table td:first-child { width: auto; min-width: 0; max-width: calc(45vw - 16px); white-space: normal; overflow-wrap: anywhere; }");
    const inventory = rules.indexOf(".table-wrap .inventory th:first-child, .table-wrap .inventory td:first-child { width: calc(45vw - 16px); min-width: calc(45vw - 16px); }");
    expect(shared).toBeGreaterThan(-1);
    expect(inventory).toBeGreaterThan(shared);
  });
  it("wraps the inventory's purpose inside the pinned Component column, and its id at its hyphens first, inside a dotted segment only where one cannot fit (final review Finding 2)", () => {
    has([
      ".inventory .inv-id { white-space: normal; overflow-wrap: anywhere; }",
      ".table td .purpose { max-width: 100%; white-space: normal; }",
    ]);
  });
  it("lets the inventory's table box run the page's length, not a nested 338 px scroller of one row (fix round 2)", () => {
    // The markup is <div className="table-wrap"><table className="table inventory">; useWholeRows reads a max-height of
    // none as a non-finite cap and leaves the box alone, so the desktop whole-row fit is untouched.
    has([".table-wrap:has(> .inventory) { max-height: none; }"]);
    expect(rules.filter((r) => r.includes("max-height: none"))).toEqual([".table-wrap:has(> .inventory) { max-height: none; }"]);
  });
  it("holds the audit log's Run column to about 35% of its scroller, a run id on two lines at its hyphen (phone 2)", () => {
    // A run id is run-YYYYMMDD-HHMMSS-xxxxxxx: it breaks after its date into "run-20260927-" (13 characters) and
    // "183526-001e52d" (14). The cell is mono at 12 px, 7.2 px a character, so 14ch is 100.8 px; with the 12 px left
    // pad and a 4 px slack in place of the right pad the column is 116.8 px, 35.2% of the 332 px table-card scroller
    // at 390 (phone 1: 160 px, 48%). The header cell takes the same bound in its own font and reads RUN well inside it.
    has([".table-wrap .table.audit-log th:first-child, .table-wrap .table.audit-log td:first-child { max-width: calc(14ch + var(--sp-3) + var(--sp-1)); padding-right: 0; }"]);
    // It follows the shared first-column rule, which it outranks by specificity as well.
    expect(rules.indexOf(".table-wrap .table.audit-log th:first-child, .table-wrap .table.audit-log td:first-child { max-width: calc(14ch + var(--sp-3) + var(--sp-1)); padding-right: 0; }"))
      .toBeGreaterThan(rules.indexOf(".table-wrap .table th:first-child, .table-wrap .table td:first-child, .viz-table .table th:first-child, .viz-table .table td:first-child { width: auto; min-width: 0; max-width: calc(45vw - 16px); white-space: normal; overflow-wrap: anywhere; }"));
    // No other rule in the band names the class.
    expect(rules.filter((r) => r.includes("audit-log"))).toHaveLength(1);
  });
  it("marks the audit log's table, with audit-log, and not the opened run's inputs table below it", () => {
    const runs = [{ runId: "run-20260927-183526-001e52d", state: "done", label: "Base book", submittedAt: null, endedAt: null, elapsedMs: null, platformRequestHash: "prh", engineInputsHash: null, resultContentHash: null }] as CatalogRunListItem[];
    const inputs = {
      runId: "run-20260927-183526-001e52d", state: "done", seed: null, grid: null, engineContext: null, platformRequestHash: "prh",
      engineInputsHash: null, resultContentHash: null, resultBytes: null, submittedAt: null, endedAt: null,
      inputs: [{ role: "portfolio", ord: 0, collection: "portfolios", id: "book-1", contentHash: "sha256:book" }],
    } as CatalogRunInputs;
    const html = renderToStaticMarkup(createElement(AuditView, { ws: "ws-a", runs, query: {}, open: "run-20260927-183526-001e52d", opened: { inputs, plan: { kind: "skipped", state: "done" } } }));
    expect(html).toContain('<section class="card table-card" aria-label="Run audit log"><div class="card-title">Run audit log</div><div class="table-wrap"><table class="table audit-log">');
    expect(html.match(/audit-log/g)).toHaveLength(1);
    expect(html).toContain('<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Role</th>');
  });
  it("keeps only the Family column sticky on a By kind table, so the set columns have room, and a set header on one line level with the identity headers", () => {
    has([
      ".by-kind th:nth-child(2), .by-kind td:nth-child(2), .by-kind th:nth-child(3), .by-kind td:nth-child(3) { position: static; }",
      ".by-kind th:nth-child(n+4) a { display: inline; }",
    ]);
  });
  it("holds the heatmap's expiry column while the grid scrolls, and lets the ramp legend take the card's width", () => {
    has([
      ".hm-scroll .hm-row, .hm-scroll .hm-col:first-child { position: sticky; left: 0; z-index: 2; background: var(--surface); }",
      ".ramp-legend .ramp, .ramp-legend .ramp-names { width: auto; flex: 1 1 160px; }",
    ]);
  });
  it("lays the treemap out as a ranked list of bars, each as long as its share of the largest", () => {
    has([
      ".treemap { display: grid; gap: var(--sp-1); height: auto !important; overflow: visible; background: transparent; }",
      ".treemap-cell { position: static; width: auto !important; height: auto !important; padding: var(--sp-1) var(--sp-2); border-radius: var(--r-1); background: linear-gradient(to right, var(--surface-2) var(--share), transparent var(--share)); }",
    ]);
  });
});
