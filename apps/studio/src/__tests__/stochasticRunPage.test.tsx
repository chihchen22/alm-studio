/**
 * Stochastic distributions layer: one stochastic run's stored envelope, read through
 * GET /api/runs/:id/stochastic/summary and displayed as the reply carries it. Every expected value here is restated
 * by hand; nothing is imported from the code under test as an expectation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { summarizeStochastic, type StochasticRunResult } from "@alm/engine";
import type { RunSummary, StochasticSummaryReply } from "@alm/reader";
import { statLabel } from "../compare/compareModel";
import { calibrationEntries, gateChip, gateLine, modelText, stochasticHref, stochasticRunRows, statText } from "../results/stochasticRun";
import { loadStochastic } from "../pages/results/loadStochastic";
import {
  StochasticCalibrationCard,
  StochasticGateCard,
  StochasticNotBuilt,
  StochasticRunBody,
  StochasticRunContextCard,
  StochasticRunIndexView,
  StochasticRunNotes,
  StochasticRunTable,
} from "../pages/results/StochasticRunViews";
import { mockFetch } from "./fixtures/run";

afterEach(() => vi.unstubAllGlobals());

const BANNED_CHARS = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0xa7)}]`);

// The server's gate texts as slice two words them, restated by hand; Studio prints them verbatim.
const GATE_WITHIN =
  "Calibrated to the at-the-money column of the short-rate volatility surface of the run's market snapshot. The fit RMSE is within the acceptance gate, as the envelope records (calibration.rmseGateBreached false).";
const GATE_BREACHED =
  "Calibrated to the at-the-money column of the short-rate volatility surface of the run's market snapshot. The fit RMSE exceeds the acceptance gate, as the envelope records (calibration.rmseGateBreached true). The breach is reported, never refused: the distributions rest on a fit outside the gate.";
const GATE_NONE =
  "The Hull-White parameters were supplied by the caller (calibration.source override), not calibrated to the market snapshot, so no fit RMSE exists and no gate applies. The caller's reason is in calibration.reason.";
const GATE_BGM_BREACHED =
  "Calibrated to the default subset of the long-yield volatility surface (28 points) of the run's market snapshot. The fit RMSE exceeds the acceptance gate, as the envelope records (calibration.rmseGateBreached true). The breach is reported, never refused: the distributions rest on a fit outside the gate.";
const GATE_BGM_NONE =
  "The BGM parameters were supplied by the caller (calibration.source override), not calibrated to the market snapshot, so no fit RMSE exists and no gate applies. The caller's reason is in calibration.reason.";

const NOTES = [
  "A distribution here is a statistic of the Monte Carlo path set, never an EVE or an NII. Every statistic is read verbatim from the run's stored envelope, and portfolioId and marketId from its stored submission; none is derived.",
  "The standard error is the standard error of the mean, computed by the engine over antithetic-pair averages (nPaths / 2 independent samples). The standard deviation is the per-path dispersion, not a standard error.",
  "Each quantile is the engine's interpolation between order statistics at the pinned p. Per-path values are not stored, so no other quantile is available.",
  "The distributions are for the base scenario only, the scenario the context names in scenarioId.",
];

const DET_NOTE =
  "This is a deterministic run. A stochastic distribution exists only for a run submitted in stochastic mode; this run's results are on the measure layers.";

type Row = StochasticSummaryReply["eveDistribution"]["rows"][number];
const r = (stat: Row["stat"], p: number | null, value: number): Row => ({ stat, p, value });

/** Engine vector V1, the summary of envelope A, written out by hand, with one stored refusal tag. */
const REPLY: StochasticSummaryReply = {
  kind: "stochastic-run-summary",
  runId: "run-a",
  context: [
    { field: "runId", value: "run-a" },
    { field: "portfolioId", value: "book-1" },
    { field: "marketId", value: "mkt-1" },
    { field: "schemaVersion", value: "0.1.0" },
    { field: "model", value: "hull-white-1f" },
    { field: "scenarioId", value: "base" },
    { field: "assumptionSetId", value: "as-1" },
    { field: "seed", value: "1" },
    { field: "nPaths", value: 20 },
    { field: "horizonMonths", value: 360 },
    { field: "discountBasis", value: "all-in" },
    { field: "calibration.source", value: "cap-atm-calibration" },
    { field: "calibration.a", value: 0.01 },
    { field: "calibration.sigma", value: 0.006 },
    { field: "calibration.rmseBp", value: 7.5 },
    { field: "calibration.rmseGateBp", value: 5 },
    { field: "calibration.rmseGateBreached", value: true },
    { field: "calibration.nQuotes", value: 12 },
    { field: "calibration.reason", value: null },
    { field: "martingale.correctedMaxAbsErrBp", value: 0.001 },
    { field: "martingale.rawTerminalErrBp", value: 2.5 },
    { field: "martingale.terminalDfStandardError", value: 0.0004 },
    { field: "martingale.terminalYears", value: 30 },
  ],
  calibrationGate: { state: "gate-breached", rmseBp: 7.5, rmseGateBp: 5, text: GATE_BREACHED },
  eveDistribution: {
    rows: [
      r("mean", null, 100),
      r("standardError", null, 3),
      r("stdev", null, 10),
      r("min", null, 70),
      r("max", null, 130),
      r("quantile", 0.05, 80),
      r("quantile", 0.25, 90),
      r("quantile", 0.5, 100),
      r("quantile", 0.75, 110),
      r("quantile", 0.95, 120),
    ],
  },
  nii12mDistribution: {
    rows: [
      r("mean", null, 10),
      r("standardError", null, 0),
      r("stdev", null, 0),
      r("min", null, 10),
      r("max", null, 10),
      r("quantile", 0.05, 10),
      r("quantile", 0.25, 10),
      r("quantile", 0.5, 10),
      r("quantile", 0.75, 10),
      r("quantile", 0.95, 10),
    ],
  },
  notImplemented: [{ _tag: "not-implemented", layer: "stochastic.shocked-scenarios", reason: "base only, by design" }],
  notes: NOTES,
  // Slice two Task 5: the summary's additive calibration field, the arm verbatim.
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
};

const esc = (s: string) => s.replace(/'/g, "&#x27;");

const detail = (over: Record<string, unknown> = {}) => ({
  runId: "run-a",
  state: "done",
  submittedAt: "2026-09-25T10:00:00Z",
  platformRequestHash: "prh-run-a",
  mode: "stochastic",
  scenarios: [],
  ...over,
});

describe("Stochastic distributions: the distribution table", () => {
  it("prints each statistic with its 6-decimal value and the full value in the title", () => {
    const html = renderToStaticMarkup(<StochasticRunTable title="EVE distribution" rows={REPLY.eveDistribution.rows} />);
    expect(html).toContain('<th scope="row">Mean</th><td class="num" title="100">100</td>');
    expect(html).toContain('<th scope="row">Quantile at 0.05</th><td class="num" title="80">80</td>');
    expect(html).toContain(">Statistic</th>");
    expect(html).toContain(">Value</th>");
    expect(html).toContain('aria-label="EVE distribution"');
  });
  it("a long value prints 1,234,567.123457 and keeps 1234567.123456789 in its title", () => {
    const html = renderToStaticMarkup(<StochasticRunTable title="EVE distribution" rows={[r("mean", null, 1234567.123456789)]} />);
    expect(html).toContain('<td class="num" title="1234567.123456789">1,234,567.123457</td>');
  });
});

describe("Stochastic distributions: the context card", () => {
  it("prints the 23 stored fields as mono row headers, null as none and a boolean as text", () => {
    const html = renderToStaticMarkup(<StochasticRunContextCard context={REPLY.context} />);
    expect(html).toContain('aria-label="Run context"');
    expect(html.split('<th scope="row" class="mono">').length - 1).toBe(23);
    expect(html).toContain('<th scope="row" class="mono">calibration.reason</th><td class="mono">none</td>');
    expect(html).toContain('<th scope="row" class="mono">calibration.rmseGateBreached</th><td class="mono">true</td>');
  });
});

describe("Stochastic distributions: the calibration gate", () => {
  it("a breached gate prints its chip, the stored RMSE against the stored gate and the engine text", () => {
    const html = renderToStaticMarkup(<StochasticGateCard gate={REPLY.calibrationGate} />);
    expect(html).toContain('<span class="status status-breach">Gate breached</span> Fit RMSE 7.5 bp against the 5 bp gate.');
    expect(html).toContain(esc(GATE_BREACHED));
    expect(html).toContain('aria-label="Calibration gate"');
  });
  it("a gate held prints the pass chip", () => {
    const html = renderToStaticMarkup(<StochasticGateCard gate={{ state: "within-gate", rmseBp: 0.9, rmseGateBp: 5, text: GATE_WITHIN }} />);
    expect(html).toContain("status status-pass");
    expect(html).toContain("Within the gate");
    expect(html).toContain("Fit RMSE 0.9 bp against the 5 bp gate.");
  });
  it("an override prints no gate", () => {
    const html = renderToStaticMarkup(<StochasticGateCard gate={{ state: "no-gate", rmseBp: null, rmseGateBp: null, text: GATE_NONE }} />);
    expect(html).toContain('<span class="status status-unobs">No gate</span> Parameters supplied by override, not calibrated.');
    expect(html).toContain(esc(GATE_NONE));
  });
  it("gateLine and gateChip, all three states", () => {
    expect(gateLine({ state: "gate-breached", rmseBp: 7.5, rmseGateBp: 5, text: GATE_BREACHED })).toBe("Fit RMSE 7.5 bp against the 5 bp gate.");
    expect(gateLine({ state: "within-gate", rmseBp: 0.9, rmseGateBp: 5, text: GATE_WITHIN })).toBe("Fit RMSE 0.9 bp against the 5 bp gate.");
    expect(gateLine({ state: "no-gate", rmseBp: null, rmseGateBp: null, text: GATE_NONE })).toBe("Parameters supplied by override, not calibrated.");
    expect(gateChip("within-gate")).toEqual({ className: "status status-pass", text: "Within the gate" });
    expect(gateChip("gate-breached")).toEqual({ className: "status status-breach", text: "Gate breached" });
    expect(gateChip("no-gate")).toEqual({ className: "status status-unobs", text: "No gate" });
  });
  it("statText formats to 6 decimals and prints null as none; statLabel still prints a quantile's p", () => {
    expect(statText(0.0004)).toBe("0.0004");
    expect(statText(1234567.123456789)).toBe("1,234,567.123457");
    expect(statText(null)).toBe("none");
    expect(statLabel({ stat: "quantile", p: 0.25 })).toBe("Quantile at 0.25");
  });
});

/** The four calibration arms a summary's `calibration` field can carry, written out by hand. */
const HW_CAL: StochasticSummaryReply["calibration"] = REPLY.calibration;
const HW_OVERRIDE: StochasticSummaryReply["calibration"] = { source: "override", a: 0.03, sigma: 0.01, reason: "stress lever" };
const BGM_CAL: StochasticSummaryReply["calibration"] = {
  source: "long-yield-atm-calibration",
  a: 0.11, b: 0.22, c: 0.33, d: 0.044, beta: 0.15, volScalar: 1,
  displacement: 0.05, cevBeta: 0.5,
  rmseBp: 12.45, rmseGateBp: 10, rmseGateBreached: true, nQuotes: 28,
  subset: [{ expiryYears: 1, tenorYears: 1 }, { expiryYears: 5, tenorYears: 10 }],
  iterations: 150,
};
const BGM_OVERRIDE: StochasticSummaryReply["calibration"] = {
  source: "override", model: "bgm-lmm-2f", a: 0, b: 0, c: 1, d: 0, beta: 0, volScalar: 0, reason: "zero-vol probe",
};

/** A BGM reply: the HW reply with the model row, the calibration rows, the gate and the calibration field of a BGM run. */
const BGM_REPLY: StochasticSummaryReply = {
  ...REPLY,
  runId: "run-g",
  context: REPLY.context.map((c) => {
    if (c.field === "runId") return { ...c, value: "run-g" };
    if (c.field === "model") return { ...c, value: "bgm-lmm-2f" };
    if (c.field === "calibration.source") return { ...c, value: "long-yield-atm-calibration" };
    if (c.field === "calibration.a" || c.field === "calibration.sigma") return { ...c, value: null };
    if (c.field === "calibration.rmseBp") return { ...c, value: 12.45 };
    if (c.field === "calibration.rmseGateBp") return { ...c, value: 10 };
    if (c.field === "calibration.nQuotes") return { ...c, value: 28 };
    return c;
  }),
  calibrationGate: { state: "gate-breached", rmseBp: 12.45, rmseGateBp: 10, text: GATE_BGM_BREACHED },
  calibration: BGM_CAL,
};

const row = (k: string, v: string) => `<th scope="row" class="mono">${k}</th><td class="mono">${v}</td>`;

describe("Stochastic distributions: the rate model in the header", () => {
  it("names each model with its id; an unknown id prints as itself and a missing row says not recorded", () => {
    expect(modelText("hull-white-1f")).toBe("Hull-White 1F");
    expect(modelText("bgm-lmm-2f")).toBe("BGM, the shifted-CEV LIBOR market model with Rebonato two-factor volatility");
    expect(modelText("x-model")).toBe("x-model");
    expect(modelText(null)).toBe("not recorded");
  });
  it("the head card prints the model the context row stores", () => {
    const hw = renderToStaticMarkup(<StochasticRunBody runId="run-a" data={{ detail: detail() as never, summary: REPLY, note: null }} />);
    expect(hw).toContain('Rate model: Hull-White 1F <span class="mono">hull-white-1f</span>');
    const bgm = renderToStaticMarkup(<StochasticRunBody runId="run-g" data={{ detail: detail({ runId: "run-g" }) as never, summary: BGM_REPLY, note: null }} />);
    expect(bgm).toContain('Rate model: BGM, the shifted-CEV LIBOR market model with Rebonato two-factor volatility <span class="mono">bgm-lmm-2f</span>');
    expect(bgm.indexOf("Rate model:")).toBeLessThan(bgm.indexOf('aria-label="Calibration gate"'));
  });
});

describe("Stochastic distributions: the calibration card", () => {
  it("calibrationEntries reads the arm's scalar keys in its own order, at full precision, and leaves the subset out", () => {
    expect(calibrationEntries(HW_CAL)).toEqual([
      { key: "source", value: "cap-atm-calibration" },
      { key: "a", value: "0.01" },
      { key: "sigma", value: "0.006" },
      { key: "rmseBp", value: "7.5" },
      { key: "rmseGateBp", value: "5" },
      { key: "rmseGateBreached", value: "true" },
      { key: "nQuotes", value: "12" },
      { key: "underlyingTau", value: "0.25" },
      { key: "iterations", value: "9" },
    ]);
    expect(calibrationEntries(BGM_CAL).map((e) => e.key)).toEqual([
      "source", "a", "b", "c", "d", "beta", "volScalar", "displacement", "cevBeta", "rmseBp", "rmseGateBp", "rmseGateBreached", "nQuotes", "iterations",
    ]);
  });
  it("Hull-White calibrated: a and sigma with the fit diagnostics", () => {
    const html = renderToStaticMarkup(<StochasticCalibrationCard calibration={HW_CAL} />);
    expect(html).toContain('aria-label="Calibration"');
    expect(html).toContain('<div class="card-title">Calibration</div>');
    expect(html).toContain("Hull-White 1F, calibrated to the at-the-money column of the short-rate volatility surface: a is the mean-reversion speed per year and sigma the instantaneous normal volatility.");
    expect(html).toContain(row("a", "0.01"));
    expect(html).toContain(row("sigma", "0.006"));
    expect(html).toContain(row("underlyingTau", "0.25"));
    expect(html).toContain(row("iterations", "9"));
    expect(html).not.toContain("Subset");
  });
  it("Hull-White override: a, sigma and the caller's reason", () => {
    const html = renderToStaticMarkup(<StochasticCalibrationCard calibration={HW_OVERRIDE} />);
    expect(html).toContain("Hull-White 1F, parameters supplied by the caller, not calibrated: a is the mean-reversion speed per year and sigma the instantaneous normal volatility.");
    expect(html).toContain(row("source", "override"));
    expect(html).toContain(row("a", "0.03"));
    expect(html).toContain(row("reason", "stress lever"));
  });
  it("BGM calibrated: the six Rebonato values, displacement and CEV, the diagnostics and the subset", () => {
    const html = renderToStaticMarkup(<StochasticCalibrationCard calibration={BGM_CAL} />);
    expect(html).toContain("BGM, calibrated to the default subset of the long-yield volatility surface: a, b, c and d shape the Rebonato volatility, volScalar scales it and beta sets the correlation between forwards; the displacement and the CEV exponent (cevBeta) of the shifted-CEV forward are held fixed at the default engine.");
    for (const [k, v] of [["a", "0.11"], ["b", "0.22"], ["c", "0.33"], ["d", "0.044"], ["beta", "0.15"], ["volScalar", "1"], ["displacement", "0.05"], ["cevBeta", "0.5"], ["rmseBp", "12.45"], ["rmseGateBp", "10"], ["rmseGateBreached", "true"], ["nQuotes", "28"], ["iterations", "150"]]) {
      expect(html).toContain(row(k!, v!));
    }
    expect(html).toContain("Subset the fit used (expiry x tenor, years): 1x1, 5x10");
  });
  it("BGM override: the six values, the model key and the reason; displacement and CEV are not overridable", () => {
    const html = renderToStaticMarkup(<StochasticCalibrationCard calibration={BGM_OVERRIDE} />);
    expect(html).toContain("BGM, parameters supplied by the caller, not calibrated: the six Rebonato values as supplied; the displacement and the CEV exponent are not overridable and stay at the default engine.");
    expect(html).toContain(row("model", "bgm-lmm-2f"));
    expect(html).toContain(row("volScalar", "0"));
    expect(html).toContain(row("reason", "zero-vol probe"));
    expect(html).not.toContain(">displacement<");
  });
  it("a reply with no calibration field (a server before slice two) renders the page without the card", () => {
    const { calibration: _drop, ...old } = REPLY;
    const html = renderToStaticMarkup(<StochasticRunBody runId="run-a" data={{ detail: detail() as never, summary: old as StochasticSummaryReply, note: null }} />);
    expect(html).toContain('aria-label="Calibration gate"');
    expect(html).not.toContain('aria-label="Calibration"');
  });
  it("the BGM gate card prints the server's text verbatim, override included", () => {
    const html = renderToStaticMarkup(<StochasticGateCard gate={BGM_REPLY.calibrationGate} />);
    expect(html).toContain('<span class="status status-breach">Gate breached</span> Fit RMSE 12.45 bp against the 10 bp gate.');
    expect(html).toContain(esc(GATE_BGM_BREACHED));
    const none = renderToStaticMarkup(<StochasticGateCard gate={{ state: "no-gate", rmseBp: null, rmseGateBp: null, text: GATE_BGM_NONE }} />);
    expect(none).toContain(esc(GATE_BGM_NONE));
  });
  it("no new or reworded copy on the page says cap or swaption quotes or vols", () => {
    for (const cal of [HW_CAL, HW_OVERRIDE, BGM_CAL, BGM_OVERRIDE]) {
      const html = renderToStaticMarkup(<StochasticCalibrationCard calibration={cal} />);
      expect(html).not.toMatch(/cap (normal )?vol|cap quote|cap surface|swaption (quote|normal|grid|atm)/i);
      expect(BANNED_CHARS.test(html)).toBe(false);
    }
  });
});

describe("Stochastic distributions: a stored 0.2.0 envelope (the committed Hull-White golden)", () => {
  // The envelope source is the golden generated on main before slice two (schema 0.2.0); the summary is the engine's
  // own reader of it, the reply the server's route returns for a stored 0.2.0 run today. Expectations are restated by hand.
  const golden = JSON.parse(
    readFileSync(new URL("../../../../packages/engine/src/run/__tests__/golden/stochastic-hw-vanilla-64.json", import.meta.url), "utf8"),
  ) as StochasticRunResult;
  const reply = summarizeStochastic({ envelope: golden, portfolioId: "vanilla-book-v1", marketId: "market-public" });
  const html = renderToStaticMarkup(
    <StochasticRunBody runId={golden.runId} data={{ detail: detail({ runId: golden.runId }) as never, summary: reply, note: null }} />,
  );
  it("is a stored 0.2.0 Hull-White envelope", () => {
    expect(golden.schemaVersion).toBe("0.2.0");
    expect(html).toContain(row("schemaVersion", "0.2.0"));
    expect(html).toContain('Rate model: Hull-White 1F <span class="mono">hull-white-1f</span>');
  });
  it("prints the gate the server words now, verbatim, with the stored RMSE against the stored gate", () => {
    expect(html).toContain('<span class="status status-pass">Within the gate</span> Fit RMSE 0.900995 bp against the 5 bp gate.');
    expect(html).toContain(esc(GATE_WITHIN));
  });
  it("prints the stored calibration arm at full precision", () => {
    expect(html).toContain(row("a", "0.010724117190284644"));
    expect(html).toContain(row("sigma", "0.006116484379837266"));
    expect(html).toContain(row("rmseBp", "0.9009946994701852"));
    expect(html).toContain(row("nQuotes", "15"));
    expect(html).toContain(row("iterations", "2000"));
  });
  it("prints the stored mean EVE and carries no old surface naming", () => {
    expect(html).toContain('<th scope="row">Mean</th><td class="num" title="120866072.26933393">120,866,072.269334</td>');
    expect(html).not.toMatch(/cap (normal )?vol|cap quote|cap surface|swaption (quote|normal|grid|atm)/i);
  });
});

describe("Stochastic distributions: not built and notes", () => {
  it("lists each stored refusal tag", () => {
    const html = renderToStaticMarkup(<StochasticNotBuilt tags={REPLY.notImplemented} />);
    expect(html).toContain('aria-label="Not built in this mode"');
    expect(html).toContain('class="card plan-notes"');
    expect(html).toContain('<span class="mono">stochastic.shocked-scenarios</span> base only, by design');
    expect(html).toContain("○ Not implemented");
  });
  it("a flat-basis note reads Informational, not Not implemented (Studio Part 2 D16)", () => {
    const tags = [{ _tag: "not-implemented", layer: "plan.balance-basis.skipped", reason: "flat basis skipped 2 families: swaps, fees" }] as typeof REPLY.notImplemented;
    const html = renderToStaticMarkup(<StochasticNotBuilt tags={tags} />);
    expect(html.split("○ Informational").length - 1).toBe(1);
    expect(html.split("○ Not implemented").length - 1).toBe(0);
  });
  it("a derived curve note reads Informational, not Not implemented (Piece B, step B2)", () => {
    const tags = [{ _tag: "not-implemented", layer: "plan.derived-curve.index-only", reason: "derived curve X (x) adds a constant spread to index resets only (i); mortgages, client rates, new business and discounting read the base curve" }] as typeof REPLY.notImplemented;
    const html = renderToStaticMarkup(<StochasticNotBuilt tags={tags} />);
    expect(html.split("○ Informational").length - 1).toBe(1);
    expect(html.split("○ Not implemented").length - 1).toBe(0);
  });
  it("an empty list says so", () => {
    const html = renderToStaticMarkup(<StochasticNotBuilt tags={[]} />);
    expect(html).toContain("None: the envelope lists no refusal.");
  });
  it("prints all four notes", () => {
    const html = renderToStaticMarkup(<StochasticRunNotes notes={REPLY.notes} />);
    expect(html).toContain('aria-label="How to read these statistics"');
    for (const n of NOTES) expect(html).toContain(esc(n));
    expect(html).toContain("portfolioId and marketId from its stored submission");
  });
});

describe("Stochastic distributions: the body", () => {
  const html = renderToStaticMarkup(<StochasticRunBody runId="run-a" data={{ detail: detail() as never, summary: REPLY, note: null }} />);
  it("heads the page with the run, the CSV link and the source", () => {
    expect(html).toContain("Stochastic distributions: run");
    expect(html).toContain('<span class="mono">run-a</span>');
    expect(html).toContain('href="/api/runs/run-a/stochastic/summary.csv"');
    expect(html).toContain(">Download CSV</a>");
    expect(html).toContain(
      "Source: GET /api/runs/run-a/stochastic/summary (the run&#x27;s stored envelope, read by the server; every value verbatim, none derived)",
    );
  });
  it("orders the cards: head, gate, calibration, EVE, NII, source, context, not built, notes", () => {
    const marks = [
      'aria-label="Stochastic run"',
      'aria-label="Calibration gate"',
      'aria-label="Calibration"',
      'aria-label="EVE distribution"',
      'aria-label="NII 12m distribution"',
      "Source: GET /api/runs/run-a/stochastic/summary",
      'aria-label="Run context"',
      'aria-label="Not built in this mode"',
      'aria-label="How to read these statistics"',
    ];
    const at = marks.map((m) => html.indexOf(m));
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
  });
  it("never claims a test or a significance, and carries no banned character", () => {
    expect(html).not.toContain("significan");
    expect(html).not.toContain("p-value");
    expect(BANNED_CHARS.test(html)).toBe(false);
  });
  it("with no summary it prints the No result card and its note, and no table", () => {
    const none = renderToStaticMarkup(<StochasticRunBody runId="run-d" data={{ detail: detail({ runId: "run-d", mode: "deterministic" }) as never, summary: null, note: DET_NOTE }} />);
    expect(none).toContain('<span class="status status-unobs">No result</span>');
    expect(none).toContain(esc(DET_NOTE));
    expect(none).not.toContain("<table");
  });
});

describe("Stochastic distributions: the run index", () => {
  const run = (runId: string, over: Partial<RunSummary>): RunSummary => ({
    runId,
    state: "done",
    submittedAt: "2026-09-25T10:00:00Z",
    platformRequestHash: `prh-${runId}`,
    mode: "stochastic",
    ...over,
  });
  const RUNS: RunSummary[] = [
    run("run-5", { submittedAt: "2026-09-25T10:00:00Z", label: "first" }),
    run("run-6", { submittedAt: "2026-09-26T10:00:00Z" }),
    run("run-1", { mode: "deterministic", submittedAt: "2026-09-27T10:00:00Z" }),
    run("run-7", { state: "running", submittedAt: "2026-09-28T10:00:00Z" }),
  ];
  it("keeps done stochastic runs, newest first", () => {
    expect(stochasticRunRows(RUNS)).toEqual([
      { runId: "run-6", label: null, submittedAt: "2026-09-26T10:00:00Z" },
      { runId: "run-5", label: "first", submittedAt: "2026-09-25T10:00:00Z" },
    ]);
  });
  it("links each to this screen with the run as the picker's choice", () => {
    expect(stochasticHref("ws-a", "run-6")).toBe("#/ws/ws-a/results/stochastic?result=run-6");
    const html = renderToStaticMarkup(<StochasticRunIndexView ws="ws-a" runs={RUNS} />);
    expect(html).toContain('href="#/ws/ws-a/results/stochastic?result=run-6"');
    expect(html).toContain("Done stochastic runs");
    expect(html).toContain("Source: /api/runs, state done, mode stochastic");
    expect(html.indexOf("run-6")).toBeLessThan(html.indexOf("run-5"));
    expect(html).not.toContain("run-1");
    expect(html).not.toContain("run-7");
  });
  it("an empty list says Studio does not run stochastic runs", () => {
    const html = renderToStaticMarkup(<StochasticRunIndexView ws="ws-a" runs={[]} />);
    expect(html).toContain("No stochastic run");
    expect(html).toContain(
      "No done stochastic run. Studio does not run stochastic runs; submit one in stochastic mode on the workbench Run page.",
    );
  });
});

describe("loadStochastic", () => {
  it("a done stochastic run reads its summary", async () => {
    mockFetch([
      ["/api/runs/run-a/stochastic/summary", REPLY],
      ["/api/runs/run-a", detail()],
    ]);
    const data = await loadStochastic("run-a");
    expect(data.summary?.runId).toBe("run-a");
    expect(data.note).toBeNull();
  });
  it("a deterministic run has no summary, and says where its results are", async () => {
    mockFetch([
      ["/api/runs/run-a/stochastic/summary", REPLY],
      ["/api/runs/run-a", detail({ mode: "deterministic" })],
    ]);
    const data = await loadStochastic("run-a");
    expect(data.summary).toBeNull();
    expect(data.note).toBe(DET_NOTE);
  });
  it("a running stochastic run has no summary yet", async () => {
    mockFetch([
      ["/api/runs/run-a/stochastic/summary", REPLY],
      ["/api/runs/run-a", detail({ state: "running" })],
    ]);
    const data = await loadStochastic("run-a");
    expect(data.summary).toBeNull();
    expect(data.note).toBe("The run is running; a stochastic distribution exists only for a run that ended in state done.");
  });
  it("a refused summary prints the server's reply", async () => {
    mockFetch([
      ["/api/runs/run-a/stochastic/summary", { error: { code: "unprocessable", message: "bad envelope" } }, 422],
      ["/api/runs/run-a", detail()],
    ]);
    const data = await loadStochastic("run-a");
    expect(data.summary).toBeNull();
    expect(data.note).toBe("422: bad envelope");
  });
});
