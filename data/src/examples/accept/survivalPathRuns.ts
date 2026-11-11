/**
 * Run the seeded S3d-1 demo (apps/server/src/examples/survivalPathDemo.ts) through the engine in this process, the way
 * its launch does: the seeded setup on Quillfield Bank as the file holds it, its seeded set bound through the engine,
 * its scenarios resolved from the shipped library on the run-off basis, and the setup's engine options (the server's
 * own engineOptionsOfSetup). apps/server/src/__tests__/s3d1SurvivalPath.test.ts holds the launched run's
 * liquidityStress block equal to this one.
 */
import { bindAssumptions } from "@alm/engine/src/scenario";
import { buildRunResult, resolveDefaultContext, type PortfolioSpec, type RunRequest, type RunResult } from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";
import { featureDemoSets } from "../../../../apps/server/src/examples/featureDemos";
import { survivalPathDemos, type SurvivalPathDemo } from "../../../../apps/server/src/examples/survivalPathDemo";
import { engineOptionsOfSetup } from "../../../../apps/server/src/workspaces/setupCompile";
import type { RunSetup } from "../../../../apps/server/src/workspaces/types";
import { exampleBook } from "./depositFormRuns";
import { demoScenarios } from "./featureDemoRuns";
import { ACCEPT_TS } from "./handBooks";

/** Run the demo; `edit` changes the setup first, `book` replaces the bank (a check's comparison run). */
export function runSurvivalPathDemo(
  repoRoot: string,
  market: MarketSnapshot,
  opts: { edit?: (s: RunSetup) => RunSetup; book?: PortfolioSpec } = {},
): { demo: SurvivalPathDemo; result: RunResult } {
  const demo = survivalPathDemos(repoRoot)[0]!;
  const setup = opts.edit === undefined ? demo.setup : opts.edit(structuredClone(demo.setup));
  const book = opts.book ?? exampleBook(repoRoot, demo.bookId);
  const sets = featureDemoSets(repoRoot).map((s) => bindAssumptions(s));
  const setIds = setup.inputs.assumptionSetIds as string[];
  const request: RunRequest = {
    runId: "accept-demo-survival-path",
    portfolioId: book.id,
    marketSnapshot: market,
    scenarios: demoScenarios(setup),
    assumptionSets: sets.filter((s) => setIds.includes(s.id)),
    grid: { horizonMonths: setup.gridHorizonMonths, asOf: book.asOf },
    seed: "platform-0",
    timestamps: { ...ACCEPT_TS },
  };
  const result = buildRunResult(request, book, { ...resolveDefaultContext(), ...engineOptionsOfSetup(setup) } as never);
  return { demo, result };
}
