/**
 * The run-entry side of the full beta form.
 *
 * A full form is bound by a deposit-beta overlay, so the run learns of it from its assumption sets, not its book.
 * When any set on the run's axis binds one, the run resolves here, once, before the walk:
 *
 *  - each scenario's shift of the short rate at tenor zero, in percent (base 0, parallel shockBp, twist shortBp,
 *    custom the knot vector read at tenor zero), which the static pass hands each full-form deposit through the
 *    instrument factory (MakeInstrumentOptions depositShiftPct);
 *  - the refusals: a dynamic new-business scenario (its projection builds its own deposits at the base state) and
 *    the opt-in blocks that rebuild deposits on bumped paths the level driver does not read (SEG, key-rate
 *    durations, the EVE channel decomposition).
 *
 * The deposit convention marks the full-form deposits at run entry (`markFullFormBook`): "regulatory" leaves them
 * whole and marks them "frozen" (the regulatory transform splits every other deposit as before), "shocked-level"
 * marks them "shocked-level" and refuses any deposit without the form. The mark rides on the terms, so every block
 * that builds the deposit sees one slotting.
 *
 * A run whose sets bind no full form resolves nothing here, and no stage sees a key.
 */
import type { AssumptionSet, DepositBetaOverlay } from "../contracts/assumptions";
import type { DepositSlotting, EngineNMDBetaTerms, PortfolioSpec, Position } from "../contracts/position";
import type { Scenario } from "../contracts/scenario";
import { selectorMatchesBag } from "../plan/dimensions";
import { dimensionsOf } from "../portfolio/dimensions";
import { customShiftBp } from "../scenario/rateEnvironment";

/** True when any binding of any of the sets is a deposit-beta overlay carrying a full form. */
export function setsBindFullForm(sets: Iterable<AssumptionSet>): boolean {
  for (const set of sets) {
    for (const b of set.bindings) if (b.overlay.kind === "deposit-beta" && b.overlay.fullForm !== undefined) return true;
  }
  return false;
}

/** The scenario's shift of the short rate at tenor zero, percent. */
export function depositShiftPctOf(scenario: Scenario): number {
  const spec = scenario.rateSpec;
  switch (spec.kind) {
    case "base":
      return 0;
    case "parallel":
      return spec.shockBp / 100;
    case "twist":
      return spec.shortBp / 100;
    case "custom":
      return customShiftBp(0, spec.shocks) / 100;
  }
}

/** The opt-ins a full-form run refuses, by the run option's name. */
export interface FullFormOptIns {
  seg?: boolean;
  keyRate?: boolean;
  eveChannels?: boolean;
}

/**
 * Resolve the shift of every scenario, or refuse in one sentence naming the scenario or the option. Called only
 * when the run's sets bind a full form.
 */
export function resolveDepositShifts(scenarios: readonly Scenario[], optIns: FullFormOptIns): ReadonlyMap<string, number> {
  for (const [name, on] of [["seg", optIns.seg], ["keyRate", optIns.keyRate], ["eveChannels", optIns.eveChannels]] as const) {
    if (on === true) {
      throw new Error(
        `run: ${name} cannot run beside the full beta form; that block rebuilds deposits on bumped paths, and the ` +
          "full form reads the scenario's level, not the path, so drop one of the two",
      );
    }
  }
  const out = new Map<string, number>();
  for (const s of scenarios) {
    if (s.newBusiness.mode !== "static") {
      throw new Error(
        `run: the full beta form applies to static-runoff scenarios only; scenario "${s.id}" has new-business mode ` +
          `"${s.newBusiness.mode}", whose dynamic projection builds its own deposits`,
      );
    }
    out.set(s.id, depositShiftPctOf(s));
  }
  return out;
}

/** The deposit-beta overlay that governs an nmd-b position under `set`: the first matching binding, else none. */
export function governingDepositBeta(p: Position, book: PortfolioSpec, set: AssumptionSet | undefined): DepositBetaOverlay | undefined {
  const family = book.coa.families.find((f) => f.id === p.familyId);
  for (const binding of set?.bindings ?? []) {
    if (binding.familyId !== p.familyId || binding.overlay.kind !== "deposit-beta") continue;
    if (binding.selector !== undefined) {
      if (family === undefined) continue;
      if (!selectorMatchesBag(binding.selector, dimensionsOf(p, family, book.taxonomy))) continue;
    }
    return binding.overlay;
  }
  return undefined;
}

/**
 * Mark the full-form deposits of `book` for the deposit convention. A deposit is full-form when the base scenario's
 * set binds it a full form. Both slottings mark those and leave every other position as it is, so the caller splits
 * the unmarked deposits by the regulatory transform under either convention (under
 * "shocked-level" a deposit without the form has no shocked level to read, so it takes the standardized slotting the
 * frozen arm gives it). "shocked-level" refuses a book whose deposits carry no form at all: the convention would then
 * be the regulatory one under another name. Positions that are not marked keep their object identity.
 */
export function markFullFormBook(book: PortfolioSpec, baseSet: AssumptionSet | undefined, slotting: DepositSlotting): PortfolioSpec {
  let changed = false;
  let deposits = 0;
  const positions = book.positions.map((p) => {
    const t = p.terms;
    if ((t.type !== "nmd-b" && t.type !== "nmd") || p.parentPositionId !== undefined) return p;
    deposits++;
    const full = t.type === "nmd-b" && governingDepositBeta(p, book, baseSet)?.fullForm !== undefined;
    if (!full) return p;
    changed = true;
    return { ...p, terms: { ...(t as EngineNMDBetaTerms), depositSlotting: slotting } };
  });
  if (slotting === "shocked-level" && deposits > 0 && !changed) {
    throw new Error(
      'run: nmdConvention "shocked-level" slots deposits on the full beta form, and no deposit carries one under the ' +
        "base scenario's set, so bind a full form or run the regulatory convention",
    );
  }
  return changed ? { ...book, positions } : book;
}

/**
 * True when `book` holds a deposit the regulatory transform would split: an nmd or nmd-b
 * that is not a child of an earlier split and carries no slotting mark. A shocked-level book of full-form deposits only
 * holds none, so it is walked exactly as before.
 */
export function hasUnslottedDeposit(book: PortfolioSpec): boolean {
  return book.positions.some((p) => {
    const t = p.terms;
    if ((t.type !== "nmd-b" && t.type !== "nmd") || p.parentPositionId !== undefined) return false;
    return !(t.type === "nmd-b" && (t as EngineNMDBetaTerms).depositSlotting !== undefined);
  });
}
