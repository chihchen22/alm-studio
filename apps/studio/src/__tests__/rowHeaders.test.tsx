// apps/studio/src/__tests__/rowHeaders.test.tsx
/**
 * Row headers on the EVE tab and the Edit-a-set table (ALM Studio Polish 15 item 1). The first cell of each body row
 * in those tables names its row (a scenario, a key-rate node, a sum line, a month or a row number), so it is a
 * `<th scope="row">`, not a `<td>`. The body row header keeps the body cell's look (app.css), and the phone keeps it on
 * the body cell's layer under the pinned corner header.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet } from "@alm/engine";
import { EveTab } from "../pages/results/EveTab";
import { EditSetView, type EditSetViewProps } from "../pages/assumptions/EditSetPage";
import { draftSet } from "../assumptions/setEditModel";
import { DETAIL, freshResult } from "./fixtures/results";

const APP_CSS = readFileSync(fileURLToPath(new URL("../styles/app.css", import.meta.url)), "utf8");

/** The opening tag of the first cell of every body row in a markup string. */
function firstBodyCells(html: string): string[] {
  const bodies = [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].map((m) => m[1]!);
  return bodies.flatMap((b) => [...b.matchAll(/<tr[^>]*>(<t[dh][^>]*>)/g)].map((m) => m[1]!));
}

describe("EVE tab row headers", () => {
  const r = freshResult();
  r.eve.keyRate = {
    scenarioId: "S0", discountBasis: "all-in", bumpBp: 10,
    nodes: [{ tenorYears: 0.25, duration: 0.5 }, { tenorYears: 2, duration: 1.5 }],
    sum: 2, parallelReference: 2.001,
    convergence: { halvedBumpBp: 5, residualYears: -0.001, residualYearsAtHalvedBump: -0.00025, ratio: 4, converged: true },
  };
  r.eve.channels = { discountBasis: "all-in", byScenario: [{ scenarioId: "S100", eveBase: 5e8, eveShocked: 4e8, totalDelta: -1e8, projectionDelta: -3e7, discountingDelta: -6.9e7, interactionResidual: -1_234_567 }] };
  const html = renderToStaticMarkup(<EveTab ws="ws-a" runId="run-fixture" detail={DETAIL} result={r} query={{}} scenarioLabel={(id: string) => `Label ${id}`} />);

  it("every body row in all three EVE tables opens on a row header", () => {
    const cells = firstBodyCells(html);
    // The fixture's 5 scenarios (S0, S100, S-100, S200, S-200), then 2 node rows plus the sum and the parallel
    // reference, then 1 channel row: 10.
    expect(cells.length).toBe(10);
    expect(cells.filter((c) => !c.startsWith('<th scope="row"'))).toEqual([]);
  });

  it("the row headers carry their labels and the node tenor keeps its figure class", () => {
    expect(html).toContain('<th scope="row">Label S0 <span class="mono muted">S0</span></th>');
    expect(html).toContain('<th scope="row" class="num">0.25</th><td class="num">0.5</td>');
    expect(html).toContain('<th scope="row" class="num">2</th><td class="num">1.5</td>');
    expect(html).toContain('<th scope="row">Sum over nodes</th><td class="num">2</td>');
    expect(html).toContain('<th scope="row">Parallel reference</th><td class="num">2.001</td>');
    expect(html).toContain('<th scope="row">Label S100</th>');
  });
});

describe("Edit-a-set row headers", () => {
  const SET: AssumptionSet = {
    schemaVersion: "1.0.0", id: "squeeze", label: "Squeeze",
    bindings: [
      { familyId: "lines", overlay: { kind: "commitment-draw", rampRates: [0.35, 0.15], steadyRate: 0.02 }, modelVersion: "engine-commitment-draw-1" },
      {
        familyId: "dda",
        overlay: {
          kind: "nmd-decay",
          params: {
            closureSteady: 5, closureInitial: 5, closureTauMonths: 24, burnoutLambda: 0.1, maxRateDecay: 0, maxRateGrowth: 0, logisticK: 2, logisticMidpoint: 0,
            maPeriod: 24, regimeAlpha: 2, balanceSize: 1000000, sens: { gMin: 0.15, gMax: 1, bStar: 1100000, kappaB: 1.3 },
            buckets: [{ label: "small", repBalance: 100000, share: 0.6 }, { label: "large", repBalance: 5000000, share: 0.4 }],
          },
        },
        modelVersion: "kernel-nmd-decay-1",
      },
    ],
  };
  const props: EditSetViewProps = {
    sets: [{ id: "squeeze", label: "Squeeze", contentHash: "h" }], selected: "squeeze", draft: draftSet(SET), reading: false,
    loadError: null, listNote: null, saving: null, saveId: "squeeze-edit-1", note: null, book: null, bookId: null,
    bookNote: "Pick a book", stored: [], storedNote: null, onPick() {}, onDraft() {}, onSave() {}, onReread() {},
  };
  const html = renderToStaticMarkup(<EditSetView {...props} />);

  it("each month of a list and each row of a table opens on a row header", () => {
    const cells = firstBodyCells(html);
    // Two ramp months and two buckets.
    expect(cells.length).toBe(4);
    expect(cells.filter((c) => c !== '<th scope="row">')).toEqual([]);
    expect(html).toContain('<th scope="row">Month 1</th>');
    expect(html).toContain('<th scope="row">Month 2</th>');
    expect(html).toContain('<th scope="row">Row 1</th>');
    expect(html).toContain('<th scope="row">Row 2</th>');
  });
});

describe("the body row header's look", () => {
  it("takes the body cell's face, ink, padding, rule and hover, not the column header's", () => {
    expect(APP_CSS).toContain(".table tbody th { font-size: inherit; font-weight: 500; text-transform: none; letter-spacing: normal; color: var(--ink); padding: var(--row-pad) var(--sp-3); border-bottom: 1px solid var(--line); white-space: normal; transition: background var(--t-fast); }");
    expect(APP_CSS).toContain(".table tbody tr:last-child th { border-bottom: 0; }");
    expect(APP_CSS).toContain(".table tbody tr:hover th { background: var(--surface-2); }");
  });

  it("sits on the body cell's layer when the phone pins the first column", () => {
    expect(APP_CSS).toContain(".table-wrap .table tbody th:first-child, .viz-table .table tbody th:first-child { z-index: 1; }");
  });
});

describe("the remaining body row headers keep their cell's look (Row header scope)", () => {
  // The Balance, FTP, Market and Govern row headers carry classes and content whose td rules name td: a mono id's size
  // and one line (components.css .table td.mono), a selected row's wash (desktop and the phone's pinned column), the
  // inventory's baseline and its meta and purpose lines. Each td rule gains a body th twin with the same declarations.
  it("restates each td rule for a body row header", () => {
    expect(APP_CSS).toContain(".table tbody th.mono { white-space: nowrap; font-size: var(--fs-1); }");
    expect(APP_CSS).toContain(".table .row-link.is-selected th { background: var(--accent-wash); }");
    expect(APP_CSS).toContain(".table tbody th .inv-meta, .table tbody th .purpose { display: block; margin-top: var(--sp-1); font-size: var(--fs-2); font-weight: 400; }");
    expect(APP_CSS).toContain(".table tbody th .purpose { max-width: 52ch; text-wrap: pretty; }");
    expect(APP_CSS).toContain(".inventory tbody th { vertical-align: baseline; }");
  });

  it("keeps the By kind family row header on the body cell's middle line, not the header band's floor (Row header scope 2)", () => {
    // .by-kind th sits every header cell on the band's floor; a body td takes the table's middle default, so its row
    // header twin restates middle after the header rule.
    const twin = ".by-kind tbody th { vertical-align: middle; }";
    expect(APP_CSS).toContain(twin);
    expect(APP_CSS.indexOf(twin)).toBeGreaterThan(APP_CSS.indexOf(".by-kind th { vertical-align: bottom; }"));
  });

  it("restates the phone's td rules inside the phone block, after their td originals", () => {
    const phone = APP_CSS.slice(APP_CSS.indexOf("@media (max-width: 900px) {"));
    const wash = "  .table-wrap .table .row-link.is-selected th:first-child { background: linear-gradient(var(--accent-wash), var(--accent-wash)), var(--surface); }";
    const purpose = "  .table tbody th .purpose { max-width: 100%; white-space: normal; }";
    expect(phone).toContain(wash);
    expect(phone).toContain(purpose);
    expect(phone.indexOf(wash)).toBeGreaterThan(phone.indexOf(".table-wrap .table .row-link.is-selected td:first-child"));
    expect(phone.indexOf(purpose)).toBeGreaterThan(phone.indexOf(".table td .purpose { max-width: 100%; white-space: normal; }"));
  });
});
