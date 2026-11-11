// apps/studio/src/__tests__/curveDefaultStudio.test.tsx
/**
 * The Studio screens of the curve default. The curve line of a run
 * on the Results pages, the stochastic page, Govern and Compare; the market's default named on Curve setups and
 * Market; the "Linear in zero (month grid)" preset; the derived curve's estimatedOnDefault, read only. Every sentence
 * is restated by hand.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootstrapZeroCurve, loadMarketSnapshot } from "@alm/kernel";
import { buildCurveFromSetup } from "@alm/engine/src/curveBuilder";
import type { CatalogRunInputs, CatalogRunListItem, CompareReply, DerivedCurveListRow, MarketCurveReply, RunCurveLine, RunDetail } from "@alm/reader";
import { runCurveLine, runCurveValue } from "../results/curveLine";
import { RunStrip } from "../pages/results/ResultsPage";
import { StochasticRunBody } from "../pages/results/StochasticRunViews";
import { RunPlanView } from "../pages/govern/WorkspaceGovern";
import { AuditView } from "../pages/govern/GovernPages";
import { ProvenanceCard } from "../pages/compare/CompareViews";
import {
  CurveBuilderView, FILL_RACE_SENTENCE, emptyEditor, fillFromSnapshot, presetOutcome, setupNameProblem, type CurveBuilderViewProps,
} from "../pages/market/CurveBuilderPage";
import { blockFromState, LINEAR_ZERO_PRESET } from "../market/curveSetupModel";
import { defaultButtonText, marketCurveOf, marketCurveText, marketDefaultOf, marketDefaultSentence } from "../market/marketCurve";
import { estimatedOnText } from "../market/derivedCurveModel";
import { DerivedCurvesView, type DerivedCurvesViewProps } from "../pages/market/DerivedCurvesPage";
import { baseOptions, curveFromState, curveOfListRow, defaultState, stateFromCurve } from "../market/derivedCurveModel";
import { loadMarket } from "../pages/market/loadMarket";
import { MarketView } from "../pages/market/MarketView";
import { curveInstances } from "../harness/instances";
import { DETAIL, RESULT } from "./fixtures/results";
import { LINEAGE_M, MARKETS, SERIES, SNAP } from "./fixtures/market";
import { mockFetch } from "./fixtures/run";

afterEach(() => vi.unstubAllGlobals());

const PACK = fileURLToPath(new URL("../../../../packages/kernel/public/market_public.json", import.meta.url));
const CONSTRUCTED = fileURLToPath(new URL("../../../../packages/kernel/src/math/rates/__tests__/fixtures/market_constructed.json", import.meta.url));
const EM_DASH = String.fromCharCode(0x2014);
const SECTION_SIGN = String.fromCharCode(0xa7);
const noop = () => {};
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

const V2: RunCurveLine = { line: "Curve: platform default v2, log-linear on discount factor", value: "platform default v2, log-linear on discount factor", from: "stamp" };
const FALLBACK: RunCurveLine = {
  line: "Curve: platform default v1, linear in zero (fallback: quote 3W at 0.0575 years is not within 0.0001 years of a whole month)",
  value: "platform default v1, linear in zero (fallback: quote 3W at 0.0575 years is not within 0.0001 years of a whole month)",
  from: "stamp",
};

// ---------------------------------------------------------------------------------------------------------------------
// The curve line of a run

describe("the curve line of a run (decision 64)", () => {
  it("is the server's line verbatim when the run detail carries one", () => {
    expect(runCurveLine({ state: "done", curve: V2 })).toBe("Curve: platform default v2, log-linear on discount factor");
    expect(runCurveValue({ state: "done", curve: V2 })).toBe("platform default v2, log-linear on discount factor");
    expect(runCurveLine({ state: "done", curve: FALLBACK })).toBe(
      "Curve: platform default v1, linear in zero (fallback: quote 3W at 0.0575 years is not within 0.0001 years of a whole month)",
    );
  });
  it("says why there is none: not done yet, ended without a result, or a detail that carries none", () => {
    expect(runCurveLine({ state: "queued" })).toBe("Curve: unknown until the run finishes");
    expect(runCurveLine({ state: "running" })).toBe("Curve: unknown until the run finishes");
    expect(runCurveLine({ state: "error" })).toBe("Curve: none, the run ended error without a result");
    expect(runCurveLine({ state: "cancelled" })).toBe("Curve: none, the run ended cancelled without a result");
    expect(runCurveLine({ state: "interrupted" })).toBe("Curve: none, the run ended interrupted without a result");
    expect(runCurveLine({ state: "done" })).toBe("Curve: Unobservable, the run detail carries no curve line");
    expect(runCurveValue({ state: "done" })).toBe("Unobservable, the run detail carries no curve line");
  });

  it("sits on its own line at the end of the run strip, on Results and the Dashboard", () => {
    const detail: RunDetail = { ...DETAIL, curve: V2 };
    const html = renderToStaticMarkup(<RunStrip ws="ws-a" runId="run-fixture" data={{ detail, result: RESULT, note: null }} query={{}} />);
    expect(html).toContain('<span class="run-strip-curve" title="Curve">Curve: platform default v2, log-linear on discount factor</span></div>');
    const picked = renderToStaticMarkup(<RunStrip ws="ws-a" runId="run-fixture" data={{ detail, result: RESULT, note: null }} query={{}} picked={true} />);
    expect(picked).toContain('<span>Showing the latest done run. Pick another in the Run pill.</span><span class="run-strip-curve" title="Curve">Curve: platform default v2');
  });

  it("heads the stochastic run, read from the summary first and the run detail second", () => {
    const summary = {
      runId: "run-s", calibrationGate: { state: "no-gate", rmseBp: null, rmseGateBp: null, text: "Parameters supplied by override, not calibrated." },
      eveDistribution: { rows: [] }, nii12mDistribution: { rows: [] }, context: [], notImplemented: [], notes: [], curve: V2,
    } as never;
    const both = renderToStaticMarkup(<StochasticRunBody runId="run-s" data={{ detail: { ...DETAIL, mode: "stochastic", curve: FALLBACK }, summary, note: null }} />);
    expect(both).toContain('<p class="run-curve">Curve: platform default v2, log-linear on discount factor</p>');
    const fromDetail = renderToStaticMarkup(
      <StochasticRunBody runId="run-s" data={{ detail: { ...DETAIL, mode: "stochastic", curve: V2 }, summary: { ...(summary as object), curve: undefined } as never, note: null }} />,
    );
    expect(fromDetail).toContain('<p class="run-curve">Curve: platform default v2, log-linear on discount factor</p>');
  });

  it("is a Curve row on Govern's plan of a stored run, after Basis", () => {
    const html = renderToStaticMarkup(createElement(RunPlanView, { runId: "run-1", basisLabel: "Run on the base book", provenance: RESULT.provenance, curve: V2.value }));
    expect(html).toContain("<dt>Basis</dt><dd>Run on the base book</dd><dt>Curve</dt><dd>platform default v2, log-linear on discount factor</dd><dt>Plan id</dt>");
  });

  it("is a Curve row on Govern's opened audit row, beside the plan, when it was read", () => {
    const runs = [{ runId: "run-1", state: "done", label: null, submittedAt: null, endedAt: null, elapsedMs: null, platformRequestHash: "prh", engineInputsHash: "ih", resultContentHash: null }] as CatalogRunListItem[];
    const inputs = { runId: "run-1", inputs: [] } as unknown as CatalogRunInputs;
    const opened = { inputs, plan: { kind: "skipped" as const, state: "done" }, curve: V2.value };
    const html = renderToStaticMarkup(createElement(AuditView, { ws: "ws-a", runs, query: {}, open: "run-1", opened }));
    expect(html).toContain("<dt>Curve</dt><dd>platform default v2, log-linear on discount factor</dd>");
    const without = renderToStaticMarkup(createElement(AuditView, { ws: "ws-a", runs, query: {}, open: "run-1", opened: { inputs, plan: opened.plan } }));
    expect(without).not.toContain("<dt>Curve</dt>");
  });

  it("is a Curve row per side on Compare's provenance when the reply carries it", () => {
    const reply = {
      table: "nii", columns: [], rows: [], note: "n",
      provenance: {
        a: { runId: "run-1", inputsHash: "hash-a", curve: "platform default v1, linear in zero", schemaVersion: "1.11.0", engineVersion: "2.0.0" },
        b: { runId: "run-2", inputsHash: "hash-b", curve: "platform default v2, log-linear on discount factor", schemaVersion: "1.11.0", engineVersion: "2.0.0" },
      },
    } as unknown as CompareReply;
    const html = renderToStaticMarkup(<ProvenanceCard reply={reply} />);
    expect(html).toContain('<dt>Inputs hash A</dt><dd class="mono">hash-a</dd><dt>Curve A</dt><dd>platform default v1, linear in zero</dd>');
    expect(html).toContain('<dt>Inputs hash B</dt><dd class="mono">hash-b</dd><dt>Curve B</dt><dd>platform default v2, log-linear on discount factor</dd>');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The market's default

// The server's reply (GET /api/market/:id/curve-default, B4 Task 9 fix round 1), restated by hand.
const V2_STAMP = { kind: "default", version: 2 } as const;
const V1_STAMP = { kind: "default", version: 1 } as const;
const REPLY_V2: MarketCurveReply = { marketId: "market-public-2026-03-31", builds: V2_STAMP, default: V2_STAMP };
const REPLY_V1: MarketCurveReply = { marketId: "market-public-2026-03-31-v1", builds: V1_STAMP, default: V1_STAMP };

describe("the default a market builds, read from the server (decisions 57, 58, 70, 72)", () => {
  it("reads v2, the pinned v1, the fallback with its reason, and a setup over either", () => {
    expect(marketCurveText(marketCurveOf(REPLY_V2))).toBe("platform default v2, log-linear on discount factor");
    expect(marketCurveText(marketCurveOf(REPLY_V1))).toBe("platform default v1, linear in zero (this market is pinned to it)");
    const reason = "quote 3W at 0.0575 years is not within 0.0001 years of a whole month";
    const fallback = { kind: "default", version: 1, reason } as const;
    expect(marketCurveText(marketCurveOf({ marketId: "m", builds: fallback, default: fallback }))).toBe(
      "platform default v1, linear in zero (fallback: quote 3W at 0.0575 years is not within 0.0001 years of a whole month)",
    );
    const withSetup: MarketCurveReply = { marketId: "m", builds: { kind: "setup", id: "ust-lz", label: "UST linear" }, default: V2_STAMP };
    expect(marketCurveText(marketCurveOf(withSetup))).toBe("setup UST linear (ust-lz)");
    expect(marketCurveText(marketCurveOf({ ...withSetup, builds: { kind: "setup", id: "ust-lz" } }))).toBe("setup ust-lz");
    // The default the market would build without its block: what "Use the platform default curve" returns to.
    expect(marketCurveText(marketDefaultOf(withSetup))).toBe("platform default v2, log-linear on discount factor");
  });

  it("names a market the engine refuses in the server's words, and a read that failed", () => {
    const refused = { kind: "refused", reason: "The market's curveDefault is 2; the only value it takes is 1." } as const;
    expect(marketCurveText(marketCurveOf({ marketId: "m", builds: refused, default: refused }))).toBe(
      "not read: The market's curveDefault is 2; the only value it takes is 1.",
    );
    expect(marketCurveText({ kind: "problem", problem: "404 not-found: no market" })).toBe("not read: 404 not-found: no market");
  });

  it("says in a sentence which default the market builds, and the button names its version", () => {
    const v2 = marketDefaultOf(REPLY_V2);
    const v1 = marketDefaultOf(REPLY_V1);
    expect(marketDefaultSentence(v2)).toBe("This market builds platform default v2, log-linear on discount factor, from its own quotes.");
    expect(marketDefaultSentence(v1)).toBe("This market builds platform default v1, linear in zero: it is pinned to the older default.");
    expect(marketDefaultSentence({ kind: "default", version: 1, reason: "the snapshot carries no curveQuotes list" })).toBe(
      "This market builds platform default v1, linear in zero: platform default v2 cannot take its quotes (the snapshot carries no curveQuotes list).",
    );
    expect(marketDefaultSentence({ kind: "problem", problem: "boom" })).toBe("Which default this market builds could not be read: boom");
    expect(defaultButtonText(v2)).toBe("Use the platform default curve (v2)");
    expect(defaultButtonText(v1)).toBe("Use the platform default curve (v1)");
    expect(defaultButtonText(null)).toBe("Use the platform default curve");
    expect(defaultButtonText({ kind: "problem", problem: "boom" })).toBe("Use the platform default curve");
  });

  it("the Studio runs no engine code to name it: marketCurve.ts imports types only", () => {
    const src = readFileSync(fileURLToPath(new URL("../market/marketCurve.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/^import (?!type )[^;]*@alm\/(engine|kernel)/m);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The preset (decision 65)

describe("the Linear in zero (month grid) preset", () => {
  it("is labelled within about 1e-9 of the old default and not byte-equal, under an id the server takes", () => {
    expect(LINEAR_ZERO_PRESET.id).toBe("linear-zero-month-grid");
    expect(LINEAR_ZERO_PRESET.label).toBe("Linear in zero (month grid)");
    expect(LINEAR_ZERO_PRESET.note).toBe(
      "Built from the attached snapshot's quotes and joined linear in zero rate on the month grid. Within about 1e-9 of the old default from one month out, and not byte-equal to it: a quote shorter than one month is dropped, so the first month differs.",
    );
    expect(setupNameProblem(LINEAR_ZERO_PRESET.id)).toBeNull();
    // The reserved id stays refused.
    expect(setupNameProblem("platform-default")).toBe('The curve setup id "platform-default" is reserved for the platform\'s own curve; pick another id.');
  });

  it("fills the editor from the snapshot with the fill's rows and convention, interpolation linear in zero, and its own name", async () => {
    const snap = await loadMarketSnapshot(PACK);
    const ed = emptyEditor();
    const out = presetOutcome(ed, ed.version, fillFromSnapshot(snap));
    expect(out.editor.id).toBe("linear-zero-month-grid");
    expect(out.editor.label).toBe("Linear in zero (month grid)");
    expect(out.editor.interpolation).toBe("linear-zero");
    expect(out.editor.baseCurve).toBe("UST");
    expect(out.editor.dayCount).toBe("ACT/365");
    expect(out.editor.compounding).toBe("semi-annual");
    expect(out.editor.rows.map((r) => r.tenorText)).toEqual(["1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"]);
    expect(out.editor.rows.every((r) => r.quoteType === "par-rate" && r.instrument === "ois-swap")).toBe(true);
    expect(out.editor.rows.map((r) => Number(r.valueText))).toEqual(snap.curveQuotes.map((q) => q.rate));
    expect(out.lines).toEqual([
      "Loaded the preset Linear in zero (month grid) from the attached snapshot. Save it, then make it active to run on it.",
      "Day count and compounding follow the snapshot: Actual/365, Semi-annual.",
    ]);
  });

  it("leaves an editor that changed while the snapshot was read alone, and a snapshot with no quotes changes nothing", () => {
    const ed = { ...emptyEditor(), version: 3 };
    const raced = presetOutcome(ed, 2, { rows: [{ instrument: "ois-swap", tenorText: "1Y", quoteType: "par-rate", valueText: "0.04", convexityText: "" }], dropped: [], convention: null, note: "n" });
    expect(raced.editor).toBe(ed);
    expect(raced.lines).toEqual([FILL_RACE_SENTENCE]);
    const empty = presetOutcome(ed, 3, fillFromSnapshot({ curveQuotes: [] }));
    expect(empty.editor).toBe(ed);
    expect(empty.lines).toEqual(["The attached snapshot carries no curve quotes."]);
  });

  it("builds a curve within about 1e-9 of the old default on the public pack, at the quotes and between them", async () => {
    const snap = await loadMarketSnapshot(PACK);
    const ed = emptyEditor();
    const block = blockFromState(presetOutcome(ed, ed.version, fillFromSnapshot(snap)).editor).block;
    expect(block).not.toBeNull();
    const preset = buildCurveFromSetup(block!).curve;
    const v1 = bootstrapZeroCurve(snap);
    let worst = 0;
    for (let m = 1; m <= 360; m++) worst = Math.max(worst, Math.abs(preset.zeroRate(m / 12) - v1.zeroRate(m / 12)));
    // Measured 7.85e-10 at one month on 2026-10-16; the label says about 1e-9.
    expect(worst).toBeLessThan(2e-9);
    expect(worst).toBeGreaterThan(0);
  });

  it("on a pack with a 1D quote: within about 1e-9 from one month out, and the dropped quote moves the first month", async () => {
    const snap = await loadMarketSnapshot(CONSTRUCTED);
    const ed = emptyEditor();
    const f = fillFromSnapshot(snap);
    expect(f.dropped).toEqual(["1D"]);
    const preset = buildCurveFromSetup(blockFromState(presetOutcome(ed, ed.version, f).editor).block!).curve;
    const v1 = bootstrapZeroCurve(snap);
    let worst = 0;
    for (let d = 30; d <= 360 * 30; d++) worst = Math.max(worst, Math.abs(preset.zeroRate(d / 360) - v1.zeroRate(d / 360)));
    // Measured 9.90e-10 at one month on 2026-10-16.
    expect(worst).toBeLessThan(2e-9);
    // Under one month the old default reads the 1D quote; the preset cannot: measured 5.65e-5 as a decimal, 0.565 bp, at one day.
    expect(Math.abs(preset.zeroRate(1 / 360) - v1.zeroRate(1 / 360))).toBeGreaterThan(5e-5);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The Curve setups page

const LISTED = {
  id: "cs-0123456789abcdef", setupId: "sofr-main", label: "SOFR main", interpolation: "log-linear-df", dayCount: "ACT/360", compounding: "annual",
  rows: [{ instrument: "ois-swap", tenorMonths: 12, quoteType: "par-rate", value: 0.04 }], active: true,
} as CurveBuilderViewProps["setups"] extends (infer T)[] | null ? T : never;

function cbProps(p: Partial<CurveBuilderViewProps> = {}): CurveBuilderViewProps {
  return {
    setups: [LISTED], missing: [], listError: null, editor: emptyEditor(),
    activeId: LISTED.id, blocked: null, hasSnapshot: true, by: "Chih", busy: null, note: null,
    paste: { text: "", unit: "auto", result: null }, fill: null, preview: null, previewError: null,
    onBy: noop, onEdit: noop, onActivate: noop, onDeactivate: noop, onNew: noop, onField: noop, onRow: noop, onAddRow: noop, onRemoveRow: noop,
    onPasteText: noop, onPasteUnit: noop, onPasteAdd: noop, onFill: noop, onPreview: noop, onSave: noop,
    ...p,
  };
}
const cb = (p: Partial<CurveBuilderViewProps> = {}) => renderToStaticMarkup(<CurveBuilderView {...cbProps(p)} />);

describe("Curve setups: what the default is now", () => {
  it("the intro says the default is log-linear on discount factor, the pinned markets keep linear in zero, and a setup wins", () => {
    expect(text(cb())).toContain(
      "A curve setup names the quotes a run's base curve is built from and the method that joins them. Save a setup under its own name, then make it active: the next run of this workspace builds its curve from it. An active setup always wins. With none active, runs use the platform default curve: version 2, log-linear on discount factor, built from the market's own quotes. A market pinned to the older default keeps version 1, linear in zero.",
    );
  });

  it("the platform default button names the version this market builds, with the sentence under it", () => {
    const v2 = cb({ marketDefault: marketDefaultOf(REPLY_V2) });
    expect(v2).toMatch(/<button[^>]*>Use the platform default curve \(v2\)<\/button>/);
    expect(text(v2)).toContain("This market builds platform default v2, log-linear on discount factor, from its own quotes.");
    const v1 = cb({ marketDefault: marketDefaultOf(REPLY_V1) });
    expect(v1).toMatch(/<button[^>]*>Use the platform default curve \(v1\)<\/button>/);
    expect(text(v1)).toContain("This market builds platform default v1, linear in zero: it is pinned to the older default.");
  });

  it("an empty list says runs use the platform default, then which one this market builds", () => {
    expect(text(cb({ setups: [], activeId: null, marketDefault: marketDefaultOf(REPLY_V2) }))).toContain(
      "This workspace holds no curve setup. Runs use the platform default curve. This market builds platform default v2, log-linear on discount factor, from its own quotes.",
    );
  });

  it("lists the preset with its label, its note and a load button, off with no snapshot or while busy", () => {
    const m = cb();
    expect(m).toContain('aria-label="Presets"');
    expect(text(m)).toContain("Presets Linear in zero (month grid) Preset");
    expect(text(m)).toContain(LINEAR_ZERO_PRESET.note);
    const button = m.match(/<button[^>]*aria-label="Load Linear in zero \(month grid\) into the editor"[^>]*>Load into the editor<\/button>/);
    expect(button).not.toBeNull();
    expect(button![0]).not.toContain("disabled");
    expect(cb({ hasSnapshot: false }).match(/<button[^>]*aria-label="Load Linear in zero \(month grid\) into the editor"[^>]*>/)![0]).toContain('disabled=""');
    expect(text(cb({ hasSnapshot: false }))).toContain("Attach a base snapshot on Yield curves first.");
    expect(cb({ busy: "Reading" }).match(/<button[^>]*aria-label="Load Linear in zero \(month grid\) into the editor"[^>]*>/)![0]).toContain('disabled=""');
    // On an empty list too: the preset is how a first setup starts.
    expect(cb({ setups: [], activeId: null })).toContain('aria-label="Load Linear in zero (month grid) into the editor"');
  });

  it("prints what the preset load did under the preset, the quotes it could not fill included", () => {
    const m = cb({ preset: { lines: ["Loaded the preset Linear in zero (month grid) from the attached snapshot. Save it, then make it active to run on it."], dropped: ["ON"] } });
    expect(text(m)).toContain("Loaded the preset Linear in zero (month grid) from the attached snapshot. Save it, then make it active to run on it. Not filled (shorter than one month): ON");
  });

  it("carries no em-dash or section sign", () => {
    const m = cb({ marketDefault: marketDefaultOf(REPLY_V2), preset: { lines: ["x"], dropped: [] } });
    expect(m).not.toContain(EM_DASH);
    expect(m).not.toContain(SECTION_SIGN);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Derived curves (decision 63)

const DERIVED: DerivedCurveListRow = {
  id: "dc-0123456789abcdef", curveId: "sofr-ust", label: "SOFR over UST", base: "platform-default",
  spreads: [{ tenorMonths: 3, spreadBp: 8 }], source: { from: "sofr-main", minus: "platform-default" }, estimatedOnDefault: 1,
};

function dcProps(p: Partial<DerivedCurvesViewProps> = {}): DerivedCurvesViewProps {
  return {
    curves: [DERIVED], missing: [], listError: null, options: baseOptions([{ id: "sofr-main", label: "SOFR OIS" }]),
    editor: defaultState(), blocked: null, by: "Chih", busy: null, note: null, fill: { from: "sofr-main", minus: "platform-default", lines: null },
    onBy: noop, onEdit: noop, onNew: noop, onField: noop, onCell: noop, onAddRow: noop, onRemoveRow: noop, onFillFrom: noop, onFillMinus: noop, onFill: noop, onSave: noop,
    ...p,
  };
}

describe("Derived curves: where a saved curve's spreads were estimated", () => {
  it("reads the server's value, and nothing for a curve that carries none", () => {
    expect(estimatedOnText(DERIVED)).toBe("Spreads estimated on platform default v1");
    expect(estimatedOnText({ ...DERIVED, estimatedOnDefault: 2 })).toBe("Spreads estimated on platform default v2");
    const { estimatedOnDefault: _e, ...typed } = DERIVED;
    expect(estimatedOnText(typed)).toBeNull();
  });
  it("shows it on the saved curve's row, read only", () => {
    const m = renderToStaticMarkup(<DerivedCurvesView {...dcProps()} />);
    expect(m).toContain('<span class="muted cb-item-stamp">Spreads estimated on platform default v1</span>');
    const { estimatedOnDefault: _e, ...typed } = DERIVED;
    expect(renderToStaticMarkup(<DerivedCurvesView {...dcProps({ curves: [typed] })} />)).not.toContain("estimated on");
  });
  it("Edit then Save of a stamped curve posts a body without estimatedOnDefault: the server owns it", () => {
    expect("estimatedOnDefault" in curveFromState(stateFromCurve(curveOfListRow(DERIVED)))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Market (Yield curves)

describe("Market: the base curve named by its default", () => {
  const routes = (stored: unknown): Array<[string, unknown, number?]> => [
    ["/api/catalog/markets/market-public-2026-03-31", SNAP],
    ["/api/catalog/markets", MARKETS],
    ["/api/catalog/curves/risk-free/series", SERIES],
    ["/api/catalog/lineage/market/market-public-2026-03-31", LINEAGE_M],
    ["/api/scenarios/preview", { marketSnapshot: "market-public-2026-03-31", calibrationDate: "2026-03-31", base: { t: [1], z: [0.04], df: [0.9608] }, shocked: { t: [1], z: [0.04], df: [0.9608] }, shiftBp: [0] }],
    ...(stored === undefined ? [] : [["/api/market/market-public-2026-03-31/curve-default", stored] as [string, unknown]]),
  ];

  it("reads the server's curve stamp and names the base curve on the curves table and in its source line", async () => {
    mockFetch(routes(REPLY_V2));
    const model = await loadMarket("market-public-2026-03-31");
    expect(model.baseCurve).toEqual({ kind: "default", version: 2 });
    const html = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{}} section="curves" />);
    expect(text(html)).toContain("Base curve of this snapshot: platform default v2, log-linear on discount factor.");
    expect(text(html)).not.toContain("active setup");
    expect(text(html)).toContain(
      "base.z and base.df, the engine's build of /api/catalog/markets/market-public-2026-03-31 (platform default v2, log-linear on discount factor), the curve named from GET /api/market/market-public-2026-03-31/curve-default;",
    );
    expect(text(html)).toContain("Quoted points as stored; the zero and forward curves built from them appear on a run's Rates tab.");
  });

  it("the risk-free instance under the charts names the base curve rather than a fixed linear-in-zero line", () => {
    const [riskFree, termFunding] = curveInstances(SNAP, { positions: null, setupsOnBase: [], baseCurve: "platform default v2, log-linear on discount factor" });
    expect(riskFree!.settings).toContainEqual({ label: "Base curve", value: "platform default v2, log-linear on discount factor" });
    expect(riskFree!.settings.some((s) => s.label === "Interpolation")).toBe(false);
    // The term funding curve is not the base curve; its rows are as before.
    expect(termFunding!.settings).toContainEqual({ label: "Interpolation", value: "linear in zero" });
    // A caller that read no base curve keeps the old rows.
    expect(curveInstances(SNAP, { positions: null, setupsOnBase: [] })[0]!.settings).toContainEqual({ label: "Interpolation", value: "linear in zero" });
  });

  it("says the workspace's active setup wins over the snapshot's base curve", async () => {
    mockFetch(routes(REPLY_V2));
    const model = await loadMarket("market-public-2026-03-31");
    const html = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{}} section="curves" activeSetup="SOFR main" />);
    expect(text(html)).toContain("Base curve of this snapshot: platform default v2, log-linear on discount factor. This workspace's active setup SOFR main wins.");
  });

  it("names a marked market's v1, and degrades alone when the curve stamp cannot be read", async () => {
    mockFetch(routes(REPLY_V1));
    const marked = await loadMarket("market-public-2026-03-31");
    expect(text(renderToStaticMarkup(<MarketView ws="ws-a" model={marked} query={{}} section="curves" />))).toContain(
      "Base curve of this snapshot: platform default v1, linear in zero (this market is pinned to it).",
    );
    mockFetch(routes(undefined));
    const lost = await loadMarket("market-public-2026-03-31");
    expect(lost.baseCurve?.kind).toBe("problem");
    expect(lost.base).not.toBeNull();
    expect(text(renderToStaticMarkup(<MarketView ws="ws-a" model={lost} query={{}} section="curves" />))).toContain("Base curve of this snapshot: not read: ");
  });
});
