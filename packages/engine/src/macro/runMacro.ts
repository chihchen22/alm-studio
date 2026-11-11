/**
 * The run-scoped macro value (spec v4 Sections 5 and 6).
 *
 * A RunMacro is resolved once per run entry and threaded beside rateIndices to
 * every makeInstrument call: the frozen NO_MACRO sentinel, or a path carrying
 * the mapped house-price index. It is nominal at runtime through a
 * module-private symbol brand, so a plain object (or a structured clone, which
 * drops a symbol-keyed property) is refused by the factory rather than read.
 *
 * The module has exactly two constructors: resolveRunMacro (the run entry, the
 * stochastic entry, the compile and the drill) and runMacroFromWire (only the
 * shard worker, which receives the plain toWire form through workerData and
 * re-mints it, restoring NO_MACRO's identity).
 *
 * The run rule (R6, ruling 2026-10-08): the base scenario's set carries
 * the run's mapping. A scenario whose set carries no macroBindings inherits it;
 * a scenario whose set carries a different mapping (a mapping when the base has
 * none included) is refused, naming both sets.
 */
import type { MarketSnapshot } from "@alm/kernel";
import type { AssumptionSet } from "../contracts/assumptions";
import type { DimensionPredicate } from "../contracts/dimensions";
import type { MacroBinding, MacroSeries, MacroTarget } from "../contracts/macroFactors";
import type { Scenario } from "../contracts/scenario";
import { canonicalize, sha256Hex } from "../runtime/contentHash";
import { macroSelectorText } from "./targetKey";
import { INDEX_PROJECTION_MAX, INDEX_PROJECTION_MIN, asOfMonthOf, macroSeriesTable, validateMacroFactors } from "./macroFactors";

const BRAND = Symbol("RunMacro");

/** No macro path reaches this run. */
export interface RunMacroNone { readonly kind: "none" }

/** One mapped house-price index path and the families it reaches. */
export interface RunMacroPath {
  readonly kind: "path";
  readonly seriesId: string;
  readonly housePriceIndexPath: readonly number[];
  readonly families: readonly MacroTarget[];
}

export type RunMacro = RunMacroNone | RunMacroPath;

/** The plain, structured-clone-safe form a shard worker receives (no brand, no symbol). */
export type RunMacroWire =
  | { kind: "none" }
  | { kind: "path"; seriesId: string; housePriceIndexPath: number[]; families: MacroTarget[] };

/** What resolveRunMacro reads of a run request (a RunRequest satisfies it). */
export interface MacroRunInputs {
  scenarios: ReadonlyArray<Pick<Scenario, "id" | "rateSpec" | "assumptionSetId">>;
  assumptionSets: readonly AssumptionSet[];
  grid: { horizonMonths: number };
}

/** Freezes a plain JSON value and everything it holds. */
function deepFreeze(v: unknown): void {
  if (v === null || typeof v !== "object" || Object.isFrozen(v)) return;
  for (const x of Object.values(v)) deepFreeze(x);
  Object.freeze(v);
}

/** Brands and freezes a value; the only way a RunMacro comes to exist. Its targets are the module's own copies, so freezing them never freezes a caller's set. */
function mint<T extends RunMacro>(v: T): T {
  Object.defineProperty(v, BRAND, { value: true, enumerable: false });
  if (v.kind === "path") {
    Object.freeze(v.housePriceIndexPath);
    deepFreeze(v.families);
  }
  return Object.freeze(v);
}

/** The frozen, branded sentinel: the run carries no macro path. */
export const NO_MACRO: RunMacro = mint({ kind: "none" });

/** True only for a value this module minted. */
export const isRunMacro = (v: unknown): v is RunMacro =>
  v !== null && typeof v === "object" && (v as Record<symbol, unknown>)[BRAND] === true;

/** The mapped house-price index path, or undefined for NO_MACRO. */
export const housePriceIndexPathOf = (m: RunMacro): readonly number[] | undefined => (m.kind === "path" ? m.housePriceIndexPath : undefined);

/** The families and selectors the run's path reaches; [] for NO_MACRO. */
export const macroTargetsOf = (m: RunMacro): readonly MacroTarget[] => (m.kind === "path" ? m.families : []);

/** The one key a family and selector are matched on, mapping to binding: family, then the hash of the selector's canonical text (null for the whole family); the text is macroTargetIdentity's, shared with Studio. */
export const macroTargetKey = (familyId: string, selector: DimensionPredicate | undefined): string =>
  `${familyId}::${sha256Hex(macroSelectorText(selector))}`;

/**
 * A mortgage carrying a house-price response reached the factory without a
 * resolved RunMacro (`terms` names it), or a run stage reached its work without
 * the run's value (`stage` names it, via requireRunMacro). Exactly one is set.
 */
export class MacroUnresolvedError extends Error {
  readonly terms: string | undefined;
  readonly stage: string | undefined;
  constructor(termsId: string, why: string);
  constructor(termsId: undefined, why: undefined, stage: string);
  constructor(termsId: string | undefined, why: string | undefined, stage?: string) {
    super(stage !== undefined
      ? `${stage}: the run's macro value was not threaded to this stage; a stage never substitutes NO_MACRO, so a mapped family cannot fall back to the kernel schedule`
      : `makeInstrument: mortgage "${termsId}" carries a house-price response and ${why}; a mapped family never falls back to the kernel schedule`);
    this.name = "MacroUnresolvedError"; this.terms = termsId; this.stage = stage;
  }
  /** The stage form: a run stage reached its work without the run's macro value (what requireRunMacro throws). */
  static forStage(stage: string): MacroUnresolvedError { return new MacroUnresolvedError(undefined, undefined, stage); }
}

/** The run's RunMacro, or MacroUnresolvedError naming the stage that was not given it: a stage never substitutes NO_MACRO. */
export function requireRunMacro(m: RunMacro | undefined, where: string): RunMacro {
  if (m === undefined) throw MacroUnresolvedError.forStage(where);
  return m;
}

/** A run whose macro mapping cannot be read: at the run entry, the stochastic entry, the compile or the drill. */
export class MacroRefusedError extends Error {
  readonly ids: Record<string, string>;
  constructor(message: string, ids: Record<string, string> = {}) {
    super(message);
    this.name = "MacroRefusedError"; this.ids = ids;
  }
}

const copyTarget = (t: MacroTarget): MacroTarget =>
  t.selector === undefined ? { familyId: t.familyId } : { familyId: t.familyId, selector: JSON.parse(JSON.stringify(t.selector)) as DimensionPredicate };

/** The plain form of a RunMacro, arrays copied; safe to structured-clone into a worker. */
export function toWire(m: RunMacro): RunMacroWire {
  if (m.kind === "none") return { kind: "none" };
  return { kind: "path", seriesId: m.seriesId, housePriceIndexPath: [...m.housePriceIndexPath], families: m.families.map(copyTarget) };
}

/** Re-mints a RunMacro from its wire form: NO_MACRO itself for none; a checked, branded path otherwise. Called only by the shard worker. */
export function runMacroFromWire(w: RunMacroWire): RunMacro {
  if (w !== null && typeof w === "object" && w.kind === "none") return NO_MACRO;
  const bad = (why: string): never => { throw new MacroRefusedError(`run refused: the shard worker received a macro path it cannot read: ${why}`); };
  if (w === null || typeof w !== "object" || w.kind !== "path") return bad("unknown kind");
  if (typeof w.seriesId !== "string" || w.seriesId.length === 0) bad("no series id");
  if (!Array.isArray(w.housePriceIndexPath) || w.housePriceIndexPath.length === 0) bad("an empty index path");
  for (const v of w.housePriceIndexPath) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < INDEX_PROJECTION_MIN || v > INDEX_PROJECTION_MAX) bad(`index value ${String(v)} outside [${INDEX_PROJECTION_MIN}, ${INDEX_PROJECTION_MAX}]`);
  }
  if (!Array.isArray(w.families) || w.families.length === 0) bad("no families");
  return mint({ kind: "path", seriesId: w.seriesId, housePriceIndexPath: [...w.housePriceIndexPath], families: w.families.map(copyTarget) });
}

/** True when `set` has a four-factor prepay binding on the target's family and selector that carries the housing group. */
function carriesHousing(set: AssumptionSet, key: string): boolean {
  return set.bindings.some((b) =>
    b.overlay.kind === "prepay" && b.overlay.model === "four-factor-cpr" && b.overlay.housing !== undefined
    && macroTargetKey(b.familyId, b.selector) === key);
}

/**
 * The run's macro value, resolved once at its entry.
 * An unmapped base returns NO_MACRO without reading the market's block. A
 * mapped base reads the one series it names from the market, which must be an
 * index projection covering the horizon, and every scenario set (inheriting
 * or not) must carry the housing group on each mapped family.
 */
export function resolveRunMacro(request: MacroRunInputs, market: MarketSnapshot, marketName?: string): RunMacro {
  const base = request.scenarios.find((s) => s.rateSpec.kind === "base");
  if (base === undefined) return NO_MACRO;
  const setById = new Map(request.assumptionSets.map((s) => [s.id, s] as const));
  const baseSet = setById.get(base.assumptionSetId);
  if (baseSet === undefined) return NO_MACRO;
  const mapping: MacroBinding[] | undefined = baseSet.macroBindings;
  const want = canonicalize(mapping ?? null);
  // The distinct scenario sets, in scenario order, with the first scenario that uses each.
  const scenarioSets: Array<{ set: AssumptionSet; scenarioId: string }> = [];
  const seen = new Set<string>();
  for (const s of request.scenarios) {
    if (seen.has(s.assumptionSetId)) continue;
    seen.add(s.assumptionSetId);
    const set = setById.get(s.assumptionSetId);
    if (set !== undefined) scenarioSets.push({ set, scenarioId: s.id });
  }
  for (const { set, scenarioId } of scenarioSets) {
    if (set.macroBindings === undefined) continue;
    if (canonicalize(set.macroBindings) !== want) {
      throw new MacroRefusedError(
        `run refused: scenario "${scenarioId}" uses set "${set.id}", whose macroBindings differ from the base set "${baseSet.id}"'s; every scenario in a run shares the base's macro path`,
        { baseSetId: baseSet.id, setId: set.id, scenarioId, field: "macroBindings" },
      );
    }
  }
  if (mapping === undefined || mapping.length === 0) return NO_MACRO;

  const shown = marketName === undefined ? "the run's market" : `market "${marketName}"`;
  const block = (market as { macroFactors?: unknown }).macroFactors ?? [];
  const asOf = asOfMonthOf(market);
  if (asOf === null) {
    throw new MacroRefusedError(`run refused: ${shown} carries no readable calibrationDate, so its macroFactors block has no as-of month to be checked against`, { baseSetId: baseSet.id });
  }
  const problems = validateMacroFactors(block, asOf);
  if (problems.length > 0) {
    throw new MacroRefusedError(`run refused: ${shown} carries a macroFactors block the run cannot read: ${problems.map((p) => p.message).join("; ")}`, { baseSetId: baseSet.id });
  }
  const table = macroSeriesTable(block as MacroSeries[]);
  const seriesId = mapping[0]!.seriesId;
  const series = table.get(seriesId);
  if (series === undefined) {
    const carried = [...table.keys()];
    throw new MacroRefusedError(
      `run refused: set "${baseSet.id}" maps series "${seriesId}", which ${shown} does not carry (it carries ${carried.length === 0 ? "none" : carried.join(", ")})`,
      { baseSetId: baseSet.id, seriesId },
    );
  }
  if (series.kind !== "index" || series.role !== "projection") {
    const article = /^[aeiou]/.test(series.kind) ? "an" : "a";
    throw new MacroRefusedError(`run refused: series "${seriesId}" is ${article} ${series.kind} ${series.role}; the house-price response reads an index projection`, { seriesId });
  }
  const horizon = request.grid.horizonMonths;
  if (series.values.length < horizon) {
    throw new MacroRefusedError(`run refused: projection "${seriesId}" has ${series.values.length} months and the run horizon is ${horizon}`, { seriesId });
  }
  for (const { set } of scenarioSets) {
    for (const t of mapping) {
      if (!carriesHousing(set, macroTargetKey(t.familyId, t.selector))) {
        throw new MacroRefusedError(
          `run refused: scenario set "${set.id}" inherits the mapping of "${baseSet.id}", but its four-factor prepay binding for family "${t.familyId}" carries no housing group`,
          { baseSetId: baseSet.id, setId: set.id, familyId: t.familyId },
        );
      }
    }
  }
  return mint({
    kind: "path",
    seriesId,
    housePriceIndexPath: [...series.values] as number[],
    families: mapping.map(copyTarget),
  });
}
