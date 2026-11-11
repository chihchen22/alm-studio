/**
 * Piece 2b acceptance (e): the pivot reads back off the stored envelope alone,
 * refuses typed when the envelope does not carry what was asked, and never
 * falls back to a family number dressed as a cell answer.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { Scenario } from "../../contracts/scenario";
import { resolveDefaultContext } from "../../run/engine";
import { buildRunResult } from "../../run/orchestrate";
import {
  BY_SEGMENT_VIEW,
  baseAssumptions,
  loadMarket,
  makeRunRequest,
  regulatoryScenarios,
  viewSegmentedBook,
} from "../../run/__tests__/fixtures";
import { pivot, PivotUnavailableError } from "../pivot";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

// NonNullable is required. makeRunRequest's second parameter carries a
// default, so Parameters<typeof makeRunRequest>[1] includes undefined and
// indexing it with ["views"] is TS2339. Task 6 hit this and fixed it the
// same way; do not drop the wrapper.
function run(views?: NonNullable<Parameters<typeof makeRunRequest>[1]>["views"]) {
  const book = viewSegmentedBook();
  const set = baseAssumptions("AS-PIVOT");
  return buildRunResult(
    makeRunRequest(market, {
      portfolioId: book.id,
      assumptionSets: [set],
      scenarios: regulatoryScenarios(set.id),
      ...(views !== undefined ? { views } : {}),
    }),
    book,
    // resolveDefaultContext takes ZERO arguments (run/engine.ts line 79).
    resolveDefaultContext(),
  );
}

/**
 * The same book and view over two scenarios: the base, and one that reinvests
 * dynamically. Nothing is hand-mutated; the dynamic scenario goes in on the
 * request and the engine builds the envelope it builds.
 */
function runWithDynamic() {
  const book = viewSegmentedBook();
  const set = baseAssumptions("AS-PIVOT-DYN");
  const dynamic: Scenario = {
    id: "SDYN",
    label: "dynamic new business",
    rateSpec: { kind: "parallel", shockBp: 100 },
    assumptionSetId: set.id,
    newBusiness: { mode: "dynamic", rules: [{ familyId: "FIXED", reinvest: "flat" }] },
  };
  return buildRunResult(
    makeRunRequest(market, {
      portfolioId: book.id,
      assumptionSets: [set],
      scenarios: [regulatoryScenarios(set.id)[0]!, dynamic],
      views: [BY_SEGMENT_VIEW],
    }),
    book,
    resolveDefaultContext(),
  );
}

const near = (a: number, b: number): void => {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(b)));
};

/**
 * The typed refusal a query raises, so a case can assert on `detail` and not
 * only on the class. `toThrow(PivotUnavailableError)` alone cannot tell the
 * three refusal reasons apart: an implementation that raised the view refusal
 * for every one of them would satisfy it.
 */
function refusal(query: () => unknown): PivotUnavailableError {
  try {
    query();
  } catch (e) {
    if (e instanceof PivotUnavailableError) return e;
    throw e;
  }
  throw new Error("the pivot answered where a typed refusal was expected");
}

describe("pivot", () => {
  it("returns one row per group, in the view's group order, for a bucketed metric", () => {
    const r = run([BY_SEGMENT_VIEW]);
    const out = pivot(r, { viewId: "by-segment", metric: "balance", scenarioId: "S0" });
    expect(out.groupBy).toEqual(["segment"]);
    expect(out.rows.map((x) => x.key.segment)).toEqual(["rate-shopper", "relationship", "whole-book"]);
    expect(out.rows.map((x) => x.positionCount)).toEqual([2, 1, 3]);
    expect(out.rows[0]!.cellIds).toEqual(['DDA|{"segment":"rate-shopper"}']);
  });

  it("the rows sum bucket-wise to the run total, which it also returns", () => {
    const r = run([BY_SEGMENT_VIEW]);
    const out = pivot(r, { viewId: "by-segment", metric: "principal", scenarioId: "S0" });
    const scn = r.cashflows.byScenario.find((s) => s.scenarioId === "S0")!;
    const bookTotal = scn.byCell!.reduce<number[]>((acc, c) => {
      c.series.principal.forEach((v, k) => (acc[k] = (acc[k] ?? 0) + v));
      return acc;
    }, []);
    for (let k = 0; k < bookTotal.length; k++) {
      near(out.rows.reduce((a, x) => a + x.series![k]!, 0), bookTotal[k]!);
      near((out.total as number[])[k]!, bookTotal[k]!);
    }
  });

  it("is byte-identical run twice on one envelope", () => {
    const r = run([BY_SEGMENT_VIEW]);
    const q = { viewId: "by-segment", metric: "interest", scenarioId: "S100" } as const;
    expect(JSON.stringify(pivot(r, q))).toBe(JSON.stringify(pivot(r, q)));
  });

  it("returns band rows for a gap metric, with the bands beside them", () => {
    const r = run([BY_SEGMENT_VIEW]);
    const out = pivot(r, { viewId: "by-segment", metric: "repricing", scenarioId: "S0" });
    const ladder = r.gap.repricing.find((l) => l.scenarioId === "S0")!;
    expect(out.bands!.map((b) => b.label)).toEqual(ladder.rows.map((x) => x.band.label));
    expect(out.rows[0]!.series!.length).toBe(ladder.rows.length);
    for (let b = 0; b < ladder.rows.length; b++) {
      near(out.rows.reduce((a, x) => a + x.series![b]!, 0), ladder.rows[b]!.gap);
    }
  });

  it("returns the additive NII fields for metric nii", () => {
    const r = run([BY_SEGMENT_VIEW]);
    const out = pivot(r, { viewId: "by-segment", metric: "nii", scenarioId: "S0" });
    const scn = r.nii.byScenario.find((s) => s.scenarioId === "S0")!;
    expect(out.rows.every((x) => x.series === undefined && x.value === undefined)).toBe(true);
    near(out.rows.reduce((a, x) => a + x.nii!.net12, 0), scn.totalNet12);
    near(out.total as number, scn.totalNet12);
  });

  it("returns a scalar for metric evePv", () => {
    const r = run([BY_SEGMENT_VIEW]);
    const out = pivot(r, { viewId: "by-segment", metric: "evePv", scenarioId: "S0" });
    const scn = r.eve.byScenario.find((s) => s.scenarioId === "S0")!;
    expect(out.rows.every((x) => typeof x.value === "number")).toBe(true);
    near(out.total as number, scn.pvAssets + scn.pvLiabilities);
  });

  it("refuses an unknown view, naming what the envelope holds", () => {
    const r = run([BY_SEGMENT_VIEW]);
    const err = (() => {
      try {
        pivot(r, { viewId: "by-vintage", metric: "balance", scenarioId: "S0" });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(PivotUnavailableError);
    expect((err as PivotUnavailableError).message).toContain("by-vintage");
    expect((err as PivotUnavailableError).message).toContain("by-segment");
  });

  it("refuses an unknown scenario and an unknown metric, each saying which", () => {
    const r = run([BY_SEGMENT_VIEW]);
    expect(() => pivot(r, { viewId: "by-segment", metric: "balance", scenarioId: "S999" })).toThrow(
      PivotUnavailableError,
    );
    expect(() =>
      pivot(r, { viewId: "by-segment", metric: "ftpMargin" as never, scenarioId: "S0" }),
    ).toThrow(PivotUnavailableError);

    // The reason, not just the class. The view is known on both of these, so a
    // detail naming the view would be the wrong refusal wearing the right type.
    expect(
      refusal(() => pivot(r, { viewId: "by-segment", metric: "balance", scenarioId: "S999" })).detail,
    ).toContain("carries scenarios");
    expect(
      refusal(() => pivot(r, { viewId: "by-segment", metric: "ftpMargin" as never, scenarioId: "S0" }))
        .detail,
    ).toContain("is not a pivot metric");
  });

  /**
   * The dynamic asymmetry, off an ordinary run rather than a hand-built
   * envelope. Which metrics a dynamic scenario can answer is decided by which
   * stage each block's Cashflow edge points at (run/defaultPlan.ts):
   *
   *   cashflows, NII   st-nii depends on st-balance whenever any scenario is
   *                    dynamic, and the balance stage replaces that scenario's
   *                    envelope with the dynamic projection's own, which has no
   *                    cell index. No cells, so the pivot refuses.
   *   gap, EVE         st-gap and st-eve depend on st-cashflow even when a
   *                    balance stage exists, so both read the static
   *                    contractual series and carry its cells. The pivot
   *                    answers, off the static run-off, for every scenario.
   *
   * Four metrics refuse and three answer off one envelope. The answering half
   * is the assertion that would catch a future change to either carrier.
   */
  it("refuses the cell-less metrics on a dynamic scenario and still answers gap and EVE", () => {
    const r = runWithDynamic();
    // The scenario is on every block: what follows is a refusal for want of
    // cells, not for want of a scenario.
    const cf = r.cashflows.byScenario.find((s) => s.scenarioId === "SDYN")!;
    const scnNii = r.nii.byScenario.find((s) => s.scenarioId === "SDYN")!;
    const ladder = r.gap.repricing.find((l) => l.scenarioId === "SDYN")!;
    const scnEve = r.eve.byScenario.find((s) => s.scenarioId === "SDYN")!;
    expect(cf.byCell).toBeUndefined();
    expect(scnNii.byCell).toBeUndefined();
    expect(ladder.byCell).toBeDefined();
    expect(scnEve.byCell).toBeDefined();

    for (const m of ["balance", "principal", "interest", "nii"] as const) {
      expect(() => pivot(r, { viewId: "by-segment", metric: m, scenarioId: "SDYN" })).toThrow(
        PivotUnavailableError,
      );
    }

    const gap = pivot(r, { viewId: "by-segment", metric: "repricing", scenarioId: "SDYN" });
    expect(gap.rows.map((x) => x.key.segment)).toEqual([
      "rate-shopper",
      "relationship",
      "whole-book",
    ]);
    for (let b = 0; b < ladder.rows.length; b++) {
      near(gap.rows.reduce((a, x) => a + x.series![b]!, 0), ladder.rows[b]!.gap);
    }

    const eve = pivot(r, { viewId: "by-segment", metric: "evePv", scenarioId: "SDYN" });
    near(eve.total as number, scnEve.pvAssets + scnEve.pvLiabilities);

    // The refusal is per scenario, not per run: the static base scenario in the
    // same envelope keeps every metric.
    expect(pivot(r, { viewId: "by-segment", metric: "nii", scenarioId: "S0" }).rows.length).toBe(3);
  });

  it("refuses every metric on a no-view envelope rather than answering with family numbers", () => {
    const r = run();
    for (const m of ["balance", "repricing", "nii", "evePv"] as const) {
      expect(() => pivot(r, { viewId: "by-segment", metric: m, scenarioId: "S0" })).toThrow(
        PivotUnavailableError,
      );
    }
    // The reason says the run carries no cells at all, which is the one a
    // reader has to act on. The other branch of the view lookup, the run that
    // declares views and not this one, names what it does declare.
    expect(
      refusal(() => pivot(r, { viewId: "by-segment", metric: "balance", scenarioId: "S0" })).detail,
    ).toContain("declared no views");
  });
});
