/**
 * Assumption-set model: the serializable, diffable object the natural-language
 * layer compiles to.
 *
 * An AssumptionSet is DATA, not code. The AI layer authors it and the engine
 * executes it; no code path in the AI layer computes a balance-sheet number.
 * This is the division of labor the prototype exists to prove: the language
 * model authors typed objects and narrates computed decompositions, and it
 * never does arithmetic on the book.
 *
 * Each overlay wraps the parameters the vendored kernel behavioral model
 * actually consumes, so a compiled set is directly executable: no translation
 * layer sits between what the AI writes and what the kernel runs.
 */
import type { JsonValue } from "@alm/harness";
import type { BetaSCurveParams, MBSParams, NMDParams } from "@alm/kernel";
import type { DerivedFrom } from "./derivation";
import type { DimensionPredicate } from "./dimensions";
import type { AssumptionSetId, ProductFamilyId } from "./ids";
import type { HousingParams, MacroBinding } from "./macroFactors";
import type { ComponentDecayForm, DepositBetaFullForm, ReplicatingPortfolioForm } from "./position";

/**
 * Prepayment overlay. Either the kernel four-factor CPR params (refi S-curve,
 * seasoning ramp, calendar seasonality, burnout) or a constant CPR. The
 * four-factor arm may carry the optional, all-or-none `housing` group (ALM
 * Studio Piece 7b): the illustrative house-price response a mapped macro path
 * reads. Absent, the arm is exactly the kernel model.
 *
 * The constant arm drives a level-pay `fixed-loan`:
 * `annualCpr` is read by every rate scenario and by the business-as-usual row
 * of the liquidity stress ladder. The optional `stressAnnualCpr` is read only
 * by the moderate and severe rows of that ladder; absent, they read
 * `annualCpr` too. Both are fractions (0.161 means 16.1 percent CPR).
 */
export type PrepayOverlay =
  | { kind: "prepay"; model: "four-factor-cpr"; params: MBSParams; housing?: HousingParams }
  | { kind: "prepay"; model: "constant-cpr"; annualCpr: number; stressAnnualCpr?: number };

/**
 * Non-maturity decay overlay: the kernel decay-kernel parameter set. The optional `componentDecay` group (teach slice
 * E1) adds the component decay form on a dated rate path; the overlay merge then writes it onto the nmd
 * terms and the factory builds the engine's ComponentDecayDeposit, which does not read `params`. Absent, the overlay
 * is exactly the kernel model.
 *
 * The optional `replicatingPortfolio` group is the replicating-portfolio credit
 * construction; the merge writes it onto nmd terms that carry a linear decay, and the FTP block prices that deposit's
 * credit on it. Absent, the FTP block prices the deposit as before.
 */
export interface DecayOverlay {
  kind: "nmd-decay";
  params: NMDParams;
  componentDecay?: ComponentDecayForm;
  replicatingPortfolio?: ReplicatingPortfolioForm;
}

/**
 * Deposit-rate beta overlay: the kernel S-curve beta(r) parameter set. The optional `fullForm` group (teach slice
 * C4) adds the full form's intercept, dampening, base state and flat balances; the overlay merge then writes
 * it onto the nmd-b terms as `fullBeta`. Absent, the overlay is exactly the kernel model.
 */
export interface DepositBetaOverlay {
  kind: "deposit-beta";
  params: BetaSCurveParams;
  fullForm?: DepositBetaFullForm;
  /**
   * The replicating-portfolio credit of a full-form deposit, on a
   * capped life. The merge writes it onto the nmd-b terms beside `fullBeta`; it needs a full form.
   */
  replicatingPortfolio?: ReplicatingPortfolioForm;
}

/**
 * CD rollover overlay: the new-business rollover knobs for term deposits. The
 * prototype models CDs as contractual bullet liabilities plus this rule.
 *
 * The kernel's full competing-risk early-withdrawal model (cdBook) IS wired to
 * the Instrument hot loop: the `case "cd"` arm of `makeInstrument`
 * (../runtime/instrumentFactory.ts) builds a `CdBookInstrument`, and this
 * overlay sits beside that walk rather than standing in for it. The arm is
 * named rather than given a line number on purpose: the first version of this
 * pointer cited a line, and inserting the commitment arm above it moved the
 * target. An earlier version of this comment
 * said the walk was unwired, which stopped being true when the factory arm
 * landed. On the original convention the walk reads no rate shock, so CD early
 * withdrawal is shock-invariant; on the corrected convention the run marks the book and the walk reads the curve of the path it
 * is projected on (../cd/corrections.ts).
 */
export interface CdRolloverOverlay {
  kind: "cd-rollover";
  /** Fraction of maturing balance that renews rather than running off. */
  renewalProbability: number;
  /** Spread over the reinvestment index applied to the renewed CD, in bp. */
  offeredSpreadBp: number;
  /** Tenor of the renewed CD, months. */
  termMonths: number;
}

/**
 * Commitment draw overlay: the authored monthly draw path for an
 * undrawn committed line. It REPLACES the path baked into the position's terms,
 * the relationship a prepay overlay has with a Mortgage's cprParams.
 *
 * Rates are fractions of what is STILL undrawn, not of the original limit, so
 * over-drawing is structurally impossible. `rampRates[k-1]` is month k;
 * `steadyRate` holds from month rampRates.length + 1 onward.
 *
 * The path is AUTHORED, not fitted, and it does not respond to the rate shock.
 */
export interface CommitmentDrawOverlay {
  kind: "commitment-draw";
  /** Monthly draw fractions, month 1 first. Each finite and in [0, 1]. May be empty. */
  rampRates: number[];
  /** The fraction holding from month rampRates.length + 1 onward. Finite, in [0, 1]. */
  steadyRate: number;
}

/**
 * Loan client-rate overlay: ONE total spread, in basis points, over
 * the 10-year forward par rate on the run's curve. Flat carry: the spread holds
 * for the whole horizon, so the client rate moves one for one with the
 * benchmark. The spread is an authored value, not fitted. It has no consumer
 * yet: the static applier is a no-op and no projection reads the rate.
 */
export interface LoanClientRateOverlay {
  kind: "loan-client-rate";
  /** The only public client-rate model. */
  model: "flat-carry";
  /** Total spread over the 10-year forward par rate, bp. Finite, in [0, 1000]. */
  totalSpreadBp: number;
}

/**
 * An overlay whose behavior a mounted plugin owns. The discriminant
 * stays a literal so the six built-in arms keep narrowing; `registeredKind` is
 * the name the behavioral registry is keyed by. `params` is opaque to the
 * engine: the plugin that registered the kind is the only thing that reads it.
 */
export interface RegisteredOverlay {
  kind: "registered";
  registeredKind: string;
  params: JsonValue;
}

/** The six kinds the engine itself executes. */
export type BuiltinOverlay =
  | PrepayOverlay
  | DecayOverlay
  | DepositBetaOverlay
  | CdRolloverOverlay
  | CommitmentDrawOverlay
  | LoanClientRateOverlay;

export type BuiltinOverlayKind = BuiltinOverlay["kind"];

export type BehavioralOverlay = BuiltinOverlay | RegisteredOverlay;

/** The string the behavioral registry is keyed by, for any overlay. */
export function overlayKindOf(overlay: BehavioralOverlay): string {
  return overlay.kind === "registered" ? overlay.registeredKind : overlay.kind;
}

/**
 * The key two whole-family bindings of one kind on one family collide on:
 * "<family>::<kind>", the kind by the registry's name so two plugins' kinds on
 * one family stay distinct. Null for a binding with a selector key present, an
 * empty one included; a selector's overlap depends on the book's positions
 * (compile, checkBindingOverlap). The one rule bindAssumptions (at save) and
 * resolveAssumptions (at run) both apply (ALM Studio Polish 2 C1).
 */
export function wholeFamilyKey(b: OverlayBinding): string | null {
  return b.selector === undefined ? `${b.familyId}::${overlayKindOf(b.overlay)}` : null;
}

/** Binds one behavioral overlay to one product family. */
export interface OverlayBinding {
  familyId: ProductFamilyId;
  overlay: BehavioralOverlay;
  /** Version tag of the underlying calibrated model, carried into provenance. */
  modelVersion: string;
  /** Narrows the binding to the positions of its family that match. Absent matches the whole family. */
  selector?: DimensionPredicate;
}

/**
 * The assumption set. `id` is stable and authored; `contentHash` is filled by
 * the engine at bind time and must never be authored by hand.
 */
export interface AssumptionSet {
  schemaVersion: string;
  id: AssumptionSetId;
  label: string;
  bindings: OverlayBinding[];
  /**
   * Engine-populated hash (runtime/assumptionSetHash.ts): over `bindings` alone
   * when the set carries no macro mapping, so no stored hash moves; over
   * `bindings` and `macroBindings` when it does. Omit when authoring.
   */
  contentHash?: string;
  /**
   * The macro mapping: which macro
   * series feeds which family's house-price response. Outside `bindings`, so
   * overlay kinds, licensing and wholeFamilyKey are untouched. Absent means no
   * mapping; an empty list is refused at bind. One series per run in 7b.
   */
  macroBindings?: MacroBinding[];
  /**
   * Written only by deriveAssumptionSet: the immediate
   * base and the ops that produced this set. It is not in the bindings
   * contentHash and is recorded on the derived set; never author it by hand.
   */
  derivedFrom?: DerivedFrom;
}

/** One field-level change between two assumption sets. */
export interface AssumptionDelta {
  familyId: ProductFamilyId;
  overlayKind: BehavioralOverlay["kind"];
  /** The predicate of the binding the delta belongs to, when it carries one. */
  selector?: DimensionPredicate;
  /** Dotted path into the overlay, e.g. "params.betaMax" or "offeredSpreadBp". */
  path: string;
  from: number | string | boolean | null;
  to: number | string | boolean | null;
}

/** Diff between a base assumption set and a compiled one. Diffable by design. */
export interface AssumptionDiff {
  baseId: AssumptionSetId;
  deltas: AssumptionDelta[];
  /** Present only when the two sets' macro mappings differ; null for a side with none. */
  macroBindings?: { from: MacroBinding[] | null; to: MacroBinding[] | null };
}
