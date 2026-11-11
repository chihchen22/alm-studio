/**
 * Workspace readiness (Studio A+E spec v3.1 Section 3.5; contract 14; plan Task C4).
 *
 * One function builds every row of the Section 3.5 table, in order, from the head, the
 * file store and the `setups.ndjson` and `runs.ndjson` files. The readiness route, the
 * validate route, the launch gate and the clone reply all read it, so the chips and the
 * Launch button agree.
 *
 * States, worst first: Error, Not set on a required item, Stale, Warning, Draft, Valid.
 * A section chip is the worst state among its counted items; an optional item that is
 * Not set never counts. When a section has no counted item its chip is Not set if any
 * optional item is Not set (nothing there yet) and Valid otherwise.
 *
 * Stale, exactly. A validation line (and a launched run) recorded the pins it consumed,
 * a map from role to DocRef. The item is Stale when, for any recorded role, the pinned
 * contentHash differs from the hash the workspace holds in that role NOW, or the role is
 * empty now. "Now" is resolved from the head alone (no bytes are read for it): the role
 * lookup mirrors the setup compile's own (`resolveRoles` in setupCompile.ts), so a
 * validation made at the head's pins is never Stale against that same head. Documents
 * in no consumed role never stale anything, and `blockHashes` are not read here. One exception
 * reads bytes: under an active curve setup the market role is the derived market
 * the compile pins the setup into, so its id and hash are derived from the stored base and setup
 * documents exactly as the compile derives them (`curvePinOf`), and the setup is the `curveSetup` role.
 * Piece B, step B2 extends the same read: saved derived curves an index of that market names join the
 * derive (`marketPinOf`), each in its `derivedCurve:<curve id>` role, and the rate indices item checks
 * the market so pinned, so a missing curve or a curve on another base reads Error before launch.
 * Piece B, step B3b adds the `indexHistory:<id>` roles: each index history a lagged formula of the pinned
 * market's read closure reads (the engine's indexHistoryIdsRead), as the compile pins them. Their current hash is the
 * hash of the stored bytes, re-read here (one file read per history per report), not the meta's, so a history whose
 * document is gone, or whose bytes were overwritten in place, reads Stale in its role. The rates item checks the market
 * with the stored histories it reads, warns where a history stops short of a month a lag reads, and otherwise prints
 * each history's reading at the cut-off (historyReadingText, the results note's own clause).
 * The rates item also warns, acknowledgeably, where a derived curve an index
 * of the pinned market names was estimated on a platform default version other than the one that market builds
 * (derivedCurveDefaultText). Nothing is changed by it.
 * The Curves item says the base curve "builds", and its Valid text
 * names the default it builds on in the run's curve-line words (baseCurveBuildsText): the marker, the reason of a
 * fallback to version 1, or the sub-month quotes version 2 leaves out. That text is informational: nothing is asked
 * of the user. Under an active curve setup the market the launch pins is built as the run builds it, so a
 * curveDefault marker the engine refuses reads Error here and blocks the launch, rather than failing the run.
 * A workspace a registered curve readiness rule applies to (src/registry.ts) reads the Curves
 * item Error, and blocks the launch, when the rule refuses the curve default stamp of the market the launch pins.
 *
 * The launch list. `launchable[slot]` carries, for the market, balance, assumptions and
 * run sections only, the items that block (Error, or Not set on a required item, and a
 * Stale item on a Production workspace: the month a sign-off will bind launches only on
 * the pins it validated) and the items that can be acknowledged (Stale, Warning), each as
 * "<section>/<item>". One documented exception to that rule (review C m4): the Run setups
 * item does not read "run/Run setups". It keeps the id "run/setups" the launch route shipped
 * with (and Group B and C tests assert) when it is Error, Not set or Stale, and reads
 * "run/setup-warnings" when it is Warning, the id the launch route also files the compile's
 * own warnings under, so acknowledging a warning never acknowledges staleness (review C m2).
 * Group E's acknowledge list uses these two ids as they stand. A setup whose EVE settings ask
 * for the stochastic path reads Error with the compile's refusal text (review C M1).
 * Results and Govern report on outputs and on the sign-off, never on whether
 * the next launch may start. A Draft item blocks nothing: the compile at launch is the
 * validation that matters.
 *
 * The function never throws for a document it cannot read: that item reads Error with the
 * reason, because a status page that 500s on a damaged pin is no status page.
 */
import {
  checkBindingOverlap,
  estimatedOnDefaultOf,
  historyReadingText,
  indexHistoryIdsRead,
  indexHistoryReadings,
  SHIPPED_LIBRARIES,
  type AssumptionSet,
  type BalancePlan,
  type IndexHistoryReading,
  type MarketWithDerivedCurves,
  type PlanScenarioRef,
  type PortfolioSpec,
} from "@alm/engine";
import { lowerBalancePlan } from "@alm/engine/src/plan/lowerBalancePlan";
import { checkRateIndexRefs } from "@alm/engine/src/rateIndex/resolve";
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import { curveDefaultOf, curveDefaultStampOf, resolveAssumptions } from "@alm/engine/src/scenario";
import { defaultSetupFromSnapshot } from "@alm/engine/src/curveBuilder";
import { validateCurveSetup, type CurveSetupBlock } from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";
import type { PlatformContext } from "../context";
import { approvalState, type ApprovalRecord } from "../approvals/approvals";
import type { RunStatus, StoredRunRequest } from "../jobs/types";
import { loadOperatorPlugins, pluginConfigPath } from "../plugins/load";
import { serializeDocument, sha256Hex, type FileStore } from "../store/store";
import { HttpError } from "../http/errors";
import { CURVE_DEFAULT_V1_TEXT, CURVE_DEFAULT_V2_TEXT, curveLineOf } from "../export/curveLine";
import {
  activeCurveSetupOf,
  buildBaseCurveNamed,
  buildRefusalsOf,
  curvePinOf,
  CURVE_SETUP_ON_MARKET,
  readActiveCurveSetup,
} from "./curveSetupSlot";
import { curveReadinessRulesFor } from "../registry";
import { derivedCurveRefOf, marketPinOf, namedCurveIdsOf, readDerivedCurve } from "./derivedCurveSlot";
import { storedIndexHistories } from "./indexHistoryPins";
import { behavioralRegistryOf, STOCHASTIC_PATH_REFUSAL } from "./setupCompile";
import type {
  ConsumedPins,
  ConsumedRole,
  DocRef,
  NiiBasis,
  RunSetup,
  SetupEvent,
  SetupInputs,
  SetupScenarios,
  SetupSlot,
  WorkspaceManifest,
} from "./types";
import type { WorkspaceStore } from "./workspaceStore";

// ---------------------------------------------------------------------------
// The public shapes (plan Shared interfaces)
// ---------------------------------------------------------------------------

export type ReadinessState = "not-set" | "draft" | "valid" | "warning" | "error" | "stale";
export type SectionId = "workspace" | "market" | "balance" | "assumptions" | "run" | "results" | "govern";

export interface StaleRole {
  role: string;
  pinned: string;
  current: string | null;
}

export interface ReadinessItem {
  section: SectionId;
  item: string;
  state: ReadinessState;
  required: boolean;
  detail: string;
  staleRoles?: StaleRole[];
}

export interface ReadinessReport {
  items: ReadinessItem[];
  sections: Record<SectionId, ReadinessState>;
  launchable: Record<string, { ok: boolean; blocking: string[]; acknowledgeable: string[] }>;
}

/** The report plus what the launch route reads and the report's shape does not carry. */
export interface ReadinessDetail {
  report: ReadinessReport;
  /** Per slot: the roles whose newest validated pin differs from the workspace's current role, whatever the item state. */
  staleBySlot: Record<string, StaleRole[]>;
  /** Per slot: the one-sentence reason each blocking or acknowledgeable id carries, for a refusal message. */
  reasonById: Record<string, Record<string, string>>;
}

/** The Run setups item's id when it blocks or is Stale; the id the launch route shipped with (an exception to "<section>/<item>"). */
export const RUN_SETUPS_ITEM = "run/setups";

/**
 * The id a setup's warnings are acknowledged under: the compile's own warnings at launch, and the
 * Run setups item when its newest validation passed with warnings. Kept apart from RUN_SETUPS_ITEM so
 * acknowledging the standing interim-band note never acknowledges staleness (review C m2).
 */
export const RUN_SETUP_WARNINGS_ITEM = "run/setup-warnings";

export const SECTION_IDS: readonly SectionId[] = ["workspace", "market", "balance", "assumptions", "run", "results", "govern"];

/**
 * The id of an item in a `launchable` list: "<section>/<item>", except the Run setups item, which
 * keeps the shipped ids: RUN_SETUPS_ITEM, or RUN_SETUP_WARNINGS_ITEM when its state is Warning.
 */
export function itemIdOf(section: SectionId, item: string, state?: ReadinessState): string {
  if (section === "run" && item === "Run setups") return state === "warning" ? RUN_SETUP_WARNINGS_ITEM : RUN_SETUPS_ITEM;
  return `${section}/${item}`;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const RANK: Record<ReadinessState, number> = { error: 0, "not-set": 1, stale: 2, warning: 3, draft: 4, valid: 5 };

interface Res {
  state: ReadinessState;
  required: boolean;
  detail: string;
  staleRoles?: StaleRole[];
}

const res = (state: ReadinessState, required: boolean, detail: string, staleRoles?: StaleRole[]): Res => ({
  state,
  required,
  detail,
  ...(staleRoles !== undefined && staleRoles.length > 0 ? { staleRoles } : {}),
});

/** An optional Not set loses to everything when results are merged: it says "nothing there", not "something wrong". */
const priority = (r: Res): number => (r.state === "not-set" && !r.required ? 6 : RANK[r.state]);

const counts = (r: { state: ReadinessState; required: boolean }): boolean => !(r.state === "not-set" && !r.required);

function worst(list: Res[]): Res {
  let best = list[0]!;
  for (const r of list) if (priority(r) < priority(best)) best = r;
  return best;
}

/** One item over several setups: the worst state wins; the detail names the setups sharing that state. */
function merge(parts: Array<{ label: string; r: Res }>): Res {
  if (parts.length === 1) return parts[0]!.r;
  const top = worst(parts.map((p) => p.r));
  const same = parts.filter((p) => p.r.state === top.state);
  const detail = same.length === parts.length && new Set(same.map((p) => p.r.detail)).size === 1
    ? top.detail
    : same.map((p) => `${p.label}: ${p.r.detail}`).join(" ");
  const roles = parts.flatMap((p) => p.r.staleRoles ?? []);
  return res(top.state, parts.some((p) => p.r.required), detail, roles);
}

// ---------------------------------------------------------------------------
// Pinned documents
// ---------------------------------------------------------------------------

type Loaded<T> = { where: "live"; doc: T } | { where: "superseded"; doc: T; stamp: string } | { where: "missing" };

/** Every DocRef is resolved by id and hash: the live document first, then superseded/ (`findPinned`). One parse per pin. */
class PinnedDocs {
  private readonly cache = new Map<string, Loaded<unknown>>();
  constructor(private readonly store: FileStore) {}

  get<T>(ref: DocRef): Loaded<T> {
    const key = `${ref.collection}/${ref.id}/${ref.contentHash}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit as Loaded<T>;
    let out: Loaded<unknown>;
    try {
      const found = this.store.findPinned(ref.collection, ref.id, ref.contentHash);
      if (found === null) out = { where: "missing" };
      else {
        const doc = JSON.parse(found.bytes.toString("utf8")) as unknown;
        out = found.where === "live" ? { where: "live", doc } : { where: "superseded", doc, stamp: found.stamp ?? "" };
      }
    } catch {
      out = { where: "missing" };
    }
    this.cache.set(key, out);
    return out as Loaded<T>;
  }
}

/** The pin's problem as a sentence, or null when the live bytes are there. */
function pinProblem(ref: DocRef, l: Loaded<unknown>): string | null {
  if (l.where === "live") return null;
  if (l.where === "superseded") {
    return `pinned bytes of ${ref.collection} "${ref.id}" were superseded on ${l.stamp}; re-pin to the current document or keep this workspace as history`;
  }
  return `the pin on ${ref.collection} "${ref.id}" is unresolved: no stored bytes hash to ${ref.contentHash.slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Setups: slot views and head-only role resolution
// ---------------------------------------------------------------------------

interface Row {
  label: string;
  scenarios: SetupScenarios;
  assumptionSetIds: SetupInputs["assumptionSetIds"];
  basis: NiiBasis;
}

interface SlotView {
  /** null for the view a workspace with no setup slot is read through. */
  slot: SetupSlot | null;
  name: string;
  setup: RunSetup | null;
  /** Why the setup document cannot be read, when it cannot. */
  problem: string | null;
  inputs: SetupInputs;
  rows: Row[];
  scenarioBalancePlans: Record<string, string>;
  stochastic: boolean;
  gridHorizonMonths: number;
}

const BASE_INPUTS: SetupInputs = { book: { role: "base" }, market: { role: "base" }, assumptionSetIds: { kind: "block-default" } };

function rowsOf(setup: RunSetup): Row[] {
  return [
    { label: setup.name, scenarios: setup.scenarios, assumptionSetIds: setup.inputs.assumptionSetIds, basis: setup.nii.basis },
    ...setup.batch.map((b) => ({ label: b.label, scenarios: b.scenarios, assumptionSetIds: b.assumptionSetIds, basis: b.basis })),
  ];
}

function slotViewOf(docs: PinnedDocs, slot: SetupSlot): SlotView {
  const l = docs.get<RunSetup>(slot.current);
  if (l.where === "missing") {
    return {
      slot,
      name: slot.setupLineageId,
      setup: null,
      problem: `the slot's setup document "${slot.current.id}" cannot be read: no stored bytes hash to its pin`,
      inputs: BASE_INPUTS,
      rows: [],
      scenarioBalancePlans: {},
      stochastic: false,
      gridHorizonMonths: 360,
    };
  }
  const setup = l.doc;
  return {
    slot,
    name: setup.name,
    setup,
    problem: null,
    inputs: setup.inputs,
    rows: rowsOf(setup),
    scenarioBalancePlans: setup.plan.scenarioBalancePlans ?? {},
    stochastic: setup.eve.path === "stochastic",
    gridHorizonMonths: setup.gridHorizonMonths,
  };
}

/**
 * The refs the head holds in each role for one setup row, with no bytes read. Mirrors the compile's
 * `resolveRoles`; a role the head cannot resolve is absent (the validated pin then reads Stale with
 * a null current), never an error.
 */
/**
 * The market, curveSetup and derivedCurve roles of the launch pin (steps B1 and B2), as the
 * compile resolves them: given the market the setup's inputs name, the derived market the active setup
 * and the saved curves its indices name are pinned into (or that market itself when it already carries
 * them). Null when no setup is active and the market names no saved curve, so the caller keeps the head's
 * own market pin. A role it cannot resolve is null (the validated pin then reads Stale). `snapshot` is the
 * pinned market's content, for the rate index check; `error` is the sentence a pin refusal carries.
 */
interface PinView {
  market: DocRef | null;
  snapshot: MarketSnapshot | null;
  curveSetup: DocRef | null;
  derivedCurves: Array<[string, DocRef]>;
  error?: string;
}
type CurveRoles = (market: DocRef | null) => PinView | null;
/**
 * The `indexHistory:<id>` roles of the launch pin, as the compile resolves them (resolveRoles): each
 * history a lagged formula of the book's read closure reads on the market the launch pins, with the hash of its stored
 * bytes now. A history whose document is gone is left out, so its validated pin reads Stale with no current hash.
 */
type HistoryRoles = (book: DocRef | null, market: DocRef | null) => Array<[string, DocRef]>;

function roleRefs(ws: WorkspaceManifest, setup: RunSetup, slot: SetupSlot, row: Row | null, curveRoles: CurveRoles, historyRoles: HistoryRoles): ConsumedPins {
  const out: ConsumedPins = {};
  const { blocks } = ws;
  const inputs = setup.inputs;
  const scenarios = row?.scenarios ?? setup.scenarios;
  const basis = row?.basis ?? setup.nii.basis;
  const setIds = row?.assumptionSetIds ?? inputs.assumptionSetIds;

  const book = inputs.book.role === "base" ? blocks.positions.book : blocks.positions.retagged.find((r) => r.id === (inputs.book as { id: string }).id) ?? null;
  if (book !== null) out.book = book;
  const market =
    inputs.market.role === "base"
      ? blocks.market.snapshot
      : blocks.market.derived.find((d) => d.definitionKey === (inputs.market as { definitionKey: string }).definitionKey) ?? null;
  const curve = curveRoles(market);
  if (curve === null) {
    if (market !== null) out.market = market;
  } else {
    if (curve.market !== null) out.market = curve.market;
    if (curve.curveSetup !== null) out.curveSetup = curve.curveSetup;
    for (const [curveId, ref] of curve.derivedCurves) out[`derivedCurve:${curveId}`] = ref;
  }
  for (const [historyId, ref] of historyRoles(book, market)) out[`indexHistory:${historyId}`] = ref;
  if (blocks.assumptions.routingPolicy !== null) out.routingPolicy = blocks.assumptions.routingPolicy;

  const ids = Array.isArray(setIds) ? setIds : blocks.assumptions.defaultSetId === null ? [] : [blocks.assumptions.defaultSetId];
  for (const id of ids) {
    const ref = blocks.assumptions.sets.find((r) => r.id === id);
    if (ref !== undefined) out[`set:${id}` as ConsumedRole] = ref;
  }
  if (scenarios.kind === "slate") {
    const ref = blocks.scenarios.slates.find((r) => r.id === scenarios.slateId);
    if (ref !== undefined) out.slate = ref;
  }
  if (basis.kind === "custom") {
    const ref = blocks.targets.balancePlans.find((r) => r.id === basis.balancePlanId);
    if (ref !== undefined) out.balancePlan = ref;
  }
  for (const [scenarioId, planId] of Object.entries(setup.plan.scenarioBalancePlans ?? {})) {
    const ref = blocks.targets.balancePlans.find((r) => r.id === planId);
    if (ref !== undefined) out[`balancePlan:${scenarioId}` as ConsumedRole] = ref;
  }
  out.setup = slot.current;
  return out;
}

function staleRolesOf(pinned: ConsumedPins, current: (role: ConsumedRole, ref: DocRef) => string | null): StaleRole[] {
  const out: StaleRole[] = [];
  for (const [role, ref] of Object.entries(pinned) as Array<[ConsumedRole, DocRef]>) {
    const now = current(role, ref);
    if (now !== ref.contentHash) out.push({ role, pinned: ref.contentHash, current: now });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The computation
// ---------------------------------------------------------------------------

const LAUNCH_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>(["market", "balance", "assumptions", "run"]);

const WORKSPACE_ITEMS: ReadonlyArray<readonly [SectionId, string]> = [
  ["market", "Base snapshot"],
  ["market", "Curves"],
  ["market", "Vol surface"],
  ["market", "Rate indices and derived markets"],
  ["balance", "Positions"],
  ["balance", "Chart of accounts"],
  ["balance", "Strategy"],
  ["assumptions", "Sets"],
  ["assumptions", "Routing policy"],
  ["assumptions", "Mapping"],
  ["run", "Scenarios"],
  ["run", "Run setups"],
  ["results", "Newest result"],
  ["govern", "Sign-off"],
];

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The engine's derived curve problems (rateIndex/resolve.ts, Piece B step B2), told apart from its index
 * problems by their own wording: the curve is missing (`rate index "<i>" reads derived curve "<c>", which
 * <market> does not carry`), built on another base (`..., built on "<b>", but the run's curve is "<r>"`),
 * or the market's derivedCurves block is unreadable. The engine reports these only when every index a
 * position reads resolves.
 */
const BASE_MISMATCH = ", but the run's curve is ";
const DERIVED_BLOCK_UNREADABLE = " carries a derivedCurves block the run cannot read: ";
const isDerivedCurveProblem = (p: string): boolean =>
  (p.startsWith("rate index ") && p.includes(" reads derived curve ")) || p.includes(DERIVED_BLOCK_UNREADABLE);
/**
 * The engine's index history problems (rateIndex/resolve.ts, Piece B step B3b): a lagged formula's parent names a
 * history the run was not given (`..., which reads index history "<id>", and the run was not given that history`), or
 * a given history is unreadable or does not hash to its id (`index history "<id>" given to the run ...`); these take
 * the import hint. The same head with `, but <market> carries no readable calibrationDate ...` is a market problem:
 * the history is fine and the market cannot date the months before the cut-off, so the hint points at the market
 * (B3b follow-up item 1). Null for a problem that is not about a history.
 */
const HISTORY_READ = ", which reads index history ";
const MARKET_UNDATED = " carries no readable calibrationDate to date the months before the cut-off";
export function indexHistoryProblemHint(p: string): string | null {
  if (p.includes(HISTORY_READ) && p.includes(MARKET_UNDATED)) {
    return " The months before the cut-off are dated by the market's calibration date, so the history is not the fix: attach a base snapshot with a readable calibration date on Market > Yield curves and derive the market again on Market > Rate indices.";
  }
  if (p.includes(HISTORY_READ) || p.startsWith("index history ")) return " Import the history again on Market > Rate indices.";
  return null;
}

const ACK_CLOSE = " Acknowledge the warning to launch, or import a longer history on Market > Rate indices.";
/**
 * The rates item's Warning where a history stops short of a month a lag reads (decisions 49 and 52; B3b follow-up
 * item 2): each reading's clause, then what the flat months read, said only for the cases the readings hold. A month
 * after a history's last month reads the cut-off value (flatAfter of a history that starts before the cut-off); a
 * month before its first month reads its first value (flatBefore, ruling D3); a history that starts at or after the
 * cut-off fills nothing before it (no look-ahead), so its flatAfter months read the cut-off value too.
 */
export function historyShortText(short: readonly IndexHistoryReading[]): string {
  const starts = (r: IndexHistoryReading): boolean => r.firstMonth < r.asOfMonth;
  const parts: string[] = [];
  if (short.some((r) => starts(r) && r.flatAfter > 0)) parts.push("months after a history's last month read the index's cut-off value on the unshocked curve");
  if (short.some((r) => starts(r) && r.flatBefore > 0)) parts.push("months before a history's first month read its first value");
  if (short.some((r) => !starts(r) && r.flatAfter > 0)) {
    parts.push("a history that starts at or after the cut-off fills nothing before it (no look-ahead), so every month a lag reads before the cut-off reads the index's cut-off value on the unshocked curve");
  }
  const said = parts.join("; ");
  const explain = said === "" ? "" : ` ${said[0]!.toUpperCase()}${said.slice(1)}.`;
  return `An index history stops short of a month a lag reads: ${short.map(historyReadingText).join("; ")}.${explain}${ACK_CLOSE}`;
}

const DEFAULT_CLOSE = " Nothing was changed: acknowledge the warning to launch on the saved spreads, or fill the curve again on Market > Derived curves and save it.";
/**
 * The rates item's Warning where a derived curve an index of the run's market names was estimated on a platform
 * default curve version other than the one the run's market builds: the curve's
 * estimatedOnDefaultOf (its stamp; 1 when its source names platform-default and it carries none) against
 * curveDefaultOf of the market the launch pins. A typed grid, or a source of two curve setups, is never named.
 * Null when every curve agrees, when no index names a curve, or when the market's marker is one the engine
 * refuses (the launch refuses that in its own words). Nothing is changed: the run reads the saved spreads.
 */
export function derivedCurveDefaultText(market: MarketSnapshot): string | null {
  const named = new Set(namedCurveIdsOf(market));
  if (named.size === 0) return null;
  let runDefault: 1 | 2;
  try {
    runDefault = curveDefaultOf(market);
  } catch {
    return null;
  }
  const clauses: string[] = [];
  for (const curve of (market as MarketWithDerivedCurves).derivedCurves ?? []) {
    if (!named.has(curve.id)) continue;
    const on = estimatedOnDefaultOf(curve);
    if (on !== null && on !== runDefault) clauses.push(`derived curve ${JSON.stringify(curve.id)} was estimated on platform default v${on}`);
  }
  if (clauses.length === 0) return null;
  const said = clauses.join("; ");
  return `${said[0]!.toUpperCase()}${said.slice(1)}; the run's default is v${runDefault}.${DEFAULT_CLOSE}`;
}

/**
 * The Valid text of the Curves item for a base snapshot that builds:
 * the default it builds on, in the words of the run's curve line (export/curveLine.ts), plus
 *   - for a market marked `curveDefault: 1`, that it is marked;
 *   - for a fallback to version 1, the reason the version 2 default cannot take the snapshot;
 *   - for version 2, the sub-month quotes the default leaves out, by term.
 * Informational, not a Warning: the market runs as it is, and no acknowledgement is asked. The caller has
 * just built the snapshot through buildBaseCurveNamed, so the stamp does not throw here.
 */
export function baseCurveBuildsText(snapshot: MarketSnapshot): string {
  const stamp = curveDefaultStampOf(snapshot);
  const lead = "The base curve builds from the snapshot: ";
  if (stamp.kind === "setup") return `${lead}${curveLineOf(stamp, snapshot).value}.`;
  if (stamp.version === 1) {
    if (stamp.reason === undefined) return `${lead}${CURVE_DEFAULT_V1_TEXT} (the market is marked curveDefault: 1).`;
    return `${lead}${CURVE_DEFAULT_V1_TEXT}. Platform default v2 cannot take this snapshot, so the build falls back to v1: ${stamp.reason}.`;
  }
  const filled = defaultSetupFromSnapshot(snapshot);
  const dropped = filled.ok ? filled.dropped : [];
  const left =
    dropped.length === 0
      ? ""
      : ` The default leaves out the sub-month ${dropped.length === 1 ? "quote" : "quotes"} ${dropped.join(", ")}: it takes whole months only, so the short end reads flat at the first month.`;
  return `${lead}${CURVE_DEFAULT_V2_TEXT}.${left}`;
}

/** An item that could not be computed reads Error with the reason; it never takes the report down. */
function guarded(required: boolean, name: string, fn: () => Res): Res {
  try {
    return fn();
  } catch (err) {
    return res("error", required, `${name} could not be checked: ${messageOf(err)}`);
  }
}

export function computeReadiness(ws: WorkspaceManifest, ctx: PlatformContext, wsStore: WorkspaceStore): ReadinessReport {
  return computeReadinessDetail(ws, ctx, wsStore).report;
}

export function computeReadinessDetail(ws: WorkspaceManifest, ctx: PlatformContext, wsStore: WorkspaceStore): ReadinessDetail {
  const { store } = ctx;
  const docs = new PinnedDocs(store);
  const { blocks } = ws;
  const events = wsStore.readSetupEvents(ws.id);
  const views: SlotView[] = blocks.run.setups.map((s) => slotViewOf(docs, s));
  // A workspace with no slot is read through one virtual view on the block default, so the shared items still evaluate.
  const checkViews: SlotView[] =
    views.length > 0
      ? views
      : [{ slot: null, name: "(no run setup)", setup: null, problem: null, inputs: BASE_INPUTS, rows: [{ label: "(none)", scenarios: { kind: "library", refs: [] }, assumptionSetIds: { kind: "block-default" }, basis: { kind: "flat", termMonths: 60, spreadOverIndexBp: 0 } }], scenarioBalancePlans: {}, stochastic: false, gridHorizonMonths: 360 }];

  // ---- workspace-level documents --------------------------------------------------

  const snapshotRef = blocks.market.snapshot;
  const snapshot = snapshotRef === null ? null : docs.get<MarketSnapshot>(snapshotRef);
  const bookRefOf = (v: SlotView): DocRef | null =>
    v.inputs.book.role === "base" ? blocks.positions.book : blocks.positions.retagged.find((r) => r.id === (v.inputs.book as { id: string }).id) ?? null;
  const bookOf = (v: SlotView): Loaded<PortfolioSpec> | null => {
    const ref = bookRefOf(v);
    return ref === null ? null : docs.get<PortfolioSpec>(ref);
  };

  // Piece B, steps B1 and B2: the pin roles the compile would consume, derived once per market (the
  // active setup and the curve slots are fixed for this head). The setup and the curves are read and the
  // market derived exactly as the compile's pinMarket does (marketPinOf), with nothing stored.
  const pinViews = new Map<string, PinView | null>();
  const curveRoles: CurveRoles = (market) => {
    const active = activeCurveSetupOf(blocks.market);
    const setupRef = active !== null && active.ref !== null && active.ref.collection === "curve-setups" ? active.ref : null;
    if (market === null) return active === null ? null : { market: null, snapshot: null, curveSetup: setupRef, derivedCurves: [] };
    const key = `${market.id}/${market.contentHash}`;
    if (!pinViews.has(key)) {
      const base = docs.get<MarketSnapshot>(market);
      const named = base.where === "live" ? namedCurveIdsOf(base.doc) : [];
      const derivedCurves = named
        .map((curveId): [string, DocRef | null] => [curveId, derivedCurveRefOf(blocks.market, curveId)])
        .filter((e): e is [string, DocRef] => e[1] !== null);
      let view: PinView | null;
      if (active === null && derivedCurves.length === 0) view = null;
      else {
        view = { market: null, snapshot: null, curveSetup: setupRef, derivedCurves };
        if ((active === null || setupRef !== null) && base.where === "live") {
          let setup: CurveSetupBlock | null = null;
          let readable = true;
          if (setupRef !== null) {
            const setupDoc = docs.get<unknown>(setupRef);
            const checked = setupDoc.where === "live" ? validateCurveSetup(setupDoc.doc) : null;
            if (checked !== null && checked.ok) setup = checked.block;
            else readable = false;
          }
          if (readable) {
            try {
              const curves = derivedCurves.map(([curveId]) => readDerivedCurve(store, blocks.market, curveId)!.block);
              const r = marketPinOf(base.doc, market.id, setup, curves);
              view.market = r === null ? market : { collection: "market", id: r.id, contentHash: sha256Hex(serializeDocument(r.snapshot)), pinnedAt: "" };
              view.snapshot = r === null ? base.doc : r.snapshot;
            } catch (err) {
              view.error = messageOf(err);
            }
          }
        }
      }
      pinViews.set(key, view);
    }
    return pinViews.get(key)!;
  };

  // The hash of a history's stored bytes now (re-read, not the meta's: plan v2 N7), once per report.
  const historyHashes = new Map<string, string | null>();
  const historyHashNow = (id: string): string | null => {
    if (!historyHashes.has(id)) historyHashes.set(id, store.has("index-histories", id) ? sha256Hex(store.getDocumentBytes("index-histories", id)) : null);
    return historyHashes.get(id)!;
  };
  const historyViews = new Map<string, Array<[string, DocRef]>>();
  const historyRoles: HistoryRoles = (book, market) => {
    if (book === null || market === null) return [];
    const key = `${book.id}/${book.contentHash}|${market.id}/${market.contentHash}`;
    let out = historyViews.get(key);
    if (out === undefined) {
      out = [];
      const portfolio = docs.get<PortfolioSpec>(book);
      const pin = curveRoles(market);
      const own = pin === null ? docs.get<MarketSnapshot>(market) : null;
      const snapshot = pin !== null ? pin.snapshot : own!.where === "live" ? own!.doc : null;
      if (portfolio.where === "live" && snapshot !== null) {
        for (const id of indexHistoryIdsRead(portfolio.doc, snapshot)) {
          const hash = historyHashNow(id);
          if (hash !== null) out.push([id, { collection: "index-histories", id, contentHash: hash, pinnedAt: "" }]);
        }
      }
      historyViews.set(key, out);
    }
    return out;
  };

  // ---- Market -----------------------------------------------------------------

  const baseSnapshot = (): Res => {
    if (snapshotRef === null) return res("not-set", true, "No base market snapshot. Attach a stored snapshot on Market > Yield curves.");
    const problem = pinProblem(snapshotRef, snapshot!);
    if (problem !== null) return res("error", true, `Base snapshot: ${problem}.`);
    const date = (snapshot as { doc: MarketSnapshot }).doc.calibrationDate;
    if (date === ws.cutoffDate) return res("valid", true, `Snapshot "${snapshotRef.id}" is dated at the cut-off, ${date}.`);
    const recorded = ws.clashes.some((c) => c.block === "market" && c.id === snapshotRef.id);
    return res("warning", true, `Snapshot "${snapshotRef.id}" is dated ${date}, cut-off is ${ws.cutoffDate}${recorded ? "; the clash is recorded" : ""}.`);
  };

  const curvesBuild = (): Res => {
    // An active curve setup is the curve a launch runs on. A pointer to a document
    // that is not in the store is an Error with its own sentence; it never falls back to the snapshot.
    if (activeCurveSetupOf(blocks.market) !== null) {
      let active: ReturnType<typeof readActiveCurveSetup>;
      try {
        active = readActiveCurveSetup(store, blocks.market);
      } catch (err) {
        return res("error", true, messageOf(err));
      }
      const { ref, block } = active!;
      const refusals = buildRefusalsOf(block);
      if (refusals.length > 0) return res("error", true, `${CURVE_SETUP_ON_MARKET}${refusals.join("; ")}`);
      // The setup is pinned into the base market at launch, so with no base snapshot it cannot be used
      // yet. Not set and not required here: the Base snapshot item is the one that blocks.
      if (snapshotRef === null) {
        return res("not-set", false, `The active curve setup "${block.label}" (${ref.id}) needs a base market snapshot before it can be used. Attach a stored snapshot on Market > Yield curves.`);
      }
      // A pinned snapshot that is missing or superseded reads as the legacy branch below does: Not set, not required
      // (the Base snapshot item names the pin problem and blocks).
      if (snapshot === null || snapshot.where !== "live") {
        return res("not-set", false, `The active curve setup "${block.label}" (${ref.id}) needs a readable base market snapshot before it can be used.`);
      }
      try {
        // B4 Task 8 (Task 3a review minor 3): the pinned market keeps the base's curveDefault marker, and the
        // run's build refuses a marker other than 1 even under a block, so the market the launch pins is built
        // here as the run builds it. Readiness and the launch then agree: an Error here blocks the launch.
        const pinned = curvePinOf(snapshot.doc, snapshotRef.id, block);
        buildBaseCurveNamed(pinned === null ? snapshot.doc : pinned.snapshot);
      } catch (err) {
        return res("error", true, messageOf(err));
      }
      return res("valid", true, `The active curve setup "${block.label}" (${ref.id}) builds the base curve: ${block.interpolation}, ${block.inputs.length} rows.`);
    }
    if (snapshotRef === null || snapshot === null || snapshot.where !== "live") {
      return res("not-set", false, "Waits for a readable base snapshot.");
    }
    try {
      buildBaseCurveNamed(snapshot.doc);
    } catch (err) {
      // Every refusal reads with a named prefix, chosen by the route that refused (curveSetupSlot.ts curvePrefixOf):
      // the curveDefault marker, the curve setup (Task 8 ruling 6), curve default version 1, or the platform
      // default. The last line is a net.
      if (err instanceof HttpError) return res("error", true, err.message);
      return res("error", true, `The base curve does not build: ${messageOf(err)}`);
    }
    return res("valid", true, baseCurveBuildsText(snapshot.doc));
  };

  // A registered curve readiness rule may hold a workspace to one curve default stamp. A market
  // that builds, but on a stamp the rule refuses, reads Error with the rule's text, and the Error blocks every launch.
  // A workspace no rule applies to: unchanged.
  const curves = (): Res => {
    const built = curvesBuild();
    const rules = curveReadinessRulesFor(ws.id);
    if (built.state !== "valid" || rules.length === 0 || snapshotRef === null || snapshot === null || snapshot.where !== "live") return built;
    const active = readActiveCurveSetup(store, blocks.market);
    const pinned = active === null ? null : curvePinOf(snapshot.doc, snapshotRef.id, active.block);
    const launched = pinned === null ? snapshot.doc : pinned.snapshot;
    const stamp = curveDefaultStampOf(launched);
    const input = { workspaceId: ws.id, pinnedMarketId: snapshotRef.id, launchedMarketId: pinned === null ? snapshotRef.id : pinned.id, stamp, builds: curveLineOf(stamp, launched).value };
    for (const rule of rules) {
      const problem = rule.problem(input);
      if (problem !== null) return res("error", true, problem);
    }
    return built;
  };

  // ---- Balance Sheet ----------------------------------------------------------

  const positions = (): Res => {
    const ref = blocks.positions.book;
    if (ref === null) return res("not-set", true, "No position book. Import positions (CSV or JSON) or attach a stored book.");
    const problem = pinProblem(ref, docs.get(ref));
    if (problem !== null) return res("error", true, `Positions: ${problem}.`);
    const asOf = store.getMeta("portfolios", ref.id).asOf;
    if (typeof asOf !== "string") return res("error", true, `Book "${ref.id}" carries no as-of date in its meta.`);
    if (asOf === ws.cutoffDate) return res("valid", true, `Book "${ref.id}" is dated at the cut-off, ${asOf}.`);
    const recorded = ws.clashes.some((c) => c.block === "positions" && c.id === ref.id);
    return res("warning", true, `Book "${ref.id}" is dated ${asOf}, cut-off is ${ws.cutoffDate}${recorded ? "; the clash is recorded" : ""}.`);
  };

  const coaItem = (): Res => {
    const ref = blocks.positions.book;
    if (ref === null) return res("not-set", false, "Waits for a position book.");
    const book = docs.get<PortfolioSpec>(ref);
    if (book.where === "missing" || book.doc.coa === undefined) return res("not-set", false, "The book carries no readable chart of accounts.");
    const stored = blocks.positions.coa;
    if (stored === null) return res("valid", false, "The book embeds its chart of accounts.");
    const storedDoc = docs.get<unknown>(stored);
    if (storedDoc.where === "missing" || contentHash(storedDoc.doc) !== contentHash(book.doc.coa)) {
      return res("warning", false, `The stored chart of accounts "${stored.id}" differs from the one the book embeds; the book's own is the one runs use.`);
    }
    return res("valid", false, "The book embeds its chart of accounts, and the stored one is the same.");
  };

  // ---- Assumptions ------------------------------------------------------------

  /** The compile refuses a setup on a workspace with no routing policy (setupCompile.ts), so the item is required. */
  const routingPolicy = (): Res => {
    const ref = blocks.assumptions.routingPolicy ?? null;
    if (ref === null) return res("not-set", true, "Attach a routing policy; Validate refuses a setup without one.");
    const problem = pinProblem(ref, docs.get(ref));
    if (problem !== null) return res("error", true, `Routing policy: ${problem}.`);
    return res("valid", true, `Routing policy "${ref.id}" is attached.`);
  };

  const mapping = (): Res => {
    if (blocks.assumptions.sets.length === 0) return res("not-set", false, "No assumption set in the block, so no scenario mapping to check.");
    const inBlock = new Set(blocks.assumptions.sets.map((s) => s.id));
    const problems: string[] = [];
    for (const ref of blocks.scenarios.slates) {
      const slate = docs.get<{ scenarios: Array<{ id: string; assumptionSetId: string }> }>(ref);
      const p = pinProblem(ref, slate);
      if (p !== null) {
        problems.push(`slate "${ref.id}": ${p}`);
        continue;
      }
      for (const s of (slate as { doc: { scenarios: Array<{ id: string; assumptionSetId: string }> } }).doc.scenarios) {
        if (!inBlock.has(s.assumptionSetId)) problems.push(`slate "${ref.id}" scenario "${s.id}" names set "${s.assumptionSetId}", which is not in the assumptions block`);
      }
    }
    if (problems.length > 0) return res("error", false, `${problems.join("; ")}.`);
    return res("valid", false, blocks.scenarios.slates.length === 0
      ? "No authored slate to map; library scenarios run on the setup's sets."
      : "Every scenario of every authored slate names a set in the block.");
  };

  // ---- per slot ------------------------------------------------------------------

  const slotSets = (v: SlotView): Res => {
    const ids = new Set<string>();
    let usesDefault = false;
    for (const row of v.rows) {
      if (Array.isArray(row.assumptionSetIds)) for (const id of row.assumptionSetIds) ids.add(id);
      else usesDefault = true;
    }
    if (usesDefault) {
      const d = blocks.assumptions.defaultSetId;
      if (d === null) return res("not-set", true, "Attach an assumption set; the first attached becomes the default.");
      ids.add(d);
    }
    if (ids.size === 0) return res("not-set", true, "No assumption set referenced. Attach a set and choose it in the run setup.");
    const book = bookOf(v);
    const errors: string[] = [];
    const warnings: string[] = [];
    let unchecked = false;
    for (const id of ids) {
      const ref = blocks.assumptions.sets.find((r) => r.id === id);
      if (ref === undefined) {
        errors.push(`the setup names set "${id}", which is not in the assumptions block`);
        continue;
      }
      const set = docs.get<AssumptionSet>(ref);
      const p = pinProblem(ref, set);
      if (p !== null) {
        errors.push(`set "${id}": ${p}`);
        continue;
      }
      if (book === null || book.where !== "live") {
        unchecked = true;
        continue;
      }
      const doc = (set as { doc: AssumptionSet }).doc;
      try {
        const kinds = doc.bindings.some((b) => b.overlay.kind === "registered") ? registeredKinds(ctx, v.setup) : [];
        resolveAssumptions(doc, book.doc.coa.families, kinds);
        checkBindingOverlap(book.doc, doc);
      } catch (err) {
        errors.push(`set "${id}" is one the run would refuse: ${messageOf(err)}`);
        continue;
      }
      const held = new Set(book.doc.positions.map((p) => p.familyId));
      const idle = [...new Set(doc.bindings.map((b) => b.familyId))].filter((f) => !held.has(f));
      if (idle.length > 0) warnings.push(`set "${id}" binds ${idle.join(", ")}, which the book holds no position in`);
    }
    if (errors.length > 0) return res("error", true, `${errors.join("; ")}.`);
    if (warnings.length > 0) return res("warning", true, `${warnings.join("; ")}.`);
    if (unchecked) return res("valid", true, "A set is attached; its family checks wait for a readable position book.");
    return res("valid", true, `${ids.size === 1 ? "The set resolves" : `${ids.size} sets resolve`} against the book's chart of accounts with no overlap.`);
  };

  const slotScenarios = (v: SlotView): Res => {
    if (v.slot === null) return res("not-set", true, "No run setup, so no scenario choice.");
    if (v.problem !== null) return res("error", true, v.problem);
    const resolves = (entry: PlanScenarioRef): boolean => {
      if (!("ref" in entry)) return true;
      const hash = entry.ref.indexOf("#");
      if (hash < 0) return false;
      const lib = SHIPPED_LIBRARIES.find((l) => l.id === entry.ref.slice(0, hash));
      return lib?.scenarios.some((s) => s.id === entry.ref.slice(hash + 1)) ?? false;
    };
    const problems: string[] = [];
    let named = 0;
    for (const row of v.rows) {
      const sc = row.scenarios;
      if (sc.kind === "library") {
        named += sc.refs.length;
        for (const ref of sc.refs) if (!resolves({ ref })) problems.push(`library reference "${ref}" resolves to nothing`);
      } else if (sc.kind === "plan-scenarios") {
        named += sc.items.length;
        for (const item of sc.items) {
          if (!resolves(item)) problems.push(`scenario reference "${(item as { ref: string }).ref}" resolves to nothing`);
        }
      } else {
        const ref = blocks.scenarios.slates.find((r) => r.id === sc.slateId);
        if (ref === undefined) {
          problems.push(`the slate "${sc.slateId}" is not in the scenarios block`);
          continue;
        }
        const slate = docs.get<{ scenarios: Array<{ id: string }> }>(ref);
        const p = pinProblem(ref, slate);
        if (p !== null) {
          problems.push(`slate "${sc.slateId}": ${p}`);
          continue;
        }
        const ids = (slate as { doc: { scenarios: Array<{ id: string }> } }).doc.scenarios.map((s) => String(s.id));
        named += sc.include === "all" ? ids.length : sc.include.length;
        if (sc.include !== "all") for (const id of sc.include) if (!ids.includes(id)) problems.push(`scenario "${id}" is not in slate "${sc.slateId}"`);
      }
    }
    if (problems.length > 0) return res("error", true, `${problems.join("; ")}.`);
    if (named === 0) return res("not-set", true, "The run setup's scenario choice names nothing.");
    return res("valid", true, `${named} scenario${named === 1 ? "" : "s"} named, each resolvable.`);
  };

  const slotRates = (v: SlotView): Res => {
    const m = blocks.market;
    const refused = m.carried.filter((c) => c.status === "refused");
    const awaiting = m.carried.filter((c) => c.status === "awaiting");
    const book = bookOf(v);
    let target: DocRef | null;
    if (v.inputs.market.role === "base") target = m.snapshot;
    else {
      const key = v.inputs.market.definitionKey;
      target = m.derived.find((d) => d.definitionKey === key) ?? null;
      if (target === null) {
        const carried = m.carried.find((c) => c.definitionKey === key);
        return res("error", false, `The setup names derived market "${key}", which resolves to nothing${carried !== undefined ? ` (it is still carried: ${carried.status})` : ""}.`);
      }
    }
    // What the run reads from each index history, when it reads one (decisions 49 and 52).
    let historyLine: { warn: boolean; text: string } | null = null;
    // A derived curve estimated on another platform default version than the run's (decision 63).
    let curveDefaultLine: string | null = null;
    if (book !== null && book.where === "live" && target !== null) {
      const market = docs.get<MarketSnapshot>(target);
      if (market.where === "live") {
        // When the market's indices name a derived curve, the check reads the market the
        // launch would pin (the saved curves and the active setup in one derive), so a missing curve and a
        // curve built on another base read here as they refuse at launch. Otherwise the market as it stands.
        let checkedDoc = market.doc;
        let checkedId = target.id;
        if (namedCurveIdsOf(market.doc).length > 0) {
          const pin = curveRoles(target);
          if (pin?.error !== undefined) return res("error", false, pin.error);
          if (pin !== null && pin.market !== null && pin.snapshot !== null) {
            checkedDoc = pin.snapshot;
            checkedId = pin.market.id;
          }
        }
        const histories = storedIndexHistories(store, indexHistoryIdsRead(book.doc, checkedDoc));
        const check = checkRateIndexRefs(book.doc, checkedDoc, checkedId, histories);
        if (check.problems.length > 0) {
          const first = check.problems[0]!;
          let hint: string;
          const historyHint = indexHistoryProblemHint(first);
          if (historyHint !== null) {
            // The index resolves; the history it lags on is missing or unreadable, or the market cannot date it.
            hint = historyHint;
          } else if (isDerivedCurveProblem(first)) {
            // The index resolves; its curve does not. Pointing the setup at another market is not the fix.
            hint = first.includes(BASE_MISMATCH)
              ? " Save the derived curve again on the run's curve on Market > Derived curves, or change the active curve setup on Market > Curve setups."
              : first.includes(DERIVED_BLOCK_UNREADABLE)
                ? ""
                : " Save a derived curve under that id on Market > Derived curves.";
          } else {
            // A carrier carries every index a position reads; a curve it lacks is pinned at launch, so curve problems do not disqualify it.
            const carriers: string[] = [];
            for (const d of m.derived) {
              if (d.id === target.id) continue;
              const other = docs.get<MarketSnapshot>(d);
              if (other.where !== "live") continue;
              const otherHistories = storedIndexHistories(store, indexHistoryIdsRead(book.doc, other.doc));
              if (checkRateIndexRefs(book.doc, other.doc, d.id, otherHistories).problems.every(isDerivedCurveProblem)) carriers.push(d.id);
            }
            hint =
              carriers.length > 0
                ? ` The market block holds ${carriers.join(", ")}, which carries the indices: point the setup's market at it on Run > Setups.`
                : " No derived market in the block carries them.";
          }
          return res("error", false, `${first}${check.problems.length > 1 ? ` (${check.problems.length} problems)` : ""}.${hint}`);
        }
        curveDefaultLine = derivedCurveDefaultText(checkedDoc);
        if (histories.length > 0) {
          // Read on the market the launch pins (an active curve setup moves the curve's month 0 the clause prints).
          const readings = indexHistoryReadings(book.doc, curveRoles(target)?.snapshot ?? checkedDoc, histories);
          const short = readings.filter((r) => r.flatAfter + r.flatBefore > 0);
          if (short.length > 0) {
            historyLine = { warn: true, text: historyShortText(short) };
          } else if (readings.length > 0) {
            historyLine = { warn: false, text: ` Index history read: ${readings.map(historyReadingText).join("; ")}.` };
          }
        }
      }
    }
    if (refused.length > 0) return res("warning", false, `${refused.length} carried definition${refused.length === 1 ? "" : "s"} refused on re-apply: ${refused.map((c) => c.definitionKey).join(", ")}.`);
    if (awaiting.length > 0) return res("draft", false, `${awaiting.length} carried definition${awaiting.length === 1 ? "" : "s"} await re-apply: ${awaiting.map((c) => c.definitionKey).join(", ")}.`);
    if (historyLine?.warn === true || curveDefaultLine !== null) {
      // Both warnings are one acknowledgeable item; a history reading that does not warn still follows.
      const warned = [...(historyLine?.warn === true ? [historyLine.text] : []), ...(curveDefaultLine !== null ? [curveDefaultLine] : [])];
      const reading = historyLine !== null && !historyLine.warn ? historyLine.text : "";
      return res("warning", false, `${warned.join(" ")}${reading}`);
    }
    if (book !== null && target !== null) return res("valid", false, `Every rate index a position names resolves on the setup's market.${historyLine?.text ?? ""}`);
    if (m.derived.length === 0 && m.carried.length === 0) return res("not-set", false, "No derived market is named and none is carried.");
    return res("valid", false, "Derived markets are held; they are checked once a book and a snapshot are set.");
  };

  // Slice two Task 5: the words of record, computed on read (were "ATM cap quotes").
  const slotVol = (v: SlotView): Res => {
    const need = v.stochastic;
    if (snapshotRef === null || snapshot === null || snapshot.where !== "live") {
      return res("not-set", need, need ? "The setup asks for a stochastic path; it needs a base snapshot whose short-rate volatility surface carries the at-the-money column." : "Needed only for a stochastic path.");
    }
    const quotes = snapshot.doc.capQuotes;
    if (Array.isArray(quotes) && quotes.some((q) => q.isAtm)) return res("valid", need, "The short-rate volatility surface carries the at-the-money column.");
    if (need) return res("error", true, "The setup asks for a stochastic path and the base snapshot's short-rate volatility surface carries no at-the-money column.");
    return res("not-set", false, "No at-the-money column on the short-rate volatility surface; needed only for a stochastic path.");
  };

  const slotStrategy = (v: SlotView): Res => {
    const named = new Set<string>();
    for (const row of v.rows) if (row.basis.kind === "custom") named.add(row.basis.balancePlanId);
    for (const id of Object.values(v.scenarioBalancePlans)) named.add(id);
    if (named.size === 0) {
      return blocks.targets.balancePlans.length === 0
        ? res("not-set", false, "Not needed: the setup's basis is Flat or Runoff.")
        : res("valid", false, `${blocks.targets.balancePlans.length} balance plan${blocks.targets.balancePlans.length === 1 ? "" : "s"} held; this setup names none.`);
    }
    const book = bookOf(v);
    const missingPlans: string[] = [];
    const errors: string[] = [];
    let unchecked = false;
    for (const id of named) {
      const ref = blocks.targets.balancePlans.find((r) => r.id === id);
      if (ref === undefined) {
        missingPlans.push(id);
        continue;
      }
      const plan = docs.get<BalancePlan>(ref);
      const p = pinProblem(ref, plan);
      if (p !== null) {
        errors.push(`plan "${id}": ${p}`);
        continue;
      }
      if (book === null || book.where !== "live") {
        unchecked = true;
        continue;
      }
      const opening = new Map<string, number>();
      for (const pos of book.doc.positions) opening.set(pos.familyId, (opening.get(pos.familyId) ?? 0) + pos.terms.notional);
      try {
        lowerBalancePlan((plan as { doc: BalancePlan }).doc, opening, v.gridHorizonMonths, book.doc.asOf, book.doc.coa);
      } catch (err) {
        errors.push(messageOf(err));
      }
    }
    if (errors.length > 0) return res("error", true, `${errors.join("; ")}.`);
    if (missingPlans.length > 0) {
      return res("not-set", true, `The setup names balance plan${missingPlans.length === 1 ? "" : "s"} ${missingPlans.map((i) => `"${i}"`).join(", ")}, which the targets block does not hold.`);
    }
    if (unchecked) return res("valid", true, "Plans are attached; they are checked against the book once it is readable.");
    return res("valid", true, "Every named plan has the book's as-of and targets families or nodes the book holds.");
  };

  /** The newest validation line of the slot's CURRENT setup document, and the stale roles against the head's roles now. */
  const slotRunSetups = (v: SlotView): Res => {
    if (v.slot === null) return res("not-set", true, "No run setup. A blank workspace is created with Standard ALCO.");
    if (v.problem !== null || v.setup === null) return res("error", true, v.problem ?? "The setup document cannot be read.");
    // Validate and launch refuse a stochastic EVE path (review C M1), so no validation line can clear it.
    if (v.stochastic) return res("error", true, STOCHASTIC_PATH_REFUSAL);
    const line = events
      .filter((e): e is Extract<SetupEvent, { t: "validate" }> => e.t === "validate" && e.setupLineageId === v.slot!.setupLineageId && e.setupDocId === v.slot!.current.id)
      .at(-1);
    if (line === undefined) return res("draft", true, `"${v.name}" is saved and has not been validated.`);
    const fresh = roleRefs(ws, v.setup, v.slot, null, curveRoles, historyRoles);
    const stale = staleRolesOf(line.consumed, (role) => fresh[role]?.contentHash ?? null);
    if (line.outcome === "fail") {
      const reports = line.reports as { error?: { message?: string } } | undefined;
      const why = reports?.error?.message ?? "a gate refused the plan; the validation report names it";
      return res("error", true, `The newest validation of "${v.name}" failed: ${why}`, stale);
    }
    if (stale.length > 0) {
      return res("stale", true, `The newest validation of "${v.name}" consumed pins the workspace no longer holds in these roles: ${stale.map((s) => s.role).join(", ")}. Validate again.`, stale);
    }
    if (line.outcome === "warn") return res("warning", true, `"${v.name}" validated with warnings.`);
    return res("valid", true, `"${v.name}" validated clean at the workspace's current pins.`);
  };

  // ---- Results ----------------------------------------------------------------

  const resultsItem = (): Res => {
    const seen = new Set<string>();
    const runs: Array<{ att: ReturnType<WorkspaceStore["readRunAttachments"]>[number]; status: RunStatus | null }> = [];
    let stochasticRuns = 0;
    for (const att of wsStore.readRunAttachments(ws.id)) {
      if (seen.has(att.runId)) continue;
      seen.add(att.runId);
      // "Newest result" reads the newest deterministic run; an attached stochastic run is
      // a separate reading, listed in the run history and Advanced Results.
      if (att.mode === "stochastic") {
        stochasticRuns += 1;
        continue;
      }
      let status: RunStatus | null = null;
      try {
        if (store.runFileExists(att.runId, "status.json")) status = store.readRunJson<RunStatus>(att.runId, "status.json");
      } catch {
        status = null;
      }
      runs.push({ att, status });
    }
    if (runs.length === 0) {
      return res("not-set", false, stochasticRuns === 0
        ? "No run is attached to this workspace yet."
        : `No deterministic run is attached to this workspace yet; ${stochasticRuns} stochastic run${stochasticRuns === 1 ? " is" : "s are"} listed in the run history.`);
    }
    const stamp = (r: (typeof runs)[number]): string => r.status?.submittedAt ?? r.att.at;
    runs.sort((a, b) => (stamp(a) !== stamp(b) ? (stamp(a) < stamp(b) ? 1 : -1) : a.att.runId < b.att.runId ? 1 : -1));
    const { att, status } = runs[0]!;
    if (status === null) return res("warning", false, `The newest run ${att.runId} has no readable status.`);
    if (status.state === "queued" || status.state === "running") return res("draft", false, `The newest run ${att.runId} is ${status.state}.`);
    if (status.state !== "done") return res("warning", false, `The newest run ${att.runId} ended ${status.state}.`);
    if (att.pins === "reconstructed") {
      return res("warning", false, `The newest run ${att.runId} predates workspaces; its pins were reconstructed, so currency cannot be proved.`);
    }
    if (!store.runFileExists(att.runId, "request.json")) return res("warning", false, `The newest run ${att.runId} has no request record to read its pins from.`);
    const request = store.readRunJson<StoredRunRequest>(att.runId, "request.json");
    const stamped = request.workspace;
    if (stamped === undefined) return res("warning", false, `The newest run ${att.runId} records no consumed pins.`);

    const lineage = stamped.setupLineageId ?? att.setupLineageId;
    const slot = blocks.run.setups.find((s) => s.setupLineageId === lineage);
    const fresh: ConsumedPins = {};
    if (slot !== undefined) {
      const v = views.find((x) => x.slot === slot);
      if (v?.setup != null) {
        const launched = events.find((e) => e.t === "launch" && e.setupLineageId === slot.setupLineageId && e.launchNo === stamped.launchNo);
        const batch = launched !== undefined && launched.t === "launch" && launched.batch;
        const rows: Array<Row | null> = batch ? [null, ...rowsOf(v.setup).slice(1)] : [null];
        for (const row of rows) Object.assign(fresh, roleRefs(ws, v.setup, slot, row, curveRoles, historyRoles));
      }
    }
    const stale = staleRolesOf(stamped.consumed, (role, ref) => {
      // The run's slate role pins the launch slate the server wrote, which no block lists: it is read from the store.
      if (role === "slate") return store.has(ref.collection, ref.id) ? store.getMeta(ref.collection, ref.id).contentHash : null;
      return fresh[role]?.contentHash ?? null;
    });
    if (stale.length > 0) {
      return res("stale", false, `The newest run ${att.runId} consumed pins the workspace no longer holds in these roles: ${stale.map((s) => s.role).join(", ")}.`, stale);
    }
    return res("valid", false, `The newest run ${att.runId} is done and every consumed pin is current.`);
  };

  // ---- Govern -----------------------------------------------------------------

  const signOff = (): Res => {
    const records: ApprovalRecord[] = [];
    for (const meta of store.listMeta("approvals")) {
      if (meta.artifactCollection !== undefined && (meta.artifactCollection !== "workspaces" || meta.artifactId !== ws.id)) continue;
      const rec = store.getDocument<ApprovalRecord>("approvals", meta.id).doc;
      if (rec.artifactCollection === "workspaces" && rec.artifactId === ws.id) records.push(rec);
    }
    const { state, latest } = approvalState(records, ws.signedHash);
    if (state === "none") return res("not-set", false, "No sign-off recorded.");
    if (state === "changed") {
      return res("stale", false, `Signed by ${latest!.by} at ${latest!.at}, but the workspace has changed since${ws.type === "production" ? "" : "; sign it again"}.`);
    }
    if (state === "revoked") return res("not-set", false, "The last sign-off was revoked.");
    return res("valid", false, `Signed by ${latest!.by} at ${latest!.at}${ws.lock !== null ? "; the workspace is locked" : ""}.`);
  };

  // ---- assemble ---------------------------------------------------------------

  const shared = new Map<string, Res>();
  shared.set("market/Base snapshot", guarded(true, "Base snapshot", baseSnapshot));
  shared.set("market/Curves", guarded(false, "Curves", curves));
  shared.set("balance/Positions", guarded(true, "Positions", positions));
  shared.set("balance/Chart of accounts", guarded(false, "Chart of accounts", coaItem));
  shared.set("assumptions/Routing policy", guarded(true, "Routing policy", routingPolicy));
  shared.set("assumptions/Mapping", guarded(false, "Mapping", mapping));
  shared.set("results/Newest result", guarded(false, "Newest result", resultsItem));
  shared.set("govern/Sign-off", guarded(false, "Sign-off", signOff));

  const perSlot: Array<{ view: SlotView; items: Map<string, Res> }> = checkViews.map((view) => ({
    view,
    items: new Map<string, Res>([
      ["market/Vol surface", guarded(view.stochastic, "Vol surface", () => slotVol(view))],
      ["market/Rate indices and derived markets", guarded(false, "Rate indices and derived markets", () => slotRates(view))],
      ["balance/Strategy", guarded(false, "Strategy", () => slotStrategy(view))],
      ["assumptions/Sets", guarded(true, "Sets", () => slotSets(view))],
      ["run/Scenarios", guarded(true, "Scenarios", () => slotScenarios(view))],
      ["run/Run setups", guarded(true, "Run setups", () => slotRunSetups(view))],
    ]),
  }));

  const items: ReadinessItem[] = WORKSPACE_ITEMS.map(([section, item]) => {
    const key = `${section}/${item}`;
    const sharedRes = shared.get(key);
    const r =
      sharedRes ??
      merge(perSlot.map((p) => ({ label: p.view.name, r: p.items.get(key)! })));
    return { section, item, state: r.state, required: r.required, detail: r.detail, ...(r.staleRoles !== undefined ? { staleRoles: r.staleRoles } : {}) };
  });

  // Section chips.
  const sections = {} as Record<SectionId, ReadinessState>;
  const chipOf = (list: ReadinessItem[]): ReadinessState => {
    const counted = list.filter(counts);
    if (counted.length > 0) return counted.reduce((a, b) => (RANK[b.state] < RANK[a.state] ? b : a)).state;
    return list.length > 0 ? "not-set" : "valid";
  };
  for (const id of SECTION_IDS) {
    // The Workspace chip (the overview) is the worst of everything; every other chip is its own section's.
    sections[id] = chipOf(id === "workspace" ? items : items.filter((i) => i.section === id));
  }

  // The launch lists, one per slot.
  const launchable: ReadinessReport["launchable"] = {};
  const staleBySlot: Record<string, StaleRole[]> = {};
  const reasonById: ReadinessDetail["reasonById"] = {};
  for (const { view, items: own } of perSlot) {
    if (view.slot === null) continue;
    const blocking: string[] = [];
    const acknowledgeable: string[] = [];
    const reasons: Record<string, string> = {};
    for (const [section, item] of WORKSPACE_ITEMS) {
      if (!LAUNCH_SECTIONS.has(section)) continue;
      const key = `${section}/${item}`;
      const r = shared.get(key) ?? own.get(key)!;
      const id = itemIdOf(section, item, r.state);
      let list: string[] | null = null;
      if (r.state === "error" || (r.state === "not-set" && r.required)) list = blocking;
      else if (r.state === "stale") list = ws.type === "production" ? blocking : acknowledgeable;
      else if (r.state === "warning") list = acknowledgeable;
      if (list !== null && !list.includes(id)) {
        list.push(id);
        reasons[id] = r.detail;
      }
    }
    launchable[view.slot.setupLineageId] = { ok: blocking.length === 0 && acknowledgeable.length === 0, blocking, acknowledgeable };
    staleBySlot[view.slot.setupLineageId] = own.get("run/Run setups")!.staleRoles ?? [];
    reasonById[view.slot.setupLineageId] = reasons;
  }

  return { report: { items, sections, launchable }, staleBySlot, reasonById };
}

/** The behavioral kinds the mounted plugins register: read only when a set binds a "registered" overlay. */
function registeredKinds(ctx: PlatformContext, setup: RunSetup | null): readonly string[] {
  try {
    const operator = loadOperatorPlugins(pluginConfigPath(ctx.config.repoRoot));
    const mounted = behavioralRegistryOf(setup?.plan.profile, operator);
    try {
      return mounted.registry.kinds();
    } finally {
      mounted.dispose();
    }
  } catch {
    return [];
  }
}
