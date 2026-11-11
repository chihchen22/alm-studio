/**
 * Overlay-application tests.
 *
 * These prove the AssumptionSet is what actually drives the runoff: an overlay's
 * params replace the ones baked into a position's terms, and the effective book
 * reproduces the kernel instrument built from the OVERRIDDEN params exactly (and
 * differs from the un-overridden terms). Validation, the genuine
 * kernel-limitation failure (constant-cpr on a Mortgage), and the D5
 * incompatibility refusals (formerly silent skips) are covered too.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  BETA_S_CURVE_DEFAULTS,
  loadMarketSnapshot,
  MBS_DEFAULTS,
  Mortgage,
  MORTGAGE_DEFAULTS,
  NMDBeta,
  NMDeposit,
  NMD_B_TERMS_DEFAULTS,
  NMD_DEFAULTS,
  NMD_TERMS_DEFAULTS,
  type BetaSCurveParams,
  type MBSParams,
  type MarketSnapshot,
  type NMDParams,
  type NMDTerms,
  type RatePath,
  type ZeroCurve,
} from "@alm/kernel";
import { buildBaseCurve, buildRatePath } from "../../../scenario/rateEnvironment";
import {
  IncompatibleOverlayError,
  UnknownFamilyError,
} from "../../../scenario/resolveAssumptions";
import type { AssumptionSet } from "../../../contracts/assumptions";
import type { ChartOfAccounts } from "../../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../../contracts/position";
import type { BucketGrid } from "../../../contracts/results";
import type { Scenario } from "../../../contracts/scenario";
import { applyStaticOverlays, checkBindingOverlap, StaticOverlayError } from "../applyOverlays";
import { OverlappingBindingError } from "../../../run/executorErrors";
import {
  baseAssumptions,
  NMD_DEFAULT_PARAMS,
  RELATIONSHIP_NMD_PARAMS,
  segmentedAssumptions,
  segmentedNmdBook,
  twoSidedBook,
} from "../../../run/__tests__/fixtures";
import { projectStaticScenario } from "../staticRunoff";

const FIXTURE = fileURLToPath(
  new URL("../../../../../kernel/public/market_public.json", import.meta.url),
);
const HORIZON = 360;
const AS_OF = "2026-03-31";
const GRID: BucketGrid = { horizonMonths: HORIZON, asOf: AS_OF };

/** COA with a mortgage, a fixed loan, an interest-bearing NMD-B, and a non-IB NMD family. */
function makeCoa(): ChartOfAccounts {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "mortgages", label: "Mortgages", parentId: "assets", side: "asset", isLeaf: true, familyId: "MORTGAGE", order: 0 },
      { id: "fixed", label: "Fixed Loans", parentId: "assets", side: "asset", isLeaf: true, familyId: "FIXED", order: 1 },
      { id: "liab", label: "Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      { id: "mma", label: "MMA", parentId: "liab", side: "liability", isLeaf: true, familyId: "IB", order: 0 },
      { id: "dda", label: "DDA", parentId: "liab", side: "liability", isLeaf: true, familyId: "NONIB", order: 1 },
    ],
    families: [
      { id: "MORTGAGE", label: "Mortgages", side: "asset", instrumentType: "mortgage", coaNodeId: "mortgages" },
      { id: "FIXED", label: "Fixed Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "fixed" },
      { id: "IB", label: "MMA", side: "liability", instrumentType: "nmd-b", coaNodeId: "mma" },
      { id: "NONIB", label: "DDA", side: "liability", instrumentType: "nmd", coaNodeId: "dda" },
    ],
  };
}

function makePortfolio(positions: Position[]): PortfolioSpec {
  return { id: "PF", label: "book", asOf: AS_OF, coa: makeCoa(), positions };
}

const mortgagePos = (): Position => ({
  id: "M1",
  familyId: "MORTGAGE",
  coaNodeId: "mortgages",
  terms: { ...MORTGAGE_DEFAULTS, id: "M1", ageMonths: 60, maturityMonths: 300 },
});
const ibPos = (): Position => ({
  id: "B1",
  familyId: "IB",
  coaNodeId: "mma",
  terms: { ...NMD_B_TERMS_DEFAULTS, id: "B1" },
});
const nonIbPos = (): Position => ({
  id: "D1",
  familyId: "NONIB",
  coaNodeId: "dda",
  terms: { ...NMD_TERMS_DEFAULTS, id: "D1" },
});

const baseScenario: Scenario = {
  id: "BASE",
  label: "base",
  rateSpec: { kind: "base" },
  assumptionSetId: "AS",
  newBusiness: { mode: "static", rules: [] },
};

function assumptionSet(bindings: AssumptionSet["bindings"]): AssumptionSet {
  return { schemaVersion: "1.0.0", id: "AS", label: "test", bindings };
}

let snapshot: MarketSnapshot;
let base: ZeroCurve;
let path: RatePath;

beforeAll(async () => {
  snapshot = await loadMarketSnapshot(FIXTURE);
  base = buildBaseCurve(snapshot);
  path = buildRatePath(base, HORIZON);
});

/** Bucket a single instrument's cashflows (mirrors aggregate.ts). */
function bucketPrincipal(cfs: { monthOffset: number; principalPaid: number }[]): number[] {
  const principal = new Float64Array(HORIZON);
  for (const cf of cfs) {
    const b = cf.monthOffset - 1;
    if (b < 0 || b >= HORIZON) continue;
    principal[b] += cf.principalPaid;
  }
  return Array.from(principal);
}

describe("prepay overlay on a mortgage", () => {
  it("applies the overlay's MBSParams, reproducing the kernel with the OVERRIDDEN params", () => {
    // A faster refi curve than the baked-in default.
    const faster: MBSParams = { ...MBS_DEFAULTS, maxCpr: 80.0, steepness: MBS_DEFAULTS.steepness };
    const set = assumptionSet([
      {
        familyId: "MORTGAGE",
        overlay: { kind: "prepay", model: "four-factor-cpr", params: faster },
        modelVersion: "test-1",
      },
    ]);
    const portfolio = makePortfolio([mortgagePos()]);
    const result = projectStaticScenario(
      portfolio,
      { scenario: baseScenario, ratePath: path, assumptions: set },
      GRID,
    );
    const got = result.byFamily.find((f) => f.familyId === "MORTGAGE")!.series.principal;

    // Reference: the kernel mortgage built with the overridden cprParams.
    const overridden = new Mortgage({
      ...MORTGAGE_DEFAULTS,
      id: "M1",
      ageMonths: 60,
      maturityMonths: 300,
      cprParams: faster,
    }).generateCashflows(path);
    expect(got).toEqual(bucketPrincipal(overridden));

    // And it genuinely differs from the un-overridden terms (the default curve).
    const baked = new Mortgage({
      ...MORTGAGE_DEFAULTS,
      id: "M1",
      ageMonths: 60,
      maturityMonths: 300,
    }).generateCashflows(path);
    expect(got).not.toEqual(bucketPrincipal(baked));
  });

  it("a position's prepayMidpointOffsetBp moves the applied midpoint by its own offset; absent, the overlay's params apply as written", () => {
    const faster: MBSParams = { ...MBS_DEFAULTS, maxCpr: 80.0 };
    const set = assumptionSet([
      { familyId: "MORTGAGE", overlay: { kind: "prepay", model: "four-factor-cpr", params: faster }, modelVersion: "test-1" },
    ]);
    const offset = { ...mortgagePos(), id: "M2", terms: { ...mortgagePos().terms, id: "M2", prepayMidpointOffsetBp: 12 } } as Position;
    const out = applyStaticOverlays(makePortfolio([mortgagePos(), offset]), set).positions;
    // Absent: the overlay's params object itself, as before the field existed.
    expect((out[0]!.terms as { cprParams: MBSParams }).cprParams).toBe(faster);
    // Present: every parameter the overlay's, the midpoint moved by the position's 12bp.
    expect((out[1]!.terms as { cprParams: MBSParams }).cprParams).toEqual({ ...faster, inflection: faster.inflection + 12 });
    expect(faster.inflection).toBe(MBS_DEFAULTS.inflection);
  });

  it("throws StaticOverlayError for a constant-cpr overlay the kernel Mortgage cannot execute", () => {
    const set = assumptionSet([
      {
        familyId: "MORTGAGE",
        overlay: { kind: "prepay", model: "constant-cpr", annualCpr: 0.1 },
        modelVersion: "test-1",
      },
    ]);
    expect(() => applyStaticOverlays(makePortfolio([mortgagePos()]), set)).toThrow(
      StaticOverlayError,
    );
  });
});

describe("deposit-beta overlay on an NMD-B", () => {
  it("applies the overlay's sCurve, reproducing the kernel with the OVERRIDDEN sCurve", () => {
    const steeper: BetaSCurveParams = { ...BETA_S_CURVE_DEFAULTS, betaMax: 0.95 };
    const set = assumptionSet([
      { familyId: "IB", overlay: { kind: "deposit-beta", params: steeper }, modelVersion: "b-1" },
    ]);
    const portfolio = makePortfolio([ibPos()]);
    const result = projectStaticScenario(
      portfolio,
      { scenario: baseScenario, ratePath: path, assumptions: set },
      GRID,
    );
    const got = result.byFamily.find((f) => f.familyId === "IB")!.series.interest;

    const overridden = new NMDBeta({
      ...NMD_B_TERMS_DEFAULTS,
      id: "B1",
      sCurve: steeper,
    }).generateCashflows(path);
    const expected = new Float64Array(HORIZON);
    for (const cf of overridden) {
      const b = cf.monthOffset - 1;
      if (b >= 0 && b < HORIZON) expected[b] += cf.interestPaid;
    }
    expect(got).toEqual(Array.from(expected));

    // Higher beta -> higher deposit rate paid -> more interest than the default.
    const baked = new NMDBeta({ ...NMD_B_TERMS_DEFAULTS, id: "B1" }).generateCashflows(path);
    let bakedInt = 0;
    for (const cf of baked) bakedInt += cf.interestPaid;
    expect(got.reduce((s, v) => s + v, 0)).toBeGreaterThan(bakedInt);
  });
});

describe("nmd-decay overlay on a non-IB NMD", () => {
  it("applies the overlay's NMDParams, reproducing the kernel with the OVERRIDDEN params", () => {
    const faster: NMDParams = { ...NMD_DEFAULTS, maxRateDecay: NMD_DEFAULTS.maxRateDecay + 1.0 };
    const set = assumptionSet([
      { familyId: "NONIB", overlay: { kind: "nmd-decay", params: faster }, modelVersion: "d-1" },
    ]);
    const portfolio = makePortfolio([nonIbPos()]);
    const result = projectStaticScenario(
      portfolio,
      { scenario: baseScenario, ratePath: path, assumptions: set },
      GRID,
    );
    const got = result.byFamily.find((f) => f.familyId === "NONIB")!.series.balance;

    const overridden = new NMDeposit({
      ...NMD_TERMS_DEFAULTS,
      id: "D1",
      nmdParams: faster,
    }).generateCashflows(path);
    const expected = new Float64Array(HORIZON);
    for (const cf of overridden) {
      const b = cf.monthOffset - 1;
      if (b >= 0 && b < HORIZON) expected[b] += cf.balance;
    }
    expect(got).toEqual(Array.from(expected));
  });
});

describe("overlay-instrument incompatibility refuses instead of skipping (D5)", () => {
  // These three cases were formerly SILENT: the overlay was dropped and the
  // position ran on its baked-in terms, fabricating an un-overridden number
  // against the caller's stated intent. Each now
  // throws a typed error naming the family, the overlay kind, and the
  // instrument type — before any position is touched.

  it("throws for a deposit-beta overlay bound to the non-interest-bearing NMD family", () => {
    const set = assumptionSet([
      {
        familyId: "NONIB",
        overlay: { kind: "deposit-beta", params: { ...BETA_S_CURVE_DEFAULTS } },
        modelVersion: "b-x",
      },
    ]);
    try {
      applyStaticOverlays(makePortfolio([nonIbPos()]), set);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompatibleOverlayError);
      const err = e as IncompatibleOverlayError;
      expect(err.familyId).toBe("NONIB");
      expect(err.overlayKind).toBe("deposit-beta");
      expect(err.instrumentType).toBe("nmd");
    }
  });

  it("throws for a prepay overlay bound to a fixed-loan family", () => {
    const set = assumptionSet([
      {
        familyId: "FIXED",
        overlay: { kind: "prepay", model: "four-factor-cpr", params: { ...MBS_DEFAULTS } },
        modelVersion: "p-x",
      },
    ]);
    try {
      applyStaticOverlays(makePortfolio([mortgagePos()]), set);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompatibleOverlayError);
      const err = e as IncompatibleOverlayError;
      expect(err.familyId).toBe("FIXED");
      expect(err.overlayKind).toBe("prepay");
      expect(err.instrumentType).toBe("fixed-loan");
    }
  });

  it("throws for an nmd-decay overlay bound to a loan family", () => {
    const set = assumptionSet([
      {
        familyId: "FIXED",
        overlay: { kind: "nmd-decay", params: { ...NMD_DEFAULTS } },
        modelVersion: "d-x",
      },
    ]);
    try {
      applyStaticOverlays(makePortfolio([mortgagePos()]), set);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompatibleOverlayError);
      const err = e as IncompatibleOverlayError;
      expect(err.familyId).toBe("FIXED");
      expect(err.overlayKind).toBe("nmd-decay");
      expect(err.instrumentType).toBe("fixed-loan");
    }
  });

  it("throws StaticOverlayError when a position's terms disagree with its family's declared type", () => {
    // The family catalogue declares IB as nmd-b (so the set passes the
    // family-level gate), but the position actually carries nmd terms: a
    // misconfigured book. The per-position merge refuses rather than skipping.
    const set = assumptionSet([
      { familyId: "IB", overlay: { kind: "deposit-beta", params: { ...BETA_S_CURVE_DEFAULTS } }, modelVersion: "b-x" },
    ]);
    const rogue: Position = {
      id: "R1",
      familyId: "IB",
      coaNodeId: "mma",
      terms: { ...NMD_TERMS_DEFAULTS, id: "R1" }, // type "nmd" under an nmd-b family
    };
    try {
      applyStaticOverlays(makePortfolio([rogue]), set);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(StaticOverlayError);
      const err = e as StaticOverlayError;
      expect(err.positionId).toBe("R1");
      expect(err.overlayKind).toBe("deposit-beta");
      expect(err.message).toContain("nmd");
    }
  });
});

describe("overlay validation and no-ops", () => {
  it("surfaces an unknown-family binding (reusing m04's validation gate)", () => {
    const set = assumptionSet([
      {
        familyId: "NOPE",
        overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS },
        modelVersion: "x",
      },
    ]);
    expect(() => applyStaticOverlays(makePortfolio([mortgagePos()]), set)).toThrow(
      UnknownFamilyError,
    );
  });

  it("leaves positions untouched when a family carries no overlay", () => {
    const set = assumptionSet([
      {
        familyId: "MORTGAGE",
        overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS },
        modelVersion: "x",
      },
    ]);
    const portfolio = makePortfolio([mortgagePos(), nonIbPos()]);
    const effective = applyStaticOverlays(portfolio, set);
    // NONIB has no binding: same position object passes through.
    const nonIb = effective.positions.find((p) => p.familyId === "NONIB");
    expect(nonIb).toBe(portfolio.positions.find((p) => p.familyId === "NONIB"));
  });
});

describe("per-binding application with selectors", () => {
  it("a selected binding touches only the positions it matches; the rest are object-identical", () => {
    const book = segmentedNmdBook();
    const set = segmentedAssumptions();
    const out = applyStaticOverlays(book, set);
    const byId = new Map(out.positions.map((p) => [p.id, p]));
    const d1 = byId.get("D1")!.terms as NMDTerms;
    const d2 = byId.get("D2")!.terms as NMDTerms;
    const d3 = byId.get("D3")!.terms as NMDTerms;
    expect(d1.nmdParams).toEqual(NMD_DEFAULT_PARAMS);
    expect(d2.nmdParams).toEqual(NMD_DEFAULT_PARAMS);
    expect(d3.nmdParams).toEqual(RELATIONSHIP_NMD_PARAMS);
    // The fixed loan has no binding: same object.
    expect(byId.get("F1")).toBe(book.positions.find((p) => p.id === "F1"));
  });
  it("an unselected binding on a tagged book behaves exactly as before", () => {
    const book = segmentedNmdBook();
    const out = applyStaticOverlays(book, baseAssumptions());
    for (const id of ["D1", "D2", "D3"]) {
      expect((out.positions.find((p) => p.id === id)!.terms as NMDTerms).nmdParams).toEqual(NMD_DEFAULT_PARAMS);
    }
  });
  it("L3 on the applier's path: two bindings of one kind matching one position refuse, naming both", () => {
    const book = segmentedNmdBook();
    const set = segmentedAssumptions();
    set.bindings[3] = { ...set.bindings[3]!, selector: undefined } as typeof set.bindings[3];
    delete (set.bindings[3] as { selector?: unknown }).selector;
    let err: unknown;
    try { applyStaticOverlays(book, set); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(OverlappingBindingError);
    const o = err as OverlappingBindingError;
    expect(o.positionId).toBe("D1");
    expect(o.kind).toBe("nmd-decay");
    expect([o.firstIndex, o.secondIndex]).toEqual([1, 3]);
    expect(o.message).toContain('{"segment":["rate-shopper"]}');
    expect(o.message).toContain("AS-SEGMENTED");
  });
  it("checkBindingOverlap passes disjoint predicates and an untagged book with one binding per kind", () => {
    expect(() => checkBindingOverlap(segmentedNmdBook(), segmentedAssumptions())).not.toThrow();
    expect(() => checkBindingOverlap(twoSidedBook(), baseAssumptions())).not.toThrow();
  });
});
