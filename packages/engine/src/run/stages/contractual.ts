/**
 * contractual-cashflow: Position + RatePath -> Cashflow + RepricingSchedule,
 * per scenario.
 *
 * One whole-book chunked pass, exactly as the pre-1c pipeline ran it:
 * scenarios grouped by assumption set in FIRST-APPEARANCE order, each group over
 * that set's effective book, then one assembleScenarioCashflows per scenario.
 * The group order is load-bearing for byte identity, because the chunked fold is
 * order-fixed by construction and the grouping decides which positions are in
 * which chunk.
 *
 * SPEED RULE: no seam lookup and no event inside this pass, and none inside the
 * per-position loop it calls. The walker sees one stage that turns an effective
 * book and a rate path into series; the fused per-position work is invisible to
 * it, which is the point.
 */
import type { RatePath } from "@alm/kernel";
import type { PortfolioSpec } from "../../contracts/position";
import type { ScenarioCashflows } from "../../contracts/results";
import type { FamilySeries } from "../../gap";
import { assembleScenarioCashflows } from "../../portfolio";
import { PlanGraphError } from "../executorErrors";
import { foldCellsToFamilies } from "../shard/chunk";
import { DEFAULT_CELL_BUDGET_BYTES, runStaticPass, type StaticPassGroup } from "../shard/staticPass";
import type { StageFn } from "./types";
import { positionsFor, requireScenario } from "./types";

export const runContractualStage: StageFn = (env, stage, input) => {
  const groupBySet = new Map<string, StaticPassGroup>();
  const groups: StaticPassGroup[] = [];
  const bookBySet = new Map<string, PortfolioSpec>();
  for (const scenario of env.request.scenarios) {
    if (!env.setById.has(scenario.assumptionSetId)) {
      throw new PlanGraphError(
        stage.id,
        `run: scenario "${scenario.id}" references unknown assumption set "${scenario.assumptionSetId}"`,
      );
    }
    const path = requireScenario<RatePath>(env, stage, input, "RatePath", scenario.id);
    let group = groupBySet.get(scenario.assumptionSetId);
    if (!group) {
      const book = positionsFor(env, stage, input, scenario.assumptionSetId);
      bookBySet.set(scenario.assumptionSetId, book);
      group = { positions: book.positions, scenarios: [] };
      groupBySet.set(scenario.assumptionSetId, group);
      groups.push(group);
    }
    // A run that named nmdWarmup hands each scenario its own deposit history; otherwise no key.
    const nmdWarmup = env.nmdWarmup?.byScenario.get(scenario.id);
    // A run whose sets bind a full beta form hands each scenario its short-rate shift.
    const depositShiftPct = env.depositShiftByScenario?.get(scenario.id);
    group.scenarios.push({
      scenarioId: scenario.id,
      rateSpec: scenario.rateSpec,
      path,
      ...(nmdWarmup !== undefined ? { nmdWarmup } : {}),
      ...(depositShiftPct !== undefined ? { depositShiftPct } : {}),
    });
  }

  const familyIds = env.portfolio.coa.families.map((f) => f.id);
  const famIndex = new Map<string, number>();
  for (let i = 0; i < familyIds.length; i++) famIndex.set(familyIds[i]!, i);
  const cellPlan = env.cellPlan;
  // The pass accumulates at CELL grain and the family series is the
  // ordered fold over each family's contiguous cell range. Under the identity
  // plan a range holds one cell and the fold aliases it, so the arrays handed
  // downstream are the very arrays the pre-2b pass produced.
  const cellSeries = runStaticPass(
    groups,
    cellPlan,
    env.horizonMonths,
    env.shards,
    env.request.marketSnapshot,
    DEFAULT_CELL_BUDGET_BYTES,
    env.rateIndices,
    env.macro,
    // The liquidity flows setting, read here for one reason: a run that asked for
    // "principal-plus-interest" folds the gap interest carrier in this same pass.
    env.liquidityFlows,
  );

  const cashflows = new Map<string, ScenarioCashflows>();
  const repricing = new Map<string, FamilySeries>();
  for (const scenario of env.request.scenarios) {
    const cells = cellSeries.get(scenario.id)!;
    const series = foldCellsToFamilies(cells, cellPlan.familyCellRange, env.horizonMonths);
    const book = bookBySet.get(scenario.assumptionSetId)!;
    cashflows.set(scenario.id, assembleScenarioCashflows(book, scenario.id, series, env.horizonMonths));
    // The per-cell series beside the family rows, never instead of
    // them. Present only when a view is declared; the identity plan's cells
    // ARE the families and a second copy of them would say nothing.
    //
    // COPY, not share, for two reasons that both hold on their own.
    //
    // First, the TYPE requires it. BucketedSeries is number[] and the sink is a
    // Float64Array, so there is no sharing form to choose: Array.from is the
    // conversion, and it allocates.
    //
    // Second, SYMMETRY. The family half of this same envelope is already an
    // independent copy of the sink, made by toSeries (portfolio/aggregate.ts,
    // three Array.from calls). Building the cell half the same way means neither
    // half aliases the sink and neither half aliases the other, so a reader does
    // not have to know which rows are safe to write through.
    //
    // What is NOT a reason, recorded so it is not rediscovered as one: addDelta
    // (projection/dynamic/dynamicNewBusiness.ts) does write a BucketedSeries in
    // place, but it cannot reach a cell row. projectDynamicScenario calls
    // aggregateScenario itself and addDelta writes only into that fresh
    // envelope's rows, which toSeries has already copied; the balance stage then
    // discards this contractual object wholesale. And foldCellsToFamilies
    // aliases the Float64Array SINK, which is one layer below the envelope, not
    // the envelope row itself. The copy is right; that particular hazard is not
    // why.
    //
    // This arm is written for EVERY scenario, dynamic ones included: the loop
    // below has no new-business branch, because this pass ran the cell grain for
    // all of them. What a DYNAMIC scenario loses is the PUBLISHED arm, one layer
    // downstream: the balance stage replaces its Cashflow object with the
    // dynamic projection's own, which has no cell index, and the envelope
    // publishes that replaced object. The EVE and gap arms survive, because
    // st-eve and st-gap read this stage whatever the new-business mode is. Full
    // statement on the contract, at ScenarioCashflows.byCell.
    if (cellPlan.groupingDimensions.length > 0) {
      const scn = cashflows.get(scenario.id)!;
      scn.byCell = cellPlan.cells.map((cell, i) => ({
        cellId: cell.id,
        series: {
          balance: Array.from(cells.balance[i]!),
          principal: Array.from(cells.principal[i]!),
          interest: Array.from(cells.interest[i]!),
        },
      }));
    }
    repricing.set(scenario.id, {
      famIndex,
      repricing: series.repricing,
      principal: series.gapPrincipal,
      // Slice 4a (ruling 4): the contractual interest of this same pass and the
      // same cash flows as the gap fold, beside `principal`, never the NII
      // stage's Cashflow edge (on a dynamic scenario that edge carries
      // new-business interest; the gap ladder is the static run-off). Present
      // only when the pass was asked for it, aliased like the two arrays above.
      ...(series.gapInterest !== undefined ? { interest: series.gapInterest } : {}),
      // The cell-grain twin rides beside the family arrays, as a
      // side-car the ladder reads only for its byCell arm. The ladder's own
      // rows and its COA roll-up keep reading families, so the headline gap is
      // the same number with a view declared and without one.
      //
      // The two Float64Array[] are handed over as they are, not copied. Nothing
      // here parallels the envelope's Array.from: FamilySeries is an internal
      // carrier typed Float64Array on both halves, the family half of this very
      // object already hands `series.repricing` over the same way, and the gap
      // ladder only reads them, banding each into a fresh Float64Array inside
      // nodeBandRows. A copy would allocate a second book-sized buffer per
      // scenario to protect against a write that does not exist.
      //
      // The dynamic caveat recorded above for the CASHFLOW arm does not carry
      // here, and the difference is worth stating because the two blocks sit
      // together. RepricingSchedule is produced by this stage and by no other;
      // the balance stage replaces Cashflow alone, and both gap ladders read
      // the static runoff of the existing book whatever the new-business mode
      // is (run/orchestrate.ts header). So a dynamic scenario's gap ladder
      // carries the same cell arm a static one does, and its cells still sum to
      // its families, because both halves come out of this one pass.
      ...(cellPlan.groupingDimensions.length > 0
        ? {
            byCell: {
              cells: cellPlan.cells,
              repricing: cells.repricing,
              principal: cells.gapPrincipal,
            },
          }
        : {}),
    });
  }
  return { scenario: { Cashflow: cashflows, RepricingSchedule: repricing } };
};
