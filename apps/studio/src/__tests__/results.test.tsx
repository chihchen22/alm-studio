import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { headlinesFor, NOT_IN_RUN, signedMM, usdMM } from "@alm/reader";
import type { RunResult } from "@alm/engine";
import { overviewCells, overviewModel } from "../results/overview";
import { loadResults, planIdText } from "../pages/results/loadResults";
import { liveTabs } from "../pages/results/tabs";
import { OverviewTab } from "../pages/results/OverviewTab";
import { NoResultCard, NotImplementedBanner, ResultsLayerBody, RunIndexView, RunStrip } from "../pages/results/ResultsPage";
import { INFORMATIONAL_LAYERS } from "../pages/results/informational";
import { DETAIL, RESULT, freshResult } from "./fixtures/results";
import { mockFetch } from "./fixtures/run";

afterEach(() => vi.unstubAllGlobals());

const overviewHtml = (r: RunResult) =>
  renderToStaticMarkup(<OverviewTab ws="ws-a" runId="run-fixture" detail={DETAIL} result={r} query={{}} scenarioLabel={(id) => id} />);

describe("overviewModel", () => {
  it("paints every headline as its stored field, formatted like the viewer", () => {
    const r = freshResult();
    const cells = overviewCells(overviewModel(r));
    expect(cells.length).toBe(3 * r.eve.byScenario.length);
    for (const c of cells) {
      const s = c.headline.metric === "eve"
        ? r.eve.byScenario.find((x) => x.scenarioId === c.headline.scenarioId)!.eve
        : c.headline.metric === "nii12"
          ? r.nii.byScenario.find((x) => x.scenarioId === c.headline.scenarioId)!.totalNet12
          : r.nii.byScenario.find((x) => x.scenarioId === c.headline.scenarioId)!.totalNet24;
      expect(c.read).toEqual({ kind: "value", value: s });
      expect(c.text).toBe(c.headline.metric === "eve" ? usdMM(s) : signedMM(s));
    }
  });

  it("holds every headline the registry lists", () => {
    const ids = overviewCells(overviewModel(RESULT)).map((c) => c.headline.id);
    for (const h of headlinesFor(RESULT)) expect(ids).toContain(h.id);
  });

  it("a removed field paints Not in this run with the reason, never a number", () => {
    const r = freshResult();
    delete (r.nii.byScenario[2] as Partial<(typeof r.nii.byScenario)[number]>).totalNet12;
    const id = r.nii.byScenario[2]!.scenarioId;
    const cell = overviewCells(overviewModel(r)).find((c) => c.headline.id === `nii12:${id}`)!;
    expect(cell.text).toBe(NOT_IN_RUN);
    expect(cell.read.kind).toBe("not-in-run");
    if (cell.read.kind === "not-in-run") expect(cell.read.reason).toContain("totalNet12");
  });

  it("a removed block is named as missing and paints no number for it", () => {
    const r = freshResult() as Partial<RunResult>;
    delete r.eve;
    const m = overviewModel(r as RunResult);
    expect(m.missing).toEqual([{ block: "eve", reason: "The envelope carries no eve block." }]);
    expect(m.rows.every((row) => row.eve.text === NOT_IN_RUN)).toBe(true);
    expect(m.rows[0]!.nii12.read.kind).toBe("value");
  });

  it("a removed nii block is named as missing and paints no NII number", () => {
    const r = freshResult() as Partial<RunResult>;
    delete r.nii;
    const m = overviewModel(r as RunResult);
    expect(m.missing).toEqual([{ block: "nii", reason: "The envelope carries no nii block." }]);
    expect(m.rows.every((row) => row.nii12.text === NOT_IN_RUN && row.nii24.text === NOT_IN_RUN)).toBe(true);
    expect(m.rows[0]!.eve.read.kind).toBe("value");
  });

  it("a block with no scenario entries is named as missing", () => {
    const r = freshResult();
    r.eve.byScenario = [];
    expect(overviewModel(r).missing).toEqual([{ block: "eve", reason: "The eve block lists no scenarios." }]);
  });
});

describe("the Overview tab", () => {
  it("opens each scenario row on a row header (Row header scope 2)", () => {
    const html = overviewHtml(freshResult());
    // The fixture's 5 scenarios, each labelled by its id here.
    for (const id of ["S0", "S100", "S-100", "S200", "S-200"]) expect(html).toContain(`<tr><th scope="row">${id} <span class="mono muted">${id}</span></th>`);
    expect(html).not.toMatch(/<tbody><tr><td/);
  });
  it("a run without an eve block shows Not in this run with the reason; NII stays", () => {
    const r = freshResult() as Partial<RunResult>;
    delete r.eve;
    const html = overviewHtml(r as RunResult);
    expect(html).toContain('aria-label="EVE"');
    expect(html).toContain(NOT_IN_RUN);
    expect(html).toContain("The envelope carries no eve block.");
    expect(html).toContain(signedMM(RESULT.nii.byScenario[0]!.totalNet12));
    expect(html).not.toContain(usdMM(RESULT.eve.byScenario[0]!.eve));
  });

  it("a run without a nii block shows Not in this run with the reason; EVE stays", () => {
    const r = freshResult() as Partial<RunResult>;
    delete r.nii;
    const html = overviewHtml(r as RunResult);
    expect(html).toContain('aria-label="NII"');
    expect(html).toContain("The envelope carries no nii block.");
    expect(html).toContain(usdMM(RESULT.eve.byScenario[0]!.eve));
    expect(html).not.toContain(signedMM(RESULT.nii.byScenario[0]!.totalNet12));
  });

  it("a run with neither block renders no table, only the two reasons", () => {
    const r = freshResult() as Partial<RunResult>;
    delete r.eve;
    delete r.nii;
    const html = overviewHtml(r as RunResult);
    expect(html).toContain("The envelope carries no eve block.");
    expect(html).toContain("The envelope carries no nii block.");
    expect(html).not.toContain("<table");
  });
});

/** The stochastic note, restated from the approved design. */
const STOCH_NOTE = "This is a stochastic run. Its result is a Monte Carlo distribution envelope, not a deterministic result, so this layer does not read it; Stochastic distributions shows it.";
const ERR_NOTE = "The run is error; a result exists only for a run that ended in state done.";
const LINK = '<a class="btn btn-primary" href="#/ws/ws-a/results/stochastic?result=run-fixture">Open Stochastic distributions</a>';

describe("loadResults", () => {
  it("a stochastic run reads no result, and its note names Stochastic distributions", async () => {
    mockFetch([["/api/runs/run-fixture/result", RESULT], ["/api/runs/run-fixture", { ...DETAIL, mode: "stochastic" }]]);
    const d = await loadResults("run-fixture");
    expect(d.result).toBeNull();
    expect(d.note).toBe(STOCH_NOTE);
  });

  it("reads the run detail, then the result of a done run", async () => {
    mockFetch([["/api/runs/run-fixture/result", RESULT], ["/api/runs/run-fixture", DETAIL]]);
    const d = await loadResults("run-fixture");
    expect(d.detail.runId).toBe("run-fixture");
    expect(d.result?.eve.byScenario[0]!.eve).toBe(RESULT.eve.byScenario[0]!.eve);
    expect(d.note).toBeNull();
  });

  it("does not ask for a result of a run that did not finish", async () => {
    mockFetch([["/api/runs/run-x", { ...DETAIL, runId: "run-x", state: "error" }]]);
    const d = await loadResults("run-x");
    expect(d.result).toBeNull();
    expect(d.note).toBe("The run is error; a result exists only for a run that ended in state done.");
  });
});

describe("NoResultCard", () => {
  const det = { detail: { ...DETAIL, state: "error" as const }, result: null, note: ERR_NOTE };
  const sto = { detail: { ...DETAIL, mode: "stochastic" as const }, result: null, note: STOCH_NOTE };
  it("a deterministic run with the Results label: the section the Results layer always printed", () => {
    expect(renderToStaticMarkup(<NoResultCard ws="ws-a" runId="run-fixture" data={det} label="No result" />)).toBe(
      `<section class="card unobs-panel" aria-label="No result"><span class="status status-unobs">No result</span><p class="unobs-text">${ERR_NOTE}</p></section>`,
    );
  });
  it("a deterministic run with no label: the section the Dashboard always printed, with no aria-label", () => {
    expect(renderToStaticMarkup(<NoResultCard ws="ws-a" runId="run-fixture" data={det} />)).toBe(
      `<section class="card unobs-panel"><span class="status status-unobs">No result</span><p class="unobs-text">${ERR_NOTE}</p></section>`,
    );
  });
  it("a stochastic run adds the link to Stochastic distributions, with or without the label", () => {
    expect(renderToStaticMarkup(<NoResultCard ws="ws-a" runId="run-fixture" data={sto} label="No result" />)).toBe(
      `<section class="card unobs-panel" aria-label="No result"><span class="status status-unobs">No result</span><p class="unobs-text">${STOCH_NOTE}</p>${LINK}</section>`,
    );
    expect(renderToStaticMarkup(<NoResultCard ws="ws-a" runId="run-fixture" data={sto} />)).toBe(
      `<section class="card unobs-panel"><span class="status status-unobs">No result</span><p class="unobs-text">${STOCH_NOTE}</p>${LINK}</section>`,
    );
  });
  it("the Results layer body keeps its run strip and prints the card with the link for a stochastic run", () => {
    const html = renderToStaticMarkup(<ResultsLayerBody ws="ws-a" tab="eve" runId="run-fixture" data={sto} query={{}} />);
    expect(html).toContain('<div class="run-strip" role="group" aria-label="Run"');
    expect(html).toContain(`<section class="card unobs-panel" aria-label="No result"><span class="status status-unobs">No result</span><p class="unobs-text">${STOCH_NOTE}</p>${LINK}</section>`);
  });
  it("the Results layer body for a deterministic run with no result prints the unchanged section and no link", () => {
    const html = renderToStaticMarkup(<ResultsLayerBody ws="ws-a" tab="eve" runId="run-fixture" data={det} query={{}} />);
    expect(html).toContain('<div class="run-strip" role="group" aria-label="Run"');
    expect(html).toContain(`<section class="card unobs-panel" aria-label="No result"><span class="status status-unobs">No result</span><p class="unobs-text">${ERR_NOTE}</p></section>`);
    expect(html).not.toContain("Open Stochastic distributions");
  });
});

describe("the results page", () => {
  it("the run strip: the label on its own line first, then run, plan, book, market, status and Compare, labels for screen readers only, the source routes in its title", () => {
    const r = freshResult();
    r.provenance.planId = "plan-synthetic-2500-v1";
    const detail = { ...DETAIL, refs: { portfolioId: "book-x", marketId: "market-public-2026-03-31", scenarioSlateId: "slate-x", assumptionSetIds: [] } };
    const html = renderToStaticMarkup(<RunStrip ws="ws-a" runId="run-fixture" data={{ detail, result: r, note: null }} query={{}} />);
    expect(html).toBe(
      '<div class="run-strip" role="group" aria-label="Run" title="Source: /api/runs/run-fixture; plan id from /api/runs/run-fixture/result provenance.planId">'
      + '<span class="run-strip-label" title="Fixture run">Fixture run</span>'
      + '<span class="mono" title="Run"><span class="sr-only">Run: </span>run-fixture</span>'
      + '<span class="mono" title="Plan"><span class="sr-only">Plan: </span>plan-synthetic-2500-v1</span>'
      + '<span class="mono" title="Book"><span class="sr-only">Book: </span>book-x</span>'
      + '<span class="mono" title="Market"><span class="sr-only">Market: </span>market-public-2026-03-31</span>'
      + '<span class="status status-pass">done</span>'
      + '<a class="pill pill-quiet" href="#/ws/ws-a/results/compare?runs=run-fixture%2C&amp;table=nii">Compare with...</a>'
      // The curve line closes the strip; a detail with no curve line says so.
      + '<span class="run-strip-curve" title="Curve">Curve: Unobservable, the run detail carries no curve line</span>'
      + "</div>",
    );
    // A detail with no refs names neither its book nor its market, and says why.
    const noRefs = renderToStaticMarkup(<RunStrip ws="ws-a" runId="run-fixture" data={{ detail: { ...DETAIL, refs: undefined } as never, result: r, note: null }} query={{}} />);
    expect(noRefs).toContain('<span class="mono" title="Book"><span class="sr-only">Book: </span>Unobservable: the run detail carries no refs</span>');
    expect(noRefs).toContain('<span class="mono" title="Market"><span class="sr-only">Market: </span>Unobservable: the run detail carries no refs</span>');
    expect(planIdText({ detail: DETAIL, result: RESULT, note: null })).toBe("none: the run was not submitted from a plan");
    expect(planIdText({ detail: { ...DETAIL, state: "running" }, result: null, note: "The run is running." })).toBe("unknown until the run finishes");
    expect(planIdText({ detail: { ...DETAIL, state: "queued" }, result: null, note: "The run is queued." })).toBe("unknown until the run finishes");
  });

  it("the run strip's state chip: error and cancelled breach, queued and running neutral", () => {
    const chip = (state: "error" | "cancelled" | "queued" | "running") =>
      renderToStaticMarkup(<RunStrip ws="ws-a" runId="run-fixture" data={{ detail: { ...DETAIL, state }, result: null, note: `The run is ${state}.` }} query={{}} />);
    expect(chip("error")).toContain('<span class="status status-breach">error</span>');
    expect(chip("cancelled")).toContain('<span class="status status-breach">cancelled</span>');
    expect(chip("queued")).toContain('<span class="chip">queued</span>');
    expect(chip("running")).toContain('<span class="chip">running</span>');
  });

  it("a run that ended error or cancelled says it ended without a result, never that it has to finish", () => {
    for (const state of ["error", "cancelled"] as const) {
      const text = planIdText({ detail: { ...DETAIL, state }, result: null, note: `The run is ${state}.` });
      expect(text).toBe(`unknown: the run ended ${state} without a result`);
      expect(text).not.toContain("until the run finishes");
    }
  });

  it("a done run whose result was not read says so, with the load note, not that the run has to finish", () => {
    const note = "500: result.json unreadable";
    const text = planIdText({ detail: DETAIL, result: null, note });
    expect(text).toBe(`unknown: the result was not read. ${note}`);
    expect(text).not.toContain("until the run finishes");
    const html = renderToStaticMarkup(<RunStrip ws="ws-a" runId="run-fixture" data={{ detail: DETAIL, result: null, note }} query={{}} />);
    expect(html).toContain(note);
    expect(html).not.toContain("until the run finishes");
  });

  it("a stochastic run, done or not, says the result was not read and why", () => {
    const note = STOCH_NOTE;
    for (const state of ["done", "running"] as const) {
      const text = planIdText({ detail: { ...DETAIL, state, mode: "stochastic" }, result: null, note });
      expect(text).toBe(`unknown: the result was not read. ${note}`);
    }
  });

  it("the notImplemented banner lists each tag verbatim; an empty list renders nothing", () => {
    const html = renderToStaticMarkup(<NotImplementedBanner tags={[{ _tag: "NotImplemented", layer: "plan.stage.st-ftp", reason: "no plugin" } as never]} />);
    expect(html).toContain("plan.stage.st-ftp");
    expect(html).toContain("no plugin");
    expect(renderToStaticMarkup(<NotImplementedBanner tags={[]} />)).toBe("");
  });

  it("the attribution tags a new-business or assumption difference raises read as one plain line, the engine text kept behind a disclosure", () => {
    const reason = (id: string) => `scenario "${id}" changes assumptions or new business versus base; the multi-driver peel requires re-projecting partial configurations, which this prototype does not build`;
    const tags = ["S100", "S-100"].map((id) => ({ _tag: "NotImplemented", layer: `attribution.${id}`, reason: reason(id) }) as never);
    const html = renderToStaticMarkup(<NotImplementedBanner tags={[...tags, { _tag: "NotImplemented", layer: "plan.stage.st-ftp", reason: "no plugin" } as never]} />);
    const plain = html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/\s+/g, " ");
    expect(plain).toContain("Driver attribution was not built for S100, S-100: their assumptions or new business differ from base.");
    expect(html).toContain("<details");
    const summaryAt = html.indexOf("Driver attribution was not built");
    const detailsAt = html.indexOf("<details");
    expect(summaryAt).toBeGreaterThan(-1);
    expect(detailsAt).toBeGreaterThan(summaryAt);
    // Engine text verbatim, inside the disclosure only.
    expect(html.indexOf("which this prototype does not build")).toBeGreaterThan(detailsAt);
    expect(html.split("○ Not implemented").length - 1).toBe(2);
    expect(html).toContain("plan.stage.st-ftp");
  });

  it("a flat-basis note that left families out reads Informational; every other layer stays Not implemented (Studio Part 2 D16)", () => {
    const tags = [
      { _tag: "NotImplemented", layer: "plan.balance-basis.skipped", reason: "flat basis skipped 2 families: swaps, fees" },
      { _tag: "NotImplemented", layer: "plan.stage.st-ftp", reason: "no plugin" },
    ] as never[];
    const html = renderToStaticMarkup(<NotImplementedBanner tags={tags} />);
    expect(html.split("○ Informational").length - 1).toBe(1);
    expect(html.split("○ Not implemented").length - 1).toBe(1);
    expect(html.indexOf("○ Informational")).toBeLessThan(html.indexOf("plan.balance-basis.skipped"));
    expect(html.indexOf("○ Not implemented")).toBeGreaterThan(html.indexOf("plan.balance-basis.skipped"));
    // The card holds notes as well as layers that did not run, and its label and heading say so.
    expect(html).toContain('aria-label="Run notes"');
    expect(html).toContain("Layers that did not run, and notes");
  });

  it("a derived curve note reads Informational, not as a layer that failed to run (Piece B, step B2)", () => {
    const tags = [
      { _tag: "NotImplemented", layer: "plan.derived-curve.index-only", reason: "derived curve Treasury over SOFR (ust-sofr) adds a constant spread to index resets only (sofr-3m-idx); mortgages, client rates, new business and discounting read the base curve" },
      { _tag: "NotImplemented", layer: "plan.balance-basis.skipped", reason: "flat basis skipped 2 families: swaps, fees" },
      { _tag: "NotImplemented", layer: "plan.stage.st-ftp", reason: "no plugin" },
    ] as never[];
    const html = renderToStaticMarkup(<NotImplementedBanner tags={tags} />);
    expect(html.split("○ Informational").length - 1).toBe(2);
    expect(html.split("○ Not implemented").length - 1).toBe(1);
    expect(html.indexOf("○ Informational")).toBeLessThan(html.indexOf("plan.derived-curve.index-only"));
    expect(html).toContain("adds a constant spread to index resets only (sofr-3m-idx)");
  });
  it("the informational layers are the flat-basis note, the derived curve note, the rate index formula note and the index history note, and no other", () => {
    expect([...INFORMATIONAL_LAYERS].sort()).toEqual(["plan.balance-basis.skipped", "plan.derived-curve.index-only", "plan.rate-index.formula", "plan.rate-index.history"]);
  });

  it("the EVE layer shows the EVE table and its export link", () => {
    const html = renderToStaticMarkup(<ResultsLayerBody ws="ws-a" tab="eve" runId="run-fixture" data={{ detail: DETAIL, result: RESULT, note: null }} query={{ run: "run-fixture" }} />);
    expect(html).toContain("Economic value of equity");
    expect(html).toContain(usdMM(RESULT.eve.byScenario[0]!.eve));
    expect(html).toContain('href="/api/runs/run-fixture/export/eve.csv"');
  });

  it("a measure layer renders one tab body, no tab bar, and its export links", () => {
    const data = { detail: DETAIL, result: RESULT, note: null };
    const html = renderToStaticMarkup(<ResultsLayerBody ws="ws-a" tab="gap" runId="run-1" data={data} query={{ run: "run-1" }} />);
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain('href="/api/runs/run-1/export/repricing-gap.csv"');
    expect(html).toContain('href="/api/runs/run-1/export/liquidity-gap.csv"');
    expect(html).toContain('href="/api/runs/run-1/export/cashflows.csv"');
    expect(html).toContain("Source: gap.repricing[scenarioId=S0].rows");
  });

  it("FTP has no export bar; its one export link is ftp.csv on its own card", () => {
    const data = { detail: DETAIL, result: RESULT, note: null };
    const html = renderToStaticMarkup(<ResultsLayerBody ws="ws-a" tab="ftp" runId="run-1" data={data} query={{ run: "run-1" }} />);
    expect(html).not.toContain('class="export-bar"');
    expect(html.match(/\/export\/[a-z-]+\.csv/g)).toEqual(["/export/ftp.csv"]);
  });

  it("a run with no result says why and shows no export link and no tab body", () => {
    const html = renderToStaticMarkup(<ResultsLayerBody ws="ws-a" tab="eve" runId="r" data={{ detail: { ...DETAIL, state: "cancelled" }, result: null, note: "The run is cancelled." }} query={{}} />);
    expect(html).toContain("The run is cancelled.");
    expect(html).not.toContain("/export/");
    expect(html).not.toContain("Economic value of equity");
  });

  it("with no runs the index says so and points at Run", () => {
    const html = renderToStaticMarkup(<RunIndexView ws="ws-a" rows={[]} query={{}} />);
    expect(html).toContain("No runs yet, press Run");
    expect(html).toContain('href="#/ws/ws-a/run/queue"');
  });

  it("Go to Run lands on the queue of the workspace and leaves page state behind", () => {
    const html = renderToStaticMarkup(<RunIndexView ws="ws-a" rows={[]} query={{ book: "book-x", asOf: "market-1", plan: "plan-a", tab: "eve" }} />);
    expect(html).toContain('<a class="btn btn-primary" href="#/ws/ws-a/run/queue">Go to Run</a>');
  });

  it("the tab registry follows the spec order", () => {
    expect(liveTabs()[0]!.id).toBe("overview");
  });
});
