/**
 * The type gate (harness Plane 4): does the plan COMPOSE. Pure; returns a
 * report, never throws on a rule failure. Rule text lives in
 * docs/harness/example-plan.json validationRules.typeGate.
 */
import { CONTEXT_SUPPLIED_TYPES, type GateFailure, type GateReport, type PlanStage, type RunPlan } from "../contracts/plan";
import { resolveComponent } from "./componentAliases";
import { producersOf } from "./edges";

/**
 * The longest horizon any surface of this engine projects, in months. Exported
 * because the single-instrument drill bounds its own schedule at the same
 * number: one cap, stated once, so a plan and a drill cannot disagree on what
 * is too long.
 */
export const MAX_HORIZON = 360;

/**
 * The one day-count convention the kernel's bootstrap executes. T2 is
 * declared-equals-executed: a plan may name this and nothing else.
 */
const EXECUTED_DAY_COUNT = "ACT/360";

function fail(rule: GateFailure["rule"], stageId: string | null, detail: string): GateFailure {
  return { gate: "type", rule, stageId, detail };
}

/** Transitive upstream set per stage, or null when the graph has a cycle. */
function upstreamClosure(stages: PlanStage[]): Map<string, Set<string>> | null {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const memo = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const walk = (id: string): Set<string> | null => {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return null;
    visiting.add(id);
    const out = new Set<string>();
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      out.add(dep);
      const up = walk(dep);
      if (up === null) return null;
      for (const u of up) out.add(u);
    }
    visiting.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const s of stages) if (walk(s.id) === null) return null;
  return memo;
}

/**
 * What the mounted profile can execute: the components its plugins declare and
 * the contract types they produce. Built by the compiler from the mounted
 * context (registryProducers), never written by hand.
 */
export interface StageProducers {
  components: ReadonlySet<string>;
  producedTypes: ReadonlySet<string>;
  /**
   * What each executable component's plugin declares (T6). Keyed by
   * every name the component may be written as, alias included, so a stage is
   * compared against its own executor rather than against a list beside it.
   */
  declaresByComponent: ReadonlyMap<string, { produces: readonly string[]; consumes: readonly string[] }>;
}

/** One thing the mounted profile cannot supply for a stage. */
export interface ExecutabilityGap {
  stageId: string;
  missing: { kind: "component"; component: string } | { kind: "type"; type: string };
}

/**
 * What a plan asks of the profile that the profile cannot give.
 *
 * A consumed type with no producer anywhere is a refusal: the stage would read a
 * value nothing computes. An unexecuted COMPONENT is a refusal only when the
 * stage is the sole producer of a type another stage consumes, which is ruling
 * 13: a declared stage nothing executes may ride along as a tagged gap as long
 * as no number depends on it, and must stop the run as soon as one does.
 */
export function stageExecutability(plan: RunPlan, producers: StageProducers): {
  refusals: ExecutabilityGap[];
  tolerated: Array<{ stageId: string; component: string }>;
} {
  const refusals: ExecutabilityGap[] = [];
  const tolerated: Array<{ stageId: string; component: string }> = [];
  const contextTypes: readonly string[] = CONTEXT_SUPPLIED_TYPES;
  const supplied = (t: string): boolean => producers.producedTypes.has(t) || contextTypes.includes(t);
  // A cover has to be executable. Counting ANY other stage that DECLARES the
  // type would let two stages neither of which the profile mounts excuse each
  // other, and the plan would compile with nothing computing the value. The
  // component set is alias-resolved by the compiler, so the same membership
  // test that decides executability decides whether a stage can cover.
  const producedBy = (t: string, exceptStageId: string): boolean =>
    plan.stages.some(
      (s) =>
        s.id !== exceptStageId &&
        producers.components.has(s.component) &&
        (s.produces as readonly string[]).includes(t),
    );
  const consumedByAnother = (t: string, exceptStageId: string): boolean =>
    plan.stages.some((s) => s.id !== exceptStageId && (s.consumes as readonly string[]).includes(t));

  // Components first, then consumed types, because the compiler raises the
  // FIRST refusal and the better explanation is the stage nothing executes: a
  // consumer reading a type only that stage declares is the same defect seen
  // from the far end. Within each pass the order is plan order.
  for (const s of plan.stages) {
    if (producers.components.has(s.component)) continue;
    // Sole producer of something the plan reads: nothing else would compute it.
    const load = s.produces.find(
      (t) => consumedByAnother(t, s.id) && !producedBy(t, s.id) && !supplied(t),
    );
    if (load !== undefined) refusals.push({ stageId: s.id, missing: { kind: "component", component: s.component } });
    else tolerated.push({ stageId: s.id, component: s.component });
  }
  for (const s of plan.stages) {
    for (const t of s.consumes) {
      if (supplied(t) || producedBy(t, s.id)) continue;
      refusals.push({ stageId: s.id, missing: { kind: "type", type: t } });
    }
  }
  return { refusals, tolerated };
}

export function typeGate(plan: RunPlan, portfolioAsOf: string, producers: StageProducers): GateReport {
  const failures: GateFailure[] = [];
  const checked: string[] = [];
  const byId = new Map(plan.stages.map((s) => [s.id, s]));

  // T4 first: every rule after it needs a resolvable, acyclic graph.
  for (const s of plan.stages) {
    for (const dep of s.dependsOn ?? []) {
      if (!byId.has(dep)) failures.push(fail("T4", s.id, `dependsOn "${dep}" does not name a stage`));
    }
  }
  const closure = upstreamClosure(plan.stages);
  if (closure === null) failures.push(fail("T4", null, "the dependency graph has a cycle"));
  checked.push(`T4 ${plan.stages.length} stages, dependsOn resolved, acyclic=${closure !== null}`);

  // T1: every consumed type is produced by exactly ONE stage in the consumer's
  // DIRECT dependsOn, or is supplied by a context file with no such producer.
  // Transitive reachability is not enough after piece 1c: dependsOn is the
  // wiring the executor walks, not a hint, and an edge names one producer. The
  // producer lookup is producersOf, the same function the walker's resolveEdges
  // calls (Ruling P7a), so the compile half and the run half cannot drift.
  // T1 no longer needs the closure: it looks one hop, so a cyclic graph is T4's
  // to report and this rule still answers.
  for (const s of plan.stages) {
    for (const t of s.consumes) {
      const edgeProducers = producersOf(plan, s, t);
      if (edgeProducers.length === 1) continue;
      if (edgeProducers.length === 0) {
        if (CONTEXT_SUPPLIED_TYPES.includes(t)) continue;
        failures.push(fail("T1", s.id, `consumes "${t}" but no stage in its dependsOn [${(s.dependsOn ?? []).join(", ")}] produces it and no context file supplies it`));
        continue;
      }
      failures.push(fail("T1", s.id, `consumes "${t}" and two or more stages in its dependsOn produce it ([${edgeProducers.join(", ")}]); an edge names one producer, so drop the ones this stage does not read`));
    }
  }
  checked.push(`T1 every consumed type resolved to exactly one producer in the stage's own dependsOn, or to the context supply [${CONTEXT_SUPPLIED_TYPES.join(", ")}]`);

  // T1b: executability against the mounted profile. A consumed type nothing
  // produces is always a failure; a stage whose component nothing executes is a
  // failure only when the plan depends on its output (ruling 13), and otherwise
  // a tolerated stage the compiler tags. The producer set is the mounted
  // plugins' declares, never a hand-kept list.
  const executability = stageExecutability(plan, producers);
  for (const gap of executability.refusals) {
    failures.push(fail("T1", gap.stageId, gap.missing.kind === "component"
      ? `component "${gap.missing.component}" is not mounted by the profile and this stage is the only producer of a type the plan consumes; no plugin declares it`
      : `consumes "${gap.missing.type}", which no mounted plugin produces and no context file supplies`));
  }
  checked.push(`T1 component and produced-type set read from ${producers.components.size} mounted components`);
  if (executability.tolerated.length > 0) {
    checked.push(`T1 stages no mounted plugin executes, tolerated because no other stage reads a type only they produce: ${
      executability.tolerated.map((t) => `${t.stageId} (${t.component})`).join(", ")}`);
  }

  // T2: the declared day count must be the one the engine executes. The kernel
  // bootstraps ACT/360 and reads no other convention, so accepting a different
  // string here would let a plan declare a basis nothing honors. The full
  // per-edge unit walk arrives with the dimension bag.
  for (const s of plan.stages) {
    if (s.kind !== "curve" || !s.consumes.includes("MarketSnapshot")) continue;
    const declared = s.params?.dayCount;
    if (typeof declared !== "string") {
      failures.push(fail("T2", s.id, "a curve stage consuming MarketSnapshot must declare params.dayCount"));
      continue;
    }
    if (declared !== EXECUTED_DAY_COUNT) {
      failures.push(fail(
        "T2",
        s.id,
        `declares params.dayCount "${declared}" but the engine executes "${EXECUTED_DAY_COUNT}"; ` +
          `T2 is declared-equals-executed, so a plan may not state a basis nothing honors`,
      ));
    }
  }
  checked.push(`T2 day count declared and equal to the executed convention ${EXECUTED_DAY_COUNT} on every curve stage`);

  // T6: declared equals mounted. A stage may not claim to produce a type its
  // executor does not declare, nor to consume one its executor never reads. A
  // METRIC stage is held to EQUALITY on its consumes (Ruling P16): its executor
  // reads every input the plugin declares, so a metric that omits one would
  // leave that edge unresolved at run time, and the guarantee this rule exists
  // to give is that the omission is named at COMPILE, with the stage, the
  // plugin and the type. A stage whose component NO MOUNTED PLUGIN declares is
  // skipped, because there is no declares row to compare against; that is the
  // predicate, not "the compile tolerated it". Such a stage is not waved
  // through: when it is load-bearing the SAME report refuses it under T1b, the
  // sole-producer arm of stageExecutability, and when nothing reads what only
  // it produces, ruling 13 tags it instead.
  for (const s of plan.stages) {
    const declares = producers.declaresByComponent.get(s.component);
    if (declares === undefined) continue;
    // The message names the PLUGIN, not the alias the plan happened to write:
    // "alm-eve" is the author's word for it and "engine.metric.eve" is the row
    // whose declares this rule compared against.
    const executor = resolveComponent(s.component);
    for (const t of s.produces) {
      if (declares.produces.includes(t)) continue;
      failures.push(fail("T6", s.id, `declares it produces "${t}", which its executor "${executor}" does not declare; the executor declares [${declares.produces.join(", ")}]`));
    }
    for (const t of s.consumes) {
      if (declares.consumes.includes(t) || (s.kind !== "metric" && CONTEXT_SUPPLIED_TYPES.includes(t))) continue;
      failures.push(fail("T6", s.id, `declares it consumes "${t}", which its executor "${executor}" does not declare and no context file supplies; the executor declares [${declares.consumes.join(", ")}]`));
    }
    if (s.kind !== "metric") continue;
    for (const t of declares.consumes) {
      if ((s.consumes as readonly string[]).includes(t)) continue;
      failures.push(fail("T6", s.id, `is a metric stage that does not declare it consumes "${t}", which its executor "${executor}" reads; a metric stage declares every input its executor reads, so the edge resolves at compile rather than failing at run`));
    }
  }
  checked.push("T6 every executed stage's produces and consumes are declared by its mounted plugin, and a metric stage's consumes equal the plugin's");

  // T3: as-of and grid consistency.
  if (plan.asOf !== portfolioAsOf) failures.push(fail("T3", null, `plan asOf ${plan.asOf} differs from portfolio asOf ${portfolioAsOf}`));
  const h = plan.grid.horizonMonths;
  if (!Number.isInteger(h) || h < 1 || h > MAX_HORIZON) failures.push(fail("T3", null, `grid.horizonMonths must be an integer in 1..${MAX_HORIZON}, got ${h}`));
  for (const s of plan.stages) {
    const sh = s.params?.horizonMonths;
    if (sh !== undefined && sh !== h) failures.push(fail("T3", s.id, `params.horizonMonths ${String(sh)} differs from grid.horizonMonths ${h}`));
  }
  checked.push(
    plan.asOf === portfolioAsOf
      ? `T3 asOf ${plan.asOf} equals the portfolio asOf; horizon ${h}`
      : `T3 asOf ${plan.asOf} differs from the portfolio asOf ${portfolioAsOf}; horizon ${h}`,
  );

  // T5: no orphan. Reachable from a context input (consumes a context type or
  // has an upstream that does) and reaches a metric stage.
  if (closure !== null) {
    const downstream = new Map<string, Set<string>>();
    for (const s of plan.stages) for (const up of closure.get(s.id) ?? []) {
      const d = downstream.get(up) ?? new Set<string>();
      d.add(s.id);
      downstream.set(up, d);
    }
    for (const s of plan.stages) {
      const fromContext = s.consumes.some((t) => CONTEXT_SUPPLIED_TYPES.includes(t)) || [...(closure.get(s.id) ?? [])].some((u) => byId.get(u)!.consumes.some((t) => CONTEXT_SUPPLIED_TYPES.includes(t)));
      const reachesMetric = s.kind === "metric" || [...(downstream.get(s.id) ?? [])].some((d) => byId.get(d)!.kind === "metric");
      if (!fromContext) failures.push(fail("T5", s.id, "not reachable from any context input"));
      if (!reachesMetric) failures.push(fail("T5", s.id, "reaches no metric stage"));
    }
    checked.push("T5 every stage reachable from a context input and reaching a metric");
  } else {
    checked.push("T5 skipped: the dependency graph has a cycle");
  }

  return { passed: failures.length === 0, failures, checked };
}
