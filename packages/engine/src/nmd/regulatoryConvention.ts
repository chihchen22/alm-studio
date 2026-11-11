/**
 * The regulatory deposit convention as a pure book transform.
 *
 * Each non-maturity book is replaced by a prescribed core ladder plus a
 * non-core slice:
 *
 *   1. Marginal pass-through is capped: b = min(beta at r0, passThroughCap).
 *   2. Core share = min(1 - b, coreShareCap); the rest is non-core.
 *   3. The core is a uniform ladder of `rungs` frozen `nmd` positions whose
 *      average life is the prescribed one, each fixed at the CURRENT paid rate
 *      d0 = beta(r0) r0 (the modelled beta, not the capped one: it is the rate
 *      the bank pays today, an observed fact of the book).
 *   4. The interest-bearing non-core slice is a one-month floating liability at
 *      margin d0 - r0, so its month-1 coupon is exactly d0 and it reprices one
 *      for one after that. The non-interest-bearing non-core slice is a frozen
 *      one-month `nmd` at the parent's paid rate (0 for a non-interest-bearing
 *      book).
 *
 * A rung is an `nmd` with its decay switched off rather than a fixed loan,
 * because the constant-balance convention re-originates maturing slices and an
 * `nmd` vintage carries its deposit rate forward unchanged, so the core does
 * not reprice (the capstone's frozen_balance_params rationale).
 *
 * Every child keeps the parent's family, COA node and dimension bag, carries
 * `parentPositionId`, and `discountSpreadBp` 0. Core rungs and the
 * non-interest-bearing non-core slice carry `repricingTreatment: "excluded"`
 * (the ALCO rule: core deposits are not rate-sensitive); the
 * interest-bearing non-core floaters do not. The transform never mutates its
 * input and leaves every other position object-identical. A position that
 * already carries `parentPositionId` is a child of an earlier split and is left
 * as it is, so the transform is idempotent.
 *
 * Pure: the caller supplies r0 and the beta at r0, so this module reads no
 * curve and imports nothing from the kernel but types and defaults.
 */
import {
  NMD_DEFAULTS,
  NONIB_BUCKETS,
  type FloatingLoanTerms,
  type NMDParams,
  type NMDTerms,
} from "@alm/kernel";
import type { PortfolioSpec, Position } from "../contracts/position";

/** The four parameters of the convention. */
export interface RegulatoryConventionParams {
  /** Cap on the marginal pass-through, decimal. */
  passThroughCap: number;
  /** Cap on the core share, decimal. */
  coreShareCap: number;
  /** Prescribed average life of the core ladder, years. */
  prescribedAverageLifeYears: number;
  /** Number of equal rungs in the core ladder. */
  rungs: number;
}

/** A regulatory convention parameters document, as a seed stores it. */
export const REGULATORY_CONVENTION_DEFAULTS: RegulatoryConventionParams = {
  passThroughCap: 0.5,
  coreShareCap: 0.9,
  prescribedAverageLifeYears: 5.0,
  rungs: 10,
};

/**
 * Python's round(): nearest integer, ties to even. The capstone slots rungs
 * with int(round(x)), so a tie must round the way Python does, not the way
 * Math.round does (which sends every tie up).
 */
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Rung months: rung k matures at the midpoint of its slice of [0, 2L], that is
 * int(round(24 L (k + 0.5) / rungs)) for k = 0..rungs-1. For L = 5 and 10 rungs
 * that is [6, 18, ..., 114], mean 60 months.
 */
export function ladderRungMonths(avgLifeYears: number, rungs: number): number[] {
  const horizonMonths = 24 * avgLifeYears;
  const out: number[] = [];
  for (let k = 0; k < rungs; k++) out.push(roundHalfEven((horizonMonths * (k + 0.5)) / rungs));
  return out;
}

/**
 * The decay kernel switched off: no closure, no rate incentive, no regime
 * amplifier, no burnout. An `nmd` carrying these is a bullet liability at a
 * fixed deposit rate, which is exactly what a prescribed-maturity slot is.
 */
function frozenParams(): NMDParams {
  return {
    ...NMD_DEFAULTS,
    closureSteady: 0,
    closureInitial: 0,
    closureTauMonths: 24,
    maxRateDecay: 0,
    maxRateGrowth: 0,
    regimeAlpha: 0,
    burnoutLambda: 0,
    buckets: NONIB_BUCKETS.map((b) => ({ ...b })),
  };
}

function refuse(field: string, detail: string): never {
  throw new Error(`applyRegulatoryConvention: ${field} ${detail}`);
}

function checkParams(params: RegulatoryConventionParams, r0: number): void {
  if (!Number.isInteger(params.rungs) || params.rungs < 1) {
    refuse("params.rungs", `must be a positive integer, got ${String(params.rungs)}`);
  }
  if (!Number.isFinite(params.passThroughCap) || params.passThroughCap < 0 || params.passThroughCap > 1) {
    refuse("params.passThroughCap", `must lie in [0, 1], got ${String(params.passThroughCap)}`);
  }
  if (!Number.isFinite(params.coreShareCap) || params.coreShareCap < 0 || params.coreShareCap > 1) {
    refuse("params.coreShareCap", `must lie in [0, 1], got ${String(params.coreShareCap)}`);
  }
  if (!Number.isFinite(params.prescribedAverageLifeYears) || params.prescribedAverageLifeYears <= 0) {
    refuse(
      "params.prescribedAverageLifeYears",
      `must be a positive number of years, got ${String(params.prescribedAverageLifeYears)}`,
    );
  }
  if (!Number.isFinite(r0)) refuse("r0", `must be a finite decimal rate, got ${String(r0)}`);
}

/** The child record: the parent's placement and bag, the child's own terms and flags. */
function childOf(
  parent: Position,
  terms: NMDTerms | FloatingLoanTerms,
  excluded: boolean,
): Position {
  return {
    id: terms.id,
    familyId: parent.familyId,
    coaNodeId: parent.coaNodeId,
    terms,
    ...(parent.dimensions !== undefined ? { dimensions: structuredClone(parent.dimensions) } : {}),
    discountSpreadBp: 0,
    parentPositionId: parent.id,
    ...(excluded ? { repricingTreatment: "excluded" as const } : {}),
  };
}

/**
 * Apply the convention to every `nmd-b` and `nmd` position of `book`.
 *
 * `r0` is the decimal simple one-month forward at step 0 of the base path (the
 * rate a one-month floater accrues in month 1). `betaAtR0` is called for
 * `nmd-b` positions only and returns the modelled beta at r0 (the caller reads
 * the effective beta curve at r0 in percent); an `nmd` position's modelled beta
 * is 0 by definition.
 *
 * Returns the transformed book (same id, label, as-of, COA and taxonomy; each
 * parent replaced in place by its children, in rung order then the non-core
 * slice) and the child-to-parent map in the same order.
 */
export function applyRegulatoryConvention(
  book: PortfolioSpec,
  params: RegulatoryConventionParams,
  r0: number,
  betaAtR0: (p: Position) => number,
): { book: PortfolioSpec; parentOf: Record<string, string> } {
  checkParams(params, r0);
  const rungMonths = ladderRungMonths(params.prescribedAverageLifeYears, params.rungs);
  const parentOf: Record<string, string> = {};
  const positions: Position[] = [];

  for (const p of book.positions) {
    const t = p.terms;
    // A full-form deposit marked for slotting is slotted by its own instrument, so it stays whole.
    if ((t.type !== "nmd-b" && t.type !== "nmd") || p.parentPositionId !== undefined || (t.type === "nmd-b" && t.depositSlotting !== undefined)) {
      positions.push(p);
      continue;
    }
    const interestBearing = t.type === "nmd-b";
    const modelledBeta = interestBearing ? betaAtR0(p) : 0;
    if (!Number.isFinite(modelledBeta) || modelledBeta < 0 || modelledBeta > 1) {
      refuse(`beta at r0 of position "${p.id}"`, `must lie in [0, 1], got ${String(modelledBeta)}`);
    }
    const applied = Math.min(modelledBeta, params.passThroughCap);
    const coreShare = Math.min(1 - applied, params.coreShareCap);
    const noncoreShare = 1 - coreShare;
    // The paid rate today: beta(r0) r0 for an interest-bearing book; the
    // parent's own static rate for an nmd (0 on a non-interest-bearing book).
    const d0 = interestBearing ? modelledBeta * r0 : (t as NMDTerms).depositRate;
    const side = t.side ?? "liability";
    const label = t.label ?? p.id;
    const perRung = (t.notional * coreShare) / rungMonths.length;
    const noncore = t.notional * noncoreShare;

    for (let k = 0; k < rungMonths.length; k++) {
      const id = `${p.id}-core-${k + 1}`;
      const m = rungMonths[k]!;
      const rung: NMDTerms = {
        id,
        type: "nmd",
        label: `${label}: core rung ${k + 1} (${m}M)`,
        notional: perRung,
        maturityMonths: m,
        originationOffsetMonths: 0,
        amortType: "bullet",
        side,
        depositRate: d0,
        beta: 0,
        nmdParams: frozenParams(),
      };
      positions.push(childOf(p, rung, true));
      parentOf[id] = p.id;
    }

    if (noncore > 1e-9) {
      const id = `${p.id}-noncore`;
      if (interestBearing) {
        const slice: FloatingLoanTerms = {
          id,
          type: "floating-loan",
          label: `${label}: non-core, slotted overnight`,
          notional: noncore,
          maturityMonths: 1,
          originationOffsetMonths: 0,
          amortType: "bullet",
          side,
          indexTenorMonths: 1,
          margin: d0 - r0,
          resetFrequencyMonths: 1,
        };
        positions.push(childOf(p, slice, false));
      } else {
        const slice: NMDTerms = {
          id,
          type: "nmd",
          label: `${label}: non-core, slotted overnight`,
          notional: noncore,
          maturityMonths: 1,
          originationOffsetMonths: 0,
          amortType: "bullet",
          side,
          depositRate: d0,
          beta: 0,
          nmdParams: frozenParams(),
        };
        positions.push(childOf(p, slice, true));
      }
      parentOf[id] = p.id;
    }
  }

  return { book: { ...book, positions }, parentOf };
}
