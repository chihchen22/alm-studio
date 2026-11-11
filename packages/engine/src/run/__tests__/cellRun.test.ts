/**
 * Piece 2b acceptance (a), (b) and (c) for the cashflow block: a run with no
 * view carries no cell arm at all, and a run with one carries cells whose
 * series sum bucket-wise to the family series.
 *
 * The gap block, appended below, is the same three claims on both ladders, plus
 * the one the gap adds: a cell is signed by its family's declared side. Where a
 * family holds one cell, neither the headline rows nor the COA drill-down moves
 * because a reader asked for a second breakdown; a family holding several cells
 * sums them in cell order and may differ in the last bits, as the contract says.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { resolveDefaultContext } from "../engine";
import { buildRunResult, RUN_RESULT_SCHEMA_VERSION } from "../orchestrate";
import { buildCellPlan } from "../../portfolio/cells";
import {
  BY_SEGMENT_VIEW,
  baseAssumptions,
  loadMarket,
  makeRunRequest,
  regulatoryScenarios,
  viewSegmentedBook,
} from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

// The overrides parameter carries a default, so its declared type is
// `Partial<RunRequest> | undefined` and indexing it needs the NonNullable.
function run(views?: NonNullable<Parameters<typeof makeRunRequest>[1]>["views"]) {
  const book = viewSegmentedBook();
  const set = baseAssumptions("AS-VIEW");
  const request = makeRunRequest(market, {
    portfolioId: book.id,
    assumptionSets: [set],
    scenarios: regulatoryScenarios(set.id),
    ...(views !== undefined ? { views } : {}),
  });
  // resolveDefaultContext takes ZERO arguments (run/engine.ts line 79).
  return buildRunResult(request, book, resolveDefaultContext());
}

const near = (a: number, b: number): void => {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(b)));
};

describe("the cashflow cell block", () => {
  it("stamps 1.13.0 and carries NO cell arm when no view is declared", () => {
    const r = run();
    expect(RUN_RESULT_SCHEMA_VERSION).toBe("1.13.0");
    expect(r.schemaVersion).toBe("1.13.0");
    expect(r.cashflows.cells).toBeUndefined();
    expect(r.views).toBeUndefined();
    expect(r.cashflows.byScenario.every((s) => s.byCell === undefined)).toBe(true);
  });

  it("(b) writes the cell dictionary once and one series per cell per scenario", () => {
    const r = run([BY_SEGMENT_VIEW]);
    const cells = r.cashflows.cells!;
    expect(cells.filter((c) => c.familyId === "DDA").map((c) => [c.id, c.positionCount])).toEqual([
      ['DDA|{"segment":"rate-shopper"}', 2],
      ['DDA|{"segment":"relationship"}', 1],
    ]);
    for (const scn of r.cashflows.byScenario) {
      expect(scn.byCell!.map((c) => c.cellId)).toEqual(cells.map((c) => c.id));
    }
  });

  it("(c) the deposit family's two cells sum bucket-wise to its family series", () => {
    const r = run([BY_SEGMENT_VIEW]);
    const cells = r.cashflows.cells!;
    const dda = cells.map((c, i) => [c, i] as const).filter(([c]) => c.familyId === "DDA").map(([, i]) => i);
    expect(dda.length).toBe(2);
    for (const scn of r.cashflows.byScenario) {
      const fam = scn.byFamily.find((f) => f.familyId === "DDA")!;
      for (const metric of ["balance", "principal", "interest"] as const) {
        for (let k = 0; k < fam.series[metric].length; k++) {
          near(dda.reduce((a, i) => a + scn.byCell![i]!.series[metric][k]!, 0), fam.series[metric][k]!);
        }
      }
    }
  });

  it("a family holding one cell is BITWISE equal to its family series", () => {
    const r = run([BY_SEGMENT_VIEW]);
    const cells = r.cashflows.cells!;
    for (const id of ["FIXED", "MORTGAGE", "MMA"]) {
      const idx = cells.findIndex((c) => c.familyId === id);
      expect(cells.filter((c) => c.familyId === id)).toHaveLength(1);
      for (const scn of r.cashflows.byScenario) {
        const fam = scn.byFamily.find((f) => f.familyId === id)!;
        expect(scn.byCell![idx]!.series.principal).toEqual(fam.series.principal);
        expect(scn.byCell![idx]!.series.interest).toEqual(fam.series.interest);
      }
    }
  });

  it("carries the view membership and no numbers on it", () => {
    const r = run([BY_SEGMENT_VIEW]);
    expect(r.views!.map((v) => [v.viewId, v.label, v.groupBy])).toEqual([
      ["by-segment", "By segment", ["segment"]],
    ]);
    const groups = r.views![0]!.groups;
    expect(groups.map((g) => [g.key.segment, g.positionCount])).toEqual([
      ["rate-shopper", 2],
      ["relationship", 1],
      ["whole-book", 3],
    ]);
    // Every cell id a group names is in the dictionary, and P4 holds on groups.
    const ids = new Set(r.cashflows.cells!.map((c) => c.id));
    expect(groups.flatMap((g) => g.cellIds).every((id) => ids.has(id))).toBe(true);
    expect(groups.reduce((a, g) => a + g.positionCount, 0)).toBe(viewSegmentedBook().positions.length);
  });

  it("the cell series is a COPY, so nothing downstream writes through a shared array", () => {
    const r = run([BY_SEGMENT_VIEW]);
    const cells = r.cashflows.cells!;
    // MMA holds one cell, so foldCellsToFamilies ALIASES the cell sink array
    // into the family slot. If the envelope shared that array rather than
    // copying it, writing one row would move the other.
    const idx = cells.findIndex((c) => c.familyId === "MMA");
    const scn = r.cashflows.byScenario[0]!;
    const fam = scn.byFamily.find((f) => f.familyId === "MMA")!;
    const cell = scn.byCell![idx]!;
    expect(cell.series.principal).not.toBe(fam.series.principal);
    const before = fam.series.principal[0]!;
    cell.series.principal[0] = before + 1234.5;
    expect(fam.series.principal[0]).toBe(before);
  });
});

describe("the gap cell block", () => {
  it("carries no byCell arm when no view is declared", () => {
    const r = run();
    expect(r.gap.repricing.every((l) => l.byCell === undefined)).toBe(true);
    expect(r.gap.liquidity.every((l) => l.byCell === undefined)).toBe(true);
    // ABSENT, not present-and-undefined: the key never lands, so JSON.stringify
    // emits nothing rather than a slot a reader could mistake for an answer.
    expect(r.gap.repricing.every((l) => !Object.hasOwn(l, "byCell"))).toBe(true);
    expect(r.gap.liquidity.every((l) => !Object.hasOwn(l, "byCell"))).toBe(true);
  });

  it("emits one banded row set per cell, in cell order, on both ladders", () => {
    const r = run([BY_SEGMENT_VIEW]);
    const ids = r.cashflows.cells!.map((c) => c.id);
    for (const ladder of [...r.gap.repricing, ...r.gap.liquidity]) {
      expect(ladder.byCell!.map((c) => c.cellId)).toEqual(ids);
      expect(ladder.byCell![0]!.rows.map((x) => x.band)).toEqual(ladder.rows.map((x) => x.band));
    }
  });

  it("signs a cell by its family's side and leaves the headline rows untouched", () => {
    const withView = run([BY_SEGMENT_VIEW]);
    const without = run();
    for (const kind of ["repricing", "liquidity"] as const) {
      for (let s = 0; s < withView.gap[kind].length; s++) {
        expect(JSON.stringify(withView.gap[kind][s]!.rows)).toBe(
          JSON.stringify(without.gap[kind][s]!.rows),
        );
        // The COA drill-down folds over families too, so it does not move either.
        expect(JSON.stringify(withView.gap[kind][s]!.byCoaNode)).toBe(
          JSON.stringify(without.gap[kind][s]!.byCoaNode),
        );
      }
    }
    // DDA is a liability family, so its cells book in the liabilities column only.
    const dda = withView.cashflows.cells!
      .map((c, i) => [c, i] as const)
      .filter(([c]) => c.familyId === "DDA");
    for (const [, i] of dda) {
      const rows = withView.gap.liquidity[0]!.byCell![i]!.rows;
      expect(rows.every((x) => x.assets === 0)).toBe(true);
    }
  });

  it("the deposit family's cells sum band-wise to its COA leaf rows", () => {
    const r = run([BY_SEGMENT_VIEW]);
    const cells = r.cashflows.cells!;
    const dda = cells.map((c, i) => [c, i] as const).filter(([c]) => c.familyId === "DDA").map(([, i]) => i);
    for (const kind of ["repricing", "liquidity"] as const) {
      const ladder = r.gap[kind][0]!;
      const leaf = ladder.byCoaNode.find((n) => n.coaNodeId === "dda")!;
      for (let b = 0; b < leaf.rows.length; b++) {
        near(dda.reduce((a, i) => a + ladder.byCell![i]!.rows[b]!.liabilities, 0), leaf.rows[b]!.liabilities);
      }
    }
  });
});

/**
 * The cross-run EXACT assertions below hold only because every family's
 * positions are CELL-CONTIGUOUS in book order and its cells appear in
 * cell-index order. On this fixture the deposit family runs D1, D2
 * (rate-shopper, book positions 2 and 4) then D3 (relationship, position 5), so
 * the cell fold associates as ((0 + D1) + D2) + (0 + D3), which is bitwise the
 * direct fold's ((0 + D1) + D2) + D3 because 0 + x is x for a finite x.
 * Interleave the segments and the association changes, the last bits move, and
 * the toBe assertions fail with no production-code change behind them.
 *
 * Call this FIRST in any test that asserts toBe across two runs, so an
 * interleaving change fails loudly on this precondition and not mysteriously on
 * a number three assertions later.
 */
function assertCellContiguousWithinFamilies(): void {
  const book = viewSegmentedBook();
  const plan = buildCellPlan(book, [BY_SEGMENT_VIEW]);
  for (const family of book.coa.families) {
    const runs: number[] = [];
    book.positions.forEach((pos, p) => {
      if (pos.familyId !== family.id) return;
      const c = plan.cellIndexByPosition[p]!;
      if (runs.at(-1) !== c) runs.push(c);
    });
    expect(runs, `${family.id}: each cell must occupy ONE contiguous run of its family's positions`).toEqual([
      ...new Set(runs),
    ]);
    expect(runs, `${family.id}: the family's cells must appear in cell-index order`).toEqual(
      [...runs].sort((a, b) => a - b),
    );
  }
}

describe("the NII cell block", () => {
  it("carries no byCell arm when no view is declared", () => {
    expect(run().nii.byScenario.every((s) => s.byCell === undefined)).toBe(true);
  });

  it("emits one row per cell in cell order, side-signed by the cell's family", () => {
    const r = run([BY_SEGMENT_VIEW]);
    const ids = r.cashflows.cells!.map((c) => c.id);
    for (const scn of r.nii.byScenario) expect(scn.byCell!.map((c) => c.cellId)).toEqual(ids);
    const dda = r.cashflows.cells!.findIndex((c) => c.familyId === "DDA");
    // A liability cell books expense, never income.
    expect(r.nii.byScenario[0]!.byCell![dda]!.interestIncome12).toBe(0);
    expect(r.nii.byScenario[0]!.byCell![dda]!.net12).toBeLessThanOrEqual(0);
  });

  it("the deposit family's cells sum to its family row, and the totals do not move", () => {
    assertCellContiguousWithinFamilies(); // the toBe assertions below depend on it
    const withView = run([BY_SEGMENT_VIEW]);
    const without = run();
    const cells = withView.cashflows.cells!;
    const dda = cells.map((c, i) => [c, i] as const).filter(([c]) => c.familyId === "DDA").map(([, i]) => i);
    for (let s = 0; s < withView.nii.byScenario.length; s++) {
      const scn = withView.nii.byScenario[s]!;
      const fam = scn.byFamily.find((f) => f.familyId === "DDA")!;
      near(dda.reduce((a, i) => a + scn.byCell![i]!.net12, 0), fam.net12);
      near(dda.reduce((a, i) => a + scn.byCell![i]!.net24, 0), fam.net24);
      // A total that moved because a reader asked for a breakdown is a defect.
      expect(scn.totalNet12).toBe(without.nii.byScenario[s]!.totalNet12);
      expect(scn.totalNet24).toBe(without.nii.byScenario[s]!.totalNet24);
      expect(JSON.stringify(scn.netMonthly)).toBe(JSON.stringify(without.nii.byScenario[s]!.netMonthly));
    }
  });
});

describe("the EVE cell block", () => {
  it("carries no byCell arm when no view is declared", () => {
    expect(run().eve.byScenario.every((s) => s.byCell === undefined)).toBe(true);
  });

  it("emits one pv per cell in cell order, and carries no duration on a cell", () => {
    const r = run([BY_SEGMENT_VIEW]);
    const ids = r.cashflows.cells!.map((c) => c.id);
    for (const scn of r.eve.byScenario) {
      expect(scn.byCell!.map((c) => c.cellId)).toEqual(ids);
      expect(scn.byCell!.every((c) => Object.keys(c).sort().join(",") === "cellId,pv")).toBe(true);
      expect(scn.byCell!.every((c) => Number.isFinite(c.pv))).toBe(true);
    }
  });

  it("the deposit family's cells sum to its family pv, and eve does not move", () => {
    // Same precondition as the NII block's cross-run case: the eve, pvAssets and
    // deltaEveVsBase toBe assertions below are bitwise only because every
    // family's positions are cell-contiguous in book order and its cells appear
    // in cell-index order. The helper is defined further up this file, between
    // the gap cell block and the NII cell block.
    assertCellContiguousWithinFamilies();
    const withView = run([BY_SEGMENT_VIEW]);
    const without = run();
    const cells = withView.cashflows.cells!;
    const dda = cells.map((c, i) => [c, i] as const).filter(([c]) => c.familyId === "DDA").map(([, i]) => i);
    for (let s = 0; s < withView.eve.byScenario.length; s++) {
      const scn = withView.eve.byScenario[s]!;
      const fam = scn.byFamily.find((f) => f.familyId === "DDA")!;
      near(dda.reduce((a, i) => a + scn.byCell![i]!.pv, 0), fam.pv);
      expect(scn.eve).toBe(without.eve.byScenario[s]!.eve);
      expect(scn.pvAssets).toBe(without.eve.byScenario[s]!.pvAssets);
      expect(scn.deltaEveVsBase).toBe(without.eve.byScenario[s]!.deltaEveVsBase);
    }
  });
});
