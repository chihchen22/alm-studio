/**
 * The SEG block: sensitivity
 * equivalent gap, the equivalent balance profile and constant-balance NII, on
 * the book's own earnings convention, which differs from the engine's runoff
 * NII in two ways: runoff is replaced by new vintages so the balance
 * sheet stays constant, and the shock starts at step 1, so month 1 is
 * unshocked.
 *
 * Everything numerical is the frozen kernel's (analytics/seg.ts): ShockedPath
 * and runStaticBalanceScenario, with the kernel's replacement-vintage rules
 * (makeVintage). This module only chooses the shock sizes and the horizons,
 * signs by side, and sums. Per position, on the base scenario's deterministic
 * path:
 *
 *   SEG pair     static balance at +s and -s (s = shockBp), horizon H + 1, so
 *                the outstanding series reaches t = H:
 *                  cum(t) = (I_up(month t+1) - I_dn(month t+1)) x 12 / (2s)
 *                  out(0) = sign x N; out(t) = sign x (N - cum(t)), t = 1..H
 *                  per(0) = 0; per(t) = out(t-1) - out(t)
 *                (the signed convention: a fixed asset reads +N at t = 0)
 *   bank pair    the same at horizon H, the bank print:
 *                  segBank(i) = (NII_dn - NII_up)(month i+1) x 12 / (2s), signed NII
 *                positive = liability-sensitive. Run apart from the SEG pair
 *                because the kernel truncates each vintage's maturity at the
 *                horizon, and a level-pay vintage's amortisation depends on
 *                that maturity, so the two horizons differ in the last bits of
 *                an amortising book; the print uses the book's horizon H.
 *   EBP          the bank pair's existing-instrument opening balances (no
 *                vintages), averaged over up and down, months 1..H, unsigned.
 *   NII          static balance at 0, +n and -n (n = niiShockBp), horizon 12,
 *                signed by side (assets +, liabilities -), interest only.
 *
 * Sign comes from the position's family side in the chart of accounts, the
 * rule the engine NII uses. A position the block cannot cover is listed in
 * `uncovered` with its reason and enters no total: one the factory cannot
 * build, one the kernel gives no replacement vintage (cd, commitment, swap),
 * one on a family that is neither asset nor liability, and a seasoned fixed
 * loan (the kernel rule anchors its cash flows at origination, not at the
 * as-of date).
 *
 * Determinism: positions in book order, families in chart-of-accounts order,
 * attribution groups in first-appearance order; plain ordered sums; no clock,
 * no RNG. Output arrays are ordinary number arrays.
 */
import {
  Mortgage,
  ShockedPath,
  makeVintage,
  type Instrument,
  type RatePath,
} from "@alm/kernel";
// The kernel walk for every instrument, with prepaying fixed-loan vintages at the parent's CPR.
import { runStaticBalance } from "../loanPrepay";
import type { BalanceSheetSide } from "../contracts/ids";
import type { PortfolioSpec, Position } from "../contracts/position";
import type { SegNii, SegResult, SegSeries } from "../contracts/results";
import { totalAssetNotional } from "../nii/computeNII";
// The cohort-0 prepayment overlay, its own restated walk.
import { mortgageAtFlatCpr, runStaticBalanceSplit } from "./cprOverlay";

/** The book's constants. */
export const SEG_DEFAULTS = {
  horizonMonths: 60,
  niiHorizonMonths: 12,
  shockBp: 10,
  niiShockBp: 200,
} as const;

/** One position's scalars and series, kept for the instrument-level results file. */
export interface PositionSegRow {
  niiBase12: number;
  niiUp12: number;
  niiDown12: number;
  /** horizonMonths + 1 entries, t = 0..horizonMonths, signed. */
  segOutstanding: number[];
  /** horizonMonths entries, months 1..horizonMonths, unsigned. */
  ebp: number[];
  /** segPeak.value of the position's own series. */
  segPeak: number;
}

export interface SegInput {
  /** The overlaid base book. */
  book: PortfolioSpec;
  /** The base scenario's deterministic path; it must reach horizonMonths + 1 steps. */
  basePath: RatePath;
  scenarioId: string;
  horizonMonths: number;
  niiHorizonMonths: number;
  shockBp: number;
  niiShockBp: number;
  /** The engine factory with the run's options; null when it cannot build the position. */
  makeInstrument: (p: Position) => Instrument | null;
  /**
   * Teach slice C2, optional: by family id, cohort 0's flat CPR under the up and the down shock, with the
   * replacement vintages on the family's own model. It moves the SEG pair, the bank pair and the EBP of a mortgage
   * position on that family; absent, every position runs as before.
   */
  cprOverlay?: ReadonlyMap<string, { upAnnualCpr: number; downAnnualCpr: number }>;
  /**
   * Slice K1 (D6), optional: the deposit history (percent per annum, oldest first) a replacement vintage of a
   * kernel deposit reads, the one the run built the existing deposits on. Absent, the vintages read the kernel's own
   * warmup series, the original convention.
   */
  depositHistory?: readonly number[];
}

/** The attribution-group key a position carries no tag for. */
const UNASSIGNED = "unassigned";

function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

function emptyNii(months: number): SegNii {
  return { base12: 0, up12: 0, down12: 0, baseMonthly: zeros(months), upMonthly: zeros(months), downMonthly: zeros(months) };
}

function emptySeries(horizon: number, niiMonths: number): SegSeries {
  return {
    nii: emptyNii(niiMonths),
    segOutstanding: zeros(horizon + 1),
    segPeriodic: zeros(horizon + 1),
    ebpAssets: zeros(horizon),
    ebpLiabilities: zeros(horizon),
    segPeak: { value: 0, month: 1 },
  };
}

function addInto(target: number[], source: readonly number[]): void {
  for (let i = 0; i < target.length; i++) target[i]! += source[i]!;
}

function addNii(target: SegNii, source: SegNii): void {
  target.base12 += source.base12;
  target.up12 += source.up12;
  target.down12 += source.down12;
  addInto(target.baseMonthly, source.baseMonthly);
  addInto(target.upMonthly, source.upMonthly);
  addInto(target.downMonthly, source.downMonthly);
}

function addSeries(target: SegSeries, source: SegSeries): void {
  addNii(target.nii, source.nii);
  addInto(target.segOutstanding, source.segOutstanding);
  addInto(target.segPeriodic, source.segPeriodic);
  addInto(target.ebpAssets, source.ebpAssets);
  addInto(target.ebpLiabilities, source.ebpLiabilities);
}

/** max |outstanding(t)| over t >= 1, first month on a tie; the value keeps its sign. */
function peakOf(outstanding: readonly number[]): { value: number; month: number } {
  let month = 1;
  for (let t = 2; t < outstanding.length; t++) {
    if (Math.abs(outstanding[t]!) > Math.abs(outstanding[month]!)) month = t;
  }
  return { value: outstanding[month] ?? 0, month };
}

function periodicOf(outstanding: readonly number[]): number[] {
  const per = zeros(outstanding.length);
  for (let t = 1; t < outstanding.length; t++) per[t] = outstanding[t - 1]! - outstanding[t]!;
  return per;
}

function signedNii(
  inst: Instrument,
  base: RatePath,
  shockBp: number,
  months: number,
  sign: number,
  depositHistory?: readonly number[],
): { monthly: number[]; total: number } {
  const path = shockBp === 0 ? base : new ShockedPath(base, shockBp);
  const run = runStaticBalance(inst, path, path, base, months, depositHistory);
  const monthly = zeros(months);
  let total = 0;
  for (let m = 0; m < months; m++) {
    monthly[m] = sign * run.totalInterest[m]!;
    total += monthly[m]!;
  }
  return { monthly, total };
}

/** Why the block cannot cover a position, or undefined when it can. */
function uncoveredReason(p: Position, side: BalanceSheetSide | undefined, inst: Instrument | null, basePath: RatePath): string | undefined {
  if (inst === null) return `no kernel instrument for ${p.terms.type}`;
  if (side !== "asset" && side !== "liability") {
    return `family "${p.familyId}" sits on the ${side ?? "undeclared"} side; the constant-balance convention signs assets and liabilities only`;
  }
  // The kernel's own rule, asked rather than restated: a type it builds no
  // replacement vintage for (cd, commitment, swap) cannot hold a constant balance.
  if (makeVintage(inst, 1, 1, basePath, basePath, 2) === null) {
    return `no replacement vintage for ${p.terms.type} (kernel rule)`;
  }
  const offset = p.terms.originationOffsetMonths;
  if (offset !== 0) {
    return (
      `seasoned ${p.terms.type} (originationOffsetMonths ${offset}): the kernel constant-balance rule ` +
      `anchors the cash flows at origination, not at the as-of date`
    );
  }
  return undefined;
}

/** Compute the block and keep each covered position's row for the instruments file. */
export function computeSegBlock(input: SegInput): { result: SegResult; perPosition: Map<string, PositionSegRow> } {
  const { book, basePath, horizonMonths: H, niiHorizonMonths: NH, shockBp, niiShockBp } = input;
  const deltaR = (2 * shockBp) / 1e4;

  const sideByFamily = new Map<string, BalanceSheetSide>();
  for (const fam of book.coa.families) sideByFamily.set(fam.id, fam.side);
  const tagged = book.positions.some((p) => p.dimensions?.attributionGroup !== undefined);

  const bookSeries = emptySeries(H, NH);
  const segBank = zeros(H);
  const familySeries = new Map<string, SegSeries>();
  const groupNii = new Map<string, SegNii>();
  const perPosition = new Map<string, PositionSegRow>();
  const uncovered: SegResult["uncovered"] = [];

  for (const p of book.positions) {
    const side = sideByFamily.get(p.familyId);
    const inst = input.makeInstrument(p);
    const reason = uncoveredReason(p, side, inst, basePath);
    if (reason !== undefined || inst === null) {
      uncovered.push({ positionId: p.id, reason: reason ?? `no kernel instrument for ${p.terms.type}` });
      continue;
    }
    const sign = side === "liability" ? -1 : 1;
    const notional = inst.terms.notional;
    const up = new ShockedPath(basePath, +shockBp);
    const dn = new ShockedPath(basePath, -shockBp);

    // A family the overlay names walks cohort 0 at its shocked flat CPR, the vintages on the family model.
    const overlay = input.cprOverlay?.get(p.familyId);
    if (overlay !== undefined && !(inst instanceof Mortgage)) {
      throw new Error(
        `seg: the cohort-0 CPR overlay on family "${p.familyId}" needs a kernel mortgage; position "${p.id}" built a ${p.terms.type} instrument`,
      );
    }
    const walk =
      overlay === undefined
        ? (path: RatePath, months: number) => runStaticBalance(inst, path, path, basePath, months, input.depositHistory)
        : (path: RatePath, months: number) =>
            runStaticBalanceSplit(
              mortgageAtFlatCpr(inst as Mortgage, path === up ? overlay.upAnnualCpr : overlay.downAnnualCpr),
              inst,
              path,
              path,
              basePath,
              months,
            );

    // SEG pair, horizon H + 1: the outstanding series t = 0..H.
    const segUp = walk(up, H + 1);
    const segDn = walk(dn, H + 1);
    const outstanding = zeros(H + 1);
    outstanding[0] = sign * notional;
    for (let t = 1; t <= H; t++) {
      const cum = ((segUp.totalInterest[t]! - segDn.totalInterest[t]!) * 12) / deltaR;
      outstanding[t] = sign * (notional - cum);
    }

    // Bank pair, horizon H: the bank print and the EBP.
    const bankUp = walk(up, H);
    const bankDn = walk(dn, H);
    const ebp = zeros(H);
    for (let i = 0; i < H; i++) {
      segBank[i]! += ((sign * bankDn.totalInterest[i]! - sign * bankUp.totalInterest[i]!) * 12) / deltaR;
      ebp[i] = (bankUp.existing.balance[i]! + bankDn.existing.balance[i]!) / 2;
    }

    const base = signedNii(inst, basePath, 0, NH, sign, input.depositHistory);
    const niiUp = signedNii(inst, basePath, +niiShockBp, NH, sign, input.depositHistory);
    const niiDn = signedNii(inst, basePath, -niiShockBp, NH, sign, input.depositHistory);
    const nii: SegNii = {
      base12: base.total,
      up12: niiUp.total,
      down12: niiDn.total,
      baseMonthly: base.monthly,
      upMonthly: niiUp.monthly,
      downMonthly: niiDn.monthly,
    };

    const series: SegSeries = {
      nii,
      segOutstanding: outstanding,
      segPeriodic: periodicOf(outstanding),
      ebpAssets: side === "asset" ? ebp : zeros(H),
      ebpLiabilities: side === "liability" ? ebp : zeros(H),
      segPeak: peakOf(outstanding),
    };
    perPosition.set(p.id, {
      niiBase12: nii.base12,
      niiUp12: nii.up12,
      niiDown12: nii.down12,
      segOutstanding: outstanding,
      ebp,
      segPeak: series.segPeak.value,
    });

    addSeries(bookSeries, series);
    let fam = familySeries.get(p.familyId);
    if (fam === undefined) {
      fam = emptySeries(H, NH);
      familySeries.set(p.familyId, fam);
    }
    addSeries(fam, series);
    if (tagged) {
      const tag = p.dimensions?.attributionGroup;
      const key = tag === undefined ? UNASSIGNED : Array.isArray(tag) ? tag.join("+") : tag;
      let g = groupNii.get(key);
      if (g === undefined) {
        g = emptyNii(NH);
        groupNii.set(key, g);
      }
      addNii(g, nii);
    }
  }

  bookSeries.segPeak = peakOf(bookSeries.segOutstanding);
  // Families in chart-of-accounts order, then any family the chart does not declare.
  const byFamily: Record<string, SegSeries> = {};
  const familyOrder = [...book.coa.families.map((f) => f.id), ...familySeries.keys()];
  for (const id of familyOrder) {
    const s = familySeries.get(id);
    if (s === undefined || byFamily[id] !== undefined) continue;
    s.segPeak = peakOf(s.segOutstanding);
    byFamily[id] = s;
  }

  const assets = totalAssetNotional(book);
  const result: SegResult = {
    convention: "constant-balance-sheet",
    scenarioId: input.scenarioId,
    shockBp,
    niiShockBp,
    horizonMonths: H,
    niiHorizonMonths: NH,
    // A book with no asset notional has no margin to state; 0 rather than a
    // ratio over zero, which JSON cannot carry.
    nimPct: assets > 0 ? (100 * bookSeries.nii.base12) / assets : 0,
    totalAssetNotional: assets,
    book: bookSeries,
    segBank,
    byFamily,
    ...(tagged ? { byAttributionGroup: Object.fromEntries(groupNii) } : {}),
    uncovered,
  };
  return { result, perPosition };
}
