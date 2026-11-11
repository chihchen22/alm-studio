/**
 * behavioral: Position + RatePath -> Position, per assumption set.
 *
 * The stage is the LICENSE and the assumption set keeps the parameters (spec
 * Section 4.1). This function applies exactly the bindings that name this stage,
 * in assumption-set binding order, to the book it received from its predecessor
 * in the chain. It licenses nothing by itself and invents no parameter.
 *
 * A stage that licenses no binding returns the book it received, object-
 * identical: the chain downstream reads exactly what it would have read, and the
 * walker logs the stage as skipped: "no-binding". Breaking the chain instead
 * would turn a plan's unbound stage into a refusal, which spec Section 4.1
 * expressly does not do.
 *
 * RatePath is in the declared consumes because a behavioral model is entitled to
 * the scenario's path; the four built-in kinds rewrite terms without reading it,
 * and a plugin that needs it reads it from the input the walker resolved.
 */
import type { PortfolioSpec } from "../../contracts/position";
import { applyLicensedOverlays } from "../../projection/static/applyOverlays";
import { macroTargetsOf, requireRunMacro } from "../../macro/runMacro";
import type { StageFn } from "./types";
import { positionsFor } from "./types";

export const runBehavioralStage: StageFn = (env, stage, input) => {
  const mine = env.licensedBindings.filter((l) => l.stageId === stage.id);
  const out = new Map<string, PortfolioSpec>();
  // The assumption-set axis, not every set the request carries: a set no
  // scenario references is overlaid for nothing, and the walker opens no scope
  // to put the result in.
  for (const assumptionSetId of env.assumptionSetIds) {
    const set = env.setById.get(assumptionSetId)!;
    const book = positionsFor(env, stage, input, assumptionSetId);
    const licensed = new Set<number>();
    for (let i = 0; i < set.bindings.length; i++) {
      // The binding INDEX is the identity: two bindings of one kind
      // on one family, split by selector, differ only here.
      const owned = mine.some((l) => l.assumptionSetId === assumptionSetId && l.bindingIndex === i);
      if (owned) licensed.add(i);
    }
    out.set(assumptionSetId, applyLicensedOverlays(book, set, licensed, env.behavioral, macroTargetsOf(requireRunMacro(env.macro, `behavioral stage "${stage.id}"`))));
  }
  return { assumptionSet: { Position: out } };
};
