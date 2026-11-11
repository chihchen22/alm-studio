/**
 * Piece 7 final fix, item 2b. The commitment mapping, asserted in the
 * engine because intake cannot assert it.
 *
 * The engine reads one fact two ways. `gap/gapEngine.ts` keys on the POSITION's
 * `terms.type`, because it holds an Instrument and no family definition; every
 * other guarded fold (FTP, EVE, the key-rate pass, `balanceSummary`, `walGap`,
 * `survivalHorizon`, the stochastic per-path fold) keys on the FAMILY's
 * `instrumentType`. Both readings are right only while the mapping holds, and
 * nothing enforced it: the server's intake validator refuses a commitment
 * family and a commitment position outright, before the mapping rule it does
 * carry ever runs, so a commitment book cannot be imported at all and every
 * producer of one composes a `PortfolioSpec` in memory.
 *
 * BOTH DIRECTIONS are pinned here, because they fail differently and the
 * failures are both silent:
 *   - commitment terms in a NON-commitment family: the draw's negative
 *     principal lands in the inflow arm, in pvAssets and in FTP par-matching;
 *   - non-commitment terms in a COMMITMENT family: a funded loan is rated as
 *     undrawn capacity by `lcr-regulatory` and dropped from EVE and FTP.
 *
 * Both branches of `buildCellPlan` assert, so the identity plan (no views) and
 * the general plan (a view declared) refuse the same book.
 */
import { describe, expect, it } from "vitest";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../contracts/position";
import { assertCommitmentMapping } from "../../commitment/offBalanceSheet";
import { CommitmentFamilyMappingError, ExecutorError } from "../../run/executorErrors";
import { BY_SEGMENT_VIEW, viewSegmentedBook } from "../../run/__tests__/fixtures";
import { buildCellPlan } from "../cells";

const COMMIT_FAMILY_ID = "COMMIT";
const COMMIT_NODE_ID = "commitments";

/** A commitment terms object. Shaped like the seed's, minus the seed. */
function commitmentTerms(id: string): Position["terms"] {
  return {
    id,
    type: "commitment",
    notional: 50_000_000,
    maturityMonths: 36,
    originationOffsetMonths: 0,
    amortType: "bullet",
    side: "asset",
    draw: { rampRates: [0.35], steadyRate: 0.02 },
  } as unknown as Position["terms"];
}

function withCommitmentFamily(coa: ChartOfAccounts): ChartOfAccounts {
  return {
    ...coa,
    nodes: [
      ...coa.nodes,
      {
        id: COMMIT_NODE_ID,
        label: "Undrawn committed lines",
        parentId: null,
        side: "asset",
        isLeaf: true,
        familyId: COMMIT_FAMILY_ID,
        order: 99,
      },
    ],
    families: [
      ...coa.families,
      {
        id: COMMIT_FAMILY_ID,
        label: "Undrawn committed lines",
        side: "asset",
        instrumentType: "commitment",
        coaNodeId: COMMIT_NODE_ID,
      },
    ],
  };
}

/** Direction 1: commitment TERMS attached to a family that is not a commitment family. */
function commitmentTermsInLoanFamily(): PortfolioSpec {
  const book = viewSegmentedBook("PF-MISMAP-1");
  const host = book.positions[0]!;
  return {
    ...book,
    positions: [
      { ...host, terms: commitmentTerms(host.id) },
      ...book.positions.slice(1),
    ],
  };
}

/** Direction 2: a funded position sitting in a commitment family. */
function loanTermsInCommitmentFamily(): PortfolioSpec {
  const book = viewSegmentedBook("PF-MISMAP-2");
  const host = book.positions[0]!;
  return {
    ...book,
    coa: withCommitmentFamily(book.coa),
    positions: [
      { ...host, familyId: COMMIT_FAMILY_ID, coaNodeId: COMMIT_NODE_ID },
      ...book.positions.slice(1),
    ],
  };
}

/** The matching book: commitment terms in the commitment family. Must NOT throw. */
function mappedCorrectly(): PortfolioSpec {
  const book = viewSegmentedBook("PF-MAPPED");
  const host = book.positions[0]!;
  return {
    ...book,
    coa: withCommitmentFamily(book.coa),
    positions: [
      {
        ...host,
        familyId: COMMIT_FAMILY_ID,
        coaNodeId: COMMIT_NODE_ID,
        terms: commitmentTerms(host.id),
      },
      ...book.positions.slice(1),
    ],
  };
}

describe("assertCommitmentMapping", () => {
  it("refuses commitment terms in a non-commitment family", () => {
    expect(() =>
      assertCommitmentMapping(
        { id: "P1", familyId: "FIXED", terms: commitmentTerms("P1") },
        { instrumentType: "fixed-loan" },
      ),
    ).toThrow(CommitmentFamilyMappingError);
  });

  it("refuses non-commitment terms in a commitment family", () => {
    expect(() =>
      assertCommitmentMapping(
        { id: "P2", familyId: COMMIT_FAMILY_ID, terms: { type: "fixed-loan" } as Position["terms"] },
        { instrumentType: "commitment" },
      ),
    ).toThrow(CommitmentFamilyMappingError);
  });

  it("passes when both say commitment, and when neither does", () => {
    expect(() =>
      assertCommitmentMapping(
        { id: "P3", familyId: COMMIT_FAMILY_ID, terms: commitmentTerms("P3") },
        { instrumentType: "commitment" },
      ),
    ).not.toThrow();
    expect(() =>
      assertCommitmentMapping(
        { id: "P4", familyId: "FIXED", terms: { type: "fixed-loan" } as Position["terms"] },
        { instrumentType: "fixed-loan" },
      ),
    ).not.toThrow();
  });

  it("carries both sides of the contradiction on the error", () => {
    let thrown: unknown;
    try {
      assertCommitmentMapping(
        { id: "P5", familyId: "FIXED", terms: commitmentTerms("P5") },
        { instrumentType: "fixed-loan" },
      );
    } catch (err) {
      thrown = err;
    }
    const err = thrown as CommitmentFamilyMappingError;
    expect(err).toBeInstanceOf(ExecutorError);
    expect(err.positionId).toBe("P5");
    expect(err.familyId).toBe("FIXED");
    expect(err.termsType).toBe("commitment");
    expect(err.instrumentType).toBe("fixed-loan");
  });
});

describe("buildCellPlan enforces the mapping on both branches", () => {
  it("identity plan refuses direction 1, commitment terms in a loan family", () => {
    expect(() => buildCellPlan(commitmentTermsInLoanFamily(), undefined)).toThrow(
      CommitmentFamilyMappingError,
    );
  });

  it("identity plan refuses direction 2, funded terms in a commitment family", () => {
    expect(() => buildCellPlan(loanTermsInCommitmentFamily(), undefined)).toThrow(
      CommitmentFamilyMappingError,
    );
  });

  it("general plan refuses direction 1", () => {
    expect(() => buildCellPlan(commitmentTermsInLoanFamily(), [BY_SEGMENT_VIEW])).toThrow(
      CommitmentFamilyMappingError,
    );
  });

  it("general plan refuses direction 2", () => {
    expect(() => buildCellPlan(loanTermsInCommitmentFamily(), [BY_SEGMENT_VIEW])).toThrow(
      CommitmentFamilyMappingError,
    );
  });

  it("admits a correctly mapped commitment book on both branches", () => {
    const book = mappedCorrectly();
    expect(() => buildCellPlan(book, undefined)).not.toThrow();
    expect(() => buildCellPlan(book, [BY_SEGMENT_VIEW])).not.toThrow();
  });

  it("leaves a commitment-free book untouched", () => {
    const book = viewSegmentedBook("PF-CLEAN");
    expect(() => buildCellPlan(book, undefined)).not.toThrow();
    expect(() => buildCellPlan(book, [BY_SEGMENT_VIEW])).not.toThrow();
  });
});
