/**
 * The rate document builder. Every expected number is RESTATED here:
 * the discount identity exp(-z t), the order-statistic interpolation at
 * position (n - 1) p, the sample mean. The curve and path seams are called to
 * obtain the INPUT objects the builder is pinned against, never to compute an
 * expectation the builder itself produces.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { HWSimulationResult, MarketSnapshot, ZeroCurve } from "@alm/kernel";
import { STOCHASTIC_QUANTILES } from "../../contracts/stochastic";
import type { Scenario } from "../../contracts/scenario";
import { buildBaseCurve, shockedCurve } from "../../scenario/rateEnvironment";
import { quoteTenorsOf } from "../../curveBuilder/quoteTenors";
import { buildScenarioRatePath } from "../../projection/static/staticRunoff";
import {
  baseAssumptions,
  loadMarket,
  makeRunRequest,
  regulatoryScenarios,
  HORIZON,
} from "../../run/__tests__/fixtures";
import type { RunRequest } from "../../contracts/run";
import type { AssumptionSet } from "../../contracts/assumptions";
import { RATE_DOCUMENT_SCHEMA_VERSION } from "../../contracts/rateDocument";
import {
  buildRateDocument,
  buildStochasticRateFan,
  curveNodesOf,
  RateDocumentError,
} from "../rateDocument";

let market: MarketSnapshot;
let baseCurve: ZeroCurve;
/** The kernel bootstrap (curveDefault: 1), a curve with no quote-tenor registration whose own nodes are its quotes. */
let kernelCurve: ZeroCurve;

beforeAll(async () => {
  market = await loadMarket();
  baseCurve = buildBaseCurve(market);
  kernelCurve = buildBaseCurve({ ...market, curveDefault: 1 } as MarketSnapshot);
});

/**
 * The nodes a rate document reports for a curve, restated: the curve's quote tenors (registered by the default
 * curve's dense build, else its own nodes) with z read off the curve at each. The default curve carries 360 dense
 * whole-month nodes, so its document reports the 11 quote tenors, not curve.t. Deltas Step 1.
 */
const quoteNodesZ = (curve: ZeroCurve): number[] => quoteTenorsOf(curve).map((t) => curve.zeroRate(t));

const DET = { runId: "RUN-RATES-1", mode: "deterministic" as const };

/** The order-statistic interpolation, restated: position (n - 1) p on the sorted sample. */
function handQuantile(sorted: number[], p: number): number {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const rest = pos - lo;
  if (lo + 1 < sorted.length) return sorted[lo] + rest * (sorted[lo + 1] - sorted[lo]);
  return sorted[lo];
}

describe("curveNodesOf", () => {
  it("copies the curve's own nodes and restates df = exp(-z t) at each", () => {
    // A curve with no registration (the kernel bootstrap); the dense default is covered in curveNodesQuoteTenors.test.ts.
    const baseCurve = kernelCurve;
    const nodes = curveNodesOf(baseCurve);
    expect(nodes.t).toEqual([...baseCurve.t]);
    expect(nodes.z).toEqual([...baseCurve.z]);
    expect(nodes.df.length).toBe(nodes.t.length);
    for (let i = 0; i < nodes.t.length; i++) {
      expect(nodes.df[i]).toBeCloseTo(Math.exp(-nodes.z[i] * nodes.t[i]), 14);
      expect(nodes.df[i]).toBeCloseTo(baseCurve.discountFactor(nodes.t[i]), 14);
      if (i > 0) expect(nodes.t[i]).toBeGreaterThan(nodes.t[i - 1]);
    }
    // A copy, not a view: mutating the document never reaches the curve.
    nodes.z[0] = 99;
    expect(baseCurve.z[0]).not.toBe(99);
  });
});

describe("buildRateDocument, deterministic", () => {
  it("identifies itself, carries the grid, and has one entry per scenario in request order", () => {
    const request = makeRunRequest(market);
    const doc = buildRateDocument(request, DET);
    expect(doc.schemaVersion).toBe(RATE_DOCUMENT_SCHEMA_VERSION);
    expect(doc.kind).toBe("rate-document");
    expect(doc.runId).toBe("RUN-RATES-1");
    expect(doc.mode).toBe("deterministic");
    expect(doc.grid).toEqual({ horizonMonths: HORIZON, dtYears: 1 / 12, asOf: request.grid.asOf });
    expect(doc.scenarios.map((s) => s.scenarioId)).toEqual(request.scenarios.map((s) => s.id));
    expect("stochastic" in doc).toBe(false);
  });

  it("base entry: the curve equals the base curve nodes and the kind is copied", () => {
    const request = makeRunRequest(market);
    const doc = buildRateDocument(request, DET);
    const base = doc.scenarios.find((s) => s.rateSpecKind === "base")!;
    // The default curve's quote tenors and z read off it (was baseCurve.t and baseCurve.z, the kernel's 11 nodes).
    expect(base.curve.t).toEqual(quoteTenorsOf(baseCurve));
    expect(base.curve.t).toHaveLength(market.curveQuotes.length);
    expect(base.curve.z).toEqual(quoteNodesZ(baseCurve));
    expect(base.ratePathModel).toBe("deterministic");
    expect(doc.base.z).toEqual(quoteNodesZ(baseCurve));
  });

  it("parallel +200bp: every node's zero rate sits 0.02 above the base", () => {
    const request = makeRunRequest(market);
    const doc = buildRateDocument(request, DET);
    const up = request.scenarios.find((s) => s.rateSpec.kind === "parallel" && s.rateSpec.shockBp === 200);
    expect(up, "fixture carries a +200bp scenario").toBeDefined();
    const entry = doc.scenarios.find((s) => s.scenarioId === up!.id)!;
    expect(entry.rateSpecKind).toBe("parallel");
    expect(entry.curve.t.length).toBe(doc.base.t.length);
    for (let i = 0; i < entry.curve.t.length; i++) {
      expect(entry.curve.z[i] - doc.base.z[i]).toBeCloseTo(0.02, 12);
      expect(entry.curve.df[i]).toBeCloseTo(Math.exp(-entry.curve.z[i] * entry.curve.t[i]), 14);
    }
  });

  it("path identity: rate[k] is Object.is-equal to the static pass's own path at every step", () => {
    const request = makeRunRequest(market);
    const doc = buildRateDocument(request, DET);
    for (const scenario of request.scenarios) {
      const entry = doc.scenarios.find((s) => s.scenarioId === scenario.id)!;
      expect(entry.path, scenario.id).toBeDefined();
      const path = buildScenarioRatePath(baseCurve, scenario, HORIZON);
      expect(entry.path!.times.length).toBe(HORIZON + 1);
      expect(entry.path!.rate.length).toBe(HORIZON);
      expect(entry.path!.times).toEqual([...path.times]);
      for (let k = 0; k < HORIZON; k++) {
        expect(Object.is(entry.path!.rate[k], path.rateAt(k)), `${scenario.id} step ${k}`).toBe(true);
      }
      // And the curve the path was built on is the shocked curve, node for node.
      const shocked = shockedCurve(baseCurve, scenario.rateSpec);
      // The shocked curve's quote nodes, z read off it (was shocked.z, the kernel's 11 nodes).
      expect(entry.curve.z).toEqual(quoteNodesZ(shocked));
    }
  });

  it("a non-deterministic rate-path model gets its curve and an omission marker, never a path", () => {
    const [s0] = regulatoryScenarios();
    const plugin: Scenario = { ...s0, id: "S-HW", ratePathModel: "hw1f-demo" };
    const request = makeRunRequest(market, { scenarios: [s0, plugin] });
    const doc = buildRateDocument(request, DET);
    const entry = doc.scenarios.find((s) => s.scenarioId === "S-HW")!;
    expect(entry.ratePathModel).toBe("hw1f-demo");
    // The base curve's quote nodes, z read off it (was baseCurve.z, the kernel's 11 nodes).
    expect(entry.curve.z).toEqual(quoteNodesZ(baseCurve));
    expect("path" in entry).toBe(false);
    expect(entry.pathOmitted).toBe(
      'rate path model "hw1f-demo" is not the deterministic built-in; the rate document recomputes only the deterministic path',
    );
    const det = doc.scenarios.find((s) => s.scenarioId === s0.id)!;
    expect("pathOmitted" in det).toBe(false);
    expect(det.path).toBeDefined();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a horizon of %s with a typed error",
    (horizonMonths) => {
      const request = makeRunRequest(market, { grid: { horizonMonths, asOf: "2026-01-01" } });
      expect(() => buildRateDocument(request, DET)).toThrow(RateDocumentError);
      expect(() => buildRateDocument(request, DET)).toThrow(/horizonMonths/);
    },
  );

  it("is a pure function of its inputs: two builds serialize identically", () => {
    const request = makeRunRequest(market);
    expect(JSON.stringify(buildRateDocument(request, DET))).toBe(
      JSON.stringify(buildRateDocument(request, DET)),
    );
  });
});

/** A 4-path, 3-step simulation with hand-picked short rates. */
function handSim(): HWSimulationResult {
  const rPaths = [
    Float64Array.from([0.01, 0.02, 0.03]),
    Float64Array.from([0.02, 0.06, 0.01]),
    Float64Array.from([0.03, 0.01, 0.02]),
    Float64Array.from([0.04, 0.03, 0.04]),
  ];
  return {
    seed: 1n,
    a: 0.05,
    sigma: 0.01,
    nPaths: 4,
    horizonYears: 0.25,
    dtYears: 1 / 12,
    times: Float64Array.from([1 / 12, 2 / 12, 3 / 12]),
    XPaths: rPaths.map((r) => Float64Array.from(r)),
    rPaths,
    dfMarket: Float64Array.from([1, 1, 1]),
    dfSimulated: Float64Array.from([1, 1, 1]),
    rawErrorBps: Float64Array.from([0, 0, 0]),
    corrected: true,
  };
}

describe("buildStochasticRateFan", () => {
  it("pins mean and the five quantiles at every step against the hand formula", () => {
    const sim = handSim();
    const fan = buildStochasticRateFan("S0", sim);
    expect(fan.scenarioId).toBe("S0");
    expect(fan.nPaths).toBe(4);
    expect(fan.a).toBe(0.05);
    expect(fan.sigma).toBe(0.01);
    expect(fan.times).toEqual([1 / 12, 2 / 12, 3 / 12]);
    expect(fan.quantiles.map((q) => q.p)).toEqual([...STOCHASTIC_QUANTILES]);
    expect(fan.quantiles.length).toBe(5);

    // Column at each step, sorted by hand.
    const columns = [
      [0.01, 0.02, 0.03, 0.04], // step 0
      [0.01, 0.02, 0.03, 0.06], // step 1
      [0.01, 0.02, 0.03, 0.04], // step 2
    ];
    for (let k = 0; k < 3; k++) {
      const col = columns[k];
      const mean = col.reduce((a, b) => a + b, 0) / col.length;
      expect(fan.mean[k]).toBeCloseTo(mean, 14);
      for (const q of fan.quantiles) {
        expect(q.values.length).toBe(3);
        expect(q.values[k]).toBeCloseTo(handQuantile(col, q.p), 14);
      }
    }
    // Spot values, fully by hand: step 1, p95 at position 2.85 -> 0.03 + 0.85 * 0.03.
    expect(fan.quantiles[4].values[1]).toBeCloseTo(0.0555, 14);
    // Step 0, p5 at position 0.15 -> 0.01 + 0.15 * 0.01.
    expect(fan.quantiles[0].values[0]).toBeCloseTo(0.0115, 14);
    expect(fan.mean[1]).toBeCloseTo(0.03, 14);
  });

  it("refuses a simulation whose path count disagrees with its rows", () => {
    const sim = { ...handSim(), nPaths: 3 };
    expect(() => buildStochasticRateFan("S0", sim)).toThrow(RateDocumentError);
  });
});

describe("buildRateDocument, stochastic", () => {
  it("carries the fan for the named scenario beside the deterministic entries", () => {
    const request = makeRunRequest(market, { grid: { horizonMonths: 3, asOf: "2026-01-01" } });
    const doc = buildRateDocument(request, {
      runId: "RUN-RATES-S",
      mode: "stochastic",
      stochastic: { scenarioId: "S0", sim: handSim() },
    });
    expect(doc.mode).toBe("stochastic");
    expect(doc.stochastic?.scenarioId).toBe("S0");
    expect(doc.stochastic?.nPaths).toBe(4);
    expect(doc.scenarios.length).toBe(request.scenarios.length);
    expect(doc.scenarios[0].path?.rate.length).toBe(3);
  });

  it("refuses stochastic mode without a simulation", () => {
    const request = makeRunRequest(market);
    expect(() => buildRateDocument(request, { runId: "R", mode: "stochastic" })).toThrow(
      RateDocumentError,
    );
    expect(() => buildRateDocument(request, { runId: "R", mode: "stochastic" })).toThrow(
      /stochastic/,
    );
  });
});

// --- The client-rate arm, schema 1.1.0 ------------------

/** The fixture base set plus a flat-carry client-rate binding on the mortgage family. */
function withClientRate(totalSpreadBp: number, id = "AS-BASE"): AssumptionSet {
  const set = baseAssumptions(id);
  set.bindings.push({
    familyId: "MORTGAGE",
    overlay: { kind: "loan-client-rate", model: "flat-carry", totalSpreadBp } as never,
    modelVersion: "illustrative-flat-carry-1",
  });
  return set;
}

const requestWithClientRate = (bp = 250, overrides: Partial<RunRequest> = {}): RunRequest =>
  makeRunRequest(market, { assumptionSets: [withClientRate(bp)], ...overrides });

describe("rate document 1.1.0: the clientRates arm", () => {
  it("stamps the current schema, 1.2.0 since a later release slice two", () => {
    expect(RATE_DOCUMENT_SCHEMA_VERSION).toBe("1.2.0");
    expect(buildRateDocument(makeRunRequest(market), DET).schemaVersion).toBe("1.2.0");
  });

  it("the mortgage row at 250 bp carries tenor 10 and the market's own curve convention", () => {
    const doc = buildRateDocument(requestWithClientRate(), DET);
    const base = doc.scenarios.find((s) => s.rateSpecKind === "base")!;
    expect(base.clientRates?.length).toBe(1);
    const r = base.clientRates![0]!;
    expect(r.familyId).toBe("MORTGAGE");
    expect(r.assumptionSetId).toBe("AS-BASE");
    expect(r.model).toBe("flat-carry");
    expect(r.totalSpreadBp).toBe(250);
    expect(r.benchmarkTenorYears).toBe(10);
    expect(r.curveConvention).toBe(market.curveConvention);
    expect(r.benchmark.length).toBe(HORIZON);
    expect(r.clientRate.length).toBe(HORIZON);
  });

  it("clientRate[k] = path.forwardRateAt(k, 10) + 0.025 at k = 0, 11, 119 and H - 1, on every scenario", () => {
    const request = requestWithClientRate();
    const doc = buildRateDocument(request, DET);
    for (const scenario of request.scenarios) {
      const entry = doc.scenarios.find((s) => s.scenarioId === scenario.id)!;
      const r = entry.clientRates![0]!;
      const path = buildScenarioRatePath(baseCurve, scenario, HORIZON);
      for (const k of [0, 11, 119, HORIZON - 1]) {
        expect(
          Math.abs(r.clientRate[k]! - (path.forwardRateAt(k, 10) + 0.025)),
          `${scenario.id} k=${k}`,
        ).toBeLessThan(1e-12);
        expect(Math.abs(r.benchmark[k]! - path.forwardRateAt(k, 10))).toBeLessThan(1e-12);
        // Under spread equality the client rate IS the prepay's offered mortgage rate, never plus a second 250.
        expect(Math.abs(r.clientRate[k]! - (path.forwardRateAt(k, 10) + 0.05))).toBeGreaterThan(1e-3);
      }
    }
  });

  it("omits the key when no binding is a loan-client-rate", () => {
    const doc = buildRateDocument(makeRunRequest(market), DET);
    for (const s of doc.scenarios) expect("clientRates" in s).toBe(false);
  });

  it("a pathOmitted scenario carries no clientRates", () => {
    const [s0] = regulatoryScenarios();
    const plugin: Scenario = { ...s0!, id: "S-HW", ratePathModel: "hw1f-demo" };
    const doc = buildRateDocument(requestWithClientRate(250, { scenarios: [s0!, plugin] }), DET);
    const omitted = doc.scenarios.find((s) => s.scenarioId === "S-HW")!;
    expect("clientRates" in omitted).toBe(false);
    expect(omitted.pathOmitted).toBeDefined();
    expect(doc.scenarios.find((s) => s.scenarioId === s0!.id)!.clientRates?.length).toBe(1);
  });

  it("a scenario whose assumptionSetId is absent from the request builds with no throw and no clientRates", () => {
    const [s0] = regulatoryScenarios();
    const orphan: Scenario = { ...s0!, id: "S-ORPHAN", assumptionSetId: "NO-SUCH-SET" };
    const request = requestWithClientRate(250, { scenarios: [s0!, orphan] });
    let doc: ReturnType<typeof buildRateDocument> | undefined;
    expect(() => {
      doc = buildRateDocument(request, DET);
    }).not.toThrow();
    const entry = doc!.scenarios.find((s) => s.scenarioId === "S-ORPHAN")!;
    expect("clientRates" in entry).toBe(false);
    expect(entry.path).toBeDefined();
  });

  it("a stochastic document lands the arm on its deterministic scenarios", () => {
    const request = requestWithClientRate(250, { grid: { horizonMonths: 3, asOf: "2026-01-01" } });
    const doc = buildRateDocument(request, {
      runId: "RUN-RATES-S",
      mode: "stochastic",
      stochastic: { scenarioId: "S0", sim: handSim() },
    });
    expect(doc.stochastic).toBeDefined();
    expect(doc.scenarios[0]!.clientRates?.[0]?.clientRate.length).toBe(3);
  });

  it("emits one row per loan-client-rate binding, in binding order, with its selector as stored", () => {
    const set = withClientRate(250);
    set.bindings.push({
      familyId: "FIXED",
      overlay: { kind: "loan-client-rate", model: "flat-carry", totalSpreadBp: 90 } as never,
      modelVersion: "x",
      selector: { segment: ["retail"] },
    });
    const doc = buildRateDocument(makeRunRequest(market, { assumptionSets: [set] }), DET);
    const rows = doc.scenarios[0]!.clientRates!;
    expect(rows.map((r) => r.familyId)).toEqual(["MORTGAGE", "FIXED"]);
    expect("selector" in rows[0]!).toBe(false);
    expect(rows[1]!.selector).toEqual({ segment: ["retail"] });
    expect(rows[1]!.totalSpreadBp).toBe(90);
  });

  it("parity: the binding changes nothing in rates.json except the clientRates arm", () => {
    const without = buildRateDocument(makeRunRequest(market), DET);
    const withBinding = buildRateDocument(requestWithClientRate(), DET);
    const strip = (d: ReturnType<typeof buildRateDocument>) =>
      JSON.parse(
        JSON.stringify({
          ...d,
          scenarios: d.scenarios.map((s) => {
            const { clientRates: _drop, ...rest } = s;
            return rest;
          }),
        }),
      );
    expect(strip(withBinding)).toEqual(strip(without));
    expect(withBinding.scenarios.every((s) => s.clientRates !== undefined)).toBe(true);
  });
});
