/**
 * The results label for the B3a index kinds.
 *
 * Markets, both on the public pack:
 *   indexed:  the seeded rfr-1m, rfr-3m (basis 0) and prime-demo.
 *   formulas: indexed plus a ten-year constant-maturity swap (cms-10y) and three formulas, as the run tests
 *             build them, except that admin-rate (beta 0.4 on rfr-1m from 4.33 percent) is set two months late with
 *             a 0 percent floor and an 8 percent cap.
 *   formulasDerived: formulas plus the B2 flat 25 bp derived curve, named by rfr-3m re-set with a 10 bp basis.
 *
 * One Informational note, plan.rate-index.formula, beside the B2 note plan.derived-curve.index-only (unchanged):
 * each index the run reads with its formula text and only the caveats that apply. Ids and sentences are restated as
 * literals, never read back from the code under test.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { PortfolioSpec, Position, PositionTerms } from "../../contracts/position";
import { deriveMarketSnapshot } from "../../market/deriveMarketSnapshot";
import { rateIndexFormulaNote } from "../../rateIndex/formulaNote";
import { runStochastic, STOCHASTIC_SHOCKED_SCENARIOS_LAYER } from "../../run/stochastic";
import { AS_OF, baseAssumptions, loadMarket, makeRunRequest, twoSidedBook } from "../../run/__tests__/fixtures";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { compilePlan } from "../compile";
import { fixturePlan, loadPolicy } from "./fixtures";

const BASE_ID = "market-public-2026-03-31";
const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 0 },
  { op: "set-index", id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basisBp: 300 },
];
const FORMULA_OPS = [
  { op: "set-index", id: "cms-10y", label: "Ten-year swap rate (demonstration index)", kind: "constant-maturity-swap", tenorYears: 10, basisBp: 0 },
  { op: "set-index", id: "admin-rate", label: "Administered rate, 40 percent of the one-month change (demonstration values)", kind: "formula", parent: "rfr-1m", beta: 0.4, startBp: 433, basisBp: 0 },
  { op: "set-index", id: "cms-lag", label: "Half the ten-year swap change, three months late (demonstration values)", kind: "formula", parent: "cms-10y", beta: 0.5, startBp: 400, lagMonths: 3, basisBp: 0 },
  { op: "set-index", id: "level-1", label: "The three-month rate through a formula (demonstration values)", kind: "formula", parent: "rfr-3m", coefficient: 1, basisBp: 0 },
];
const TASK6_OPS = [FORMULA_OPS[0]!, { ...FORMULA_OPS[1]!, lagMonths: 2, floorBp: 0, capBp: 800 }, FORMULA_OPS[2]!, FORMULA_OPS[3]!];

/** The B2 derived curve (derivedSpreadRun.test.ts): flat 25 bp, named by rfr-3m re-set with a 10 bp basis. */
const FLAT_25 = { id: "flat-25", label: "Flat 25 bp", base: "platform-default", spreads: [{ tenorMonths: 1, spreadBp: 25 }] };
const DERIVE_OPS = [
  { op: "set-derived-curve", curve: FLAT_25 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 10, spreadCurve: "flat-25" },
];

let formulas: MarketSnapshot;
/** formulas plus the B2 derived curve on the rfr-3m window, which level-1 reads as its parent. */
let formulasDerived: MarketSnapshot;
beforeAll(async () => {
  const indexed = deriveMarketSnapshot(structuredClone(await loadMarket()), SEED_OPS, { baseId: BASE_ID }).snapshot;
  formulas = deriveMarketSnapshot(structuredClone(indexed), TASK6_OPS, { baseId: BASE_ID }).snapshot;
  formulasDerived = deriveMarketSnapshot(structuredClone(formulas), DERIVE_OPS, { baseId: BASE_ID }).snapshot;
});

function floaterPosition(id: string, rateIndexId?: string, notional = 1_000_000): Position {
  const terms = {
    id,
    type: "floating-loan",
    notional,
    maturityMonths: 12,
    originationOffsetMonths: 0,
    amortType: "bullet",
    side: "asset",
    indexTenorMonths: 1,
    margin: 0.0125,
    resetFrequencyMonths: 1,
    ...(rateIndexId !== undefined ? { rateIndexId } : {}),
  } as unknown as PositionTerms;
  return { id, familyId: "floaters", coaNodeId: "floaters", terms };
}

function handBook(id: string, positions: Position[]): PortfolioSpec {
  return {
    id,
    label: "hand book H",
    asOf: AS_OF,
    coa: {
      schemaVersion: "1.0.0",
      nodes: [
        { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
        { id: "floaters", label: "Floaters", parentId: "assets", side: "asset", isLeaf: true, familyId: "floaters", order: 0 },
      ],
      families: [{ id: "floaters", label: "Floaters", side: "asset", instrumentType: "floating-loan", coaNodeId: "floaters" }],
    },
    positions,
  };
}

const request = (market: MarketSnapshot) =>
  makeRunRequest(market, {
    runId: "IK-NOTE-STO",
    portfolioId: "PF-STO",
    scenarios: [
      { id: "S0", label: "S0", rateSpec: { kind: "base" }, assumptionSetId: "AS-BASE", newBusiness: { mode: "static", rules: [] } },
    ],
    assumptionSets: [{ ...baseAssumptions(), bindings: [] }],
    grid: { horizonMonths: 360, asOf: AS_OF },
  });

describe("the rate index formula note (decision 43)", () => {
  const open: Array<{ dispose(): void }> = [];
  afterEach(() => {
    while (open.length > 0) open.pop()!.dispose();
  });
  const STAMPS = {
    runId: "RUN-1",
    seed: "42",
    timestamps: { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" },
  };
  function compileOn(market: MarketSnapshot, rateIndexId: string) {
    const b = twoSidedBook();
    const terms = {
      id: "F",
      type: "floating-loan",
      notional: 1_000_000,
      maturityMonths: 12,
      originationOffsetMonths: 0,
      amortType: "bullet",
      indexTenorMonths: 1,
      margin: 0.0125,
      resetFrequencyMonths: 1,
      rateIndexId,
    } as unknown as PositionTerms;
    const portfolio = { ...b, positions: [...b.positions, { id: "F", familyId: "FIXED", coaNodeId: "fixed-loans", terms }] };
    const c = compilePlan(
      fixturePlan(),
      { portfolio, marketSnapshot: market, assumptionSets: [baseAssumptions()], policy: loadPolicy(), libraries: SHIPPED_LIBRARIES },
      STAMPS,
    );
    open.push(c.harness);
    return c;
  }

  it("lists each index a floater reads with its formula text and the lag caveat", () => {
    const notes = compileOn(formulas, "admin-rate").notImplemented.filter((n) => n.layer === "plan.rate-index.formula");
    expect(notes.length).toBe(1);
    expect(notes[0]!.reason).toBe(
      "the run reads these rate indices: admin-rate: formula on rfr-1m, beta (change) 0.4 from a start of 4.33 percent plus basis, lag 2 months, floor 0 percent, cap 8 percent, basis 0 bp; " +
        "rfr-1m: compounded window, 1 month, basis 0 bp. " +
        "Until its lag has run, a lagged index reads its parent's cut-off value on the run's unshocked curve.",
    );
  });
  it("a constant-maturity-swap read carries the convexity caveat on a deterministic run only", () => {
    const det = rateIndexFormulaNote([{ id: "cms-10y", label: "x", kind: "constant-maturity-swap", tenorYears: 10, basis: 0 }], "deterministic")!;
    expect(det.reason).toBe(
      "the run reads these rate indices: cms-10y: constant-maturity swap, 10 years, basis 0 bp. " +
        "A constant-maturity swap index reads the path's forward par swap rate with no convexity adjustment.",
    );
    expect(rateIndexFormulaNote([{ id: "cms-10y", label: "x", kind: "constant-maturity-swap", tenorYears: 10, basis: 0 }], "stochastic")!.reason).toBe(
      "the run reads these rate indices: cms-10y: constant-maturity swap, 10 years, basis 0 bp.",
    );
  });
  it("a lagged formula on a swap index: the convexity caveat then the lag caveat when compiled, the lag caveat alone on the stochastic arm", () => {
    const list =
      "the run reads these rate indices: cms-lag: formula on cms-10y, beta (change) 0.5 from a start of 4 percent plus basis, lag 3 months, floor none, cap none, basis 0 bp; " +
      "cms-10y: constant-maturity swap, 10 years, basis 0 bp.";
    const compiled = compileOn(formulas, "cms-lag").notImplemented.filter((n) => n.layer === "plan.rate-index.formula");
    expect(compiled.length).toBe(1);
    expect(compiled[0]!.reason).toBe(
      list +
        " A constant-maturity swap index reads the path's forward par swap rate with no convexity adjustment." +
        " Until its lag has run, a lagged index reads its parent's cut-off value on the run's unshocked curve.",
    );
    const book = handBook("PF-STO", [floaterPosition("F", "cms-lag")]);
    const stochastic = runStochastic(request(formulas), book, { nPaths: 20 }).notImplemented.filter((n) => n.layer === "plan.rate-index.formula");
    expect(stochastic.length).toBe(1);
    expect(stochastic[0]!.reason).toBe(list + " Until its lag has run, a lagged index reads its parent's cut-off value on the run's unshocked curve.");
  });
  it("a derived curve on a window and a formula read together: the B2 note first, unchanged, then the formula note", () => {
    const informational = compileOn(formulasDerived, "level-1").notImplemented.filter(
      (n) => n.layer === "plan.derived-curve.index-only" || n.layer === "plan.rate-index.formula",
    );
    expect(informational.map((n) => n.layer)).toEqual(["plan.derived-curve.index-only", "plan.rate-index.formula"]);
    // The B2 note's pre-B3a text, verbatim (derivedSpreadRun.test.ts).
    expect(informational[0]!.reason).toBe(
      "derived curve Flat 25 bp (flat-25) adds a constant spread to index resets only (rfr-3m); mortgages, client rates, new business and discounting read the base curve",
    );
    // The note lists the stored records: rfr-3m with its own 10 bp basis and the curve it names, not the folded sum.
    expect(informational[1]!.reason).toBe(
      "the run reads these rate indices: level-1: formula on rfr-3m, coefficient (level) 1, lag none, floor none, cap none, basis 0 bp; " +
        "rfr-3m: compounded window, 3 months, basis 10 bp, derived curve flat-25.",
    );
  });
  it("no note for a book reading compounded windows only, and the B2 note is untouched", () => {
    expect(compileOn(formulas, "rfr-3m").notImplemented.some((n) => n.layer === "plan.rate-index.formula")).toBe(false);
    expect(rateIndexFormulaNote([{ id: "rfr-3m", label: "x", tenorMonths: 3, basis: 0 }], "deterministic")).toBeUndefined();
  });
  it("the stochastic arm carries the note after its own, and none on compounded windows", () => {
    // P10: the imported constant is pinned to its literal; the expectations below restate the literal.
    expect(STOCHASTIC_SHOCKED_SCENARIOS_LAYER).toBe("stochastic.shocked-scenarios");
    const book = (id: string) => handBook("PF-STO", [floaterPosition("F", id)]);
    const layers = (id: string) => runStochastic(request(formulas), book(id), { nPaths: 20 }).notImplemented.map((n) => n.layer);
    expect(layers("admin-rate")).toEqual(["stochastic.shocked-scenarios", "plan.rate-index.formula"]);
    expect(layers("rfr-3m")).toEqual(["stochastic.shocked-scenarios"]);
  });
});
