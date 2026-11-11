/**
 * CSV intake: RFC 4180 parsing, contract-driven cells, kernel-default param
 * blocks with loud warnings, and total per-row error reporting with physical
 * line numbers.
 */
import { describe, expect, it } from "vitest";
import { FLOATING_LOAN_DEFAULTS } from "@alm/kernel";
import { seasoningOffsetOf } from "@alm/engine/src/portfolio/seasoning";
import { parsePositions } from "../index";
import { parsePositionsCsv } from "../positionsCsv";
import type { RowError } from "../validationReport";
import { TEST_COA, TEST_TAXONOMY } from "./fixtures";

const HEADER =
  "position_id,family_id,coa_node_id,terms_type,label,notional,maturityMonths,originationOffsetMonths,amortType,side,coupon,indexTenorMonths,margin,resetFrequencyMonths,depositRate,beta";

const PORTFOLIO = { portfolioId: "csv-book", label: "CSV test book", asOf: "2026-03-31" };

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\r\n");
}

function expectErrors(result: ReturnType<typeof parsePositionsCsv>): RowError[] {
  expect("errors" in result).toBe(true);
  return (result as { errors: RowError[] }).errors;
}

describe("parsePositionsCsv", () => {
  it("imports a mixed book, fills param blocks and side from kernel defaults and the family, loudly", () => {
    const result = parsePositionsCsv(
      csv(
        'p1,loans,n-loans,fixed-loan,"Loan, small",1000000,60,-6,level-pay,asset,0.05,,,,,',
        "p2,floaters,n-float,floating-loan,,2000000,36,0,level-pay,,,1,0.02,3,,",
        "p3,dda,n-dda,nmd,,500000,360,0,level-pay,,,,,,0,0",
        "p4,mma,n-mma,nmd-b,,750000,360,0,level-pay,,,,,,,",
      ),
      TEST_COA,
      PORTFOLIO,
    );
    expect("portfolio" in result).toBe(true);
    if (!("portfolio" in result)) return;

    const { portfolio, warnings } = result;
    expect(portfolio.id).toBe("csv-book");
    expect(portfolio.asOf).toBe("2026-03-31");
    expect(portfolio.coa).toBe(TEST_COA);
    expect(portfolio.positions.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4"]);

    const p1 = portfolio.positions[0].terms as unknown as Record<string, unknown>;
    expect(p1.label).toBe("Loan, small"); // quoted embedded comma survives
    expect(p1.coupon).toBe(0.05);
    expect(p1.originationOffsetMonths).toBe(-6); // a seasoned fixed-loan is the one type the engine re-anchors

    const p2 = portfolio.positions[1].terms as unknown as Record<string, unknown>;
    expect(p2.side).toBe("asset"); // filled from the floaters family
    expect(p2.originationOffsetMonths).toBe(0);

    const p3 = portfolio.positions[2].terms as unknown as Record<string, unknown>;
    expect(p3.side).toBe("liability");
    expect(p3.nmdParams).toBeDefined(); // kernel default block

    const p4 = portfolio.positions[3].terms as unknown as Record<string, unknown>;
    expect(p4.sCurve).toBeDefined();
    expect(p4.nmdParams).toBeDefined();

    // Every default fill is announced, never silent.
    expect(warnings.some((w) => w.startsWith("nmd.nmdParams"))).toBe(true);
    expect(warnings.some((w) => w.startsWith("nmd-b.sCurve"))).toBe(true);
    expect(warnings.some((w) => w.startsWith("nmd-b.nmdParams"))).toBe(true);
    expect(warnings.some((w) => w.includes("side filled from the owning family for 3"))).toBe(true);
  });

  it("refuses a seasoned floater at its physical line with the column and the engine's own seasoning message", () => {
    const errors = expectErrors(
      parsePositionsCsv(
        csv(
          "p1,loans,n-loans,fixed-loan,,1000000,60,-6,level-pay,,0.05,,,,,", // line 2: seasoned fixed-loan, clean
          "fl-6,floaters,n-float,floating-loan,,2000000,36,-6,level-pay,,,1,0.02,3,,", // line 3
        ),
        TEST_COA,
        PORTFOLIO,
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ row: 3, positionId: "fl-6", column: "originationOffsetMonths", message: expect.any(String) });
    let thrown = "";
    try {
      seasoningOffsetOf({ ...FLOATING_LOAN_DEFAULTS, id: "fl-6", originationOffsetMonths: -6 });
    } catch (e) {
      thrown = (e as Error).message;
    }
    expect(thrown).toMatch(/cannot be applied to a floating loan/);
    expect(errors[0]!.message).toBe(thrown);
  });

  it("reports every bad row with its physical line number and column", () => {
    const errors = expectErrors(
      parsePositionsCsv(
        csv(
          "p1,loans,n-loans,fixed-loan,,not-a-number,60,0,level-pay,,0.05,,,,,", // line 2
          "p2,loans,n-loans,fixed-loan,,1000000,60,0,interest-only,,0.05,,,,,", // line 3
          "p3,no-such-family,n-loans,fixed-loan,,1000000,60,0,level-pay,,0.05,,,,,", // line 4
          "p4,loans,n-loans,fixed-loan,,1000000,60,0,level-pay,,,,,,,", // line 5: coupon empty
          "p5,loans,n-loans,fixed-loan,,1000000,60,0,level-pay,,0.05,,,,,", // line 6: clean
          "p6,floaters,n-float,floating-loan,,1000000,60,0,level-pay,,0.07,1,0.02,3,,", // line 7: coupon on a floater
        ),
        TEST_COA,
        PORTFOLIO,
      ),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ row: 2, positionId: "p1", column: "notional" }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ row: 3, positionId: "p2", column: "amortType" }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ row: 4, positionId: "p3", column: "family_id" }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ row: 5, positionId: "p4", column: "coupon" }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        row: 7,
        positionId: "p6",
        column: "coupon",
        message: expect.stringContaining('does not apply to terms_type "floating-loan"'),
      }),
    );
    expect(errors.some((e) => e.positionId === "p5")).toBe(false);
  });

  it("surfaces kernel domain errors through CSV rows with line numbers", () => {
    const errors = expectErrors(
      parsePositionsCsv(
        csv("p1,floaters,n-float,floating-loan,,1000000,36,0,level-pay,,,1,0.02,0,,"),
        TEST_COA,
        PORTFOLIO,
      ),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        row: 2,
        positionId: "p1",
        message: "FloatingLoan: resetFrequencyMonths must be >= 1",
      }),
    );
  });

  it("rejects an unknown or duplicate or missing header column up front", () => {
    const badHeader = HEADER.replace(",beta", ",beta,wacky_column");
    const errors = expectErrors(
      parsePositionsCsv(
        [badHeader, "p1,loans,n-loans,fixed-loan,,1,60,0,level-pay,,0.05,,,,,,"].join("\n"),
        TEST_COA,
        PORTFOLIO,
      ),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ row: 1, column: "wacky_column", message: expect.stringContaining("unknown column") }),
    );

    const missingMeta = expectErrors(
      parsePositionsCsv(["notional,coupon", "1,0.05"].join("\n"), TEST_COA, PORTFOLIO),
    );
    for (const meta of ["position_id", "family_id", "coa_node_id", "terms_type"]) {
      expect(missingMeta).toContainEqual(expect.objectContaining({ column: meta }));
    }
  });

  it("errors on a stated side that contradicts the family", () => {
    const errors = expectErrors(
      parsePositionsCsv(
        csv("p1,dda,n-dda,nmd,,500000,360,0,level-pay,asset,,,,,0,0"),
        TEST_COA,
        PORTFOLIO,
      ),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ row: 2, positionId: "p1", column: "side" }),
    );
  });

  it("refuses empty files, header-only files, and unterminated quotes", () => {
    expect(expectErrors(parsePositionsCsv("", TEST_COA, PORTFOLIO))[0].message).toContain("empty");
    expect(expectErrors(parsePositionsCsv(HEADER, TEST_COA, PORTFOLIO))[0].message).toContain(
      "no data rows",
    );
    expect(
      expectErrors(parsePositionsCsv(csv('p1,loans,n-loans,fixed-loan,"unterminated'), TEST_COA, PORTFOLIO))[0]
        .message,
    ).toContain("unterminated");
  });

  it("routes through parsePositions with a store COA lookup and refuses unknown coaIds", () => {
    const viaIndex = parsePositions(
      {
        kind: "csv",
        text: csv("p1,loans,n-loans,fixed-loan,,1000000,60,0,level-pay,,0.05,,,,,"),
        coaId: "demo-coa",
        ...PORTFOLIO,
      },
      { resolveCoa: (id) => (id === "demo-coa" ? TEST_COA : undefined) },
    );
    expect("portfolio" in viaIndex).toBe(true);

    const unknown = parsePositions(
      { kind: "csv", text: "x", coaId: "nope", ...PORTFOLIO },
      { resolveCoa: () => undefined },
    );
    expect("errors" in unknown).toBe(true);
    if ("errors" in unknown) {
      expect(unknown.errors[0].message).toContain('no stored chart of accounts with id "nope"');
    }
  });
});

/**
 * Piece 2d, spec Sections 3.2 to 3.4. A CSV book tags its positions through
 * dim.<id> columns against a stored taxonomy. Nothing in the parser checks a
 * tag value: the engine's D1 to D4, run by validatePortfolioSpec, are the only
 * tag validation, and the parser's one display concession is rewriting the
 * column those rules name from dimensions.<id> to the dim.<id> the author wrote.
 */
describe("piece 2d: CSV tag columns", () => {
  const TAG_HEADER = `${HEADER},dim.vintage,dim.segment,dim.behavioralClasses`;
  const LOAN = "p1,loans,n-loans,fixed-loan,,1000000,60,0,level-pay,,0.05,,,,,";
  const LOAN2 = "p2,loans,n-loans,fixed-loan,,1000000,60,0,level-pay,,0.05,,,,,";

  function taggedCsv(...rows: string[]): string {
    return [TAG_HEADER, ...rows].join("\r\n");
  }

  it("accepts a taxonomy with no dim. column and carries it on the spec, bagless", () => {
    const result = parsePositionsCsv(csv(LOAN), TEST_COA, PORTFOLIO, TEST_TAXONOMY);
    expect("portfolio" in result).toBe(true);
    if (!("portfolio" in result)) return;
    expect(result.portfolio.taxonomy).toBe(TEST_TAXONOMY);
    expect(result.portfolio.positions[0].dimensions).toBeUndefined();
  });

  it("resolves taxonomyId through the store and refuses an unknown one", () => {
    const resolveCoa = (id: string) => (id === "demo-coa" ? TEST_COA : undefined);
    const ok = parsePositions(
      { kind: "csv", text: csv(LOAN), coaId: "demo-coa", taxonomyId: "demo-tax", ...PORTFOLIO },
      { resolveCoa, resolveTaxonomy: (id) => (id === "demo-tax" ? TEST_TAXONOMY : undefined) },
    );
    expect("portfolio" in ok).toBe(true);
    if ("portfolio" in ok) expect(ok.portfolio.taxonomy?.id).toBe("test-taxonomy");

    const unknown = parsePositions(
      { kind: "csv", text: csv(LOAN), coaId: "demo-coa", taxonomyId: "nope", ...PORTFOLIO },
      { resolveCoa, resolveTaxonomy: () => undefined },
    );
    expect("errors" in unknown).toBe(true);
    if ("errors" in unknown) {
      expect(unknown.errors[0].column).toBe("taxonomyId");
      expect(unknown.errors[0].message).toContain('no stored dimension taxonomy with id "nope"');
    }
  });

  it("carries dim.<id> cells into the position bag and leaves an untagged row bagless", () => {
    const result = parsePositionsCsv(
      taggedCsv(`${LOAN},2019,relationship,decay`, `${LOAN2},,,`),
      TEST_COA,
      PORTFOLIO,
      TEST_TAXONOMY,
    );
    expect("portfolio" in result).toBe(true);
    if (!("portfolio" in result)) return;
    expect(result.portfolio.positions[0].dimensions).toEqual({
      vintage: "2019",
      segment: "relationship",
      behavioralClasses: ["decay"],
    });
    expect(result.portfolio.positions[1].dimensions).toBeUndefined();
  });

  it("splits a multi-valued cell on the pipe and trims each piece", () => {
    const result = parsePositionsCsv(
      taggedCsv(`${LOAN},,,decay | deposit-beta`),
      TEST_COA,
      PORTFOLIO,
      TEST_TAXONOMY,
    );
    expect("portfolio" in result).toBe(true);
    if (!("portfolio" in result)) return;
    expect(result.portfolio.positions[0].dimensions).toEqual({
      behavioralClasses: ["decay", "deposit-beta"],
    });
  });

  it("infers an open taxonomy from the dim. columns when no taxonomy was given", () => {
    const result = parsePositionsCsv(taggedCsv(`${LOAN},2019,relationship,decay`, `${LOAN2},2021,,`), TEST_COA, PORTFOLIO);
    expect("portfolio" in result).toBe(true);
    if (!("portfolio" in result)) return;
    expect(result.portfolio.taxonomy).toEqual({
      schemaVersion: "1.0.0",
      id: "csv-book-tags",
      label: "Tags read from the columns of CSV test book",
      dimensions: [
        { id: "vintage", label: "vintage" },
        { id: "segment", label: "segment" },
        { id: "behavioralClasses", label: "behavioralClasses", multiValued: true },
      ],
    });
    expect(result.portfolio.positions[0].dimensions).toEqual({ vintage: "2019", segment: "relationship", behavioralClasses: ["decay"] });
    // Fix round M2: a blank cell of an inferred single-valued tag is "Unassigned"; the multi-valued classes stay absent.
    expect(result.portfolio.positions[1].dimensions).toEqual({ vintage: "2021", segment: "Unassigned" });
    expect(result.warnings).toContain("1 position has no segment; it is grouped as Unassigned.");
  });

  it("groups blank cells as Unassigned and counts them in one line (fix round M2)", () => {
    const rows = [`p1,loans,n-loans,fixed-loan,,1000000,60,0,level-pay,,0.05,,,,,,east`, `p2,loans,n-loans,fixed-loan,,1000000,60,0,level-pay,,0.05,,,,,,`, `p3,loans,n-loans,fixed-loan,,1000000,60,0,level-pay,,0.05,,,,,,`];
    const result = parsePositionsCsv([`${HEADER},dim.region`, ...rows].join("\r\n"), TEST_COA, PORTFOLIO);
    expect("portfolio" in result).toBe(true);
    if (!("portfolio" in result)) return;
    expect(result.portfolio.positions.map((p) => p.dimensions?.region)).toEqual(["east", "Unassigned", "Unassigned"]);
    expect(result.warnings).toContain("2 positions have no region; they are grouped as Unassigned.");
  });

  it("reads a dim. column blank on every row as no tag, and says so (fix round M2)", () => {
    const result = parsePositionsCsv([`${HEADER},dim.region,dim.desk`, `${LOAN},,north`, `${LOAN2},,south`].join("\r\n"), TEST_COA, PORTFOLIO);
    expect("portfolio" in result).toBe(true);
    if (!("portfolio" in result)) return;
    expect(result.portfolio.taxonomy?.dimensions).toEqual([{ id: "desk", label: "desk" }]);
    expect(result.portfolio.positions.map((p) => p.dimensions)).toEqual([{ desk: "north" }, { desk: "south" }]);
    expect(result.warnings).toContain("The column dim.region is blank on every row, so it is not read as a tag.");
    const none = parsePositionsCsv([`${HEADER},dim.region`, `${LOAN},`].join("\r\n"), TEST_COA, PORTFOLIO);
    if (!("portfolio" in none)) throw new Error("expected a portfolio");
    expect("taxonomy" in none.portfolio).toBe(false);
    expect(none.portfolio.positions[0].dimensions).toBeUndefined();
  });

  it("refuses two tag columns whose names differ only in case (fix round L8)", () => {
    const errors = expectErrors(parsePositionsCsv([`${HEADER},dim.region,dim.Region`, `${LOAN},a,b`].join("\r\n"), TEST_COA, PORTFOLIO));
    expect(errors).toEqual([{ row: 1, column: "dim.Region", message: 'columns "dim.region" and "dim.Region" differ only in case; name a tag once' }]);
  });

  it("refuses an inferred dim. column that names a derived tag or a malformed name, by column", () => {
    const errors = expectErrors(parsePositionsCsv([`${HEADER},dim.side,dim.9x`, `${LOAN},asset,a`].join("\r\n"), TEST_COA, PORTFOLIO));
    expect(errors).toEqual([
      { row: 1, column: "dim.side", message: 'column "dim.side" names a tag the engine derives from the chart of accounts; drop the column' },
      { row: 1, column: "dim.9x", message: 'column "dim.9x": a tag name starts with a letter and holds letters, digits, "-" or "_" (at most 64)' },
    ]);
  });

  it("keeps a file with no dim. column taxonomy-free, as before", () => {
    const result = parsePositionsCsv(csv(LOAN), TEST_COA, PORTFOLIO);
    expect("portfolio" in result).toBe(true);
    if (!("portfolio" in result)) return;
    expect("taxonomy" in result.portfolio).toBe(false);
  });

  it("refuses a dim. column the taxonomy does not declare, and a derived one it does", () => {
    const withSide = {
      ...TEST_TAXONOMY,
      dimensions: [...TEST_TAXONOMY.dimensions, { id: "side", label: "Balance-sheet side" }],
    };
    const errors = expectErrors(
      parsePositionsCsv(
        [`${HEADER},dim.nope,dim.side`, `${LOAN},x,asset`].join("\r\n"),
        TEST_COA,
        PORTFOLIO,
        withSide,
      ),
    );
    const unknown = errors.find((e) => e.column === "dim.nope")!;
    expect(unknown.row).toBe(1);
    expect(unknown.message).toContain('unknown column "dim.nope"');
    expect(unknown.message).toContain("dim.segment");
    // productFamily and side are derived and unauthorable, so dim.side is not legal.
    expect(unknown.message).not.toContain("dim.side");
    expect(errors).toContainEqual(
      expect.objectContaining({ row: 1, column: "dim.side", message: expect.stringContaining("unknown column") }),
    );
  });

  it("refuses a duplicate dim. column", () => {
    const errors = expectErrors(
      parsePositionsCsv(
        [`${HEADER},dim.vintage,dim.vintage`, `${LOAN},2019,2019`].join("\r\n"),
        TEST_COA,
        PORTFOLIO,
        TEST_TAXONOMY,
      ),
    );
    expect(errors).toContainEqual({
      row: 1,
      column: "dim.vintage",
      message: 'duplicate column "dim.vintage"',
    });
  });

  it("reports a D3 value refusal under dim.<id> with the row line", () => {
    const errors = expectErrors(
      parsePositionsCsv(
        taggedCsv(`${LOAN},2019,whale,decay`, `${LOAN2},,,a||b`),
        TEST_COA,
        PORTFOLIO,
        TEST_TAXONOMY,
      ),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        row: 2,
        positionId: "p1",
        column: "dim.segment",
        message: expect.stringContaining("D3:"),
      }),
    );
    // "a||b" keeps the empty piece, so D3 refuses it with the row and column named.
    expect(errors).toContainEqual(
      expect.objectContaining({
        row: 3,
        positionId: "p2",
        column: "dim.behavioralClasses",
        message: expect.stringContaining("empty value"),
      }),
    );
    expect(errors.some((e) => e.column === "dimensions.segment")).toBe(false);
  });
});
