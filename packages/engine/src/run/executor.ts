/**
 * The walker. It sorts the plan's stages topologically on
 * dependsOn, breaking ties by plan order, and runs them one after another:
 *
 *   1. resolve the executor: component -> plugin id -> stage function;
 *   2. check the edges IN against the shelf;
 *   3. run the stage function;
 *   4. check the edges OUT against what the stage declared;
 *   5. log one `stage` entry.
 *
 * It is the ONLY thing that reads or writes the shelf. A stage function receives
 * artifacts and returns artifacts and never sees the shelf at all, which is what
 * makes each one testable on its own and what keeps the graph the single
 * statement of what feeds what.
 *
 * The type gate's T4 already refused cycles and dangling dependsOn and the
 * tightened T1 already refused an unresolvable or ambiguous edge, so on a
 * COMPILED plan none of the PlanGraphError paths here can fire. They exist
 * because a caller may hand the walker an uncompiled plan, which is exactly what
 * a plan-less run does with its derived default plan.
 */
import type {
  ArtifactScope,
  ContractTypeName,
  PlanStage,
  RunPlan,
} from "../contracts/plan";
import { CONTEXT_SUPPLIED_TYPES } from "../contracts/plan";
import { resolveComponent } from "../plan/componentAliases";
import { producersOf } from "../plan/edges";
import {
  ArtifactMissingError,
  PlanGraphError,
  UndeclaredArtifactError,
} from "./executorErrors";
import { makeShelf, type Shelf } from "./shelf";
import {
  RESULT_TYPES,
  runBalanceStage,
  runBehavioralStage,
  runContractualStage,
  runCustomMetricStage,
  runCurveStage,
  runMetricStage,
  runTermStructureStage,
  runTlpStage,
  STAGE_OUTPUT_SCOPE,
  type ArtifactBag,
  type ScopedBag,
  type StageFn,
  type StageInput,
  type StageResult,
  type StageRunEnv,
} from "./stages";

/** The producer id of an artifact a context file supplies rather than a stage. */
export const CONTEXT_PRODUCER = "<context>";

const RUN_SCOPE: ArtifactScope = { kind: "run" };

export interface ExecuteOptions {
  /**
   * Stages the compile tolerated with no mounted plugin (ruling 13). They are
   * logged as skipped: "not-executable" and put nothing on the shelf.
   */
  unexecutedStageIds?: ReadonlySet<string>;
  /** Run-scope artifacts a context file supplies, put under CONTEXT_PRODUCER. */
  contextArtifacts?: ArtifactBag;
  /**
   * TEST SEAM, keyed by stage id: the stage function to run instead of the one
   * `stageFunctionFor` resolves. It exists so the walker's own unit tests can
   * measure ordering, edge resolution and the log line on a toy catalog without
   * running a single engine function. `executePlan` is engine-internal and
   * nothing outside the package calls it; `buildRunResult` is the public entry
   * point and passes no table, so a production run always resolves its stage
   * functions from the component and the kind.
   */
  stageFunctions?: Readonly<Record<string, StageFn>>;
}

export interface ExecutedPlan {
  shelf: Shelf;
  /** Stage ids in execution order, the tolerated ones included. */
  order: string[];
  /** Per stage: which producer each consumed type resolved to. */
  resolution: ReadonlyMap<string, ReadonlyMap<ContractTypeName, string>>;
  /** Which stage produced each run-scope metric result. */
  metricProducers: ReadonlyMap<ContractTypeName, string>;
  /**
   * Every stage that put a CustomMetricResult on the shelf, in walk
   * order. Custom metrics are a list, not a slot, so they are NOT recorded in
   * `metricProducers`.
   */
  customProducers: readonly string[];
  /** The stage the NII metric's Cashflow edge resolved to: the primary series. */
  primaryCashflowProducer: string;
}

/** Kahn's algorithm with a stable tie-break on plan order. */
export function topologicalOrder(plan: RunPlan): PlanStage[] {
  const byId = new Map(plan.stages.map((s) => [s.id, s]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const s of plan.stages) {
    const deps = s.dependsOn ?? [];
    for (const dep of deps) {
      if (!byId.has(dep)) {
        throw new PlanGraphError(s.id, `dependsOn "${dep}" does not name a stage in this plan`);
      }
      dependents.set(dep, [...(dependents.get(dep) ?? []), s.id]);
    }
    indegree.set(s.id, deps.length);
  }
  const out: PlanStage[] = [];
  const remaining = plan.stages.map((s) => s.id);
  while (out.length < plan.stages.length) {
    // Plan order is the tie-break: the first remaining stage with no unmet
    // dependency runs next, which makes the walk deterministic in the plan file.
    const nextIndex = remaining.findIndex((id) => (indegree.get(id) ?? 0) === 0);
    if (nextIndex < 0) {
      throw new PlanGraphError(remaining[0] ?? null, `the dependency graph has a cycle through [${remaining.join(", ")}]`);
    }
    const id = remaining.splice(nextIndex, 1)[0]!;
    out.push(byId.get(id)!);
    for (const dependent of dependents.get(id) ?? []) {
      indegree.set(dependent, (indegree.get(dependent) ?? 1) - 1);
    }
  }
  return out;
}

/**
 * For each type a stage consumes, the ONE stage in its direct dependsOn that
 * declares the type in produces. Zero, and the type is context-supplied,
 * resolves to CONTEXT_PRODUCER. Zero otherwise, or two or more, refuses: this is
 * the run-time half of the per-edge walk that tightened T1 performs at compile,
 * and both halves ask `producersOf` so they cannot drift.
 */
export function resolveEdges(plan: RunPlan, stage: PlanStage): Map<ContractTypeName, string> {
  const out = new Map<ContractTypeName, string>();
  for (const type of stage.consumes) {
    const producers = producersOf(plan, stage, type);
    if (producers.length === 1) {
      out.set(type, producers[0]!);
      continue;
    }
    if (producers.length === 0) {
      if (CONTEXT_SUPPLIED_TYPES.includes(type)) {
        out.set(type, CONTEXT_PRODUCER);
        continue;
      }
      throw new PlanGraphError(
        stage.id,
        `consumes "${type}" and no stage in its dependsOn [${(stage.dependsOn ?? []).join(", ")}] produces it, ` +
          `and no context file supplies it`,
      );
    }
    throw new PlanGraphError(
      stage.id,
      `consumes "${type}" and two or more stages in its dependsOn produce it ([${producers.join(", ")}]); ` +
        `an edge names one producer, so drop the ones this stage does not read`,
    );
  }
  return out;
}

/** Which stage function executes a stage: the plugin id first, then the kind. */
export function stageFunctionFor(pluginId: string, stage: PlanStage): StageFn {
  if (pluginId === "engine.curve.bootstrap") return runCurveStage;
  if (pluginId === "engine.tlp-overlay") return runTlpStage;
  switch (stage.kind) {
    case "term-structure":
      return runTermStructureStage;
    case "behavioral":
      return runBehavioralStage;
    case "contractual-cashflow":
      return runContractualStage;
    case "balance-new-business":
      return runBalanceStage;
    case "metric":
      // A metric stage producing CustomMetricResult runs the custom
      // arm, which needs the PLUGIN ID and so is closed over here. The four
      // built-in arms are chosen by the type they produce and need no such
      // thing, so every other metric stage keeps returning runMetricStage
      // unchanged.
      return stage.produces.includes("CustomMetricResult")
        ? (env, s, input) => runCustomMetricStage(pluginId, env, s, input)
        : runMetricStage;
    default:
      throw new PlanGraphError(
        stage.id,
        `no stage function executes kind "${stage.kind}" on component "${stage.component}" (plugin "${pluginId}")`,
      );
  }
}

/** The scenario ids and assumption set ids the request's scopes expand over. */
function scopesOf(env: StageRunEnv, kind: "run" | "scenario" | "assumptionSet"): ArtifactScope[] {
  if (kind === "run") return [RUN_SCOPE];
  if (kind === "scenario") return env.request.scenarios.map((s) => ({ kind: "scenario", scenarioId: s.id }));
  // The assumption-set axis, not every set the request carries: a set no
  // scenario references opens no scope, so nothing is produced or read for it.
  return env.assumptionSetIds.map((id) => ({ kind: "assumptionSet", assumptionSetId: id }));
}

/** The id a scoped bag is keyed by: the scenario id, or the assumption set id. */
function scopeId(scope: ArtifactScope): string {
  if (scope.kind === "scenario") return scope.scenarioId;
  if (scope.kind === "assumptionSet") return scope.assumptionSetId;
  return "run";
}

/** The bag a stage kind's output belongs in, given the scope it writes at. */
function outputBagOf(result: StageResult, scope: "run" | "scenario" | "assumptionSet"): ArtifactBag | ScopedBag {
  if (scope === "run") return result.run ?? {};
  return (scope === "scenario" ? result.scenario : result.assumptionSet) ?? {};
}

export function executePlan(plan: RunPlan, env: StageRunEnv, options: ExecuteOptions = {}): ExecutedPlan {
  const shelf = makeShelf();
  const unexecuted = options.unexecutedStageIds ?? new Set<string>();
  // Context-supplied types go on the shelf at run scope before the first stage,
  // so an edge that resolves to the context reads the shelf like any other.
  for (const [type, value] of Object.entries(options.contextArtifacts ?? {})) {
    shelf.put(type as ContractTypeName, RUN_SCOPE, CONTEXT_PRODUCER, value);
  }

  const order: string[] = [];
  const resolution = new Map<string, ReadonlyMap<ContractTypeName, string>>();
  const metricProducers = new Map<ContractTypeName, string>();
  const customProducers: string[] = [];
  let primaryCashflowProducer = "";

  for (const stage of topologicalOrder(plan)) {
    order.push(stage.id);
    const edges = resolveEdges(plan, stage);
    resolution.set(stage.id, edges);
    const consumed = [...edges].map(([type, producerStageId]) => ({
      type,
      scope: scopeOfProducer(plan, producerStageId),
      producerStageId,
    }));

    const pluginId = resolveComponent(stage.component);

    if (unexecuted.has(stage.id)) {
      env.log({
        t: "stage",
        stageId: stage.id,
        pluginId,
        kind: stage.kind,
        consumed,
        produced: [],
        skipped: "not-executable",
      });
      continue;
    }

    // Edges IN. A miss here can only mean an upstream stage function produced
    // less than it declared, which is the bug this check exists to catch.
    // DELIBERATELY EVERY SCOPE of the producer's kind, which is a superset of
    // what any one arm reads: a producer that filled four of five scenarios is a
    // bug wherever the fifth is read, so it is refused here rather than at the
    // arm that happens to reach it first. Do not narrow this to the scopes the
    // consumer touches.
    for (const [type, producerStageId] of edges) {
      const producerKind = scopeOfProducer(plan, producerStageId);
      for (const scope of scopesOf(env, producerKind)) {
        if (!shelf.has(type, scope, producerStageId)) {
          throw new ArtifactMissingError(stage.id, type, scope, "consumer", `producer "${producerStageId}" put nothing there`);
        }
      }
    }

    const fn = options.stageFunctions?.[stage.id] ?? stageFunctionFor(pluginId, stage);
    const result = fn(env, stage, gather(env, plan, shelf, edges));

    // Edges OUT.
    const declared = new Set<ContractTypeName>(stage.produces);
    const returned = returnedTypes(result);
    for (const type of returned) {
      if (!declared.has(type)) throw new UndeclaredArtifactError(stage.id, type);
    }
    const outputScope = STAGE_OUTPUT_SCOPE[stage.kind];
    // The declaration is satisfied by the bag the stage's OWN scope names, not
    // by the union of the three: a stage kind writes at exactly one scope, so a
    // type returned in the wrong bag is a stage that did not produce what it
    // declared, and nothing downstream would find it on the shelf.
    const outputBag = outputBagOf(result, outputScope);
    const produced: Array<{ type: string; scope: string }> = [];
    for (const type of stage.produces) {
      if (!(type in outputBag)) {
        throw new ArtifactMissingError(
          stage.id,
          type,
          scopesOf(env, outputScope)[0] ?? RUN_SCOPE,
          "producer",
          returned.has(type)
            ? `it returned "${type}" at another scope; a "${stage.kind}" stage writes at ${outputScope} scope`
            : undefined,
        );
      }
      produced.push({ type, scope: outputScope });
      if (outputScope === "run") {
        const value = (outputBag as ArtifactBag)[type];
        // A declared key whose value is undefined is how an optional metric
        // states its own absence: the declaration is satisfied, the shelf slot
        // is not filled, and the refusal that caused it is already logged.
        if (value !== undefined) shelf.put(type, RUN_SCOPE, stage.id, value);
      } else {
        const map = (outputBag as ScopedBag)[type];
        for (const scope of scopesOf(env, outputScope)) {
          const key = scopeId(scope);
          if (map === undefined || !map.has(key)) {
            throw new ArtifactMissingError(stage.id, type, scope, "producer");
          }
          shelf.put(type, scope, stage.id, map.get(key));
        }
      }
      if (type === "CustomMetricResult") customProducers.push(stage.id);
      else if (RESULT_TYPES.includes(type)) metricProducers.set(type, stage.id);
    }
    if (stage.produces.includes("NiiResult")) {
      primaryCashflowProducer = edges.get("Cashflow") ?? primaryCashflowProducer;
    }

    // A behavioral stage that licenses no binding did the identity pass. It is
    // logged as skipped so a reader sees it ran and changed nothing.
    const mine =
      stage.kind === "behavioral" ? env.licensedBindings.filter((l) => l.stageId === stage.id) : [];
    const unbound = stage.kind === "behavioral" && mine.length === 0;
    env.log({
      t: "stage",
      stageId: stage.id,
      pluginId,
      kind: stage.kind,
      consumed,
      produced,
      ...(unbound ? { skipped: "no-binding" as const } : {}),
      ...(mine.length > 0
        ? {
            bindings: mine.map((l) => ({
              assumptionSetId: l.assumptionSetId,
              bindingIndex: l.bindingIndex,
              positionsMatched: env.positionsMatched.get(`${l.assumptionSetId}:${l.bindingIndex}`) ?? 0,
            })),
          }
        : {}),
    });
  }

  return { shelf, order, resolution, metricProducers, customProducers, primaryCashflowProducer };
}

/** The scope kind a producer writes at: the context writes at run scope. */
function scopeOfProducer(plan: RunPlan, producerStageId: string): "run" | "scenario" | "assumptionSet" {
  if (producerStageId === CONTEXT_PRODUCER) return "run";
  const stage = plan.stages.find((s) => s.id === producerStageId);
  if (stage === undefined) throw new PlanGraphError(producerStageId, "resolved to a stage the plan does not carry");
  return STAGE_OUTPUT_SCOPE[stage.kind];
}

/** Read every resolved edge off the shelf and bucket it by the producer's scope. */
function gather(
  env: StageRunEnv,
  plan: RunPlan,
  shelf: Shelf,
  edges: ReadonlyMap<ContractTypeName, string>,
): StageInput {
  const run: ArtifactBag = {};
  const scenario: ScopedBag = {};
  const assumptionSet: ScopedBag = {};
  for (const [type, producerStageId] of edges) {
    const kind = scopeOfProducer(plan, producerStageId);
    if (kind === "run") {
      run[type] = shelf.get(type, RUN_SCOPE, producerStageId);
      continue;
    }
    const map = new Map<string, unknown>();
    for (const scope of scopesOf(env, kind)) {
      map.set(scopeId(scope), shelf.get(type, scope, producerStageId));
    }
    if (kind === "scenario") scenario[type] = map;
    else assumptionSet[type] = map;
  }
  return { run, scenario, assumptionSet };
}

/** Every contract type a stage result carries a key for, at any scope. */
function returnedTypes(result: StageResult): Set<ContractTypeName> {
  const out = new Set<ContractTypeName>();
  for (const bag of [result.run, result.scenario, result.assumptionSet]) {
    for (const key of Object.keys(bag ?? {})) out.add(key as ContractTypeName);
  }
  return out;
}
