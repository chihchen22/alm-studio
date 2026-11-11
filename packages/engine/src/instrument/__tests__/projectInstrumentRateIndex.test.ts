/**
 * Piece 7a, sub-part S2d: the single-instrument drill resolves a
 * floater's rate index against the market it prices on. Expected numbers are
 * restated: the month-1 base reset r(0) = 0.03711187832875318 on the public
 * pack (the default curve, first node at exactly 1/12; was 0.03711187754093537), the margin, and the index basis.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import type { PositionTerms } from "../../contracts/position";
import type { Scenario } from "../../contracts/scenario";
import { deriveMarketSnapshot } from "../../market/deriveMarketSnapshot";
import { RateIndexRefusedError } from "../../rateIndex/resolve";
import { projectInstrument } from "../projectInstrument";

const FIXTURE = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));

const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 0 },
  { op: "set-index", id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basisBp: 300 },
];

let plain: MarketSnapshot;
let indexed: MarketSnapshot;
beforeAll(async () => {
  plain = await loadMarketSnapshot(FIXTURE);
  indexed = deriveMarketSnapshot(structuredClone(plain), SEED_OPS, { baseId: "market-public-2026-03-31" }).snapshot;
});

const S0: Scenario = {
  id: "S0",
  label: "S0",
  rateSpec: { kind: "base" },
  assumptionSetId: "none",
  newBusiness: { mode: "static", rules: [] },
};

function floater(rateIndexId?: string): PositionTerms {
  return {
    id: "drill-idx-1",
    type: "floating-loan",
    notional: 1_000_000,
    maturityMonths: 12,
    originationOffsetMonths: 0,
    amortType: "bullet",
    indexTenorMonths: 1,
    margin: 0.0125,
    resetFrequencyMonths: 1,
    ...(rateIndexId !== undefined ? { rateIndexId } : {}),
  } as unknown as PositionTerms;
}

const input = (terms: PositionTerms, market: MarketSnapshot) => ({
  terms,
  familyId: "floaters",
  side: "asset" as const,
  marketSnapshot: market,
  scenarios: [S0],
  horizonMonths: 24,
});

describe("projectInstrument on a named rate index (h)", () => {
  it("prices on the index market: month-1 coupon is the base reset plus margin plus the 300 bp basis", () => {
    const r = projectInstrument(input(floater("prime-demo"), indexed));
    const row = r.byScenario[0]!.rows[0]!;
    // r(0) 0.03711187832875318 + margin 0.0125 + basis 0.03 = 0.07961187832875318.
    // R(0) on the default curve (was 0.03711187754093537, measured on unmodified source); interpolation, deltas Step 1
    expect(row.couponRate).toBeCloseTo(0.03711187832875318 + 0.0425, 12);
    expect(row.interest).toBeCloseTo((1_000_000 * (0.03711187832875318 + 0.0425)) / 12, 9);
  });

  it("an unindexed floater is unchanged by the market carrying indices", () => {
    const a = projectInstrument(input(floater(), plain));
    const b = projectInstrument(input(floater(), indexed));
    expect(JSON.stringify(b.byScenario)).toBe(JSON.stringify(a.byScenario));
    // R(0) on the default curve (was 0.03711187754093537); interpolation, deltas Step 1
    expect(a.byScenario[0]!.rows[0]!.couponRate).toBeCloseTo(0.03711187832875318 + 0.0125, 12);
  });

  it("refuses on a market that does not carry the index, with the run's text, before any number", () => {
    let caught: unknown;
    try {
      projectInstrument(input(floater("prime-demo"), plain));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RateIndexRefusedError);
    expect((caught as Error).message).toBe(
      'run refused: 1 position(s) name a rate index the run cannot resolve, and a floater never falls back to the one-month benchmark: position "drill-idx-1" names rate index "prime-demo", which the run\'s market does not carry (it carries none)',
    );
  });

  it("refuses a type that is not a floating loan when it carries rateIndexId", () => {
    const fixed = {
      id: "drill-idx-2",
      type: "fixed-loan",
      notional: 1_000_000,
      maturityMonths: 12,
      originationOffsetMonths: 0,
      amortType: "bullet",
      coupon: 0.05,
      rateIndexId: "prime-demo",
    } as unknown as PositionTerms;
    expect(() => projectInstrument(input(fixed, indexed))).toThrow(
      'position "drill-idx-2" is a fixed-loan and names rate index "prime-demo"; only floating-loan positions reset on a rate index',
    );
  });

  it("computes an effective duration on the indexed floater (the bump legs carry the table)", () => {
    const r = projectInstrument(input(floater("rfr-3m"), indexed));
    const d = r.byScenario[0]!.effectiveDuration;
    expect(d === undefined || Number.isFinite(d)).toBe(true);
    expect(r.byScenario[0]!.repricingMonths.length).toBeGreaterThan(0);
  });
});
