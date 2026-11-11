/**
 * Build the viewer's demo RunResult by driving the real engine, and write it to
 * public/runResult.json (served as a static asset the browser bundle fetches).
 * NEVER hand-writes a number: every figure the viewer renders comes out of
 * engine.run() here, in Node, at build time.
 *
 * Run from apps/viewer with: npx tsx scripts/generateFixture.mts (or npm run
 * generate:fixture). No npm hook runs it: the committed fixtures change only
 * when it is run by hand. It also writes public/vanillaRunResult.json; that file
 * stays at its committed bytes, so a run meant to refresh runResult.json leaves
 * the vanilla file as committed. Regenerating with the same seed and config
 * reproduces the file byte-for-byte (the engine is deterministic; timestamps are
 * injected constants below, not read from a clock).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  BETA_S_CURVE_DEFAULTS,
  MBS_DEFAULTS,
  NMD_DEFAULTS,
  loadMarketSnapshot,
} from "@alm/kernel";
import {
  DEFAULT_GENERATOR_CONFIG,
  buildVanillaPortfolio,
  computeBalanceSheetTotals,
  generatePortfolio,
  vanillaAssumptionSet,
  vanillaScenarios,
} from "@alm/data";
import { createEngine } from "@alm/engine";
import type {
  AssumptionSet,
  RunRequest,
  Scenario,
} from "@alm/engine";
import type { AttributionDriver, HeadlineAttribution } from "@alm/engine";
import { REGULATORY_SHOCKS_BP } from "@alm/engine";
import { diffAssumptions } from "@alm/ai/src/compiler/diff";
import { buildRationale } from "@alm/ai/src/compiler/rationale";

/** Fixed driver order for the waterfall, matching the AttributionDriver union. */
const DRIVER_ORDER: AttributionDriver[] = [
  "rate",
  "volume",
  "mix",
  "prepay",
  "deposit-beta",
  "decay",
  "new-business",
];

/**
 * Aggregate one headline's per-(family, driver) contributions into per-driver
 * steps for the waterfall. This is display binning of numbers the engine already
 * computed (a sum of attribution rows), done here in the build step so the client
 * renders and never computes. Ordered by DRIVER_ORDER; determinism preserved.
 */
function waterfallSteps(h: HeadlineAttribution) {
  const byDriver = new Map<AttributionDriver, number>();
  for (const c of h.contributions) {
    byDriver.set(c.driver, (byDriver.get(c.driver) ?? 0) + c.amount);
  }
  const steps = DRIVER_ORDER.filter((d) => byDriver.has(d)).map((driver) => ({
    driver,
    amount: byDriver.get(driver) as number,
  }));
  return {
    metric: h.metric,
    scenarioId: h.scenarioId,
    baseValue: h.baseValue,
    scenarioValue: h.scenarioValue,
    totalDelta: h.totalDelta,
    residual: h.residual,
    steps,
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const marketPath = resolve(here, "../../../packages/kernel/public/market_public.json");
const outPath = resolve(here, "../public/runResult.json");
const vanillaOutPath = resolve(here, "../public/vanillaRunResult.json");

const AS_OF = "2026-03-31";
const HORIZON = 360;

/** A demo book: the real 11-family generator, sized down so build stays quick. */
const config = { ...DEFAULT_GENERATOR_CONFIG, asOf: AS_OF, targetPositions: 2500 };

/** Base behavioral set: kernel-default overlays bound to the behavioral families. */
function baseAssumptions(): AssumptionSet {
  return {
    schemaVersion: "1.0.0",
    id: "AS-BASE",
    label: "Base behavioral set (defaults)",
    bindings: [
      {
        familyId: "mortgages",
        overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS },
        modelVersion: "mbs-1.0",
      },
      {
        familyId: "mbs",
        overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS },
        modelVersion: "mbs-1.0",
      },
      {
        familyId: "dda",
        overlay: { kind: "nmd-decay", params: NMD_DEFAULTS },
        modelVersion: "nmd-1.0",
      },
      {
        familyId: "mma",
        overlay: { kind: "deposit-beta", params: BETA_S_CURVE_DEFAULTS },
        modelVersion: "beta-1.0",
      },
      {
        familyId: "cds",
        overlay: {
          kind: "cd-rollover",
          renewalProbability: 0.6,
          offeredSpreadBp: 25,
          termMonths: 24,
        },
        modelVersion: "cd-1.0",
      },
    ],
  };
}

/**
 * A compiled candidate the reviewer would see BEFORE running it: "MMA betas 15
 * points higher, CD renewal up to 75%". Authored as a typed object (the diff is
 * what the show-before-run panel renders), never run into the displayed numbers.
 */
function candidateAssumptions(base: AssumptionSet): AssumptionSet {
  const bindings = base.bindings.map((b) => {
    if (b.familyId === "mma" && b.overlay.kind === "deposit-beta") {
      return {
        ...b,
        overlay: {
          ...b.overlay,
          params: {
            ...b.overlay.params,
            betaMax: b.overlay.params.betaMax + 0.15,
          },
        },
      };
    }
    if (b.familyId === "cds" && b.overlay.kind === "cd-rollover") {
      return { ...b, overlay: { ...b.overlay, renewalProbability: 0.75 } };
    }
    return b;
  });
  return { ...base, id: "AS-CANDIDATE", label: "MMA betas +15bp, CD renewal 75%", bindings };
}

/** The regulatory parallel grid as static scenarios. */
function regulatoryScenarios(assumptionSetId: string): Scenario[] {
  return REGULATORY_SHOCKS_BP.map((bp) => ({
    id: `S${bp}`,
    label: bp === 0 ? "Base" : `${bp > 0 ? "+" : ""}${bp}bp parallel`,
    rateSpec: bp === 0 ? { kind: "base" as const } : { kind: "parallel" as const, shockBp: bp },
    assumptionSetId,
    newBusiness: { mode: "static" as const, rules: [] },
  }));
}

async function main(): Promise<void> {
  const market = await loadMarketSnapshot(marketPath);
  const portfolio = generatePortfolio(config);
  const totals = computeBalanceSheetTotals(portfolio);

  const base = baseAssumptions();
  const candidate = candidateAssumptions(base);
  // One array feeds both the request and the bundle, so the shipped scenario
  // metadata is by construction the definitions the engine actually ran.
  const scenarios = regulatoryScenarios(base.id);

  const request: RunRequest = {
    runId: "RUN-DEMO-1",
    portfolioId: portfolio.id,
    marketSnapshot: market,
    scenarios,
    assumptionSets: [base],
    grid: { horizonMonths: HORIZON, asOf: AS_OF },
    seed: "20260716",
    timestamps: {
      startedAt: "2026-07-16T00:00:00.000Z",
      finishedAt: "2026-07-16T00:00:02.000Z",
    },
  };

  const engine = createEngine();
  engine.loadPortfolio(portfolio);
  const runResult = engine.run(request);

  // The diff is a pure structural comparison of two data objects (no book
  // arithmetic); produced here so the client only renders it.
  const boundBase = engine.bindAssumptions(base);
  const boundCandidate = engine.bindAssumptions(candidate);
  const diff = diffAssumptions(boundBase, boundCandidate);
  const rationale = buildRationale(candidate.label, diff);

  const bundle = {
    generatedFrom: {
      note: "Produced by apps/viewer/scripts/generateFixture.mts via @alm/engine run(). No number here is hand-authored.",
      portfolioId: portfolio.id,
      positionCount: portfolio.positions.length,
      asOf: AS_OF,
      seed: request.seed,
      balanceSheet: totals,
      families: portfolio.coa.families.map((f) => ({ id: f.id, label: f.label, side: f.side })),
      scenarios: scenarios.map((s) => ({ id: s.id, label: s.label, rateSpec: s.rateSpec })),
    },
    runResult,
    derived: {
      note: "Display-only aggregation of engine attribution rows into per-driver waterfall steps, summed in the build step so the client renders and never computes.",
      waterfalls: runResult.attribution.headlines.map(waterfallSteps),
    },
    showBeforeRun: {
      baseSet: boundBase,
      candidateSet: boundCandidate,
      diff,
      rationale,
    },
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

  // eslint-disable-next-line no-console
  console.log(
    `wrote ${outPath}\n  positions=${portfolio.positions.length}` +
      ` scenarios=${runResult.nii.byScenario.length}` +
      ` notImplemented=${runResult.notImplemented.length}` +
      ` diffDeltas=${diff.deltas.length}`,
  );

  // Second bundle: the vanilla book. Same engine,
  // same bundle shape; the assumption set is honestly empty, so the
  // show-before-run panel diffs the empty set against itself (zero deltas).
  const vanillaPortfolio = buildVanillaPortfolio();
  const vanillaTotals = computeBalanceSheetTotals(vanillaPortfolio);
  const vanillaSet = vanillaAssumptionSet();
  const vanillaScenarioDefs = vanillaScenarios(vanillaSet.id);
  const vanillaRequest: RunRequest = {
    runId: "RUN-VANILLA-1",
    portfolioId: vanillaPortfolio.id,
    marketSnapshot: market,
    scenarios: vanillaScenarioDefs,
    assumptionSets: [vanillaSet],
    grid: { horizonMonths: HORIZON, asOf: vanillaPortfolio.asOf },
    seed: "vanilla",
    timestamps: {
      startedAt: "2026-07-18T00:00:00.000Z",
      finishedAt: "2026-07-18T00:00:01.000Z",
    },
  };
  const vanillaEngine = createEngine();
  vanillaEngine.loadPortfolio(vanillaPortfolio);
  const vanillaResult = vanillaEngine.run(vanillaRequest);
  const vanillaBound = vanillaEngine.bindAssumptions(vanillaSet);
  const vanillaDiff = diffAssumptions(vanillaBound, vanillaBound);

  const vanillaBundle = {
    generatedFrom: {
      note: "Produced by apps/viewer/scripts/generateFixture.mts via @alm/engine run(). No number here is hand-authored.",
      portfolioId: vanillaPortfolio.id,
      positionCount: vanillaPortfolio.positions.length,
      asOf: vanillaPortfolio.asOf,
      seed: vanillaRequest.seed,
      balanceSheet: vanillaTotals,
      families: vanillaPortfolio.coa.families.map((f) => ({ id: f.id, label: f.label, side: f.side })),
      scenarios: vanillaScenarioDefs.map((s) => ({ id: s.id, label: s.label, rateSpec: s.rateSpec })),
    },
    runResult: vanillaResult,
    derived: {
      note: "Display-only aggregation of engine attribution rows into per-driver waterfall steps, summed in the build step so the client renders and never computes.",
      waterfalls: vanillaResult.attribution.headlines.map(waterfallSteps),
    },
    showBeforeRun: {
      baseSet: vanillaBound,
      candidateSet: vanillaBound,
      diff: vanillaDiff,
      rationale: buildRationale(vanillaSet.label, vanillaDiff),
    },
  };

  writeFileSync(vanillaOutPath, `${JSON.stringify(vanillaBundle, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(
    `wrote ${vanillaOutPath}\n  positions=${vanillaPortfolio.positions.length}` +
      ` scenarios=${vanillaResult.nii.byScenario.length}` +
      ` notImplemented=${vanillaResult.notImplemented.length}`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
