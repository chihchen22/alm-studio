// apps/studio/src/__tests__/clientRatePathModel.test.ts
import { describe, expect, it } from "vitest";
import type { RateDocument } from "@alm/engine";
import { ApiError } from "@alm/reader";
import { clientRateModel, sampleMonths } from "../assumptions/clientRatePathModel";

/** The basis sentences, restated (CALC Section 4 wording). */
const BASIS_CMT = "Benchmark: the 10-year forward par yield on the run's curve, on the curve's own quote basis: semi-annual bond-equivalent basis (Treasury CMT on the public pack).";
const BASIS_ACT = "Benchmark: the 10-year forward par yield on the run's curve, on the curve's own quote basis: annual ACT/360 par rate.";

const curve = { t: [1, 5, 10], z: [0.04, 0.042, 0.045], df: [0.96, 0.81, 0.64] };

function rowOf(over: Record<string, unknown> = {}, rates: number[] = []) {
  const clientRate = rates.length > 0 ? rates : (() => { const a = new Array(360).fill(0.07); a[0] = 0.0612; a[11] = 0.0634; return a; })();
  return {
    assumptionSetId: "loan-repricing-demo-v1", familyId: "mortgages", model: "flat-carry", curveConvention: "semiannual_bond",
    benchmarkTenorYears: 10, totalSpreadBp: 250, benchmark: clientRate.map((r) => r - 0.025), clientRate, ...over,
  };
}
function docOf(horizon: number, scenarios: unknown[], schemaVersion = "1.1.0"): RateDocument {
  return {
    schemaVersion, kind: "rate-document", runId: "run-1", mode: "deterministic",
    grid: { horizonMonths: horizon, dtYears: 1 / 12, asOf: "2026-03-31" }, base: curve, scenarios,
  } as unknown as RateDocument;
}
const scen = (id: string, extra: Record<string, unknown>) => ({ scenarioId: id, rateSpecKind: "base", ratePathModel: "deterministic", curve, ...extra });

describe("sampleMonths", () => {
  it("keeps 1, 12, 24, 60, 120 up to the horizon and appends the horizon once", () => {
    expect(sampleMonths(360)).toEqual([1, 12, 24, 60, 120, 360]);
    expect(sampleMonths(24)).toEqual([1, 12, 24]);
    expect(sampleMonths(60)).toEqual([1, 12, 24, 60]);
    expect(sampleMonths(13)).toEqual([1, 12, 13]);
    expect(sampleMonths(120)).toEqual([1, 12, 24, 60, 120]);
    expect(sampleMonths(1)).toEqual([1]);
  });
});

describe("clientRateModel rows", () => {
  it("reads the stored client rate at the sample months, month M from index M - 1", () => {
    const m = clientRateModel({ doc: docOf(360, [scen("S0", { clientRates: [rowOf()] })]) }, "run-1");
    expect(m.message).toBeNull();
    expect(m.months).toEqual([1, 12, 24, 60, 120, 360]);
    const row = m.scenarios[0]!.rows[0]!;
    expect(m.scenarios[0]!.scenarioId).toBe("S0");
    expect(row.family).toBe("mortgages");
    expect(row.selector).toBe("whole family");
    expect(row.spread).toBe("250 bp");
    expect(row.basis.endsWith("semi-annual bond-equivalent basis (Treasury CMT on the public pack).")).toBe(true);
    expect(row.basis).toBe(BASIS_CMT);
    expect(row.cells.map((c) => c.month)).toEqual([1, 12, 24, 60, 120, 360]);
    expect(row.cells[0]!.text).toBe("6.12%");
    expect(row.cells[1]!.text).toBe("6.34%");
    expect(row.cells[2]!.text).toBe("7.00%");
  });
  it("words an annual ACT/360 curve as its own basis", () => {
    const m = clientRateModel({ doc: docOf(360, [scen("S0", { clientRates: [rowOf({ curveConvention: "annual_act360" })] })]) }, "run-1");
    expect(m.scenarios[0]!.rows[0]!.basis).toBe(BASIS_ACT);
    expect(BASIS_ACT.endsWith("annual ACT/360 par rate.")).toBe(true);
  });
  it("horizon 24 gives [1, 12, 24] with 24 once; horizon 60 omits month 120; horizon 13 gives [1, 12, 13]", () => {
    const at = (h: number) => clientRateModel({ doc: docOf(h, [scen("S0", { clientRates: [rowOf({}, new Array(h).fill(0.06))] })]) }, "run-1").scenarios[0]!.rows[0]!.cells.map((c) => c.month);
    expect(at(24)).toEqual([1, 12, 24]);
    expect(at(60)).toEqual([1, 12, 24, 60]);
    expect(at(13)).toEqual([1, 12, 13]);
  });
  it("never indexes past a shorter stored array", () => {
    const m = clientRateModel({ doc: docOf(60, [scen("S0", { clientRates: [rowOf({}, [0.06, 0.061, 0.062])] })]) }, "run-1");
    expect(m.scenarios[0]!.rows[0]!.cells.map((c) => c.month)).toEqual([1]);
  });
  it("prints a stored selector in words", () => {
    const m = clientRateModel({ doc: docOf(24, [scen("S0", { clientRates: [rowOf({ selector: { segment: "retail" } }, new Array(24).fill(0.06))] })]) }, "run-1");
    expect(m.scenarios[0]!.rows[0]!.selector).toBe("segment: retail");
  });
  it("keeps one entry per row, in stored order, and per scenario", () => {
    const m = clientRateModel({ doc: docOf(24, [
      scen("S0", { clientRates: [rowOf({ familyId: "mortgages" }, new Array(24).fill(0.06)), rowOf({ familyId: "mbs" }, new Array(24).fill(0.05))] }),
      scen("S100", { clientRates: [rowOf({}, new Array(24).fill(0.07))] }),
    ]) }, "run-1");
    expect(m.scenarios.map((s) => [s.scenarioId, s.rows.map((r) => r.family)])).toEqual([["S0", ["mortgages", "mbs"]], ["S100", ["mortgages"]]]);
  });
});

describe("clientRateModel states", () => {
  it("a 1.0.0 document says to re-run", () => {
    const m = clientRateModel({ doc: docOf(24, [scen("S0", {})], "1.0.0") }, "run-1");
    expect(m.message).toBe("This run finished before client rates were projected; re-run it.");
    expect(m.scenarios).toEqual([]);
  });
  it("a path-omitted scenario prints its stored text beside the scenarios that carry rows", () => {
    const m = clientRateModel({ doc: docOf(24, [
      scen("S0", { clientRates: [rowOf({}, new Array(24).fill(0.06))] }),
      scen("S100", { ratePathModel: "hw1f-demo", pathOmitted: "rate path model is not the deterministic built-in" }),
    ]) }, "run-1");
    expect(m.message).toBeNull();
    expect(m.scenarios.map((s) => [s.scenarioId, s.omitted, s.rows.length])).toEqual([["S0", null, 1], ["S100", "rate path model is not the deterministic built-in", 0]]);
  });
  it("a run whose scenarios are all path-omitted prints their stored texts and no binding claim", () => {
    const m = clientRateModel({ doc: docOf(24, [scen("S0", { ratePathModel: "hw1f-demo", pathOmitted: "no path" })]) }, "run-1");
    expect(m.message).toBeNull();
    expect(m.scenarios.map((s) => [s.scenarioId, s.omitted])).toEqual([["S0", "no path"]]);
  });
  it("no client rates on any scenario says the set binds no loan repricing", () => {
    const m = clientRateModel({ doc: docOf(24, [scen("S0", {}), scen("S100", {})]) }, "run-1");
    expect(m.message).toBe("The run's assumption set binds no loan repricing.");
    expect(m.scenarios).toEqual([]);
  });
  it("an empty run says to pick a run", () => {
    expect(clientRateModel({ doc: null }, "").message).toBe("Pick a run to see its projected client rate.");
  });
  it("a read failure prints the error text", () => {
    expect(clientRateModel({ error: new ApiError(404, "not-found", "no such run") }, "run-9").message).toBe("404: no such run");
    expect(clientRateModel({ error: new Error("boom") }, "run-9").message).toBe("boom");
  });
});
