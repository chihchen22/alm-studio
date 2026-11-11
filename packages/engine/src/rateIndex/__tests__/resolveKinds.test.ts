/**
 * The run entry over the B3a index kinds. The B2 fold now covers the read closure:
 * every index a position reads and its parent chain, each once, so a derived curve on a parent no position names
 * is folded too. Each formula in the closure carries parentAtCutoff, its parent's month-0 value on the run's
 * UNSHOCKED base curve (ruling 2026-10-13, which amends decision 40). Expected texts and
 * values are restated here, not read back from the code under test.
 */
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { DeterministicRatePath, loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import type { AnchoredFormulaIndex } from "../../contracts/rateIndex";
import type { PortfolioSpec, Position, PositionTerms } from "../../contracts/position";
import { buildBaseCurve } from "../../scenario/rateEnvironment";
import { checkRateIndexRefs, indicesRead } from "../resolve";

const FIXTURE = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarketSnapshot(FIXTURE);
});

function floater(id: string, rateIndexId: string): Position {
  const terms = {
    id,
    type: "floating-loan",
    notional: 1_000_000,
    maturityMonths: 12,
    originationOffsetMonths: 0,
    amortType: "bullet",
    side: "asset",
    indexTenorMonths: 1,
    margin: 0.0125,
    resetFrequencyMonths: 1,
    rateIndexId,
  } as unknown as PositionTerms;
  return { id, familyId: "floaters", coaNodeId: "floaters", terms };
}
const bookOf = (positions: Position[]): PortfolioSpec => ({
  id: "PF-DC",
  label: "derived curve book",
  asOf: "2026-01-01",
  coa: { schemaVersion: "1.0.0", nodes: [], families: [] },
  positions,
});

const CMS = { id: "cms-10y", label: "Ten-year swap", kind: "constant-maturity-swap" as const, tenorYears: 10 as const, basis: 0, spreadCurve: "flat-25" };
const LEVEL = { id: "level-cms", label: "Swap through a formula", kind: "formula" as const, parent: "cms-10y", coefficient: 1, basis: 0 };
const BETA = { id: "admin-rate", label: "Administered", kind: "formula" as const, parent: "rfr-1m", beta: 0.4, start: 0.0433, basis: 0 };
const RFR1 = { id: "rfr-1m", label: "One-month", tenorMonths: 1 as const, basis: 0 };
const FLAT_25 = { id: "flat-25", label: "Flat 25 bp", base: "platform-default", spreads: [{ tenorMonths: 1, spreadBp: 25 }] };

describe("the run entry over the read closure", () => {
  it("folds a derived curve on a parent no position reads, at 12 x tenor months for a swap index", () => {
    const t = checkRateIndexRefs(bookOf([floater("F", "level-cms")]), { ...market, rateIndices: [CMS, LEVEL], derivedCurves: [FLAT_25] } as never).table!;
    // The flat curve's one row (25 bp) reads 25 bp at 120 months, beyond the last row: basis 0 + 0.0025.
    expect(t.get("cms-10y")).toEqual({ id: "cms-10y", label: "Ten-year swap", kind: "constant-maturity-swap", tenorYears: 10, basis: 0.0025 });
  });

  it("fixes parentAtCutoff from the run's unshocked curve, in decimal", () => {
    const t = checkRateIndexRefs(bookOf([floater("F", "admin-rate")]), { ...market, rateIndices: [RFR1, BETA] } as never).table!;
    const path = new DeterministicRatePath(buildBaseCurve(market), 12);
    expect((t.get("admin-rate") as AnchoredFormulaIndex).parentAtCutoff).toBe(path.rateAt(0));
  });

  it("folds the parent's derived curve before it anchors a beta formula on it", () => {
    const BETA_CMS = { id: "beta-cms", label: "Half the swap change", kind: "formula" as const, parent: "cms-10y", beta: 0.5, start: 0.04, basis: 0 };
    const t = checkRateIndexRefs(bookOf([floater("F", "beta-cms")]), { ...market, rateIndices: [CMS, BETA_CMS], derivedCurves: [FLAT_25] } as never).table!;
    // The parent's step-0 read on the unshocked base curve, plus the 25 bp the flat curve adds at 120 months.
    const tenYearAt0 = new DeterministicRatePath(buildBaseCurve(market), 12).forwardRateAt(0, 10);
    expect((t.get("beta-cms") as AnchoredFormulaIndex).parentAtCutoff).toBe(tenYearAt0 + 0.0025);
  });

  it("refuses a missing curve on a parent, naming the parent", () => {
    const r = checkRateIndexRefs(bookOf([floater("F", "level-cms")]), { ...market, rateIndices: [CMS, LEVEL] } as never);
    expect(r.message).toContain(`rate index "cms-10y" reads derived curve "flat-25", which the run's market does not carry`);
  });

  it("a book reading compounded windows only gets the B2 table object back, and indicesRead lists nothing new", () => {
    const plain = { id: "rfr-3m", label: "x", tenorMonths: 3 as const, basis: 0 };
    const r = checkRateIndexRefs(bookOf([floater("F", "rfr-3m")]), { ...market, rateIndices: [plain, BETA, RFR1] } as never);
    expect(r.table!.get("rfr-3m")).toBe(plain);
    expect(r.table!.get("admin-rate")).toEqual(BETA);
    expect(indicesRead(bookOf([floater("F", "rfr-3m")]), { ...market, rateIndices: [plain, BETA, RFR1] } as never)).toEqual([plain]);
  });

  it("indicesRead lists the read index, then its parents, as stored", () => {
    expect(indicesRead(bookOf([floater("F", "level-cms")]), { ...market, rateIndices: [CMS, LEVEL], derivedCurves: [FLAT_25] } as never)).toEqual([LEVEL, CMS]);
  });
});
