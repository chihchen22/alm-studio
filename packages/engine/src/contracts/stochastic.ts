/**
 * Stochastic result envelope.
 *
 * The stochastic run mode emits its OWN envelope with its OWN schema version.
 * It never touches the deterministic RunResult: a Monte Carlo mean is a
 * statistic of a distribution, not an EVE, and the type system must make it
 * impossible to read one as the other. Every distribution field lives inside a
 * StochasticDistribution carrying its path count and standard error, so no
 * bare number in this envelope can masquerade as a deterministic result.
 *
 * Scope (amended by ADR-041): two rate models, Hull-White 1F (the
 * default) and, since envelope 0.3.0,
 * BGM by request; base scenario only, EVE and NII-12m distributions, default
 * 256 paths, calibration RMSE surfaced with the model's gate (Hull-White 5 bp,
 * BGM 10 bp; breach flagged, never absorbed), refusal without the volatility
 * surface the model calibrates to, quantiles bounded by what the path count
 * supports, seed load-bearing with byte-determinism per seed (a BGM envelope
 * apart from its wall-clock simulation.fixedCostMs). The HW envelope fields
 * are unchanged.
 */
import type { CurveDefaultStamp } from "./curveSetup";
import type { SavedCalibrationArm } from "../calibration/savedCalibration";
import type { NotImplemented } from "./errors";
import type { AssumptionSetId, RunId, ScenarioId } from "./ids";

/**
 * Serialized schema version of the StochasticRunResult envelope. Independent of
 * the deterministic RUN_RESULT_SCHEMA_VERSION by design: the two
 * schemas evolve separately so distribution semantics never leak into the
 * deterministic contract.
 * 0.2.0: the optional curveDefault stamp, additive.
 * 0.3.0: additive. `model` widens to StochasticModel;
 * `calibration` gains the BGM long-yield arm and the BGM override arm (the HW arms are untouched);
 * the optional `simulation` block, written on BGM runs only. An HW envelope differs from a 0.2.0
 * one in `schemaVersion` alone.
 */
export const STOCHASTIC_RESULT_SCHEMA_VERSION = "0.3.0";

/**
 * The schema stamp of an envelope that carries the `gap` block: 0.4.0, additive. Written only
 * when the request asked for `gap`; an envelope without it keeps STOCHASTIC_RESULT_SCHEMA_VERSION and its bytes.
 */
export const STOCHASTIC_GAP_SCHEMA_VERSION = "0.4.0";

/**
 * The schema stamp of an envelope whose `calibration` is the `saved-calibration` arm (a
 * run that used a saved fit), 0.5.0, additive; it may carry `gap` too. Written only on such a run; every other envelope
 * keeps its stamp and its bytes.
 */
export const STOCHASTIC_SAVED_CALIBRATION_SCHEMA_VERSION = "0.5.0";

/** The SEG horizon of the stochastic gap, months (slice 4b ruling). Fixed; not a request field. */
export const STOCHASTIC_GAP_HORIZON_MONTHS = 120;

/**
 * The size cap of a stochastic gap run, position-paths (slice 4b ruling 3): positions x nPaths above this is refused
 * before any simulation. About 2.8 ms per position per path at 120 months estimated on the granular book (the spike's
 * 30 minutes estimated over 10,000 x 64) and about 4.3 ms measured on a test book, so a run at the cap takes about 5 to 7.5
 * minutes.
 */
export const STOCHASTIC_GAP_SIZE_CAP = 100_000;

/**
 * The stochastic gap option (slice 4b ruling 1): `enabled: true` is its only field and only value. Absent means no
 * gap and a byte-identical envelope.
 */
export interface StochasticGapOption {
  enabled: true;
}

/**
 * The stochastic rate model a run names. `hull-white-1f` is the default when a
 * request names none; `bgm-lmm-2f` is the kernel's shifted-CEV LIBOR market model with Rebonato
 * two-factor volatility, displacement 0.05 and CEV exponent 0.5 (the engine of record).
 */
export type StochasticModel = "hull-white-1f" | "bgm-lmm-2f";

/**
 * The quantile set every distribution reports, as cumulative probabilities.
 * Pinned by ADR-019 (p5/p25/p50/p75/p95). Finer tails are refused, not
 * extrapolated: MIN_STOCHASTIC_PATHS below guarantees at least one path sits
 * beyond each reported tail point (N >= 1 / min(p, 1-p)).
 */
export const STOCHASTIC_QUANTILES: readonly number[] = [0.05, 0.25, 0.5, 0.75, 0.95];

/** Default Monte Carlo path count. Heavier runs belong behind RUN_PERF. */
export const DEFAULT_STOCHASTIC_PATHS = 256;

/**
 * Smallest admissible path count: the support bound of the widest pinned
 * quantile (p5/p95 need N >= 20 so the tail point is interpolated between real
 * order statistics, never extrapolated past the sample).
 */
export const MIN_STOCHASTIC_PATHS = 20;

/** Paths per antithetic pair (the kernel simulator's +Z/-Z pairing). */
export const PATHS_PER_PAIR = 2;

/**
 * HW calibration acceptance gate on the ATM cap surface, bp of normal vol
 * (alm-hull-white convention). A breach is SURFACED as `rmseGateBreached`,
 * never silently absorbed: on a steep cap term structure a one-factor model
 * legitimately fits above 5 bp (the vendored 2026-03-31 surface sits near
 * 7.8 bp), and that structural residual is a disclosure, not a defect.
 */
export const HW_RMSE_GATE_BP = 5;

/**
 * BGM calibration acceptance gate on the default subset of the long-yield volatility surface, bp
 * of normal vol. Reported, never refused: the curve default v2 fit sits near
 * 12.45 bp, and a breach is a disclosure in `rmseGateBreached`.
 */
export const BGM_RMSE_GATE_BP = 10;

/**
 * Fewest default-subset points a BGM calibration accepts (six Rebonato parameters plus two). A
 * long-yield block with fewer points in the kernel's 28-point default subset is refused.
 */
export const BGM_SUBSET_MIN_POINTS = 8;

/**
 * The tenors the BGM simulation saves per path, years: 1 day (the short-rate analog the discounting
 * and the rate fan read), 1 month, then 1, 2, 3, 5, 7, 10, 20 and 30 years.
 */
export const BGM_SAVED_TENORS_YEARS: readonly number[] = [1 / 360, 1 / 12, 1, 2, 3, 5, 7, 10, 20, 30];

/**
 * A caller-supplied BGM parameter set: the six Rebonato values and a stated
 * reason. Displacement and CEV stay fixed at the engine of record and are not overridable. Lives
 * here, not beside the HW override in the frozen HW module.
 */
export interface BgmModelOverride {
  a: number;
  b: number;
  c: number;
  d: number;
  beta: number;
  volScalar: number;
  /** The caller's stated reason for supplying parameters directly; non-empty. */
  reason: string;
}

/**
 * Closed bounds [min, max] of a BGM override: the kernel's fit bounds with the
 * volScalar floor opened from 0.01 to 0, so volScalar 0 is the zero-vol degeneracy probe.
 */
export const BGM_OVERRIDE_BOUNDS: Readonly<
  Record<"a" | "b" | "c" | "d" | "beta" | "volScalar", readonly [number, number]>
> = {
  a: [0, 5],
  b: [0, 5],
  c: [1e-3, 5],
  d: [0, 5],
  beta: [-1, 1],
  volScalar: [0, 2],
};

/** Monthly simulation step, years (alm-conventions monthly grid). */
export const STOCHASTIC_DT_YEARS = 1 / 12;

/** Months per year, for horizon-months <-> horizon-years conversion. */
export const MONTHS_PER_YEAR = 12;

/** Decimal-to-basis-points scale factor. */
export const BP_PER_UNIT = 1e4;

/** Trapezoidal accrual weight in the money-market discount reconstruction. */
export const TRAPEZOID_WEIGHT = 0.5;

/** The NII horizon the stochastic mode distributes, months (the pinned first NII horizon). */
export const STOCHASTIC_NII_HORIZON_MONTHS = 12;

/** One reported quantile: cumulative probability and the interpolated sample value. */
export interface StochasticQuantile {
  /** Cumulative probability in (0, 1), e.g. 0.05. */
  p: number;
  value: number;
}

/**
 * A Monte Carlo distribution summary. Every statistic carries its provenance:
 * the path count N and the standard error of the mean, so a reader can never
 * mistake `mean` for a converged deterministic figure (anti-fabrication specifics).
 */
export interface StochasticDistribution {
  /** Monte Carlo path count the statistics are computed over. */
  nPaths: number;
  /** Sample mean across paths. A STATISTIC, not a deterministic result. */
  mean: number;
  /**
   * Standard error of the mean, computed over ANTITHETIC-PAIR AVERAGES
   * (nPaths/2 independent samples), because the +Z/-Z paths within a pair are
   * negatively correlated and a naive per-path SE would misstate the
   * independence assumption. Zero for a degenerate (zero-vol) distribution.
   */
  standardError: number;
  /** Per-path sample standard deviation (n-1 denominator); dispersion, not SE. */
  stdev: number;
  min: number;
  max: number;
  /**
   * The pinned quantile set (STOCHASTIC_QUANTILES), linearly interpolated
   * between order statistics. Present in ascending p order.
   */
  quantiles: StochasticQuantile[];
}

/**
 * How the HW parameters were obtained. The calibrated arm carries the full fit
 * diagnostics with the RMSE gate; the override arm records verbatim that the
 * caller SUPPLIED the parameters (a verification seam and a stress lever), so
 * an override can never silently impersonate a market calibration.
 */
export type StochasticCalibrationSummary =
  | {
      source: "cap-atm-calibration";
      /** Mean-reversion speed, 1/year. */
      a: number;
      /** Instantaneous normal vol, decimal annualised. */
      sigma: number;
      /** Fit RMSE against the ATM cap normal vols, bp. */
      rmseBp: number;
      /** The acceptance gate the RMSE is judged against (HW_RMSE_GATE_BP). */
      rmseGateBp: number;
      /** True when rmseBp exceeds the gate. Surfaced, never absorbed. */
      rmseGateBreached: boolean;
      /** Number of ATM cap quotes the fit used. */
      nQuotes: number;
      /** Caplet underlying accrual, years (0.25 for SOFR 3M caps). */
      underlyingTau: number;
      /** Solver iterations consumed. */
      iterations: number;
    }
  | {
      source: "override";
      a: number;
      sigma: number;
      /** The caller's stated reason for supplying parameters directly. */
      reason: string;
    }
  | BgmLongYieldCalibration
  | BgmOverrideCalibration
  | SavedCalibrationArm;

/** One point of the long-yield volatility surface the BGM fit used, years. */
export interface BgmSubsetPoint {
  expiryYears: number;
  tenorYears: number;
}

/**
 * The BGM calibrated arm (0.3.0): the Rebonato parameters fitted to the kernel's default subset of
 * the long-yield volatility surface, with the fit diagnostics and the 10 bp gate.
 */
export interface BgmLongYieldCalibration {
  source: "long-yield-atm-calibration";
  a: number;
  b: number;
  c: number;
  d: number;
  beta: number;
  volScalar: number;
  /** Displacement of the shifted-CEV forward, held fixed at fit time (engine of record 0.05). */
  displacement: number;
  /** CEV exponent, held fixed at fit time (engine of record 0.5). */
  cevBeta: number;
  /** Fit RMSE against the subset's at-the-money normal vols, bp. */
  rmseBp: number;
  /** The acceptance gate the RMSE is judged against (BGM_RMSE_GATE_BP). */
  rmseGateBp: number;
  /** True when rmseBp exceeds the gate. Surfaced, never absorbed. */
  rmseGateBreached: boolean;
  /** Number of subset points the fit used. */
  nQuotes: number;
  /** The subset points the fit used, in grid order. */
  subset: BgmSubsetPoint[];
  /** Solver iterations consumed. */
  iterations: number;
}

/**
 * The BGM override arm (0.3.0): the caller SUPPLIED the Rebonato parameters. It shares `source:
 * "override"` with the HW override arm and is told apart by its `model` key, which the HW arm lacks.
 */
export interface BgmOverrideCalibration {
  source: "override";
  model: "bgm-lmm-2f";
  a: number;
  b: number;
  c: number;
  d: number;
  beta: number;
  volScalar: number;
  /** The caller's stated reason for supplying parameters directly. */
  reason: string;
}

/**
 * The BGM simulation block (0.3.0, BGM runs only): the kernel's safety-guard counts, the saved
 * tenors, and the fixed cost of calibration plus simulation plus reconstruction, milliseconds.
 */
export interface StochasticSimulationSummary {
  /** Evolutions where a log-forward excursion hit the ceiling guard. Zero in normal operation. */
  nCapFires: number;
  /** Evolutions where a log-forward excursion hit the floor guard. Zero in normal operation. */
  nFloorFires: number;
  /** Total forward evolutions the simulation performed. */
  nTotalEvolutions: number;
  /** The tenors saved per path, years (BGM_SAVED_TENORS_YEARS). */
  savedTenors: number[];
  /** Calibration plus simulation plus reconstruction, timed inside the BGM environment build, ms. */
  fixedCostMs: number;
}

/**
 * The discount-factor martingale diagnostics of the run's own path set.
 *
 *  - `correctedMaxAbsErrBp` is the identity the engine's discounting actually
 *    relies on: with the kernel's multiplicative martingale correction,
 *    E_p[D_p(t_k)] = P^M(0, t_k) at every step; this reports the max residual.
 *  - `rawTerminalErrBp` is the UNCORRECTED money-market DF drift at the run
 *    horizon (MC mean minus curve DF, bp). It is honestly nonzero: the vendored
 *    kernel's short rate omits the deterministic convexity shift phi(t), so the
 *    raw DF drifts systematically with horizon and the correction absorbs it.
 *    Reported so the correction's workload is visible, not hidden.
 *  - `terminalDfStandardError` is the antithetic-pair standard error of the
 *    corrected terminal DF across paths — the printed SE of the engine-level
 *    martingale check.
 */
export interface StochasticMartingaleCheck {
  /** max_k |E_p[D_p(t_k)] - P^M(0,t_k)|, bp, post-correction. */
  correctedMaxAbsErrBp: number;
  /** Uncorrected terminal-horizon DF drift (MC mean - curve DF), bp. */
  rawTerminalErrBp: number;
  /** Antithetic-pair SE of the corrected terminal DF (dispersion of D_p(T)). */
  terminalDfStandardError: number;
  /** The terminal horizon the raw drift and SE are measured at, years. */
  terminalYears: number;
}

/**
 * The stochastic run envelope (schemaVersion 0.1.0). A SEPARATE result from
 * the deterministic RunResult; nothing in here is an EVE or an NII — the
 * distributions are statistics of the Monte Carlo path set, each carrying its
 * N and standard error.
 */
export interface StochasticRunResult {
  schemaVersion: string;
  /**
   * Structural discriminant so no consumer can pattern-match this envelope as
   * a deterministic result (distribution semantics never touch the
   * deterministic schema).
   */
  kind: "stochastic-distribution";
  /** The rate model of the run; "hull-white-1f" on every envelope before 0.3.0. */
  model: StochasticModel;
  runId: RunId;
  /** The base scenario the distributions are conditioned on (base only). */
  scenarioId: ScenarioId;
  /** The assumption set the base scenario resolved. */
  assumptionSetId: AssumptionSetId;
  /** The request seed the RNG consumed. Load-bearing: it moves every number here. */
  seed: string;
  nPaths: number;
  horizonMonths: number;
  /** Discount basis of the per-path PV (mirrors the deterministic EVE default). */
  discountBasis: "all-in" | "risk-free";
  /**
   * Which curve the run's base curve built on, the same stamp the deterministic provenance
   * carries (additive 0.2.0). Not hashed: this envelope carries no hash.
   * Absent on archived 0.1.0 envelopes.
   */
  curveDefault?: CurveDefaultStamp;
  calibration: StochasticCalibrationSummary;
  martingale: StochasticMartingaleCheck;
  /** BGM runs only (additive 0.3.0); absent on HW envelopes and on every envelope before 0.3.0. */
  simulation?: StochasticSimulationSummary;
  /** EVE across paths: per-path (PV assets - PV liabilities). A distribution, not an EVE. */
  eveDistribution: StochasticDistribution;
  /** 12-month net interest income across paths (computeNII semantics per path). */
  nii12mDistribution: StochasticDistribution;
  /**
   * The gap distributions (additive 0.4.0): written only when the request asked for `gap`, and then the
   * envelope stamps STOCHASTIC_GAP_SCHEMA_VERSION. Statistics of the Monte Carlo path set, never a gap.
   */
  gap?: StochasticGapBlock;
  /**
   * Typed refusals for the paths this mode deliberately does not build:
   * shocked-scenario distributions and dynamic new business. Carried
   * in-envelope, mirroring the FTP block's in-block refusal convention.
   */
  notImplemented: NotImplemented[];
}

/** One distribution per balance-sheet side and their net (assets minus liabilities), each across the path set. */
export interface StochasticSideDistributions {
  assets: StochasticDistribution;
  liabilities: StochasticDistribution;
  /** assets - liabilities, computed per path and then summarised (never a difference of two summaries). */
  net: StochasticDistribution;
}

/** One repricing band of the stochastic gap: the SEG that reprices in [startMonth, endMonth), bucket units. */
export interface StochasticRepricingBand {
  label: string;
  startMonth: number;
  endMonth: number;
  /** Signed net SEG repricing in the band (signed: a fixed asset reads +N): outstanding(start) - outstanding(end). */
  net: StochasticDistribution;
  /** The running sum of the band values through this band, per path, then summarised. */
  cumulative: StochasticDistribution;
}

/** One liquidity band of the stochastic gap: the EBP balance that runs off in [startMonth, endMonth). */
export interface StochasticLiquidityBand {
  label: string;
  startMonth: number;
  endMonth: number;
  /** EBP at the band start minus EBP at the band end, by side; a balance, no interest. */
  runOff: StochasticSideDistributions;
  /** The running sum of the band run-off through this band, per path, then summarised. */
  cumulative: StochasticSideDistributions;
}

/**
 * The stochastic gap block (0.4.0). For every path, the SEG block (seg/computeSeg.ts, unchanged) runs on
 * that path's rates re-shocked around the path; its SEG and EBP fold to the chart-of-accounts top level, are banded
 * into the eight bands 0-1M to 5-10Y, and the per-position rows are dropped. Each figure below is a statistic of
 * this run's Monte Carlo path set, never a gap. Hull-White only, base scenario only, 120 months.
 *
 * Identities (per path, so also of the means): the repricing bands plus beyondHorizon sum to the signed net
 * notional the block covers (outstanding at t = 0); the liquidity run-off bands plus beyondHorizon sum to
 * month1Balance, by side.
 */
export interface StochasticGapBlock {
  /** The SEG horizon, STOCHASTIC_GAP_HORIZON_MONTHS (120). */
  horizonMonths: number;
  /** The SEG block's earnings convention. */
  convention: "constant-balance-sheet";
  /** The SEG pair's half-shock, bp (SEG_DEFAULTS.shockBp). */
  shockBp: number;
  /** Repricing gap from SEG, signed net. */
  repricing: {
    bands: StochasticRepricingBand[];
    /** SEG still outstanding at month 120, signed net: outstanding beyond 10 years, not banded. */
    beyondHorizon: { net: StochasticDistribution };
  };
  /** Liquidity gap from EBP, the average outstanding balance; it carries no interest. */
  liquidity: {
    bands: StochasticLiquidityBand[];
    /** The EBP balance outstanding in month 120, by side: outstanding beyond 10 years, not banded. */
    beyondHorizon: StochasticSideDistributions;
    /** The EBP balance of month 1, by side: the total the run-off bands and beyondHorizon add back to. */
    month1Balance: StochasticSideDistributions;
  };
  /** The positions the SEG block cannot cover, with its reason; they enter no figure above. Carried, not dropped. */
  uncovered: { positionId: string; reason: string }[];
  uncoveredCount: number;
}
