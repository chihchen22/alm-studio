/**
 * Plan routes (harness Plane 4).
 *
 *   GET  /api/routing-policies            listing
 *   POST /api/routing-policies            { policy } -> 201
 *   GET  /api/balance-plans               listing
 *   GET  /api/balance-plans/:id           one stored balance plan -> 200 | 404
 *   POST /api/balance-plans               { balancePlan } -> 201 (a derivedFrom key is refused 422; see derive)
 *   POST /api/balance-plans/derive/preview  { baseId, bookId, ops, id?, label? } -> 200 { plan, changes, rules } (routes/derivedBalancePlans.ts)
 *   POST /api/balance-plans/derive          { baseId, bookId, ops, id?, label? } -> 201 | 200 | 409 | 422 (routes/derivedBalancePlans.ts)
 *   GET  /api/plans/library               the shipped scenario libraries
 *   GET  /api/catalog/plugins             catalog components, stage kinds and mounted plugins, verbatim (Studio S2)
 *   POST /api/plans/validate              { plan, candidateSets? } -> 200 { type, routing, compile, notImplemented, profileHash } (422 only on malformed shape)
 *   POST /api/plans/run                   { plan, seed?, label?, patches? } -> 202 run envelope | 422 plan_rejected
 *
 * A run through a plan writes one scenario slate "plan-<planId>" (append-only;
 * an existing slate with the same content is reused, a different content under
 * the same id is a 409) and then goes through the ordinary run submission, so
 * the child, the store layout and the catalog see nothing new.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssumptionSet, BalancePlan, IndexHistoryEntry, PortfolioSpec, RoutingPolicy, RunPlan, Scenario } from "@alm/engine";
import {
  COMPONENT_ALIASES,
  compilePlan,
  ExecutorError,
  indexHistoryIdsRead,
  parseRoutingPolicy,
  parseRunPlan,
  PlanRejected,
  PlanShapeError,
  SHIPPED_LIBRARIES,
  type CompiledPlan,
  type GateReport,
  type RunLogEntry,
} from "@alm/engine";
import type { PatchLayer } from "@alm/harness";
import type { MarketSnapshot } from "@alm/kernel";
import type { PlatformContext } from "../../context";
import { loadOperatorPlugins, pluginConfigPath } from "../../plugins/load";
import { sha256Hex } from "../../store/store";
import { bindAssumptions } from "@alm/engine/src/scenario";
import { conflict, HttpError, unprocessable } from "../errors";
import { mirrorBestEffort, validated, type RouteResult, type Router } from "../router";
import { submitRun } from "./runs";
import { readIndexHistory } from "../../workspaces/indexHistoryPins";

/**
 * The report slot of a gate that never ran. A refusal raised before the
 * waterfalls (a profile that will not mount, for one) leaves `PlanRejected`
 * carrying the EMPTY reports its constructor was handed, and those read
 * `passed: true`. Answering with them would credit a check nobody performed,
 * so a caller with no real reports says so here instead.
 */
function notRun(reason: string): GateReport {
  return { passed: false, failures: [], checked: [`gate not run: ${reason}`] };
}

/**
 * A gate rejection: 422 with BOTH reports in the detail, never a bare message.
 * The reports are the REAL ones when the compiler attached them, which it does
 * exactly when both waterfalls ran, and explicit not-run reports otherwise.
 */
function planRejected(err: PlanRejected): HttpError {
  const gates = err.gates ?? { type: notRun(err.message), routing: notRun(err.message) };
  return new HttpError(422, "plan_rejected", err.message, { type: gates.type, routing: gates.routing });
}

/**
 * An executor refusal: 422 with the same detail shape a compile refusal gets.
 * The run log the walker had when it refused rides along, so a caller sees which
 * stages ran before the one that could not.
 */
function executorRefused(err: ExecutorError): HttpError {
  return new HttpError(422, "plan_not_runnable", err.message, {
    error: err.name,
    ...(err.runLog !== undefined ? { runLog: err.runLog } : {}),
  });
}

/**
 * A compile refusal as the plan routes answer it: a gate rejection or an
 * executor refusal keeps its typed body, anything else is a 422 with the
 * engine's message. Shared with the setup compile (Studio A+E Task C2), so a
 * setup and a plan are refused alike.
 */
export function compileRefusal(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof PlanRejected) return planRejected(err);
  if (err instanceof ExecutorError) return executorRefused(err);
  return unprocessable(err instanceof Error ? err.message : String(err));
}

/**
 * The run pipeline requires exactly one base scenario; a 422 naming them otherwise.
 * Shared with the workspace setup launch (Studio A+E Task C3), which checks every
 * batch row before anything is written.
 */
export function assertOneBaseScenario(planId: string, scenarios: Scenario[]): void {
  const bases = scenarios.filter((s) => s.rateSpec.kind === "base");
  if (bases.length !== 1) {
    throw new HttpError(
      422,
      "plan_not_runnable",
      bases.length === 0
        ? `plan "${planId}" resolves to no base scenario; a run needs exactly one base scenario ` +
            `(a rateSpec of kind "base") to measure the shocked ones against`
        : `plan "${planId}" resolves to ${bases.length} base scenarios ` +
            `(${bases.map((s) => s.id).join(", ")}); a run needs exactly one base scenario`,
      { scenarioIds: scenarios.map((s) => s.id) },
    );
  }
}

/**
 * The launch slate of a plan run: one slate "plan-<planId>" per plan id, written once
 * (append-only) and reused when its stored scenarios agree; different content under the
 * same id is a 409. Returns the slate id. Shared with the workspace setup launch.
 */
export function writeOrReuseLaunchSlate(store: PlatformContext["store"], planId: string, scenarios: Scenario[]): string {
  const slateId = `plan-${planId}`;
  const slate = { id: slateId, label: `Scenarios of plan ${planId}`, scenarios };
  if (store.has("scenario-slates", slateId)) {
    const existing = store.getDocument<{ scenarios: Scenario[] }>("scenario-slates", slateId).doc;
    if (sha256Hex(JSON.stringify(existing.scenarios)) !== sha256Hex(JSON.stringify(slate.scenarios))) {
      throw conflict(
        `scenario slate "${slateId}" exists with different scenarios; change the plan id to run a changed scenario set`,
      );
    }
  } else {
    store.putDocument("scenario-slates", slateId, slate, {
      label: slate.label,
      scenarioCount: slate.scenarios.length,
      scenarioIds: slate.scenarios.map((s) => s.id),
      fromPlan: planId,
    });
    // After the store write: the catalog and lineage reads, and the run that consumes this slate, resolve
    // it at once (best effort; the workspace launch calls this inside its lock, and the mirror takes none).
    mirrorBestEffort({ store }, "scenario-slates", slateId);
  }
  return slateId;
}

/** Parse `{ plan }` off a request body; a shape refusal is a 422 naming the field. */
export function parseBodyPlan(body: unknown): RunPlan {
  if (typeof body !== "object" || body === null || !("plan" in body)) {
    throw unprocessable("body must be { plan: RunPlan }");
  }
  try {
    return parseRunPlan((body as { plan: unknown }).plan);
  } catch (err) {
    if (err instanceof PlanShapeError) throw unprocessable(err.message);
    throw err;
  }
}

/**
 * Shape gate for an untrusted BalancePlan (the `plans` collection). The engine
 * owns the lowering and refuses a path its rule shape cannot carry; this gate
 * only guarantees the stored document has the declared shape, so no raw
 * TypeError escapes the route and every refusal names the field.
 */
function parseBalancePlan(x: unknown): BalancePlan {
  const bad = (field: string, detail: string): never => {
    throw unprocessable(`${field}: ${detail}`);
  };
  const obj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!obj(x)) return bad("balancePlan", "expected an object");
  if (x.schemaVersion !== "1.0.0") {
    return bad("balancePlan.schemaVersion", `expected "1.0.0", got ${JSON.stringify(x.schemaVersion)}`);
  }
  for (const key of ["id", "label", "asOf"] as const) {
    if (typeof x[key] !== "string" || (x[key] as string).length === 0) {
      return bad(`balancePlan.${key}`, "expected a non-empty string");
    }
  }
  if (!Array.isArray(x.targets)) return bad("balancePlan.targets", "expected an array");
  // Path and pricing are shared by family and node targets: one gate, one set of refusals.
  const pathAndPricing = (t: Record<string, unknown>, at: string): Omit<BalancePlan["targets"][number], "familyId"> => {
    if (!Array.isArray(t.path)) return bad(`${at}.path`, "expected an array");
    const path = t.path.map((k, j): { month: number; balance: number } => {
      const kat = `${at}.path[${j}]`;
      if (!obj(k)) return bad(kat, "expected an object");
      if (typeof k.month !== "number" || !Number.isFinite(k.month)) {
        return bad(`${kat}.month`, "expected a finite number");
      }
      if (typeof k.balance !== "number" || !Number.isFinite(k.balance)) {
        return bad(`${kat}.balance`, "expected a finite number");
      }
      return { month: k.month, balance: k.balance };
    });
    const pricing = t.newBusinessPricing;
    if (!obj(pricing)) return bad(`${at}.newBusinessPricing`, "expected an object");
    for (const key of ["spreadOverIndexBp", "termMonths"] as const) {
      if (typeof pricing[key] !== "number" || !Number.isFinite(pricing[key] as number)) {
        return bad(`${at}.newBusinessPricing.${key}`, "expected a finite number");
      }
    }
    return {
      path,
      newBusinessPricing: {
        spreadOverIndexBp: pricing.spreadOverIndexBp as number,
        termMonths: pricing.termMonths as number,
      },
    };
  };
  const targets = x.targets.map((t, i): BalancePlan["targets"][number] => {
    const at = `balancePlan.targets[${i}]`;
    if (!obj(t)) return bad(at, "expected an object");
    if (typeof t.familyId !== "string" || t.familyId.length === 0) {
      return bad(`${at}.familyId`, "expected a non-empty string");
    }
    return { familyId: t.familyId, ...pathAndPricing(t, at) };
  });
  // Contract 25: optional node targets (contract 20). Absent stays absent, so no plan hash moves.
  let nodeTargets: BalancePlan["nodeTargets"];
  if (x.nodeTargets !== undefined) {
    if (!Array.isArray(x.nodeTargets)) return bad("balancePlan.nodeTargets", "expected an array");
    nodeTargets = x.nodeTargets.map((t, i): NonNullable<BalancePlan["nodeTargets"]>[number] => {
      const at = `balancePlan.nodeTargets[${i}]`;
      if (!obj(t)) return bad(at, "expected an object");
      if (typeof t.coaNodeId !== "string" || t.coaNodeId.length === 0) {
        return bad(`${at}.coaNodeId`, "expected a non-empty string");
      }
      return { coaNodeId: t.coaNodeId, ...pathAndPricing(t, at) };
    });
  }
  if (x.unlistedFamilies !== "runoff") {
    return bad(
      "balancePlan.unlistedFamilies",
      'expected "runoff" (families the plan does not list run off; the plan states it, it is never implied)',
    );
  }
  return {
    schemaVersion: "1.0.0",
    id: x.id as string,
    label: x.label as string,
    asOf: x.asOf as string,
    targets,
    unlistedFamilies: "runoff",
    ...(nodeTargets === undefined ? {} : { nodeTargets }),
  };
}

interface Resolved {
  portfolio: PortfolioSpec;
  marketSnapshot: MarketSnapshot;
  assumptionSets: AssumptionSet[];
  policy: RoutingPolicy;
  balancePlan?: BalancePlan;
  scenarioBalancePlans?: BalancePlan[];
  marketId: string;
  /** The index histories a lagged formula of the plan's market reads, sorted by id; absent when none. */
  indexHistories?: IndexHistoryEntry[];
}

/**
 * Set Check: the unsaved drafts a validate call checks the plan against. Each
 * goes through bindAssumptions, the Save route's validator, so a malformed
 * draft is the same 422 Save answers. A draft is identified by its id: it is
 * the draft of the stored set with that id, and stands in for it in this one
 * compile. A draft the plan does not read would check nothing, so it is a 422
 * naming it, as is a second draft of the same set. Nothing is stored.
 */
function parseCandidateSets(x: unknown, plan: RunPlan): Map<string, AssumptionSet> {
  const out = new Map<string, AssumptionSet>();
  if (x === undefined) return out;
  if (!Array.isArray(x)) throw unprocessable("candidateSets must be an array of assumption sets");
  const read = plan.inputs.assumptionSets ?? [];
  for (const raw of x) {
    const bound = validated(() => bindAssumptions(raw as AssumptionSet));
    if (!read.includes(bound.id)) {
      throw unprocessable(`candidate set "${bound.id}" is not one plan "${plan.planId}" reads (it reads ${read.join(", ")})`);
    }
    if (out.has(bound.id)) throw unprocessable(`candidateSets holds set "${bound.id}" twice`);
    out.set(bound.id, bound);
  }
  return out;
}

/**
 * Resolve every artifact the plan names; an unknown id is a 422 naming it. A
 * candidate (Set Check) stands in for the stored set with its id.
 */
function resolveInputs(ctx: PlatformContext, plan: RunPlan, candidates: ReadonlyMap<string, AssumptionSet> = new Map()): Resolved {
  const { store } = ctx;
  const require = <T>(fn: () => T, what: string, id: string): T => {
    try {
      return fn();
    } catch {
      throw unprocessable(`plan references unknown ${what} "${id}"`);
    }
  };
  const portfolio = require(
    () => store.getDocument<PortfolioSpec>("portfolios", plan.inputs.positionBook).doc,
    "portfolio",
    plan.inputs.positionBook,
  );
  const marketSnapshot = require(
    () => store.getDocument<MarketSnapshot>("market", plan.inputs.marketSnapshot).doc,
    "market snapshot",
    plan.inputs.marketSnapshot,
  );
  // Read from the store and checked against its id (422 missing, 409 moved), sorted by id.
  const historyIds = indexHistoryIdsRead(portfolio, marketSnapshot);
  const policy = require(
    () => store.getDocument<RoutingPolicy>("routing-policies", plan.inputs.routingPolicy).doc,
    "routing policy",
    plan.inputs.routingPolicy,
  );
  const setIds = plan.inputs.assumptionSets ?? [];
  if (setIds.length === 0) {
    throw unprocessable("plan.inputs.assumptionSets must name at least one stored assumption set");
  }
  const assumptionSets = setIds.map((id) =>
    candidates.get(id) ?? require(() => store.getDocument<AssumptionSet>("assumption-sets", id).doc, "assumption set", id),
  );
  const out: Resolved = {
    portfolio,
    marketSnapshot,
    assumptionSets,
    policy,
    marketId: plan.inputs.marketSnapshot,
    ...(historyIds.length > 0 ? { indexHistories: historyIds.map((id) => readIndexHistory(store, id).entry) } : {}),
  };
  if (plan.balancePlan !== undefined) {
    out.balancePlan = require(
      () => store.getDocument<BalancePlan>("plans", plan.balancePlan!).doc,
      "balance plan",
      plan.balancePlan,
    );
  }
  const mappedIds = [...new Set(Object.values(plan.scenarioBalancePlans ?? {}))];
  if (mappedIds.length > 0) {
    out.scenarioBalancePlans = mappedIds.map((id) =>
      require(() => store.getDocument<BalancePlan>("plans", id).doc, "balance plan", id),
    );
  }
  return out;
}

/**
 * A stored plan compiled exactly as `POST /api/plans/run` compiles it: the
 * shape gate, `resolveInputs` by id, then `compilePlan` against this box's
 * catalog with no patches and the route's default seed. The mounted context is
 * disposed before returning, so the caller reads the request, the gates and the
 * log, and runs nothing. It is the reference the setup compile's migration
 * parity (spec Section 8.3 invariant 8) is measured against.
 */
export function compileStoredPlan(ctx: PlatformContext, stored: RunPlan): CompiledPlan {
  const plan = parseBodyPlan({ plan: stored });
  const r = resolveInputs(ctx, plan);
  const operator = loadOperatorPlugins(pluginConfigPath(ctx.config.repoRoot));
  let compiled: CompiledPlan;
  try {
    compiled = compilePlan(
      plan,
      { ...r, libraries: SHIPPED_LIBRARIES, catalog: operator.catalog, pluginSources: operator.sources, patches: [] },
      { runId: "pending", seed: "platform-0", timestamps: { startedAt: "", finishedAt: "" } },
    );
  } catch (err) {
    throw compileRefusal(err);
  }
  compiled.harness.dispose();
  return compiled;
}

export function registerPlanRoutes(router: Router, ctx: PlatformContext): void {
  const { store } = ctx;

  router.add("GET", "/api/routing-policies", () => ({
    kind: "json",
    value: store
      .listMeta("routing-policies")
      .map((m) => ({ id: m.id, contentHash: m.contentHash, label: String(m.label ?? "") })),
  }));

  router.add("POST", "/api/routing-policies", (req) => {
    const body = req.json<{ policy?: unknown }>();
    let policy: RoutingPolicy;
    try {
      policy = parseRoutingPolicy(body.policy);
    } catch (err) {
      throw unprocessable(err instanceof Error ? err.message : String(err));
    }
    if (store.has("routing-policies", policy.id)) {
      throw conflict(`routing policy "${policy.id}" already exists (the store is append-only)`);
    }
    store.putDocument("routing-policies", policy.id, policy, {
      label: policy.label,
      classCount: policy.classes.length,
    });
    return { kind: "json", status: 201, value: policy };
  });

  router.add("GET", "/api/balance-plans", () => ({
    kind: "json",
    value: store
      .listMeta("plans")
      .map((m) => ({
        id: m.id,
        contentHash: m.contentHash,
        label: String(m.label ?? ""),
        asOf: String(m.asOf ?? ""),
        // Present on a derived plan's row only.
        ...(typeof m.derivedFromPlanId === "string" ? { derivedFromPlanId: m.derivedFromPlanId } : {}),
      })),
  }));

  router.add("GET", "/api/balance-plans/:id", (req) => ({
    kind: "json",
    value: store.getDocument<BalancePlan>("plans", req.params.id).doc,
  }));

  router.add("POST", "/api/balance-plans", (req) => {
    const body = req.json<{ balancePlan?: unknown }>();
    const candidate = body.balancePlan;
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      Object.prototype.hasOwnProperty.call(candidate, "derivedFrom")
    ) {
      throw unprocessable("derivedFrom is written by POST /api/balance-plans/derive; a plain save cannot carry it");
    }
    const balancePlan = parseBalancePlan(body.balancePlan);
    if (store.has("plans", balancePlan.id)) {
      throw conflict(`balance plan "${balancePlan.id}" already exists (the store is append-only)`);
    }
    store.putDocument("plans", balancePlan.id, balancePlan, {
      label: balancePlan.label,
      asOf: balancePlan.asOf,
      targetCount: balancePlan.targets.length,
    });
    return { kind: "json", status: 201, value: balancePlan };
  });

  router.add("GET", "/api/plans/library", () => ({ kind: "json", value: SHIPPED_LIBRARIES }));

  /** The catalog this box runs: the built-ins plus the operator's list, read once at registration. */
  const operator = loadOperatorPlugins(pluginConfigPath(ctx.config.repoRoot));

  // Studio S2. Registered here because the mounted list must be the catalog
  // the validate route compiles against, which lives in this closure. The
  // component rows are docs/harness/catalog.json verbatim; the route derives
  // no "runs" flag, the Studio does that from these three lists.
  router.add("GET", "/api/catalog/plugins", () => {
    const file = JSON.parse(readFileSync(join(ctx.config.repoRoot, "docs", "harness", "catalog.json"), "utf8")) as {
      components: unknown[];
      stageKinds: unknown[];
    };
    const mounted = [...operator.catalog.values()].map((p) => ({
      id: p.id,
      aliases: COMPONENT_ALIASES[p.id] ?? [],
      kind: p.declares?.kind ?? null,
    }));
    return { kind: "json", value: { components: file.components, stageKinds: file.stageKinds, mounted } };
  });

  /** Parse the optional patch layers off a run body. A bad shape is a 422 naming the layer. */
  const parsePatches = (x: unknown): PatchLayer[] => {
    if (x === undefined) return [];
    if (!Array.isArray(x)) throw unprocessable("patches must be an array of patch layers");
    return x.map((layer, i) => {
      if (typeof layer !== "object" || layer === null) throw unprocessable(`patches[${i}]: expected an object`);
      const l = layer as { label?: unknown; patches?: unknown };
      if (typeof l.label !== "string" || l.label.length === 0) {
        throw unprocessable(`patches[${i}].label: expected a non-empty string`);
      }
      if (!Array.isArray(l.patches)) throw unprocessable(`patches[${i}].patches: expected an array`);
      return { label: l.label, patches: l.patches as PatchLayer["patches"] };
    });
  };

  /** Compile against this box's catalog. The caller owns the context that comes back. */
  const compile = (plan: RunPlan, r: Resolved, patches: PatchLayer[], seed: string): CompiledPlan =>
    compilePlan(
      plan,
      {
        ...r,
        libraries: SHIPPED_LIBRARIES,
        catalog: operator.catalog,
        pluginSources: operator.sources,
        patches,
      },
      { runId: "pending", seed, timestamps: { startedAt: "", finishedAt: "" } },
    );

  /**
   * What a compile refusal carries out with it: the class name, the message,
   * the log it had written, and the two gate reports IF the waterfalls had run
   * by then. `gates` absent means the gates never ran.
   */
  interface CompileRefusal {
    name: string;
    message: string;
    gates?: { type: GateReport; routing: GateReport };
    runLog?: RunLogEntry[];
  }

  /**
   * Compile for validation, turning every typed refusal into a report rather
   * than a throw: a validate call asked a question and is owed an answer.
   */
  const tryCompile = (
    plan: RunPlan,
    r: Resolved,
    patches: PatchLayer[],
  ): { compiled?: CompiledPlan; refused?: CompileRefusal } => {
    try {
      return { compiled: compile(plan, r, patches, "platform-0") };
    } catch (err) {
      const carried = err as { gates?: CompileRefusal["gates"]; runLog?: RunLogEntry[] };
      return {
        refused: {
          name: err instanceof Error ? err.name : "unknown",
          message: err instanceof Error ? err.message : String(err),
          // Echoed only when the compiler attached them, which it does exactly
          // when both waterfalls ran. Nothing here synthesizes a report.
          ...(carried.gates !== undefined ? { gates: carried.gates } : {}),
          ...(carried.runLog !== undefined ? { runLog: carried.runLog } : {}),
        },
      };
    }
  };

  router.add("POST", "/api/plans/validate", (req) => {
    const body = req.json<{ plan?: unknown; patches?: unknown; candidateSets?: unknown }>();
    const plan = parseBodyPlan(body);
    // Set Check: drafts stand in for their stored sets in this compile only; the compile itself is unchanged.
    const r = resolveInputs(ctx, plan, parseCandidateSets(body.candidateSets, plan));
    // Section 7 step 1: the request's patch layers compose onto the plan's own
    // rows at validate time too. Validating the UNPATCHED tree and running the
    // patched one would answer a question the caller did not ask.
    const patches = parsePatches(body.patches);
    const outcome = tryCompile(plan, r, patches);
    if (outcome.compiled !== undefined) {
      // Nothing in THIS process runs the plan, so the context the compiler
      // handed over is unwound here rather than leaking one tree per call.
      outcome.compiled.harness.dispose();
      return {
        kind: "json",
        value: {
          type: outcome.compiled.gates.type,
          routing: outcome.compiled.gates.routing,
          compile: outcome.compiled.compile,
          notImplemented: outcome.compiled.notImplemented,
          // Studio S3a: the hash the run will carry (PlanRef.planHash), so a
          // confirm sheet shows it before submitting. A refusal carries none.
          planHash: outcome.compiled.request.plan!.planHash,
          profileHash: outcome.compiled.profileHash,
          profile: outcome.compiled.profile,
          runLog: outcome.compiled.runLog,
        },
      };
    }
    // A refusal. Round-2 ruling 10: a unit-level refusal surfaces at validate
    // time, not first at run time, and it surfaces as an answer rather than a
    // 500. The two report slots are filled from what the compiler actually did:
    // the REAL reports when the waterfalls ran (a plan can fail the type gate
    // AND carry a load-bearing unmounted stage, and the stage refusal is raised
    // first; reporting type.passed: true there would claim a check that
    // failed), and an explicit not-run report when they did not. A synthesized
    // pass is never an option: it would credit a gate nobody ran.
    const refused = outcome.refused!;
    return {
      kind: "json",
      value: {
        type: refused.gates?.type ?? notRun(refused.message),
        routing: refused.gates?.routing ?? notRun(refused.message),
        compile: { passed: false, detail: refused.message, error: refused.name },
        ...(refused.runLog !== undefined ? { runLog: refused.runLog } : {}),
      },
    };
  });

  router.add("POST", "/api/plans/run", (req): RouteResult => {
    const body = req.json<{ plan?: unknown; seed?: string; label?: string; patches?: unknown }>();
    const plan = parseBodyPlan(body);
    const r = resolveInputs(ctx, plan);
    const patches = parsePatches(body.patches);
    let compiled: CompiledPlan;
    try {
      compiled = compile(plan, r, patches, body.seed ?? "platform-0");
    } catch (err) {
      if (err instanceof PlanRejected) throw planRejected(err);
      if (err instanceof ExecutorError) throw executorRefused(err);
      throw unprocessable(err instanceof Error ? err.message : String(err));
    }
    // The plan runs in a child process, so nothing in THIS process reaches the
    // mounted tree after the compile: the compiler hands ownership over and the
    // route unwinds it here rather than leaking one context per submitted run.
    // The child mounts the SAME composed profile again, off the stored request.
    compiled.harness.dispose();

    // The run pipeline requires exactly one base scenario. Checking it HERE,
    // before the slate is written, keeps the append-only store clean: a plan
    // with no base would otherwise leave a slate behind that its corrected
    // successor could never replace under the same id.
    assertOneBaseScenario(plan.planId, compiled.request.scenarios);
    const slateId = writeOrReuseLaunchSlate(store, plan.planId, compiled.request.scenarios);
    const submitted = submitRun(ctx, {
      portfolioId: plan.inputs.positionBook,
      marketId: r.marketId,
      scenarioSlateId: slateId,
      assumptionSetIds: plan.inputs.assumptionSets,
      gridHorizonMonths: plan.grid.horizonMonths,
      ...(body.seed !== undefined ? { seed: body.seed } : {}),
      ...(body.label !== undefined ? { label: body.label } : {}),
      plan: compiled.request.plan!,
      planTags: compiled.notImplemented,
      planRunLog: compiled.runLog,
      profileHash: compiled.profileHash,
      profile: compiled.profile,
      planDocument: plan,
    }, compiled.request.views);
    // What the compiler learned is said at the front door as well as carried
    // into the envelope: a submitter who never reads the result still sees the
    // profile it ran on, which plugin answered for each seam, and which
    // declared stages the pipeline will not execute.
    if (submitted.kind === "json") {
      return {
        ...submitted,
        value: {
          ...(submitted.value as Record<string, unknown>),
          profileHash: compiled.profileHash,
          runLog: compiled.runLog,
          ...(compiled.notImplemented.length > 0 ? { notImplemented: compiled.notImplemented } : {}),
        },
      };
    }
    return submitted;
  });
}
