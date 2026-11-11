/**
 * A StageRunEnv over a request and a book, for the stage-function unit tests.
 * It resolves the seams from a mounted context exactly as buildRunResult does,
 * so a stage function under test sees what it sees in a real run.
 */
import type { Context } from "@alm/harness";
import type { NotImplemented } from "../../contracts/errors";
import type { PortfolioSpec } from "../../contracts/position";
import type { FamilyNewBusiness, ReinvestmentShortfall } from "../../contracts/results";
import type { RunRequest } from "../../contracts/run";
import type { AssumptionSet } from "../../contracts/assumptions";
import { resolveRunMacro } from "../../macro/runMacro";
import { buildCellPlan } from "../../portfolio/cells";
import { bindAssumptions } from "../../scenario";
import type { StageRunEnv } from "../stages";

export function makeTestEnv(request: RunRequest, portfolio: PortfolioSpec, harness: Context): StageRunEnv {
  const setById = new Map<string, AssumptionSet>();
  for (const set of request.assumptionSets) setById.set(set.id, bindAssumptions(set));
  // The assumption-set axis, built exactly as buildRunResult builds it: the ids
  // a scenario references, deduplicated, in scenario first-appearance order.
  const assumptionSetIds: string[] = [];
  for (const scenario of request.scenarios) {
    if (!setById.has(scenario.assumptionSetId)) continue;
    if (assumptionSetIds.includes(scenario.assumptionSetId)) continue;
    assumptionSetIds.push(scenario.assumptionSetId);
  }
  const baseScenario = request.scenarios.find((s) => s.rateSpec.kind === "base")!;
  return {
    request,
    portfolio,
    grid: request.grid,
    horizonMonths: request.grid.horizonMonths,
    baseScenario,
    setById,
    assumptionSetIds,
    shards: undefined,
    // Resolved as buildRunResult resolves it; a stage never substitutes the sentinel.
    macro: resolveRunMacro(request, request.marketSnapshot),
    curves: harness.get("curves"),
    ratePaths: harness.get("ratePaths"),
    behavioral: harness.get("behavioral"),
    metrics: harness.get("metrics"),
    licensedBindings: [],
    positionsMatched: new Map<string, number>(),
    cellPlan: buildCellPlan(portfolio, undefined),
    shortfalls: new Map<string, ReinvestmentShortfall[]>(),
    newBusiness: new Map<string, FamilyNewBusiness[]>(),
    notImplemented: [] as NotImplemented[],
    log: () => {},
  };
}
