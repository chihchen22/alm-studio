/**
 * The forecast gap arm: both gap ladders with the new volume a scenario's balance plan
 * makes, added to the contractual run-off ladders, which stay the default view and are not touched.
 *
 * For each tranche the sweep minted at bucket k (month 1 of the tranche is bucket k):
 *
 *   liquidity  the tranche's principal in the bucket it is received (bucket k + m - 1 for its month m), and its funding
 *              at origination, the notional, booked as negative principal in bucket k - 1, as a drawdown is: the
 *              bucket of the runoff it replaces, which comes back at the end of month k, time k / 12 (fix round M1;
 *              going-concern EVE times the funding the same). An asset tranche is cash out when it is made and cash in
 *              as it repays; a deposit tranche the reverse. So a balance held flat by replacing its runoff nets in
 *              each bucket to its residual, about zero, the first bucket included.
 *   repricing  the tranche's repricing volume, folded by the same rule as any position (accumulateGapPosition): a
 *              fixed tranche reprices as its principal runs off, a floater at its next reset after origination, the
 *              beta slice of a beta deposit in its origination month. Making a tranche sets its rate; it is not a
 *              repricing event of a dollar already counted, so origination adds nothing here.
 *   interest   on a run that asked for the interest-inclusive liquidity ladder, the tranche's interest on its
 *              payment date.
 *
 * Cash flows past the grid are dropped, as the contractual ladders drop them. No kernel file changes.
 */
import type { PortfolioSpec } from "../contracts/position";
import type { ForecastGapResult, GapLadder } from "../contracts/results";
import type { LiquidityFlowsOption } from "../contracts/run";
import type { SweptTranche } from "../projection/dynamic";
import type { GapLadderBuckets } from "./bucketOptions";
import { accumulateGapPosition, buildGapFromSeries, type BucketSeriesPair, type FamilySeries } from "./gapEngine";

export const FORECAST_GAP_NOTE =
  "The forecast gap adds the new volume the plan makes to the contractual ladders: each tranche's principal and repricing from the month it is made, and its funding as an outflow for a loan or an inflow for a deposit in the month the runoff it replaces comes back, so a replaced runoff nets in its own month.";

/**
 * A copy of the contractual series with the tranches added (the byCell side-car is left out: new volume lands at
 * family grain). The contractual arrays are not written.
 */
export function forecastFamilySeries(contractual: FamilySeries, tranches: readonly SweptTranche[], horizon: number): FamilySeries {
  const copy = (a: Float64Array[]): Float64Array[] => a.map((x) => Float64Array.from(x));
  const out: FamilySeries = {
    famIndex: contractual.famIndex,
    repricing: copy(contractual.repricing),
    principal: copy(contractual.principal),
    ...(contractual.interest !== undefined ? { interest: copy(contractual.interest) } : {}),
  };
  for (const t of tranches) {
    const fi = contractual.famIndex.get(t.familyId);
    if (fi === undefined) throw new Error(`forecastFamilySeries: tranche of unknown family "${t.familyId}"`);
    const k = t.bucket;
    if (k < 0 || k >= horizon) continue;
    const len = horizon - k;
    const scratch: BucketSeriesPair = {
      repricing: [new Float64Array(len)],
      principal: [new Float64Array(len)],
      ...(out.interest !== undefined ? { interest: [new Float64Array(len)] } : {}),
    };
    accumulateGapPosition(scratch, 0, t.instrument, t.instrument.generateCashflows(t.path), len, t.path);
    const pr = out.principal[fi]!;
    const rp = out.repricing[fi]!;
    // Fix round M1: the funding is paid when the runoff it replaces comes back, the end of bucket k - 1 (time k / 12,
    // as going-concern EVE times it), so a replaced runoff nets in its own bucket. The sweep never mints at 0.
    pr[k > 0 ? k - 1 : 0]! -= t.notional;
    for (let j = 0; j < len; j++) {
      pr[k + j]! += scratch.principal[0]![j]!;
      rp[k + j]! += scratch.repricing[0]![j]!;
    }
    if (out.interest !== undefined) {
      const it = out.interest[fi]!;
      for (let j = 0; j < len; j++) it[k + j]! += scratch.interest![0]![j]!;
    }
  }
  return out;
}

/** The forecast arm for every scenario, in request order: a static scenario's ladders equal its contractual ones. */
export function computeForecastGap(
  scenarios: ReadonlyArray<{ id: string }>,
  inputs: ReadonlyMap<string, { series: FamilySeries; book: PortfolioSpec }>,
  tranchesByScenario: ReadonlyMap<string, readonly SweptTranche[]> | undefined,
  horizon: number,
  buckets?: GapLadderBuckets,
  liquidityFlows?: LiquidityFlowsOption,
): ForecastGapResult {
  const repricing: GapLadder[] = [];
  const liquidity: GapLadder[] = [];
  for (const s of scenarios) {
    const inp = inputs.get(s.id);
    if (inp === undefined) throw new Error(`computeForecastGap: scenario "${s.id}" has no contractual gap series`);
    const series = forecastFamilySeries(inp.series, tranchesByScenario?.get(s.id) ?? [], horizon);
    const both = buildGapFromSeries(inp.book, s.id, series, horizon, buckets, liquidityFlows);
    repricing.push(both.repricing);
    liquidity.push(both.liquidity);
  }
  return { note: FORECAST_GAP_NOTE, repricing, liquidity };
}
