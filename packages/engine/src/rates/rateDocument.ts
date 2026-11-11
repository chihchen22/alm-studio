/**
 * The rate document builder. Pure: a function of the request plus,
 * on a stochastic run, the simulation object. It reads no envelope, no shelf,
 * no store and no clock.
 *
 * Ruling 3 (2026-09-17): the curves and paths are REBUILT from the request
 * by the same functions the run used: `buildBaseCurve` and `shockedCurve` from
 * the rate-environment seam and `buildScenarioRatePath` from the static pass.
 * The identity is proven in the test file step for step with `Object.is`.
 *
 * The builder recomputes the DETERMINISTIC path only. A scenario that names
 * another registered rate-path model gets its shocked curve and an omission
 * marker; the builder has no registry and will not guess a path it did not run.
 *
 * The step is never restated here: `grid.dtYears` is READ OFF a built path, so
 * the document reports whatever step the path constructor actually used rather
 * than a local copy of the default that could drift from it.
 */
import type { BGMSimulationResult, HWSimulationResult, RatePath, ZeroCurve } from "@alm/kernel";
import type { AssumptionSet } from "../contracts/assumptions";
import {
  RATE_DOCUMENT_SCHEMA_VERSION,
  type BgmRateFan,
  type ClientRateRow,
  type CurveNodes,
  type MonthlyRatePath,
  type RateDocument,
  type ScenarioRates,
  type StochasticRateFan,
} from "../contracts/rateDocument";
import type { RunRequest } from "../contracts/run";
import type { Scenario } from "../contracts/scenario";
import { STOCHASTIC_QUANTILES } from "../contracts/stochastic";
import { buildScenarioRatePath } from "../projection/static/staticRunoff";
import { quantileSorted } from "../run/stochastic";
import { buildBaseCurve, buildRatePath, shockedCurve } from "../scenario/rateEnvironment";
import { quoteTenorsOf } from "../curveBuilder/quoteTenors";
import { clientRateRow } from "./clientRate";
import { RateDocumentError } from "./errors";

/** The id the term-structure stage substitutes when a scenario names no model. */
const DETERMINISTIC_MODEL = "deterministic";

// The error classes live in a leaf module so clientRate.ts can use them without
// importing this file; re-exported so every importer and instanceof check keeps
// seeing the same class objects.
export { RateDocumentError, ClientRateBenchmarkError } from "./errors";

export interface RateDocumentInput {
  runId: string;
  mode: "deterministic" | "stochastic";
  /**
   * Supplied by the runner on a stochastic run: the simulation the envelope came
   * from. The Hull-White arm carries no `model` (as before the slice); the BGM arm
   * names its model and hands over the full 360-month kernel simulation.
   */
  stochastic?:
    | { scenarioId: string; sim: HWSimulationResult }
    | { scenarioId: string; model: "bgm-lmm-2f"; sim: BGMSimulationResult };
}

/** The 1D saved tenor, years: the BGM fan's row (BGM_SAVED_TENORS_YEARS[0]). */
const ONE_DAY_YEARS = 1 / 360;

/**
 * A zero curve at its quote tenors, with the discount identity df = exp(-z t)
 * restated. A curve built from a curveSetup block on dense nodes reports the
 * quotes it was built from; any other curve has no
 * registration, so its quote tenors are its own nodes and z read there is the
 * node value itself.
 */
export function curveNodesOf(curve: ZeroCurve): CurveNodes {
  const t = quoteTenorsOf(curve);
  const z = t.map((ti) => curve.zeroRate(ti));
  const df = t.map((ti, i) => Math.exp(-z[i] * ti));
  return { t, z, df };
}

function monthlyPathOf(path: RatePath, horizonMonths: number): MonthlyRatePath {
  const rate = new Array<number>(horizonMonths);
  for (let k = 0; k < horizonMonths; k++) rate[k] = path.rateAt(k);
  return { times: [...path.times], rate };
}

function scenarioRatesOf(
  baseCurve: ZeroCurve,
  scenario: Scenario,
  horizonMonths: number,
  setById: ReadonlyMap<string, AssumptionSet>,
): ScenarioRates {
  const model = scenario.ratePathModel ?? DETERMINISTIC_MODEL;
  const shocked = shockedCurve(baseCurve, scenario.rateSpec);
  const entry: ScenarioRates = {
    scenarioId: scenario.id,
    rateSpecKind: scenario.rateSpec.kind,
    ratePathModel: model,
    curve: curveNodesOf(shocked),
  };
  if (model === DETERMINISTIC_MODEL) {
    const built = buildScenarioRatePath(baseCurve, scenario, horizonMonths);
    entry.path = monthlyPathOf(built, horizonMonths);
    // An unknown set id gets no rows and no throw: the run defers that refusal
    // to the contractual stage, which names the scenario, so the document
    // builder does not refuse what the run itself defers.
    const set = setById.get(scenario.assumptionSetId);
    if (set !== undefined) {
      const rows: ClientRateRow[] = [];
      for (const binding of set.bindings) {
        if (binding.overlay.kind !== "loan-client-rate") continue;
        rows.push(clientRateRow(set, binding, built, shocked, horizonMonths, scenario.id));
      }
      if (rows.length > 0) entry.clientRates = rows;
    }
  } else {
    entry.pathOmitted =
      `rate path model "${model}" is not the deterministic built-in; ` +
      `the rate document recomputes only the deterministic path`;
  }
  return entry;
}

/**
 * The step the paths were built on, read off a built path rather than restated.
 * A document whose scenarios all omit their path (or a request with no scenario
 * at all) has nothing to read, so one throwaway one-step deterministic path on
 * the base curve answers for the step; it is discarded immediately.
 */
function dtYearsOf(scenarios: ScenarioRates[], baseCurve: ZeroCurve): number {
  for (const entry of scenarios) {
    const times = entry.path?.times;
    if (times !== undefined && times.length >= 2) return times[1] - times[0];
  }
  const probe = buildRatePath(baseCurve, 1);
  return probe.times[1] - probe.times[0];
}

/**
 * The short-rate fan: per step, the sample mean and the pinned quantiles across
 * paths, by the same order-statistic interpolation the envelope's distributions
 * use (`quantileSorted`, shared rather than restated so the two never drift).
 */
export function buildStochasticRateFan(scenarioId: string, sim: HWSimulationResult): StochasticRateFan {
  const nPaths = sim.nPaths;
  if (sim.rPaths.length !== nPaths) {
    throw new RateDocumentError(
      `stochastic rate fan: sim.nPaths is ${nPaths} but sim.rPaths holds ${sim.rPaths.length} rows`,
    );
  }
  if (nPaths < 1) throw new RateDocumentError("stochastic rate fan: no paths to summarise");
  const nSteps = sim.times.length;
  const mean = new Array<number>(nSteps);
  const quantiles = STOCHASTIC_QUANTILES.map((p) => ({ p, values: new Array<number>(nSteps) }));
  const column = new Float64Array(nPaths);
  for (let k = 0; k < nSteps; k++) {
    let sum = 0;
    for (let p = 0; p < nPaths; p++) {
      const r = sim.rPaths[p][k];
      column[p] = r;
      sum += r;
    }
    mean[k] = sum / nPaths;
    column.sort();
    for (const q of quantiles) q.values[k] = quantileSorted(column, q.p);
  }
  return {
    scenarioId,
    nPaths,
    a: sim.a,
    sigma: sim.sigma,
    times: [...sim.times],
    mean,
    quantiles,
  };
}

/**
 * The BGM fan: per step, the sample mean and the pinned quantiles across paths of
 * the 1D saved forward, over the first `horizonMonths` rows of the simulation (the
 * kernel simulates 360 months whatever the run horizon, decision 97). The same
 * shared `quantileSorted` as the Hull-White fan and the envelope.
 */
export function buildBgmRateFan(scenarioId: string, sim: BGMSimulationResult, horizonMonths: number): BgmRateFan {
  const nPaths = sim.nPaths;
  const nRows = sim.times.length;
  const nTenors = sim.tenors.length;
  if (nPaths < 1) throw new RateDocumentError("BGM rate fan: no paths to summarise");
  if (sim.rates.length !== nPaths * nRows * nTenors) {
    throw new RateDocumentError(
      `BGM rate fan: sim.nPaths is ${nPaths} but sim.rates holds ${sim.rates.length} values ` +
        `for ${nRows} steps and ${nTenors} saved tenors`,
    );
  }
  if (!Number.isInteger(horizonMonths) || horizonMonths < 1 || horizonMonths > nRows) {
    throw new RateDocumentError(
      `BGM rate fan: a horizon of ${String(horizonMonths)} months does not fit the ${nRows}-step simulation`,
    );
  }
  const ti = sim.tenors.findIndex((t) => Math.abs(t - ONE_DAY_YEARS) < 1e-12);
  if (ti < 0) throw new RateDocumentError("BGM rate fan: the simulation saved no 1D tenor");
  const mean = new Array<number>(horizonMonths);
  const quantiles = STOCHASTIC_QUANTILES.map((p) => ({ p, values: new Array<number>(horizonMonths) }));
  const column = new Float64Array(nPaths);
  for (let k = 0; k < horizonMonths; k++) {
    let sum = 0;
    for (let p = 0; p < nPaths; p++) {
      const r = sim.rates[(p * nRows + k) * nTenors + ti];
      column[p] = r;
      sum += r;
    }
    mean[k] = sum / nPaths;
    column.sort();
    for (const q of quantiles) q.values[k] = quantileSorted(column, q.p);
  }
  return {
    scenarioId,
    nPaths,
    model: "bgm-lmm-2f",
    bgm: {
      a: sim.a,
      b: sim.b,
      c: sim.c,
      d: sim.d,
      beta: sim.beta,
      volScalar: sim.volScalar,
      displacement: sim.displacement,
      cevBeta: sim.cevBeta,
    },
    times: Array.from(sim.times.subarray(0, horizonMonths)),
    mean,
    quantiles,
  };
}

/** Build the rate document for a run from its request (and, stochastic, its simulation). */
export function buildRateDocument(request: RunRequest, input: RateDocumentInput): RateDocument {
  const horizonMonths = request.grid.horizonMonths;
  if (!Number.isInteger(horizonMonths) || horizonMonths < 1) {
    throw new RateDocumentError(
      `rate document: grid.horizonMonths must be a positive integer, got ${String(horizonMonths)}`,
    );
  }
  if (input.mode === "stochastic" && input.stochastic === undefined) {
    throw new RateDocumentError(
      "rate document: a stochastic run must supply the simulation it ran (input.stochastic)",
    );
  }
  const baseCurve = buildBaseCurve(request.marketSnapshot);
  // Duplicates are refused earlier by the run (orchestrate.ts), so a plain Map suffices.
  const setById = new Map(request.assumptionSets.map((s) => [s.id, s] as const));
  const scenarios = request.scenarios.map((s) => scenarioRatesOf(baseCurve, s, horizonMonths, setById));
  const doc: RateDocument = {
    schemaVersion: RATE_DOCUMENT_SCHEMA_VERSION,
    kind: "rate-document",
    runId: input.runId,
    mode: input.mode,
    grid: { horizonMonths, dtYears: dtYearsOf(scenarios, baseCurve), asOf: request.grid.asOf },
    base: curveNodesOf(baseCurve),
    scenarios,
  };
  if (input.mode === "stochastic" && input.stochastic !== undefined) {
    const s = input.stochastic;
    doc.stochastic =
      "model" in s
        ? buildBgmRateFan(s.scenarioId, s.sim, horizonMonths)
        : buildStochasticRateFan(s.scenarioId, s.sim);
  }
  return doc;
}
