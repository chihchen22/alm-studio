/**
 * The derived curve spread folded at the run entry (step
 * B2). An index whose spreadCurve names a derived curve resets on the
 * base forward plus that curve's spread at the index tenor; the runtime entry
 * carries the folded basis and no spreadCurve, so nothing downstream can fold
 * it a second time. Expected texts and values are restated here, not imported
 * from the code under test.
 */
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import type { PortfolioSpec, Position, PositionTerms } from "../../contracts/position";
import * as engineBarrel from "../../index";
import { checkRateIndexRefs, derivedCurvesRead, RateIndexRefusedError, resolveRunRateIndices } from "../resolve";

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
const book = bookOf([floater("F", "sofr-3m")]);

const curve = { id: "ust-sofr", label: "UST over SOFR", base: "platform-default", spreads: [{ tenorMonths: 3, spreadBp: 12 }] };
const idx = { id: "sofr-3m", label: "SOFR 3M", tenorMonths: 3, basis: 0.001, spreadCurve: "ust-sofr" };

describe("checkRateIndexRefs with a derived curve", () => {
  it("folds the spread into the runtime basis and leaves the key off", () => {
    const t = checkRateIndexRefs(book, { ...market, rateIndices: [idx], derivedCurves: [curve] } as never).table!;
    expect(t.get("sofr-3m")).toEqual({ id: "sofr-3m", label: "SOFR 3M", tenorMonths: 3, basis: 0.001 + 0.0012 });
  });

  it("an index with no spreadCurve is the stored object itself", () => {
    const plain = { id: "sofr-3m", label: "SOFR 3M", tenorMonths: 3 as const, basis: 0.001 };
    const t = checkRateIndexRefs(book, { ...market, rateIndices: [plain] } as never).table!;
    expect(t.get("sofr-3m")).toBe(plain);
  });

  it("refuses a missing curve, naming both ids", () => {
    const r = checkRateIndexRefs(book, { ...market, rateIndices: [idx] } as never);
    expect(r.message).toContain(`rate index "sofr-3m" reads derived curve "ust-sofr", which the run's market does not carry`);
  });

  it("refuses a base that is not the run's curve", () => {
    const onSetup = { ...curve, base: "sofr-main" };
    const r = checkRateIndexRefs(book, { ...market, rateIndices: [idx], derivedCurves: [onSetup] } as never);
    expect(r.message).toContain(`built on "sofr-main", but the run's curve is "platform-default"`);
  });

  it("an unreferenced index with a missing curve does not refuse the run", () => {
    const other = { ...idx, id: "sofr-6m", tenorMonths: 6 as const, spreadCurve: "gone" };
    const r = checkRateIndexRefs(book, { ...market, rateIndices: [idx, other], derivedCurves: [curve] } as never);
    expect(r.message).toBeUndefined();
  });

  // Beyond the five cases above: the exact sentences, the identity of untouched entries, and the base rule's other arm.

  it("puts the bare sentence in problems, names the market when the caller does, and refuses through the error", () => {
    const m = { ...market, rateIndices: [idx] } as never;
    const r = checkRateIndexRefs(book, m, "mk-1");
    expect(r.table).toBeUndefined();
    expect(r.problems).toEqual([`rate index "sofr-3m" reads derived curve "ust-sofr", which market "mk-1" does not carry`]);
    expect(r.first).toEqual({ positionId: "F", rateIndexId: "sofr-3m" });
    expect(() => resolveRunRateIndices(book, m)).toThrow(RateIndexRefusedError);
  });

  it("states the base refusal in full, with the setup id as the run's curve when the market carries a curve setup", () => {
    const onDefault = { ...curve };
    const r = checkRateIndexRefs(book, { ...market, curveSetup: { id: "sofr-main" }, rateIndices: [idx], derivedCurves: [onDefault] } as never);
    expect(r.problems).toEqual([
      `rate index "sofr-3m" reads derived curve "ust-sofr", built on "platform-default", but the run's curve is "sofr-main"`,
    ]);
    // The same curve built on the setup's id folds.
    const onSetup = { ...curve, base: "sofr-main" };
    const ok = checkRateIndexRefs(book, { ...market, curveSetup: { id: "sofr-main" }, rateIndices: [idx], derivedCurves: [onSetup] } as never);
    expect(ok.message).toBeUndefined();
    expect(ok.table!.get("sofr-3m")!.basis).toBe(0.001 + 0.0012);
  });

  it("refuses, never folds, when the market's curve setup is named platform-default (the reserved id)", () => {
    const m = { ...market, curveSetup: { id: "platform-default" }, rateIndices: [idx], derivedCurves: [curve] } as never;
    const r = checkRateIndexRefs(book, m);
    expect(r.table).toBeUndefined();
    expect(r.problems).toEqual([
      `rate index "sofr-3m" reads derived curve "ust-sofr", but the run's market carries a curve setup named "platform-default", ` +
        "an id reserved for the platform's own curve; rename the curve setup",
    ]);
    expect(derivedCurvesRead(book, m)).toEqual([]);
    expect(() => resolveRunRateIndices(book, m)).toThrow(RateIndexRefusedError);
  });

  it("refuses a malformed derivedCurves block with the validator's sentences, never folding", () => {
    const bad = { ...curve, spreads: [] };
    const r = checkRateIndexRefs(book, { ...market, rateIndices: [idx], derivedCurves: [bad] } as never);
    expect(r.table).toBeUndefined();
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]!.startsWith(`the run's market carries a derivedCurves block the run cannot read: derived curve "ust-sofr": `)).toBe(true);
    expect(r.message).toContain("derivedCurves block the run cannot read");
  });

  it("does not read the derivedCurves block when no referenced index names a curve", () => {
    const plain = { id: "sofr-3m", label: "SOFR 3M", tenorMonths: 3 as const, basis: 0.001 };
    const poisoned = {
      ...market,
      rateIndices: [plain],
      get derivedCurves(): never {
        throw new Error("the block was read");
      },
    } as never;
    expect(checkRateIndexRefs(book, poisoned).message).toBeUndefined();
  });

  it("builds a new table: untouched entries keep their object, the stored index is not mutated", () => {
    const plain = { id: "rfr-1m", label: "One month", tenorMonths: 1 as const, basis: 0 };
    const stored = { ...idx };
    const t = checkRateIndexRefs(
      bookOf([floater("F", "sofr-3m"), floater("G", "rfr-1m")]),
      { ...market, rateIndices: [stored, plain], derivedCurves: [curve] } as never,
    ).table!;
    expect(t.get("rfr-1m")).toBe(plain);
    expect(t.get("sofr-3m")).not.toBe(stored);
    expect(Object.prototype.hasOwnProperty.call(t.get("sofr-3m"), "spreadCurve")).toBe(false);
    expect(stored).toEqual({ id: "sofr-3m", label: "SOFR 3M", tenorMonths: 3, basis: 0.001, spreadCurve: "ust-sofr" });
  });

  it("reads the spread at the index's own tenor, linear between rows", () => {
    const sloped = { ...curve, spreads: [{ tenorMonths: 1, spreadBp: 10 }, { tenorMonths: 5, spreadBp: 30 }] };
    const t = checkRateIndexRefs(book, { ...market, rateIndices: [idx], derivedCurves: [sloped] } as never).table!;
    // At 3 months, halfway from 10 bp to 30 bp: 20 bp, 0.002.
    expect(t.get("sofr-3m")!.basis).toBe(0.001 + 0.002);
  });

  it("names each problem index once, however many positions carry it", () => {
    const r = checkRateIndexRefs(bookOf([floater("F", "sofr-3m"), floater("G", "sofr-3m")]), { ...market, rateIndices: [idx] } as never);
    expect(r.problems).toEqual([`rate index "sofr-3m" reads derived curve "ust-sofr", which the run's market does not carry`]);
  });
});

describe("derivedCurvesRead", () => {
  it("lists the curves the run applies, by curve id then index id, and nothing on a refused or plain run", () => {
    const b = { id: "aaa", label: "A curve", base: "platform-default", spreads: [{ tenorMonths: 1, spreadBp: 5 }] };
    const i6 = { id: "sofr-6m", label: "SOFR 6M", tenorMonths: 6 as const, basis: 0, spreadCurve: "ust-sofr" };
    const i1 = { id: "rfr-1m", label: "One month", tenorMonths: 1 as const, basis: 0, spreadCurve: "aaa" };
    const unref = { id: "lonely", label: "Not named", tenorMonths: 1 as const, basis: 0, spreadCurve: "aaa" };
    const m = { ...market, rateIndices: [idx, i6, i1, unref], derivedCurves: [curve, b] } as never;
    const portfolio = bookOf([floater("F", "sofr-6m"), floater("G", "sofr-3m"), floater("H", "rfr-1m")]);
    expect(derivedCurvesRead(portfolio, m)).toEqual([
      { indexId: "rfr-1m", curveId: "aaa", label: "A curve" },
      { indexId: "sofr-3m", curveId: "ust-sofr", label: "UST over SOFR" },
      { indexId: "sofr-6m", curveId: "ust-sofr", label: "UST over SOFR" },
    ]);
    expect(derivedCurvesRead(portfolio, { ...market, rateIndices: [idx, i6, i1] } as never)).toEqual([]);
    const plain = { id: "sofr-3m", label: "SOFR 3M", tenorMonths: 3 as const, basis: 0.001 };
    expect(derivedCurvesRead(book, { ...market, rateIndices: [plain] } as never)).toEqual([]);
  });

  it("rides the engine barrel", () => {
    expect(typeof (engineBarrel as Record<string, unknown>).derivedCurvesRead).toBe("function");
  });
});
