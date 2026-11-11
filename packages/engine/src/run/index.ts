/**
 * @alm/engine run-orchestrator module.
 *
 * The run() pipeline and the EngineTools implementation: wires the portfolio,
 * scenario, projection, NII, EVE, gap, attribution, and provenance modules into
 * one RunResult, caches it by runId, and serves queryResults and explain off the
 * cache. Byte-for-byte deterministic given a request and its seed.
 */
export {
  createEngine,
  EngineRuntime,
  resolveDefaultContext,
  type EngineContext,
} from "./engine";
export {
  buildRunResult,
  DuplicateAssumptionSetError,
  RUN_RESULT_SCHEMA_VERSION,
  type RunPipelineContext,
} from "./orchestrate";
export { buildRunAttribution, type RunAttribution } from "./attribution";
export { sliceResult, explainResult } from "./read";
export type { EngineTools } from "../contracts/tools";
// Harness Plane 4: the stage-graph walker, the shelf it owns, and the
// typed refusals. `executePlan` is engine-internal; buildRunResult is the entry
// point a caller outside the package uses.
export {
  CONTEXT_PRODUCER,
  executePlan,
  resolveEdges,
  stageFunctionFor,
  topologicalOrder,
  type ExecuteOptions,
  type ExecutedPlan,
} from "./executor";
export { artifactKey, makeShelf, type Shelf, type ShelfEntry } from "./shelf";
export {
  ArtifactConflictError,
  ArtifactMissingError,
  CustomMetricShapeError,
  ExecutorError,
  PlanGraphError,
  RequiredMetricMissingError,
  UndeclaredArtifactError,
  UnlicensedBindingError,
} from "./executorErrors";
export { defaultPlanFor } from "./defaultPlan";
