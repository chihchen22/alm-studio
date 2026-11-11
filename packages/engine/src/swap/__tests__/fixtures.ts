/**
 * Piece 8 test fixtures: swap books built on the run fixtures, and the
 * RESTATED formulas every swap test checks against.
 *
 * NOTHING HERE IS READ BACK FROM THE SWAP MODULE OR A FOLD. The par rate, the
 * payer's risk-free value and the floating leg's forward are written out from
 * `curve.discountFactor` alone, so a test that compares a fold's output to
 * them cannot pass by agreeing with itself.
 */
import type { MarketSnapshot, ZeroCurve } from "@alm/kernel";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { RunRequest, RunResult } from "../../contracts/run";
import { clearPortfolios } from "../../portfolio/registry";
import { createEngine, resolveDefaultContext } from "../../run";
import { makeRunRequest, twoSidedBook } from "../../run/__tests__/fixtures";
import type { SwapTerms } from "../terms";

export const SWAP_FAMILY_ID = "SWAPS";
export const DERIVATIVE_ROOT_ID = "derivatives";
/** The swap notional most tests use, currency units. */
export const N_SWAP = 5_000_000;

export function swapTerms(id: string, over: Partial<SwapTerms> = {}): SwapTerms {
  return {
    id,
    type: "swap",
    notional: N_SWAP,
    maturityMonths: 60,
    originationOffsetMonths: 0,
    amortType: "bullet",
    direction: "pay-fixed",
    fixedRate: 0.04,
    ...over,
  };
}

const leafOf = (familyId: string): string => `node-${familyId}`;

export function swapPosition(
  id: string,
  familyId: string = SWAP_FAMILY_ID,
  over: Partial<SwapTerms> = {},
): Position {
  return { id, familyId, coaNodeId: leafOf(familyId), terms: swapTerms(id, over) };
}

/** The base COA plus one derivative ROOT and one swap leaf per family id. */
export function coaWithSwapFamilies(
  base: ChartOfAccounts,
  familyIds: readonly string[] = [SWAP_FAMILY_ID],
): ChartOfAccounts {
  return {
    ...base,
    nodes: [
      ...base.nodes,
      { id: DERIVATIVE_ROOT_ID, label: "Derivatives", parentId: null, side: "derivative", isLeaf: false, order: 9 },
      ...familyIds.map((fid, i) => ({
        id: leafOf(fid),
        label: `Swaps ${fid}`,
        parentId: DERIVATIVE_ROOT_ID,
        side: "derivative" as const,
        isLeaf: true,
        familyId: fid,
        order: i,
      })),
    ],
    families: [
      ...base.families,
      ...familyIds.map((fid) => ({
        id: fid,
        label: `Swaps ${fid}`,
        side: "derivative" as const,
        instrumentType: "swap" as const,
        coaNodeId: leafOf(fid),
      })),
    ],
  };
}

/** `base` (default: the two-sided run book) plus the given swaps in the given swap families. */
export function hedgedBook(
  id: string,
  swaps: Position[],
  familyIds: readonly string[] = [SWAP_FAMILY_ID],
  base: PortfolioSpec = twoSidedBook(id),
): PortfolioSpec {
  return { ...base, id, coa: coaWithSwapFamilies(base.coa, familyIds), positions: [...base.positions, ...swaps] };
}

/** Engine-convention par: monthly 30/360 fixed against 1M SOFR, both on the risk-free curve. Restated. */
export function engineParRate(curve: ZeroCurve, months: number): number {
  let annuity = 0;
  for (let m = 1; m <= months; m++) annuity += curve.discountFactor(m / 12);
  return (12 * (1 - curve.discountFactor(months / 12))) / annuity;
}

/**
 * The 1M simple forward over [(m-1)/12, m/12]: the rate a monthly floating leg
 * fixes at for month m on a deterministic path. Restated from discount factors.
 */
export function floatForward(curve: ZeroCurve, m: number): number {
  return (curve.discountFactor((m - 1) / 12) / curve.discountFactor(m / 12) - 1) * 12;
}

/**
 * A pay-fixed swap's value on the risk-free curve, zero margin, monthly reset, horizon at or
 * past maturity: the floating leg plus its notional telescopes to N, less the
 * fixed leg and its notional. Restated.
 */
export function payerPvRiskFree(curve: ZeroCurve, notional: number, fixedRate: number, months: number): number {
  let annuity = 0;
  for (let m = 1; m <= months; m++) annuity += curve.discountFactor(m / 12);
  return notional * (1 - curve.discountFactor(months / 12)) - notional * (fixedRate / 12) * annuity;
}

/** One book through the default engine, on the run fixtures' regulatory grid. */
export function runBook(
  market: MarketSnapshot,
  book: PortfolioSpec,
  over: Partial<RunRequest> = {},
): RunResult {
  clearPortfolios();
  const engine = createEngine(resolveDefaultContext());
  engine.loadPortfolio(book);
  return engine.run(makeRunRequest(market, { portfolioId: book.id, ...over }));
}
