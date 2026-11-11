/**
 * The calibration panel's words and edits, and the attached stochastic run in the Analysis path and
 * the result picker (test (d), the Studio half). Every expected sentence is written out here.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SavedCalibration } from "@alm/engine";
import type { GuidedRunRow, RunSetup, WorkspaceRunRow } from "@alm/reader";
import { parameterLines, savedText, solverOf } from "../pages/analysis/CalibrationPanel";
import { splitRuns } from "../pages/analysis/AnalysisPage";
import { withCalibration, withSimulation } from "../guided/setup";
import { chooseResult, deterministicRows, pickerRuns } from "../pages/results/resultChoice";
import { newestDoneOf } from "../pages/workspace/ComparePage";
import { RunIndexView } from "../pages/results/ResultsPage";
import { ResultPicker } from "../pages/results/ResultPicker";

const fit = (over: Partial<SavedCalibration["fit"]>): SavedCalibration["fit"] => ({
  model: "bgm-lmm-2f", parameters: { model: "bgm-lmm-2f", a: 0.1, b: 0.2, c: 0.5, d: 0.8, beta: 0.08, volScalar: 0.3, displacement: 0.05, cevBeta: 0.5 },
  rmseBp: 12.4505, gateBp: 10, breached: true, iterations: 150, nQuotes: 28, solver: {}, quotes: [], curveDefault: "", curveFingerprint: "", ...over,
});
const doc = (f: SavedCalibration["fit"], acceptance: SavedCalibration["acceptance"]): SavedCalibration => ({ schemaVersion: "1.0.0", id: "cal-0123456789abcdef", label: "BGM fit", fit: f, pins: { marketId: "m", marketHash: "h", curveDefault: "", curveFingerprint: "" }, acceptance, createdBy: "t", createdAt: "2026-11-03T00:00:00Z" });

describe("the calibration panel's words", () => {
  it("says a fit outside its gate is outside it, with the reason it was saved with", () => {
    expect(savedText(doc(fit({}), { kind: "outside-gate", reason: "Teaching run." }))).toBe("BGM fit: BGM (LIBOR market model), two factor, 12.45 bp against a 10 bp gate, outside its gate. Saved with the reason: Teaching run.");
    const hw = fit({ model: "hull-white-1f", parameters: { model: "hull-white-1f", a: 0.0312, sigma: 0.0091 }, rmseBp: 0.8925, gateBp: 5, breached: false });
    expect(savedText({ ...doc(hw, { kind: "within-gate" }), label: "HW fit" })).toBe("HW fit: Hull-White one factor, 0.89 bp against a 5 bp gate, within its gate.");
    expect(parameterLines(hw.parameters)).toEqual([{ label: "Mean reversion a (per year)", value: "0.0312000" }, { label: "Volatility sigma (normal, per year)", value: "0.00910000" }]);
  });

  it("reads the BGM solver options, all four starting points or none", () => {
    expect(solverOf({ maxIterations: "", a: "", b: "", c: "", d: "" })).toEqual({ solver: {} });
    expect(solverOf({ maxIterations: "400", a: "0.6", b: "0.6", c: "0.65", d: "0.7" })).toEqual({ solver: { maxIterations: 400, aInit: 0.6, bInit: 0.6, cInit: 0.65, dInit: 0.7 } });
    expect(solverOf({ maxIterations: "0", a: "1", b: "", c: "", d: "" })).toEqual({ problems: ["Type the iteration cap as a whole number from 1 to 2000.", "Type all four starting points a, b, c and d as numbers, or leave all four blank."] });
  });
});

describe("the setup's saved fit", () => {
  const base = { eve: { stochastic: { nPaths: 64, seed: "7", model: "hull-white-1f" } } } as unknown as Omit<RunSetup, "id">;
  it("is set and cleared without touching paths, seed or model, and survives a Simulation save of the same model only", () => {
    const used = withCalibration(base, "cal-0123456789abcdef");
    expect(used.eve.stochastic).toEqual({ nPaths: 64, seed: "7", model: "hull-white-1f", calibrationId: "cal-0123456789abcdef" });
    expect(withCalibration(used, null).eve.stochastic).toEqual({ nPaths: 64, seed: "7", model: "hull-white-1f" });
    expect(withSimulation(used, { kind: "stochastic", model: "hull-white-1f", nPaths: 128, seed: "7" }).eve.stochastic?.calibrationId).toBe("cal-0123456789abcdef");
    expect(withSimulation(used, { kind: "stochastic", model: "bgm-lmm-2f", nPaths: 128, seed: "7" }).eve.stochastic).toEqual({ nPaths: 128, seed: "7", model: "bgm-lmm-2f" });
    expect(() => withCalibration({ eve: {} } as unknown as Omit<RunSetup, "id">, "x")).toThrow("Simulation step first");
  });
});

describe("an attached stochastic run in the Analysis path and the result picker", () => {
  const status = (submittedAt: string) => ({ state: "done" as const, submittedAt, summary: { portfolioId: "b", marketId: "m", scenarioSlateId: "s", scenarioCount: 1 } });
  const rows = [
    { runId: "run-det", attachedBy: "launch", at: "2026-11-03T10:00:00Z", setupLineageId: "setup-guided", launchNo: 1, pins: "consumed", status: status("2026-11-03T10:00:00Z"), basisLabel: "Flat" },
    { runId: "run-mc", attachedBy: "launch", at: "2026-11-03T11:00:00Z", setupLineageId: "setup-guided", launchNo: 2, pins: "consumed", mode: "stochastic", setupDocId: "rs-2", status: status("2026-11-03T11:00:00Z"), basisLabel: "Runoff" },
  ] as unknown as WorkspaceRunRow[];
  const legacy = [{ runId: "run-s2a", setupLineageId: "setup-guided", setupDocId: "rs-1", at: "2026-11-02T09:00:00Z", by: "t", status: { state: "done", submittedAt: "2026-11-02T09:00:00Z" } }] as GuidedRunRow[];

  it("keeps deterministic runs apart and lists the attached run beside the S2a link, newest first", () => {
    const split = splitRuns(rows, legacy);
    expect(split.runs.map((r) => r.runId)).toEqual(["run-det"]);
    expect(split.stochastic.map((r) => [r.runId, r.setupDocId])).toEqual([["run-mc", "rs-2"], ["run-s2a", "rs-1"]]);
    expect(splitRuns(rows, [...legacy, { ...legacy[0]!, runId: "run-mc" }]).stochastic.length).toBe(2);
  });

  it("the picker lists the attached run as stochastic, picks it on the Stochastic screen, and keeps deterministic tabs on deterministic runs", () => {
    const runs = pickerRuns(rows, {}, null);
    expect(runs.map((r) => [r.runId, r.stochastic])).toEqual([["run-mc", true], ["run-det", false]]);
    expect((chooseResult(runs, undefined, "stochastic") as { runId: string }).runId).toBe("run-mc");
    expect((chooseResult(runs, undefined, "deterministic") as { runId: string }).runId).toBe("run-det");
    const html = renderToStaticMarkup(<ResultPicker ws="ws" screen="stochastic" query={{}} runs={runs} choice={chooseResult(runs, undefined, "stochastic")} want="stochastic" />);
    expect(html).toContain("Stochastic</span>");
  });
});

describe("screens that read deterministic runs only (fix round M4)", () => {
  const status = (submittedAt: string) => ({ state: "done" as const, submittedAt, summary: { portfolioId: "b", marketId: "m", scenarioSlateId: "s", scenarioCount: 1 } });
  const rows = [
    { runId: "run-mc", attachedBy: "launch", at: "2026-11-03T11:00:00Z", pins: "consumed", mode: "stochastic", status: status("2026-11-03T11:00:00Z"), basisLabel: "Runoff" },
    { runId: "run-det", attachedBy: "launch", at: "2026-11-03T10:00:00Z", pins: "consumed", status: status("2026-11-03T10:00:00Z"), basisLabel: "Flat" },
  ] as unknown as WorkspaceRunRow[];
  it("Govern's plan card and Workspace Compare read the newest deterministic run, never the newer stochastic one", () => {
    expect(deterministicRows(rows).map((r) => r.runId)).toEqual(["run-det"]);
    expect(pickerRuns(deterministicRows(rows), {}, null)[0]!.runId).toBe("run-det");
    expect(newestDoneOf(rows)).toBe("run-det");
    expect(newestDoneOf([rows[0]!])).toBeNull();
  });
  it("the Advanced Results index opens a stochastic run on the Stochastic distributions screen (L4)", () => {
    const html = renderToStaticMarkup(<RunIndexView ws="ws" query={{}} rows={[{ runId: "run-mc", state: "done", planId: null, label: null, submittedAt: "2026-11-03", bookId: null, stochastic: true }]} />);
    expect(html).toContain("results/stochastic");
    expect(html).toContain(">stochastic<");
  });
});

