/**
 * The setup compile (Studio A+E spec v3.1 Section 5.2 steps 1 to 8; contracts 5, 6
 * and 15; plan Task C2). A run setup, its slot and the workspace head become one
 * `RunPlan`, compiled by the engine's own `compilePlan` against this box's catalog,
 * exactly as `POST /api/plans/run` compiles a stored plan. Nothing is written: the
 * validate and launch routes decide what to record and what to submit. The one
 * exception: with an active curve setup, step 1 stores the derived market
 * the setup is pinned into, append-only and content-addressed, so a second compile reuses it.
 *
 * Order, as the spec states it:
 *  1. Roles. Book, market, routing policy and assumption sets resolve from the head's
 *     blocks (`block-default` to `assumptions.defaultSetId`); a slate and the balance
 *     plans resolve from theirs. Each document is read as stored bytes, hashed, and
 *     compared with the head's pin in that role: a mismatch is a 409, an absent role a
 *     422. Every role lands in `consumed`. With an active curve setup the
 *     market role is the derived market that setup is pinned into, and the setup itself is
 *     the `curveSetup` role; with none, the market role is exactly the block's pin. Saved derived
 *     curves an index of that market names ride the same derive, each in its own
 *     `derivedCurve:<curve id>` role.
 *  2. `asOf` is the book's as-of (never the cut-off date); the grid is the setup's.
 *  3. Scenarios: library refs verbatim; a slate inlined as definitions with
 *     `newBusiness` removed (contract 5); `plan-scenarios` items verbatim.
 *  4. Basis: Flat sets `balanceBasis`, Custom sets `balancePlan`, Runoff sets neither;
 *     `scenarioBalancePlans` pass through.
 *  5. Stages: a literal list passes through; "derived-default" is the engine's default
 *     plan for the resolved sets with the balance stage on whenever the basis is Flat
 *     or Custom or a scenario plan exists (contract 23). With the setup's FTP switch off, every
 *     stage that produces FtpResult is dropped from either list (slice three decision 121).
 *  6. Pass 1 with planId "ws-pending"; the planId is
 *     `ws-<10 hex of sha256(setupLineageId)>-<12 hex of contentHash(request.scenarios)>`
 *     (Section 2.10). An unedited import keeps its own planId and skips this pass.
 *  7. Pass 2 with the final id; its scenarios must be byte-identical to pass 1's (a 500
 *     naming both hashes otherwise). Then the Slice 1 checks on the resolved scenarios.
 *  8. The basis label by provenance: one `BasisSource` per scenario in the compiler's
 *     own precedence, never read off the rule shapes (MAJOR 1, ruling 20).
 */
import {
  compilePlan,
  DEFAULT_NII_WINDOW_MONTHS,
  DEFAULT_PROFILE,
  indexHistoryIdsRead,
  isEngineReportHorizons,
  OVERLAY_KIND_TO_CLASS,
  PLAN_SCHEMA_VERSION,
  SHIPPED_LIBRARIES,
  type AssumptionSet,
  type BalancePlan,
  type BehavioralClassId,
  type CompiledPlan,
  type GapBucketsOption,
  type GateReport,
  type IndexHistoryEntry,
  type NotImplemented,
  type PlanScenarioRef,
  type PlanStage,
  type PortfolioSpec,
  type RoutingPolicy,
  type RunLogEntry,
  type RunPlan,
  type RunRequest,
  type ScenarioDefinition,
  type SegSettings,
} from "@alm/engine";
import { defaultPlanFor } from "@alm/engine/src/run/defaultPlan";
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import { seasoningRefusals } from "@alm/engine/src/portfolio/seasoning";
import { composeProfile, mountProfile, type Profile } from "@alm/harness";
import type { MarketSnapshot } from "@alm/kernel";
import type { PlatformContext } from "../context";
import { conflict, HttpError, unprocessable } from "../http/errors";
import { compileRefusal } from "../http/routes/plans";
import { loadOperatorPlugins, pluginConfigPath, type OperatorPlugins } from "../plugins/load";
import { AlreadyExistsError, NotFoundError, serializeDocument, sha256Hex } from "../store/store";
import { derivedMarketMeta } from "../derivedSets/derivedMarkets";
import { mirrorBestEffort } from "../http/router";
import { readActiveCurveSetup } from "./curveSetupSlot";
import { marketPinOf, namedCurveIdsOf, readDerivedCurve } from "./derivedCurveSlot";
import { readIndexHistory } from "./indexHistoryPins";
import type {
  BasisSource,
  ConsumedPins,
  ConsumedRole,
  DocRef,
  NiiBasis,
  RunSetup,
  SetupInputs,
  SetupLiquidityStress,
  SetupScenarios,
  SetupSlot,
  WorkspaceManifest,
} from "./types";
import type { WorkspaceStore } from "./workspaceStore";

export interface CompiledSetupRow {
  planId: string;
  request: RunRequest;
  planDocument: RunPlan;
  consumed: ConsumedPins;
  basisLabel: string;
  basisByScenario: Record<string, BasisSource>;
  skippedFamilies: string[];
  warnings: string[];
  gates: { type: GateReport; routing: GateReport };
  notImplemented: NotImplemented[];
  profileHash: string;
  /** The composed profile the row compiled against; the launch persists it so the child mounts the same rows. */
  profile: Profile;
  runLog: RunLogEntry[];
  /** The engine options the launch submits for this setup (`engineOptionsOfSetup`). */
  engineOptions: SetupEngineOptions;
  /** The per-position results opt-in the launch submits; absent when the setup does not save them. */
  instrumentResults?: { save: true; coaNodeIds?: string[] };
}

/**
 * The run route's `engineOptions` a setup asks for (spec E1 to E5), each written only when it is not the
 * default, the rule `resolveEngineOptions` stores them by, so a setup that asks for nothing new submits the
 * body it always did. Every batch row of a setup shares them.
 */
export interface SetupEngineOptions {
  durationMode: "base-only" | "per-scenario";
  keyRate?: true;
  eveChannels?: true;
  discountBasis?: "risk-free" | "spread-consistent";
  nmdConvention?: "regulatory" | "shocked-level";
  nmdWarmup?: NonNullable<RunSetup["nmdWarmup"]>;
  /** The model convention, written only when the setup names one (absent is the original convention). */
  modelConvention?: NonNullable<RunSetup["modelConvention"]>;
  seg?: true;
  /** The SEG knobs, written only when the setup's SEG block is on and names one. */
  segSettings?: SegSettings;
  nextResetGap?: true;
  /** The fixed-rate gap ladder, written only when the setup's `gap.fixedRateLadder` is on. */
  fixedRateGap?: true;
  /** The forecast gap arm, written only when the setup's `gap.forecast` is on. */
  forecastGap?: true;
  /** Going-concern EVE, written only when the setup's `eve.goingConcern` is on. */
  goingConcernEve?: true;
  /** The months going-concern EVE counts, written only beside `goingConcernEve` when the setup names them. */
  goingConcernSpan?: number;
  liquidityStress?: SetupLiquidityStress;
  /**
   * Slice three (spec decisions 107 to 111): the repricing ladder's user buckets, written for `monthly` and
   * `custom`, never for `standard` (the nine bands are on every ladder).
   */
  gapBuckets?: GapBucketsOption;
  /**
   * The liquidity ladder's user buckets, written for a `monthly` or `custom-months` interval on a ladder that is
   * switched on; `standard`, the reserved `daily`, and a switched-off ladder write nothing (decision 109).
   */
  liquidityBuckets?: GapBucketsOption;
  /**
   * The liquidity ladder's flows, written only as "principal-plus-interest" on a ladder that is
   * switched on; "principal" (the default) and a switched-off ladder write nothing.
   */
  liquidityFlows?: "principal-plus-interest";
  /** The NII report horizons, written only when they differ from the engine default [12, 24] (decision 115). */
  reportHorizons?: number[];
  /** The default NII window (`nii.horizonMonths`), written only when it is not 60 (decision 118). */
  windowMonths?: number;
}

function gapBucketsOf(setup: Omit<RunSetup, "id">): GapBucketsOption | undefined {
  const rb = setup.gap.repricingBuckets;
  if (rb.kind === "monthly") return { kind: "monthly" };
  if (rb.kind === "custom") return { kind: "custom", edgesMonths: [...rb.edgesMonths] };
  return undefined;
}

function liquidityBucketsOf(setup: Omit<RunSetup, "id">): GapBucketsOption | undefined {
  const liq = setup.gap.liquidity;
  if (!liq.enabled) return undefined;
  if (liq.interval.kind === "monthly") return { kind: "monthly" };
  if (liq.interval.kind === "custom-months") return { kind: "custom", edgesMonths: [...liq.interval.edgesMonths] };
  return undefined;
}

function reportHorizonsOf(setup: Omit<RunSetup, "id">): number[] | undefined {
  const rh = setup.nii.reportHorizons;
  return isEngineReportHorizons(rh) ? undefined : [...rh];
}

/** The SEG knobs a setup names, only when its SEG block is on and names at least one. */
function segSettingsOfSetup(setup: Omit<RunSetup, "id">): SegSettings | undefined {
  const s = setup.seg;
  if (s === undefined || !s.enabled) return undefined;
  const { enabled: _enabled, ...knobs } = s;
  return Object.keys(knobs).length === 0 ? undefined : knobs;
}

export function engineOptionsOfSetup(setup: Omit<RunSetup, "id">): SetupEngineOptions {
  const gapBuckets = gapBucketsOf(setup);
  const liquidityBuckets = liquidityBucketsOf(setup);
  const reportHorizons = reportHorizonsOf(setup);
  const windowMonths = setup.nii.horizonMonths !== DEFAULT_NII_WINDOW_MONTHS ? setup.nii.horizonMonths : undefined;
  return {
    durationMode: setup.eve.durationMode,
    ...(setup.eve.keyRate ? { keyRate: true as const } : {}),
    ...(setup.eve.channels ? { eveChannels: true as const } : {}),
    ...(setup.eve.discountBasis !== "all-in" ? { discountBasis: setup.eve.discountBasis } : {}),
    ...(setup.nmdConvention === "regulatory" || setup.nmdConvention === "shocked-level" ? { nmdConvention: setup.nmdConvention } : {}),
    ...(setup.nmdWarmup !== undefined ? { nmdWarmup: setup.nmdWarmup } : {}),
    ...(setup.modelConvention !== undefined ? { modelConvention: setup.modelConvention } : {}),
    ...(setup.seg?.enabled === true ? { seg: true as const } : {}),
    ...(segSettingsOfSetup(setup) !== undefined ? { segSettings: segSettingsOfSetup(setup) } : {}),
    ...(setup.gap.nextReset === true ? { nextResetGap: true as const } : {}),
    ...(setup.gap.fixedRateLadder ? { fixedRateGap: true as const } : {}),
    ...(setup.gap.forecast === true ? { forecastGap: true as const } : {}),
    ...(setup.eve.goingConcern === true ? { goingConcernEve: true as const } : {}),
    ...(setup.eve.goingConcern === true && setup.eve.goingConcernSpan !== undefined ? { goingConcernSpan: setup.eve.goingConcernSpan } : {}),
    ...(setup.liquidityStress !== undefined ? { liquidityStress: setup.liquidityStress } : {}),
    ...(gapBuckets !== undefined ? { gapBuckets } : {}),
    ...(liquidityBuckets !== undefined ? { liquidityBuckets } : {}),
    ...(setup.gap.liquidity.enabled && setup.gap.liquidity.flows === "principal-plus-interest"
      ? { liquidityFlows: "principal-plus-interest" as const }
      : {}),
    ...(reportHorizons !== undefined ? { reportHorizons } : {}),
    ...(windowMonths !== undefined ? { windowMonths } : {}),
  };
}

/** The run route's `instrumentResults` a setup asks for; an absent or empty node list means every position. */
export function instrumentResultsOfSetup(setup: Omit<RunSetup, "id">): { save: true; coaNodeIds?: string[] } | undefined {
  const ir = setup.instrumentResults;
  if (!ir.save) return undefined;
  return { save: true, ...(ir.coaNodeIds !== undefined && ir.coaNodeIds.length > 0 ? { coaNodeIds: [...ir.coaNodeIds] } : {}) };
}

/** One batch row of a setup (Section 5.2 `RunSetup.batch`); null means the setup itself. */
export type SetupRow = { label: string; scenarios: SetupScenarios; assumptionSetIds: SetupInputs["assumptionSetIds"]; basis: NiiBasis };

/**
 * The decided refusal of a stochastic EVE path (review C M1; the limitations page "Slice 1 deviations").
 * The launch submits no `mode` or `stochastic` block, so a setup asking for the stochastic path
 * would run deterministic with nothing said; validate and launch refuse it instead, and readiness
 * reads the Run setups item Error with the same text. NII carries no stochastic arm in the setup
 * schema (`nii.path` is "single" only, refused at the shape gate), so there is nothing to refuse there.
 */
export const STOCHASTIC_PATH_CODE = "stochastic-path-reserved";
export const STOCHASTIC_PATH_REFUSAL =
  "Stochastic runs launch from the Analysis path in this release: choose one on the Simulation step and launch it on the Run step. This setup asks for the stochastic EVE path. Choose single path to launch it on the deterministic path.";

/** Refuse a setup whose EVE settings ask for the stochastic path, by name. */
export function assertDeterministicPath(setup: RunSetup): void {
  if (setup.eve.path === "stochastic") throw new HttpError(422, STOCHASTIC_PATH_CODE, STOCHASTIC_PATH_REFUSAL, { field: "eve.path" });
}

/** The planId pass 1 compiles under; never launched. */
export const PENDING_PLAN_ID = "ws-pending";

/**
 * The Flat basis on the plan (contract 18), from the setup's arm. Key order kind, termMonths, spreadOverIndexBp, as
 * the literal it replaced (S2b-1 lifts the 60 and 0 pin), so a stored setup at 60 and 0 compiles to the same plan
 * bytes and hash.
 */
const flatBasisOf = (b: Extract<NiiBasis, { kind: "flat" }>) => ({ kind: "flat" as const, termMonths: b.termMonths, spreadOverIndexBp: b.spreadOverIndexBp });

/** The informational tag the compiler raises for families the Flat basis skips (contract 18). */
const SKIPPED_TAG = "plan.balance-basis.skipped";

const STAMPS = { runId: "pending", seed: "platform-0", timestamps: { startedAt: "", finishedAt: "" } };

// ---------------------------------------------------------------------------
// Step 1: roles and the pin check
// ---------------------------------------------------------------------------

/** Read a pinned document's stored bytes and refuse 409 when they no longer hash to the head's pin. */
function readPinned<T>(ctx: PlatformContext, role: string, ref: DocRef): T {
  let bytes: Buffer;
  try {
    bytes = ctx.store.getDocumentBytes(ref.collection, ref.id);
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw conflict(`pin ${role} "${ref.id}" moved: head pins ${ref.contentHash}, and no document "${ref.id}" is in ${ref.collection}`);
    }
    throw err;
  }
  const actual = sha256Hex(bytes);
  if (actual !== ref.contentHash) {
    throw conflict(`pin ${role} "${ref.id}" moved: head pins ${ref.contentHash}, bytes hash ${actual}`);
  }
  return JSON.parse(bytes.toString("utf8")) as T;
}

function missing(detail: string, field: string): never {
  throw unprocessable(detail, { field });
}

/**
 * One sentence naming at most the first five refused positions, the count of the rest, and the
 * engine's own message for the first refused position (read from `seasoningRefusals`, verbatim).
 */
function seasoningSentence(bookId: string, refused: Array<{ positionId: string; message: string }>): string {
  const n = refused.length;
  const named = refused.slice(0, 5).map((r) => `"${r.positionId}"`).join(", ");
  const rest = n > 5 ? ` and ${n - 5} more` : "";
  return (
    `book "${bookId}" holds ${n} position${n === 1 ? "" : "s"} whose originationOffsetMonths the engine cannot season: ` +
    `${named}${rest}; the first reads: ${refused[0]!.message}.`
  );
}

interface Roles {
  consumed: ConsumedPins;
  portfolio: PortfolioSpec;
  marketSnapshot: MarketSnapshot;
  marketId: string;
  policy: RoutingPolicy;
  policyId: string;
  assumptionSets: AssumptionSet[];
  setIds: string[];
  slate?: { scenarios: Array<Record<string, unknown>> };
  balancePlan?: BalancePlan;
  scenarioBalancePlans?: BalancePlan[];
  /** The index histories the run reads, sorted by id; absent when it reads none. */
  indexHistories?: IndexHistoryEntry[];
}

/**
 * Piece B, step B1 (plan Task 8). With an active curve setup, the run's market is ONE derived market:
 * the resolved market (base or already derived) plus one `set-curve-setup` op, derived by the engine
 * with no id (`derived-mk-<12 hex>`, the reapply.ts pattern), so the same setup on the same market is
 * the same id and the same bytes, reused, never a 409. It is stored append-only and mirrored (it is a
 * `market` document, and a run's ingest resolves its market pin in the database), and never listed in
 * the market block. A pointer to a missing setup refuses with its sentence; it never falls back to the
 * legacy curve. Null when no setup is active: the market role stays byte-identical to before.
 *
 * Piece B, step B2 (plan Task 6). The same derive also carries one `set-derived-curve` op per saved
 * derived curve that an index of the resolved market names (marketPinOf), each read from its slot and
 * listed as a `derivedCurve:<curve id>` role. A curve an index names that no slot holds is not pinned:
 * the engine's run check then refuses an index a position reads, naming the index and the curve. With
 * no setup active and no curve named, null: the market role stays byte-identical to before.
 *
 * After the market is pinned, every index history a lagged formula of
 * that market's read closure reads (the engine's indexHistoryIdsRead, sorted by id) is read as stored bytes,
 * checked against its id and pinned in its own `indexHistory:<id>` role (indexHistoryPins.ts); the documents ride
 * the compile and the run request. A missing document is a 422 and moved bytes a 409. With no history read,
 * nothing is pinned and the roles stay byte-identical to before.
 */
function pinMarket(
  ctx: PlatformContext,
  ws: WorkspaceManifest,
  marketId: string,
  market: MarketSnapshot,
): { setupRef: DocRef | null; curveRefs: Array<[string, DocRef]>; marketRef: DocRef | null } | null {
  const active = readActiveCurveSetup(ctx.store, ws.blocks.market);
  const curves = namedCurveIdsOf(market)
    .map((curveId) => readDerivedCurve(ctx.store, ws.blocks.market, curveId))
    .filter((c): c is NonNullable<typeof c> => c !== null);
  if (active === null && curves.length === 0) return null;
  const curveRefs = curves.map((c): [string, DocRef] => [c.block.id, c.ref]);
  const result = marketPinOf(market, marketId, active?.block ?? null, curves.map((c) => c.block));
  if (result === null) return { setupRef: active?.ref ?? null, curveRefs, marketRef: null }; // the market already carries all of it
  const { store } = ctx;
  const bytesHash = sha256Hex(serializeDocument(result.snapshot));
  if (!store.has("market", result.id)) {
    try {
      store.putDocument("market", result.id, result.snapshot, derivedMarketMeta(result));
      // After the store write: the run's ingest resolves this market pin in the database (best effort).
      mirrorBestEffort(ctx, "market", result.id);
    } catch (err) {
      if (!(err instanceof AlreadyExistsError)) throw err; // another compile wrote the same bytes first
    }
  }
  const meta = store.getMeta("market", result.id);
  if (meta.contentHash !== bytesHash) {
    throw conflict(`market "${result.id}" already exists with different content (the store is append-only)`);
  }
  return {
    setupRef: active?.ref ?? null,
    curveRefs,
    marketRef: { collection: "market", id: result.id, contentHash: meta.contentHash, pinnedAt: new Date().toISOString() },
  };
}

function resolveRoles(
  ctx: PlatformContext,
  ws: WorkspaceManifest,
  slot: SetupSlot,
  inputs: SetupInputs,
  scenarios: SetupScenarios,
  basis: NiiBasis,
  scenarioBalancePlans: Record<string, string> | undefined,
): Roles {
  const consumed: ConsumedPins = {};
  const pin = <T>(role: ConsumedRole, ref: DocRef): T => {
    consumed[role] = ref;
    return readPinned<T>(ctx, role, ref);
  };
  const { blocks } = ws;

  const bookRef =
    inputs.book.role === "base"
      ? blocks.positions.book ?? missing(`workspace "${ws.id}" has no position book; attach one to the positions block`, "inputs.book")
      : blocks.positions.retagged.find((r) => r.id === (inputs.book as { id: string }).id) ??
        missing(`retagged book "${(inputs.book as { id: string }).id}" is not in the positions block of workspace "${ws.id}"`, "inputs.book");
  const portfolio = pin<PortfolioSpec>("book", bookRef);
  // Studio blank path D4: a stored book the engine cannot season (a seasoned floater put in the
  // store before intake refused it) fails validation here instead of the run, at minute 40.
  const unseasonable = seasoningRefusals(portfolio);
  if (unseasonable.length > 0) throw unprocessable(seasoningSentence(bookRef.id, unseasonable), { field: "inputs.book" });

  let marketRef: DocRef;
  if (inputs.market.role === "base") {
    marketRef = blocks.market.snapshot ?? missing(`workspace "${ws.id}" has no market snapshot; attach one to the market block`, "inputs.market");
  } else {
    const key = inputs.market.definitionKey;
    const derived = blocks.market.derived.find((d) => d.definitionKey === key);
    if (derived === undefined) {
      const carried = blocks.market.carried.find((c) => c.definitionKey === key);
      missing(
        `derived market definition "${key}" is not in the market block of workspace "${ws.id}"` +
          (carried !== undefined ? `; it is still carried (${carried.status}), so re-apply it on the new base` : "; it is not carried either"),
        "inputs.market",
      );
    }
    marketRef = derived;
  }
  let marketSnapshot = pin<MarketSnapshot>("market", marketRef);
  let marketId = marketRef.id;
  const curve = pinMarket(ctx, ws, marketRef.id, marketSnapshot);
  if (curve !== null) {
    if (curve.setupRef !== null) consumed.curveSetup = curve.setupRef;
    for (const [curveId, ref] of curve.curveRefs) consumed[`derivedCurve:${curveId}`] = ref;
    if (curve.marketRef !== null) {
      marketSnapshot = pin<MarketSnapshot>("market", curve.marketRef);
      marketId = curve.marketRef.id;
    }
  }
  // Every index history a lagged formula of the run's market reads, pinned by its bytes.
  const historyEntries: IndexHistoryEntry[] = [];
  for (const id of indexHistoryIdsRead(portfolio, marketSnapshot)) {
    const { ref, entry } = readIndexHistory(ctx.store, id);
    consumed[`indexHistory:${id}`] = ref;
    historyEntries.push(entry);
  }

  const policyRef = blocks.assumptions.routingPolicy ?? missing(`workspace "${ws.id}" has no routing policy; attach one to the assumptions block`, "routingPolicy");
  const policy = pin<RoutingPolicy>("routingPolicy", policyRef);

  let setIds: string[];
  if (Array.isArray(inputs.assumptionSetIds)) {
    setIds = inputs.assumptionSetIds;
  } else {
    const def = blocks.assumptions.defaultSetId;
    if (def === null) missing("attach an assumption set; the first attached becomes the default", "inputs.assumptionSetIds");
    setIds = [def];
  }
  const assumptionSets = setIds.map((id) => {
    const ref = blocks.assumptions.sets.find((r) => r.id === id) ??
      missing(`assumption set "${id}" is not in the assumptions block of workspace "${ws.id}"`, "inputs.assumptionSetIds");
    return pin<AssumptionSet>(`set:${id}`, ref);
  });

  const out: Roles = {
    consumed,
    portfolio,
    marketSnapshot,
    marketId,
    policy,
    policyId: policyRef.id,
    assumptionSets,
    setIds,
    ...(historyEntries.length > 0 ? { indexHistories: historyEntries } : {}),
  };

  if (scenarios.kind === "slate") {
    const slateRef = blocks.scenarios.slates.find((r) => r.id === scenarios.slateId) ??
      missing(`scenario slate "${scenarios.slateId}" is not in the scenarios block of workspace "${ws.id}"`, "scenarios.slateId");
    out.slate = pin("slate", slateRef);
  }

  const balancePlanRef = (id: string, field: string): DocRef =>
    blocks.targets.balancePlans.find((r) => r.id === id) ??
    missing(`balance plan "${id}" is not in the targets block of workspace "${ws.id}"`, field);
  if (basis.kind === "custom") {
    out.balancePlan = pin<BalancePlan>("balancePlan", balancePlanRef(basis.balancePlanId, "nii.basis.balancePlanId"));
  }
  const mapped = Object.entries(scenarioBalancePlans ?? {});
  if (mapped.length > 0) {
    // One document per distinct plan, in first-appearance order (the plans route's own resolveInputs order).
    const byId = new Map<string, BalancePlan>();
    for (const [scenarioId, bpId] of mapped) {
      const doc = pin<BalancePlan>(`balancePlan:${scenarioId}`, balancePlanRef(bpId, `plan.scenarioBalancePlans.${scenarioId}`));
      if (!byId.has(bpId)) byId.set(bpId, doc);
    }
    out.scenarioBalancePlans = [...byId.values()];
  }
  consumed.setup = slot.current;
  return out;
}

// ---------------------------------------------------------------------------
// Step 3: scenarios (contract 5)
// ---------------------------------------------------------------------------

function planScenarios(scenarios: SetupScenarios, slate: Roles["slate"]): PlanScenarioRef[] {
  if (scenarios.kind === "library") return scenarios.refs.map((ref) => ({ ref }));
  if (scenarios.kind === "plan-scenarios") return scenarios.items;
  const all = slate!.scenarios;
  const ids = all.map((s) => String(s.id));
  if (scenarios.include !== "all") {
    for (const id of scenarios.include) {
      if (!ids.includes(id)) {
        missing(`scenario "${id}" is not in slate "${scenarios.slateId}" (it holds ${ids.join(", ")})`, "scenarios.include");
      }
    }
  }
  const include = scenarios.include;
  return all
    .filter((s) => include === "all" || include.includes(String(s.id)))
    .map((s) => {
      // The setup's basis decides new business; a slate scenario's own strategy would win over it.
      const { newBusiness: _dropped, ...definition } = s;
      return definition as unknown as ScenarioDefinition;
    });
}

/** The definition a plan scenario resolves to, as `resolveScenarios` looks it up; undefined when the ref names nothing (the compile refuses it). */
function definitionOf(entry: PlanScenarioRef): ScenarioDefinition | undefined {
  if (!("ref" in entry)) return entry;
  const hash = entry.ref.indexOf("#");
  const lib = SHIPPED_LIBRARIES.find((l) => l.id === entry.ref.slice(0, hash));
  return lib?.scenarios.find((s) => s.id === entry.ref.slice(hash + 1));
}

function scenarioIdOf(entry: PlanScenarioRef): string {
  return "ref" in entry ? entry.ref.slice(entry.ref.indexOf("#") + 1) : entry.id;
}

// ---------------------------------------------------------------------------
// Step 8: provenance and the label
// ---------------------------------------------------------------------------

/** One `BasisSource` per scenario, in `compilePlan`'s own precedence (`compile.ts` defaultNewBusiness). */
function basisSources(plan: RunPlan): Array<{ id: string; source: BasisSource; ownMode?: "static" | "dynamic" }> {
  return plan.scenarios.map((entry) => {
    const id = scenarioIdOf(entry);
    const own = definitionOf(entry)?.newBusiness;
    if (own !== undefined) return { id, source: { kind: "scenario" }, ownMode: own.mode };
    const mapped = plan.scenarioBalancePlans?.[id];
    if (mapped !== undefined) return { id, source: { kind: "scenario-plan", balancePlanId: mapped } };
    if (plan.balancePlan !== undefined) return { id, source: { kind: "plan", balancePlanId: plan.balancePlan } };
    if (plan.balanceBasis !== undefined) return { id, source: { kind: "flat" } };
    return { id, source: { kind: "runoff" } };
  });
}

/**
 * The label (Section 5.2 step 8). Whole-run labels when every scenario agrees; otherwise
 * one phrase per group of scenarios, in first-appearance order. A scenario's own static
 * strategy is a runoff and reads so; its own dynamic strategy is named as its own.
 */
export function basisLabelOf(rows: Array<{ id: string; source: BasisSource; ownMode?: "static" | "dynamic" }>): string {
  const groups: Array<{ key: string; name: string; plan?: string; ids: string[] }> = [];
  for (const r of rows) {
    let name: string;
    let plan: string | undefined;
    if (r.source.kind === "flat") name = "Flat";
    else if (r.source.kind === "runoff" || (r.source.kind === "scenario" && r.ownMode === "static")) name = "Runoff";
    else if (r.source.kind === "scenario") name = "Own dynamic strategy";
    else {
      name = "Custom dynamic";
      plan = r.source.balancePlanId;
    }
    const key = `${name}\u0000${plan ?? ""}`;
    const group = groups.find((g) => g.key === key);
    if (group === undefined) groups.push({ key, name, ...(plan !== undefined ? { plan } : {}), ids: [r.id] });
    else group.ids.push(r.id);
  }
  if (groups.length === 1) {
    const g = groups[0]!;
    if (g.name === "Flat") return "Flat (simple top-up)";
    if (g.name === "Runoff") return "Runoff";
    if (g.name === "Custom dynamic") return `Custom dynamic (${g.plan})`;
  }
  return groups.map((g) => `${g.name} on ${g.ids.join(", ")}${g.plan !== undefined ? ` (${g.plan})` : ""}`).join(", ");
}

/** The family list the compiler's skipped tag names, after its last colon. */
function skippedFamiliesOf(tags: NotImplemented[]): string[] {
  const tag = tags.find((t) => t.layer === SKIPPED_TAG);
  if (tag === undefined) return [];
  const list = tag.reason.slice(tag.reason.lastIndexOf(": ") + 2);
  return list.split(", ").filter((f) => f.length > 0);
}

/**
 * Slice 1 settings the run does not honour yet, each said once (Sections 6.3, 6.4, 6.5). Slice three (decision 112)
 * honours the bucket setting on both ladders and the NII report horizons, so their warnings are gone. Slice 4a
 * honours liquidity flows of principal plus interest (the interest-inclusive ladder), so its warning is gone too.
 * Slice B2 honours the fixed-rate ladder, so its warning is gone as well.
 */
function warningsOf(setup: RunSetup): string[] {
  const out: string[] = [];
  const liq = setup.gap.liquidity;
  if (liq.enabled && liq.interval.kind === "daily") {
    out.push("Liquidity gap: a daily interval is reserved; it needs a daily cash flow generator, a later release. Results show the interim nine standard bands.");
  }
  if (setup.eve.valuationDates !== "as-of") {
    out.push("EVE: valuation at later dates is reserved for a later release; Results show present value as of the grid as-of.");
  }
  // A deposit history whose every value is below 0.5 is most likely decimals, not percent
  // (0.0365 for 3.65 percent). It is not refused (a near-zero rate era is real), but it is said, and the launch asks.
  const w = setup.nmdWarmup;
  if (w !== undefined && w.kind === "history" && w.series.valuesPct.length > 0 && w.series.valuesPct.every((x) => x < 0.5)) {
    out.push(`Deposit history: every value of "${w.series.label}" is below 0.5. The history is read in percent (3.65 for 3.65 percent); check that it is not in decimals.`);
  }
  // instrumentResults.save is honoured: the launch sends it, the runner writes instruments.json.
  return out;
}

// ---------------------------------------------------------------------------
// The compile
// ---------------------------------------------------------------------------

export function behavioralRegistryOf(profile: RunPlan["profile"], operator: OperatorPlugins) {
  const harness = mountProfile(composeProfile(profile ?? DEFAULT_PROFILE, []), operator.catalog);
  return {
    registry: harness.get("behavioral"),
    dispose: () => harness.dispose(),
  };
}

function compileOnce(plan: RunPlan, roles: Roles, operator: OperatorPlugins): CompiledPlan {
  let compiled: CompiledPlan;
  try {
    compiled = compilePlan(
      plan,
      {
        portfolio: roles.portfolio,
        marketSnapshot: roles.marketSnapshot,
        assumptionSets: roles.assumptionSets,
        policy: roles.policy,
        ...(roles.balancePlan !== undefined ? { balancePlan: roles.balancePlan } : {}),
        ...(roles.scenarioBalancePlans !== undefined ? { scenarioBalancePlans: roles.scenarioBalancePlans } : {}),
        ...(roles.indexHistories !== undefined ? { indexHistories: roles.indexHistories } : {}),
        libraries: SHIPPED_LIBRARIES,
        catalog: operator.catalog,
        pluginSources: operator.sources,
        patches: [],
      },
      STAMPS,
    );
  } catch (err) {
    throw compileRefusal(err);
  }
  // Nothing in this process runs the plan: the context is unwound here, as the validate route does.
  compiled.harness.dispose();
  return compiled;
}

/** What every compile of one setup row shares: the resolved roles, the basis and the plan for a given id. */
interface Prepared {
  roles: Roles;
  basis: NiiBasis;
  operator: OperatorPlugins;
  planFor: (planId: string) => RunPlan;
}

/**
 * Deviation D1 (recorded in the task report). The engine's derived default plan
 * (`defaultPlanFor`, built for plan-less requests that never meet the routing gate)
 * declares neither `selector.behavioralClasses` nor `feeds` on its behavioral stages,
 * and the routing gate's R1 refuses such a stage (`plan/routingGate.ts`), so a derived
 * plan over any set with bindings could never compile. Each derived behavioral stage
 * of a built-in kind therefore declares the class the engine itself maps that kind to
 * (`OVERLAY_KIND_TO_CLASS`, the table R4's coverage already reads) and feeds every
 * metric the workspace's routing policy routes that class to (anything but "none").
 * It declares no disposition, so R2 has nothing to check; R3 and R4 run as written.
 * `feeds` is read by the routing gate only, so no number depends on it. A stage of a
 * registered kind, or a class the policy does not list, is left as derived and the
 * gate refuses it by name.
 */
export function routableDerivedStages(stages: PlanStage[], policy: RoutingPolicy): PlanStage[] {
  const classes = OVERLAY_KIND_TO_CLASS as Record<string, BehavioralClassId | undefined>;
  return stages.map((s) => {
    if (s.kind !== "behavioral" || !s.id.startsWith("st-behavioral-")) return s;
    const cls = classes[s.id.slice("st-behavioral-".length)];
    const rule = cls === undefined ? undefined : policy.classes.find((c) => c.id === cls);
    if (cls === undefined || rule === undefined) return s;
    const feeds = policy.metrics.map((m) => m.id).filter((m) => rule.routing[m] !== undefined && rule.routing[m] !== "none");
    return { ...s, selector: { behavioralClasses: cls }, feeds };
  });
}

function prepare(ctx: PlatformContext, ws: WorkspaceManifest, slot: SetupSlot, setup: RunSetup, row: SetupRow | null): Prepared {
  const template = setup.plan;
  const scenarios = row?.scenarios ?? setup.scenarios;
  const basis = row?.basis ?? setup.nii.basis;
  const inputs: SetupInputs = { ...setup.inputs, assumptionSetIds: row?.assumptionSetIds ?? setup.inputs.assumptionSetIds };

  // 1 and 2.
  const roles = resolveRoles(ctx, ws, slot, inputs, scenarios, basis, template.scenarioBalancePlans);
  const operator = loadOperatorPlugins(pluginConfigPath(ctx.config.repoRoot));

  // 5. Stages.
  let stages: PlanStage[];
  if (template.stages === "derived-default") {
    const balanceStage = basis.kind !== "runoff" || Object.keys(template.scenarioBalancePlans ?? {}).length > 0;
    const derivation: RunRequest = {
      runId: "",
      portfolioId: roles.portfolio.id,
      marketSnapshot: roles.marketSnapshot,
      scenarios: [],
      assumptionSets: roles.assumptionSets,
      grid: { horizonMonths: setup.gridHorizonMonths, asOf: roles.portfolio.asOf },
      seed: "",
      timestamps: { startedAt: "", finishedAt: "" },
    };
    const behavioral = behavioralRegistryOf(template.profile, operator);
    try {
      stages = routableDerivedStages(
        defaultPlanFor(derivation, roles.portfolio, behavioral.registry, { balanceStage }).plan.stages,
        roles.policy,
      );
    } finally {
      behavioral.dispose();
    }
  } else {
    stages = template.stages;
  }
  // Slice three (spec decision 121): FTP off drops every stage that produces FtpResult, from a derived list or a
  // literal one. Nothing consumes FtpResult, so the walk is unaffected; `ftp` is never an engine option, so a run
  // cannot disagree with its plan.
  if (!setup.ftp.enabled) stages = stages.filter((s) => !s.produces.includes("FtpResult"));

  // 3, 4 and the plan. The derived plan's inputs, scenarios, reports, rules, planId and label
  // are the setup's own, so the plan is assembled from the setup with the stage list above.
  const planScenarioList = planScenarios(scenarios, roles.slate);
  const planFor = (planId: string): RunPlan => ({
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId,
    label: template.label,
    authoredBy: template.authoredBy,
    asOf: roles.portfolio.asOf,
    grid: { horizonMonths: setup.gridHorizonMonths },
    ...(template.note !== undefined ? { note: template.note } : {}),
    inputs: {
      marketSnapshot: roles.marketId,
      positionBook: roles.portfolio.id,
      routingPolicy: roles.policyId,
      assumptionSets: [...roles.setIds],
    },
    ...(template.profile !== undefined ? { profile: template.profile } : {}),
    ...(template.views !== undefined ? { views: template.views } : {}),
    stages,
    scenarios: planScenarioList,
    ...(basis.kind === "custom" ? { balancePlan: basis.balancePlanId } : {}),
    ...(basis.kind === "flat" ? { balanceBasis: flatBasisOf(basis) } : {}),
    ...(template.scenarioBalancePlans !== undefined ? { scenarioBalancePlans: template.scenarioBalancePlans } : {}),
    // The families' new-volume products, written only when the setup names any.
    ...(setup.nii.templates !== undefined && setup.nii.templates.length > 0 ? { newVolumeTemplates: setup.nii.templates.map((t) => ({ ...t })) } : {}),
    reports: template.reports,
    validationRules: template.validationRules,
  });
  return { roles, basis, operator, planFor };
}

/**
 * The plan a setup row compiles under a given planId, with its consumed pins, and no
 * compile: steps 1 to 5 only. The validate route shows it as the compiled
 * chain when the compile refuses, and the parity test reads it for a stored plan the
 * engine refuses today.
 */
export function assembleSetupPlan(
  ctx: PlatformContext,
  ws: WorkspaceManifest,
  slot: SetupSlot,
  setup: RunSetup,
  row: SetupRow | null,
  planId: string,
): { plan: RunPlan; consumed: ConsumedPins } {
  const prepared = prepare(ctx, ws, slot, setup, row);
  return { plan: prepared.planFor(planId), consumed: prepared.roles.consumed };
}

export function compileSetupRow(
  ctx: PlatformContext,
  _wsStore: WorkspaceStore,
  ws: WorkspaceManifest,
  slot: SetupSlot,
  setup: RunSetup,
  row: SetupRow | null,
): CompiledSetupRow {
  // Before any role is read: a stochastic EVE path is never compiled as a deterministic run (review C M1).
  assertDeterministicPath(setup);
  const { roles, basis, operator, planFor } = prepare(ctx, ws, slot, setup, row);

  // 6 and 7. An unedited import (the setup itself, never a batch row) keeps its planId.
  let planId: string;
  let compiled: CompiledPlan;
  if (row === null && setup.plan.planId !== null) {
    planId = setup.plan.planId;
    compiled = compileOnce(planFor(planId), roles, operator);
  } else {
    const pass1 = compileOnce(planFor(PENDING_PLAN_ID), roles, operator);
    const scenariosHash = contentHash(pass1.request.scenarios);
    planId = `ws-${sha256Hex(slot.setupLineageId).slice(0, 10)}-${scenariosHash.slice(0, 12)}`;
    compiled = compileOnce(planFor(planId), roles, operator);
    const again = contentHash(compiled.request.scenarios);
    if (again !== scenariosHash) {
      throw new HttpError(
        500,
        "internal",
        `setup compile: pass 2 resolved different scenarios from pass 1 (pass 1 ${scenariosHash}, pass 2 ${again}); scenario resolution must not read the planId`,
      );
    }
  }
  const planDocument = planFor(planId);

  // 7, the Slice 1 checks. (a) Under Flat or Custom, a scenario carrying its own runoff
  // strategy is refused; (b) under Runoff, an own dynamic strategy is named in the label;
  // (c) a Flat book with no eligible family is the compiler's own refusal, already a 422.
  const sources = basisSources(planDocument);
  if (basis.kind !== "runoff") {
    const own = sources.find((s) => s.source.kind === "scenario" && s.ownMode === "static");
    if (own !== undefined) {
      throw unprocessable(
        `scenario "${own.id}" carries its own runoff strategy; drop it from the slate or choose Runoff`,
        { field: "scenarios", scenarioId: own.id },
      );
    }
  }

  // 8.
  const basisByScenario: Record<string, BasisSource> = {};
  for (const s of sources) basisByScenario[s.id] = s.source;
  const instruments = instrumentResultsOfSetup(setup);

  return {
    planId,
    request: compiled.request,
    planDocument,
    consumed: roles.consumed,
    basisLabel: basisLabelOf(sources),
    basisByScenario,
    skippedFamilies: skippedFamiliesOf(compiled.notImplemented),
    warnings: warningsOf(setup),
    gates: compiled.gates,
    notImplemented: compiled.notImplemented,
    profileHash: compiled.profileHash,
    profile: compiled.profile,
    runLog: compiled.runLog,
    engineOptions: engineOptionsOfSetup(setup),
    ...(instruments !== undefined ? { instrumentResults: instruments } : {}),
  };
}

/**
 * The basis label of a stored run, read from the run's own record,
 * never from the setup: the compiled plan document when the run carries one, else the
 * request's own scenarios (a direct submission names each scenario's strategy).
 */
export function basisLabelOfRun(planDocument: RunPlan | undefined, scenarios: Array<{ id: string; newBusiness?: { mode: "static" | "dynamic" } }>): string {
  if (planDocument !== undefined) return basisLabelOf(basisSources(planDocument));
  return basisLabelOf(
    scenarios.map((s) => ({ id: s.id, source: { kind: "scenario" } as const, ownMode: s.newBusiness?.mode ?? "static" })),
  );
}

// ---------------------------------------------------------------------------
// The stochastic arm of the workspace launch
// ---------------------------------------------------------------------------

/** The base-only scenario a stochastic launch runs: no rate shock, static run-off (the engine refuses dynamic new business). */
export function stochasticBaseScenario(assumptionSetId: string): { id: string; label: string; rateSpec: { kind: "base" }; assumptionSetId: string; newBusiness: { mode: "static"; rules: [] } } {
  return { id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId, newBusiness: { mode: "static", rules: [] } };
}

/** What a stochastic launch submits, and the pins it consumed. */
export interface CompiledStochasticSetup {
  consumed: ConsumedPins;
  portfolioId: string;
  marketId: string;
  assumptionSetId: string;
  /** The setup's stochastic choice, verbatim: paths, seed, model, an override, a saved calibration. */
  stochastic: NonNullable<RunSetup["eve"]["stochastic"]>;
  /** Plain sentences the Run step and the launch reply carry (what this run does not read). */
  notes: string[];
}

/**
 * Compile a setup's stochastic choice (`eve.stochastic`) for the workspace launch. The roles resolve and hash as the
 * deterministic compile resolves them (book, the market block's pin, the one assumption set, the setup, any index
 * history the market's lagged indices read), with two differences, each said in a note: an active curve setup is not
 * applied (a stochastic run builds its curve from the snapshot's own quotes), and the NII basis, the new-volume
 * products and the opt-ins are not sent (a stochastic run is base-only static run-off, and the run route
 * refuses those on a stochastic run). The routing policy is not read and is not pinned.
 */
export function compileStochasticSetup(ctx: PlatformContext, ws: WorkspaceManifest, slot: SetupSlot, setup: RunSetup): CompiledStochasticSetup {
  const st = setup.eve.stochastic;
  if (st === undefined) {
    throw unprocessable("This setup asks for no stochastic run: choose one on the Simulation step (the model, the paths and the seed), then launch it.", { field: "eve.stochastic" });
  }
  const consumed: ConsumedPins = {};
  const pin = <T>(role: ConsumedRole, ref: DocRef): T => {
    consumed[role] = ref;
    return readPinned<T>(ctx, role, ref);
  };
  const { blocks } = ws;
  const inputs = setup.inputs;
  const bookRef =
    inputs.book.role === "base"
      ? blocks.positions.book ?? missing(`workspace "${ws.id}" has no position book; attach one to the positions block`, "inputs.book")
      : blocks.positions.retagged.find((r) => r.id === (inputs.book as { id: string }).id) ??
        missing(`retagged book "${(inputs.book as { id: string }).id}" is not in the positions block of workspace "${ws.id}"`, "inputs.book");
  const portfolio = pin<PortfolioSpec>("book", bookRef);
  let marketRef: DocRef;
  if (inputs.market.role === "base") {
    marketRef = blocks.market.snapshot ?? missing(`workspace "${ws.id}" has no market snapshot; attach one to the market block`, "inputs.market");
  } else {
    const key = inputs.market.definitionKey;
    marketRef = blocks.market.derived.find((d) => d.definitionKey === key) ?? missing(`derived market definition "${key}" is not in the market block of workspace "${ws.id}"`, "inputs.market");
  }
  const market = pin<MarketSnapshot>("market", marketRef);
  for (const id of indexHistoryIdsRead(portfolio, market)) consumed[`indexHistory:${id}`] = readIndexHistory(ctx.store, id).ref;
  let setId: string;
  if (Array.isArray(inputs.assumptionSetIds)) {
    if (inputs.assumptionSetIds.length !== 1) {
      throw unprocessable(`A stochastic run reads one assumption set, the base scenario's; this setup names ${inputs.assumptionSetIds.length}. Name one, or use the workspace default.`, { field: "inputs.assumptionSetIds" });
    }
    setId = inputs.assumptionSetIds[0]!;
  } else {
    const def = blocks.assumptions.defaultSetId;
    if (def === null) missing("attach an assumption set; the first attached becomes the default", "inputs.assumptionSetIds");
    setId = def;
  }
  const setRef = blocks.assumptions.sets.find((r) => r.id === setId) ?? missing(`assumption set "${setId}" is not in the assumptions block of workspace "${ws.id}"`, "inputs.assumptionSetIds");
  pin<AssumptionSet>(`set:${setId}`, setRef);
  consumed.setup = slot.current;
  // A saved calibration the choice names is a consumed pin like any document the run reads (its bytes, hashed now);
  // the run route checks its model, snapshot and curve and says why in one sentence.
  if (st.calibrationId !== undefined) {
    let bytes: Buffer;
    try {
      bytes = ctx.store.getDocumentBytes("calibrations", st.calibrationId);
    } catch (err) {
      if (err instanceof NotFoundError) throw unprocessable(`The saved calibration ${st.calibrationId} is not in the store: choose another on the Calibration step, or fit at run time.`, { field: "eve.stochastic.calibrationId" });
      throw err;
    }
    consumed.calibration = { collection: "calibrations", id: st.calibrationId, contentHash: sha256Hex(bytes), pinnedAt: new Date().toISOString() };
  }
  const notes = [
    "A stochastic run measures the base scenario only, and the positions run off on every path: the setup's balance sheet basis, its new-volume products and the forecast gap and going-concern views apply to the deterministic run.",
  ];
  if (readActiveCurveSetup(ctx.store, blocks.market) !== null) notes.push("A stochastic run builds its curve from the snapshot's own quotes; the edited curve variant applies to the deterministic run.");
  // The stochastic route takes no model convention; say so rather than leave it unsaid.
  if (setup.modelConvention === "corrected-v1") notes.push("A stochastic run keeps the original convention for the certificates of deposit and the SEG block; the corrections apply to the deterministic run.");
  return { consumed, portfolioId: bookRef.id, marketId: marketRef.id, assumptionSetId: setId, stochastic: st, notes };
}
