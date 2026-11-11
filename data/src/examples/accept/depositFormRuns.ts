/**
 * Run a seeded deposit-form demo (apps/server/src/examples/depositForms.ts) through the engine in this process, the way its
 * launch does: the seeded setup on its example book as the file holds it (the deposit desk, or Quillfield Bank version
 * 1.2 for the funding tenor), its seeded set bound through the engine, its scenarios resolved from the shipped library
 * on the run-off basis, and the setup's engine options (the server's own engineOptionsOfSetup).
 * apps/server/src/__tests__/s3c1DepositForms.test.ts holds every block of these runs equal to the launched run's
 * result.json.
 *
 * Shared by the core accept checks nmd-b-full-beta-form, nmd-component-decay-dated-path,
 * ftp-replicating-portfolio-credit, ftp-credit-scenario-reading and quillfield-feature-demos.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bindAssumptions } from "@alm/engine/src/scenario";
import { buildRunResult, resolveDefaultContext, type AssumptionSet, type PortfolioSpec, type RunRequest, type RunResult } from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";
import { depositFormDemos, depositFormSets, type DepositFormDemo, type DepositFormDemoId } from "../../../../apps/server/src/examples/depositForms";
import { featureDemoSets } from "../../../../apps/server/src/examples/featureDemos";
import { engineOptionsOfSetup } from "../../../../apps/server/src/workspaces/setupCompile";
import type { RunSetup } from "../../../../apps/server/src/workspaces/types";
import { demoScenarios } from "./featureDemoRuns";
import { ACCEPT_TS } from "./handBooks";

export interface DepositFormRun {
  demo: DepositFormDemo;
  result: RunResult;
}

/** An example book as its file holds it. */
export function exampleBook(repoRoot: string, id: string): PortfolioSpec {
  return JSON.parse(readFileSync(join(repoRoot, "examples", `${id}.json`), "utf8")) as PortfolioSpec;
}

/**
 * Run one deposit-form demo. `edit` changes the setup first (a check's comparison run); `book` replaces the demo's book (the
 * funding-tenor check's version 1.1 run); `editSets` changes the seeded sets before they are bound (a check's
 * comparison of one form value). Pure over the repository and the market.
 */
export function runDepositFormDemo(
  repoRoot: string,
  market: MarketSnapshot,
  id: DepositFormDemoId,
  opts: { edit?: (s: RunSetup) => RunSetup; book?: PortfolioSpec; editSets?: (sets: AssumptionSet[]) => AssumptionSet[] } = {},
): DepositFormRun {
  const demo = depositFormDemos(repoRoot).find((d) => d.id === id);
  if (demo === undefined) throw new Error(`no deposit-form demo "${id}"`);
  const setup = opts.edit === undefined ? demo.setup : opts.edit(structuredClone(demo.setup));
  const book = opts.book ?? exampleBook(repoRoot, demo.bookId);
  const raw = [...depositFormSets(repoRoot), ...featureDemoSets(repoRoot)];
  const sets = (opts.editSets === undefined ? raw : opts.editSets(structuredClone(raw))).map((s) => bindAssumptions(s));
  const setIds = setup.inputs.assumptionSetIds as string[];
  const request: RunRequest = {
    runId: `accept-demo-${id}`,
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
