/**
 * The run side of the replicating-portfolio credit.
 *
 * The credit is bound by an nmd-decay overlay, so the run learns of it from its assumption sets. When any set on the
 * run's axis binds one, the run checks here, once, before the walk, and refuses what cannot run beside it: SEG,
 * key-rate durations and the EVE channel decomposition (each rebuilds deposits on bumped curves, and a credit run
 * carries no EVE), a deposit convention that slots deposits for EVE, a scenario other than the base (the FTP
 * block is base-only, ADR-018; the credit's steepener is read inside the credit), and dynamic new business.
 *
 * The metric stage then leaves out what the book cannot price honestly: NII (deposits that carry a repricing beta and
 * no paid rate have no interest cost to read) and EVE (a transfer-rate run is not a valuation). Each is tagged in
 * notImplemented. The FTP block runs; its NIM bridge reconciles to the interest the
 * positions' own terms carry, computed for the bridge only. The cash flows and the two gaps run.
 *
 * The credit also rides a deposit-beta overlay (a full-form deposit), and a credit
 * that says how it reads a shock (`scenarioCurve`) takes parallel scenarios on the deterministic path. The FTP block's
 * series stay base-only; only the credit reads the shocks, in its `byScenario` readout.
 *
 * A run whose sets bind none checks nothing here, and no stage sees a key.
 */
import type { AssumptionSet } from "../contracts/assumptions";
import type { NotImplemented } from "../contracts/errors";
import type { ReplicatingPortfolioForm } from "../contracts/position";
import type { Scenario } from "../contracts/scenario";
import { makeNotImplemented } from "../runtime/notImplemented";

/** True when any binding of any of the sets carries a replicating-portfolio credit (nmd-decay, or deposit-beta since E3). */
export function setsBindReplicatingPortfolio(sets: Iterable<AssumptionSet>): boolean {
  return boundCreditForms(sets).length > 0;
}

/** Every replicating-portfolio credit form the sets bind, on either overlay kind. */
export function boundCreditForms(sets: Iterable<AssumptionSet>): ReplicatingPortfolioForm[] {
  const out: ReplicatingPortfolioForm[] = [];
  for (const set of sets) {
    for (const b of set.bindings) {
      if ((b.overlay.kind === "nmd-decay" || b.overlay.kind === "deposit-beta") && b.overlay.replicatingPortfolio !== undefined) {
        out.push(b.overlay.replicatingPortfolio);
      }
    }
  }
  return out;
}

/**
 * True when every credit the sets bind says how it reads a shocked scenario. Only then may
 * the run carry parallel scenarios; the FTP block itself stays base-only, and the credit reads the shocks.
 */
export function creditReadsShocks(forms: readonly ReplicatingPortfolioForm[]): boolean {
  return forms.length > 0 && forms.every((f) => f.scenarioCurve !== undefined);
}

/** What a replicating-portfolio run refuses at entry, by the run option's name. */
export interface ReplicatingPortfolioOptIns {
  seg?: boolean;
  keyRate?: boolean;
  eveChannels?: boolean;
  nmdConvention?: string;
}

/** Refuse, in one sentence naming the option or the scenario, what cannot run beside the credit. */
export function checkReplicatingPortfolioRun(scenarios: readonly Scenario[], optIns: ReplicatingPortfolioOptIns, forms: readonly ReplicatingPortfolioForm[] = []): void {
  const readsShocks = creditReadsShocks(forms);
  for (const [name, on] of [["seg", optIns.seg], ["keyRate", optIns.keyRate], ["eveChannels", optIns.eveChannels]] as const) {
    if (on === true) {
      throw new Error(
        `run: ${name} cannot run beside the replicating-portfolio credit; that block rebuilds deposits on bumped curves ` +
          "for EVE, which a book priced on the credit does not carry, so drop one of the two",
      );
    }
  }
  if (optIns.nmdConvention === "regulatory" || optIns.nmdConvention === "shocked-level") {
    throw new Error(
      `run: nmdConvention "${optIns.nmdConvention}" slots deposits for EVE, and a book priced on the replicating-portfolio ` +
        "credit carries no EVE, so run it on the behavioral convention",
    );
  }
  for (const s of scenarios) {
    const deterministic = s.ratePathModel === undefined || s.ratePathModel === "deterministic";
    // A credit that says how it reads a shock takes parallel scenarios on the deterministic
    // path; the FTP block's own series stay base-only.
    if (readsShocks && s.rateSpec.kind !== "base" && !(s.rateSpec.kind === "parallel" && deterministic)) {
      throw new Error(
        `run: the replicating-portfolio credit reads parallel shocks on the deterministic path only; scenario "${s.id}" is ` +
          "not one, so run it on a parallel slate",
      );
    }
    if (!readsShocks && s.rateSpec.kind !== "base") {
      // The FTP block is base-only; the credit reads its steepener itself, so a shocked scenario adds nothing.
      throw new Error(
        `run: the replicating-portfolio credit is read on the base curve only, and it reads its steepener itself; ` +
          `scenario "${s.id}" shifts the curve, so run the base slate`,
      );
    }
    if (s.newBusiness.mode !== "static") {
      throw new Error(
        `run: the replicating-portfolio credit applies to static-runoff scenarios only; scenario "${s.id}" has new-business ` +
          `mode "${s.newBusiness.mode}"`,
      );
    }
  }
}

/** The notImplemented tag of a block a replicating-portfolio run leaves out, by block. */
export function replicatingPortfolioRefusal(block: "nii" | "eve", reading: "base-only" | "scenario" = "base-only"): NotImplemented {
  if (reading === "scenario") {
    // A credit read at every scenario, on a book whose NII and EVE are read on its other runs.
    const e3 = {
      nii:
        "the run's sets bind a replicating-portfolio credit read at every scenario; this run prices the transfer credit, " +
        "and the book's NII is read on its runs that bind no credit, so the nii block carries no scenario rather than a " +
        "second reading. The credit's margin rows read the deposit's equilibrium paid rate, a run-rate; the ftp block's " +
        "NIM bridge reconciles to the interest the positions' own terms carry, for the bridge only.",
      eve:
        "the run's sets bind a replicating-portfolio credit read at every scenario; this run prices the transfer credit, " +
        "and the book's EVE is read on its runs that bind no credit, so the eve block carries no scenario.",
    } as const;
    return makeNotImplemented(`${block}.replicating-portfolio`, e3[block]);
  }
  const reasons = {
    nii:
      "the run's sets bind the replicating-portfolio credit; deposits priced on it carry a repricing beta and no paid " +
      "rate, so their interest cost is not the book's, and the nii block carries no scenario rather than a number. The " +
      "ftp block's NIM bridge still reconciles its margins to the interest the positions' own terms carry, which reads " +
      "the deposits at a paid rate of 0: the FTP card's NII net is not a figure for the book.",
    eve:
      "the run's sets bind the replicating-portfolio credit; a credit run prices transfer rates, and the book's value " +
      "is read on its runs that bind no credit, so the eve block carries no scenario rather than a value on another book.",
  } as const;
  return makeNotImplemented(`${block}.replicating-portfolio`, reasons[block]);
}
