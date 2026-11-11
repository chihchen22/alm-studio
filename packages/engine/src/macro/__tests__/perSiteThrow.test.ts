// packages/engine/src/macro/__tests__/perSiteThrow.test.ts (A7)
/**
 * Each reachable makeInstrument site, called WITHOUT a macro value on a book
 * whose one mortgage carries a housing group (bypassing intake, which refuses
 * the key), throws MacroUnresolvedError: an unthreaded site fails loudly and
 * never falls back to the kernel schedule. The two drill sites and the bullet
 * site are pinned by the call-site AST check; the intake site by its own test.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { MORTGAGE_DEFAULTS, buildTLPCurve, type MarketSnapshot, type RatePath, type ZeroCurve } from "@alm/kernel";
import type { PortfolioSpec } from "../../contracts/position";
import { computeEnvironmentDurations } from "../../eve/effectiveDuration";
import { computeKeyRateDurations } from "../../eve/keyRate";
import { computeFtpResult } from "../../ftp";
import { buildScenarioGap } from "../../gap/gapEngine";
import { aggregateScenario } from "../../portfolio/aggregate";
import { CHUNK_METRICS, accumulateChunk, sinkOverBuffer } from "../../run/shard/chunk";
import { loadMarket, makeCoa, regulatoryScenarios } from "../../run/__tests__/fixtures";
import { buildBaseCurve, buildRatePath } from "../../scenario";
import { MacroUnresolvedError } from "../runMacro";

const H = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const HORIZON = 360;
const book: PortfolioSpec = {
  id: "pf-housing", label: "one housing mortgage", asOf: "2026-01-01", coa: makeCoa(),
  positions: [{ id: "m1", familyId: "MORTGAGE", coaNodeId: "mortgages", terms: { ...MORTGAGE_DEFAULTS, id: "m1", housing: H } as never }],
};
const tlp = buildTLPCurve([{ tYears: 1, spread: 0 }]);
let market: MarketSnapshot; let curve: ZeroCurve; let path: RatePath;
beforeAll(async () => { market = await loadMarket(); curve = buildBaseCurve(market); path = buildRatePath(curve, HORIZON); });

describe("each reachable site throws MacroUnresolvedError without macro", () => {
  it("aggregateScenario", () => {
    expect(() => aggregateScenario(book, { scenarioId: "S0", path }, { horizonMonths: HORIZON, asOf: book.asOf })).toThrow(MacroUnresolvedError);
  });
  it("accumulateChunk", () => {
    const sink = sinkOverBuffer(new Float64Array(CHUNK_METRICS * 1 * HORIZON), 1, HORIZON);
    expect(() => accumulateChunk(book.positions, 0, 1, Int32Array.of(0), path, HORIZON, sink)).toThrow(MacroUnresolvedError);
  });
  it("buildScenarioGap", () => {
    expect(() => buildScenarioGap(book, { scenarioId: "S0", path }, HORIZON)).toThrow(MacroUnresolvedError);
  });
  it("computeEnvironmentDurations", () => {
    const family = book.coa.families.find((f) => f.id === "MORTGAGE")!;
    expect(() => computeEnvironmentDurations([{ family, positions: book.positions }], curve, tlp, HORIZON, 100, "all-in")).toThrow(MacroUnresolvedError);
  });
  it("computeKeyRateDurations", () => {
    expect(() => computeKeyRateDurations({ portfolio: book, scenarioId: "S0", curve, tlp, horizonMonths: HORIZON })).toThrow(MacroUnresolvedError);
  });
  it("computeFtpResult", () => {
    expect(() => computeFtpResult({ portfolio: book, scenarios: regulatoryScenarios(), baseScenarioId: "S0", curve, tlp, path, horizonMonths: HORIZON,
      niiBase: { scenarioId: "S0", totalNet12: 0 } as never })).toThrow(MacroUnresolvedError);
  });
});
