/**
 * JSON intake and the rateIndexId terms field.
 *
 * A floating-loan may name a market rate index through rateIndexId. Intake
 * checks only its shape (the market that carries the index is not known at
 * import time; the run refuses a missing one). On any other terms type the
 * field is a row error, swaps included, so an author cannot believe a fixed
 * loan floats. Expected texts are restated here, never read from the code under
 * test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePositionsJson } from "../intake/positionsJson";
import type { RowError } from "../intake/validationReport";
import { fixedLoanPosition, floatingLoanPosition, validSpec } from "../intake/__tests__/fixtures";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

let tp: TestPlatform;
beforeAll(async () => {
  tp = await bootTestPlatform();
}, 60_000);
afterAll(async () => {
  await tp.close();
});

const FLOATING_ONLY =
  "rateIndexId is read on floating-loan terms only; a swap's floating leg stays on the one-month benchmark";

describe("rateIndexId at JSON intake", () => {
  it("accepts a floater naming prime-demo with no warning, stored verbatim", () => {
    const spec = validSpec([floatingLoanPosition("f1", { rateIndexId: "prime-demo" })]);
    const out = parsePositionsJson(spec);
    expect("portfolio" in out, JSON.stringify(out)).toBe(true);
    if ("portfolio" in out) {
      expect(out.warnings).toEqual([]);
      const terms = out.portfolio.positions[0].terms as unknown as Record<string, unknown>;
      expect(terms.rateIndexId).toBe("prime-demo");
    }
  });

  it("a floater with no rateIndexId is unchanged: accepted, no warning", () => {
    const out = parsePositionsJson(validSpec([floatingLoanPosition("f1")]));
    expect("portfolio" in out).toBe(true);
    if ("portfolio" in out) expect(out.warnings).toEqual([]);
  });

  it("refuses an id that is not lowercase letters, digits and single hyphens (Prime) as a row error on rateIndexId", () => {
    const out = parsePositionsJson(validSpec([floatingLoanPosition("f1", { rateIndexId: "Prime" })]));
    expect("errors" in out).toBe(true);
    const errors = (out as { errors: RowError[] }).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0].column).toBe("rateIndexId");
    expect(errors[0].positionId).toBe("f1");
    expect(errors[0].row).toBe(1);
    expect(errors[0].message).toBe(
      'field "rateIndexId" must be a rate index id of lowercase letters, digits and single hyphens, starting with a letter, at most 40 characters; got "Prime"',
    );
  });

  it("refuses a non-string id and an over-long id", () => {
    const out = parsePositionsJson(
      validSpec([
        floatingLoanPosition("f1", { rateIndexId: 7 }),
        floatingLoanPosition("f2", { rateIndexId: "a".repeat(41) }),
      ]),
    );
    const errors = (out as { errors: RowError[] }).errors;
    expect(errors.map((e) => [e.positionId, e.column])).toEqual([
      ["f1", "rateIndexId"],
      ["f2", "rateIndexId"],
    ]);
    expect(errors[0].message).toContain("got 7");
  });

  it("a fixed-loan carrying rateIndexId gets the floating-only row error", () => {
    const out = parsePositionsJson(validSpec([fixedLoanPosition("p1", { rateIndexId: "prime-demo" })]));
    const errors = (out as { errors: RowError[] }).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0].column).toBe("rateIndexId");
    expect(errors[0].positionId).toBe("p1");
    expect(errors[0].message).toBe(FLOATING_ONLY);
  });

  it("POST /api/portfolios/import stores the terms with rateIndexId intact", async () => {
    const spec = {
      ...validSpec([floatingLoanPosition("f1", { rateIndexId: "prime-demo" })]),
      id: "idx-intake-test",
    };
    const r = await api<{ id: string; warnings: string[] }>(tp.base, "POST", "/api/portfolios/import", spec);
    expect(r.status, r.text).toBe(201);
    expect(r.body.warnings).toEqual([]);
    const got = await api<{ positions: Array<{ terms: Record<string, unknown> }> }>(
      tp.base,
      "GET",
      "/api/portfolios/idx-intake-test",
    );
    expect(got.status).toBe(200);
    expect(got.body.positions[0].terms.rateIndexId).toBe("prime-demo");
  });

  it("POST /api/portfolios/import answers 422 for a fixed-loan naming an index", async () => {
    const spec = {
      ...validSpec([fixedLoanPosition("p1", { rateIndexId: "prime-demo" })]),
      id: "idx-intake-bad",
    };
    const r = await api<{ error: { detail: RowError[] } }>(tp.base, "POST", "/api/portfolios/import", spec);
    expect(r.status).toBe(422);
    expect(r.body.error.detail.map((e) => e.message)).toEqual([FLOATING_ONLY]);
  });
});
