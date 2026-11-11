/**
 * The stochastic CSVs: the stochastic provenance header,
 * renderStochasticSummaryCsv and renderStochasticCompareCsv. Every expected
 * line below is a literal restated by hand; only the renderers, the provenance
 * helpers and the engine's summarizeStochastic and compareStochastic (to build
 * the input) are imported.
 */
import { describe, expect, it } from "vitest";
import {
  compareStochastic,
  summarizeStochastic,
  type StochasticDistribution,
  type StochasticRunResult,
} from "@alm/engine";
import {
  renderStochasticCompareCsv,
  renderStochasticSummaryCsv,
  stochasticProvenanceOf,
  stochasticProvenanceRows,
} from "../stochasticCsv";

const P = [0.05, 0.25, 0.5, 0.75, 0.95];

function dist(
  nPaths: number,
  mean: number,
  se: number,
  stdev: number,
  min: number,
  max: number,
  qs: number[],
): StochasticDistribution {
  return {
    nPaths,
    mean,
    standardError: se,
    stdev,
    min,
    max,
    quantiles: qs.map((value, i) => ({ p: P[i]!, value })),
  };
}

function envelope(over: Partial<StochasticRunResult> = {}): StochasticRunResult {
  return {
    schemaVersion: "0.1.0",
    kind: "stochastic-distribution",
    model: "hull-white-1f",
    runId: "run-a",
    scenarioId: "base",
    assumptionSetId: "as-1",
    seed: "1",
    nPaths: 20,
    horizonMonths: 360,
    discountBasis: "all-in",
    calibration: {
      source: "cap-atm-calibration",
      a: 0.01,
      sigma: 0.006,
      rmseBp: 7.5,
      rmseGateBp: 5,
      rmseGateBreached: true,
      nQuotes: 12,
      underlyingTau: 0.25,
      iterations: 9,
    },
    martingale: {
      correctedMaxAbsErrBp: 0.001,
      rawTerminalErrBp: 2.5,
      terminalDfStandardError: 0.0004,
      terminalYears: 30,
    },
    eveDistribution: dist(20, 100, 3, 10, 70, 130, [80, 90, 100, 110, 120]),
    nii12mDistribution: dist(20, 10, 0, 0, 10, 10, [10, 10, 10, 10, 10]),
    notImplemented: [
      { _tag: "not-implemented", layer: "stochastic.shocked-scenarios", reason: "base only, by design" },
    ],
    ...over,
  } as StochasticRunResult;
}

const GEN = "2026-10-08T00:00:00.000Z";

/** The curve line a route reads for the run, restated by hand. */
const CURVE = { line: "Curve: platform default v2, log-linear on discount factor", value: "platform default v2, log-linear on discount factor", from: "stamp" } as const;
const CURVE_ROW = '# curve,"platform default v2, log-linear on discount factor"';

describe("renderStochasticSummaryCsv", () => {
  it("V1: writes the provenance header, gate, parameters, notes and 44 rows as one long table", () => {
    const e = envelope();
    const summary = summarizeStochastic({ envelope: e, portfolioId: "book-1", marketId: "mkt-1" });
    const csv = renderStochasticSummaryCsv(summary, stochasticProvenanceOf(e, CURVE), GEN);
    expect(csv.split("\r\n")).toEqual([
      "# kind,stochastic-distribution",
      "# runId,run-a",
      "# schemaVersion,0.1.0",
      "# inputsHash,not recorded: the stochastic envelope carries no inputsHash",
      CURVE_ROW,
      "# engineVersion,not recorded: the stochastic envelope carries no engineVersion",
      "# generatedAt,2026-10-08T00:00:00.000Z",
      "# calibrationGate,gate-breached",
      // Slice two Task 5: the gate text reads the words of record (was "the at-the-money cap volatilities"), and the
      // "# calibration.parameters" row follows the gate rows.
      "# calibrationGate.text,\"Calibrated to the at-the-money column of the short-rate volatility surface of the run's market snapshot. The fit RMSE exceeds the acceptance gate, as the envelope records (calibration.rmseGateBreached true). The breach is reported, never refused: the distributions rest on a fit outside the gate.\"",
      '# calibration.parameters,"a=0.01, sigma=0.006"',
      "# note,\"A distribution here is a statistic of the Monte Carlo path set, never an EVE or an NII. Every statistic is read verbatim from the run's stored envelope, and portfolioId and marketId from its stored submission; none is derived.\"",
      "# note,\"The standard error is the standard error of the mean, computed by the engine over antithetic-pair averages (nPaths / 2 independent samples). The standard deviation is the per-path dispersion, not a standard error.\"",
      "# note,\"Each quantile is the engine's interpolation between order statistics at the pinned p. Per-path values are not stored, so no other quantile is available.\"",
      "# note,\"The distributions are for the base scenario only, the scenario the context names in scenarioId.\"",
      "section,field,p,value",
      "context,runId,,run-a",
      "context,portfolioId,,book-1",
      "context,marketId,,mkt-1",
      "context,schemaVersion,,0.1.0",
      "context,model,,hull-white-1f",
      "context,scenarioId,,base",
      "context,assumptionSetId,,as-1",
      "context,seed,,1",
      "context,nPaths,,20",
      "context,horizonMonths,,360",
      "context,discountBasis,,all-in",
      "context,calibration.source,,cap-atm-calibration",
      "context,calibration.a,,0.01",
      "context,calibration.sigma,,0.006",
      "context,calibration.rmseBp,,7.5",
      "context,calibration.rmseGateBp,,5",
      "context,calibration.rmseGateBreached,,true",
      "context,calibration.nQuotes,,12",
      "context,calibration.reason,,",
      "context,martingale.correctedMaxAbsErrBp,,0.001",
      "context,martingale.rawTerminalErrBp,,2.5",
      "context,martingale.terminalDfStandardError,,0.0004",
      "context,martingale.terminalYears,,30",
      "eveDistribution,mean,,100",
      "eveDistribution,standardError,,3",
      "eveDistribution,stdev,,10",
      "eveDistribution,min,,70",
      "eveDistribution,max,,130",
      "eveDistribution,quantile,0.05,80",
      "eveDistribution,quantile,0.25,90",
      "eveDistribution,quantile,0.5,100",
      "eveDistribution,quantile,0.75,110",
      "eveDistribution,quantile,0.95,120",
      "nii12mDistribution,mean,,10",
      "nii12mDistribution,standardError,,0",
      "nii12mDistribution,stdev,,0",
      "nii12mDistribution,min,,10",
      "nii12mDistribution,max,,10",
      "nii12mDistribution,quantile,0.05,10",
      "nii12mDistribution,quantile,0.25,10",
      "nii12mDistribution,quantile,0.5,10",
      "nii12mDistribution,quantile,0.75,10",
      "nii12mDistribution,quantile,0.95,10",
      "notImplemented,stochastic.shocked-scenarios,,\"base only, by design\"",
      "",
    ]);
  });

  it("renders a full-precision value verbatim, never rounded", () => {
    const e = envelope({
      nii12mDistribution: dist(20, 10, 1.0036228337889995e-9, 0, 10, 10, [10, 10, 10, 10, 10]),
    });
    const csv = renderStochasticSummaryCsv(summarizeStochastic({ envelope: e }), stochasticProvenanceOf(e, CURVE), GEN);
    expect(csv.split("\r\n")).toContain("nii12mDistribution,standardError,,1.0036228337889995e-9");
  });
});

describe("renderStochasticSummaryCsv over a BGM envelope", () => {
  it("writes the BGM gate text and the six Rebonato values with displacement and CEV", () => {
    const e = envelope({
      schemaVersion: "0.3.0",
      model: "bgm-lmm-2f",
      calibration: {
        source: "long-yield-atm-calibration",
        a: 0.11,
        b: 0.22,
        c: 0.8,
        d: 0.05,
        beta: 0.1,
        volScalar: 1.25,
        displacement: 0.05,
        cevBeta: 0.5,
        rmseBp: 12.45,
        rmseGateBp: 10,
        rmseGateBreached: true,
        nQuotes: 28,
        subset: [{ expiryYears: 1, tenorYears: 5 }],
        iterations: 150,
      },
    });
    const lines = renderStochasticSummaryCsv(summarizeStochastic({ envelope: e }), stochasticProvenanceOf(e, CURVE), GEN).split("\r\n");
    expect(lines.slice(7, 10)).toEqual([
      "# calibrationGate,gate-breached",
      "# calibrationGate.text,\"Calibrated to the default subset of the long-yield volatility surface (28 points) of the run's market snapshot. The fit RMSE exceeds the acceptance gate, as the envelope records (calibration.rmseGateBreached true). The breach is reported, never refused: the distributions rest on a fit outside the gate.\"",
      '# calibration.parameters,"a=0.11, b=0.22, c=0.8, d=0.05, beta=0.1, volScalar=1.25, displacement=0.05, cevBeta=0.5"',
    ]);
    expect(lines).toContain("context,calibration.a,,");
    expect(lines).toContain("context,calibration.sigma,,");
    expect(lines).toContain("context,model,,bgm-lmm-2f");
  });
});

describe("stochasticProvenanceRows", () => {
  it("emits exactly the six rows, tagged", () => {
    expect(
      stochasticProvenanceRows(" [A]", { kind: "stochastic-distribution", runId: "r", schemaVersion: "0.1.0", curve: "setup Seed (seed)" }),
    ).toEqual([
      "# kind [A],stochastic-distribution",
      "# runId [A],r",
      "# schemaVersion [A],0.1.0",
      "# inputsHash [A],not recorded: the stochastic envelope carries no inputsHash",
      "# curve [A],setup Seed (seed)",
      "# engineVersion [A],not recorded: the stochastic envelope carries no engineVersion",
    ]);
  });
});

const NOTE_1 =
  "A distribution here is a statistic of the Monte Carlo path set, never an EVE or an NII. Every B - A is derived by the server from the two stored envelopes, displayed beside both originals.";
const NOTE_2 =
  "The B - A of a quantile is the difference of the two runs' quantiles. It is not a quantile of the path-by-path difference: per-path values are not stored, so no distribution of B - A exists and none is shown.";
const NOTE_3 =
  "The B - A of the standard deviation, the standard error, the minimum and the maximum is a difference of two estimates, each from its own path set; it carries sampling error of its own that the envelopes do not report.";
const TEXT_INDEPENDENT =
  "Standard-error figure for the B - A of the means, derived: sqrt(SE A^2 + SE B^2), from the two runs' reported standard errors. The runs use different seeds, so their path sets are treated as independent and the figure is the standard error of the difference. It is a precision figure, not a test.";
const TEXT_SAME_RUN =
  "Run A and run B are the same run, so every B - A is zero by construction and no standard-error figure applies.";

describe("renderStochasticCompareCsv", () => {
  const ea = envelope();
  const eb = envelope({
    runId: "run-b",
    seed: "2",
    eveDistribution: dist(20, 104, 4, 15, 60, 150, [78, 95, 101, 113, 127]),
  });

  it("V2: writes both provenance headers, the notes, the SE figures and 45 rows as one long table", () => {
    const reply = compareStochastic(
      { envelope: ea, portfolioId: "book-1", marketId: "mkt-1" },
      { envelope: eb, portfolioId: "book-1", marketId: "mkt-2" },
    );
    const csv = renderStochasticCompareCsv(reply, stochasticProvenanceOf(ea, CURVE), stochasticProvenanceOf(eb, CURVE), GEN);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(67);
    expect(lines).toEqual([
      "# kind [A],stochastic-distribution",
      "# runId [A],run-a",
      "# schemaVersion [A],0.1.0",
      "# inputsHash [A],not recorded: the stochastic envelope carries no inputsHash",
      '# curve [A],"platform default v2, log-linear on discount factor"',
      "# engineVersion [A],not recorded: the stochastic envelope carries no engineVersion",
      "# kind [B],stochastic-distribution",
      "# runId [B],run-b",
      "# schemaVersion [B],0.1.0",
      "# inputsHash [B],not recorded: the stochastic envelope carries no inputsHash",
      '# curve [B],"platform default v2, log-linear on discount factor"',
      "# engineVersion [B],not recorded: the stochastic envelope carries no engineVersion",
      "# generatedAt,2026-10-08T00:00:00.000Z",
      `# note,"${NOTE_1}"`,
      `# note,"${NOTE_2}"`,
      `# note,"${NOTE_3}"`,
      "# eveDistribution.meanDeltaStandardError.basis,independent-seeds",
      `# eveDistribution.meanDeltaStandardError.text,"${TEXT_INDEPENDENT}"`,
      "# nii12mDistribution.meanDeltaStandardError.basis,independent-seeds",
      `# nii12mDistribution.meanDeltaStandardError.text,"${TEXT_INDEPENDENT}"`,
      "section,field,p,value [A],value [B],value [derived: B - A],same [derived]",
      "context,runId,,run-a,run-b,,false",
      "context,portfolioId,,book-1,book-1,,true",
      "context,marketId,,mkt-1,mkt-2,,false",
      "context,schemaVersion,,0.1.0,0.1.0,,true",
      "context,model,,hull-white-1f,hull-white-1f,,true",
      "context,scenarioId,,base,base,,true",
      "context,assumptionSetId,,as-1,as-1,,true",
      "context,seed,,1,2,,false",
      "context,nPaths,,20,20,,true",
      "context,horizonMonths,,360,360,,true",
      "context,discountBasis,,all-in,all-in,,true",
      "context,calibration.source,,cap-atm-calibration,cap-atm-calibration,,true",
      "context,calibration.a,,0.01,0.01,,true",
      "context,calibration.sigma,,0.006,0.006,,true",
      "context,calibration.rmseBp,,7.5,7.5,,true",
      "context,calibration.rmseGateBp,,5,5,,true",
      "context,calibration.rmseGateBreached,,true,true,,true",
      "context,calibration.nQuotes,,12,12,,true",
      "context,calibration.reason,,,,,true",
      "context,martingale.correctedMaxAbsErrBp,,0.001,0.001,,true",
      "context,martingale.rawTerminalErrBp,,2.5,2.5,,true",
      "context,martingale.terminalDfStandardError,,0.0004,0.0004,,true",
      "context,martingale.terminalYears,,30,30,,true",
      "eveDistribution,mean,,100,104,4,",
      "eveDistribution,standardError,,3,4,1,",
      "eveDistribution,stdev,,10,15,5,",
      "eveDistribution,min,,70,60,-10,",
      "eveDistribution,max,,130,150,20,",
      "eveDistribution,quantile,0.05,80,78,-2,",
      "eveDistribution,quantile,0.25,90,95,5,",
      "eveDistribution,quantile,0.5,100,101,1,",
      "eveDistribution,quantile,0.75,110,113,3,",
      "eveDistribution,quantile,0.95,120,127,7,",
      "eveDistribution,meanDeltaStandardError,,,,5,",
      "nii12mDistribution,mean,,10,10,0,",
      "nii12mDistribution,standardError,,0,0,0,",
      "nii12mDistribution,stdev,,0,0,0,",
      "nii12mDistribution,min,,10,10,0,",
      "nii12mDistribution,max,,10,10,0,",
      "nii12mDistribution,quantile,0.05,10,10,0,",
      "nii12mDistribution,quantile,0.25,10,10,0,",
      "nii12mDistribution,quantile,0.5,10,10,0,",
      "nii12mDistribution,quantile,0.75,10,10,0,",
      "nii12mDistribution,quantile,0.95,10,10,0,",
      "nii12mDistribution,meanDeltaStandardError,,,,0,",
      "",
    ]);
  });

  it("V3: the same run gives basis same-run and a blank standard-error figure", () => {
    const reply = compareStochastic({ envelope: ea }, { envelope: ea });
    const prov = stochasticProvenanceOf(ea, CURVE);
    const lines = renderStochasticCompareCsv(reply, prov, prov, GEN).split("\r\n");
    expect(lines).toContain("# eveDistribution.meanDeltaStandardError.basis,same-run");
    expect(lines).toContain(`# eveDistribution.meanDeltaStandardError.text,"${TEXT_SAME_RUN}"`);
    expect(lines).toContain("eveDistribution,meanDeltaStandardError,,,,,");
    expect(lines).toContain("nii12mDistribution,meanDeltaStandardError,,,,,");
    expect(lines).toContain("# runId [B],run-a");
  });
});
