/**
 * Fixtures for the regulatory deposit-convention tests: the
 * four-position NMD book (two high-yield savings segments, interest-bearing and non-interest-bearing checking)
 * and the three beta curves of spec Section 5.1.
 */
import {
  NMD_B_TERMS_DEFAULTS,
  NMD_TERMS_DEFAULTS,
  type BetaSCurveParams,
  type NMDBetaTerms,
  type NMDTerms,
} from "@alm/kernel";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../contracts/position";

/** r0 on the seeded pack: the simple one-month forward at step 0. */
export const R0 = 0.037111877541;

function curve(betaMin: number, betaMax: number): BetaSCurveParams {
  return { betaMin, betaMax, k: 1.2, m: 2.0, lambda: 1 };
}
/** Spec Section 5.1 beta curves: beta at r0 equals 0.95, 0.70, 0.25. */
export const HYS_A_CURVE = curve(0.6, 0.994903145571733);
export const HYS_B_CURVE = curve(0.3, 0.7513178806534091);
export const CHECKING_IB_CURVE = curve(0.1, 0.2692442052450284);

export function nmdCoa(): ChartOfAccounts {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "liabilities", label: "Liabilities", parentId: null, side: "liability", isLeaf: false, order: 0 },
      { id: "hys-a", label: "HYS A", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "HYS-A", order: 0 },
      { id: "hys-b", label: "HYS B", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "HYS-B", order: 1 },
      { id: "checking-ib", label: "Checking IB", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "CHECKING-IB", order: 2 },
      { id: "checking-nib", label: "Checking NIB", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "CHECKING-NIB", order: 3 },
    ],
    families: [
      { id: "HYS-A", label: "HYS A", side: "liability", instrumentType: "nmd-b", coaNodeId: "hys-a" },
      { id: "HYS-B", label: "HYS B", side: "liability", instrumentType: "nmd-b", coaNodeId: "hys-b" },
      { id: "CHECKING-IB", label: "Checking IB", side: "liability", instrumentType: "nmd-b", coaNodeId: "checking-ib" },
      { id: "CHECKING-NIB", label: "Checking NIB", side: "liability", instrumentType: "nmd", coaNodeId: "checking-nib" },
    ],
  };
}

/**
 * Decay switched off on the parents, so a behavioral run's one-year repricing
 * gap reads only the beta slices booked at month 1 (the locked slices run off
 * at month 360). The regulatory children do not depend on this choice.
 */
export const FROZEN_PARENT = {
  ...NMD_TERMS_DEFAULTS.nmdParams,
  closureSteady: 0,
  closureInitial: 0,
  maxRateDecay: 0,
  maxRateGrowth: 0,
  regimeAlpha: 0,
  burnoutLambda: 0,
};

function nmdB(id: string, familyId: string, coaNodeId: string, notional: number, sCurve: BetaSCurveParams): Position {
  const terms: NMDBetaTerms = { ...NMD_B_TERMS_DEFAULTS, id, notional, maturityMonths: 360, sCurve, nmdParams: FROZEN_PARENT };
  return {
    id,
    familyId,
    coaNodeId,
    terms,
    dimensions: { managementView: "deposits", segment: id },
    discountSpreadBp: 0,
  };
}

/** The four-position NMD book, round illustrative balances. */
export function fourNmdBook(sCurves?: { a: BetaSCurveParams; b: BetaSCurveParams; ib: BetaSCurveParams }): PortfolioSpec {
  const c = sCurves ?? { a: HYS_A_CURVE, b: HYS_B_CURVE, ib: CHECKING_IB_CURVE };
  const nib: NMDTerms = { ...NMD_TERMS_DEFAULTS, id: "checking-nib", notional: 50_000_000, maturityMonths: 360, nmdParams: FROZEN_PARENT };
  return {
    id: "PF-NMD4",
    label: "Four NMD books",
    asOf: "2026-03-31",
    coa: nmdCoa(),
    positions: [
      nmdB("hys-a", "HYS-A", "hys-a", 100_000_000, c.a),
      nmdB("hys-b", "HYS-B", "hys-b", 25_000_000, c.b),
      nmdB("checking-ib", "CHECKING-IB", "checking-ib", 10_000_000, c.ib),
      { id: "checking-nib", familyId: "CHECKING-NIB", coaNodeId: "checking-nib", terms: nib, dimensions: { managementView: "deposits", segment: "checking-nib" } },
    ],
  };
}
