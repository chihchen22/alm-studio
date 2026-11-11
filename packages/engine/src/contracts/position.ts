/**
 * Position and portfolio model.
 *
 * A balance sheet is not a flat Instrument[]. A Position is a plain data record
 * that carries kernel instrument terms plus its COA placement, nothing more.
 * Two design points drive the shape:
 *
 *  - 100k positions must be cheap. A Position is a small POJO holding `terms`,
 *    not a live kernel Instrument. The engine instantiates the concrete
 *    Instrument from `terms` inside the cash-flow loop and discards it at once,
 *    reducing its Cashflow[] straight into typed-array bucket accumulators. No
 *    per-position result object survives the loop.
 *
 *  - Behavioral parameters are NOT embedded in the position. The overlay that
 *    applies is resolved from the run's AssumptionSet by familyId. This is the
 *    source-data separation: a position is an observed fact; an
 *    assumption is a separate, swappable layer the AI authors.
 */
import type {
  FixedLoanTerms,
  FloatingLoanTerms,
  MortgageTerms,
  NMDBetaTerms,
  NMDTerms,
} from "@alm/kernel";
import type { CdTerms } from "../cd/terms";
import type { HousingParams } from "./macroFactors";
import type { CommitmentTerms } from "../commitment/terms";
import type { SwapTerms } from "../swap/terms";
import type { NonRateTerms } from "../nonRate";
import type { ChartOfAccounts } from "./chartOfAccounts";
import type { DimensionBag, DimensionTaxonomy } from "./dimensions";
import type { CoaNodeId, PortfolioId, PositionId, ProductFamilyId } from "./ids";

/**
 * Floating-loan terms plus the engine-side, optional `rateIndexId` (ALM Studio
 * Piece 7a). The id names a rate index the run's market carries; the
 * kernel loan ignores the extra key. It is read for `floating-loan` terms only,
 * which covers floating term funding. A floater that names no index resets on
 * the one-month benchmark exactly as before.
 *
 * `fundingTenorMonths`: the floater's funding tenor in whole months, an opt-in. With it, the
 * FTP block reads each leg at its own tenor: the IR FTP at the reset tenor
 * (the benchmark forward over the reset window, on the curve's bond-equivalent quoting basis) and the liquidity FTP
 * at the funding tenor (the term liquidity premium there). Absent, the kernel's reading exactly as before: both legs
 * par-matched on the full principal stream (a term rate), and a monthly series that charges the premium at the reset
 * tenor. The kernel loan ignores the key.
 */
export type EngineFloatingLoanTerms = FloatingLoanTerms & { rateIndexId?: string; fundingTenorMonths?: number };

/**
 * Mortgage terms plus the engine-side, optional `housing` group (ALM Studio
 * Piece 7b). The overlay merge writes it only for a family the run's set maps
 * to a house-price path, so its presence means the position reads that path;
 * the kernel mortgage ignores the extra key. Intake refuses it on a raw position.
 *
 * `prepayMidpointOffsetBp`: basis points added to
 * the S-curve midpoint (`cprParams.inflection`) of a four-factor prepay overlay
 * when the overlay replaces this position's `cprParams`. It carries a cohort's
 * own refinancing-incentive fold relative to its family's binding (the granular
 * Agency MBS cohorts, whose notes differ from the note the binding was folded
 * at), so the set still governs every other parameter and the midpoint itself.
 * The position's own `cprParams` already carry the fold; the offset acts only
 * through an overlay. Absent, the overlay applies as written. The kernel
 * mortgage ignores the key.
 */
export type EngineMortgageTerms = MortgageTerms & { housing?: HousingParams; prepayMidpointOffsetBp?: number };

/**
 * The constant prepayment a `fixed-loan` carries.
 * Written only by a constant-cpr prepay overlay; fractions. `annualCpr` drives
 * the cash flows on every rate path; `stressAnnualCpr`, when present, is the
 * speed the moderate and severe liquidity stress rows read instead.
 */
export interface FixedLoanPrepay {
  annualCpr: number;
  stressAnnualCpr?: number;
}

/**
 * Fixed-loan terms plus the engine-side, optional `prepay` group. Present, the
 * factory builds the engine's ConstantCprFixedLoan (../loanPrepay); absent,
 * the kernel FixedLoan exactly as before. The kernel loan ignores the key.
 */
export type EngineFixedLoanTerms = FixedLoanTerms & { prepay?: FixedLoanPrepay };

/**
 * The full beta form of an interest-bearing deposit: a deposit-rate
 * schedule. With beta(r) the S-curve of the binding (or `staticBeta` in its place), r the short rate in percent:
 *
 *   beta_eff(r) = beta(r) x (1 - delta x v), the multiplier clipped to [0, 2]
 *   D*(r)       = alpha + beta_eff(r) x r
 *   D(m)        = D(m-1) + lambda x (D* - D(m-1)), from D(0) the paid rate at the base state
 *
 * delta is `deltaUp` after a rise in the short rate and `deltaDown` after a fall. The short rate is a level:
 * the base state plus the scenario's shift at tenor zero, held for the whole horizon (an instantaneous shock).
 * Written only by a deposit-beta overlay that carries it; the kernel deposit ignores the key.
 */
export interface DepositBetaFullForm {
  /** The intercept alpha, in percent, added to beta_eff(r) x r. */
  alphaPct: number;
  /** The dampening coefficient after a rise in the short rate. */
  deltaUp: number;
  /** The dampening coefficient after a fall in the short rate. */
  deltaDown: number;
  /** The volatility ratio v (realized short-rate volatility over its sample mean), held for the whole horizon. */
  volRatio: number;
  /** The base state: the short rate, in percent, the scenarios shift from. */
  baseShortRatePct: number;
  /** The direction of the last move at the base state; it picks the multiplier the base scenario reads. */
  baseLastMove: "rise" | "fall";
  /** A constant beta in place of the S-curve: the static comparator. Absent, the binding's S-curve. */
  staticBeta?: number;
  /** The paid rate, in percent, the partial adjustment starts from. Absent, this form's own rate at the base state. */
  startPaidRatePct?: number;
  /** Balances are held flat: the switch that turns the deposit's decay off. The only setting built. */
  balances: "flat";
  /** The core life, in years, the shocked-level slotting reads. Absent, the prescribed five years. */
  coreLifeYears?: number;
}

/**
 * How a full-form deposit is slotted for EVE, written at run entry by the deposit convention:
 * "frozen" is the regulatory arm (capped pass-through and core share at their base-date values), "shocked-level"
 * the behavioral arm (core share 1 - beta_eff at the shocked level). Absent, the deposit runs unslotted.
 */
export type DepositSlotting = "frozen" | "shocked-level";

/**
 * NMD-B terms plus the engine-side, optional `fullBeta` group and `depositSlotting` mark. With `fullBeta`, the
 * factory builds the engine's FullBetaDeposit (../nmd/fullBeta.ts); absent, the kernel NMDBeta exactly as before.
 */
export type EngineNMDBetaTerms = NMDBetaTerms & {
  fullBeta?: DepositBetaFullForm;
  depositSlotting?: DepositSlotting;
  /** The replicating-portfolio credit of a full-form deposit, written by its deposit-beta overlay. */
  replicatingPortfolio?: ReplicatingPortfolioForm;
};

/**
 * The component decay form of a non-maturity deposit: a component projection
 * form on a dated monthly rate path. With R the monthly retention, mu0 the survivor drift and phi the rate coefficient:
 *
 *   B(t) = B(0) x prod_{s=1..t} R x (1 + mu0 + phi x x_s)
 *   x_s  = max(0, r_s + shift - mean of the `lookbackMonths` realized month-ends before month s)
 *
 * r_s is the dated series in percent. Projection month s reads the s-th month of the window. The scenario's level
 * shift is added to the window months only, so the trailing benchmark stays on realized history. Past the window the
 * driver holds its last window value. With `staticShare` the deposit is the static bifurcation instead: that share
 * runs off on the frozen base schedule (no shift) in every scenario, and the rest leaves overnight.
 * Written only by an nmd-decay overlay that carries it; the kernel deposit ignores the key.
 */
export interface ComponentDecayForm {
  /** The monthly retention R, a fraction in (0, 1]. */
  retention: number;
  /** The survivor drift mu0 per month, a fraction (0.0028939 is +0.29 percent a month). */
  drift: number;
  /** The rate coefficient phi per month per percentage point of the driver, a fraction (negative shrinks the book). */
  coefficientPerPp: number;
  /** The trailing benchmark's length in months: the mean of that many realized month-ends before each window month. */
  lookbackMonths: number;
  /** The dated monthly series: its first month ("YYYY-MM"), what it is, and its monthly values in percent (the shipped SOFR file holds monthly averages). */
  series: { firstMonth: string; label: string; valuesPct: number[] };
  /** The dated window, first and last month ("YYYY-MM"): projection month 1 reads the window's first month. */
  window: { firstMonth: string; lastMonth: string };
  /** Past the window the driver holds its last window value: the only setting built. */
  beyondWindow: "hold-last";
  /** The static bifurcation: the stable share on the frozen base schedule, the rest overnight. Absent, the dynamic form. */
  staticShare?: number;
}

/**
 * NMD terms plus the engine-side, optional `componentDecay` group. With it, the factory builds the engine's
 * ComponentDecayDeposit (../nmd/componentDecay.ts); absent, the kernel NMDeposit exactly as before.
 * Teach slice E2 adds two more optional groups: `linearDecay` (the factory builds LinearDecayDeposit) and
 * `replicatingPortfolio` (the FTP block prices the deposit's credit on its replicating portfolio).
 */
export type EngineNMDTerms = NMDTerms & {
  componentDecay?: ComponentDecayForm;
  linearDecay?: LinearDecayForm;
  replicatingPortfolio?: ReplicatingPortfolioForm;
};

/**
 * A straight-line runoff: a teaching deposit whose balance falls by the same
 * amount every month and is gone after `horizonMonths`: B(t) = B(0) x max(0, 1 - t / n). With it, the factory builds
 * the engine's LinearDecayDeposit (../nmd/linearDecay.ts); the terms' `maturityMonths` must equal n. A position field,
 * because the runoff is the teaching instrument's own setting, not a behavioral estimate.
 */
export interface LinearDecayForm {
  /** n, the months the runoff takes, a whole number from 1. */
  horizonMonths: number;
}

/**
 * The replicating-portfolio credit of a deposit. The
 * beta share (the terms' `beta`) rolls overnight on the shortest node, one month. The share that does not reprice is
 * laid down by `construction`:
 *
 *   "life-target"  on the pillars of `pillarGridMonths`: the pillar whose life (k + 1) / 2 is the deposit's life, or
 *                  the two whose lives bracket it, blended so the blend's life is the deposit's life;
 *   "pillar"       on the one pillar of `pillarMonths`, whatever the deposit's life (Treasury's position case, RP-B);
 *   "strip"        struck once on the deposit's own runoff (the like-for-like matched-maturity strip);
 *   "static-share" the static bifurcation's credit: the deposit's static share s of the part that
 *                  does not reprice on the pillars of `pillarGridMonths` blended to the frozen base life, the rest on
 *                  the one-month bullet; liquidity s at the base life and (1 - s) at the one-month premium.
 *
 * Each pillar earns the new-money par rate of a k-month bullet. The liquidity credit is the term liquidity premium at
 * the life of the whole balance's runoff, paid on the whole balance. `haircutMonths` adds the haircut reading (a
 * shorter runoff) as information. `steepener` re-reads the rate credit on a steepened curve. Written onto nmd terms
 * by an nmd-decay overlay that carries it; the deposit must carry a linear decay.
 */
export interface ReplicatingPortfolioForm {
  construction: "life-target" | "pillar" | "strip" | "static-share";
  /** The pillar tenors in months, ascending, that the life-target blend chooses from. Life-target only. */
  pillarGridMonths?: number[];
  /** The one pillar's tenor in months. Pillar only. */
  pillarMonths?: number;
  /** A haircut ladder's runoff months, read as information beside the credit. */
  haircutMonths?: number;
  /**
   * The steepener: each par quote shifted by topBp x (t - t1) / (topYears - t1) below topYears and by topBp from
   * there, t1 the shortest quote (so it is unshifted); the term liquidity premium unchanged; the curve re-bootstrapped.
   */
  steepener?: { topBp: number; topYears: number };
  /**
   * Where the deposit's life and liquidity ladder come from. Absent, the straight-line runoff
   * (the deposit's `linearDecay`). "balance-path": the deposit's own projected balance under the scenario,
   * run off in full, its life the WAL of that path (a component decay deposit). "capped": a fixed life of
   * `months`, a cap on the core pillar (for example 60 months on a flat full-form book).
   */
  life?: { source: "balance-path" } | { source: "capped"; months: number };
  /**
   * The beta share the credit reads. Absent, the deposit's own: the terms' `beta` on an nmd,
   * beta_eff at the scenario's level on a full-form nmd-b. "s-curve-ceiling": the top of the binding's S-curve.
   * "fixed": a stated value, an FTP assumption that leaves the deposit and its paid rate as they are.
   */
  beta?: { source: "s-curve-ceiling" } | { source: "fixed"; value: number };
  /**
   * How the credit reads a shocked (parallel) scenario. "hold-base": the curve is held at the
   * base and only the deposit (its life, its beta) moves with the scenario. "shift": the tranches are
   * re-priced on the scenario's own shifted curve, the term liquidity premium unchanged. Absent, the credit
   * runs on the base scenario only.
   */
  scenarioCurve?: "hold-base" | "shift";
}

/**
 * Instrument terms a Position can carry: the five frozen kernel Instrument
 * implementations plus the engine-side `cd` cohort-book arm. The discriminant is `terms.type`, which the engine's instrument
 * factory switches on. MBS pools are represented as `mortgage` terms with a
 * pool CPR parameter set; investments, FHLB advances, and borrowings as
 * `fixed-loan` (bullet) or `floating-loan` terms (term funding stays
 * contractual).
 *
 * CDs: a `cd` position carries a COHORT BOOK (`CdTerms.cohorts`),
 * walked jointly by the kernel's competing-risk early-withdrawal model through
 * the engine adapter (`../cd/cdInstrument.ts`). One position per family book,
 * not one per ticket: the kernel's severity part-1 log-balance covariate is
 * standardized live against the cross-section of live cohorts, so isolated
 * single-cohort walks would be a different (degenerate) model. `CdTerms` is
 * structurally `Omit<InstrumentTermsBase, "type"> & { type: "cd"; ... }`
 * (compile-time seam check in ../cd/terms.ts), so every consumer that reads
 * terms structurally — id, notional, maturityMonths, side,
 * originationOffsetMonths — is unaffected by the widening.
 *
 * Seasoning (D3a): the kernel base terms carry
 * `originationOffsetMonths` (negative = seasoned), which the kernel itself
 * ignores. The engine rules it the seasoning re-anchor directive: 0 means the
 * terms are the remaining representation anchored at the portfolio as-of date
 * (the default everywhere, and how a seasoned mortgage is imported — remaining
 * terms plus its native `ageMonths`); a negative value means the terms are
 * origination-anchored and the engine shifts every cashflow bucket by the
 * offset, dropping the elapsed months. Supported for `fixed-loan` terms only
 * (exact, path-independent); other types refuse with typed guidance, and the
 * run pipeline refuses all nonzero offsets until the duration engine is
 * offset-aware. Single source of truth: `../portfolio/seasoning.ts`. No
 * engine-level duplicate of the field exists by design (the plan's
 * "add originationOffsetMonths? to Position" predates the discovery that the
 * kernel terms already carry it; a second field could disagree with the
 * first).
 *
 * Commitments: an undrawn committed line is the engine-side
 * `commitment` arm, and it is OFF balance sheet, so its `notional` is undrawn
 * optional capacity rather than a booked balance.
 *
 * Swaps: a plain vanilla interest rate swap is the engine-side
 * `swap` arm, built as two kernel bullet legs (../swap/swapInstrument.ts).
 * Its family declares side "derivative"; see ../swap/derivatives.ts for what
 * every fold does with it.
 */
export type PositionTerms =
  | EngineFixedLoanTerms
  | EngineFloatingLoanTerms
  | EngineMortgageTerms
  | EngineNMDTerms
  | EngineNMDBetaTerms
  | CdTerms
  | CommitmentTerms
  | SwapTerms
  | NonRateTerms;

/**
 * Instrument-type discriminants the engine's position layer accepts: the five
 * frozen kernel types plus the engine-side "cd", "commitment" and "swap" arms. This is
 * the union a ProductFamilyDef declares (contracts/chartOfAccounts.ts) and the
 * generator's family catalogue uses; the kernel's own `InstrumentType` stays
 * untouched (frozen kernel).
 */
export type EngineInstrumentType = PositionTerms["type"];

// Re-export the cd terms types at the contract layer so consumers of the
// position contract need no deep import into ../cd.
export type { CdTerms, CdCohortSpec } from "../cd/terms";
export type { CommitmentTerms, CommitmentDrawPath } from "../commitment/terms";
export type { SwapTerms, SwapDirection } from "../swap/terms";
// Studio slice S3a-1 follow-up: a non-rate-sensitive balance, held at book (../nonRate).
export type { NonRateTerms } from "../nonRate";

/** One on-book instrument as stored in the portfolio. */
export interface Position {
  id: PositionId;
  familyId: ProductFamilyId;
  coaNodeId: CoaNodeId;
  terms: PositionTerms;
  /** Authored tags, validated against `PortfolioSpec.taxonomy` at intake. */
  dimensions?: DimensionBag;
  /**
   * Schema 1.9.0: a per-position discount spread in basis
   * points, read only on the "spread-consistent" discount basis. Absent means
   * 0. Forced to 0 for deposit terms (nmd and nmd-b) and their children.
   */
  discountSpreadBp?: number;
  /**
   * Schema 1.9.0: the id of the position this one was split from by the
   * regulatory deposit-convention transform. Absent on an authored position.
   */
  parentPositionId?: string;
  /**
   * Schema 1.9.0: "excluded" keeps the position out of the REPRICING ladder
   * only; liquidity, NII, EVE and SEG are unchanged. The regulatory transform
   * sets it on every core rung and on the non-interest-bearing non-core slice
   * (the ALCO rule: core deposits are not rate-sensitive).
   */
  repricingTreatment?: "excluded";
}

/**
 * A named book of positions over one chart of accounts, as of one date. Self
 * contained: the COA travels with the positions so the whole portfolio hashes
 * as a single input snapshot.
 */
export interface PortfolioSpec {
  id: PortfolioId;
  label: string;
  /** ISO date of the position snapshot (the book of record). */
  asOf: string;
  coa: ChartOfAccounts;
  /** The declared dimensions. Optional; a book with none carries only the derived tags. */
  taxonomy?: DimensionTaxonomy;
  positions: Position[];
}

/** Handle returned by loadPortfolio; positions live in an in-memory registry. */
export interface PortfolioHandle {
  id: PortfolioId;
  positionCount: number;
  asOf: string;
}
