/**
 * The typed tool surface: the engine's primary interface, and the one both the
 * React viewer and the MCP server are clients of. A small
 * set of typed, documented, side-effect-explicit functions an LLM can call.
 *
 * The division of labor is baked in here: the compiler authors typed objects
 * (AssumptionSet, Scenario), the engine computes numbers (run), and explain
 * narrates a decomposition the engine already computed. The language model
 * never computes a balance-sheet number.
 */
import type { ProductFamilyDef } from "./chartOfAccounts";
import type { AssumptionDiff, AssumptionSet } from "./assumptions";
import type { AssumptionSetId, ScenarioId } from "./ids";
import type { PortfolioHandle, PortfolioSpec } from "./position";
import type { DriverContribution, HeadlineAttribution } from "./results";
import type { NewBusinessStrategy, RateSpec, Scenario } from "./scenario";
import type { RunRequest, RunResult } from "./run";

/** Input to defineScenario. */
export interface ScenarioSpec {
  id: ScenarioId;
  label: string;
  rateSpec: RateSpec;
  assumptionSetId: AssumptionSetId;
  newBusiness: NewBusinessStrategy;
}

/** A read query against a completed run. Never triggers a recomputation. */
export interface ResultQuery {
  runId: string;
  metric: "nii" | "eve" | "repricing-gap" | "liquidity-gap" | "cashflows";
  scenarioId?: ScenarioId;
  familyId?: string;
}

/** A JSON slice of results, always a subset of an already-computed RunResult. */
export interface ResultSlice {
  runId: string;
  metric: ResultQuery["metric"];
  /** The requested slice; the caller narrows by the metric it asked for. */
  data: unknown;
}

/** A question posed to the explain layer. */
export interface ExplainQuery {
  runId: string;
  metric: "nii-12m" | "nii-24m" | "eve";
  scenarioId: ScenarioId;
}

/**
 * The explain layer's answer, assembled ONLY from the attribution decomposition
 * the engine computed. If the attribution cannot support the question,
 * `supported` is false and `answer` says so. The language model narrates
 * `citations`; it does not compute them.
 */
export interface Explanation {
  supported: boolean;
  answer: string;
  attribution: HeadlineAttribution | null;
  citations: DriverContribution[];
}

/** The typed tool surface. */
export interface EngineTools {
  /**
   * Register a portfolio in the in-memory store and return a handle.
   * SIDE EFFECT: writes the store, keyed by PortfolioSpec.id; a repeated id
   * overwrites the prior portfolio.
   */
  loadPortfolio(spec: PortfolioSpec): PortfolioHandle;

  /** Build a Scenario from a spec. Pure; no side effect. */
  defineScenario(spec: ScenarioSpec): Scenario;

  /**
   * Validate and normalize an AssumptionSet, filling contentHash. Pure; no side
   * effect. The set is DATA; this call runs no behavioral model.
   */
  bindAssumptions(set: AssumptionSet): AssumptionSet;

  /**
   * Execute a run. Deterministic: same request plus seed produce byte-identical
   * results. SIDE EFFECT: caches the RunResult by runId so queryResults and
   * explain can read it without recomputing.
   */
  run(request: RunRequest): RunResult;

  /**
   * Read a slice of an already-computed run. Pure; reads the cache and never
   * recomputes. Throws if the runId is unknown.
   */
  queryResults(query: ResultQuery): ResultSlice;

  /**
   * Narrate a headline movement from the run's attribution output. Pure; reads
   * the cache. Answers ONLY from attribution (see Explanation).
   */
  explain(query: ExplainQuery): Explanation;
}

/**
 * Natural-language to assumption-set compiler. Lives in packages/ai. The LLM
 * authors a typed AssumptionSet plus a diff versus the base; it never computes
 * a balance-sheet number. The compiled object is shown before it is run.
 */
export interface AssumptionCompiler {
  compile(input: CompileAssumptionsInput): CompiledAssumptionSet;
}

export interface CompileAssumptionsInput {
  /** The natural-language instruction, e.g. "MMA betas 15 points higher". */
  instruction: string;
  /** The assumption set to modify. */
  base: AssumptionSet;
  /** Family catalogue, so the compiler can target the right bindings by name. */
  families: ProductFamilyDef[];
}

export interface CompiledAssumptionSet {
  assumptionSet: AssumptionSet;
  diff: AssumptionDiff;
  /** Plain-language account of what changed and why, for the show-before-run step. */
  rationale: string;
}
