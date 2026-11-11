/**
 * EngineTools implementation: the typed tool surface the viewer and the MCP
 * server are both clients of (tools.ts, architecture Section 6).
 *
 * Six methods, side effects stated per the contract. loadPortfolio /
 * defineScenario / bindAssumptions delegate to the sibling modules that own
 * them. run() executes the pipeline and caches the RunResult by runId; that
 * cache is the ONLY thing run() writes beyond returning the result. queryResults
 * and explain read the cache and never recompute — an unknown runId throws
 * rather than inventing an empty result.
 *
 * The provenance context (engine version + kernel reference) is resolved once at
 * construction and reused, so every run on an engine instance stamps the same
 * version fields and the determinism gate holds across repeated runs.
 */
import { readFileSync } from "node:fs";
import type { Context } from "@alm/harness";
import { fileURLToPath } from "node:url";
import type { AssumptionSet } from "../contracts/assumptions";
import type { PortfolioHandle, PortfolioSpec } from "../contracts/position";
import type { KernelProvenanceRef } from "../contracts/provenance";
import type { RunRequest, RunResult } from "../contracts/run";
import type { Scenario } from "../contracts/scenario";
import type { DurationMode } from "../eve";
import type {
  EngineTools,
  Explanation,
  ExplainQuery,
  ResultQuery,
  ResultSlice,
  ScenarioSpec,
} from "../contracts/tools";
import { getPortfolio, loadPortfolio } from "../portfolio/registry";
import { readKernelProvenanceRef } from "../provenance";
import { bindAssumptions, defineScenario } from "../scenario";
import { buildRunResult, type RunPipelineContext } from "./orchestrate";
import { explainResult, sliceResult } from "./read";

/** Run-invariant provenance context an engine stamps into every run. */
export interface EngineContext {
  engineVersion: string;
  kernel: KernelProvenanceRef;
  /**
   * Where per-scenario effective durations are measured. "base-only"
   * (the resolveDefaultContext default, sign-off 2026-07-18) measures them
   * once at the base environment and leaves the shocked scenarios' duration
   * block empty; "per-scenario" measures each scenario's durations at its own
   * shocked environment. A construction-surface option, deliberately not on the
   * frozen RunRequest contract: it is a runtime measurement policy, not part of
   * the request's serialized identity. Build a per-scenario engine with
   * `createEngine({ ...resolveDefaultContext(), durationMode: "per-scenario" })`.
   */
  durationMode?: DurationMode;
  /**
   * Position-shard count for the static-projection pass: a positive
   * integer, "auto" (os.availableParallelism()), or omitted for 1, the default
   * single-thread path. A construction-surface runtime policy like durationMode,
   * not on the frozen RunRequest: shard count never changes the numbers — the
   * chunked fixed-order fold makes every shard count byte-identical — only the
   * wall-clock. Build a sharded engine with
   * `createEngine({ ...resolveDefaultContext(), shards: "auto" })`.
   */
  shards?: number | "auto";
  /**
   * A mounted plugin context. A construction-surface policy like
   * durationMode and shards: it decides which models answer for a seam, and it
   * is deliberately not on the frozen RunRequest. Omit it for the process
   * default. Build a plugged engine with
   * `createEngine({ ...resolveDefaultContext(), harness: mountProfile(profile, catalog) })`.
   */
  harness?: Context;
}

/**
 * Resolve the default context from the on-disk artifacts: the engine version
 * from this package's package.json and the kernel reference from the vendored
 * PROVENANCE.md. Pure given the files; no clock, no randomness.
 */
export function resolveDefaultContext(): EngineContext {
  const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  const kernel = readKernelProvenanceRef(
    fileURLToPath(new URL("../../../kernel/PROVENANCE.md", import.meta.url)),
  );
  return { engineVersion: pkg.version ?? "0.0.0", kernel, durationMode: "base-only" };
}

/** The concrete EngineTools: an in-memory result cache over the run pipeline. */
export class EngineRuntime implements EngineTools {
  private readonly context: RunPipelineContext;
  private readonly cache = new Map<string, RunResult>();

  constructor(context: EngineContext) {
    this.context = context;
  }

  /** Register a portfolio; a repeated id overwrites (registry side effect). */
  loadPortfolio(spec: PortfolioSpec): PortfolioHandle {
    return loadPortfolio(spec);
  }

  /** Build a Scenario from a spec. Pure. */
  defineScenario(spec: ScenarioSpec): Scenario {
    return defineScenario(spec);
  }

  /** Validate an AssumptionSet and fill its contentHash. Pure. */
  bindAssumptions(set: AssumptionSet): AssumptionSet {
    return bindAssumptions(set);
  }

  /** Execute a run and cache it by runId (side effect: the cache write). */
  run(request: RunRequest): RunResult {
    const portfolio = getPortfolio(request.portfolioId);
    const result = buildRunResult(request, portfolio, this.context);
    this.cache.set(request.runId, result);
    return result;
  }

  /** Read a slice of a completed run. Throws on an unknown runId. */
  queryResults(query: ResultQuery): ResultSlice {
    const result = this.cache.get(query.runId);
    if (!result) {
      throw new Error(`queryResults: no completed run cached for runId "${query.runId}"`);
    }
    return sliceResult(result, query);
  }

  /** Narrate a headline movement from the run's attribution. Throws on an unknown runId. */
  explain(query: ExplainQuery): Explanation {
    const result = this.cache.get(query.runId);
    if (!result) {
      throw new Error(`explain: no completed run cached for runId "${query.runId}"`);
    }
    return explainResult(result, query);
  }
}

/** Construct an engine; resolves the default provenance context when none is supplied. */
export function createEngine(context?: EngineContext): EngineRuntime {
  return new EngineRuntime(context ?? resolveDefaultContext());
}
