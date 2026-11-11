/**
 * Seasoning re-anchor (D3a): validator matrix and the m03 aggregator
 * shift, cross-checked against the kernel instruments directly (the kernel IS
 * the Lab math), so every reference number comes from the same generator the
 * engine runs, not a retyped constant.
 *
 * Anchors:
 *  - offset 0 is byte-identical arithmetic (the full pre-existing suite is the
 *    broad proof; the shift-identity test here is the targeted one);
 *  - offset -k shifts every bucket by exactly k months: seasoned bucket j
 *    carries the same doubles as unseasoned bucket j + k, elapsed months are
 *    dropped, and the horizon-truncation window moves by k;
 *  - nonzero offsets on floating / mortgage / nmd / nmd-b terms, positive
 *    offsets, and non-integer offsets refuse typed (SeasoningError), never
 *    silently run.
 */
import { describe, expect, it } from "vitest";
import {
  FIXED_LOAN_DEFAULTS,
  FLOATING_LOAN_DEFAULTS,
  FixedLoan,
  MORTGAGE_DEFAULTS,
  NMD_B_TERMS_DEFAULTS,
  NMD_TERMS_DEFAULTS,
  type FixedLoanTerms,
} from "@alm/kernel";
import { ConstantRatePath } from "../../runtime/__tests__/stubRatePath";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position, PositionTerms } from "../../contracts/position";
import type { BucketGrid } from "../../contracts/results";
import { aggregateScenario } from "../aggregate";
import { SeasoningError, seasoningOffsetOf, seasoningRefusals } from "../seasoning";

const HORIZON = 360;
const path = new ConstantRatePath(0.04, HORIZON);
const AS_OF = "2026-01-01";
const grid = (horizonMonths: number = HORIZON): BucketGrid => ({ horizonMonths, asOf: AS_OF });

/** Single fixed-loan family COA, the smallest book that can aggregate. */
function coa(): ChartOfAccounts {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "a-fixed", label: "Fixed", parentId: "assets", side: "asset", isLeaf: true, familyId: "A_FIXED", order: 0 },
    ],
    families: [
      { id: "A_FIXED", label: "Fixed", side: "asset", instrumentType: "fixed-loan", coaNodeId: "a-fixed" },
    ],
  };
}

function fixedTerms(id: string, o: Partial<FixedLoanTerms> = {}): FixedLoanTerms {
  return { ...FIXED_LOAN_DEFAULTS, id, ...o };
}

function bookOf(terms: FixedLoanTerms): PortfolioSpec {
  const pos: Position = { id: terms.id, familyId: "A_FIXED", coaNodeId: "a-fixed", terms };
  return { id: "PF-S", label: "seasoning book", asOf: AS_OF, coa: coa(), positions: [pos] };
}

function fixedSeries(spec: PortfolioSpec, horizonMonths = HORIZON) {
  const out = aggregateScenario(spec, { scenarioId: "BASE", path }, grid(horizonMonths));
  return out.byFamily.find((f) => f.familyId === "A_FIXED")!.series;
}

// --- Validator matrix --------------------------------------------------------

describe("seasoningOffsetOf — validation and the per-type support matrix", () => {
  it("returns 0 for the default terms of every type", () => {
    expect(seasoningOffsetOf(FIXED_LOAN_DEFAULTS)).toBe(0);
    expect(seasoningOffsetOf(FLOATING_LOAN_DEFAULTS)).toBe(0);
    expect(seasoningOffsetOf(MORTGAGE_DEFAULTS)).toBe(0);
    expect(seasoningOffsetOf(NMD_TERMS_DEFAULTS)).toBe(0);
    expect(seasoningOffsetOf(NMD_B_TERMS_DEFAULTS)).toBe(0);
  });

  it("returns the negative offset for seasoned fixed-loan terms", () => {
    expect(seasoningOffsetOf(fixedTerms("F", { originationOffsetMonths: -6 }))).toBe(-6);
  });

  it("refuses a non-integer offset with a typed SeasoningError carrying the terms identity", () => {
    const terms = fixedTerms("F", { originationOffsetMonths: -6.5 });
    let caught: unknown;
    try {
      seasoningOffsetOf(terms);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SeasoningError);
    const err = caught as SeasoningError;
    expect(err.instrumentId).toBe("F");
    expect(err.instrumentType).toBe("fixed-loan");
    expect(err.originationOffsetMonths).toBe(-6.5);
  });

  it("refuses NaN and Infinity offsets", () => {
    expect(() => seasoningOffsetOf(fixedTerms("F", { originationOffsetMonths: NaN }))).toThrow(SeasoningError);
    expect(() =>
      seasoningOffsetOf(fixedTerms("F", { originationOffsetMonths: -Infinity })),
    ).toThrow(SeasoningError);
  });

  it("refuses a positive (forward-start) offset", () => {
    expect(() => seasoningOffsetOf(fixedTerms("F", { originationOffsetMonths: 3 }))).toThrow(
      SeasoningError,
    );
  });

  it("refuses nonzero offsets on floating / mortgage / nmd / nmd-b terms with per-type guidance", () => {
    const cases: Array<[PositionTerms, RegExp]> = [
      [{ ...FLOATING_LOAN_DEFAULTS, id: "FL", originationOffsetMonths: -3 }, /terms remaining at the as-of date/],
      [{ ...MORTGAGE_DEFAULTS, id: "M", originationOffsetMonths: -60 }, /ageMonths/],
      [{ ...NMD_TERMS_DEFAULTS, id: "D", originationOffsetMonths: -12 }, /as-of date/],
      [{ ...NMD_B_TERMS_DEFAULTS, id: "B", originationOffsetMonths: -12 }, /as-of date/],
    ];
    for (const [terms, guidance] of cases) {
      expect(() => seasoningOffsetOf(terms)).toThrow(SeasoningError);
      expect(() => seasoningOffsetOf(terms)).toThrow(guidance);
      // An analyst can act on the text: it says what to do and names no build reference (Studio Part 2 m4).
      expect(() => seasoningOffsetOf(terms)).toThrow(/only a fixed-loan can be seasoned\. Set the offset to 0/);
      expect(() => seasoningOffsetOf(terms)).not.toThrow(/ADR-|kernel seam|LIMITATIONS|D3b/);
      expect(() => seasoningOffsetOf(terms)).toThrow(new RegExp(`instrument "${terms.id}" \\(${terms.type}\\): originationOffsetMonths ${terms.originationOffsetMonths}`));
      // The parts are joined with a semicolon, not a dash, so the line reads as one sentence run.
      let message = "";
      try {
        seasoningOffsetOf(terms);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toContain(String.fromCharCode(0x2014));
      expect(message).toContain(`originationOffsetMonths ${terms.originationOffsetMonths}; cannot be applied to`);
    }
  });
});

// --- Aggregator shift: hand-checked against the kernel -----------------------

describe("aggregateScenario — seasoned fixed-loan re-anchor (D3a)", () => {
  it("bullet hand case: a 24M bullet originated 6 months ago matures at bucket 17", () => {
    const notional = 800_000;
    const series = fixedSeries(
      bookOf(fixedTerms("C1", { notional, maturityMonths: 24, amortType: "bullet", originationOffsetMonths: -6 })),
    );
    // Principal: the single balloon at instrument month 24 -> bucket 24 - 1 - 6 = 17.
    for (let k = 0; k < HORIZON; k++) {
      expect(series.principal[k]).toBe(k === 17 ? notional : 0);
    }
    // Interest and balance: elapsed months 1..6 dropped, months 7..24 live in
    // buckets 0..17, nothing after.
    for (let k = 0; k < HORIZON; k++) {
      expect(series.balance[k]).toBe(k <= 17 ? notional : 0);
      if (k > 17) expect(series.interest[k]).toBe(0);
      else expect(series.interest[k]).toBeGreaterThan(0);
    }
  });

  it("level-pay hand case: every bucket equals the kernel cashflow at month j + 1 + k, exactly", () => {
    const terms = fixedTerms("L1", {
      notional: 500_000,
      coupon: 0.06,
      maturityMonths: 60,
      amortType: "level-pay",
      originationOffsetMonths: -12,
    });
    const series = fixedSeries(bookOf(terms));
    // Reference: the same kernel instrument's raw stream, re-indexed by hand.
    const cfs = new FixedLoan(terms).generateCashflows(path);
    expect(cfs).toHaveLength(60);
    for (let j = 0; j < HORIZON; j++) {
      const m = j + 1 + 12; // instrument month landing in bucket j
      const ref = cfs.find((c) => c.monthOffset === m);
      expect(series.principal[j]).toBe(ref ? ref.principalPaid : 0);
      expect(series.interest[j]).toBe(ref ? ref.interestPaid : 0);
      expect(series.balance[j]).toBe(ref ? ref.balance : 0);
    }
  });

  it("shift identity: seasoned bucket j carries the same doubles as unseasoned bucket j + k", () => {
    const base = { notional: 500_000, coupon: 0.06, maturityMonths: 60, amortType: "level-pay" as const };
    const seasoned = fixedSeries(bookOf(fixedTerms("L1", { ...base, originationOffsetMonths: -12 })));
    const fresh = fixedSeries(bookOf(fixedTerms("L1", { ...base, originationOffsetMonths: 0 })));
    for (let j = 0; j + 12 < HORIZON; j++) {
      expect(seasoned.principal[j]).toBe(fresh.principal[j + 12]);
      expect(seasoned.interest[j]).toBe(fresh.interest[j + 12]);
      expect(seasoned.balance[j]).toBe(fresh.balance[j + 12]);
    }
    // The dropped months are exactly the first 12 of the fresh stream.
    const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
    expect(sum(fresh.principal) - sum(seasoned.principal)).toBeCloseTo(
      sum(fresh.principal.slice(0, 12)),
      6,
    );
  });

  it("the horizon-truncation window shifts by k: months beyond the fresh window enter", () => {
    // Horizon 12; a 24-month level-pay originated 18 months ago. The fresh
    // book would truncate months 13..24; the seasoned book consists exactly of
    // months 19..24, landing in buckets 0..5.
    const terms = fixedTerms("T1", {
      notional: 240_000,
      coupon: 0.05,
      maturityMonths: 24,
      amortType: "level-pay",
      originationOffsetMonths: -18,
    });
    const series = fixedSeries(bookOf(terms), 12);
    const cfs = new FixedLoan(terms).generateCashflows(path);
    let expected = 0;
    for (const cf of cfs) if (cf.monthOffset >= 19 && cf.monthOffset <= 24) expected += cf.principalPaid;
    const got = series.principal.reduce((s, x) => s + x, 0);
    expect(got).toBe(expected);
    for (let j = 6; j < 12; j++) expect(series.principal[j]).toBe(0);
    // Bucket 5 carries instrument month 24: the final payment clears the loan.
    expect(series.principal[5]).toBe(cfs[23].principalPaid);
  });

  it("a fully elapsed position (offset beyond maturity) contributes nothing — every flow is in the past", () => {
    const series = fixedSeries(
      bookOf(fixedTerms("E1", { notional: 100_000, maturityMonths: 12, amortType: "bullet", originationOffsetMonths: -24 })),
    );
    expect(series.principal.every((x) => x === 0)).toBe(true);
    expect(series.interest.every((x) => x === 0)).toBe(true);
    expect(series.balance.every((x) => x === 0)).toBe(true);
  });

  it("refuses a seasoned deposit through the aggregator with the typed error", () => {
    const spec: PortfolioSpec = {
      id: "PF-N",
      label: "nmd book",
      asOf: AS_OF,
      coa: {
        schemaVersion: "1.0.0",
        nodes: [
          { id: "liabs", label: "Liabs", parentId: null, side: "liability", isLeaf: false, order: 0 },
          { id: "l-dda", label: "DDA", parentId: "liabs", side: "liability", isLeaf: true, familyId: "L_DDA", order: 0 },
        ],
        families: [
          { id: "L_DDA", label: "DDA", side: "liability", instrumentType: "nmd", coaNodeId: "l-dda" },
        ],
      },
      positions: [
        {
          id: "D1",
          familyId: "L_DDA",
          coaNodeId: "l-dda",
          terms: { ...NMD_TERMS_DEFAULTS, id: "D1", originationOffsetMonths: -12 },
        },
      ],
    };
    expect(() => aggregateScenario(spec, { scenarioId: "BASE", path }, grid())).toThrow(
      SeasoningError,
    );
  });
});

// --- seasoningRefusals: the book-level read of the same rule (Studio blank path D4) ---

/** What seasoningOffsetOf itself throws for these terms, so every expected message is the engine's own. */
function thrownBy(terms: PositionTerms): string {
  try {
    seasoningOffsetOf(terms);
  } catch (e) {
    expect(e).toBeInstanceOf(SeasoningError);
    return (e as Error).message;
  }
  throw new Error(`seasoningOffsetOf accepted ${terms.id}`);
}

/** A one-position book; only id, type and originationOffsetMonths are read by the rule. */
function bookWith(terms: PositionTerms): PortfolioSpec {
  return { ...bookOf(fixedTerms("unused")), positions: [{ id: terms.id, familyId: "A_FIXED", coaNodeId: "a-fixed", terms }] };
}

/** Minimal terms for the engine-only arms (cd, commitment, swap): the rule reads three fields. */
function bareTerms(type: string, id: string, originationOffsetMonths: number): PositionTerms {
  return { id, type, originationOffsetMonths } as unknown as PositionTerms;
}

describe("seasoningRefusals: one refusal per position seasoningOffsetOf refuses", () => {
  const SEASONED = -6;
  const refusedCases: Array<[string, PositionTerms]> = [
    ["floating-loan", { ...FLOATING_LOAN_DEFAULTS, id: "P-FL", originationOffsetMonths: SEASONED }],
    ["mortgage", { ...MORTGAGE_DEFAULTS, id: "P-M", originationOffsetMonths: SEASONED }],
    ["nmd", { ...NMD_TERMS_DEFAULTS, id: "P-D", originationOffsetMonths: SEASONED }],
    ["nmd-b", { ...NMD_B_TERMS_DEFAULTS, id: "P-B", originationOffsetMonths: SEASONED }],
    ["cd", bareTerms("cd", "P-CD", SEASONED)],
    ["commitment", bareTerms("commitment", "P-C", SEASONED)],
    ["swap", bareTerms("swap", "P-S", SEASONED)],
    ["a positive (forward-start) fixed-loan offset", fixedTerms("P-FWD", { originationOffsetMonths: 3 })],
  ];

  for (const [name, terms] of refusedCases) {
    it(`refuses ${name} with the message seasoningOffsetOf throws`, () => {
      expect(seasoningRefusals(bookWith(terms))).toEqual([
        { positionId: terms.id, row: 1, message: thrownBy(terms) },
      ]);
    });
  }

  it("a seasoned fixed-loan is clean", () => {
    expect(seasoningRefusals(bookWith(fixedTerms("P-F", { originationOffsetMonths: SEASONED })))).toEqual([]);
  });

  it("a position with no offset is refused with the message seasoningOffsetOf throws", () => {
    const terms = { ...FLOATING_LOAN_DEFAULTS, id: "P-NONE" } as Record<string, unknown>;
    delete terms.originationOffsetMonths;
    const bare = terms as unknown as PositionTerms;
    expect(thrownBy(bare)).toContain("must be a finite integer");
    expect(seasoningRefusals(bookWith(bare))).toEqual([
      { positionId: "P-NONE", row: 1, message: thrownBy(bare) },
    ]);
  });

  it("the refused set at offset -6 is exactly the seven non-fixed-loan types, in book order with 1-based rows", () => {
    const book: PortfolioSpec = {
      ...bookOf(fixedTerms("unused")),
      positions: refusedCases.slice(0, 7).flatMap(([, terms], i) => [
        { id: `ok-${i}`, familyId: "A_FIXED", coaNodeId: "a-fixed", terms: fixedTerms(`ok-${i}`, { originationOffsetMonths: SEASONED }) },
        { id: terms.id, familyId: "A_FIXED", coaNodeId: "a-fixed", terms },
      ]),
    };
    const refused = seasoningRefusals(book);
    expect(refused.map((r) => r.positionId)).toEqual(["P-FL", "P-M", "P-D", "P-B", "P-CD", "P-C", "P-S"]);
    expect(refused.map((r) => r.row)).toEqual([2, 4, 6, 8, 10, 12, 14]);
    const types = refused.map((r) => book.positions[r.row! - 1]!.terms.type);
    expect(types).toEqual(["floating-loan", "mortgage", "nmd", "nmd-b", "cd", "commitment", "swap"]);
  });

  it("re-throws anything that is not a SeasoningError", () => {
    // A nonzero integer offset reaches the type switch; the type getter then throws a RangeError
    // from inside seasoningOffsetOf, so only the catch's re-throw lets it out.
    const terms = {
      ...fixedTerms("P-X"),
      originationOffsetMonths: SEASONED,
      get type(): never {
        throw new RangeError("type getter failed");
      },
    } as unknown as PositionTerms;
    const book: PortfolioSpec = {
      ...bookOf(fixedTerms("unused")),
      positions: [{ id: "P-X", familyId: "A_FIXED", coaNodeId: "a-fixed", terms }],
    };
    expect(() => seasoningRefusals(book)).toThrow(RangeError);
  });
});
