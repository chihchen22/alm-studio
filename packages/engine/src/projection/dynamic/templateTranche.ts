/**
 * New-volume product templates: the tranche a template mints, its validation, the
 * default template a family's own book suggests, and the preview the guided New volume step draws.
 *
 * A template tranche minted at bucket k is generated on ForwardStartPath(path, k), so its month m reads the scenario's
 * step k + m - 1 (forwardStart.ts). Bullet and level-pay schedules are the kernel's FixedLoan and FloatingLoan. The
 * one schedule written here is "linear" (equal principal each month), which the kernel does not offer: principal
 * N / T a month, the remaining balance in the last month, interest on the balance at the start of the month at the
 * month's coupon, the same accrual the kernel loans use. A floating linear tranche resets its coupon on the kernel
 * floater's grid (months 1, 1 + R, 1 + 2R, ...).
 *
 * A fixed template's base rate is, by default, the tranche's matched funding rate (fix round M3): the rate that
 * par-matches its own principal schedule on the scenario's discount factors from its origination month times the
 * term liquidity premium, by the kernel's parMatchedRate, the function its FTP charge uses. The discount factors are
 * read off the path itself, D(m) = D(m - 1) / (1 + r(m - 1) / 12), the accrual identity of the one-month rate, so a
 * shocked or plugged-in path prices its own new volume. A level-pay schedule depends on its coupon, so the rate is a
 * fixed point (coupon = rate + spread, rate = par match of the schedule at that coupon), reached in a few steps.
 *
 * A template with `behavior: "family"` carries its family's model (familyBehavior.ts), aged from the
 * tranche's own origination. A fixed level-payment tranche of a mortgage family is the kernel Mortgage at age 0 on its
 * family's four-factor CPR, and of a fixed-loan family bound to a constant CPR the engine's ConstantCprFixedLoan; a
 * deposit template mints a new deposit cohort of the family's kind (the kernel NMDeposit or NMDBeta) whose decay
 * closure starts at age 0 and whose moving-average window reads the kernel's warmup history followed by the scenario's
 * own path up to the origination month, so the cohort sees the rate history the opening book sees in that month. A
 * template without `behavior` mints the contractual tranche S2b-1 minted, byte for byte.
 */
import {
  buildWarmupSOFR1M,
  FixedLoan,
  FloatingLoan,
  FourFactorCPR,
  Mortgage,
  NMDBeta,
  NMDeposit,
  parMatchedRate,
  type TLPCurve,
  type Cashflow,
  type FixedLoanTerms,
  type FloatingLoanTerms,
  type Instrument,
  type RatePath,
} from "@alm/kernel";
import { IndexRatePath } from "../../rateIndex/indexRatePath";
import type { RateIndexTenor } from "../../contracts/rateIndex";
import type { ProductFamilyDef } from "../../contracts/chartOfAccounts";
import type { Position } from "../../contracts/position";
import { FLOATING_INDEX_TENORS_MONTHS, type NewBusinessAmortization, type NewBusinessTemplate } from "../../contracts/scenario";
import { MAX_TEMPLATE_TERM_MONTHS, newVolumeTemplateProblem } from "../../plan/newVolumeTemplate";
import { ForwardStartPath } from "./forwardStart";
import { ConstantCprFixedLoan } from "../../loanPrepay/constantCprFixedLoan";
import { NotImplementedError } from "../../runtime/notImplemented";
import { behaviorGap, behaviorNoteOf, type FamilyBehavior } from "./familyBehavior";
import type { NewVolumeBehaviorNote } from "../../contracts/results";

/** Linear (equal principal) terms: the kernel loan shape with the one amortization the kernel does not carry. */
type LinearTerms<T extends FixedLoanTerms | FloatingLoanTerms> = Omit<T, "amortType"> & { amortType: "linear" };

/** One linear-amortization schedule. `couponAt(m)` is the coupon of month m (1-based), already reset where it resets. */
function linearSchedule(notional: number, termMonths: number, couponAt: (m: number) => number): Cashflow[] {
  const out: Cashflow[] = [];
  const step = notional / termMonths;
  let bal = notional;
  for (let m = 1; m <= termMonths; m++) {
    const coupon = couponAt(m);
    const interest = (bal * coupon) / 12;
    const principal = m === termMonths || step > bal ? bal : step;
    out.push({ monthOffset: m, balance: bal, principalPaid: principal, interestPaid: interest, couponRate: coupon });
    bal -= principal;
    if (bal < 0) bal = 0;
  }
  return out;
}

class LinearFixedTranche implements Instrument {
  constructor(readonly terms: FixedLoanTerms) {}
  repricingSchedule(): number[] {
    return [];
  }
  generateCashflows(_path: RatePath): Cashflow[] {
    const c = this.terms.coupon;
    return linearSchedule(this.terms.notional, this.terms.maturityMonths, () => c);
  }
}

class LinearFloatingTranche implements Instrument {
  constructor(readonly terms: FloatingLoanTerms) {}
  repricingSchedule(): number[] {
    const out: number[] = [];
    for (let m = 1; m <= this.terms.maturityMonths; m += this.terms.resetFrequencyMonths) out.push(m);
    return out;
  }
  generateCashflows(path: RatePath): Cashflow[] {
    const { margin, resetFrequencyMonths: r } = this.terms;
    let current = 0;
    return linearSchedule(this.terms.notional, this.terms.maturityMonths, (m) => {
      if ((m - 1) % r === 0) current = path.rateAt(m - 1) + margin;
      return current;
    });
  }
}

/**
 * A floating tranche: the kernel's floater (or the linear one) reading the index over the tranche's own path. The
 * index is the path's one-month rate for a one-month tenor and the one-month rate compounded over the tenor
 * otherwise (the engine's IndexRatePath), so a three-month floater resets quarterly on a three-month rate.
 */
class FloatingTranche implements Instrument {
  constructor(
    readonly terms: FloatingLoanTerms,
    private readonly inner: Instrument,
  ) {}
  repricingSchedule(): number[] {
    return this.inner.repricingSchedule();
  }
  generateCashflows(path: RatePath): Cashflow[] {
    const n = this.terms.indexTenorMonths;
    return this.inner.generateCashflows(n === 1 ? path : new IndexRatePath(path, { tenorMonths: n as RateIndexTenor, basis: 0 }));
  }
}

/** What the sweep and the FTP block need of one template tranche. */
export interface TemplateTranche {
  /** The tranche, to be generated on `path` (its own, forward-started path). */
  instrument: Instrument;
  /** The scenario path shifted to the origination month. */
  path: ForwardStartPath;
}

/** The most fixed-point steps a level-pay matched rate takes; it settles to 1e-15 in well under ten. */
const MATCHED_MAX_STEPS = 60;

/** A fixed tranche's instrument on one coupon: the kernel's bullet or level-pay loan, or the linear schedule. */
function fixedInstrument(base: Omit<FixedLoanTerms, "type" | "amortType" | "coupon">, amortization: NewBusinessAmortization, coupon: number): Instrument {
  if (amortization === "decay") throw new Error("a fixed tranche repays by a bullet, a level payment or equal principal; \"decay\" is a deposit's");
  if (amortization === "linear") {
    const terms: LinearTerms<FixedLoanTerms> = { ...base, type: "fixed-loan", amortType: "linear", coupon };
    return new LinearFixedTranche(terms as unknown as FixedLoanTerms);
  }
  return new FixedLoan({ ...base, type: "fixed-loan", amortType: amortization, coupon });
}

/**
 * The matched funding rate of a fixed schedule minted at the path's step 0 (fix round M3): r with
 * r = parMatchedRate(schedule at coupon r + spread, all-in discount factors). The all-in discount factor of month m is
 * D(m) exp(-tlp(m / 12) m / 12), the kernel FTP's own all-in factor, with D read off the path's one-month rates.
 */
export function matchedFixedRate(
  path: RatePath,
  base: Omit<FixedLoanTerms, "type" | "amortType" | "coupon">,
  amortization: NewBusinessAmortization,
  spread: number,
  tlp: TLPCurve,
): number {
  return matchedRateOf(path, base.notional, base.maturityMonths, spread, tlp, (coupon) => fixedInstrument(base, amortization, coupon));
}

/**
 * The matched-rate fixed point of any fixed-coupon schedule: `build(coupon)` is the tranche at that coupon, so a
 * prepaying tranche's rate par-matches its behavioral schedule, the stream its FTP charge par-matches. The arithmetic is
 * matchedFixedRate's, operation for operation.
 */
function matchedRateOf(path: RatePath, notional: number, term: number, spread: number, tlp: TLPCurve, build: (coupon: number) => Instrument): number {
  const D = new Float64Array(term + 1);
  D[0] = 1;
  for (let m = 1; m <= term; m++) D[m] = D[m - 1]! / (1 + path.rateAt(m - 1) / 12);
  const dfAll = (t: number): number => {
    const m = Math.round(t * 12);
    return m <= 0 ? 1 : D[m]! * Math.exp(-tlp.tlp(t) * t);
  };
  let r = path.forwardRateAt(0, term / 12);
  for (let i = 0; i < MATCHED_MAX_STEPS; i++) {
    const cf = build(r + spread).generateCashflows(path);
    const next = parMatchedRate(cf, notional, dfAll);
    if (Math.abs(next - r) < 1e-15) return next;
    r = next;
  }
  return r;
}

/**
 * Mint one template tranche at bucket k on the scenario's path. A fixed coupon is locked at origination: its matched
 * funding rate (the default) or the par swap rate over the template's tenor from step k (`fixedIndex: "swap"`), plus
 * the spread. A floating tranche carries the spread as its margin and reads its index at every reset. `tlp` is the
 * run's term liquidity premium curve, required by the matched rate.
 */
export function templateTranche(
  family: Pick<ProductFamilyDef, "id" | "label" | "side">,
  originationBucket: number,
  notional: number,
  termMonths: number,
  spreadOverIndexBp: number,
  template: NewBusinessTemplate,
  scenarioPath: RatePath,
  tlp?: TLPCurve,
  /** The family's model, required when the template asks for behavior ("family"). */
  behavior?: FamilyBehavior,
): TemplateTranche {
  const problem = newVolumeTemplateProblem(template, termMonths, spreadOverIndexBp);
  if (problem !== null) throw new Error(`new-volume template for family "${family.id}": ${problem}`);
  const path = new ForwardStartPath(scenarioPath, originationBucket);
  if (template.behavior === "family") {
    if (behavior === undefined) throw new Error(`new-volume template for family "${family.id}": a behavioral template needs the family's model`);
    const carried = behavioralTranche(family, originationBucket, notional, termMonths, spreadOverIndexBp, template, scenarioPath, path, behavior, tlp);
    if (carried !== null) return carried;
  }
  const side: "asset" | "liability" = family.side === "liability" ? "liability" : "asset";
  const base = {
    id: `${family.id}~nb~${originationBucket}`,
    label: `${family.label} new business @${originationBucket}`,
    notional,
    maturityMonths: termMonths,
    originationOffsetMonths: 0,
    side,
  };
  if (template.rateType === "fixed") {
    const spread = spreadOverIndexBp / 1e4;
    let index: number;
    if (template.fixedIndex === "swap") {
      index = path.forwardRateAt(0, template.indexTenorMonths / 12);
    } else {
      if (tlp === undefined) throw new Error(`new-volume template for family "${family.id}": a matched fixed rate needs the run's term liquidity premium curve`);
      index = matchedFixedRate(path, base, template.amortization, spread, tlp);
    }
    return { instrument: fixedInstrument(base, template.amortization, index + spread), path };
  }
  if (template.rateType === "deposit" || template.amortization === "decay") {
    throw new Error(`new-volume template for family "${family.id}": a deposit template carries its family's model (behavior "family")`);
  }
  const n = template.indexTenorMonths;
  const margin = spreadOverIndexBp / 1e4;
  if (template.amortization === "linear") {
    const terms: LinearTerms<FloatingLoanTerms> = { ...base, type: "floating-loan", amortType: "linear", indexTenorMonths: n, margin, resetFrequencyMonths: n };
    const inner = new LinearFloatingTranche(terms as unknown as FloatingLoanTerms);
    return { instrument: new FloatingTranche(inner.terms, inner), path };
  }
  const terms: FloatingLoanTerms = { ...base, type: "floating-loan", amortType: template.amortization, indexTenorMonths: n, margin, resetFrequencyMonths: n };
  return { instrument: new FloatingTranche(terms, new FloatingLoan(terms)), path };
}

/** The kernel's own moving-average warmup, built once: the history every deposit of a dynamic run starts from. */
let kernelWarmup: readonly number[] | undefined;

/**
 * The warmup a deposit cohort made at bucket k reads: the kernel's history followed by the scenario's one-month
 * rate (percent) at steps 0 to k - 1, so month m of the cohort reads the same trailing window the opening book's
 * deposits read at step k + m - 1.
 */
export function cohortWarmup(scenarioPath: RatePath, originationBucket: number, history?: readonly number[]): number[] {
  // A run that named a "history" warmup starts its cohorts' window from that history instead.
  kernelWarmup ??= buildWarmupSOFR1M();
  const out = (history ?? kernelWarmup).slice();
  for (let s = 0; s < originationBucket; s++) out.push(scenarioPath.rateAt(s) * 100);
  return out;
}

/**
 * The tranche a behavioral template mints, or null when the product cannot carry the family's model (the tranche is
 * then the contractual one, and the product's note says why). A deposit template on a family with no deposit model is
 * refused, never minted as something else.
 */
function behavioralTranche(
  family: Pick<ProductFamilyDef, "id" | "label" | "side">,
  k: number,
  notional: number,
  termMonths: number,
  spreadOverIndexBp: number,
  template: NewBusinessTemplate,
  scenarioPath: RatePath,
  path: ForwardStartPath,
  b: FamilyBehavior,
  tlp?: TLPCurve,
): TemplateTranche | null {
  const gap = behaviorGap(template, b);
  if (gap !== null) {
    if (template.rateType === "deposit") throw new NotImplementedError("projection.dynamic", `new-volume template for family "${family.id}": ${gap}`);
    return null;
  }
  const side: "asset" | "liability" = family.side === "liability" ? "liability" : "asset";
  const id = `${family.id}~nb~${k}`;
  const label = `${family.label} new business @${k}`;
  if (b.model === "nmd-decay" || b.model === "nmd-decay-beta") {
    const warm = cohortWarmup(scenarioPath, k, b.warmupHistory);
    const common = { id, label, notional, maturityMonths: termMonths, originationOffsetMonths: 0, amortType: "level-pay" as const, side };
    const instrument = b.model === "nmd-decay"
      ? new NMDeposit({ ...common, type: "nmd", depositRate: b.nmd!.depositRate, beta: b.nmd!.beta, nmdParams: structuredClone(b.nmd!.nmdParams) }, warm)
      : new NMDBeta({ ...common, type: "nmd-b", sCurve: { ...b.nmdB!.sCurve }, nmdParams: structuredClone(b.nmdB!.nmdParams) }, warm);
    return { instrument, path };
  }
  // A prepaying fixed level-payment loan: the kernel mortgage (four-factor CPR) or the constant-CPR loan, at age 0.
  const spread = spreadOverIndexBp / 1e4;
  const build = (coupon: number): Instrument => {
    if (b.model === "four-factor-cpr") {
      return new Mortgage({
        id, label, type: "mortgage", notional, maturityMonths: termMonths, originationOffsetMonths: 0, amortType: "level-pay", side,
        noteRate: coupon, originalTermMonths: termMonths, originalBalance: notional, ageMonths: 0, cprParams: { ...b.cprParams! },
      });
    }
    return new ConstantCprFixedLoan({ id, label, type: "fixed-loan", notional, maturityMonths: termMonths, originationOffsetMonths: 0, amortType: "level-pay", coupon, side, prepay: { ...b.prepay! } });
  };
  let index: number;
  if (template.fixedIndex === "swap") {
    index = path.forwardRateAt(0, template.indexTenorMonths / 12);
  } else {
    if (tlp === undefined) throw new Error(`new-volume template for family "${family.id}": a matched fixed rate needs the run's term liquidity premium curve`);
    index = matchedRateOf(path, notional, termMonths, spread, tlp, build);
  }
  return { instrument: build(index + spread), path };
}

/**
 * The CPR by month a behavioral loan template's tranche made at month 0 runs (the New volume step's preview):
 * the four-factor model's own schedule on the tranche's context (age 0, its note rate, the mortgage rate the kernel
 * Mortgage reads: the 10-year forward plus the model's two spreads), or the constant CPR. Null for any other model.
 */
export function cprByMonth(b: FamilyBehavior, termMonths: number, noteRate: number, path: RatePath): number[] | null {
  if (b.model === "constant-cpr") return new Array<number>(termMonths).fill(b.prepay!.annualCpr);
  if (b.model !== "four-factor-cpr") return null;
  const p = b.cprParams!;
  const totalSpread = (p.secSpread + p.primSpread) / 1e4;
  const schedule = new FourFactorCPR({ ...p, wac: noteRate * 100 }).cprSchedule({
    term: termMonths,
    age: 0,
    noteRate,
    mortgageRateAt: (m) => path.forwardRateAt(m - 1, 10) + totalSpread,
  });
  return Array.from(schedule);
}

// ---------------------------------------------------------------------------
// The default template a family's own book suggests (new guided setups only)
// ---------------------------------------------------------------------------

/** A template with its term, as a setup row carries it (the spread is the setup's own, 0 by default). */
export interface SuggestedTemplate {
  template: NewBusinessTemplate;
  termMonths: number;
  /** One plain sentence on where the suggestion comes from. */
  basis: string;
}

const clampTerm = (m: number): number => Math.min(MAX_TEMPLATE_TERM_MONTHS, Math.max(1, Math.round(m)));

/**
 * The family's own terms as a template, for a new guided setup: the rate type and amortization of the family's
 * largest position (by notional, first in book order on a tie), and the notional-weighted remaining term of its
 * positions (a mortgage's original term). Every suggestion carries the family's behavior
 * (`behavior: "family"`), and a deposit family (nmd, nmd-b) is suggested a deposit cohort of its own kind over the
 * notional-weighted life of its positions. Null for a family whose new volume is neither a loan, a bond nor a
 * non-maturity deposit (term deposits, commitments, swaps): those keep today's rule.
 */
export function suggestedTemplate(
  family: Pick<ProductFamilyDef, "id" | "side">,
  positions: readonly Position[],
  /**
   * Fix round M3: the family's effective model, when known. A deposit family whose model a deposit product cannot carry
   * (a component, linear or full-beta form, a replicating-portfolio credit) is then suggested nothing, so it opens on
   * today's fixed-rate stand-in, never on a product the run would refuse.
   */
  behavior?: Pick<FamilyBehavior, "model">,
): SuggestedTemplate | null {
  const own = positions.filter((p) => p.familyId === family.id);
  if (own.length === 0 || (family.side !== "asset" && family.side !== "liability")) return null;
  let largest = own[0]!;
  for (const p of own) if (p.terms.notional > largest.terms.notional) largest = p;
  const t = largest.terms;
  if (t.type === "nmd" || t.type === "nmd-b") {
    if (own.some((p) => p.terms.type !== t.type)) return null;
    if (behavior !== undefined && behavior.model !== "nmd-decay" && behavior.model !== "nmd-decay-beta") return null;
    let wLife = 0;
    let wDep = 0;
    for (const p of own) {
      wLife += p.terms.maturityMonths * p.terms.notional;
      wDep += p.terms.notional;
    }
    return {
      template: { rateType: "deposit", amortization: "decay", indexTenorMonths: 1, behavior: "family" },
      termMonths: clampTerm(wDep > 0 ? wLife / wDep : t.maturityMonths),
      basis: t.type === "nmd-b"
        ? "A new deposit like the family's: its balance decays and its rate reprices by the family's model."
        : "A new deposit like the family's: its balance decays by the family's model, at the family's own rate.",
    };
  }
  if (t.type !== "fixed-loan" && t.type !== "floating-loan" && t.type !== "mortgage") return null;
  if (own.some((p) => p.terms.type !== t.type)) return null;
  let wTerm = 0;
  let wSum = 0;
  for (const p of own) {
    const life = p.terms.type === "mortgage" ? p.terms.originalTermMonths : p.terms.maturityMonths;
    wTerm += life * p.terms.notional;
    wSum += p.terms.notional;
  }
  const termMonths = clampTerm(wSum > 0 ? wTerm / wSum : t.maturityMonths);
  const amortization: NewBusinessAmortization = t.amortType === "bullet" ? "bullet" : "level-pay";
  if (t.type === "floating-loan") {
    const n = FLOATING_INDEX_TENORS_MONTHS.includes(t.resetFrequencyMonths) && t.resetFrequencyMonths <= termMonths ? t.resetFrequencyMonths : 1;
    return {
      template: { rateType: "floating", amortization, indexTenorMonths: n, behavior: "family" },
      termMonths,
      basis: `Floating like the family's positions, resetting every ${n === 1 ? "month" : `${n} months`}, over their average term.`,
    };
  }
  return {
    template: { rateType: "fixed", amortization, indexTenorMonths: termMonths, fixedIndex: "matched", behavior: "family" },
    termMonths,
    basis: t.type === "mortgage"
      ? "Fixed rate, level payment, over the original term of the family's mortgages, prepaying by the family's model."
      : `Fixed rate, ${amortization === "bullet" ? "bullet" : "level payment"}, like the family's positions, over their average term.`,
  };
}

// ---------------------------------------------------------------------------
// The preview the guided step draws
// ---------------------------------------------------------------------------

export interface TemplatePreview {
  /** The base rate at origination today (decimal): the matched funding rate or the swap rate of a fixed template, the index of a floater. */
  indexRate: number;
  /**
   * A fixed template only (fix round M3): its matched funding rate today (the all-in transfer rate its FTP charges) and
   * the margin over it, coupon less transfer rate, decimal. A matched product's margin is its spread.
   */
  transferRate?: number;
  margin?: number;
  /** The first month's coupon (decimal): index plus spread. */
  couponRate: number;
  /** The balance at the start of each month of a 100-unit tranche originated today, and its coupon that month. */
  months: Array<{ month: number; balance: number; couponRate: number }>;
  /** A behavioral template only, the model its tranches run (or why they are contractual). */
  behavior?: NewVolumeBehaviorNote;
  /** A loan tranche that runs a prepayment model, its annual CPR by month (decimal), month 1 first. */
  cprByMonth?: number[];
}

/**
 * A 100-unit tranche of the template originated at month 0 on the base path, as the run would build it. A
 * behavioral template reads the family's model (`behavior`, required then), and a deposit tranche is a liability.
 */
export function previewTemplate(
  termMonths: number,
  spreadOverIndexBp: number,
  template: NewBusinessTemplate,
  basePath: RatePath,
  tlp: TLPCurve,
  behavior?: FamilyBehavior,
): TemplatePreview {
  const side = template.rateType === "deposit" ? "liability" : "asset";
  const t = templateTranche({ id: "preview", label: "Preview", side }, 0, 100, termMonths, spreadOverIndexBp, template, basePath, tlp, behavior);
  const cfs = t.instrument.generateCashflows(t.path);
  const couponRate = cfs[0]?.couponRate ?? 0;
  const out: TemplatePreview = {
    indexRate: couponRate - spreadOverIndexBp / 1e4,
    couponRate,
    months: cfs.map((c) => ({ month: c.monthOffset, balance: c.balance, couponRate: c.couponRate })),
  };
  if (template.rateType === "fixed") {
    const base = { id: "preview", notional: 100, maturityMonths: termMonths, originationOffsetMonths: 0, side: "asset" as const };
    // The transfer rate of the schedule as minted: the par match at its own coupon, so a swap-priced product shows its gap.
    const D = new Float64Array(termMonths + 1);
    D[0] = 1;
    for (let m = 1; m <= termMonths; m++) D[m] = D[m - 1]! / (1 + t.path.rateAt(m - 1) / 12);
    const transferRate = parMatchedRate(cfs, base.notional, (u) => {
      const m = Math.round(u * 12);
      return m <= 0 ? 1 : D[m]! * Math.exp(-tlp.tlp(u) * u);
    });
    out.transferRate = transferRate;
    out.margin = couponRate - transferRate;
  }
  if (template.behavior === "family" && behavior !== undefined) {
    const note = behaviorNoteOf(template, behavior);
    out.behavior = note;
    if (note.applied) {
      const cpr = cprByMonth(behavior, termMonths, couponRate, t.path);
      if (cpr !== null) out.cprByMonth = cpr;
    }
  }
  return out;
}
