/**
 * GET /api/runs/:id/stochastic/summary and its CSV twin: one stored
 * stochastic envelope read by the engine's summarizeStochastic, served as JSON
 * and as one long CSV table under the stochastic provenance header. The server
 * adds no number.
 *
 * Seeded proof on the public market pack, vanilla book, 64 paths, default seed
 * 20260331 (the setup). Every literal below was measured on the unmodified code in a probe and is never re-pinned. Expected strings are
 * restated here, never imported.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { seedStore } from "../../scripts/seed-store";
import type { RunStatus } from "../jobs/types";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";

const BASE_ID = "market-public-2026-03-31";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestPlatform;
let base: string; // stochastic, base market, 64 paths
let det: string; // deterministic, base market
const NOTDONE = "run-stosum-notdone";

// Slice two Task 5: the words of record (was "the at-the-money cap volatilities of the run's
// market snapshot"); computed on read, no stored byte moves.
const GATE_WITHIN =
  "Calibrated to the at-the-money column of the short-rate volatility surface of the run's market snapshot. The fit RMSE is within the acceptance gate, as the envelope records (calibration.rmseGateBreached false).";
const N1 =
  "A distribution here is a statistic of the Monte Carlo path set, never an EVE or an NII. Every statistic is read verbatim from the run's stored envelope, and portfolioId and marketId from its stored submission; none is derived.";
const NOTES = [
  N1,
  "The standard error is the standard error of the mean, computed by the engine over antithetic-pair averages (nPaths / 2 independent samples). The standard deviation is the per-path dispersion, not a standard error.",
  "Each quantile is the engine's interpolation between order statistics at the pinned p. Per-path values are not stored, so no other quantile is available.",
  "The distributions are for the base scenario only, the scenario the context names in scenarioId.",
];
const REASON =
  "stochastic distributions are computed for the base scenario only this window; shocked-scenario distributions await the shocked-NII convention migration and are refused, not approximated. NII horizon distributed: 12 months.";

const waitDone = async (runId: string): Promise<void> => {
  const done = await waitFor(
    async () => (await api<RunStatus>(t.base, "GET", `/api/runs/${runId}`)).body,
    (s) => s.state === "done" || s.state === "error",
    240_000,
  );
  expect(done.state, JSON.stringify(done.error ?? {})).toBe("done");
};
const summary = (id: string) => api<Json>(t.base, "GET", `/api/runs/${id}/stochastic/summary`);
const summaryCsv = (id: string) => api<Json>(t.base, "GET", `/api/runs/${id}/stochastic/summary.csv`);

beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
  const book = {
    portfolioId: "vanilla-book-v1",
    marketId: BASE_ID,
    scenarioSlateId: "regulatory-grid-vanilla",
    assumptionSetIds: ["vanilla-empty-v1"],
  };
  const s = await api<{ runId: string }>(t.base, "POST", "/api/runs", {
    ...book,
    mode: "stochastic",
    stochastic: { nPaths: 64 },
  });
  expect(s.status).toBe(202);
  base = s.body.runId;
  const d = await api<{ runId: string }>(t.base, "POST", "/api/runs", book);
  expect(d.status).toBe(202);
  det = d.body.runId;
  for (const id of [base, det]) await waitDone(id);

  // A stochastic request that never finished (status running).
  const store = t.platform.context.store;
  store.writeRunJson(NOTDONE, "request.json", store.readRunJson<unknown>(base, "request.json"));
  store.writeRunJson(NOTDONE, "status.json", {
    runId: NOTDONE,
    state: "running",
    submittedAt: "2026-10-08T00:00:00.000Z",
    platformRequestHash: "0".repeat(64),
    summary: {
      portfolioId: "vanilla-book-v1",
      marketId: BASE_ID,
      scenarioSlateId: "regulatory-grid-vanilla",
      scenarioCount: 1,
    },
  });
}, 480_000);
afterAll(() => t.close());

describe("S1: the JSON summary of the seeded run", () => {
  it("answers 200 with the context, both distributions, the gate, the notes and the tags", async () => {
    const r = await summary(base);
    expect(r.status).toBe(200);
    const b = r.body;
    expect(b.kind).toBe("stochastic-run-summary");
    expect(b.runId).toBe(base);
    expect(b.context).toEqual([
      { field: "runId", value: base },
      { field: "portfolioId", value: "vanilla-book-v1" },
      { field: "marketId", value: BASE_ID },
      // A fresh envelope is 0.3.0 (was 0.2.0).
      { field: "schemaVersion", value: "0.3.0" },
      { field: "model", value: "hull-white-1f" },
      { field: "scenarioId", value: "S0" },
      { field: "assumptionSetId", value: "vanilla-empty-v1" },
      { field: "seed", value: "20260331" },
      { field: "nPaths", value: 64 },
      { field: "horizonMonths", value: 360 },
      { field: "discountBasis", value: "all-in" },
      { field: "calibration.source", value: "cap-atm-calibration" },
      // On curve default 2 (was 0.010742488479087394); deltas Step 1
      { field: "calibration.a", value: 0.010724117190284644 },
      // On curve default 2 (was 0.0061184513287782325); deltas Step 1
      { field: "calibration.sigma", value: 0.006116484379837266 },
      // On curve default 2 (was 0.8924966761506506); deltas Step 1
      { field: "calibration.rmseBp", value: 0.9009946994701852 },
      { field: "calibration.rmseGateBp", value: 5 },
      { field: "calibration.rmseGateBreached", value: false },
      { field: "calibration.nQuotes", value: 15 },
      { field: "calibration.reason", value: null },
      // On curve default 2 (was 6.661338147750939e-12); deltas Step 1
      { field: "martingale.correctedMaxAbsErrBp", value: 8.881784197001252e-12 },
      // On curve default 2 (was -93.49323722360359); deltas Step 1
      { field: "martingale.rawTerminalErrBp", value: -93.95054809550469 },
      // On curve default 2 (was 0.004866139391810729); deltas Step 1
      { field: "martingale.terminalDfStandardError", value: 0.004894247127172986 },
      { field: "martingale.terminalYears", value: 30 },
    ]);
    expect(b.eveDistribution).toEqual({
      rows: [
        // On curve default 2 (was 121065587.85061447); deltas Step 1
        { stat: "mean", p: null, value: 120866072.26933384 },
        // On curve default 2 (was 61217.956059216536); deltas Step 1
        { stat: "standardError", p: null, value: 61115.42003776055 },
        // On curve default 2 (was 6855510.898898505); deltas Step 1
        { stat: "stdev", p: null, value: 6843610.473478725 },
        // On curve default 2 (was 106362170.76790941); deltas Step 1
        { stat: "min", p: null, value: 106189476.98167574 },
        // On curve default 2 (was 138144575.2127334); deltas Step 1
        { stat: "max", p: null, value: 137914055.93615484 },
        // On curve default 2 (was 110937500.82142822); deltas Step 1
        { stat: "quantile", p: 0.05, value: 110756108.08004901 },
        // On curve default 2 (was 116498840.81624052); deltas Step 1
        { stat: "quantile", p: 0.25, value: 116304543.48025593 },
        // On curve default 2 (was 120774862.14222014); deltas Step 1
        { stat: "quantile", p: 0.5, value: 120577338.82517791 },
        // On curve default 2 (was 125315557.07325122); deltas Step 1
        { stat: "quantile", p: 0.75, value: 125111419.441966 },
        // On curve default 2 (was 132050902.35729401); deltas Step 1
        { stat: "quantile", p: 0.95, value: 131831793.78860644 },
      ],
    });
    const flat = 11772965.658384606;
    expect(b.nii12mDistribution).toEqual({
      rows: [
        { stat: "mean", p: null, value: 11772965.6583846 },
        { stat: "standardError", p: null, value: 1.0036228337889995e-9 },
        { stat: "stdev", p: null, value: 5.632109537858176e-9 },
        { stat: "min", p: null, value: flat },
        { stat: "max", p: null, value: flat },
        { stat: "quantile", p: 0.05, value: flat },
        { stat: "quantile", p: 0.25, value: flat },
        { stat: "quantile", p: 0.5, value: flat },
        { stat: "quantile", p: 0.75, value: flat },
        { stat: "quantile", p: 0.95, value: flat },
      ],
    });
    expect(b.calibrationGate).toEqual({
      state: "within-gate",
      // On curve default 2 (was 0.8924966761506506); deltas Step 1
      rmseBp: 0.9009946994701852,
      rmseGateBp: 5,
      text: GATE_WITHIN,
    });
    expect(b.notes).toEqual(NOTES);
    expect(b.notImplemented).toEqual([
      { _tag: "not-implemented", layer: "stochastic.shocked-scenarios", reason: REASON },
    ]);
    // The envelope's calibration arm, verbatim and additive.
    expect(b.calibration).toEqual({
      source: "cap-atm-calibration",
      a: 0.010724117190284644,
      sigma: 0.006116484379837266,
      rmseBp: 0.9009946994701852,
      rmseGateBp: 5,
      rmseGateBreached: false,
      nQuotes: 15,
      underlyingTau: 0.25,
      iterations: 2000,
    });
  }, 60_000);
});

describe("S2: the CSV twin", () => {
  it("answers 200 with the provenance header, the gate, the notes and the rows", async () => {
    const r = await summaryCsv(base);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(r.headers.get("content-disposition")).toBe(`attachment; filename="${base}-stochastic.csv"`);
    const lines = r.text.split("\r\n");
    // The "# curve" provenance row is one more header line, so every index below it moves by
    // one (was 58 lines, lines[57], slice(0, 5)); deltas, header rows.
    // Slice two Task 5: one more header line for "# calibration.parameters" (decision 93), so every index below it
    // moves by one again (was 59 lines, lines[58]).
    expect(lines).toHaveLength(60);
    expect(lines[59]).toBe("");
    expect(lines.slice(0, 6)).toEqual([
      "# kind,stochastic-distribution",
      `# runId,${base}`,
      // The stochastic envelope is 0.2.0 since Task 6 (decision 62); S1 was bumped there, this header was not (was 0.1.0).
      // A fresh envelope is 0.3.0 (was 0.2.0).
      "# schemaVersion,0.3.0",
      "# inputsHash,not recorded: the stochastic envelope carries no inputsHash",
      // The run's curve line, restated: no curveSetup and no marker on the seeded public pack.
      '# curve,"platform default v2, log-linear on discount factor"',
      "# engineVersion,not recorded: the stochastic envelope carries no engineVersion",
    ]);
    // One row lower each for the "# curve" row (were lines[5], [6], [8] and [12]).
    expect(lines[6]).toMatch(/^# generatedAt,\d{4}-\d{2}-\d{2}T/);
    expect(lines[7]).toBe("# calibrationGate,within-gate");
    expect(lines[8]).toBe(`# calibrationGate.text,"${GATE_WITHIN}"`);
    // Slice two Task 5: the parameters row after the gate rows; one row lower each below it (were lines[9] and [13]).
    expect(lines[9]).toBe('# calibration.parameters,"a=0.010724117190284644, sigma=0.006116484379837266"');
    expect(lines[10]).toBe(`# note,"${N1}"`);
    expect(lines[14]).toBe("section,field,p,value");
    for (const line of [
      // On curve default 2 (was 0.0061184513287782325); deltas Step 1
      "context,calibration.sigma,,0.006116484379837266",
      "context,calibration.rmseGateBreached,,false",
      // On curve default 2 (was 6.661338147750939e-12); deltas Step 1
      "context,martingale.correctedMaxAbsErrBp,,8.881784197001252e-12",
      // On curve default 2 (was 121065587.85061447); deltas Step 1
      "eveDistribution,mean,,120866072.26933384",
      // On curve default 2 (was 132050902.35729401); deltas Step 1
      "eveDistribution,quantile,0.95,131831793.78860644",
      "nii12mDistribution,standardError,,1.0036228337889995e-9",
    ]) {
      expect(lines, line).toContain(line);
    }
    // One row lower for the "# curve" row (was lines[56]).
    // Slice two Task 5: one row lower for the parameters row (was lines[57]).
    expect(lines[58]).toBe(`notImplemented,stochastic.shocked-scenarios,,"${REASON}"`);
  }, 60_000);
});

describe("S3: refusals, on both routes", () => {
  const routes = [
    { get: summary, what: "stochastic summary" },
    { get: summaryCsv, what: "stochastic CSV" },
  ];

  it("an unknown run is 404", async () => {
    for (const { get } of routes) {
      const r = await get("ghost");
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("not-found");
      expect(r.body.error.message).toBe('run "ghost" not found');
    }
  });

  it("a deterministic run is 400 and points at its result and its table exports", async () => {
    for (const { get, what } of routes) {
      const r = await get(det);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("bad-request");
      expect(r.body.error.message).toBe(
        `run "${det}" is a deterministic run and has no stochastic envelope; its result is served at ` +
          `/api/runs/${det}/result and its tables export at /api/runs/${det}/export/<table>.csv. ` +
          `A ${what} exists only for a run submitted with mode: "stochastic".`,
      );
    }
  });

  it("a run that is not done is 409", async () => {
    for (const { get, what } of routes) {
      const r = await get(NOTDONE);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("conflict");
      expect(r.body.error.message).toBe(`run "${NOTDONE}" is running; a ${what} requires state "done"`);
    }
  });
});

describe("S4: the envelope route and the wording", () => {
  it("GET /api/runs/:id/stochastic still serves the stored envelope verbatim", async () => {
    const r = await api<Json>(t.base, "GET", `/api/runs/${base}/stochastic`);
    expect(r.status).toBe(200);
    expect(r.text).toBe(t.platform.context.store.readRunBytes(base, "result.json").toString("utf8"));
  });

  it("no body or message carries an em-dash or a section sign", async () => {
    for (const id of [base, det, NOTDONE, "ghost"]) {
      for (const r of [await summary(id), await summaryCsv(id)]) {
        expect(r.text).not.toContain("\u2014");
        expect(r.text).not.toContain("\u00a7");
      }
    }
  });
});
