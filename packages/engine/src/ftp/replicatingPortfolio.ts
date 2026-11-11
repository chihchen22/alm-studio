/**
 * The replicating-portfolio credit of a deposit, built engine-side.
 * The kernel's `ftpNmd.ts` is not used: it prices the term liquidity premium per tranche, the construction Section 4.4
 * rejects. Here the two legs are separate objects with separate terms.
 *
 * The rate leg is the rate replicating portfolio. The beta share rolls overnight, priced at the shortest node, a
 * one-month bullet. The share that does not reprice sits on pillars. A k-month pillar is k equal bullets, one maturing
 * each month, so its stock amortizes in a straight line and its life is (k + 1) / 2 months; it earns the new-money par
 * rate of a k-month bullet. The constructions (contracts/position.ts ReplicatingPortfolioForm):
 *
 *   life-target  the pillar whose life is the deposit's life L, or the two whose lives bracket it, weighted so the
 *                blend's life is L: w_hi = (L - life_lo) / (life_hi - life_lo). The deposit's life is that of its
 *                straight-line runoff, (n + 1) / 2;
 *   pillar       one pillar of k months, whatever L is;
 *   strip        the non-repricing share struck once on the deposit's own runoff: the par-matched rate of the runoff.
 *
 * rate credit = sum over tranches of weight x rate.
 *
 * The liquidity leg is the liquidity ladder: the whole balance's runoff, the beta share included, because a repriced
 * dollar is still a funded dollar. liquidity credit = the term liquidity premium at the ladder's life L, read as the
 * par spread of an L-month bullet: its par-matched rate on the all-in curve less the same on the benchmark curve. A
 * fractional L carries a final stub period: the last cash flow sits at month L with an accrual weight equal to the
 * stub. On the whole balance. total credit = rate credit + liquidity credit.
 *
 * Every rate is the kernel's par-matched rate (monthly accrual on the start-of-month balance), so the tranches, the
 * strip and the premium share one basis and add.
 *
 * Readings beside the credit, information only: the par-match of the premium over the runoff itself (a
 * cross-check, which reads above the bullet), the linear interpolation of the bullet spreads at the two whole months
 * around L, and the haircut reading (the bullet spread at a shorter runoff's life). The steepener re-bootstraps the
 * snapshot's par quotes shifted by topBp x (t - t1) / (topYears - t1) below topYears and by topBp from there, the
 * term liquidity premium unchanged, and re-reads the rate leg.
 *
 * Teach slice E3 adds a second reader, for a life that is not a straight-line runoff's: the deposit's own
 * balance path run off in full (a component decay deposit, life the WAL of its path) or a capped
 * life (for example a 60-month cap on a flat full-form book). The beta share is the deposit's own
 * (beta_eff at the scenario on a full form) unless the form states one. It reads every scenario of the run: under
 * "hold-base" the curve stays at the base and only the deposit moves; under "shift" the tranches and the premium are
 * read on the scenario's own curve. The "static-share" construction is the static bifurcation's credit. The
 * straight-line class below is untouched.
 *
 * Pure: no clock, no randomness; the curve and premium are the run's.
 */
import { bootstrapZeroCurve, parMatchedRate, type MarketSnapshot, type TLPCurve, type ZeroCurve } from "@alm/kernel";
import type { EngineNMDBetaTerms, EngineNMDTerms, ReplicatingPortfolioForm } from "../contracts/position";
import type {
  ReplicatingPortfolioLiquidityLeg,
  ReplicatingPortfolioReadout,
  ReplicatingPortfolioScenarioReading,
  ReplicatingPortfolioTranche,
  ScenarioCreditReadout,
} from "../contracts/results";
import { linearBalance } from "../nmd/linearDecay";
import { ComponentDecayDeposit, hasComponentDecay } from "../nmd/componentDecay";
import { hasFullBeta, scenarioState } from "../nmd/fullBeta";

/** The overnight tranche's tenor in months: the pack's shortest node (the curve holds the 1M zero flat below it). */
export const OVERNIGHT_MONTHS = 1;

/** The deposit facts the credit reads. */
export interface RpDeposit {
  positionId: string;
  notional: number;
  /** The repricing beta, a fraction: the share that rolls overnight. */
  beta: number;
  /** n, the months of the straight-line runoff. */
  runoffMonths: number;
}

interface CashflowLike {
  monthOffset: number;
  balance: number;
  principalPaid: number;
}

const STUB_EPS = 1e-12;

/** A bullet of `notional` over `months`; a fractional tenor carries a final stub whose accrual weight is the stub. */
export function bulletCashflows(notional: number, months: number): CashflowLike[] {
  const whole = Math.floor(months + STUB_EPS);
  const stub = months - whole;
  const out: CashflowLike[] = [];
  for (let m = 1; m <= whole; m++) out.push({ monthOffset: m, balance: notional, principalPaid: m === whole && stub < STUB_EPS ? notional : 0 });
  if (stub > STUB_EPS) out.push({ monthOffset: months, balance: notional * stub, principalPaid: notional });
  return out;
}

/** A straight-line runoff of `notional` over `months` whole months: one step of principal a month. */
export function runoffCashflows(notional: number, months: number): CashflowLike[] {
  const step = notional / months;
  const out: CashflowLike[] = [];
  for (let m = 1; m <= months; m++) out.push({ monthOffset: m, balance: linearBalance(notional, months, m - 1), principalPaid: step });
  return out;
}

/** The pricer on one benchmark curve and premium curve. */
export class RpPricer {
  constructor(
    readonly curve: ZeroCurve,
    readonly tlp: TLPCurve,
    readonly notional = 1,
  ) {}

  private allInDf(t: number): number {
    return t <= 0 ? 1 : this.curve.discountFactor(t) * Math.exp(-this.tlp.tlp(t) * t);
  }

  ir(cfs: CashflowLike[]): number {
    return parMatchedRate(cfs, this.notional, (t) => this.curve.discountFactor(t));
  }

  allIn(cfs: CashflowLike[]): number {
    return parMatchedRate(cfs, this.notional, (t) => this.allInDf(t));
  }

  /** The new-money par rate of a k-month bullet on the benchmark curve. */
  bulletRate(months: number): number {
    return this.ir(bulletCashflows(this.notional, months));
  }

  /** The term liquidity premium at a life of `months`: the bullet's all-in par rate less its benchmark par rate. */
  bulletPremium(months: number): number {
    const cfs = bulletCashflows(this.notional, months);
    return this.allIn(cfs) - this.ir(cfs);
  }

  /** The par-matched benchmark rate of a straight-line runoff of `months`. */
  runoffRate(months: number): number {
    return this.ir(runoffCashflows(this.notional, months));
  }

  /** The premium matched to a straight-line runoff of `months`: its all-in par rate less its benchmark par rate. */
  runoffPremium(months: number): number {
    const cfs = runoffCashflows(this.notional, months);
    return this.allIn(cfs) - this.ir(cfs);
  }
}

/** The pillars and weights (within the non-repricing share) that blend to `lifeMonths` on `grid`. */
export function lifeTargetBlend(grid: readonly number[], lifeMonths: number): { months: number; weight: number }[] {
  const life = (k: number) => (k + 1) / 2;
  const exact = grid.find((k) => Math.abs(life(k) - lifeMonths) < 1e-12);
  if (exact !== undefined) return [{ months: exact, weight: 1 }];
  const below = grid.filter((k) => life(k) < lifeMonths);
  const above = grid.filter((k) => life(k) > lifeMonths);
  if (below.length === 0 || above.length === 0) {
    throw new Error(
      `replicating portfolio: no two pillars of [${grid.join(", ")}] months bracket a life of ${lifeMonths} months; ` +
        "widen the pillar grid",
    );
  }
  const lo = below[below.length - 1]!;
  const hi = above[0]!;
  const wHi = (lifeMonths - life(lo)) / (life(hi) - life(lo));
  return [
    { months: lo, weight: 1 - wHi },
    { months: hi, weight: wHi },
  ];
}

/** The steepened snapshot: par quotes shifted by topBp x (t - t1) / (topYears - t1) below topYears, topBp from there. */
export function steepenedSnapshot(snapshot: MarketSnapshot, topBp: number, topYears: number): MarketSnapshot {
  const t1 = Math.min(...snapshot.curveQuotes.map((q) => q.tYears));
  const curveQuotes = snapshot.curveQuotes.map((q) => {
    const s = q.tYears >= topYears ? topBp : (topBp * (q.tYears - t1)) / (topYears - t1);
    return { ...q, rate: q.rate + s / 1e4 };
  });
  return { ...snapshot, curveQuotes };
}

/** The months the stock schedule spans: the as-of, then every month to the longest of the runoff and the pillars. */
function stockMonths(runoffMonths: number, tranches: readonly ReplicatingPortfolioTranche[]): number {
  return Math.max(runoffMonths, ...tranches.map((t) => t.months));
}

/**
 * The replicating-portfolio credit of one deposit. `snapshot` is the run's market, read only for the steepener; the
 * steepener is left out with its reason when the run's curve is not the kernel bootstrap of that snapshot.
 */
export class ReplicatingPortfolioCredit {
  readonly lifeMonths: number;

  constructor(
    readonly deposit: RpDeposit,
    readonly form: ReplicatingPortfolioForm,
  ) {
    if (!(deposit.beta >= 0 && deposit.beta <= 1)) {
      throw new Error(`replicating portfolio: position "${deposit.positionId}" has beta ${deposit.beta}; the beta share must be a fraction`);
    }
    if (!Number.isInteger(deposit.runoffMonths) || deposit.runoffMonths < 1) {
      throw new Error(`replicating portfolio: position "${deposit.positionId}" has a runoff of ${deposit.runoffMonths} months`);
    }
    if (form.construction === "static-share") {
      throw new Error(`replicating portfolio: position "${deposit.positionId}" carries the "static-share" construction, which reads a balance path, not a runoff`);
    }
    this.lifeMonths = (deposit.runoffMonths + 1) / 2;
  }

  /** The tranches and their rates on one pricer. */
  tranches(p: RpPricer): ReplicatingPortfolioTranche[] {
    const { beta, runoffMonths } = this.deposit;
    const out: ReplicatingPortfolioTranche[] = [];
    if (beta > 0) out.push({ kind: "overnight", months: OVERNIGHT_MONTHS, weight: beta, rate: p.bulletRate(OVERNIGHT_MONTHS) });
    const rest = 1 - beta;
    if (rest > 0) {
      switch (this.form.construction) {
        case "life-target":
          for (const b of lifeTargetBlend(this.form.pillarGridMonths ?? [], this.lifeMonths)) {
            out.push({ kind: "pillar", months: b.months, weight: rest * b.weight, rate: p.bulletRate(b.months) });
          }
          break;
        case "pillar":
          out.push({ kind: "pillar", months: this.form.pillarMonths!, weight: rest, rate: p.bulletRate(this.form.pillarMonths!) });
          break;
        case "strip":
          out.push({ kind: "strip", months: runoffMonths, weight: rest, rate: p.runoffRate(runoffMonths) });
          break;
      }
    }
    return out;
  }

  /** The full readout on the run's curve and premium. */
  readout(curve: ZeroCurve, tlp: TLPCurve, snapshot?: MarketSnapshot): ReplicatingPortfolioReadout {
    const p = new RpPricer(curve, tlp);
    const tranches = this.tranches(p);
    const rateCredit = tranches.reduce((s, t) => s + t.weight * t.rate, 0);
    const liquidityCredit = p.bulletPremium(this.lifeMonths);
    const { notional, beta, runoffMonths } = this.deposit;

    // The stock schedule, month-end, $: month 0 is the whole book on every ladder. From month 1 the beta share has
    // repriced, so it leaves the liability's fixed-rate gap and the rate portfolio, and stays on the liquidity ladder.
    const last = stockMonths(runoffMonths, tranches);
    const liability: number[] = [];
    const portfolio: number[] = [];
    const net: number[] = [];
    const ladder: number[] = [];
    for (let t = 0; t <= last; t++) {
      const l = t === 0 ? notional : (1 - beta) * linearBalance(notional, runoffMonths, t);
      const rp =
        t === 0
          ? notional
          : tranches.reduce((s, tr) => (tr.kind === "overnight" ? s : s + tr.weight * linearBalance(notional, tr.months, t)), 0);
      liability.push(l);
      portfolio.push(rp);
      net.push(rp - l);
      ladder.push(linearBalance(notional, runoffMonths, t));
    }

    const runoffPremium = p.runoffPremium(runoffMonths);
    const lo = Math.floor(this.lifeMonths);
    const hi = Math.ceil(this.lifeMonths);
    const bracketPremium =
      lo === hi ? liquidityCredit : p.bulletPremium(lo) + (this.lifeMonths - lo) * (p.bulletPremium(hi) - p.bulletPremium(lo));
    const out: ReplicatingPortfolioReadout = {
      positionId: this.deposit.positionId,
      construction: this.form.construction as ReplicatingPortfolioReadout["construction"],
      beta,
      runoffMonths,
      lifeMonths: this.lifeMonths,
      tranches,
      rateCredit,
      liquidityCredit,
      totalCredit: rateCredit + liquidityCredit,
      stock: { liabilityFixedRateGap: liability, portfolio, net, liquidityLadder: ladder },
      readings: {
        runoffPremium,
        runoffWithinOneBp: Math.abs(runoffPremium - liquidityCredit) * 1e4 <= 1,
        bracketPremium,
      },
    };
    if (this.form.haircutMonths !== undefined) {
      const life = (this.form.haircutMonths + 1) / 2;
      const premium = p.bulletPremium(life);
      out.readings.haircut = { runoffMonths: this.form.haircutMonths, lifeMonths: life, liquidityCredit: premium, totalCredit: rateCredit + premium };
    }
    if (this.form.steepener !== undefined) {
      const { topBp, topYears } = this.form.steepener;
      const refused = snapshot === undefined ? "the run's market snapshot was not handed to the FTP block" : curveMismatch(curve, snapshot);
      if (refused !== null) {
        out.steepener = { topBp, topYears, refused };
      } else {
        const ps = new RpPricer(bootstrapZeroCurve(steepenedSnapshot(snapshot!, topBp, topYears)), tlp);
        const steep = this.tranches(ps);
        out.steepener = { topBp, topYears, rateCredit: steep.reduce((s, t) => s + t.weight * t.rate, 0), trancheRates: steep.map((t) => t.rate) };
      }
    }
    return out;
  }
}

/**
 * Null when the run's curve is the kernel bootstrap of `snapshot` (the steepener re-bootstraps the same way, so base
 * and steepened readings share one curve builder); else the reason the steepener is left out.
 */
function curveMismatch(curve: ZeroCurve, snapshot: MarketSnapshot): string | null {
  const own = bootstrapZeroCurve(snapshot);
  for (let m = 1; m <= 360; m++) {
    const t = m / 12;
    if (Math.abs(own.discountFactor(t) - curve.discountFactor(t)) > 1e-14) {
      return "the run's base curve is not the kernel bootstrap of its market's par quotes, so a re-bootstrapped steepener would not share its basis";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The credit on a life that is not a straight-line runoff's, read at every scenario.
// ---------------------------------------------------------------------------------------------------------------------

/** What one scenario hands the credit: the beta share, the life, the static share and the paid rate, if any. */
export interface RpScenarioFacts {
  scenarioId: string;
  /** The beta share, a fraction. */
  beta: number;
  /** The life in months the rate portfolio is capped at and the premium is read at. */
  lifeMonths: number;
  /** The static bifurcation's stable share (the "static-share" construction only). */
  staticShare?: number;
  /** The deposit's equilibrium paid rate, decimal (a full-form deposit only). */
  paidRate?: number;
}

/**
 * The credit at one scenario, on one pricer (the base curve held, or the scenario's own).
 *
 *   life-target   beta overnight, (1 - beta) on the pillars that blend to the life; liquidity: the whole balance at
 *                 the premium of the life;
 *   pillar        beta overnight, (1 - beta) on the one pillar; liquidity as life-target;
 *   static-share  beta + (1 - s)(1 - beta) overnight, s (1 - beta) on the pillars that blend to the (frozen base)
 *                 life; liquidity: s of the balance at the premium of the life, (1 - s) at the one-month premium.
 */
export function scenarioCredit(facts: RpScenarioFacts, form: ReplicatingPortfolioForm, p: RpPricer): ReplicatingPortfolioScenarioReading {
  const { beta, lifeMonths } = facts;
  if (!(beta >= 0 && beta <= 1)) throw new Error(`replicating portfolio: scenario "${facts.scenarioId}" reads beta ${beta}; the beta share must be a fraction`);
  if (!(lifeMonths >= OVERNIGHT_MONTHS)) throw new Error(`replicating portfolio: scenario "${facts.scenarioId}" reads a life of ${lifeMonths} months`);
  const s = form.construction === "static-share" ? facts.staticShare : 1;
  if (s === undefined || !(s >= 0 && s <= 1)) throw new Error(`replicating portfolio: the "static-share" construction needs a static share between 0 and 1, got ${String(s)}`);
  const termShare = s * (1 - beta);
  const onShare = 1 - termShare;
  const tranches: ReplicatingPortfolioTranche[] = [];
  if (onShare > 0) tranches.push({ kind: "overnight", months: OVERNIGHT_MONTHS, weight: onShare, rate: p.bulletRate(OVERNIGHT_MONTHS) });
  if (termShare > 0) {
    switch (form.construction) {
      case "life-target":
      case "static-share":
        for (const b of lifeTargetBlend(form.pillarGridMonths ?? [], lifeMonths)) {
          tranches.push({ kind: "pillar", months: b.months, weight: termShare * b.weight, rate: p.bulletRate(b.months) });
        }
        break;
      case "pillar":
        tranches.push({ kind: "pillar", months: form.pillarMonths!, weight: termShare, rate: p.bulletRate(form.pillarMonths!) });
        break;
      case "strip":
        throw new Error("replicating portfolio: the strip reads a straight-line runoff");
    }
  }
  const liquidityLegs: ReplicatingPortfolioLiquidityLeg[] = [{ months: lifeMonths, weight: s, premium: p.bulletPremium(lifeMonths) }];
  if (s < 1) liquidityLegs.push({ months: OVERNIGHT_MONTHS, weight: 1 - s, premium: p.bulletPremium(OVERNIGHT_MONTHS) });
  const rateCredit = tranches.reduce((acc, t) => acc + t.weight * t.rate, 0);
  const liquidityCredit = liquidityLegs.reduce((acc, l) => acc + l.weight * l.premium, 0);
  return {
    scenarioId: facts.scenarioId,
    beta,
    lifeMonths,
    tranches,
    rateCredit,
    liquidityCredit,
    totalCredit: rateCredit + liquidityCredit,
    liquidityLegs,
    ...(facts.paidRate !== undefined ? { paidRate: facts.paidRate } : {}),
  };
}

/** One scenario of the run, as the FTP block hands it to the credit: its id, the deposit's shift and its own curve. */
export interface RpRunScenario {
  scenarioId: string;
  /** The scenario's level shift of the deposit's driver, percent (0 on the base). */
  shiftPct: number;
  /** The scenario's own curve (the base curve on the base scenario). */
  curve: ZeroCurve;
}

/** The facts of one deposit at one scenario's shift, read off the deposit's own terms and the credit's form. */
export function depositFacts(terms: EngineNMDTerms | EngineNMDBetaTerms, form: ReplicatingPortfolioForm, scenarioId: string, shiftPct: number): RpScenarioFacts {
  const refuse = (detail: string): never => {
    throw new Error(`replicating portfolio: position "${terms.id}" ${detail}`);
  };
  const life = form.life;
  if (life === undefined) return refuse("reads a straight-line runoff; this reader is for the balance path and the capped life");
  let lifeMonths: number;
  let staticShare: number | undefined;
  if (life.source === "balance-path") {
    if (terms.type !== "nmd" || !hasComponentDecay(terms)) return refuse("reads its balance path, which needs the component decay form");
    lifeMonths = new ComponentDecayDeposit(terms, shiftPct).fullRunoffLifeMonths();
    staticShare = terms.componentDecay.staticShare;
  } else {
    lifeMonths = life.months;
  }
  const full = terms.type === "nmd-b" && hasFullBeta(terms) ? terms : undefined;
  let beta: number;
  if (form.beta?.source === "fixed") beta = form.beta.value;
  else if (form.beta?.source === "s-curve-ceiling") {
    if (terms.type !== "nmd-b") return refuse("reads the ceiling of an S-curve, which only an nmd-b carries");
    beta = terms.sCurve.betaMax;
  } else if (full !== undefined) beta = scenarioState(full.sCurve, full.fullBeta, shiftPct).betaEff;
  else if (terms.type === "nmd") beta = terms.beta;
  else return refuse("is an nmd-b without the full beta form; its beta at the scenario is not read here, so state one");
  const paidRate = full !== undefined ? scenarioState(full.sCurve, full.fullBeta, shiftPct).targetPct / 100 : undefined;
  return { scenarioId, beta, lifeMonths, ...(staticShare !== undefined ? { staticShare } : {}), ...(paidRate !== undefined ? { paidRate } : {}) };
}

/**
 * The readout of a credit on the balance path or a capped life: the credit at every scenario, the base one at the top.
 * The base curve is held for every scenario under "hold-base" (and when the form names no scenario reading, where the
 * run allows the base scenario only); under "shift" each scenario's tranches and premium are read on its own curve.
 */
export function scenarioCreditReadout(
  terms: EngineNMDTerms | EngineNMDBetaTerms,
  form: ReplicatingPortfolioForm,
  baseCurve: ZeroCurve,
  tlp: TLPCurve,
  scenarios: readonly RpRunScenario[],
  baseScenarioId: string,
): ScenarioCreditReadout {
  if (form.construction === "strip") throw new Error(`replicating portfolio: position "${terms.id}" carries a strip, which reads a straight-line runoff`);
  const held = new RpPricer(baseCurve, tlp);
  const byScenario = scenarios.map((sc) => {
    const p = form.scenarioCurve === "shift" ? new RpPricer(sc.curve, tlp) : held;
    return scenarioCredit(depositFacts(terms, form, sc.scenarioId, sc.shiftPct), form, p);
  });
  const base = byScenario.find((r) => r.scenarioId === baseScenarioId);
  if (base === undefined) throw new Error(`replicating portfolio: the run hands no reading for its base scenario "${baseScenarioId}"`);
  return {
    positionId: terms.id,
    construction: form.construction,
    lifeSource: form.life!.source,
    ...(form.scenarioCurve !== undefined ? { scenarioCurve: form.scenarioCurve } : {}),
    beta: base.beta,
    lifeMonths: base.lifeMonths,
    tranches: base.tranches,
    rateCredit: base.rateCredit,
    liquidityCredit: base.liquidityCredit,
    totalCredit: base.totalCredit,
    liquidityLegs: base.liquidityLegs,
    ...(base.paidRate !== undefined ? { paidRate: base.paidRate } : {}),
    byScenario,
  };
}
