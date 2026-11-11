/**
 * Small deterministic fixtures for the run-orchestrator tests. A two-sided book
 * (fixed loans + mortgages on the asset side, a Non-IB NMD and an IB NMD-B on
 * the liability side) over the regulatory parallel grid, with an assumption set
 * whose overlays reuse the kernel term defaults so the overlay-applied book is
 * numerically identical to the raw book and every layer reconciles exactly.
 *
 * The market snapshot is the real vendored kernel snapshot, loaded async in a
 * beforeAll; run() consumes it synchronously off the request.
 */
import { fileURLToPath } from "node:url";
import {
  FIXED_LOAN_DEFAULTS,
  MORTGAGE_DEFAULTS,
  NMD_B_TERMS_DEFAULTS,
  NMD_TERMS_DEFAULTS,
  loadMarketSnapshot,
  type FixedLoanTerms,
  type MarketSnapshot,
  type MortgageTerms,
  type NMDBetaTerms,
  type NMDParams,
  type NMDTerms,
} from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { DimensionTaxonomy } from "../../contracts/dimensions";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { RunRequest } from "../../contracts/run";
import type { Scenario } from "../../contracts/scenario";
import { REGULATORY_SHOCKS_BP } from "../../contracts/scenario";
import type { ViewDef } from "../../contracts/views";

export const AS_OF = "2026-01-01";
export const HORIZON = 360;

export const MARKET_PATH = fileURLToPath(
  new URL("../../../../kernel/public/market_public.json", import.meta.url),
);

export function loadMarket(): Promise<MarketSnapshot> {
  return loadMarketSnapshot(MARKET_PATH);
}

export function makeCoa(): ChartOfAccounts {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "fixed-loans", label: "Fixed Loans", parentId: "assets", side: "asset", isLeaf: true, familyId: "FIXED", order: 0 },
      { id: "mortgages", label: "Mortgages", parentId: "assets", side: "asset", isLeaf: true, familyId: "MORTGAGE", order: 1 },
      { id: "liabilities", label: "Total Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      { id: "dda", label: "DDA", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "DDA", order: 0 },
      { id: "mma", label: "MMA", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "MMA", order: 1 },
    ],
    families: [
      { id: "FIXED", label: "Fixed Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "fixed-loans" },
      { id: "MORTGAGE", label: "Mortgages", side: "asset", instrumentType: "mortgage", coaNodeId: "mortgages" },
      { id: "DDA", label: "DDA", side: "liability", instrumentType: "nmd", coaNodeId: "dda" },
      { id: "MMA", label: "MMA", side: "liability", instrumentType: "nmd-b", coaNodeId: "mma" },
    ],
  };
}

function fixedTerms(id: string, o: Partial<FixedLoanTerms> = {}): FixedLoanTerms {
  return { ...FIXED_LOAN_DEFAULTS, id, ...o };
}
function mortgageTerms(id: string, o: Partial<MortgageTerms> = {}): MortgageTerms {
  return { ...MORTGAGE_DEFAULTS, id, ...o };
}
function nmdTerms(id: string, o: Partial<NMDTerms> = {}): NMDTerms {
  return { ...NMD_TERMS_DEFAULTS, id, ...o };
}
function nmdBetaTerms(id: string, o: Partial<NMDBetaTerms> = {}): NMDBetaTerms {
  return { ...NMD_B_TERMS_DEFAULTS, id, ...o };
}

export function fixedPosition(id: string, o: Partial<FixedLoanTerms> = {}): Position {
  return { id, familyId: "FIXED", coaNodeId: "fixed-loans", terms: fixedTerms(id, o) };
}
export function mortgagePosition(id: string, o: Partial<MortgageTerms> = {}): Position {
  return { id, familyId: "MORTGAGE", coaNodeId: "mortgages", terms: mortgageTerms(id, o) };
}
export function nmdPosition(id: string, o: Partial<NMDTerms> = {}): Position {
  return { id, familyId: "DDA", coaNodeId: "dda", terms: nmdTerms(id, o) };
}
export function nmdBetaPosition(id: string, o: Partial<NMDBetaTerms> = {}): Position {
  return { id, familyId: "MMA", coaNodeId: "mma", terms: nmdBetaTerms(id, o) };
}

/** The two-sided fixture book. Notionals give positive equity like the EVE test. */
export function twoSidedBook(id = "PF-RUN"): PortfolioSpec {
  return {
    id,
    label: "Run test book",
    asOf: AS_OF,
    coa: makeCoa(),
    positions: [
      fixedPosition("F1", { notional: 5_000_000, coupon: 0.05, maturityMonths: 60 }),
      mortgagePosition("M1", { notional: 4_000_000, originalBalance: 4_000_000 }),
      nmdPosition("D1", { notional: 3_000_000 }),
      nmdBetaPosition("B1", { notional: 2_000_000 }),
    ],
  };
}

/**
 * The overlay parameter bundles the fixture assumption sets bind, exported so a
 * second set (the example-plan book) binds the same defaults rather than a
 * second copy of them.
 */
export const MORTGAGE_DEFAULT_PARAMS = MORTGAGE_DEFAULTS.cprParams;
export const NMD_DEFAULT_PARAMS = NMD_TERMS_DEFAULTS.nmdParams;
export const BETA_DEFAULT_PARAMS = NMD_B_TERMS_DEFAULTS.sCurve;
export const NMD_B_DEFAULT_PARAMS = NMD_B_TERMS_DEFAULTS.nmdParams;

/**
 * The base assumption set: overlays whose params are exactly the kernel term
 * defaults the positions already carry, so applying them leaves the book's
 * numbers unchanged while still exercising the resolve/apply/provenance path.
 *
 * EVERY BINDING HERE IS A NUMERICAL NO-OP, by design and by name: the prepay
 * params are MORTGAGE_DEFAULTS.cprParams, the decay params are
 * NMD_TERMS_DEFAULTS.nmdParams, the beta params are NMD_B_TERMS_DEFAULTS.sCurve.
 * A test that needs an overlay to MOVE a number must bind params that differ
 * from those defaults; dropping a binding from this set, or the stage that
 * licenses it, changes nothing on its own. The values themselves are pinned by
 * the goldens and must not be edited to make a test bite.
 */
export function baseAssumptions(id = "AS-BASE"): AssumptionSet {
  return {
    schemaVersion: "1.0.0",
    id,
    label: "Base behavioral set",
    bindings: [
      {
        familyId: "MORTGAGE",
        overlay: { kind: "prepay", model: "four-factor-cpr", params: MORTGAGE_DEFAULT_PARAMS },
        modelVersion: "mbs-fixture-1",
      },
      {
        familyId: "DDA",
        overlay: { kind: "nmd-decay", params: NMD_DEFAULT_PARAMS },
        modelVersion: "nmd-fixture-1",
      },
      {
        familyId: "MMA",
        overlay: { kind: "deposit-beta", params: BETA_DEFAULT_PARAMS },
        modelVersion: "beta-fixture-1",
      },
    ],
  };
}

/** A static regulatory-grid scenario: parallel shock, shared assumption set, no new business. */
function staticScenario(id: string, shockBp: number, assumptionSetId = "AS-BASE"): Scenario {
  return {
    id,
    label: id,
    rateSpec: shockBp === 0 ? { kind: "base" } : { kind: "parallel", shockBp },
    assumptionSetId,
    newBusiness: { mode: "static", rules: [] },
  };
}

/** The regulatory grid as scenarios, ids "S{shock}" (S0, S100, S-100, S200, S-200). */
export function regulatoryScenarios(assumptionSetId = "AS-BASE"): Scenario[] {
  return REGULATORY_SHOCKS_BP.map((bp) => staticScenario(`S${bp}`, bp, assumptionSetId));
}

/** Build a full RunRequest over the grid for a loaded market snapshot. */
export function makeRunRequest(
  marketSnapshot: MarketSnapshot,
  overrides: Partial<RunRequest> = {},
): RunRequest {
  const portfolio = twoSidedBook();
  return {
    runId: "RUN-1",
    portfolioId: portfolio.id,
    marketSnapshot,
    scenarios: regulatoryScenarios(),
    assumptionSets: [baseAssumptions()],
    grid: { horizonMonths: HORIZON, asOf: AS_OF },
    seed: "42",
    timestamps: { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" },
    ...overrides,
  };
}

// --- The segmented deposit fixture --------------------------------

export const SEGMENT_TAXONOMY: DimensionTaxonomy = {
  schemaVersion: "1.0.0",
  id: "TAX-SEGMENT",
  label: "One calibration segment tag",
  dimensions: [{ id: "segment", label: "Calibration segment", values: ["rate-shopper", "relationship"] }],
};

/** The DDA decay parameters for the relationship segment: closure twice the default. */
export const RELATIONSHIP_NMD_PARAMS: NMDParams = {
  ...NMD_DEFAULT_PARAMS,
  closureSteady: NMD_DEFAULT_PARAMS.closureSteady * 2,
  closureInitial: NMD_DEFAULT_PARAMS.closureInitial * 2,
};

/**
 * The rate the segmented book's deposit family pays. NMD_TERMS_DEFAULTS is the
 * Non-IB bundle, depositRate 0, so a book built straight off it earns the DDA
 * family a structurally zero net12 and no decay parameter set could ever move
 * it. Spec acceptance (b) asks for an INTEREST-BEARING deposit family, so the
 * segmented fixture pays a small fixed rate; beta stays 0, so the rate does not
 * reprice and the only thing the two decay parameter sets move is the balance.
 */
const SEGMENTED_DEPOSIT_RATE = 0.01;

/**
 * twoSidedBook plus two more DDA positions and the segment tag: D1 and D2 are
 * rate shoppers, D3 is relationship. Acceptance (b) and (c) of the 2a spec.
 */
export function segmentedNmdBook(id = "PF-SEGMENTED"): PortfolioSpec {
  const book = twoSidedBook(id);
  const d1 = book.positions.find((p) => p.id === "D1")!;
  const paying = (p: Position): Position => ({
    ...p,
    terms: { ...(p.terms as NMDTerms), depositRate: SEGMENTED_DEPOSIT_RATE },
  });
  book.positions = book.positions.map((p) =>
    p.id === "D1" ? { ...paying(d1), dimensions: { segment: "rate-shopper" } } : p,
  );
  book.positions.push(
    { ...paying(nmdPosition("D2", { notional: 1_000_000 })), dimensions: { segment: "rate-shopper" } },
    { ...paying(nmdPosition("D3", { notional: 1_000_000 })), dimensions: { segment: "relationship" } },
  );
  book.taxonomy = SEGMENT_TAXONOMY;
  return book;
}

/** baseAssumptions with the DDA decay split by segment. Binding 1 narrows; binding 3 is new. */
export function segmentedAssumptions(id = "AS-SEGMENTED"): AssumptionSet {
  const set = baseAssumptions(id);
  set.bindings[1] = { ...set.bindings[1]!, selector: { segment: ["rate-shopper"] } };
  set.bindings.push({
    familyId: "DDA",
    overlay: { kind: "nmd-decay", params: RELATIONSHIP_NMD_PARAMS },
    modelVersion: "nmd-fixture-relationship-1",
    selector: { segment: ["relationship"] },
  });
  return set;
}

// --- A book every declared view can partition -----------------------

/**
 * segmentedNmdBook plus a segment tag on the three positions 2a left untagged.
 *
 * A view grouping on `segment` refuses a book in which any position carries no
 * value for it (rule P3), and F1, M1 and B1 do not, so the 2a fixture cannot be
 * grouped as it stands, which the spec's acceptance (b) states. This wrapper tags those three
 * "whole-book" over a LOCAL widening of the taxonomy's closed value list.
 * segmentedNmdBook and SEGMENT_TAXONOMY are untouched, so every 2a test keeps
 * its numbers and this book's DDA family keeps the same 2 / 1 segment split.
 */
export const VIEW_SEGMENT_TAXONOMY: DimensionTaxonomy = {
  ...SEGMENT_TAXONOMY,
  dimensions: [
    { id: "segment", label: "Calibration segment", values: ["rate-shopper", "relationship", "whole-book"] },
  ],
};

export function viewSegmentedBook(id = "PF-VIEW-SEGMENTED"): PortfolioSpec {
  const book = segmentedNmdBook(id);
  book.taxonomy = VIEW_SEGMENT_TAXONOMY;
  book.positions = book.positions.map((p) =>
    p.dimensions === undefined ? { ...p, dimensions: { segment: "whole-book" } } : p,
  );
  return book;
}

/** The one view the 2b acceptance runs declare. */
export const BY_SEGMENT_VIEW: ViewDef = { id: "by-segment", label: "By segment", groupBy: ["segment"] };
