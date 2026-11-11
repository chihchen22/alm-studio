/**
 * Scenario model: a rate specification plus an assumption-set reference plus a
 * new-business strategy. Everything needed to project the book one way.
 *
 * The static vs dynamic balance sheet is one field, not two engines: static
 * runoff (mode "static", no rules) drives EVE and gap; new business and
 * reinvestment (mode "dynamic") drive projected NII. Both feed the same
 * cash-flow core (they are separated no more than the mathematics requires).
 */
import type { AssumptionSetId, ProductFamilyId, ScenarioId } from "./ids";

/**
 * One knot of a custom shock vector: the zero-curve shift, in basis points,
 * applied at the given tenor. Between knots the shift is linearly
 * interpolated; outside the knot range it extends flat (the same
 * interpolation the curve itself uses for zero rates).
 */
export interface CustomTenorShock {
  /** Tenor in years; finite, >= 0, strictly ascending across the vector. */
  tenorYears: number;
  /** Shift at this tenor in basis points; finite. */
  shockBp: number;
}

/**
 * Rate specification. The base curve is bootstrapped from the run's market
 * snapshot; this says how to shock it.
 *  - "base": no shock.
 *  - "parallel": uniform bp shift across all tenors (the IRRBB grid).
 *  - "twist": non-parallel; shortBp at the front, longBp at the long end,
 *    linearly interpolated through the pivot tenor.
 *  - "custom": an arbitrary per-tenor bp vector (static shock), linearly
 *    interpolated between knots and flat beyond them. Generalizes both
 *    "parallel" (one knot) and "twist" (three knots); additive arm.
 */
export type RateSpec =
  | { kind: "base" }
  | { kind: "parallel"; shockBp: number }
  | { kind: "twist"; shortBp: number; longBp: number; pivotYears: number }
  | { kind: "custom"; shocks: CustomTenorShock[] };

/**
 * The IRRBB parallel grid the prototype always covers, as shock sizes in bp.
 * Config that pins the regulatory convention across parallel modules, not
 * a computed result: base, plus/minus 100, plus/minus 200.
 */
export const REGULATORY_SHOCKS_BP: readonly number[] = [0, 100, -100, 200, -200];

/**
 * How runoff in a family is reinvested under the dynamic balance sheet.
 *  - "runoff": reinvest maturing plus prepaid principal into new instruments.
 *  - "flat": hold the family balance constant (reinvest to par).
 *  - "growth": grow the family balance at monthlyGrowthRate.
 * New-business coupon = reinvestment index + spreadOverIndexBp. Target
 * achievement is not guaranteed: if runoff already exceeds the target the
 * strategy under-hits and the shortfall is reported, not hidden (a silent
 * under-hit is a rejected behavior).
 */
export interface NewBusinessRule {
  familyId: ProductFamilyId;
  reinvest: "runoff" | "flat" | "growth";
  monthlyGrowthRate?: number;
  spreadOverIndexBp?: number;
  termMonths?: number;
  /**
   * The product the family's new volume is, beside the term and spread above. Absent
   * means today's rule, a fixed-rate bullet at the par swap rate over the term plus the spread, and the sweep runs
   * exactly the code it ran before (byte-identical results). Present, every tranche is built from the template and
   * reads the scenario's rate path from its own origination month (the forward-start path).
   */
  template?: NewBusinessTemplate;
}

/**
 * How a new-volume tranche's rate is set: locked at origination, reset on an index, or a deposit's
 * own paid rate: the family's static deposit rate on a non-interest-bearing deposit, its beta repricing on an
 * interest-bearing one.
 */
export type NewBusinessRateType = "fixed" | "floating" | "deposit";

/**
 * How a new-volume tranche repays principal: all at maturity, a level payment, equal principal each month, or a deposit's balance running off by the family's decay model ("decay", deposits only).
 */
export type NewBusinessAmortization = "bullet" | "level-pay" | "linear" | "decay";

/**
 * Whether a new-volume tranche carries its family's behavioral model. "family": the tranche runs the
 * family's effective model, the one its bindings and position values give a new position of the family, aged from its
 * own origination (prepayment on a loan or mortgage, decay and repricing on a deposit). Absent: the tranche is
 * contractual, as every S2b-1 template was, so a stored template keeps its bytes.
 */
export type NewBusinessBehavior = "family";

/** The allowed index tenors of a floating template, in months: the index is also the reset period. */
export const FLOATING_INDEX_TENORS_MONTHS: readonly number[] = [1, 3, 6, 12];

/**
 * A new-volume product template. The term and the spread stay on the rule (termMonths,
 * spreadOverIndexBp), so a template only says what kind of product the volume is.
 *  - fixed: the coupon is locked at origination at a base rate plus the spread. The base rate is, by default
 *    (`fixedIndex` absent or "matched", fix round M3), the matched funding rate of the tranche's own schedule: the rate
 *    that par-matches its principal schedule (term and amortization) on the scenario's discount factors from its
 *    origination month plus the term liquidity premium, the kernel's `parMatchedRate`, the rate its FTP charges. So a
 *    0 bp product earns a 0 FTP margin. `fixedIndex: "swap"` instead prices it off the par swap rate over
 *    `indexTenorMonths` (a learner's choice; a swap rate that does not match the schedule leaves a margin of its own).
 *  - floating: the coupon resets every `indexTenorMonths` months to the scenario's one-month rate compounded over that
 *    period (the plain one-month rate when it is 1) plus the spread, read from the path at the tranche's own month.
 *  - deposit: a new deposit cohort of the family's own kind, its balance running off by the family's
 *    decay model and its paid rate the family's own (amortization "decay", index tenor 1, behavior "family", spread 0).
 * `behavior: "family"` gives a loan or mortgage tranche its family's prepayment model where the product can
 * carry it; absent, the tranche is contractual (every S2b-1 template).
 */
export interface NewBusinessTemplate {
  rateType: NewBusinessRateType;
  amortization: NewBusinessAmortization;
  /** Fixed and swap-priced: the swap tenor. Floating: the index tenor and reset period. Fixed and matched: not read (the term is written). Deposit: 1. */
  indexTenorMonths: number;
  /** Fixed only: "matched" (the default when absent) or "swap". Never written on a floating template. */
  fixedIndex?: NewBusinessFixedIndex;
  /** "family" carries the family's behavioral model; absent, contractual. Required on a deposit template. */
  behavior?: NewBusinessBehavior;
}

/** What a fixed template's base rate is (fix round M3): its own matched funding rate, or a par swap rate at a tenor. */
export type NewBusinessFixedIndex = "matched" | "swap";

/** New-business / rollover strategy. Static runoff sets mode "static", no rules. */
export interface NewBusinessStrategy {
  mode: "static" | "dynamic";
  rules: NewBusinessRule[];
}

/** A scenario: rate path, assumption set, new-business strategy. */
export interface Scenario {
  id: ScenarioId;
  label: string;
  rateSpec: RateSpec;
  assumptionSetId: AssumptionSetId;
  newBusiness: NewBusinessStrategy;
  /**
   * Which registered rate-path model builds this scenario's path.
   * Absent means "deterministic", the shipped model, so every existing request
   * is unchanged. A model id no mounted plugin registered is a compile refusal,
   * not a run-time throw.
   */
  ratePathModel?: string;
}

/** When a shock is applied. Ramp is typed in piece 1 and executed later. */
export type ShockTiming =
  | { kind: "immediate" }
  | { kind: "ramp"; months: number };

/**
 * Macro paths the behavioral chain may consume. Units are stated here because
 * nothing else states them: `unemploymentPath` is a decimal fraction per month
 * (0.042 is 4.2 percent, not 4.2), and `housePriceIndexPath` is an index ratio
 * with base 1.0 (1.03 is three percent above the as-of level, not an index of
 * 103). Both arrays are monthly, index 0 being the first projected month, and
 * both must be at least as long as the run's horizon; a shorter array is a
 * compile refusal, never a silently extended one.
 */
export interface EnvironmentSpec {
  housePriceIndexPath?: number[];
  unemploymentPath?: number[];
}

/**
 * A scenario as authored in a plan or a library. Six fields are optional and
 * each means something specific:
 *  - `label`: display name; defaults to `id` when absent.
 *  - `timing`: when the shock applies; ramp is typed and refused at compile
 *    until a time-varying shock exists (round-2 ruling 12).
 *  - `environment`: typed and refused at compile; macro paths are market
 *    data, mapped in the assumption set (`macroBindings`), not a scenario field.
 *  - `assumptionSetId`: taken from the plan's inputs when absent.
 *  - `newBusiness`: taken from the balance plan when absent.
 *  - `ratePathModel`: the registered model that builds the path; absent means
 *    "deterministic".
 */
export interface ScenarioDefinition {
  id: ScenarioId;
  label?: string;
  rateSpec: RateSpec;
  timing?: ShockTiming;
  environment?: EnvironmentSpec;
  assumptionSetId?: AssumptionSetId;
  newBusiness?: NewBusinessStrategy;
  ratePathModel?: string;
}

/** A named, versioned set of scenario definitions. Data, hashable. */
export interface ScenarioLibrary {
  schemaVersion: "1.0.0";
  id: string;
  label: string;
  scenarios: ScenarioDefinition[];
}
