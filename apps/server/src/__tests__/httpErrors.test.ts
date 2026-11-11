/**
 * The view-refusal family maps to 422 through the generic table, so
 * an instance escaping a route's own catch is a validation answer carrying the
 * engine's message verbatim, never a 500.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CellBudgetError, ViewDefinitionError } from "@alm/engine/src/run/executorErrors";
import { PivotUnavailableError } from "@alm/engine/src/report/pivot";
import { DerivativeOverlayError } from "@alm/engine/src/scenario/resolveAssumptions";
import { ClientRateSpreadMismatchError } from "@alm/engine";
import { buildDemoAssumptions } from "@alm/data/src/demo/request";
import { toHttpError } from "../http/errors";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

describe("toHttpError on the view-refusal family", () => {
  const cases: Array<[string, Error]> = [
    ["ViewDefinitionError", new ViewDefinitionError("P3", "by-segment", "segment", "no value", "F1")],
    ["CellBudgetError", new CellBudgetError(["by-account"], 100_000, 100_000, 6, 8, 2 ** 40, 2 ** 32)],
    ["PivotUnavailableError", new PivotUnavailableError({ viewId: "v", metric: "nii", scenarioId: "S1" }, "no cell arm")],
  ];

  it.each(cases)("%s maps to 422 with the message verbatim", (_name, err) => {
    const http = toHttpError(err);
    expect(http.status).toBe(422);
    expect(http.code).toBe("validation");
    expect(http.message).toBe(err.message);
  });

  it("maps piece 8's DerivativeOverlayError (live run route) to 422 with the message verbatim", () => {
    const err = new DerivativeOverlayError("SWAPS", "decay");
    const http = toHttpError(err);
    expect(`${http.status} ${http.code}`, `status for ${err.name}: ${http.status}`).toBe("422 validation");
    expect(http.message).toBe(err.message);
  });

  it("maps piece 9's ClientRateSpreadMismatchError to 422 with the message verbatim", () => {
    const err = new ClientRateSpreadMismatchError("demo-x", "mortgages", undefined, 260, 120, 130);
    expect(err.name).toBe("ClientRateSpreadMismatchError");
    const http = toHttpError(err);
    expect(http.status + " " + http.code).toBe("422 validation");
    expect(http.message).toBe(err.message);
    // The same name on a plain Error also reaches the net: it matches by name.
    const plain = new Error("loan client-rate total spread 260 bp vs prepay 250 (120 + 130) bp");
    plain.name = "ClientRateSpreadMismatchError";
    expect(toHttpError(plain).status).toBe(422);
  });

  it("still maps an unnamed Error to 500", () => {
    expect(toHttpError(new Error("boom")).status).toBe(500);
  });
});

describe("Edit a set save route on a client-rate spread mismatch", () => {
  let tp: TestPlatform;
  beforeAll(async () => {
    tp = await bootTestPlatform();
  });
  afterAll(() => tp.close());

  it("answers 422 naming the spreads when client rate 260 meets prepay 120 + 130", async () => {
    const demo = buildDemoAssumptions();
    const clientRate = (totalSpreadBp: number) => ({
      familyId: "mortgages",
      overlay: { kind: "loan-client-rate", model: "flat-carry", totalSpreadBp },
      modelVersion: "illustrative-flat-carry-1",
    });
    const set = (id: string, totalSpreadBp: number) => ({
      schemaVersion: "1.0.0",
      id,
      label: "Client rate " + totalSpreadBp + " bp against prepay 120 + 130 bp",
      bindings: [...demo.bindings, clientRate(totalSpreadBp)],
    });
    const r = await api<{ error: { code: string; message: string } }>(
      tp.base,
      "POST",
      "/api/assumption-sets",
      set("drill-client-rate-mismatch-v1", 260),
    );
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("total spread 260 bp vs prepay 250 (120 + 130) bp");
    expect(r.body.error.message).toContain("family mortgages");

    // The equal value saves: 250 = 120 + 130.
    const ok = await api(tp.base, "POST", "/api/assumption-sets", set("drill-client-rate-equal-v1", 250));
    expect(ok.status).toBe(201);
  }, 60_000);
});

describe("toHttpError on the derivation refusal (Piece 6a)", () => {
  it("maps an Error named AssumptionDerivationError to 422 with the message verbatim", () => {
    const err = new Error("derived set refused: 1 problem(s); every problem is listed: ops[0]: nope");
    err.name = "AssumptionDerivationError";
    const http = toHttpError(err);
    expect(http.status + " " + http.code).toBe("422 validation");
    expect(http.message).toBe(err.message);
  });
});
