/**
 * Run a seeded feature demo through the engine in this process, the way its launch does: the
 * seeded setup (apps/server/src/examples/featureDemos.ts) on Quillfield Bank (examples/mid-size-bank-v1.json, version
 * 1.1), its seeded sets bound through the engine, its scenarios resolved from the shipped library or inline on the
 * run-off basis, the setup's engine options (the server's own engineOptionsOfSetup), and, for a demo that saves
 * per-position results, the server's own instruments pass. apps/server/src/__tests__/s3b1FeatureDemos.test.ts holds
 * every block of these runs equal to the launched run's result.json and instruments.json.
 *
 * Shared by the core accept checks seg-ear, per-position-drilldown and quillfield-feature-demos.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bindAssumptions } from "@alm/engine/src/scenario";
import { REGULATORY_GRID_LIBRARY } from "@alm/engine/src/scenario/library";
import { buildRunResult, resolveDefaultContext, type PortfolioSpec, type RunRequest, type RunResult, type Scenario } from "@alm/engine";
import type { InstrumentEnvironment, InstrumentsFile } from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";
import { featureDemos, featureDemoSets, type FeatureDemo, type FeatureDemoId } from "../../../../apps/server/src/examples/featureDemos";
import { engineOptionsOfSetup } from "../../../../apps/server/src/workspaces/setupCompile";
import { buildInstrumentsFile } from "../../../../apps/server/src/jobs/instrumentsPass";
import type { RunSetup } from "../../../../apps/server/src/workspaces/types";
import { ACCEPT_TS } from "./handBooks";

export interface DemoRun {
  demo: FeatureDemo;
  result: RunResult;
  instruments?: InstrumentsFile;
}

/** The example bank as the file holds it. */
export function demoBank(repoRoot: string): PortfolioSpec {
  return JSON.parse(readFileSync(join(repoRoot, "examples", "mid-size-bank-v1.json"), "utf8")) as PortfolioSpec;
}

/** The scenarios a demo setup's launch composes, on the run-off basis (every demo's NII basis). */
export function demoScenarios(setup: RunSetup): Scenario[] {
  const setIds = setup.inputs.assumptionSetIds;
  if (!Array.isArray(setIds) || setIds.length !== 1) throw new Error(`demo "${setup.name}" names ${JSON.stringify(setIds)}; expected one set`);
  const setId = setIds[0]!;
  const lib = (ref: string) => {
    const [libId, id] = ref.split("#");
    if (libId !== REGULATORY_GRID_LIBRARY.id) throw new Error(`demo "${setup.name}" names library "${libId}"`);
    const def = REGULATORY_GRID_LIBRARY.scenarios.find((s) => s.id === id);
    if (def === undefined) throw new Error(`demo "${setup.name}" names unknown scenario "${ref}"`);
    return def;
  };
  const defs =
    setup.scenarios.kind === "library"
      ? setup.scenarios.refs.map(lib)
      : setup.scenarios.kind === "plan-scenarios"
        ? setup.scenarios.items.map((i) => ("ref" in i ? lib(i.ref) : i))
        : (() => {
            throw new Error(`demo "${setup.name}" names a slate`);
          })();
  return defs.map((d) => ({ id: d.id, label: d.label ?? d.id, rateSpec: d.rateSpec, assumptionSetId: setId, newBusiness: { mode: "static", rules: [] } }) as Scenario);
}

/**
 * Run one demo. `edit` changes the setup first (a check's comparison run); `book` replaces the bank (a degeneracy
 * run). Pure over the repository and the market.
 */
export function runFeatureDemo(
  repoRoot: string,
  market: MarketSnapshot,
  id: FeatureDemoId,
  opts: { edit?: (s: RunSetup) => RunSetup; book?: PortfolioSpec } = {},
): DemoRun {
  const demo = featureDemos(repoRoot).find((d) => d.id === id);
  if (demo === undefined) throw new Error(`no feature demo "${id}"`);
  const setup = opts.edit === undefined ? demo.setup : opts.edit(structuredClone(demo.setup));
  const book = opts.book ?? demoBank(repoRoot);
  const sets = featureDemoSets(repoRoot).map((s) => bindAssumptions(s));
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
  let environment: InstrumentEnvironment | undefined;
  let envError: Error | undefined;
  const wants = setup.instrumentResults.save;
  const result = buildRunResult(request, book, {
    ...resolveDefaultContext(),
    ...engineOptionsOfSetup(setup),
    ...(wants
      ? {
          onInstrumentEnvironment: (e: InstrumentEnvironment | Error) => {
            if (e instanceof Error) envError = e;
            else environment = e;
          },
        }
      : {}),
  } as never);
  if (!wants) return { demo, result };
  if (environment === undefined) throw envError ?? new Error("the engine handed over no instrument environment");
  const baseSet = request.scenarios.find((s) => s.id === environment!.baseScenarioId)!.assumptionSetId;
  const effective = environment.booksBySet.get(baseSet)!;
  const nodes = setup.instrumentResults.coaNodeIds;
  const instruments = buildInstrumentsFile(request, effective, result, environment.perPositionSeg, environment, nodes !== undefined && nodes.length > 0 ? { coaNodeIds: nodes } : {});
  return { demo, result, instruments };
}
