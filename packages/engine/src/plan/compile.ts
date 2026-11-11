/**
 * Plan to RunRequest, through a mounted plugin profile. The
 * compiler composes and mounts the profile, runs both gates through the kernel,
 * resolves scenarios, lowers the balance plan, and assembles the request. It
 * computes no cash flow and no rate: the only arithmetic here is summing
 * position notionals into per-family opening balances, which the balance-plan
 * lowering needs as its anchor. It fakes nothing either: a stage the mounted
 * profile cannot execute, or a scenario that cannot run as declared, is a
 * refusal rather than a tag.
 */
import { isNonRateFamily } from "../nonRate";
import type { Context, PatchLayer, PluginCatalog, Profile } from "@alm/harness";
import { composeProfile, DisposeFailedError, mountProfile, profileHash } from "@alm/harness";
import type { MarketSnapshot } from "@alm/kernel";
import type { AssumptionSet } from "../contracts/assumptions";
import type { BalancePlan } from "../contracts/balancePlan";
import type { IndexHistoryEntry } from "../contracts/indexHistory";
import type { NotImplemented } from "../contracts/errors";
import type { ProductFamilyId, RunId, ScenarioId } from "../contracts/ids";
import type { ContractTypeName, GateReport, PlanStage, RoutingPolicy, RunPlan } from "../contracts/plan";
import type { PortfolioSpec } from "../contracts/position";
import type { RunTimestamps } from "../contracts/provenance";
import type { RunRequest } from "../contracts/run";
import type { PluginSource, RunLogEntry } from "../contracts/runLog";
import type { NewBusinessRule, NewBusinessStrategy, ScenarioLibrary } from "../contracts/scenario";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "../plugins/catalog";
import { buildCellPlan, type CellPlan } from "../portfolio/cells";
import { checkBindingOverlap } from "../projection/static/applyOverlays";
import {
  ArtifactConflictError,
  CellBudgetError,
  OverlappingBindingError,
  RequiredMetricMissingError,
  TaxonomyMismatchError,
  UnknownDimensionError,
  UnlicensedBindingError,
  ViewDefinitionError,
} from "../run/executorErrors";
// SHARD_CHUNK is defined in the chunk module and not re-exported by the pass,
// so it is imported from the module that owns it.
import { SHARD_CHUNK } from "../run/shard/chunk";
import {
  DEFAULT_CELL_BUDGET_BYTES,
  predictedPassBytes,
  resolveShardCount,
  type ShardsOption,
} from "../run/shard/staticPass";
// The scope table itself, from the module that defines it rather than the stage
// barrel, so the compiler does not pull every stage implementation into its
// graph and the scope a metric conflict reports cannot drift from the scope the
// walker writes at.
import { STAGE_OUTPUT_SCOPE } from "../run/stages/types";
import { contentHash } from "../runtime/contentHash";
import { makeNotImplemented } from "../runtime/notImplemented";
import { resolveRunMacro } from "../macro/runMacro";
import { COMPONENT_ALIASES, resolveComponent } from "./componentAliases";
import { checkPredicateAgainstTaxonomy } from "./dimensions";
import { checkRateIndexRefs, derivedCurvesRead, indexHistoryReadings, indicesRead, RateIndexRefusedError, type DerivedCurveRead } from "../rateIndex/resolve";
import { rateIndexFormulaNote } from "../rateIndex/formulaNote";
import { rateIndexHistoryNote } from "../rateIndex/historyNote";
import { producersOf } from "./edges";
import { kindsByPlugin, licenseBindings, type LicenseGap, type LicenseOutcome } from "./license";
import { BalancePlanUnsupported, lowerBalancePlan, nodeTargetCoverage } from "./lowerBalancePlan";
import { DEPOSIT_INSTRUMENT_TYPES } from "./newVolumeTemplate";
import { resolveScenarios } from "./resolveScenarios";
import { stageExecutability, type StageProducers } from "./typeGate";

/**
 * Whether `stage`'s Cashflow input passes a stage of kind balance-new-business
 * (Studio Polish 1 E1). Each hop is the edge `producersOf` resolves in the
 * consumer's own dependsOn, the lookup the type gate's T1 and the walker's
 * resolveEdges share; a producer that itself reads Cashflow is followed back.
 * `seen` stops a cycle, which T4 refuses anyway.
 */
export function readsCashflowThroughBalance(plan: Pick<RunPlan, "stages">, stage: PlanStage, seen: Set<string> = new Set()): boolean {
  const byId = new Map(plan.stages.map((s) => [s.id, s] as const));
  for (const id of producersOf(plan, stage, "Cashflow")) {
    if (seen.has(id)) continue;
    seen.add(id);
    const producer = byId.get(id);
    if (producer === undefined) continue;
    if (producer.kind === "balance-new-business") return true;
    if ((producer.consumes as readonly string[]).includes("Cashflow") && readsCashflowThroughBalance(plan, producer, seen)) return true;
  }
  return false;
}

export interface ResolvedPlanInputs {
  portfolio: PortfolioSpec;
  marketSnapshot: MarketSnapshot;
  assumptionSets: AssumptionSet[];
  policy: RoutingPolicy;
  libraries: ScenarioLibrary[];
  balancePlan?: BalancePlan;
  /** Every balance plan the plan's scenarioBalancePlans names, resolved by the caller. */
  scenarioBalancePlans?: BalancePlan[];
  /** Defaults to BUILTIN_CATALOG. A server extends it with operator-installed plugins. */
  catalog?: PluginCatalog;
  /** Request patch layers, applied in order after the plan's own rows. */
  patches?: PatchLayer[];
  /** Where each plugin's code came from, for the catalog entries in the run log. */
  pluginSources?: ReadonlyMap<string, PluginSource>;
  /**
   * The shard setting the run will be stored with, so the compile
   * budget check resolves the same worker count the static pass will on this
   * host. Absent means "auto", which is what a platform submission defaults to.
   */
  shards?: ShardsOption;
  /**
   * The cell budget in bytes, mirroring the sixth parameter of
   * runStaticPass. Absent means DEFAULT_CELL_BUDGET_BYTES. Tests lower it; no
   * route threads it.
   */
  cellBudgetBytes?: number;
  /** The index histories the plan's lagged indices read, resolved by the caller; absent or empty when none. */
  indexHistories?: IndexHistoryEntry[];
}

export interface PlanStamps {
  runId: RunId;
  seed: string;
  timestamps: RunTimestamps;
}

export interface CompiledPlan {
  request: RunRequest;
  /**
   * Compile-time tags: scenario timing and environment, an unused balance plan.
   * The run pipeline never sees them, so the CALLER MUST merge them into
   * RunResult.notImplemented, with mergePlanTags, before the envelope is served
   * or archived. Dropped here, the run would read as complete when it is not.
   */
  notImplemented: NotImplemented[];
  gates: { type: GateReport; routing: GateReport };
  /** The compile block /api/plans/validate reports (round-2 ruling 10). */
  compile: { passed: boolean; detail?: string };
  profile: Profile;
  profileHash: string;
  /**
   * The mounted context, live and OWNED BY THE CALLER: it passes it to
   * buildRunResult and disposes it once the run is done. compilePlan disposes
   * it only on its own refusals, never on success, because a context disposed
   * here would leave the returned request with no seams to run through.
   */
  harness: Context;
  /** Profile, catalog and gate entries, in order. The run appends its own after these. */
  runLog: RunLogEntry[];
}

export class PlanRejected extends Error {
  readonly type: GateReport;
  readonly routing: GateReport;
  /** The compile's run log as far as it got, attached by compilePlan on the way out. */
  runLog?: RunLogEntry[];
  /**
   * The two gate reports, attached by compilePlan when the refusal happened
   * AFTER both waterfalls ran. Absent means the gates never ran, and a caller
   * must say so rather than reporting a pass nobody checked.
   */
  gates?: { type: GateReport; routing: GateReport };
  override readonly cause?: unknown;
  constructor(type: GateReport, routing: GateReport, cause?: unknown) {
    const n = type.failures.length + routing.failures.length;
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    super(
      n === 0
        ? `plan rejected before the gates ran${detail}`
        : `plan rejected: ${n} gate failure(s): ${[...type.failures, ...routing.failures].map((f) => `${f.rule}${f.stageId ? `@${f.stageId}` : ""}`).join(", ")}`,
    );
    this.name = "PlanRejected";
    this.type = type;
    this.routing = routing;
    if (cause !== undefined) this.cause = cause;
  }
}

/** A stage the mounted profile cannot execute: a missing component, or an orphaned type. */
export class PlanNotExecutableError extends Error {
  readonly stageId: string;
  /** The compile's run log as far as it got, attached by compilePlan on the way out. */
  runLog?: RunLogEntry[];
  /**
   * The two gate reports, attached by compilePlan when the refusal happened
   * AFTER both waterfalls ran. Absent means the gates never ran, and a caller
   * must say so rather than reporting a pass nobody checked.
   */
  gates?: { type: GateReport; routing: GateReport };
  readonly missing: { kind: "component"; component: string } | { kind: "type"; type: string };
  constructor(stageId: string, missing: { kind: "component"; component: string } | { kind: "type"; type: string }) {
    super(
      missing.kind === "component"
        ? `stage "${stageId}" names component "${missing.component}", which no mounted plugin declares; ` +
            `mount a plugin that declares it or remove the stage`
        : `stage "${stageId}" consumes "${missing.type}", which no mounted plugin produces and no context ` +
            `file supplies; the stage would read a value nothing computes`,
    );
    this.name = "PlanNotExecutableError";
    this.stageId = stageId;
    this.missing = missing;
  }
}

/** A scenario that cannot run as declared produces no numbers. */
export class ScenarioNotExecutableError extends Error {
  readonly scenarioId: ScenarioId;
  readonly reason: string;
  /** The compile's run log as far as it got, attached by compilePlan on the way out. */
  runLog?: RunLogEntry[];
  /**
   * The two gate reports, attached by compilePlan when the refusal happened
   * AFTER both waterfalls ran. Absent means the gates never ran, and a caller
   * must say so rather than reporting a pass nobody checked.
   */
  gates?: { type: GateReport; routing: GateReport };
  constructor(scenarioId: ScenarioId, reason: string) {
    super(`scenario "${scenarioId}" cannot run as declared: ${reason}`);
    this.name = "ScenarioNotExecutableError";
    this.scenarioId = scenarioId;
    this.reason = reason;
  }
}

/**
 * Thrown when two plan scenarios, whether refs or inline definitions, resolve
 * to the same scenario id. Left unchecked, the run would carry two scenarios
 * the result keys by one id and the second would shadow the first downstream.
 */
export class DuplicateScenarioIdError extends Error {
  readonly scenarioId: ScenarioId;
  /** The compile's run log as far as it got, attached by compilePlan on the way out. */
  runLog?: RunLogEntry[];
  /**
   * The two gate reports, attached by compilePlan when the refusal happened
   * AFTER both waterfalls ran. Absent means the gates never ran, and a caller
   * must say so rather than reporting a pass nobody checked.
   */
  gates?: { type: GateReport; routing: GateReport };
  constructor(scenarioId: ScenarioId) {
    super(`plan scenarios resolve to duplicate scenario id "${scenarioId}"; each scenario id must appear once`);
    this.name = "DuplicateScenarioIdError";
    this.scenarioId = scenarioId;
  }
}

/** What the mounted context can execute, read off the plugins' declares. */
export function registryProducers(harness: Context): StageProducers {
  const components = new Set<string>();
  const producedTypes = new Set<string>();
  const declaresByComponent = new Map<string, { produces: readonly string[]; consumes: readonly string[] }>();
  for (const plugin of harness.mountedPlugins()) {
    if (!plugin.declares) continue;
    const names = [plugin.id, ...(COMPONENT_ALIASES[plugin.id] ?? [])];
    const row = { produces: plugin.declares.produces, consumes: plugin.declares.consumes ?? [] };
    for (const name of names) {
      components.add(name);
      declaresByComponent.set(name, row);
    }
    for (const t of plugin.declares.produces) producedTypes.add(t);
  }
  return { components, producedTypes, declaresByComponent };
}

export function planHash(plan: RunPlan): string {
  return contentHash(plan);
}

/**
 * One note naming every derived curve the run applies, or
 * undefined when it applies none. `read` is sorted by curve id then index id,
 * so each curve's clause lists its indices in id order (ruling R4).
 */
function derivedCurveNote(read: readonly DerivedCurveRead[]): NotImplemented | undefined {
  if (read.length === 0) return undefined;
  const clauses: string[] = [];
  for (let i = 0; i < read.length; ) {
    const { curveId, label } = read[i]!;
    const indexIds: string[] = [];
    for (; i < read.length && read[i]!.curveId === curveId; i++) indexIds.push(read[i]!.indexId);
    clauses.push(`derived curve ${label} (${curveId}) adds a constant spread to index resets only (${indexIds.join(", ")})`);
  }
  return makeNotImplemented(
    "plan.derived-curve.index-only",
    `${clauses.join("; ")}; mortgages, client rates, new business and discounting read the base curve`,
  );
}

/** Each family's opening balance: the sum of its positions' notionals (the balance a target path is anchored on). */
export function openingBalances(portfolio: PortfolioSpec): Map<ProductFamilyId, number> {
  const out = new Map<ProductFamilyId, number>();
  for (const p of portfolio.positions) out.set(p.familyId, (out.get(p.familyId) ?? 0) + p.terms.notional);
  return out;
}

function emptyReport(): GateReport {
  return { passed: true, failures: [], checked: [] };
}

/**
 * Who actually checked, read off the report rather than assumed. Every gate
 * listener stamps its plugin id on the lines it contributes, so a chain a
 * bank's policy plugin vetoed, where the built-in never ran, names the policy
 * plugin instead of the built-in it replaced.
 */
function contributorsOf(report: GateReport): string[] {
  const out: string[] = [];
  for (const line of report.checked) {
    const match = /^\[([^\]]+)\]/.exec(line);
    if (match === null) continue;
    if (!out.includes(match[1]!)) out.push(match[1]!);
  }
  return out;
}

/** A gate whose chain contributed no checked line at all: nobody to credit. */
const NO_LISTENER = "<no listener>";

/** The gate entry: every contributor in order, and the one that owned the decision. */
function gateEntry(event: "plan/type-check" | "plan/route", report: GateReport): RunLogEntry {
  const contributors = contributorsOf(report);
  return {
    t: "gate",
    event,
    listenerPluginId: contributors[contributors.length - 1] ?? NO_LISTENER,
    contributors,
    passed: report.passed,
    failures: report.failures,
  };
}

/**
 * Unwind a context the compiler mounted but will not return. Teardown noise is
 * swallowed so the refusal the caller sees is the compile refusal, never a
 * dispose failure on top of it; this mirrors mountProfile's own cleanup.
 */
function discard(harness: Context): void {
  try {
    harness.dispose();
  } catch (err) {
    if (!(err instanceof DisposeFailedError)) throw err;
  }
}

/**
 * Hand the caller what the compile knew when it refused: the log it had
 * written, and the two gate reports IF the waterfalls had already run. Without
 * the log, the refuse entries the compile order appends die with the local
 * array and a rejected compile has no audit trail while a successful one has a
 * full one. Without the gates, a caller rendering a refusal has no honest way
 * to fill the two report slots, and the tempting default, a synthesized
 * passing report, would claim a check nobody performed.
 *
 * `gates` stays UNDEFINED for a refusal raised before the waterfalls (the
 * profile that would not mount): absent means "not run", and the caller says
 * so. Both are set on the error object itself, so no refusal class needs a new
 * constructor argument; a non-object throw is left alone.
 */
function attachDiagnostics(
  err: unknown,
  diagnostics: { runLog: RunLogEntry[]; gates?: { type: GateReport; routing: GateReport } },
): void {
  if (typeof err !== "object" || err === null) return;
  const target = err as { runLog?: RunLogEntry[]; gates?: { type: GateReport; routing: GateReport } };
  target.runLog = [...diagnostics.runLog];
  if (diagnostics.gates !== undefined) target.gates = diagnostics.gates;
}

export function compilePlan(plan: RunPlan, resolved: ResolvedPlanInputs, stamps: PlanStamps): CompiledPlan {
  const runLog: RunLogEntry[] = [];
  const catalog = resolved.catalog ?? BUILTIN_CATALOG;

  // 1. Compose the profile: the plan's rows, then the request's patch layers.
  const composed = composeProfile(plan.profile ?? DEFAULT_PROFILE, resolved.patches ?? []);
  const hash = profileHash(composed);
  runLog.push({
    t: "profile",
    profileHash: hash,
    rows: composed.rows.map((r) => ({
      id: r.id,
      plugin: r.plugin,
      configHash: contentHash(r.config ?? null),
      state: r.disabled === true ? "disabled" : "active",
    })),
  });

  // 2. Mount it. A kernel refusal is a PlanRejected carrying the typed cause.
  let harness: Context;
  try {
    harness = mountProfile(composed, catalog);
  } catch (cause) {
    runLog.push({ t: "refuse", error: cause instanceof Error ? cause.message : String(cause), ids: { profileHash: hash } });
    // The gates never ran, so no `gates` goes out: the profile dump and the
    // refuse entry do, because a caller that cannot mount a tree still needs
    // to see which rows it tried and what the kernel said about them.
    const refusal = new PlanRejected(emptyReport(), emptyReport(), cause);
    attachDiagnostics(refusal, { runLog });
    throw refusal;
  }
  // Set the moment both waterfalls have run, so every refusal raised after
  // that point carries the real reports out with it.
  let gates: { type: GateReport; routing: GateReport } | undefined;
  try {
    // Only rows whose fiber ACTIVATED are logged as loaded: a row that never
    // ran its apply put no code in force for this run, and a catalog entry for
    // it would say otherwise.
    const active = new Set(harness.mountedPlugins().map((p) => p.rowId));
    for (const row of composed.rows) {
      if (!active.has(row.id)) continue;
      runLog.push({ t: "catalog", pluginId: row.plugin, source: resolved.pluginSources?.get(row.plugin) ?? "builtin" });
    }

    // 3. The type gate, as a waterfall over the mounted listeners.
    const producers = registryProducers(harness);
    // Computed here rather than at step 4 because L2 reads it: a stage no
    // mounted plugin executes is not a producer of anything. The REFUSAL it
    // feeds still waits until after the routing gate, so the order in which a
    // plan learns what is wrong with it is unchanged.
    const executability = stageExecutability(plan, producers);
    const toleratedStageIds = new Set(executability.tolerated.map((t) => t.stageId));
    const type = harness.waterfall(
      "plan/type-check",
      { plan, portfolioAsOf: resolved.portfolio.asOf, producers },
      emptyReport(),
    );
    runLog.push(gateEntry("plan/type-check", type));

    // The cell plan block 3a builds, kept for the budget check that
    // runs once the scenario count is known (before step 7).
    let cellPlan: CellPlan | undefined;
    // Set at the rate-index check (3a'), pushed at step 5.
    let derivedNote: NotImplemented | undefined;
    // Piece B, step B3a (decision 43): the rate index formula note, set and pushed beside the B2 note.
    let formulaNote: NotImplemented | undefined;
    // Piece B, step B3b (decisions 49 and 52): the index history note, pushed after the formula note.
    let historyNote: NotImplemented | undefined;
    // 3a. The taxonomy is the book's. The plan's optional
    // inputs.dimensionTaxonomy is a cross-check, compared only when the book
    // carries a taxonomy (plan deviation 8). Then every predicate, on a stage or
    // on a binding, must name declared tags and allowed values: a misspelt tag
    // that matched nothing would look like an empty segment.
    if (type.passed) {
      const bookTax = resolved.portfolio.taxonomy;
      const named = plan.inputs.dimensionTaxonomy;
      if (bookTax !== undefined && named !== undefined && named !== bookTax.id) {
        const refusal = new TaxonomyMismatchError(named, bookTax.id);
        runLog.push({
          t: "refuse",
          error: refusal.message,
          ids: { layer: "plan/dimensions", planId: plan.planId, planTaxonomyId: named, bookTaxonomyId: bookTax.id },
        });
        throw refusal;
      }
      const refuseDimension = (where: string, offence: { dimension: string; value?: string }): never => {
        const refusal = new UnknownDimensionError(where, offence.dimension, offence.value);
        runLog.push({
          t: "refuse",
          error: refusal.message,
          ids: {
            layer: "plan/dimensions",
            planId: plan.planId,
            where,
            dimension: offence.dimension,
            ...(offence.value !== undefined ? { value: offence.value } : {}),
          },
        });
        throw refusal;
      };
      for (const s of plan.stages) {
        if (s.selector?.dimensions === undefined) continue;
        const offence = checkPredicateAgainstTaxonomy(s.selector.dimensions, bookTax);
        if (offence !== undefined) refuseDimension(`stage ${s.id}`, offence);
      }
      for (const set of resolved.assumptionSets) {
        for (let i = 0; i < set.bindings.length; i++) {
          const sel = set.bindings[i]!.selector;
          if (sel === undefined) continue;
          const offence = checkPredicateAgainstTaxonomy(sel, bookTax);
          if (offence !== undefined) refuseDimension(`assumption set ${set.id} bindings[${i}]`, offence);
        }
      }

      // A view must partition the book. Building the plan here is the
      // refusal, so a planned run and a plan-less one get the same answer from
      // the same code. The run builds its own plan; this pass is compile-only.
      if (plan.views !== undefined && plan.views.length > 0) {
        try {
          cellPlan = buildCellPlan(resolved.portfolio, plan.views);
        } catch (err) {
          if (err instanceof ViewDefinitionError) {
            runLog.push({
              t: "refuse",
              error: err.message,
              ids: {
                layer: "plan/views",
                planId: plan.planId,
                rule: err.rule,
                viewId: err.viewId,
                dimension: err.dimension,
                ...(err.positionId !== undefined ? { positionId: err.positionId } : {}),
              },
            });
          }
          throw err;
        }
      }

      // 3a'. A floater that names a rate index the plan's market
      // does not carry is refused here, so the Plan page gets a synchronous answer
      // and no number is ever computed on the one-month benchmark by mistake. An
      // unindexed book never reads the market's rateIndices block.
      const indexCheck = checkRateIndexRefs(
        resolved.portfolio,
        resolved.marketSnapshot,
        plan.inputs.marketSnapshot,
        resolved.indexHistories ?? [],
      );
      if (indexCheck.message !== undefined) {
        const first = indexCheck.first!;
        runLog.push({
          t: "refuse",
          error: indexCheck.message,
          ids: {
            layer: "plan/rate-indices",
            planId: plan.planId,
            positionId: first.positionId,
            rateIndexId: first.rateIndexId,
          },
        });
        throw new RateIndexRefusedError(indexCheck.message, first.positionId, first.rateIndexId);
      }
      // The derived curves the run applies, noted once at step 5.
      derivedNote = derivedCurveNote(derivedCurvesRead(resolved.portfolio, resolved.marketSnapshot));
      formulaNote = rateIndexFormulaNote(indicesRead(resolved.portfolio, resolved.marketSnapshot), "deterministic");
      historyNote = rateIndexHistoryNote(indexHistoryReadings(resolved.portfolio, resolved.marketSnapshot, resolved.indexHistories ?? []));
    }

    // 3b. L1 and L2 (spec Sections 4.1 and 4.2), run AFTER the plan/type-check
    // waterfall has returned and ONLY when the type gate passed (Ruling P13).
    // A T-refusal keeps precedence: a plan whose arrows do not compose is
    // rejected as a gate failure, and licensing a graph that does not type is
    // an answer to a question nobody asked. They are typed refusals rather than
    // gate failures because each one names a thing to fix rather than a rule
    // code: which binding has no licensee, which result nothing computes. Each
    // writes its own run-log entry under the plan/license layer.
    let license: LicenseOutcome | undefined;
    if (type.passed) {
      license = licenseBindings(
        plan,
        resolved.assumptionSets,
        resolved.portfolio,
        kindsByPlugin(harness.get("behavioral")),
      );
      const refuseLicense = (gap: LicenseGap): never => {
        const refusal = new UnlicensedBindingError(
          gap.assumptionSetId,
          gap.familyId,
          gap.kind,
          gap.bindingIndex,
          gap.candidateStageIds,
          gap.uncoveredPositionId,
          gap.licensingComponent,
        );
        runLog.push({
          t: "refuse",
          error: refusal.message,
          ids: {
            layer: "plan/license",
            planId: plan.planId,
            assumptionSetId: gap.assumptionSetId,
            familyId: gap.familyId,
            kind: gap.kind,
            bindingIndex: String(gap.bindingIndex),
          },
        });
        throw refusal;
      };
      // Ambiguity first: two licensees is a plan an author wrote on purpose and
      // can narrow, where a binding with no licensee may be the same defect
      // seen from the far end.
      const ambiguous = license.multi[0];
      if (ambiguous !== undefined) refuseLicense(ambiguous);
      const orphan = license.unlicensed[0];
      if (orphan !== undefined) refuseLicense(orphan);

      // L3: at most one binding per kind per position. The same
      // check the applier runs, so a set that compiles is a set that applies.
      for (const set of resolved.assumptionSets) {
        try {
          checkBindingOverlap(resolved.portfolio, set);
        } catch (err) {
          if (err instanceof OverlappingBindingError) {
            runLog.push({
              t: "refuse",
              error: err.message,
              ids: {
                layer: "plan/license",
                planId: plan.planId,
                assumptionSetId: err.assumptionSetId,
                positionId: err.positionId,
                kind: err.kind,
              },
            });
          }
          throw err;
        }
      }

      // L2: the three required result slots, and one producer each. FtpResult is
      // optional: absent means result.ftp is absent, which the 1.2.0 result
      // contract already permits.
      //
      // A TOLERATED metric stage is not a producer. Ruling 13 lets a stage no
      // mounted plugin executes ride along when nothing consumes what it
      // produces, and the walker skips it as not-executable; counting it here
      // would let a plan compile on the promise of an EveResult that the walk
      // then never puts on the shelf, and the assembly's PlanGraphError would
      // surface as a failed job rather than the 422 the caller should have got.
      // Disabling the mounted eve plugin through a request patch is exactly
      // that case. Excluding it at the map means the required-slot rule refuses
      // naming EveResult at compile, and the two-producer
      // conflict rule stops firing between a live stage and a dead one.
      //
      // One stage per custom metric. One plugin registers one custom
      // metric, so the component is the metric's compile-time identity, and
      // the key is the RESOLVED component, the same name the executor mounts
      // the stage under. Grouped in this one pass so the eligibility filter
      // above is stated once.
      const metricStages = new Map<string, string[]>();
      const customByComponent = new Map<string, string[]>();
      for (const s of plan.stages) {
        if (s.kind !== "metric" || toleratedStageIds.has(s.id)) continue;
        for (const t of s.produces) metricStages.set(t, [...(metricStages.get(t) ?? []), s.id]);
        if (!s.produces.includes("CustomMetricResult")) continue;
        const key = resolveComponent(s.component);
        customByComponent.set(key, [...(customByComponent.get(key) ?? []), s.id]);
      }
      for (const required of ["NiiResult", "EveResult", "GapResult"] as const) {
        if ((metricStages.get(required) ?? []).length > 0) continue;
        const refusal = new RequiredMetricMissingError(required);
        runLog.push({ t: "refuse", error: refusal.message, ids: { layer: "plan/license", planId: plan.planId, type: required } });
        throw refusal;
      }
      for (const [metricType, ids] of metricStages) {
        // Custom stages all produce CustomMetricResult, so the type
        // cannot tell two DIFFERENT custom metrics from one metric named
        // twice. They are checked by component below.
        if (metricType === "CustomMetricResult") continue;
        if (ids.length < 2) continue;
        const refusal = new ArtifactConflictError(
          metricType as ContractTypeName,
          { kind: STAGE_OUTPUT_SCOPE.metric },
          ids[0]!,
          ids[1]!,
        );
        runLog.push({ t: "refuse", error: refusal.message, ids: { layer: "plan/license", planId: plan.planId, type: metricType } });
        throw refusal;
      }
      // The one-stage-per-custom-metric refusal, on the grouping the
      // single pass above built. It stays here, after the required-slot check
      // and the type-keyed conflict loop, so refusal precedence is unchanged.
      for (const ids of customByComponent.values()) {
        if (ids.length < 2) continue;
        const refusal = new ArtifactConflictError(
          "CustomMetricResult",
          { kind: STAGE_OUTPUT_SCOPE.metric },
          ids[0]!,
          ids[1]!,
        );
        runLog.push({ t: "refuse", error: refusal.message, ids: { layer: "plan/license", planId: plan.planId, type: "CustomMetricResult" } });
        throw refusal;
      }
    }

    // 4. The routing gate, the same way.
    const routing = harness.waterfall(
      "plan/route",
      { plan, policy: resolved.policy, portfolio: resolved.portfolio, assumptionSets: resolved.assumptionSets },
      emptyReport(),
    );
    runLog.push(gateEntry("plan/route", routing));
    gates = { type, routing };
    // An executability gap is the typed refusal, raised before the general gate
    // rejection: the caller gets the stage and the thing that is missing, not a
    // list of rule codes. `executability` is the one computed above step 3b.
    const gap = executability.refusals[0];
    if (gap !== undefined) {
      const refusal = new PlanNotExecutableError(gap.stageId, gap.missing);
      runLog.push({ t: "refuse", error: refusal.message, ids: { planId: plan.planId, stageId: gap.stageId } });
      throw refusal;
    }
    if (!type.passed || !routing.passed) {
      const refusal = new PlanRejected(type, routing);
      runLog.push({ t: "refuse", error: refusal.message, ids: { planId: plan.planId } });
      throw refusal;
    }

    // 5. Resolve the scenarios; a rate-path model with no plugin refuses here.
    // A stage nothing executes and nothing depends on rides along as a tag
    // (ruling 13), so the envelope says which declared stage did not run.
    const notImplemented: NotImplemented[] = executability.tolerated.map((t) => makeNotImplemented(
      `plan.stage.${t.stageId}`,
      `component "${t.component}" (${plan.stages.find((s) => s.id === t.stageId)!.kind}) is declared in the plan but no mounted plugin executes it; no type only this stage produces is read by another stage, so the run proceeds without it`,
    ));
    // L1's other half: a behavioral stage that licenses nothing is a tag, not a
    // refusal. It passes its book through unchanged and the run log records it
    // as skipped. A stage the profile already TOLERATED is excluded (Ruling
    // P15): it carries `plan.stage.<id>` already, and a second tag would say
    // twice what one entry says once.
    for (const stageId of license?.unboundStageIds ?? []) {
      if (toleratedStageIds.has(stageId)) continue;
      notImplemented.push(makeNotImplemented(
        `plan.stage.${stageId}.unbound`,
        `behavioral stage "${stageId}" licenses no binding in any of this run's assumption sets; ` +
          `it passes the book through unchanged and the run log records it as skipped`,
      ));
    }
    if (derivedNote !== undefined) notImplemented.push(derivedNote);
    if (formulaNote !== undefined) notImplemented.push(formulaNote);
    if (historyNote !== undefined) notImplemented.push(historyNote);
    const defaultAssumptionSetId = plan.inputs.assumptionSets?.[0] ?? resolved.assumptionSets[0]?.id ?? "";
    // Every compile refusal below is logged before it leaves, so a rejected
    // compile carries the same audit trail as a successful one.
    const refusing = <T>(ids: Record<string, string>, f: () => T): T => {
      try {
        return f();
      } catch (err) {
        // A scenario refusal names its scenario, the way the rate-path refusal
        // below does: the id is on the error, never guessed from the call site.
        const scoped = err instanceof ScenarioNotExecutableError ? { ...ids, scenarioId: err.scenarioId } : ids;
        runLog.push({ t: "refuse", error: err instanceof Error ? err.message : String(err), ids: scoped });
        throw err;
      }
    };
    // 6. Lower every balance plan, eagerly and once: a malformed balance plan
    // must be refused whether or not a scenario ends up consuming it.
    const balancePlan = resolved.balancePlan;
    // Studio A+E contract 20: a node target allocates to the asset and liability
    // families under it; the families it skipped are tagged once per balance plan.
    const nodeTagged = new Set<string>();
    const lower = (bp: BalancePlan) => {
      const rules = refusing({ planId: plan.planId, balancePlanId: bp.id }, () => lowerBalancePlan(
        bp,
        openingBalances(resolved.portfolio),
        plan.grid.horizonMonths,
        resolved.portfolio.asOf,
        resolved.portfolio.coa,
      ));
      if (!nodeTagged.has(bp.id)) {
        nodeTagged.add(bp.id);
        for (const nt of bp.nodeTargets ?? []) {
          const { skipped } = nodeTargetCoverage(nt.coaNodeId, resolved.portfolio.coa, openingBalances(resolved.portfolio));
          if (skipped.length === 0) continue;
          notImplemented.push(makeNotImplemented(
            "plan.balance-plan.node-skipped",
            `balance plan "${bp.id}" node target "${nt.coaNodeId}" skipped ${skipped.length} famil${skipped.length === 1 ? "y" : "ies"} with no positive opening balance or a side other than asset or liability: ${skipped.join(", ")}`,
          ));
        }
      }
      return rules;
    };
    if (balancePlan !== undefined && plan.balanceBasis !== undefined) {
      throw refusing({ planId: plan.planId }, () => {
        throw new BalancePlanUnsupported(null, null, `plan "${plan.planId}" names both balanceBasis and balancePlan; choose one`);
      });
    }
    let loweredRules = balancePlan === undefined ? undefined : lower(balancePlan);
    // Studio A+E contract 18: the Flat basis lowers to one flat rule per family
    // with a positive opening balance on the asset or liability side.
    if (plan.balanceBasis !== undefined) {
      const basis = plan.balanceBasis;
      const opening = openingBalances(resolved.portfolio);
      const skipped: string[] = [];
      const rules: NewBusinessRule[] = [];
      for (const fam of resolved.portfolio.coa.families) {
        const bal = opening.get(fam.id) ?? 0;
        // S3a-1 follow-up: a non-rate-sensitive family is held at book; the flat rule skips it.
        if ((fam.side !== "asset" && fam.side !== "liability") || !(bal > 0) || isNonRateFamily(fam)) {
          skipped.push(fam.id);
          continue;
        }
        rules.push({
          familyId: fam.id,
          reinvest: "flat",
          ...(basis.termMonths !== undefined ? { termMonths: basis.termMonths } : {}),
          ...(basis.spreadOverIndexBp !== undefined ? { spreadOverIndexBp: basis.spreadOverIndexBp } : {}),
        });
      }
      if (rules.length === 0) {
        throw refusing({ planId: plan.planId }, () => {
          throw new BalancePlanUnsupported(null, null, `plan "${plan.planId}" asks for a flat balance sheet and the book has no family eligible for the flat rule (every family sits off the asset and liability sides or has no positive opening balance)`);
        });
      }
      if (skipped.length > 0) {
        notImplemented.push(makeNotImplemented(
          "plan.balance-basis.skipped",
          `flat basis skipped ${skipped.length} famil${skipped.length === 1 ? "y" : "ies"} with no positive opening balance or a side other than asset or liability: ${skipped.join(", ")}`,
        ));
      }
      loweredRules = rules;
    }
    // The per-scenario map. Each named plan must be supplied; each is lowered once.
    const mapped = plan.scenarioBalancePlans ?? {};
    const supplied = new Map((resolved.scenarioBalancePlans ?? []).map((bp) => [bp.id, bp] as const));
    const loweredById = new Map<string, { plan: BalancePlan; rules: ReturnType<typeof lowerBalancePlan> }>();
    for (const bpId of new Set(Object.values(mapped))) {
      const bp = supplied.get(bpId);
      if (bp === undefined) {
        // refusing logs and rethrows; the outer throw only narrows `bp` for the compiler.
        throw refusing({ planId: plan.planId, balancePlanId: bpId }, () => {
          throw new BalancePlanUnsupported(null, null, `balance plan "${bpId}" named in scenarioBalancePlans was not supplied`);
        });
      }
      loweredById.set(bpId, { plan: bp, rules: lower(bp) });
    }
    // A family's new-volume template rides on the rule its basis lowers, with the
    // template's term and spread. Every template must name an asset or liability family of the book.
    const templates = new Map((plan.newVolumeTemplates ?? []).map((t) => [t.familyId, t] as const));
    for (const t of plan.newVolumeTemplates ?? []) {
      const fam = resolved.portfolio.coa.families.find((f) => f.id === t.familyId);
      if (fam === undefined || (fam.side !== "asset" && fam.side !== "liability")) {
        throw refusing({ planId: plan.planId }, () => {
          throw new BalancePlanUnsupported(t.familyId, null, fam === undefined
            ? `a new-volume template names family "${t.familyId}", which is not in the book's chart of accounts; the products were saved for another book, so save them again for this one (the Analysis path's New volume step)`
            : `a new-volume template names family "${t.familyId}", whose side is "${fam.side}"; new volume is minted on the asset and liability sides only`);
        });
      }
      if (isNonRateFamily(fam)) {
        throw refusing({ planId: plan.planId }, () => {
          throw new BalancePlanUnsupported(t.familyId, null, `a new-volume template names family "${t.familyId}", which is non-rate-sensitive: it is held at book value and does not run off, so new volume has nothing to replace`);
        });
      }
      // A deposit template mints a cohort of the family's own deposit kind, so the family must be one.
      if (t.rateType === "deposit" && !DEPOSIT_INSTRUMENT_TYPES.includes(fam.instrumentType)) {
        throw refusing({ planId: plan.planId }, () => {
          throw new BalancePlanUnsupported(t.familyId, null, `a deposit new-volume template names family "${t.familyId}", whose instrument type is "${fam.instrumentType}"; a deposit product is a non-maturity deposit family's (nmd or nmd-b) only`);
        });
      }
    }
    const withTemplate = (r: NewBusinessRule): NewBusinessRule => {
      const t = templates.get(r.familyId);
      if (t === undefined) return { ...r };
      return {
        ...r,
        spreadOverIndexBp: t.spreadOverIndexBp,
        termMonths: t.termMonths,
        template: {
          rateType: t.rateType,
          amortization: t.amortization,
          indexTenorMonths: t.indexTenorMonths,
          ...(t.fixedIndex !== undefined ? { fixedIndex: t.fixedIndex } : {}),
          // Written last and only when present, so an S2b-1 template keeps its bytes.
          ...(t.behavior !== undefined ? { behavior: t.behavior } : {}),
        },
      };
    };
    const consumers: ScenarioId[] = [];
    const mapConsumers = new Map<ScenarioId, string>();
    const defaultNewBusiness = (id: ScenarioId): NewBusinessStrategy => {
      const entry = mapped[id];
      if (entry !== undefined) {
        mapConsumers.set(id, entry);
        return { mode: "dynamic", rules: loweredById.get(entry)!.rules.map(withTemplate) };
      }
      if (loweredRules === undefined) return { mode: "static", rules: [] };
      consumers.push(id);
      return { mode: "dynamic", rules: loweredRules.map(withTemplate) };
    };
    const ratePaths = harness.get("ratePaths");
    const { scenarios, notImplemented: scenarioTags } = refusing({ planId: plan.planId }, () => resolveScenarios(
      plan.scenarios,
      resolved.libraries,
      defaultNewBusiness,
      defaultAssumptionSetId,
      plan.grid.horizonMonths,
    ));
    notImplemented.push(...scenarioTags);
    for (const scenario of scenarios) {
      const modelId = scenario.ratePathModel ?? "deterministic";
      if (!ratePaths.has(modelId)) {
        const refusal = new ScenarioNotExecutableError(
          scenario.id,
          `rate-path model "${modelId}" is not mounted; registered models: [${ratePaths.ids().join(", ")}]`,
        );
        runLog.push({ t: "refuse", error: refusal.message, ids: { planId: plan.planId, scenarioId: scenario.id } });
        throw refusal;
      }
      // The plugin is ASKED of the registry, never derived from the model id: a
      // third-party model's plugin id is whatever its author chose.
      runLog.push({
        t: "resolve",
        key: "ratePaths",
        pluginId: ratePaths.providerOf(modelId) ?? "<unregistered>",
        scope: { scenarioId: scenario.id },
      });
    }

    if (resolved.balancePlan !== undefined && consumers.length === 0) {
      notImplemented.push(makeNotImplemented(
        "plan.balance-plan.unused",
        `balance plan "${resolved.balancePlan.id}" was declared but no scenario consumed it (each carries its own newBusiness or a scenarioBalancePlans entry): ${scenarios.map((s) => s.id).join(", ")}`,
      ));
    }
    const seen = new Set<ScenarioId>();
    for (const s of scenarios) {
      if (seen.has(s.id)) throw new DuplicateScenarioIdError(s.id);
      seen.add(s.id);
    }
    // A map key naming no scenario of the plan is refused, and an entry
    // the scenario's own newBusiness shadowed is noted, not silently dropped.
    for (const [key, bpId] of Object.entries(mapped)) {
      if (!seen.has(key)) {
        refusing({ planId: plan.planId, balancePlanId: bpId }, () => {
          throw new BalancePlanUnsupported(null, null, `scenarioBalancePlans key "${key}" names no scenario of plan "${plan.planId}"; scenarios: ${[...seen].join(", ")}`);
        });
      }
      if (!mapConsumers.has(key)) {
        notImplemented.push(makeNotImplemented(
          "plan.balance-plan.shadowed",
          `scenario "${key}" carries its own newBusiness, so its balance plan "${bpId}" in scenarioBalancePlans is not used`,
        ));
      }
    }
    // Dynamic new business runs only in a balance-new-business stage.
    // Without one the scenario would run off and say nothing (spec Section 2 item 11).
    const firstDynamic = scenarios.find((s) => s.newBusiness.mode === "dynamic");
    if (firstDynamic !== undefined && !plan.stages.some((s) => s.kind === "balance-new-business")) {
      refusing({ planId: plan.planId }, () => {
        throw new ScenarioNotExecutableError(
          firstDynamic.id,
          "it runs dynamic new business, and the plan has no stage of kind balance-new-business (component engine.balance-plan) to run it; add the balance stage and point the NII stage at it",
        );
      });
    }
    // Polish 1 E1: the balance stage must be on every NII stage's Cashflow
    // chain, not merely present. Without this a hand-wired plan (the balance
    // stage feeding EVE, NII on the contractual stage) would stamp the balance
    // plan hashes on a run whose NII never read new business.
    if (firstDynamic !== undefined) {
      for (const nii of plan.stages.filter((s) => (s.produces as readonly string[]).includes("NiiResult"))) {
        if (readsCashflowThroughBalance(plan, nii)) continue;
        refusing({ planId: plan.planId }, () => {
          throw new ScenarioNotExecutableError(
            firstDynamic.id,
            `it runs dynamic new business, and the NII stage "${nii.id}" does not read its Cashflow through a stage of kind balance-new-business, so the new business would not reach NII; point the NII stage at the balance stage`,
          );
        });
      }
    }

    // The cell budget, predicted here with the exported closed form
    // the static pass checks before its first allocation.
    // Compile and run therefore agree by construction on this host: same cell
    // count, horizon, positions and scenario count, and the same shard
    // resolution. The run-time guard in runStaticPass stays as the hard stop.
    if (cellPlan !== undefined) {
      const positions = resolved.portfolio.positions.length;
      const workers = Math.min(resolveShardCount(resolved.shards ?? "auto"), Math.max(1, Math.ceil(positions / SHARD_CHUNK)));
      const budget = resolved.cellBudgetBytes ?? DEFAULT_CELL_BUDGET_BYTES;
      const predicted = predictedPassBytes(cellPlan.cells.length, plan.grid.horizonMonths, positions, scenarios.length, workers);
      if (predicted > budget) {
        const viewIds = cellPlan.views.map((v) => v.viewId);
        const refusal = new CellBudgetError(viewIds, cellPlan.cells.length, positions, scenarios.length, workers, predicted, budget);
        runLog.push({
          t: "refuse",
          error: refusal.message,
          ids: {
            layer: "plan/views",
            planId: plan.planId,
            rule: "budget",
            viewIds: viewIds.join(","),
            predictedBytes: String(predicted),
            budgetBytes: String(budget),
          },
        });
        throw refusal;
      }
    }

    // 6b. The run's macro mapping, resolved as the run will resolve
    // it, so a mapping the market or the scenario sets cannot carry is refused
    // here under layer plan/macro. A set that carries a house-price group but no
    // mapping, and inherits none, runs unmapped and says so.
    const macro = refusing({ layer: "plan/macro", planId: plan.planId }, () => resolveRunMacro(
      { scenarios, assumptionSets: resolved.assumptionSets, grid: { horizonMonths: plan.grid.horizonMonths } },
      resolved.marketSnapshot,
      plan.inputs.marketSnapshot,
    ));
    if (macro.kind === "none") {
      const axis = new Set(scenarios.map((s) => s.assumptionSetId));
      for (const set of resolved.assumptionSets) {
        if (!axis.has(set.id)) continue;
        const b = set.bindings.find((x) => x.overlay.kind === "prepay" && x.overlay.model === "four-factor-cpr" && x.overlay.housing !== undefined);
        if (b === undefined) continue;
        notImplemented.push(makeNotImplemented(
          "plan.macro.unmapped",
          `set ${set.id} carries a house-price response for family ${b.familyId} but no macro mapping, and inherits none; the run reads the kernel schedule`,
        ));
      }
    }

    // 7. Assemble and stamp.
    const request: RunRequest = {
      runId: stamps.runId,
      portfolioId: resolved.portfolio.id,
      marketSnapshot: resolved.marketSnapshot,
      scenarios,
      assumptionSets: resolved.assumptionSets,
      grid: { horizonMonths: plan.grid.horizonMonths, asOf: resolved.portfolio.asOf },
      ...(plan.views !== undefined && plan.views.length > 0 ? { views: plan.views } : {}),
      ...(resolved.indexHistories !== undefined && resolved.indexHistories.length > 0 ? { indexHistories: resolved.indexHistories } : {}),
      seed: stamps.seed,
      timestamps: stamps.timestamps,
      // Ruling 14: the policy and the balance plan are inputs the plan NAMES
      // rather than carries, so the plan hash alone does not pin the request.
      plan: {
        planId: plan.planId,
        planHash: planHash(plan),
        policyHash: contentHash(resolved.policy),
        ...(balancePlan !== undefined ? { balancePlanHash: contentHash(balancePlan) } : {}),
        ...(plan.balanceBasis !== undefined ? { balanceBasis: plan.balanceBasis } : {}),
        ...(mapConsumers.size > 0
          ? { scenarioBalancePlanHashes: Object.fromEntries([...mapConsumers].map(([sid, bpId]) => [sid, contentHash(loweredById.get(bpId)!.plan)])) }
          : {}),
        // Which stage licenses which binding (L1), so the run walks the plan
        // the compile licensed rather than licensing it a second time.
        ...(license !== undefined && license.licensed.length > 0 ? { licensedBindings: license.licensed } : {}),
      },
    };
    // policyHash is optional on the contract so an archived or hand-built plan
    // block still typechecks, but a COMPILED request always carries it: the
    // request is not reproducible without the policy it compiled against.
    if (request.plan?.policyHash === undefined) {
      throw new Error("compilePlan: internal invariant broken, request.plan.policyHash was not stamped");
    }
    return {
      request,
      notImplemented,
      gates: { type, routing },
      compile: { passed: true },
      profile: composed,
      profileHash: hash,
      harness,
      runLog,
    };
  } catch (err) {
    // Every refusal after the mount unwinds the tree it mounted: a caller that
    // never receives the context cannot be the one to dispose it. The log goes
    // out with the refusal, after the dispose, so the caller can say what ran.
    discard(harness);
    attachDiagnostics(err, { runLog, ...(gates !== undefined ? { gates } : {}) });
    throw err;
  }
}
