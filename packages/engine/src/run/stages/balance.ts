/**
 * balance-new-business: Position + RatePath + Cashflow -> Cashflow, per scenario.
 *
 * A scenario in static mode gets its contractual series back, object-identical:
 * the pre-1c pipeline's `let primaryCF = staticCF` and nothing else. A scenario
 * in dynamic mode is projected by projectDynamicScenario, whose reinvestment
 * under-hits land in env.shortfalls for the NII stage to attach to its rows.
 *
 * NOT PURELY FUNCTIONAL, and deliberately so: this is the one stage function
 * that WRITES to the run env, filling env.shortfalls with the dynamic
 * projection's typed reinvestment diagnostics. A shortfall is not a contract
 * type any stage consumes, so it cannot ride the shelf; it rides the env, and
 * the NII stage reads it there. Every other output of this stage is pure over
 * its inputs.
 *
 * DEVIATION, recorded in the plan's deviation list and, at the 1c close, in
 * The limitations page:
 * projectDynamicScenario applies the overlays ITSELF, from the raw book and the
 * assumption set, so this stage passes env.portfolio rather than the effective
 * book its Position edge delivered. Handing it the chain's output would apply
 * every overlay twice. The Position edge is still resolved and still checked; it
 * is not yet what the wrapped call reads.
 */
import type { RatePath } from "@alm/kernel";
import type { ScenarioCashflows } from "../../contracts/results";
import { projectDynamicScenario } from "../../projection/dynamic";
import { tlpFromSnapshot } from "./curve";
import type { StageFn } from "./types";
import { requireScenario } from "./types";

export const runBalanceStage: StageFn = (env, stage, input) => {
  const out = new Map<string, ScenarioCashflows>();
  for (const scenario of env.request.scenarios) {
    const contractual = requireScenario<ScenarioCashflows>(env, stage, input, "Cashflow", scenario.id);
    if (scenario.newBusiness.mode !== "dynamic") {
      out.set(scenario.id, contractual);
      continue;
    }
    const set = env.setById.get(scenario.assumptionSetId)!;
    const path = requireScenario<RatePath>(env, stage, input, "RatePath", scenario.id);
    const dyn = projectDynamicScenario(
      env.portfolio,
      { scenario, ratePath: path, assumptions: set.bindings.length > 0 ? set : undefined },
      env.grid,
      env.behavioral,
      env.rateIndices,
      env.macro,
      // The base scenario keeps its minted tranches for the FTP block (kept only when a rule carries a template).
      // Fix round M3: the term liquidity premium curve a matched fixed template prices off, the run's own (curve.ts).
      // Every scenario keeps all its tranches only when the run opted in to the forecast gap or going-concern EVE.
      {
        keepTranches: scenario.id === env.baseScenario.id,
        tlp: tlpFromSnapshot(env.request),
        ...(env.forecastGap === true || env.goingConcernEve === true ? { keepAllTranches: true } : {}),
        // A "history" warmup reaches the dynamic projection ("flat-at-r0" refuses dynamic scenarios).
        ...(env.nmdWarmup?.record.kind === "history" ? { nmdWarmup: env.nmdWarmup.byScenario.get(scenario.id)! } : {}),
      },
    );
    out.set(scenario.id, dyn.cashflows);
    if (dyn.tranches !== undefined) env.newVolumeTranches = dyn.tranches;
    if (dyn.allTranches !== undefined) (env.allNewVolumeTranches ??= new Map()).set(scenario.id, dyn.allTranches);
    // Reinvestment under-hits land in the typed ScenarioNII.shortfalls slot
    // (schemaVersion 1.1.0), family and magnitude carried verbatim from the
    // dynamic projection's diagnostics. Nothing is absorbed silently.
    // Studio A+E contract 24: the sweep's origination notional rides beside it,
    // verbatim, for the NII stage to attach to ScenarioNII.newBusiness. Set on
    // every dynamic scenario, an empty list when no family is ruled, so an
    // absent key always means a static scenario.
    env.newBusiness.set(scenario.id, dyn.originations);
    if (dyn.shortfalls.length > 0) {
      env.shortfalls.set(
        scenario.id,
        dyn.shortfalls.map((sf) => ({
          familyId: sf.familyId,
          reinvest: sf.reinvest,
          firstBucket: sf.firstBucket,
          clampedBuckets: sf.clampedBuckets,
          targetBalanceEnd: sf.targetBalanceEnd,
          achievedBalanceEnd: sf.achievedBalanceEnd,
          balanceGapEnd: sf.balanceGapEnd,
        })),
      );
    }
  }
  return { scenario: { Cashflow: out } };
};
