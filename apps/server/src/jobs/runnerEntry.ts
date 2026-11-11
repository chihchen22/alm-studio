/**
 * The child-process run body. One run per process:
 *
 *   1. read runs/<id>/request.json;
 *   2. load portfolios/<id>.json and verify the store content hash against the
 *      pin recorded at submission (pin-vs-artifact; refuse loudly on mismatch);
 *   3. inject wall-clock timestamps (the demo entry-point pattern — the only
 *      clock reads, outside the deterministic core);
 *   3b. verify the persisted profile against the hash the submission pinned,
 *      then mount it over this box's catalog (built-ins plus the operator
 *      plugin list), and dispose it in a finally: the gates ran on that tree,
 *      so the numbers must too;
 *   4. call buildRunResult(request, portfolio, context), passing the persisted
 *      plan document so the child walks the graph the gates checked rather than
 *      the default plan derived from the request;
 *   5. merge any compile-time plan tags into the result's notImplemented list;
 *   6. write result.json atomically; print the "done" phase; exit 0.
 *   6b. when the submission opted in to instrumentResults, write instruments.json
 *      after result.json and rates.json and before "done" (jobs/instrumentsPass.ts);
 *      a failure there is a run-log line, never a failed run.
 *
 * Progress honesty: until the engine seam lands there is no
 * in-pipeline phase callback, so the only phases this child reports are the
 * ones it actually knows: "compute" when it hands off to the engine and "done"
 * when the result is on disk. Nothing interpolates a percent bar.
 *
 * All stdout is the JSON-lines protocol the parent tees into log.ndjson.
 * Any failure prints a typed {t:"error"} line and exits nonzero; the parent
 * marks the run "error" with that message. Nothing fakes a number.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Deep import per the design's barrel note (Section 3.3): buildRunResult joins
// the @alm/engine barrel with the seam; until then this is the same
// deep-import pattern @alm/ai already uses.
import { buildRunResult, resolveDefaultContext } from "@alm/engine/src/run";
import { runStochastic, type StochasticRunOptions } from "@alm/engine/src/run/stochastic";
import type { SavedCalibrationUse } from "@alm/engine/src/calibration/savedCalibration";
import {
  buildRateDocument,
  mergePlanTags,
  BgmTenorError,
  type BgmEnvironment,
  type RateDocumentInput,
  type StochasticEnvironment,
} from "@alm/engine";
import type {
  BgmModelOverride,
  InstrumentEnvironment,
  PortfolioSpec,
  RunRequest,
  StochasticModel,
  StochasticGapOption,
  StochasticModelOverride,
} from "@alm/engine";
import { mountProfile, profileHash, type Context } from "@alm/harness";
import { loadOperatorPlugins, pluginConfigPath } from "../plugins/load";
import { sha256Hex, writeFileAtomic } from "../store/store";
import { landInstrumentsFile } from "./instrumentsPass";
import { pipelineOptionsOf } from "./pipelineOptions";
import type { RunEvent, StoredRunRequest } from "./types";

/**
 * The stored request.json shape including the run mode. Mirrors the
 * StoredRunRequestV2 intersection in http/routes/runs.ts (the canonical home
 * is jobs/types.ts, unowned this wave — see the report NOTE); a
 * request.json written before the field existed reads back deterministic.
 */
type StoredRunRequestV2 = StoredRunRequest & {
  mode?: "deterministic" | "stochastic";
  stochastic?: {
    nPaths?: number;
    model?: StochasticModel;
    modelParams?: StochasticModelOverride | BgmModelOverride;
    /** The gap option, verbatim; the route ran the engine's refusals before it was stored. */
    gap?: StochasticGapOption;
    /** The saved fit the run uses, verbatim (the route checked its model, snapshot and curve). */
    calibrationId?: string;
    savedCalibration?: SavedCalibrationUse;
  };
};

/**
 * The failure line of a stochastic compute throw. A BGM path read at a tenor the
 * simulation did not save (BgmTenorError) is put in plain words: every input the
 * route admits reads saved tenors only (swap indices carry 1 to 30 whole years,
 * dynamic new business is refused for both models), so this is a defence line,
 * never a 500 and never a number.
 */
function stochasticFailure(err: unknown): string {
  if (err instanceof BgmTenorError) {
    return (
      `runnerEntry stochastic: BgmTenorError: the BGM run read a term forward at ${err.tenorYears} years, ` +
      "a tenor its simulation does not save (it saves 1 day, 1 month and 1, 2, 3, 5, 7, 10, 20 and 30 years), " +
      "and the BGM path never builds a term forward by averaging spot rates, so the run stopped with no " +
      "result. Run Hull-White on this book, or change the input that reads that tenor."
    );
  }
  return err instanceof Error
    ? `runnerEntry stochastic: ${err.name}: ${err.message}`
    : `runnerEntry stochastic: ${String(err)}`;
}

function emit(event: RunEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function fail(message: string, detail?: string): never {
  emit({ t: "error", message, detail });
  process.exit(1);
}

/**
 * The rate document lands AFTER result.json and BEFORE the done phase.
 * A builder throw goes through fail() like any compute error, so a run never
 * carries a half document; an errored run may hold a complete result.json and
 * no rates.json; the rates route's state gate answers such a run with the
 * ordinary 409, and the 404 is reserved for done runs that predate the document.
 */
function landRateDocument(runDir: string, request: RunRequest, input: RateDocumentInput): void {
  let doc;
  try {
    doc = buildRateDocument(request, input);
  } catch (err) {
    fail(
      err instanceof Error
        ? `runnerEntry rate document: ${err.name}: ${err.message}`
        : `runnerEntry rate document: ${String(err)}`,
    );
  }
  writeFileAtomic(join(runDir, "rates.json"), `${JSON.stringify(doc)}\n`);
}

function main(): void {
  const runDir = process.argv[2];
  if (!runDir) fail("runnerEntry: missing run directory argument");

  let stored: StoredRunRequestV2;
  try {
    stored = JSON.parse(readFileSync(join(runDir, "request.json"), "utf8")) as StoredRunRequestV2;
  } catch (err) {
    fail("runnerEntry: cannot read request.json", err instanceof Error ? err.message : String(err));
  }
  const mode = stored.mode ?? "deterministic";
  if (mode !== "deterministic" && mode !== "stochastic") {
    fail(
      `runnerEntry: stored request carries unknown mode "${String(mode)}"; ` +
        `this child computes only "deterministic" and "stochastic" runs and refuses ` +
        `rather than guessing`,
    );
  }

  // Pin-vs-artifact: the portfolio bytes on disk must hash to the reference
  // recorded at submission. A mismatch means the book changed after the pin was
  // taken (or the store is corrupt); computing against it would silently answer
  // a different question, so refuse.
  const portfolioPath = join(runDir, "..", "..", "portfolios", `${stored.portfolioRef.id}.json`);
  let portfolioBytes: Buffer;
  try {
    portfolioBytes = readFileSync(portfolioPath);
  } catch (err) {
    fail(
      `runnerEntry: cannot read pinned portfolio "${stored.portfolioRef.id}"`,
      err instanceof Error ? err.message : String(err),
    );
  }
  const actualHash = sha256Hex(portfolioBytes);
  if (actualHash !== stored.portfolioRef.contentHash) {
    fail(
      `runnerEntry: portfolio "${stored.portfolioRef.id}" content hash mismatch — ` +
        `pinned ${stored.portfolioRef.contentHash}, artifact on disk hashes ${actualHash}; refusing to run`,
    );
  }
  const portfolio = JSON.parse(portfolioBytes.toString("utf8")) as PortfolioSpec;

  // Inject the wall clock at the boundary (the data/src/demo/demo.ts pattern):
  // startedAt now; finishedAt patched onto the emitted provenance after compute.
  const startedAt = new Date().toISOString();
  const request = {
    ...stored.request,
    timestamps: { startedAt, finishedAt: startedAt },
  };

  // The plugin tree this run computes through (harness Plane 4). The
  // submitting process compiled the plan against the composed profile and
  // persisted the ROWS, not just the hash, because compute happens here: the
  // child mounts the same profile over the same catalog (built-ins plus this
  // box's operator plugin list) so the tree that produces the numbers is the
  // tree the gates ran on. A stored request written before the field existed
  // carries no profile and runs on the process default, exactly as it did.
  let harness: Context | undefined;
  if (stored.profile !== undefined) {
    // Pin-vs-artifact for the profile, the same rule the portfolio gets above:
    // the rows on disk must hash to the hash the submission recorded and
    // stamped into the result's provenance. A mismatch means the rows were
    // edited after the gates ran, so the run would compute on one tree and
    // claim another. Refuse rather than answer a different question.
    if (stored.profileHash !== undefined) {
      const actualProfileHash = profileHash(stored.profile);
      if (actualProfileHash !== stored.profileHash) {
        fail(
          `runnerEntry: profile hash mismatch; stored request pins ${stored.profileHash}, ` +
            `the profile rows on disk hash ${actualProfileHash}; refusing to run`,
        );
      }
    }
    try {
      const operator = loadOperatorPlugins(pluginConfigPath(process.cwd()));
      harness = mountProfile(stored.profile, operator.catalog);
    } catch (err) {
      fail(
        "runnerEntry: cannot mount the profile this run was compiled against",
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      );
    }
  }
  try {
    compute(runDir, mode, stored, request, portfolio, harness);
  } finally {
    // One tree per child, unwound whether the run succeeded or threw: the
    // process is about to exit either way, but a dispose that never runs would
    // hide a plugin's teardown refusal.
    harness?.dispose();
  }
}

/** The run body proper, once the portfolio is pinned and the tree is mounted. */
function compute(
  runDir: string,
  mode: "deterministic" | "stochastic",
  stored: StoredRunRequestV2,
  request: RunRequest,
  portfolio: PortfolioSpec,
  harness: Context | undefined,
): void {
  // --- Stochastic arm ----------------------------------------------
  // The Hull-White Monte Carlo entry point emits the SEPARATE
  // StochasticRunResult envelope; it lands as this run's result
  // document, self-identified by kind: "stochastic-distribution", and the
  // routes serve it only through /api/runs/:id/stochastic. The path count
  // comes verbatim from the stored request — never adjusted here. Engine
  // refusals (cap vols, path count, seed, dynamic base) are pre-validated at
  // submission; any residual throw surfaces as a typed error line, and the
  // run lands in state "error" — nothing fakes a number.
  if (mode === "stochastic") {
    emit({ t: "phase", phase: "compute" });
    const spec = stored.stochastic;
    let captured: RateDocumentInput["stochastic"];
    const options: StochasticRunOptions = {
      ...(spec?.nPaths !== undefined ? { nPaths: spec.nPaths } : {}),
      // The stored model, verbatim; absent is Hull-White.
      ...(spec?.model !== undefined ? { model: spec.model } : {}),
      ...(spec?.modelParams !== undefined ? { modelParams: spec.modelParams } : {}),
      // The gap option, verbatim; absent is no gap and the envelope of before the slice.
      ...(spec?.gap !== undefined ? { gap: spec.gap } : {}),
      // The saved fit, verbatim; absent is the run-time fit (or the override) and the envelope of before.
      ...(spec?.savedCalibration !== undefined ? { savedCalibration: spec.savedCalibration } : {}),
      // The stochastic arm reaches only the behavioral seam, so it takes the
      // registry off the mounted tree rather than the whole context.
      ...(harness !== undefined ? { behavioral: harness.get("behavioral") } : {}),
      // Keep the simulation the envelope came from, for the rate document.
      onEnvironment: (env: StochasticEnvironment, baseScenario) => {
        captured = { scenarioId: baseScenario.id, sim: env.sim };
      },
      // The BGM twin: the 360-month BGM simulation, for the BGM fan (rate document 1.2.0).
      onBgmEnvironment: (env: BgmEnvironment, baseScenario) => {
        captured = { scenarioId: baseScenario.id, model: "bgm-lmm-2f", sim: env.sim };
      },
    };
    let envelope;
    try {
      envelope = runStochastic(request, portfolio, options);
    } catch (err) {
      fail(stochasticFailure(err));
    }
    writeFileAtomic(join(runDir, "result.json"), `${JSON.stringify(envelope)}\n`);
    landRateDocument(runDir, request, { runId: request.runId, mode: "stochastic", stochastic: captured });
    emit({ t: "phase", phase: "done" });
    return;
  }

  const context = {
    ...resolveDefaultContext(),
    // Every engine option the submission stored, each present only when it was asked for (pipelineOptions.ts).
    ...pipelineOptionsOf(stored.engineContext),
    ...(harness !== undefined ? { harness } : {}),
    ...(stored.planRunLog !== undefined ? { planRunLog: stored.planRunLog } : {}),
    ...(stored.profileHash !== undefined ? { profileHash: stored.profileHash } : {}),
    ...(stored.planDocument !== undefined ? { plan: stored.planDocument } : {}),
  };

  // W2-P5 seam (design 3.4 / W1-P1 NOTE): when the engine's
  // RunPipelineContext supports the optional onProgress callback, its phases
  // ("resolve" | "project" | "report" | "done") are emitted verbatim. An engine
  // predating the seam ignores the extra property; either way nothing here
  // interpolates progress, and the byte-parity smoke proves the callback
  // changes no number.
  (context as Record<string, unknown>).onProgress = (phase: string): void => {
    emit({ t: "phase", phase });
  };

  // Spec E6: a run that asked for per-position results keeps the engine's
  // environment (effective books, rate paths, curve legs) for the pass that
  // follows result.json. Observational: it moves no number of the run.
  const wantsInstruments = stored.instrumentResults?.save === true;
  let instrumentEnvironment: InstrumentEnvironment | undefined;
  let instrumentEnvironmentError: Error | undefined;
  if (wantsInstruments) {
    (context as Record<string, unknown>).onInstrumentEnvironment = (e: InstrumentEnvironment | Error): void => {
      if (e instanceof Error) instrumentEnvironmentError = e;
      else instrumentEnvironment = e;
    };
  }

  emit({ t: "phase", phase: "compute" });
  // A throw here is a run failure, not a crash: name and message go out through
  // fail() as the one typed error line (the same path the stochastic arm uses),
  // so the queue records it and no Node stack or absolute path reaches stderr.
  let result: ReturnType<typeof buildRunResult>;
  try {
    result = buildRunResult(request, portfolio, context);
  } catch (err) {
    fail(
      err instanceof Error
        ? `runnerEntry: ${err.name}: ${err.message}`
        : `runnerEntry: ${String(err)}`,
    );
  }
  result.provenance.timestamps.finishedAt = new Date().toISOString();

  // Plan tags (harness Plane 4): what the compiler learned about stages the
  // pipeline does not execute reaches the envelope here, deduped by layer. The
  // merge adds tags only; it touches no number the pipeline computed.
  if (stored.planTags !== undefined && stored.planTags.length > 0) {
    result = mergePlanTags(result, stored.planTags);
  }

  // Atomic landing: temp + rename (one EBUSY/EPERM retry inside), so the parent
  // and any reader see a complete result.json or none at all.
  writeFileAtomic(join(runDir, "result.json"), `${JSON.stringify(result)}\n`);
  landRateDocument(runDir, request, { runId: request.runId, mode: "deterministic" });
  // The per-position pass runs LAST, after the envelope is on disk, and never
  // fails the run: a failure is a run-log line and the run still reports done.
  if (wantsInstruments) {
    landInstrumentsFile({
      runDir,
      request,
      result,
      environment: instrumentEnvironment,
      ...(instrumentEnvironmentError !== undefined ? { environmentError: instrumentEnvironmentError } : {}),
      settings: stored.instrumentResults?.coaNodeIds !== undefined ? { coaNodeIds: stored.instrumentResults.coaNodeIds } : {},
      emit,
    });
  }
  emit({ t: "phase", phase: "done" });
}

main();
