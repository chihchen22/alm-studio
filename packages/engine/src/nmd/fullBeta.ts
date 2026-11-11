/**
 * The full beta form of an interest-bearing deposit: a deposit-rate schedule
 * on a stand-alone book, built engine-side on the frozen kernel's own S-curve (`betaAtRate`).
 *
 *   beta_eff(r) = beta(r) x clip(1 - delta x v, 0, 2), delta = deltaUp after a rise, deltaDown after a fall
 *   D*(r)       = alpha + beta_eff(r) x r
 *   D(m)        = D(m-1) + lambda x (D* - D(m-1)), m = 1, 2, ...
 *
 * beta(r) is the binding's S-curve, or `staticBeta` in its place (the static comparator). r is a level in percent:
 * the base state plus the scenario's shift at tenor zero, floored at zero and held for the whole horizon (an
 * instantaneous shock, the book's "level-only" basis). The direction is the sign of the shift; the base scenario
 * reads `baseLastMove`.
 *
 * D(0) is the paid rate at the base state, never the shocked target. The kernel NMDBeta snaps D(0) to the target at
 * the path's step-0 rate, so a shock at step 0 carries no lag; the kernel SEG block avoids that by shocking from
 * step 1, which delays the first adjustment by a month. Here month 1 is already one step of the partial adjustment
 * from the base state, so the year-one expense is the balance times the mean of months 1 to 12 of the path.
 *
 * Balances are flat: the balance is the notional every month and leaves at maturity, so the deposit's decay is off.
 *
 * Two slotting marks turn the deposit into its EVE book. The core is a ladder of equal
 * bullet rungs (`ladderRungMonths`), every rung and the non-core slice paying the base-state paid rate D(0); the
 * non-core slice leaves at month 1.
 *
 *   "frozen"        pass-through b = min(beta_eff at the base state, cap 0.50); core = min(1 - b, cap 0.90); the
 *                   prescribed five-year life. The same split in every scenario.
 *   "shocked-level" core = 1 - beta_eff at the scenario's level, no cap; the life is `coreLifeYears` (absent 5).
 *
 * The class extends the kernel NMDBeta so every reader that dispatches on the instrument sees an nmd-b; it overrides
 * every method that reads the deposit rate.
 */
import {
  NMDBeta,
  betaAtRate,
  type BetaSCurveParams,
  type Cashflow,
  type RatePath,
} from "@alm/kernel";
import type { DepositBetaFullForm, EngineNMDBetaTerms } from "../contracts/position";
import { REGULATORY_CONVENTION_DEFAULTS, ladderRungMonths } from "./regulatoryConvention";

/** nmd-b terms that carry the full form. */
export type FullBetaTerms = EngineNMDBetaTerms & { fullBeta: DepositBetaFullForm };

/** True when nmd-b terms carry the engine-side full form. */
export function hasFullBeta(terms: EngineNMDBetaTerms): terms is FullBetaTerms {
  return terms.fullBeta !== undefined;
}

/** The dampening multiplier 1 - delta x v, clipped to [0, 2]. */
export function dampeningMultiplier(form: DepositBetaFullForm, rising: boolean): number {
  const delta = rising ? form.deltaUp : form.deltaDown;
  return Math.min(Math.max(1 - delta * form.volRatio, 0), 2);
}

/** beta(r) before dampening: the static beta when the form carries one, else the S-curve at r percent. */
export function undampedBeta(rPct: number, sCurve: BetaSCurveParams, form: DepositBetaFullForm): number {
  return form.staticBeta ?? betaAtRate(rPct, sCurve);
}

/** beta_eff(r) at r percent after a move in the given direction. */
export function effectiveBeta(rPct: number, sCurve: BetaSCurveParams, form: DepositBetaFullForm, rising: boolean): number {
  return undampedBeta(rPct, sCurve, form) * dampeningMultiplier(form, rising);
}

/** The equilibrium paid rate D*(r), percent. */
export function equilibriumRatePct(rPct: number, sCurve: BetaSCurveParams, form: DepositBetaFullForm, rising: boolean): number {
  return form.alphaPct + effectiveBeta(rPct, sCurve, form, rising) * rPct;
}

/** The base state: its level, its direction, beta_eff there and the paid rate D(0) the path starts from. */
export function baseState(sCurve: BetaSCurveParams, form: DepositBetaFullForm): {
  levelPct: number;
  rising: boolean;
  betaEff: number;
  paidRatePct: number;
} {
  const levelPct = Math.max(form.baseShortRatePct, 0);
  const rising = form.baseLastMove === "rise";
  const betaEff = effectiveBeta(levelPct, sCurve, form, rising);
  return { levelPct, rising, betaEff, paidRatePct: form.startPaidRatePct ?? form.alphaPct + betaEff * levelPct };
}

/** One scenario's state: the level (base plus the shift, floored at 0), its direction, beta_eff and D* there. */
export function scenarioState(
  sCurve: BetaSCurveParams,
  form: DepositBetaFullForm,
  shiftPct: number,
): { levelPct: number; rising: boolean; betaEff: number; targetPct: number } {
  const levelPct = Math.max(form.baseShortRatePct + shiftPct, 0);
  const rising = shiftPct > 0 ? true : shiftPct < 0 ? false : form.baseLastMove === "rise";
  const betaEff = effectiveBeta(levelPct, sCurve, form, rising);
  return { levelPct, rising, betaEff, targetPct: form.alphaPct + betaEff * levelPct };
}

/** The core share and life of a slotting mark (see the module header). */
export function slottedCore(terms: FullBetaTerms, shiftPct: number): { coreShare: number; lifeYears: number } {
  const { sCurve, fullBeta: form } = terms;
  if (terms.depositSlotting === "frozen") {
    const caps = REGULATORY_CONVENTION_DEFAULTS;
    const b = Math.min(baseState(sCurve, form).betaEff, caps.passThroughCap);
    return { coreShare: Math.min(1 - b, caps.coreShareCap), lifeYears: caps.prescribedAverageLifeYears };
  }
  return {
    coreShare: 1 - scenarioState(sCurve, form, shiftPct).betaEff,
    lifeYears: form.coreLifeYears ?? REGULATORY_CONVENTION_DEFAULTS.prescribedAverageLifeYears,
  };
}

function refuse(terms: EngineNMDBetaTerms, detail: string): never {
  throw new Error(`FullBetaDeposit: position "${terms.id}" ${detail}`);
}

export class FullBetaDeposit extends NMDBeta {
  declare readonly terms: FullBetaTerms;
  /** The scenario's shift of the short rate at tenor zero, percent. */
  readonly shiftPct: number;

  constructor(terms: FullBetaTerms, shiftPct = 0, historical?: ReadonlyArray<number>) {
    super(terms, historical);
    const f = terms.fullBeta;
    if (f.balances !== "flat") refuse(terms, `full beta form balances must be "flat", got ${JSON.stringify(f.balances)}`);
    if (!Number.isFinite(shiftPct)) refuse(terms, `scenario shift must be a finite percent, got ${String(shiftPct)}`);
    this.shiftPct = shiftPct;
  }

  /** The paid rate path D(1..n), percent, toward this scenario's equilibrium. */
  private paidRatesPct(): number[] {
    const { sCurve, fullBeta: form, maturityMonths } = this.terms;
    const target = scenarioState(sCurve, form, this.shiftPct).targetPct;
    const out = new Array<number>(maturityMonths);
    let d = baseState(sCurve, form).paidRatePct;
    for (let m = 0; m < maturityMonths; m++) {
      d = d + sCurve.lambda * (target - d);
      out[m] = d;
    }
    return out;
  }

  /**
   * The repricing fraction the gap fold splits by: beta_eff at this scenario's level when unslotted; 0 when slotted,
   * because a slotted book reprices by its own runoff (the rungs at their maturities, the non-core slice at month 1).
   */
  override initialBeta(_path?: RatePath): number {
    if (this.terms.depositSlotting !== undefined) return 0;
    return scenarioState(this.terms.sCurve, this.terms.fullBeta, this.shiftPct).betaEff;
  }

  /** The level, the paid rate and beta_eff per month, in percent (the kernel reader's shape). */
  override depositRatePath(_path?: RatePath): { rPct: number[]; dPct: number[]; betaPct: number[] } {
    const n = this.terms.maturityMonths;
    const s = scenarioState(this.terms.sCurve, this.terms.fullBeta, this.shiftPct);
    return { rPct: new Array<number>(n).fill(s.levelPct), dPct: this.paidRatesPct(), betaPct: new Array<number>(n).fill(s.betaEff) };
  }

  override simulateBook(_path?: RatePath): ReturnType<NMDBeta["simulateBook"]> {
    return refuse(this.terms, "carries the full beta form, whose balances are flat; it has no bucket simulation");
  }

  override generateCashflows(_path?: RatePath): Cashflow[] {
    return this.terms.depositSlotting === undefined ? this.unslotted() : this.slotted();
  }

  /** Flat balance, the partial-adjustment paid rate, principal at maturity. */
  private unslotted(): Cashflow[] {
    const { notional, maturityMonths } = this.terms;
    const rates = this.paidRatesPct();
    const out: Cashflow[] = [];
    for (let m = 1; m <= maturityMonths; m++) {
      const rate = rates[m - 1]! / 100;
      out.push({
        monthOffset: m,
        balance: notional,
        principalPaid: m === maturityMonths ? notional : 0,
        interestPaid: (notional * rate) / 12,
        couponRate: rate,
      });
    }
    return out;
  }

  /** The core ladder plus the non-core slice, every dollar at the base-state paid rate. */
  private slotted(): Cashflow[] {
    const { notional, sCurve, fullBeta: form } = this.terms;
    const { coreShare, lifeYears } = slottedCore(this.terms, this.shiftPct);
    const rungs = ladderRungMonths(lifeYears, REGULATORY_CONVENTION_DEFAULTS.rungs);
    const rate = baseState(sCurve, form).paidRatePct / 100;
    const perRung = (notional * coreShare) / rungs.length;
    const noncore = notional * (1 - coreShare);
    const last = Math.max(...rungs, 1);
    const out: Cashflow[] = [];
    for (let m = 1; m <= last; m++) {
      let balance = m === 1 ? noncore : 0;
      let principal = m === 1 ? noncore : 0;
      for (const r of rungs) {
        if (r >= m) balance += perRung;
        if (r === m) principal += perRung;
      }
      out.push({ monthOffset: m, balance, principalPaid: principal, interestPaid: (balance * rate) / 12, couponRate: rate });
    }
    return out;
  }
}
