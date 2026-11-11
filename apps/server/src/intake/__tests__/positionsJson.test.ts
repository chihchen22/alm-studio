/**
 * JSON intake: total validation (every error, not the first) and dry
 * instantiation through the engine's instrument factory so kernel domain
 * errors surface at import time with the offending position id attached.
 */
import { describe, expect, it } from "vitest";
import type { Position } from "@alm/engine";
import { seasoningOffsetOf } from "@alm/engine/src/portfolio/seasoning";
import { parsePositions } from "../index";
import { parsePositionsJson } from "../positionsJson";
import { toValidationResponse, type RowError } from "../validationReport";
import {
  fixedLoanPosition,
  floatingLoanPosition,
  mortgagePosition,
  nmdBetaPosition,
  nmdPosition,
  validSpec,
} from "./fixtures";

/** The message the engine's seasoning rule throws for these terms, read off the engine itself. */
function engineRefusal(p: Position): string {
  try {
    seasoningOffsetOf(p.terms);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`seasoningOffsetOf accepted ${p.id}`);
}

function expectErrors(result: ReturnType<typeof parsePositionsJson>): RowError[] {
  expect("errors" in result).toBe(true);
  return (result as { errors: RowError[] }).errors;
}

describe("parsePositionsJson", () => {
  it("accepts a clean five-type book verbatim", () => {
    const spec = validSpec([
      fixedLoanPosition("p1"),
      floatingLoanPosition("p2"),
      mortgagePosition("p3"),
      nmdPosition("p4"),
      nmdBetaPosition("p5"),
    ]);
    const result = parsePositionsJson(spec);
    expect("portfolio" in result).toBe(true);
    if ("portfolio" in result) {
      expect(result.portfolio.positions).toHaveLength(5);
      // Stored verbatim: the parse does not rewrite the spec.
      expect(result.portfolio).toBe(spec as unknown);
      expect(result.warnings).toEqual([]);
    }
  });

  it("returns ALL row errors, each naming the row and the field", () => {
    const spec = validSpec([
      fixedLoanPosition("bad-coupon", { coupon: "high" }),
      floatingLoanPosition("bad-family"),
      fixedLoanPosition("bad-enum", { amortType: "interest-only" }),
      fixedLoanPosition("ok-1"),
      fixedLoanPosition("missing-notional", { notional: undefined }),
    ]);
    (spec.positions as { familyId: string }[])[1].familyId = "no-such-family";
    const errors = expectErrors(parsePositionsJson(spec));

    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(errors).toContainEqual(
      expect.objectContaining({ row: 1, positionId: "bad-coupon", column: "coupon" }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ row: 2, positionId: "bad-family", column: "family_id" }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ row: 3, positionId: "bad-enum", column: "amortType" }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ row: 5, positionId: "missing-notional", column: "notional" }),
    );
    // The clean row contributes no error.
    expect(errors.some((e) => e.positionId === "ok-1")).toBe(false);
  });

  it("surfaces kernel domain errors via dry instantiation, id attached, verbatim", () => {
    const spec = validSpec([
      fixedLoanPosition("neg-notional", { notional: -5 }),
      floatingLoanPosition("bad-reset", { resetFrequencyMonths: 0.5 }),
      nmdBetaPosition("bad-lambda", {
        sCurve: { betaMin: 0.05, betaMax: 0.7, k: 1.2, m: 2.5, lambda: 0 },
      }),
      fixedLoanPosition("ok-1"),
    ]);
    const errors = expectErrors(parsePositionsJson(spec));

    // -5 is a finite number, 0.5 is a finite number, lambda 0 sits deep in a
    // param block: only the kernel constructors know these are impossible.
    expect(errors).toContainEqual(
      expect.objectContaining({
        row: 1,
        positionId: "neg-notional",
        message: "FixedLoan: notional must be positive",
      }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        row: 2,
        positionId: "bad-reset",
        message: "FloatingLoan: resetFrequencyMonths must be >= 1",
      }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        row: 3,
        positionId: "bad-lambda",
        message: "NMDBeta: lambda must be in (0, 1]",
      }),
    );
    expect(errors.some((e) => e.positionId === "ok-1")).toBe(false);
  });

  it("catches non-finite numbers, including deep inside param blocks", () => {
    const spec = validSpec([
      fixedLoanPosition("inf-coupon", { coupon: Infinity }),
      mortgagePosition("nan-deep", {
        cprParams: { ...(mortgagePosition("x").terms as unknown as { cprParams: object }).cprParams, cprMax: NaN },
      }),
    ]);
    const errors = expectErrors(parsePositionsJson(spec));
    expect(errors).toContainEqual(
      expect.objectContaining({ positionId: "inf-coupon", column: "coupon" }),
    );
    const deep = errors.find((e) => e.positionId === "nan-deep");
    expect(deep?.column).toBe("cprParams");
    expect(deep?.message).toContain("cprParams.cprMax");
  });

  it("refuses a seasoned floater with the row, id, column and the engine's own seasoning message; a seasoned fixed-loan imports", () => {
    const floater = floatingLoanPosition("fl-seasoned", { originationOffsetMonths: -6 });
    const errors = expectErrors(parsePositionsJson(validSpec([fixedLoanPosition("ok-1"), floater])));
    expect(errors).toEqual([
      { row: 2, positionId: "fl-seasoned", column: "originationOffsetMonths", message: engineRefusal(floater) },
    ]);
    expect(errors[0]!.message).toMatch(/cannot be applied to a floating loan/);

    const seasonedFixed = parsePositionsJson(validSpec([fixedLoanPosition("fx-seasoned", { originationOffsetMonths: -6 })]));
    expect("portfolio" in seasonedFixed).toBe(true);
  });

  it("enforces id discipline and the family-to-instrument mapping", () => {
    const wrongType = fixedLoanPosition("wrong-type");
    wrongType.familyId = "mma"; // mma declares nmd-b, terms say fixed-loan
    wrongType.coaNodeId = "n-mma";
    const spec = validSpec([
      fixedLoanPosition("dup"),
      fixedLoanPosition("dup"),
      wrongType,
      fixedLoanPosition("drifted-id", { id: "other-id" }),
      fixedLoanPosition("bad id!"),
    ]);
    const errors = expectErrors(parsePositionsJson(spec));
    expect(errors).toContainEqual(
      expect.objectContaining({ row: 2, column: "position_id", message: expect.stringContaining("duplicate") }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ positionId: "wrong-type", column: "terms_type", message: expect.stringContaining("(mapping)") }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ positionId: "drifted-id", column: "terms.id" }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ row: 5, column: "position_id" }),
    );
  });

  it("rejects positions attached to summation nodes or the wrong leaf", () => {
    const onRoot = fixedLoanPosition("on-root");
    onRoot.coaNodeId = "n-assets";
    const wrongLeaf = fixedLoanPosition("wrong-leaf");
    wrongLeaf.coaNodeId = "n-float";
    const errors = expectErrors(parsePositionsJson(validSpec([onRoot, wrongLeaf])));
    expect(errors).toContainEqual(
      expect.objectContaining({ positionId: "on-root", column: "coa_node_id", message: expect.stringContaining("summation") }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ positionId: "wrong-leaf", column: "coa_node_id", message: expect.stringContaining("n-loans") }),
    );
  });

  it("rejects a malformed portfolio header", () => {
    const spec = validSpec([fixedLoanPosition("p1")]);
    spec.id = "bad id with spaces";
    spec.asOf = "March 31";
    const errors = expectErrors(parsePositionsJson(spec));
    expect(errors).toContainEqual(expect.objectContaining({ column: "id" }));
    expect(errors).toContainEqual(expect.objectContaining({ column: "asOf" }));
  });

  it("rejects non-object bodies and malformed top-level shapes early", () => {
    expect(expectErrors(parsePositionsJson("a string"))[0].message).toContain("JSON object");
    expect(expectErrors(parsePositionsJson({ id: "x" }))).toContainEqual(
      expect.objectContaining({ column: "positions" }),
    );
    expect(expectErrors(parsePositionsJson({ positions: [], coa: {} }))).toContainEqual(
      expect.objectContaining({ column: "coa.nodes" }),
    );
  });

  it("warns on unrecognized terms fields instead of erroring", () => {
    const result = parsePositionsJson(validSpec([fixedLoanPosition("p1", { extraField: 1 })]));
    expect("portfolio" in result).toBe(true);
    if ("portfolio" in result) {
      expect(result.warnings.some((w) => w.includes('"extraField"'))).toBe(true);
    }
  });

  it("routes through parsePositions and shapes the 422 body", () => {
    const result = parsePositions({ kind: "json", spec: "nope" });
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      const body = toValidationResponse(result.errors);
      expect(body.error.code).toBe("VALIDATION");
      expect(body.error.message).toContain("1 validation error");
      expect(body.error.detail.errors).toEqual(result.errors);
    }
  });
});
