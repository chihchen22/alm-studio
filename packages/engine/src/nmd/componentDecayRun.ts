/**
 * The run side of the component decay form.
 *
 * A component decay form is bound by an nmd-decay overlay, so the run learns of it from its assumption sets. When any
 * set on the run's axis binds one, the run resolves here, once, before the walk:
 *
 *  - each scenario's level shift in percent (the reader the full beta form uses, `depositShiftPctOf`), which the
 *    static pass hands each component decay deposit through the instrument factory (MakeInstrumentOptions
 *    depositShiftPct);
 *  - the refusals: a dynamic new-business scenario, a deposit convention that slots deposits for EVE, and the opt-in
 *    blocks that rebuild deposits on bumped curve paths the dated driver does not read (SEG, key-rate durations, the
 *    EVE channel decomposition).
 *
 * The metric stage then leaves out what the book cannot price honestly: NII (blank for this model by the routing map:
 * the form prices volume, not the paid rate), EVE (a valuation reads a curve path, not this dated path) and FTP. Each is tagged in notImplemented. The cash flows, the liquidity
 * gap and the repricing gap's balance layer run, and the family WAL reads the full runoff (`stampComponentDecayWal`).
 *
 * A run whose sets bind none resolves nothing here, and no stage sees a key.
 */
import type { AssumptionSet } from "../contracts/assumptions";
import type { NotImplemented } from "../contracts/errors";
import type { PortfolioSpec } from "../contracts/position";
import type { ScenarioCashflows } from "../contracts/results";
import type { Scenario } from "../contracts/scenario";
import { makeNotImplemented } from "../runtime/notImplemented";
import { ComponentDecayDeposit, hasComponentDecay, type WalCorrection } from "./componentDecay";
import { depositShiftPctOf } from "./fullBetaRun";

/** True when any binding of any of the sets is an nmd-decay overlay carrying a component decay form. */
export function setsBindComponentDecay(sets: Iterable<AssumptionSet>): boolean {
  for (const set of sets) {
    for (const b of set.bindings) if (b.overlay.kind === "nmd-decay" && b.overlay.componentDecay !== undefined) return true;
  }
  return false;
}

/** What a component decay run refuses at entry, by the run option's name. */
export interface ComponentDecayOptIns {
  seg?: boolean;
  keyRate?: boolean;
  eveChannels?: boolean;
  nmdConvention?: string;
}

/**
 * Resolve every scenario's level shift, or refuse in one sentence naming the scenario or the option. Called only when
 * the run's sets bind a component decay form.
 */
export function resolveComponentDecayShifts(scenarios: readonly Scenario[], optIns: ComponentDecayOptIns): ReadonlyMap<string, number> {
  for (const [name, on] of [["seg", optIns.seg], ["keyRate", optIns.keyRate], ["eveChannels", optIns.eveChannels]] as const) {
    if (on === true) {
      throw new Error(
        `run: ${name} cannot run beside the component decay form; that block rebuilds deposits on bumped curve paths, ` +
          "and the component form reads its dated rate path, so drop one of the two",
      );
    }
  }
  if (optIns.nmdConvention === "regulatory" || optIns.nmdConvention === "shocked-level") {
    throw new Error(
      `run: nmdConvention "${optIns.nmdConvention}" slots deposits for EVE, and a book on the component decay form ` +
        "carries no EVE (its dated path is not a curve path), so run it on the behavioral convention",
    );
  }
  const out = new Map<string, number>();
  for (const s of scenarios) {
    if (s.newBusiness.mode !== "static") {
      throw new Error(
        `run: the component decay form applies to static-runoff scenarios only; scenario "${s.id}" has new-business mode ` +
          `"${s.newBusiness.mode}", whose dynamic projection builds its own deposits`,
      );
    }
    out.set(s.id, depositShiftPctOf(s));
  }
  return out;
}

/** The notImplemented tag of a block a component decay run leaves out, by block. */
export function componentDecayRefusal(block: "nii" | "eve" | "ftp"): NotImplemented {
  const reasons = {
    nii:
      "the run's sets bind the component decay form, which prices deposit volume and not the paid rate, so NII is not " +
      "defined for this model and the nii block carries no scenario rather than a number.",
    eve:
      "the run's sets bind the component decay form, whose driver is a dated rate path and not a curve path, so the " +
      "eve block carries no scenario rather than a value on another path.",
    ftp:
      "the run's sets bind the component decay form; the FTP module prices a deposit on the curve path and its term " +
      "liquidity premium, which a balance on a dated path does not read, so the ftp block is left out.",
  } as const;
  return makeNotImplemented(`${block}.component-decay`, reasons[block]);
}

/** The WAL readout's note, written once when a family's WAL carries a component decay correction. */
export function componentDecayWalNote(families: readonly string[], horizonMonths: number): NotImplemented {
  return makeNotImplemented(
    "cashflows.wal.full-runoff",
    `walYears of ${families.join(", ")} reads the full runoff of its component decay deposits: the in-horizon runoff plus ` +
      `the exact geometric tail past the ${horizonMonths}-month grid, with the driver held at its last window value, ` +
      "and a static bifurcation's overnight remainder at zero life. Every other family's WAL is in-horizon.",
  );
}

/** The WAL corrections of the component decay deposits of `book` under one scenario's shift, summed by family. */
export function componentDecayWalCorrections(book: PortfolioSpec, shiftPct: number, horizonMonths: number): Map<string, WalCorrection> {
  const out = new Map<string, WalCorrection>();
  for (const p of book.positions) {
    if (p.terms.type !== "nmd" || !hasComponentDecay(p.terms)) continue;
    const c = new ComponentDecayDeposit(p.terms, shiftPct).walCorrection(horizonMonths);
    const prior = out.get(p.familyId) ?? { principal: 0, dollarYears: 0 };
    out.set(p.familyId, { principal: prior.principal + c.principal, dollarYears: prior.dollarYears + c.dollarYears });
  }
  return out;
}

/**
 * Restamp walYears on each family with a correction: (sum of principal[k] (k + 1) / 12 + dollar-years) over (in-horizon
 * principal + principal). Returns the families restamped; a family with no positive principal keeps no WAL.
 */
export function stampComponentDecayWal(scenario: ScenarioCashflows, corrections: ReadonlyMap<string, WalCorrection>): string[] {
  const out: string[] = [];
  for (const fam of scenario.byFamily) {
    const c = corrections.get(fam.familyId);
    if (c === undefined) continue;
    let total = 0;
    let dollarYears = 0;
    fam.series.principal.forEach((v, k) => {
      total += v;
      dollarYears += (v * (k + 1)) / 12;
    });
    total += c.principal;
    if (!(total > 0)) continue;
    fam.walYears = (dollarYears + c.dollarYears) / total;
    out.push(fam.familyId);
  }
  return out;
}
