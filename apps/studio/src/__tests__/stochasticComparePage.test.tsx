import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getStochasticCompare, type RunSummary, type StochasticCompareReply, type StochasticSummaryReply } from "@alm/reader";
import { calibrationCardWanted, contextText, statLabel, STOCHASTIC_TABLES } from "../compare/compareModel";
import { CalibrationParametersCard, DistributionTable, StochasticCompareBody, StochasticContextCard, StochasticNotes } from "../pages/compare/StochasticCompareViews";
import { loadStochasticCompare } from "../pages/compare/ComparePage";
import { mockFetch } from "./fixtures/run";

afterEach(() => vi.unstubAllGlobals());

const BANNED_CHARS = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0xa7)}]`);

const run = (runId: string, over: Partial<RunSummary> = {}): RunSummary => ({
  runId,
  state: "done",
  submittedAt: `2026-09-2${runId.slice(-1)}T10:00:00Z`,
  platformRequestHash: `prh-${runId}`,
  mode: "stochastic",
  ...over,
});

const RUNS: RunSummary[] = [run("run-5"), run("run-6"), run("run-1", { mode: "deterministic" })];

const INDEPENDENT_TEXT =
  "Standard-error figure for the B - A of the means, derived: sqrt(SE A^2 + SE B^2), from the two runs' reported standard errors. The runs use different seeds, so their path sets are treated as independent and the figure is the standard error of the difference. It is a precision figure, not a test.";

const NOTES = [
  "A distribution here is a statistic of the Monte Carlo path set, never an EVE or an NII. Every B - A is derived by the server from the two stored envelopes, displayed beside both originals.",
  "The B - A of a quantile is the difference of the two runs' quantiles. It is not a quantile of the path-by-path difference: per-path values are not stored, so no distribution of B - A exists and none is shown.",
  "The B - A of the standard deviation, the standard error, the minimum and the maximum is a difference of two estimates, each from its own path set; it carries sampling error of its own that the envelopes do not report.",
];

type Row = StochasticCompareReply["eveDistribution"]["rows"][number];
const r = (stat: Row["stat"], p: number | null, a: number, b: number, delta: number): Row => ({ stat, p, a, b, delta });

/** The literal compare reply of engine vector V1, written out by hand. */
const REPLY_S: StochasticCompareReply = {
  kind: "stochastic-compare",
  runA: "run-5",
  runB: "run-6",
  sameRun: false,
  context: [
    { field: "runId", a: "run-5", b: "run-6", same: false },
    { field: "portfolioId", a: "p-1", b: "p-1", same: true },
    { field: "marketId", a: "m-a", b: "m-b", same: false },
    { field: "schemaVersion", a: "0.1.0", b: "0.1.0", same: true },
    { field: "model", a: "hull-white-1f", b: "hull-white-1f", same: true },
    { field: "scenarioId", a: "base", b: "base", same: true },
    { field: "assumptionSetId", a: "as-1", b: "as-1", same: true },
    { field: "seed", a: "1", b: "2", same: false },
    { field: "nPaths", a: 20, b: 20, same: true },
    { field: "horizonMonths", a: 360, b: 360, same: true },
    { field: "discountBasis", a: "all-in", b: "all-in", same: true },
    { field: "calibration.source", a: "cap-atm-calibration", b: "cap-atm-calibration", same: true },
    { field: "calibration.a", a: 0.01, b: 0.01, same: true },
    { field: "calibration.sigma", a: 0.0061184513287782325, b: 0.009177675604594539, same: false },
    { field: "calibration.rmseBp", a: 3.5, b: 3.5, same: true },
    { field: "calibration.rmseGateBp", a: 5, b: 5, same: true },
    { field: "calibration.rmseGateBreached", a: false, b: false, same: true },
    { field: "calibration.nQuotes", a: 12, b: 12, same: true },
    { field: "calibration.reason", a: null, b: null, same: true },
    { field: "martingale.correctedMaxAbsErrBp", a: 0.001, b: 0.001, same: true },
    { field: "martingale.rawTerminalErrBp", a: 2.5, b: 2.5, same: true },
    { field: "martingale.terminalDfStandardError", a: 0.0004, b: 0.0004, same: true },
    { field: "martingale.terminalYears", a: 30, b: 30, same: true },
  ],
  eveDistribution: {
    rows: [
      r("mean", null, 100, 104, 4),
      r("standardError", null, 3, 4, 1),
      r("stdev", null, 10, 15, 5),
      r("min", null, 70, 60, -10),
      r("max", null, 130, 150, 20),
      r("quantile", 0.05, 80, 78, -2),
      r("quantile", 0.25, 90, 95, 5),
      r("quantile", 0.5, 100, 101, 1),
      r("quantile", 0.75, 110, 113, 3),
      r("quantile", 0.95, 120, 127, 7),
    ],
    meanDeltaStandardError: { value: 5, basis: "independent-seeds", text: INDEPENDENT_TEXT },
  },
  nii12mDistribution: {
    rows: [
      r("mean", null, 10, 10, 0),
      r("standardError", null, 0, 0, 0),
      r("stdev", null, 0, 0, 0),
      r("min", null, 10, 10, 0),
      r("max", null, 10, 10, 0),
      r("quantile", 0.05, 10, 10, 0),
      r("quantile", 0.25, 10, 10, 0),
      r("quantile", 0.5, 10, 10, 0),
      r("quantile", 0.75, 10, 10, 0),
      r("quantile", 0.95, 10, 10, 0),
    ],
    meanDeltaStandardError: { value: 0, basis: "independent-seeds", text: INDEPENDENT_TEXT },
  },
  notes: NOTES,
};

describe("stochastic compare model", () => {
  it("statLabel names each statistic; a quantile prints its p", () => {
    expect(statLabel(r("mean", null, 1, 1, 0))).toBe("Mean");
    expect(statLabel(r("standardError", null, 1, 1, 0))).toBe("Standard error of the mean");
    expect(statLabel(r("stdev", null, 1, 1, 0))).toBe("Standard deviation (per path)");
    expect(statLabel(r("min", null, 1, 1, 0))).toBe("Minimum");
    expect(statLabel(r("max", null, 1, 1, 0))).toBe("Maximum");
    expect(statLabel(r("quantile", 0.05, 1, 1, 0))).toBe("Quantile at 0.05");
  });

  it("contextText prints a number or boolean as String, null as none, a string as itself", () => {
    expect(contextText(0.0061184513287782325)).toBe("0.0061184513287782325");
    expect(contextText(null)).toBe("none");
    expect(contextText(false)).toBe("false");
    expect(contextText(true)).toBe("true");
    expect(contextText(20)).toBe("20");
    expect(contextText("all-in")).toBe("all-in");
  });

  it("the two tables are the EVE and the 12-month NII distributions", () => {
    expect(STOCHASTIC_TABLES).toEqual([
      { key: "eveDistribution", title: "EVE distribution" },
      { key: "nii12mDistribution", title: "NII 12m distribution" },
    ]);
  });
});

describe("DistributionTable", () => {
  const html = renderToStaticMarkup(<DistributionTable title="EVE distribution" block={REPLY_S.eveDistribution} />);

  it("prints the header with the derived B - A column", () => {
    expect(html).toContain('aria-label="EVE distribution"');
    expect(html).toContain('<div class="card-title">EVE distribution</div>');
    expect(html).toContain('<th scope="col">Statistic</th>');
    expect(html).toContain('<th scope="col" class="num">Run A</th>');
    expect(html).toContain('<th scope="col" class="num">Run B</th>');
    expect(html).toContain('<th scope="col" class="num">B - A (derived)</th>');
  });

  it("prints the standard deviation row with both values and the signed delta", () => {
    expect(html).toContain('<th scope="row">Standard deviation (per path)</th><td class="num" title="10">10</td><td class="num" title="15">15</td><td class="num" title="5">+5</td>');
  });

  it("prints the quantile at 0.05 with a negative delta and its full-precision title", () => {
    expect(html).toContain('<th scope="row">Quantile at 0.05</th><td class="num" title="80">80</td><td class="num" title="78">78</td><td class="num" title="-2">-2</td>');
  });

  it("prints the standard-error figure with the server's text verbatim", () => {
    expect(html).toContain("Standard-error figure for B - A of the means (derived)");
    expect(html).toContain("<dd>5</dd>");
    expect(html).toContain(INDEPENDENT_TEXT.replace(/'/g, "&#x27;"));
  });

  it("a null figure prints none", () => {
    const same = { value: null, basis: "same-run" as const, text: "Run A and run B are the same run, so every B - A is zero by construction and no standard-error figure applies." };
    const out = renderToStaticMarkup(<DistributionTable title="EVE distribution" block={{ ...REPLY_S.eveDistribution, meanDeltaStandardError: same }} />);
    expect(out).toContain("<dd>none</dd>");
    expect(out).toContain(same.text);
  });

  it("an NII row with delta 0 prints a bare 0", () => {
    const out = renderToStaticMarkup(<DistributionTable title="NII 12m distribution" block={REPLY_S.nii12mDistribution} />);
    expect(out).toContain('<th scope="row">Mean</th><td class="num" title="10">10</td><td class="num" title="10">10</td><td class="num" title="0">0</td>');
  });
});

describe("StochasticContextCard", () => {
  const html = renderToStaticMarkup(<StochasticContextCard reply={REPLY_S} />);

  it("is the Like for like card with the Same column", () => {
    expect(html).toContain('aria-label="Like for like"');
    expect(html).toContain('<div class="card-title">Like for like</div>');
    for (const h of ["Field", "Run A", "Run B", "Same"]) expect(html).toContain(`>${h}</th>`);
  });

  it("flags a differing field and says same for an equal one", () => {
    expect(html).toContain('<th scope="row" class="mono">seed</th><td class="mono">1</td><td class="mono">2</td><td><span class="status status-stale">differs</span></td>');
    expect(html).toContain('<th scope="row" class="mono">nPaths</th><td class="mono">20</td><td class="mono">20</td><td>same</td>');
  });

  it("prints a calibrated sigma at full precision and an absent value as none", () => {
    expect(html).toContain(">0.0061184513287782325</td>");
    expect(html).toContain(">0.009177675604594539</td>");
    expect(html).toContain('<th scope="row" class="mono">calibration.reason</th><td class="mono">none</td><td class="mono">none</td>');
  });

  it("prints all 23 fields", () => {
    expect(html.split('<th scope="row" class="mono">').length - 1).toBe(23);
  });
});

describe("StochasticNotes", () => {
  it("prints the three notes verbatim under How to read B - A", () => {
    const html = renderToStaticMarkup(<StochasticNotes reply={REPLY_S} />);
    expect(html).toContain('aria-label="How to read B - A"');
    expect(html).toContain('<div class="card-title">How to read B - A</div>');
    for (const n of NOTES) expect(html).toContain(n.replace(/'/g, "&#x27;"));
    expect(html.split("<li>").length - 1).toBe(3);
  });
});

describe("StochasticCompareBody", () => {
  const ok = renderToStaticMarkup(
    <StochasticCompareBody ws="ws-a" runs={RUNS} query={{ runs: "run-5,run-6" }} compare={{ state: "ok", value: REPLY_S }} />,
  );

  it("names the comparison, both distribution tables, the context and the notes", () => {
    expect(ok).toContain('aria-label="Comparison"');
    expect(ok).toContain("Stochastic distributions: run A");
    expect(ok).toContain('<span class="mono">run-5</span>');
    expect(ok).toContain('<span class="mono">run-6</span>');
    expect(ok).toContain('aria-label="EVE distribution"');
    expect(ok).toContain('aria-label="NII 12m distribution"');
    expect(ok).toContain('aria-label="Like for like"');
    expect(ok).toContain('aria-label="How to read B - A"');
  });

  it("states the source and the CSV twin", () => {
    expect(ok).toContain("Source: GET /api/compare/stochastic (the two stored envelopes aligned by the server; every B - A and the standard-error figure are derived there)");
    expect(ok).toContain("Each row is a statistic of one run&#x27;s Monte Carlo path set as its envelope stores it; B - A is derived by the server. Download CSV writes the same reply at full precision under a stochastic provenance header.");
    expect(ok).toContain('href="/api/compare/stochastic.csv?runs=run-5,run-6"');
    expect(ok).toContain(">Download CSV</a>");
    expect(ok).not.toContain("No CSV twin");
  });

  it("the stochastic pair label sits in the pickers, and no verdict language appears", () => {
    expect(ok).toContain("Table: both distribution tables (a stochastic pair)");
    expect(ok).not.toContain("significan");
    expect(ok).not.toContain("p-value");
    expect(ok).not.toMatch(BANNED_CHARS);
  });

  it("orders the pickers, then the comparison, the tables, the context and the notes", () => {
    const at = (s: string) => ok.indexOf(s);
    const order = ['class="plan-toolbar"', 'aria-label="Comparison"', 'aria-label="EVE distribution"', 'aria-label="NII 12m distribution"', "Source: GET /api/compare/stochastic", 'aria-label="Like for like"', 'aria-label="How to read B - A"'];
    const places = order.map(at);
    expect(places.every((p) => p >= 0)).toBe(true);
    expect([...places].sort((x, y) => x - y)).toEqual(places);
  });

  it("the loading branch names both runs", () => {
    const html = renderToStaticMarkup(<StochasticCompareBody ws="ws-a" runs={RUNS} query={{ runs: "run-5,run-6" }} compare={{ state: "loading" }} />);
    expect(html).toContain("Reading the stochastic comparison of run-5 and run-6");
    expect(html).not.toContain("<table");
  });

  it("a 400 from /api/compare/stochastic prints the server's message in an alert, with no table", async () => {
    mockFetch([
      ["/api/compare/stochastic?", { error: { code: "bad-request", message: 'run "run-1" is a deterministic run and run "run-3" is a stochastic run; a deterministic result and a Monte Carlo distribution are not like for like.' } }, 400],
    ]);
    const error = await getStochasticCompare("run-1", "run-3").then(() => null, (e: Error) => e);
    expect(error).not.toBeNull();
    const html = renderToStaticMarkup(<StochasticCompareBody ws="ws-a" runs={RUNS} query={{ runs: "run-1,run-3" }} compare={{ state: "error", error: error! }} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("400: run &quot;run-1&quot; is a deterministic run");
    expect(html).not.toContain("<table");
  });

  it("the reader requests /api/compare/stochastic?runs=a,b", async () => {
    mockFetch([["/api/compare/stochastic?", REPLY_S]]);
    const reply = await getStochasticCompare("run-5", "run-6");
    expect(reply.runA).toBe("run-5");
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain("/api/compare/stochastic?runs=run-5,run-6");
  });
});

/**
 * A mixed pair, run A Hull-White and run B BGM on one seed and one path count.
 * The compare reply is the 23-row context with the model row differing and the `different-models` basis, written out
 * by hand; the BGM parameters come from each run's single-run summary, fetched only for a pair that names BGM.
 */
const DIFFERENT_MODELS_TEXT =
  "The two runs use different rate models whose simulators draw their random numbers differently (Hull-White one normal per antithetic pair per step, BGM two), so their path sets share no draws even under one seed and one path count. The figure sqrt(SE A^2 + SE B^2) is the standard error of the difference under independence, which the stored statistics cannot confirm, because per-path values are not stored. It is a precision figure, not a test.";
const MODELS_NOTE =
  "Run A uses the Hull-White one-factor rate model (hull-white-1f) and run B the BGM rate model (bgm-lmm-2f), so every B - A carries the change of model as well as any other change between the runs.";

const REPLY_M: StochasticCompareReply = {
  ...REPLY_S,
  context: REPLY_S.context.map((c) => {
    if (c.field === "seed") return { ...c, b: "1", same: true };
    if (c.field === "model") return { ...c, b: "bgm-lmm-2f", same: false };
    if (c.field === "calibration.source") return { ...c, b: "long-yield-atm-calibration", same: false };
    if (c.field === "calibration.a" || c.field === "calibration.sigma") return { ...c, b: null, same: false };
    return c;
  }),
  eveDistribution: { ...REPLY_S.eveDistribution, meanDeltaStandardError: { value: 5, basis: "different-models", text: DIFFERENT_MODELS_TEXT } },
  nii12mDistribution: { ...REPLY_S.nii12mDistribution, meanDeltaStandardError: { value: 0, basis: "different-models", text: DIFFERENT_MODELS_TEXT } },
  notes: [...NOTES, MODELS_NOTE],
};

const HW_ARM: StochasticSummaryReply["calibration"] = {
  source: "cap-atm-calibration", a: 0.01, sigma: 0.0061184513287782325, rmseBp: 3.5, rmseGateBp: 5, rmseGateBreached: false, nQuotes: 12, underlyingTau: 0.25, iterations: 40,
};
const BGM_ARM: StochasticSummaryReply["calibration"] = {
  source: "long-yield-atm-calibration", a: 0.11, b: 0.22, c: 0.33, d: 0.044, beta: 0.15, volScalar: 1, displacement: 0.05, cevBeta: 0.5,
  rmseBp: 12.45, rmseGateBp: 10, rmseGateBreached: true, nQuotes: 28, subset: [{ expiryYears: 1, tenorYears: 1 }], iterations: 150,
};
/** Only the calibration field is read from a summary here; the rest of the reply is not this card's. */
const summaryOf = (runId: string, calibration: StochasticSummaryReply["calibration"]) => ({ kind: "stochastic-run-summary", runId, calibration });

const cell = (k: string, a: string, b: string) => `<th scope="row" class="mono">${k}</th><td class="mono">${a}</td><td class="mono">${b}</td>`;

describe("Compare of two rate models (slice two)", () => {
  it("calibrationCardWanted reads the two model context rows: an HW pair wants no card, a pair naming BGM does", () => {
    expect(calibrationCardWanted(REPLY_S)).toBe(false);
    expect(calibrationCardWanted(REPLY_M)).toBe(true);
    const bgmPair = { ...REPLY_S, context: REPLY_S.context.map((c) => (c.field === "model" ? { ...c, a: "bgm-lmm-2f", b: "bgm-lmm-2f" } : c)) };
    expect(calibrationCardWanted(bgmPair)).toBe(true);
  });

  it("an HW pair reads the compare route alone: one fetch, no summary, no card", async () => {
    mockFetch([
      ["/api/compare/stochastic?", REPLY_S],
      ["/api/runs/run-5/stochastic/summary", summaryOf("run-5", HW_ARM)],
      ["/api/runs/run-6/stochastic/summary", summaryOf("run-6", HW_ARM)],
    ]);
    const read = await loadStochasticCompare("run-5", "run-6");
    expect(read.reply).toEqual(REPLY_S);
    expect(read.calibration).toBeNull();
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/api/compare/stochastic?runs=run-5,run-6");
    const html = renderToStaticMarkup(<StochasticCompareBody ws="ws-a" runs={RUNS} query={{ runs: "run-5,run-6" }} compare={{ state: "ok", value: read.reply }} calibration={read.calibration} />);
    expect(html).not.toContain("Calibration parameters");
  });

  it("a mixed pair reads both runs' summaries and keeps each run's calibration arm verbatim", async () => {
    mockFetch([
      ["/api/compare/stochastic?", REPLY_M],
      ["/api/runs/run-5/stochastic/summary", summaryOf("run-5", HW_ARM)],
      ["/api/runs/run-6/stochastic/summary", summaryOf("run-6", BGM_ARM)],
    ]);
    const read = await loadStochasticCompare("run-5", "run-6");
    expect(read.calibration).toEqual({ a: HW_ARM, b: BGM_ARM });
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(3);
    expect(urls.some((u) => u.endsWith("/api/runs/run-5/stochastic/summary"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/api/runs/run-6/stochastic/summary"))).toBe(true);
  });

  it("a refused summary keeps the comparison and names the refusal in the card", async () => {
    mockFetch([
      ["/api/compare/stochastic?", REPLY_M],
      ["/api/runs/run-5/stochastic/summary", summaryOf("run-5", HW_ARM)],
      ["/api/runs/run-6/stochastic/summary", { error: { code: "unprocessable", message: "bad envelope" } }, 422],
    ]);
    const read = await loadStochasticCompare("run-5", "run-6");
    expect(read.reply).toEqual(REPLY_M);
    expect(read.calibration).toEqual({ error: "422: bad envelope" });
    const html = renderToStaticMarkup(<CalibrationParametersCard runA="run-5" runB="run-6" calibration={read.calibration!} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("The single-run summaries could not be read: 422: bad envelope");
  });

  it("a summary with no calibration field (a server before slice two) shows the honest alert, never a throw", async () => {
    mockFetch([
      ["/api/compare/stochastic?", REPLY_M],
      ["/api/runs/run-5/stochastic/summary", summaryOf("run-5", HW_ARM)],
      ["/api/runs/run-6/stochastic/summary", { ...summaryOf("run-6", BGM_ARM), calibration: undefined }],
    ]);
    const read = await loadStochasticCompare("run-5", "run-6");
    expect(read.reply).toEqual(REPLY_M);
    expect(read.calibration).toEqual({ error: "the summary of run-6 carries no calibration field" });
    const html = renderToStaticMarkup(<CalibrationParametersCard runA="run-5" runB="run-6" calibration={read.calibration!} />);
    expect(html).toContain("The single-run summaries could not be read: the summary of run-6 carries no calibration field");
  });

  const body = renderToStaticMarkup(
    <StochasticCompareBody ws="ws-a" runs={RUNS} query={{ runs: "run-5,run-6" }} compare={{ state: "ok", value: REPLY_M }} calibration={{ a: HW_ARM, b: BGM_ARM }} />,
  );

  it("prints the different-models basis text and the model note as the reply carries them, 23 context rows kept", () => {
    expect(body).toContain(DIFFERENT_MODELS_TEXT);
    expect(body).toContain(MODELS_NOTE);
    expect(body).not.toContain("shared-seed");
    const like = body.slice(body.indexOf('aria-label="Like for like"'), body.indexOf('aria-label="Calibration parameters"'));
    expect(like.split('<th scope="row" class="mono">').length - 1).toBe(23);
    expect(like).toContain(`${cell("model", "hull-white-1f", "bgm-lmm-2f")}<td><span class="status status-stale">differs</span></td>`);
  });

  it("puts the Calibration parameters card under the context table and before the notes", () => {
    const at = (m: string) => body.indexOf(m);
    const places = ['aria-label="Like for like"', 'aria-label="Calibration parameters"', 'aria-label="How to read B - A"'].map(at);
    expect(places.every((p) => p >= 0)).toBe(true);
    expect([...places].sort((x, y) => x - y)).toEqual(places);
  });

  it("the card prints each run's arm side by side, a key one arm lacks as not in that run", () => {
    const html = renderToStaticMarkup(<CalibrationParametersCard runA="run-5" runB="run-6" calibration={{ a: HW_ARM, b: BGM_ARM }} />);
    expect(html).toContain('<div class="card-title">Calibration parameters</div>');
    for (const h of ["Parameter", "Run A", "Run B"]) expect(html).toContain(`>${h}</th>`);
    expect(html).toContain(cell("source", "cap-atm-calibration", "long-yield-atm-calibration"));
    expect(html).toContain(cell("a", "0.01", "0.11"));
    expect(html).toContain(cell("sigma", "0.0061184513287782325", "not in run B"));
    expect(html).toContain(cell("underlyingTau", "0.25", "not in run B"));
    expect(html).toContain(cell("b", "not in run A", "0.22"));
    expect(html).toContain(cell("displacement", "not in run A", "0.05"));
    expect(html).toContain(cell("cevBeta", "not in run A", "0.5"));
    expect(html).toContain(cell("iterations", "40", "150"));
    expect(html).toContain("Source: GET /api/runs/run-5/stochastic/summary and GET /api/runs/run-6/stochastic/summary, field calibration");
    expect(html).not.toContain("B - A");
    expect(html).not.toMatch(/cap (normal )?vol|cap quote|cap surface|swaption (quote|normal|grid|atm)/i);
    expect(html).not.toMatch(BANNED_CHARS);
  });
});
