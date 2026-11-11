/**
 * The vanilla balance sheet: the smallest book the engine accepts, with no
 * optionality anywhere. Three families (cash, term loans, term funding), nine
 * hand-authored positions, all mapped to the kernel's `fixed-loan` instrument,
 * so cash flows are purely contractual and every number is checkable by hand.
 *
 * Shared by the `npm run vanilla` example and the viewer's fixture generator;
 * the numbers are pinned to this book.
 */
import type { FixedLoanTerms } from "@alm/kernel";
import type { AssumptionSet, Position, PortfolioSpec, Scenario } from "@alm/engine";
import { buildChartOfAccounts } from "./coa";

export const VANILLA_AS_OF = "2026-03-31";

/** A fixed-loan position with the boilerplate filled in. */
function pos(args: {
  id: string;
  familyId: "cash" | "fixed-loans" | "fhlb";
  coaNodeId: string;
  label: string;
  notional: number;
  maturityMonths: number;
  coupon: number;
  amortType: "bullet" | "level-pay";
}): Position {
  const terms: FixedLoanTerms = {
    id: args.id,
    type: "fixed-loan",
    label: args.label,
    notional: args.notional,
    maturityMonths: args.maturityMonths,
    originationOffsetMonths: 0,
    amortType: args.amortType,
    coupon: args.coupon,
  };
  return { id: args.id, familyId: args.familyId, coaNodeId: args.coaNodeId, terms };
}

/** $800M assets ($150M cash + $650M term loans) against $720M term funding. */
export function buildVanillaPortfolio(): PortfolioSpec {
  const coa = buildChartOfAccounts();
  const positions: Position[] = [
    // Cash: one short bullet placement.
    pos({ id: "cash-1", familyId: "cash", coaNodeId: "coa-cash", label: "Overnight/1m cash placement", notional: 150_000_000, maturityMonths: 1, coupon: 0.043, amortType: "bullet" }),
    // Term loans: five level-pay fixed-rate loans, 3y to 10y.
    pos({ id: "loan-1", familyId: "fixed-loans", coaNodeId: "coa-fixed-loans", label: "Term loan 3y", notional: 100_000_000, maturityMonths: 36, coupon: 0.060, amortType: "level-pay" }),
    pos({ id: "loan-2", familyId: "fixed-loans", coaNodeId: "coa-fixed-loans", label: "Term loan 5y", notional: 150_000_000, maturityMonths: 60, coupon: 0.0625, amortType: "level-pay" }),
    pos({ id: "loan-3", familyId: "fixed-loans", coaNodeId: "coa-fixed-loans", label: "Term loan 7y", notional: 150_000_000, maturityMonths: 84, coupon: 0.065, amortType: "level-pay" }),
    pos({ id: "loan-4", familyId: "fixed-loans", coaNodeId: "coa-fixed-loans", label: "Term loan 10y", notional: 150_000_000, maturityMonths: 120, coupon: 0.0675, amortType: "level-pay" }),
    pos({ id: "loan-5", familyId: "fixed-loans", coaNodeId: "coa-fixed-loans", label: "Term loan 10y", notional: 100_000_000, maturityMonths: 120, coupon: 0.070, amortType: "level-pay" }),
    // Term funding: three bullet advances laddered 6m / 2y / 5y.
    pos({ id: "fund-1", familyId: "fhlb", coaNodeId: "coa-fhlb", label: "Term advance 6m", notional: 220_000_000, maturityMonths: 6, coupon: 0.044, amortType: "bullet" }),
    pos({ id: "fund-2", familyId: "fhlb", coaNodeId: "coa-fhlb", label: "Term advance 2y", notional: 250_000_000, maturityMonths: 24, coupon: 0.046, amortType: "bullet" }),
    pos({ id: "fund-3", familyId: "fhlb", coaNodeId: "coa-fhlb", label: "Term advance 5y", notional: 250_000_000, maturityMonths: 60, coupon: 0.048, amortType: "bullet" }),
  ];
  return { id: "vanilla-book-v1", label: "Vanilla Balance Sheet (cash / term loans / term funding)", asOf: VANILLA_AS_OF, coa, positions };
}

/**
 * No optionality: every position is contractual, so the assumption set carries
 * zero behavioral bindings. This is the layer the AI would author for a real
 * book; here there is honestly nothing to assume.
 */
export function vanillaAssumptionSet(): AssumptionSet {
  return {
    schemaVersion: "1.0.0",
    id: "vanilla-empty-v1",
    label: "No behavioral overlays (fully contractual book)",
    bindings: [],
  };
}

/** Base plus the parallel regulatory grid, static balance sheet. */
export function vanillaScenarios(assumptionSetId: string): Scenario[] {
  return [
    { id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId, newBusiness: { mode: "static", rules: [] } },
    { id: "SM200", label: "Parallel -200bp", rateSpec: { kind: "parallel", shockBp: -200 }, assumptionSetId, newBusiness: { mode: "static", rules: [] } },
    { id: "SM100", label: "Parallel -100bp", rateSpec: { kind: "parallel", shockBp: -100 }, assumptionSetId, newBusiness: { mode: "static", rules: [] } },
    { id: "S100", label: "Parallel +100bp", rateSpec: { kind: "parallel", shockBp: 100 }, assumptionSetId, newBusiness: { mode: "static", rules: [] } },
    { id: "S200", label: "Parallel +200bp", rateSpec: { kind: "parallel", shockBp: 200 }, assumptionSetId, newBusiness: { mode: "static", rules: [] } },
  ];
}
