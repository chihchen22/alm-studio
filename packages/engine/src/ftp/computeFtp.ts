/**
 * Deterministic funds transfer pricing: the engine wrapper around the
 * kernel's par-matched static-strip FTP (packages/kernel/src/math/analytics/
 * ftp.ts), aggregated to the COA family grain with a book NIM bridge.
 *
 * Anchor chain (strongest first): the
 * vendored kernel FTP tests; an independent spreadsheet par-match of the SAME
 * kernel ftp.ts on a fixed 24-month case, recorded outside this repository
 * (cited as corroboration, no number reproduced here); and this module's own
 * flat-curve two-period hand case, asserted to machine precision in the tests.
 *
 * Division of labor, deliberately narrow:
 *   - RATES come verbatim from kernel computeFTP, one instrument at a time
 *     (loop-local, mirroring aggregate.ts: no per-position row survives). The
 *     par-match solve, the NMD-B beta blend, and the floater reset sampling
 *     are kernel logic this module does not reimplement.
 *   - DOLLARS are engine-side sums: coupon interest is the kernel Cashflow's
 *     interestPaid verbatim (the same addends computeNII buckets), and the FTP
 *     accrual is ftpRate(m) * balance(m) * (1/12) using the kernel's monthly
 *     spot funding rate against the same cashflow's start-of-month balance.
 *   - SIDES come from the COA family (the grain, the one computeNII
 *     classifies by), not from terms.side: position terms may omit `side`
 *     (the kernel would then default the row to "asset"), and a liability
 *     booked as an asset would flip every margin sign. A position whose
 *     explicit terms.side CONTRADICTS its family side refuses loudly.
 *
 * ADR-018 binds this module: the shocked-NII path convention is pinned at v1
 * semantics this window, so the FTP series is computed for the BASE scenario
 * only. Calling this module for a non-base scenario throws the typed
 * NotImplementedError; the emitted block carries the same refusal as a typed
 * NotImplemented tag in `shockedScenarios`. The refusal is the correct
 * behaviour, not a gap: publishing a shocked monthly series on a convention
 * flagged wrong-by-one-coupon-month is exactly what this house does not do.
 *
 * Determinism: positions reduce in array order, families emit in declared
 * order, no clock, no RNG. The family lookup Map is keyed get/set only.
 */
import {
  computeFTP,
  type Cashflow,
  type Instrument,
  type MarketSnapshot,
  type RatePath,
  type TLPCurve,
  type ZeroCurve,
} from "@alm/kernel";
import { isCommitmentFamily } from "../commitment/offBalanceSheet";
import { isNonRateFamily } from "../nonRate";
import type { BalanceSheetSide, ProductFamilyId, ScenarioId } from "../contracts/ids";
import { DERIVATIVE_SIDE } from "../swap/derivatives";
import type { PortfolioSpec, PositionTerms } from "../contracts/position";
import { ReplicatingPortfolioCredit, scenarioCreditReadout, type RpRunScenario } from "./replicatingPortfolio";
import type {
  FtpBookSummary,
  FtpFamilyMonthly,
  FtpFamilyRow,
  FtpNewVolume,
  FtpNewVolumeWindow,
  FtpNimBridge,
  FtpResult,
  ReplicatingPortfolioReadout,
  ScenarioCreditReadout,
  ScenarioNII,
} from "../contracts/results";
import type { RateIndexTable } from "../contracts/rateIndex";
import type { RunMacro } from "../macro/runMacro";
import type { Scenario } from "../contracts/scenario";
import { makeInstrument } from "../runtime/instrumentFactory";
import { makeNotImplemented, NotImplementedError } from "../runtime/notImplemented";
import { NII_HORIZONS_MONTHS } from "../nii";
import { forwardStartCurve, type SweptTranche } from "../projection/dynamic";

/** The NotImplemented layer name of the shocked-series refusal. */
export const FTP_SHOCKED_SERIES_LAYER = "ftp.shocked-scenarios";

/**
 * Monthly accrual fraction of the FTP charge/credit: ftpRate * balance * dt.
 * Structural constant matching the kernel par-match's DT_YEARS (ftp.ts) and
 * the alm-conventions monthly grid; not a tunable.
 */
export const FTP_ACCRUAL_DT_YEARS = 1 / 12;

/**
 * The bridge horizon: the FIRST pinned NII horizon (12 months), imported from
 * the NII module so the weld to computeNII holds by construction rather than
 * by a duplicated literal.
 */
export const FTP_BRIDGE_HORIZON_MONTHS = NII_HORIZONS_MONTHS[0];

/**
 * Zero-notional guard threshold, mirroring kernel computeFTP's bookNim guard:
 * below it a weighted rate has no mass and is not reported (family rates are
 * omitted; bookNimRate falls back to 0 exactly as the kernel's does).
 */
export const FTP_ZERO_NOTIONAL_GUARD = 1e-12;

/** Everything the FTP block consumes; assembled by the run pipeline. */
export interface FtpComputeInput {
  /** The effective (overlay-applied) book of the base scenario's assumption set. */
  portfolio: PortfolioSpec;
  /** The request's full scenario slate (names the refused shocked ids). */
  scenarios: readonly Scenario[];
  /** The base scenario's id; its rateSpec MUST be kind "base". */
  baseScenarioId: ScenarioId;
  /** The base risk-free zero curve the run bootstrapped. */
  curve: ZeroCurve;
  /** The run's TLP overlay (all-in funding = risk-free + TLP). */
  tlp: TLPCurve;
  /** The base scenario's deterministic rate path. */
  path: RatePath;
  /** The run's bucket horizon in months. */
  horizonMonths: number;
  /**
   * computeNII's base-scenario row. totalNet12 is copied VERBATIM into the
   * bridge as the number the decomposition must reconcile to; nothing on it is
   * recomputed here.
   */
  niiBase: Pick<ScenarioNII, "scenarioId" | "totalNet12" | "derivativesNet12">;
  /**
   * The run's resolved rate indices, handed to makeInstrument
   * so an indexed floater is built with its index. The kernel floating branch
   * charges the base forward over the reset window plus the TLP, so the margin
   * absorbs the basis. Absent on an unindexed run.
   */
  rateIndices?: RateIndexTable;
  /**
   * The run's resolved macro value, threaded beside rateIndices to every
   * makeInstrument call. A mortgage carrying a housing group without it throws
   * MacroUnresolvedError. Absent outside a run.
   */
  macro?: RunMacro;
  /**
   * The run's market snapshot, read only by a replicating-portfolio credit that carries a
   * steepener (it re-bootstraps the shifted par quotes). Absent, such a steepener is left out with its reason.
   */
  snapshot?: MarketSnapshot;
  /**
   * Every scenario of the run, in request order, with the deposit's shift and the scenario's
   * own curve, read only by a credit on the balance path or a capped life. Absent, such a credit reads the base only.
   */
  creditScenarios?: readonly RpRunScenario[];
  /**
   * The base scenario's minted new-volume tranches, present only when its rules carry a
   * product template. Each is transfer-priced at its origination month k by kernel computeFTP on the base curve as
   * seen from k / 12 (forwardStartCurve) and its own forward-started path, the term liquidity premium curve held as
   * it is at the cut-off; its month m accrues into bucket k + m - 1. The opening book's rows are unchanged.
   */
  newVolume?: readonly SweptTranche[];
  /** Fix round M2: the earnings window the new volume's headline reading covers, months (the run's NII window; 60 when absent). */
  newVolumeWindowMonths?: number;
  /**
   * Studio slice S3a-2 fix round (M2): the base scenario's deposit warmup history (percent per annum, oldest first),
   * present only when the run named `nmdWarmup`. Every nmd and nmd-b position is built on it, as the static projection
   * builds them, so a deposit's FTP rests on the deposit history its projection reads. Absent, deposits take the
   * kernel's own warmup series and the block is byte-identical to before.
   */
  nmdWarmup?: readonly number[];
}

/**
 * The engine-side readings that replace a kernel row's rates, or null for every other
 * position (whose row is the kernel's, untouched).
 *
 *  - A floating loan whose terms carry `fundingTenorMonths`: the IR FTP is the benchmark forward over the reset window
 *    on the curve's bond-equivalent quoting basis, the liquidity FTP
 *    the term liquidity premium at the funding tenor (45 bp at five years). The monthly series refixes the forward at
 *    each reset and carries the funding-tenor premium throughout. Its margin is the balance-weighted average, over the
 *    loan's months, of the coupon less that month's transfer rate, so the coupon and the charge share one basis (a
 *    lifetime coupon less a month-one transfer rate would overstate it; fix round 1).
 *  - An nmd whose terms carry `replicatingPortfolio`: the rates are the credit's rate, liquidity and total credit, and
 *    the monthly series holds the total credit flat (the rolling ladder's stable credit).
 */
function engineFtpRow(
  terms: PositionTerms,
  row: FtpInstrumentRow,
  curve: ZeroCurve,
  tlp: TLPCurve,
  snapshot: MarketSnapshot | undefined,
  cf: readonly Cashflow[],
  credit?: { scenarios: readonly RpRunScenario[]; baseScenarioId: string },
): { row: FtpInstrumentRow; readout?: ReplicatingPortfolioReadout; scenarioCredit?: ScenarioCreditReadout } | null {
  const marginOf = (allIn: number) => (row.side === "liability" ? allIn - row.assetRate : row.assetRate - allIn);
  if (terms.type === "floating-loan" && terms.fundingTenorMonths !== undefined) {
    const funding = terms.fundingTenorMonths;
    if (!Number.isInteger(funding) || funding < 1) {
      throw new Error(`computeFtpResult: position "${terms.id}" has fundingTenorMonths ${funding}; it must be a whole number of months from 1`);
    }
    const reset = terms.resetFrequencyMonths;
    const lp = tlp.tlp(funding / 12);
    const ir = curve.forwardRateBey(0, reset / 12);
    let current = 0;
    const monthlySeries = row.monthlySeries.map((m) => {
      if ((m.month - 1) % reset === 0) current = curve.forwardRateBey((m.month - 1) / 12, (m.month - 1 + reset) / 12) + lp;
      return { ...m, ftpRate: current };
    });
    let weighted = 0;
    let mass = 0;
    monthlySeries.forEach((m, i) => {
      const b = cf[i]!.balance;
      weighted += (m.couponRate - m.ftpRate) * b;
      mass += b;
    });
    const spread = mass > FTP_ZERO_NOTIONAL_GUARD ? weighted / mass : 0;
    const ftpMargin = row.side === "liability" ? -spread : spread;
    return { row: { ...row, irFtpRate: ir, lpFtpRate: lp, allInFtpRate: ir + lp, ftpMargin, monthlySeries } };
  }
  // A credit on the balance path (an nmd on the component form) or a capped life (a full-form
  // nmd-b), read at every scenario of the run; the family row reads the base scenario's.
  if ((terms.type === "nmd" || terms.type === "nmd-b") && terms.replicatingPortfolio?.life !== undefined) {
    const scenarios = credit?.scenarios ?? [{ scenarioId: credit?.baseScenarioId ?? "base", shiftPct: 0, curve }];
    const readout = scenarioCreditReadout(terms, terms.replicatingPortfolio, curve, tlp, scenarios, credit?.baseScenarioId ?? scenarios[0]!.scenarioId);
    const monthlySeries = row.monthlySeries.map((m) => ({ ...m, ftpRate: readout.totalCredit }));
    return {
      row: {
        ...row,
        irFtpRate: readout.rateCredit,
        lpFtpRate: readout.liquidityCredit,
        allInFtpRate: readout.totalCredit,
        ftpMargin: marginOf(readout.totalCredit),
        monthlySeries,
      },
      scenarioCredit: readout,
    };
  }
  if (terms.type === "nmd" && terms.replicatingPortfolio !== undefined) {
    if (terms.linearDecay === undefined) {
      throw new Error(`computeFtpResult: position "${terms.id}" carries a replicating-portfolio credit but no linear decay`);
    }
    const credit = new ReplicatingPortfolioCredit(
      { positionId: terms.id, notional: terms.notional, beta: terms.beta, runoffMonths: terms.linearDecay.horizonMonths },
      terms.replicatingPortfolio,
    );
    const readout = credit.readout(curve, tlp, snapshot);
    const monthlySeries = row.monthlySeries.map((m) => ({ ...m, ftpRate: readout.totalCredit }));
    return {
      row: {
        ...row,
        irFtpRate: readout.rateCredit,
        lpFtpRate: readout.liquidityCredit,
        allInFtpRate: readout.totalCredit,
        ftpMargin: marginOf(readout.totalCredit),
        monthlySeries,
      },
      readout,
    };
  }
  return null;
}

/** The kernel FTP row of one instrument (the kernel does not export its name). */
type FtpInstrumentRow = ReturnType<typeof computeFTP>["perInstrument"][number];

/** Per-family dollar accumulators plus notional-weighted rate sums. */
interface FamilyAcc {
  positionCount: number;
  notional: number;
  wCoupon: number;
  wIr: number;
  wLp: number;
  wAllIn: number;
  wMargin: number;
  balance: Float64Array;
  couponInterest: Float64Array;
  ftpAccrual: Float64Array;
  /** The replicating-portfolio readout of the family's one credit-priced deposit. */
  replicatingPortfolio?: ReplicatingPortfolioReadout;
  /** The scenario credit of the family's one deposit on its balance path or a capped life. */
  scenarioCredit?: ScenarioCreditReadout;
}

function toMonthly(acc: FamilyAcc): FtpFamilyMonthly {
  return {
    balance: Array.from(acc.balance),
    couponInterest: Array.from(acc.couponInterest),
    ftpAccrual: Array.from(acc.ftpAccrual),
  };
}

/** Sum the first `months` buckets of a series (clamped to length). */
function sumHead(series: Float64Array, months: number): number {
  const n = Math.min(months, series.length);
  let sum = 0;
  for (let k = 0; k < n; k++) sum += series[k];
  return sum;
}

/**
 * Tenor-memoized view of a ZeroCurve (W5-F1 perf recovery). The kernel
 * par-match evaluates discountFactor / forwardRate once per cashflow month per
 * position — on a 100k book that is tens of millions of calls over only ~360
 * distinct monthly tenors, each a linear node scan plus Math.exp. The wrapper
 * caches by the EXACT float argument (Map SameValueZero key), so every hit
 * returns the very number the wrapped pure function produced for those bits:
 * bit-identical output, structurally conforming to the kernel interface, no
 * kernel edit. Cache lifetime is one computeFtpResult call; nothing persists
 * across runs.
 */
function memoizedCurve(curve: ZeroCurve): ZeroCurve {
  const df = new Map<number, number>();
  const zr = new Map<number, number>();
  const fwd = new Map<number, Map<number, number>>();
  return {
    t: curve.t,
    z: curve.z,
    convention: curve.convention,
    zeroRate(time: number): number {
      let v = zr.get(time);
      if (v === undefined) {
        v = curve.zeroRate(time);
        zr.set(time, v);
      }
      return v;
    },
    discountFactor(time: number): number {
      let v = df.get(time);
      if (v === undefined) {
        v = curve.discountFactor(time);
        df.set(time, v);
      }
      return v;
    },
    forwardRate(t1: number, t2: number): number {
      let inner = fwd.get(t1);
      if (inner === undefined) {
        inner = new Map<number, number>();
        fwd.set(t1, inner);
      }
      let v = inner.get(t2);
      if (v === undefined) {
        v = curve.forwardRate(t1, t2);
        inner.set(t2, v);
      }
      return v;
    },
    // Not on the FTP path; delegate uncached rather than carry a dead cache.
    forwardRateBey(t1: number, t2: number): number {
      return curve.forwardRateBey(t1, t2);
    },
    forwardSwapRate(t1: number, t2: number): number {
      return curve.forwardSwapRate(t1, t2);
    },
  };
}

/** Tenor-memoized view of a TLPCurve; same contract as memoizedCurve. */
function memoizedTlp(tlp: TLPCurve): TLPCurve {
  const cache = new Map<number, number>();
  return {
    t: tlp.t,
    spread: tlp.spread,
    tlp(time: number): number {
      let v = cache.get(time);
      if (v === undefined) {
        v = tlp.tlp(time);
        cache.set(time, v);
      }
      return v;
    },
  };
}

/**
 * Compute the run's FTP block for the base scenario. Refuses (typed throw) at
 * a non-base scenario; emits the matching typed NotImplemented tag
 * for the shocked series inside the returned block.
 */
export function computeFtpResult(input: FtpComputeInput): FtpResult {
  const { portfolio, scenarios, baseScenarioId, curve, tlp, path, horizonMonths, niiBase } = input;

  const baseScenario = scenarios.find((s) => s.id === baseScenarioId);
  if (!baseScenario) {
    throw new Error(`computeFtpResult: scenario "${baseScenarioId}" is not in the request slate`);
  }
  if (baseScenario.rateSpec.kind !== "base") {
    throw new NotImplementedError(
      FTP_SHOCKED_SERIES_LAYER,
      `FTP series at shocked scenarios is not implemented this window (the ` +
        `shocked-NII path convention is pinned at v1 semantics; a monthly coupon-vs-FTP ` +
        `series on that convention would be wrong by one coupon month). Requested ` +
        `scenario "${baseScenarioId}" has rateSpec.kind "${baseScenario.rateSpec.kind}"; ` +
        `the FTP block is computed for the base scenario only.`,
    );
  }
  if (niiBase.scenarioId !== baseScenarioId) {
    throw new Error(
      `computeFtpResult: niiBase row is for scenario "${niiBase.scenarioId}", ` +
        `expected the base scenario "${baseScenarioId}"`,
    );
  }

  const families = portfolio.coa.families;
  const famIndex = new Map<ProductFamilyId, number>();
  const accs: FamilyAcc[] = new Array(families.length);
  for (let i = 0; i < families.length; i++) {
    famIndex.set(families[i].id, i);
    accs[i] = {
      positionCount: 0,
      notional: 0,
      wCoupon: 0,
      wIr: 0,
      wLp: 0,
      wAllIn: 0,
      wMargin: 0,
      balance: new Float64Array(horizonMonths),
      couponInterest: new Float64Array(horizonMonths),
      ftpAccrual: new Float64Array(horizonMonths),
    };
  }

  // W5-F1 perf recovery: memoized curve views shared across the whole loop
  // (see memoizedCurve). Rates and dollars are unchanged to the bit — the
  // caches replay the wrapped pure functions' own outputs.
  const mCurve = memoizedCurve(curve);
  const mTlp = memoizedTlp(tlp);

  // Hot loop: one kernel FTP row + one cashflow pass per position, loop-local.
  const positions = portfolio.positions;
  for (let p = 0; p < positions.length; p++) {
    const pos = positions[p];
    const fi = famIndex.get(pos.familyId);
    if (fi === undefined) {
      throw new Error(
        `computeFtpResult: position "${pos.id}" references unknown family "${pos.familyId}"`,
      );
    }
    // Off balance sheet. Undrawn capacity is not funded, so there is
    // nothing to transfer-price: the kernel would par-match the drawdown stream
    // and book an FTP charge on money the bank never lent, and `acc.notional`
    // would weight every book-level rate by the undrawn limit. Skipped before
    // the side checks, so the family row stays present with a zero notional and
    // no rates (the FTP_ZERO_NOTIONAL_GUARD branch) rather than disappearing.
    if (isCommitmentFamily(families[fi])) continue;
    // S3a-1 follow-up: a non-rate-sensitive balance carries no funds transfer charge or credit.
    if (isNonRateFamily(families[fi])) continue;
    const famSide = families[fi].side;
    // A swap needs no funding, so nothing is transfer-priced: the
    // row stays present with a zero notional and no rates (the
    // FTP_ZERO_NOTIONAL_GUARD branch), exactly as a commitment's does. This
    // must precede the terms spread below, whose `side` admits only asset or
    // liability; the literal compare narrows `famSide` for it.
    if (famSide === DERIVATIVE_SIDE) continue;
    if (famSide === "equity") {
      // Equity is a plug node, never an instrument (contracts/ids.ts); a
      // position here is a book-construction error, not a zero to absorb.
      throw new Error(
        `computeFtpResult: position "${pos.id}" sits in equity-side family ` +
          `"${pos.familyId}"; equity is a derived plug and holds no instruments`,
      );
    }
    // This throw is LOAD-BEARING for the terms construction below. Because a
    // DEFINED side that disagrees with the family dies here, the only case left
    // for that line to correct is an OMITTED side, which is why it tests
    // `side === undefined` rather than the older `side === famSide`. Weaken or
    // move this throw and that test quietly stops correcting a disagreeing side
    // instead of refusing the book.
    if (pos.terms.side !== undefined && pos.terms.side !== famSide) {
      throw new Error(
        `computeFtpResult: position "${pos.id}" declares terms.side "${pos.terms.side}" ` +
          `but its family "${pos.familyId}" is declared "${famSide}" (the family ` +
          `side is the classification grain); fix the book rather than let FTP guess a sign`,
      );
    }
    // Instantiate under the FAMILY side so the kernel's margin sign convention
    // agrees with the NII classification even where terms omit `side` (the
    // vanilla book's funding legs do; the kernel alone would read them "asset").
    // Equivalent to the old `side === famSide` test: the guard above already
    // threw on a DEFINED side that disagrees, so the only case left to correct
    // is an omitted one. Written as the undefined test because that is the
    // actual invariant, and because it lets the compiler see that terms whose
    // `side` is a required literal (commitment) never reach the spread.
    const terms = pos.terms.side === undefined ? { ...pos.terms, side: famSide } : pos.terms;
    const inst: Instrument = makeInstrument(terms, {
      rateIndices: input.rateIndices,
      macro: input.macro,
      ...(input.nmdWarmup !== undefined ? { nmdWarmup: input.nmdWarmup } : {}),
    });
    // One generation pass per position, not two (the ADR-013 Package D
    // pattern applied to FTP): kernel computeFTP generates the instrument's
    // cashflow stream internally, and the dollar pass below needs the same
    // stream. Generation is deterministic and pure, so the second call would
    // return value-identical rows; patch the instance so it returns the SAME
    // array the kernel call produced. Keyed on path identity; any other path
    // regenerates. Neither consumer mutates the stream (kernel ftp.ts and the
    // accrual loop below are read-only over it).
    const rawGenerate = inst.generateCashflows.bind(inst);
    let cachedPath: RatePath | undefined;
    let cachedCf: Cashflow[] | undefined;
    inst.generateCashflows = (p: RatePath): Cashflow[] => {
      if (cachedCf === undefined || cachedPath !== p) {
        cachedCf = rawGenerate(p);
        cachedPath = p;
      }
      return cachedCf;
    };
    const kernelRow = computeFTP([inst], mCurve, mTlp, path).perInstrument[0];
    // A flagged floater or a credit-priced deposit reads its rates engine-side; any other
    // position keeps the kernel row as it is.
    const cf = inst.generateCashflows(path);
    const engine = engineFtpRow(terms, kernelRow, curve, tlp, input.snapshot, cf, {
      scenarios: input.creditScenarios ?? [{ scenarioId: input.baseScenarioId, shiftPct: 0, curve }],
      baseScenarioId: input.baseScenarioId,
    });
    const row = engine?.row ?? kernelRow;
    if (row.monthlySeries.length !== cf.length) {
      throw new Error(
        `computeFtpResult: kernel monthly series length ${row.monthlySeries.length} does not ` +
          `match the cashflow stream length ${cf.length} for position "${pos.id}"; ` +
          `refusing to misalign the accrual`,
      );
    }

    const acc = accs[fi];
    const priced = engine?.readout !== undefined || engine?.scenarioCredit !== undefined;
    if (priced) {
      if (acc.replicatingPortfolio !== undefined || acc.scenarioCredit !== undefined || acc.positionCount > 0) {
        throw new Error(
          `computeFtpResult: family "${pos.familyId}" holds more than one position and one is priced on a ` +
            "replicating-portfolio credit; put a credit-priced deposit in a family of its own",
        );
      }
      if (engine!.readout !== undefined) acc.replicatingPortfolio = engine!.readout;
      if (engine!.scenarioCredit !== undefined) acc.scenarioCredit = engine!.scenarioCredit;
    } else if (acc.replicatingPortfolio !== undefined || acc.scenarioCredit !== undefined) {
      throw new Error(
        `computeFtpResult: family "${pos.familyId}" holds a credit-priced deposit and position "${pos.id}" besides; ` +
          "put a credit-priced deposit in a family of its own",
      );
    }
    const N = pos.terms.notional;
    acc.positionCount += 1;
    acc.notional += N;
    acc.wCoupon += row.assetRate * N;
    acc.wIr += row.irFtpRate * N;
    acc.wLp += row.lpFtpRate * N;
    acc.wAllIn += row.allInFtpRate * N;
    acc.wMargin += row.ftpMargin * N;

    for (let c = 0; c < cf.length; c++) {
      const flow = cf[c];
      const series = row.monthlySeries[c];
      if (series.month !== flow.monthOffset) {
        throw new Error(
          `computeFtpResult: kernel monthly series month ${series.month} does not match ` +
            `cashflow monthOffset ${flow.monthOffset} at index ${c} for position "${pos.id}"`,
        );
      }
      const bucket = flow.monthOffset - 1; // Month m -> bucket m-1
      if (bucket < 0 || bucket >= horizonMonths) continue; // explicit horizon truncation
      acc.balance[bucket] += flow.balance;
      acc.couponInterest[bucket] += flow.interestPaid;
      acc.ftpAccrual[bucket] += series.ftpRate * flow.balance * FTP_ACCRUAL_DT_YEARS;
    }
    // The instrument, its kernel row, and its Cashflow[] fall out of scope here.
  }

  // The new volume, priced tranche by tranche at origination (newVolumeFtp below).
  const newVolume = input.newVolume === undefined ? undefined : newVolumeFtp(input.newVolume, families, famIndex, curve, mTlp, horizonMonths, Math.min(input.newVolumeWindowMonths ?? 60, horizonMonths));

  // Family rows in declared order; book roll-ups in the same fixed order.
  const byFamily: FtpFamilyRow[] = new Array(families.length);
  let charges12 = 0;
  let credits12 = 0;
  let lendingMargin12 = 0;
  let fundingMargin12 = 0;
  let wMarginTotal = 0;
  let notionalTotal = 0;
  for (let i = 0; i < families.length; i++) {
    const fam = families[i];
    const acc = accs[i];
    const side: BalanceSheetSide = fam.side;
    const couponInterest12 = sumHead(acc.couponInterest, FTP_BRIDGE_HORIZON_MONTHS);
    const ftpAccrual12 = sumHead(acc.ftpAccrual, FTP_BRIDGE_HORIZON_MONTHS);
    const margin12 =
      side === "liability" ? ftpAccrual12 - couponInterest12 : couponInterest12 - ftpAccrual12;

    const row: FtpFamilyRow = {
      familyId: fam.id,
      side,
      positionCount: acc.positionCount,
      notional: acc.notional,
      couponInterest12,
      ftpAccrual12,
      margin12,
      monthly: toMonthly(acc),
    };
    if (acc.notional > FTP_ZERO_NOTIONAL_GUARD) {
      row.couponRate = acc.wCoupon / acc.notional;
      row.irFtpRate = acc.wIr / acc.notional;
      row.lpFtpRate = acc.wLp / acc.notional;
      row.allInFtpRate = acc.wAllIn / acc.notional;
      row.ftpMarginRate = acc.wMargin / acc.notional;
    }
    if (acc.replicatingPortfolio !== undefined) row.replicatingPortfolio = acc.replicatingPortfolio;
    if (acc.scenarioCredit !== undefined) row.scenarioCredit = acc.scenarioCredit;
    const nv = newVolume?.rows[i];
    if (nv !== undefined) row.newVolume = nv;
    byFamily[i] = row;

    if (side === "asset") {
      charges12 += ftpAccrual12;
      lendingMargin12 += margin12;
    } else if (side === "liability") {
      credits12 += ftpAccrual12;
      fundingMargin12 += margin12;
    }
    wMarginTotal += acc.wMargin;
    notionalTotal += acc.notional;
  }

  const mismatchCenter12 = charges12 - credits12;
  const book: FtpBookSummary = {
    bookNimRate: notionalTotal > FTP_ZERO_NOTIONAL_GUARD ? wMarginTotal / notionalTotal : 0,
    charges12,
    credits12,
    mismatchCenter12,
  };

  // A swap's net settlement is in NII and in no FTP leg; the bridge
  // copies it verbatim from the NII row and adds it, so a hedged book still
  // reconciles to niiNet12.
  const derivativesNet12 = niiBase.derivativesNet12;
  const nimBridge: FtpNimBridge = {
    horizonMonths: FTP_BRIDGE_HORIZON_MONTHS,
    lendingMargin12,
    fundingMargin12,
    mismatchCenter12,
    bridgeNet12:
      derivativesNet12 === undefined
        ? lendingMargin12 + fundingMargin12 + mismatchCenter12
        : lendingMargin12 + fundingMargin12 + mismatchCenter12 + derivativesNet12,
    niiNet12: niiBase.totalNet12,
    ...(derivativesNet12 !== undefined ? { derivativesNet12 } : {}),
  };
  // Studio A+E contract 19: a dynamic base scenario's NII row came through the
  // balance stage (the compiler refuses one that did not), so niiNet12 carries
  // the top-up tranches' interest, which no margin on the opening book explains.
  // The bridge names that residual rather than leaving the identity open.
  if (baseScenario.newBusiness.mode === "dynamic") {
    nimBridge.newBusinessNet12 = nimBridge.niiNet12 - nimBridge.bridgeNet12;
  }
  if (newVolume !== undefined) nimBridge.newVolume = newVolume.bridge;

  // Name the shocked ids the refusal covers, in slate order, for the reader.
  const shockedIds = scenarios.filter((s) => s.id !== baseScenarioId).map((s) => s.id);
  const shockedScenarios = makeNotImplemented(
    FTP_SHOCKED_SERIES_LAYER,
    `FTP series computed for base scenario "${baseScenarioId}" only. Shocked-scenario ` +
      `series are refused this window (the shocked-NII path convention is ` +
      `pinned at v1 semantics; a series on that convention would be wrong by one ` +
      `coupon month). Refused for: ${shockedIds.length > 0 ? shockedIds.join(", ") : "(no shocked scenarios in this request)"}.`,
  );

  return {
    scenarioId: baseScenarioId,
    irBasis: "risk-free",
    allInBasis: "risk-free-plus-tlp",
    byFamily,
    book,
    nimBridge,
    shockedScenarios,
  };
}

/** Per-family accumulators of the new volume. */
interface NewVolumeAcc {
  /**
   * Fix round M2: the tranches made inside the earnings window, weighted the same way. Ruling 46: a tranche at bucket k
   * is made at the end of month k (it replaces month k's runoff), so a window of N months holds k = 1 .. N.
   */
  win: { trancheCount: number; notional: number; wCoupon: number; wIr: number; wLp: number; wAllIn: number; wMargin: number };
  trancheCount: number;
  notional: number;
  wCoupon: number;
  wIr: number;
  wLp: number;
  wAllIn: number;
  wMargin: number;
  balance: Float64Array;
  couponInterest: Float64Array;
  ftpAccrual: Float64Array;
  atOrigination: Array<number | null>;
}

/**
 * Transfer-price every new-volume tranche at its origination. Tranche minted at bucket k: the kernel
 * par-matches its own cash flows (generated on its forward-started path) against the base curve as seen from k / 12,
 * so its all-in rate is the funding rate a desk would have quoted for that tranche on that day under today's forwards,
 * locked for its life (a floater's series refixes at each reset on the same forward view, as the kernel does). The
 * dollars accrue with the opening book's rule: ftpRate(m) * balance(m) / 12, into bucket k + m - 1.
 */
function newVolumeFtp(
  tranches: readonly SweptTranche[],
  families: PortfolioSpec["coa"]["families"],
  famIndex: Map<ProductFamilyId, number>,
  curve: ZeroCurve,
  tlp: TLPCurve,
  horizonMonths: number,
  windowMonths: number,
): { rows: Array<FtpNewVolume | undefined>; bridge: NonNullable<FtpNimBridge["newVolume"]> } {
  const accs: Array<NewVolumeAcc | undefined> = new Array(families.length);
  const curveAt = new Map<number, ZeroCurve>();
  for (const t of tranches) {
    const fi = famIndex.get(t.familyId);
    if (fi === undefined) throw new Error(`computeFtpResult: new-volume tranche of unknown family "${t.familyId}"`);
    let acc = accs[fi];
    if (acc === undefined) {
      acc = {
        win: { trancheCount: 0, notional: 0, wCoupon: 0, wIr: 0, wLp: 0, wAllIn: 0, wMargin: 0 },
        trancheCount: 0, notional: 0, wCoupon: 0, wIr: 0, wLp: 0, wAllIn: 0, wMargin: 0,
        balance: new Float64Array(horizonMonths),
        couponInterest: new Float64Array(horizonMonths),
        ftpAccrual: new Float64Array(horizonMonths),
        atOrigination: new Array<number | null>(horizonMonths).fill(null),
      };
      accs[fi] = acc;
    }
    let fwd = curveAt.get(t.bucket);
    if (fwd === undefined) {
      fwd = memoizedCurve(forwardStartCurve(curve, t.bucket / 12));
      curveAt.set(t.bucket, fwd);
    }
    const row = computeFTP([t.instrument], fwd, tlp, t.path).perInstrument[0]!;
    const cf = t.instrument.generateCashflows(t.path);
    if (row.monthlySeries.length !== cf.length) {
      throw new Error(`computeFtpResult: new-volume tranche "${t.instrument.terms.id}" has a monthly series of ${row.monthlySeries.length} rows and ${cf.length} cash flows`);
    }
    const N = t.notional;
    acc.trancheCount += 1;
    acc.notional += N;
    acc.wCoupon += row.assetRate * N;
    acc.wIr += row.irFtpRate * N;
    acc.wLp += row.lpFtpRate * N;
    acc.wAllIn += row.allInFtpRate * N;
    acc.wMargin += row.ftpMargin * N;
    // Ruling 46: months 1 .. N of the window are the tranches made at k = 1 .. N (the sweep never mints at 0), as
    // going-concern EVE counts them. The window's dollars stay the cash flows of buckets 0 .. N - 1 (months 1 .. N).
    if (t.bucket <= windowMonths) {
      const w = acc.win;
      w.trancheCount += 1;
      w.notional += N;
      w.wCoupon += row.assetRate * N;
      w.wIr += row.irFtpRate * N;
      w.wLp += row.lpFtpRate * N;
      w.wAllIn += row.allInFtpRate * N;
      w.wMargin += row.ftpMargin * N;
    }
    if (t.bucket < horizonMonths) acc.atOrigination[t.bucket] = row.allInFtpRate;
    for (let c = 0; c < cf.length; c++) {
      const flow = cf[c]!;
      const bucket = t.bucket + flow.monthOffset - 1;
      if (bucket < 0 || bucket >= horizonMonths) continue; // explicit horizon truncation, as the sweep does
      acc.balance[bucket] += flow.balance;
      acc.couponInterest[bucket] += flow.interestPaid;
      acc.ftpAccrual[bucket] += row.monthlySeries[c]!.ftpRate * flow.balance * FTP_ACCRUAL_DT_YEARS;
    }
  }
  const rows: Array<FtpNewVolume | undefined> = new Array(families.length);
  let charges12 = 0;
  let credits12 = 0;
  let lendingMargin12 = 0;
  let fundingMargin12 = 0;
  for (let i = 0; i < families.length; i++) {
    const acc = accs[i];
    if (acc === undefined) continue;
    const side = families[i]!.side;
    const couponInterest12 = sumHead(acc.couponInterest, FTP_BRIDGE_HORIZON_MONTHS);
    const ftpAccrual12 = sumHead(acc.ftpAccrual, FTP_BRIDGE_HORIZON_MONTHS);
    const margin12 = side === "liability" ? ftpAccrual12 - couponInterest12 : couponInterest12 - ftpAccrual12;
    const mass = acc.notional > FTP_ZERO_NOTIONAL_GUARD ? acc.notional : 0;
    const rate = (w: number): number => (mass > 0 ? w / mass : 0);
    const w = acc.win;
    const wCouponInterest = sumHead(acc.couponInterest, windowMonths);
    const wFtpAccrual = sumHead(acc.ftpAccrual, windowMonths);
    const windowRow: FtpNewVolumeWindow = {
      months: windowMonths,
      trancheCount: w.trancheCount,
      notional: w.notional,
      ...(w.notional > FTP_ZERO_NOTIONAL_GUARD
        ? { couponRate: w.wCoupon / w.notional, irFtpRate: w.wIr / w.notional, lpFtpRate: w.wLp / w.notional, allInFtpRate: w.wAllIn / w.notional, ftpMarginRate: w.wMargin / w.notional }
        : {}),
      couponInterest: wCouponInterest,
      ftpAccrual: wFtpAccrual,
      margin: side === "liability" ? wFtpAccrual - wCouponInterest : wCouponInterest - wFtpAccrual,
    };
    rows[i] = {
      window: windowRow,
      trancheCount: acc.trancheCount,
      notional: acc.notional,
      couponRate: rate(acc.wCoupon),
      irFtpRate: rate(acc.wIr),
      lpFtpRate: rate(acc.wLp),
      allInFtpRate: rate(acc.wAllIn),
      ftpMarginRate: rate(acc.wMargin),
      couponInterest12,
      ftpAccrual12,
      margin12,
      monthly: { balance: Array.from(acc.balance), couponInterest: Array.from(acc.couponInterest), ftpAccrual: Array.from(acc.ftpAccrual) },
      allInFtpRateAtOrigination: acc.atOrigination,
    };
    if (side === "asset") {
      charges12 += ftpAccrual12;
      lendingMargin12 += margin12;
    } else if (side === "liability") {
      credits12 += ftpAccrual12;
      fundingMargin12 += margin12;
    }
  }
  const mismatchCenter12 = charges12 - credits12;
  return { rows, bridge: { lendingMargin12, fundingMargin12, mismatchCenter12, net12: lendingMargin12 + fundingMargin12 + mismatchCenter12 } };
}
