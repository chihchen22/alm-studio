/**
 * The swap mapping, asserted in the engine at buildCellPlan.
 *
 * Every fold reads the FAMILY side; the gap ladder and the drill read the
 * POSITION's terms.type. The two readings agree only while a swap position,
 * a swap family and a derivative side travel together. Four ways to break
 * that, each producing plausible numbers and no throw without this guard.
 */
import { describe, expect, it } from "vitest";
import type { PortfolioSpec, Position } from "../../contracts/position";
import { ExecutorError, SwapFamilyMappingError } from "../../run/executorErrors";
import { BY_SEGMENT_VIEW, viewSegmentedBook } from "../../run/__tests__/fixtures";
import { assertSwapMapping } from "../../swap/derivatives";
import { hedgedBook, swapPosition, swapTerms, SWAP_FAMILY_ID } from "../../swap/__tests__/fixtures";
import { buildCellPlan } from "../cells";

/** The plan outcome as a string, so a RED run says what buildCellPlan did instead. */
function outcomeOf(book: PortfolioSpec, views = false): string {
  try {
    const plan = buildCellPlan(book, views ? [BY_SEGMENT_VIEW] : undefined);
    return `RETURNED: ${plan.cells.length} cells`;
  } catch (err) {
    return err instanceof SwapFamilyMappingError
      ? `REFUSED: ${err.message}`
      : `WRONG ERROR (${err instanceof Error ? err.name : typeof err}): ${String(err)}`;
  }
}

/** Case 1: swap terms in a loan family. */
function swapTermsInLoanFamily(): PortfolioSpec {
  const book = viewSegmentedBook("PF-SWAP-MISMAP-1");
  const host = book.positions[0]!;
  return { ...book, positions: [{ ...host, terms: swapTerms(host.id) } as Position, ...book.positions.slice(1)] };
}

/** Case 2: loan terms in a swap family. */
function loanTermsInSwapFamily(): PortfolioSpec {
  const book = hedgedBook("PF-SWAP-MISMAP-2", [], [SWAP_FAMILY_ID], viewSegmentedBook("PF-SWAP-MISMAP-2"));
  const host = book.positions[0]!;
  return {
    ...book,
    positions: [{ ...host, familyId: SWAP_FAMILY_ID, coaNodeId: `node-${SWAP_FAMILY_ID}` }, ...book.positions.slice(1)],
  };
}

/** Case 3: a swap family declared asset-side. */
function swapFamilyOnAssetSide(): PortfolioSpec {
  const book = hedgedBook("PF-SWAP-MISMAP-3", [swapPosition("SW1")]);
  return {
    ...book,
    coa: {
      ...book.coa,
      families: book.coa.families.map((f) => (f.id === SWAP_FAMILY_ID ? { ...f, side: "asset" as const } : f)),
    },
  };
}

/** Case 4 (not in the spec): a loan family declared derivative-side. */
function loanFamilyOnDerivativeSide(): PortfolioSpec {
  const book = hedgedBook("PF-SWAP-MISMAP-4", []);
  return {
    ...book,
    coa: {
      ...book.coa,
      families: book.coa.families.map((f) => (f.id === "FIXED" ? { ...f, side: "derivative" as const } : f)),
    },
  };
}

describe("assertSwapMapping", () => {
  it("refuses swap terms in a loan family", () => {
    expect(() =>
      assertSwapMapping({ id: "P1", familyId: "FIXED", terms: swapTerms("P1") }, { instrumentType: "fixed-loan", side: "asset" }),
    ).toThrow(SwapFamilyMappingError);
  });

  it("refuses loan terms in a swap family", () => {
    expect(() =>
      assertSwapMapping(
        { id: "P2", familyId: SWAP_FAMILY_ID, terms: { type: "fixed-loan" } as Position["terms"] },
        { instrumentType: "swap", side: "derivative" },
      ),
    ).toThrow(SwapFamilyMappingError);
  });

  it("refuses a swap family declared asset-side", () => {
    expect(() =>
      assertSwapMapping({ id: "P3", familyId: SWAP_FAMILY_ID, terms: swapTerms("P3") }, { instrumentType: "swap", side: "asset" }),
    ).toThrow(SwapFamilyMappingError);
  });

  it("refuses a loan family declared derivative-side", () => {
    expect(() =>
      assertSwapMapping(
        { id: "P4", familyId: "FIXED", terms: { type: "fixed-loan" } as Position["terms"] },
        { instrumentType: "fixed-loan", side: "derivative" },
      ),
    ).toThrow(SwapFamilyMappingError);
  });

  it("passes when all three agree, either way", () => {
    expect(() =>
      assertSwapMapping({ id: "P5", familyId: SWAP_FAMILY_ID, terms: swapTerms("P5") }, { instrumentType: "swap", side: "derivative" }),
    ).not.toThrow();
    expect(() =>
      assertSwapMapping(
        { id: "P6", familyId: "FIXED", terms: { type: "fixed-loan" } as Position["terms"] },
        { instrumentType: "fixed-loan", side: "asset" },
      ),
    ).not.toThrow();
  });

  it("carries every half of the contradiction and is an ExecutorError (so the platform answers 422)", () => {
    let thrown: unknown;
    try {
      assertSwapMapping({ id: "P7", familyId: SWAP_FAMILY_ID, terms: swapTerms("P7") }, { instrumentType: "swap", side: "asset" });
    } catch (err) {
      thrown = err;
    }
    const err = thrown as SwapFamilyMappingError;
    expect(err).toBeInstanceOf(ExecutorError);
    expect([err.positionId, err.familyId, err.termsType, err.instrumentType, err.side]).toEqual([
      "P7",
      SWAP_FAMILY_ID,
      "swap",
      "swap",
      "asset",
    ]);
  });
});

describe("buildCellPlan enforces the swap mapping on both branches", () => {
  for (const [name, build] of [
    ["swap terms in a loan family", swapTermsInLoanFamily],
    ["loan terms in a swap family", loanTermsInSwapFamily],
    ["a swap family on the asset side", swapFamilyOnAssetSide],
    ["a loan family on the derivative side", loanFamilyOnDerivativeSide],
  ] as const) {
    it(`identity plan refuses ${name}`, () => {
      expect(outcomeOf(build())).toMatch(/^REFUSED: /);
    });
  }

  it("general plan refuses case 1 and case 2", () => {
    expect(outcomeOf(swapTermsInLoanFamily(), true)).toMatch(/^REFUSED: /);
    expect(outcomeOf(loanTermsInSwapFamily(), true)).toMatch(/^REFUSED: /);
  });

  it("admits a correctly mapped hedged book", () => {
    expect(outcomeOf(hedgedBook("PF-SWAP-OK", [swapPosition("SW1")]))).toMatch(/^RETURNED: /);
  });
});
