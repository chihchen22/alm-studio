// apps/studio/src/__tests__/dashboardPage.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunSummary } from "@alm/reader";
import { DashboardPage, DashboardView, latestRunFor } from "../pages/dashboard/DashboardPage";
import { RunStrip } from "../pages/results/ResultsPage";

const model = {
  cards: [
    { key: "eve-base", label: "EVE, base", value: "$574.3M", sub: "Base", field: "eve.byScenario[scenarioId=S0].eve", tone: null, absent: false },
    { key: "eve-worst", label: "Worst EVE shock", value: "−$186.3M", sub: "−32.4% · +200bp", field: "eve.byScenario[scenarioId=S200].deltaEveVsBase", tone: "neg", absent: false },
    { key: "nii12", label: "NII, 12 months", value: "$20.0M", sub: "Lowest −$12.1M · -200bp", field: "nii.byScenario[scenarioId=S0].totalNet12", tone: null, absent: false },
    { key: "stress", label: "Stress scenario", value: "Not in this run", sub: "Every scenario besides base is on the regulatory grid.", field: null, tone: null, absent: true },
  ],
  rows: [{ scenarioId: "S0", label: "Base", eve: "$574.3M", deltaEve: "$0.0M", deltaTone: null, nii12: "$20.0M", nii24: "$36.8M", newBusiness: false }],
  newBusinessNote: null,
} as const;

/** Controls (limits): the Limit use card's rows, restated, as limitUseModel builds them. */
const limitUse = {
  state: "ok",
  rows: [
    { lensId: "rate-demo-v1", label: "Interest-rate risk (demonstration limits)", status: "pass", statusText: "✓ Pass", statusClass: "status status-pass", headroom: "+12.34% of limit", worst: "at S200, constraint eve-15" },
    { lensId: "balance-demo-v1", label: "Balance runoff", status: "breach", statusText: "✕ Breach", statusClass: "status status-breach", headroom: "−30.00% of limit", worst: "at S-100, constraint runoff-50" },
    { lensId: "capital-demo-v1", label: "Capital (demonstration limits)", status: "unobservable", statusText: "Unobservable", statusClass: "status status-unobs", headroom: null, worst: null },
  ],
} as const;

describe("Dashboard view", () => {
  it("prints each card value with its stored field as the hover title", () => {
    const html = renderToStaticMarkup(<DashboardView runId="r1" model={model as never} limitUse={limitUse as never} />);
    expect(html).toContain('title="eve.byScenario[scenarioId=S200].deltaEveVsBase"');
    expect(html).toContain("−$186.3M");
    expect(html).toContain('<div class="stat-value is-neg" title="eve.byScenario[scenarioId=S200].deltaEveVsBase">−$186.3M</div>');
    expect(html).toContain("Source: /api/runs/r1/result");
  });
  it("renders the live Limit use card, not the Soon limits card (Controls)", () => {
    const html = renderToStaticMarkup(<DashboardView runId="r1" model={model as never} limitUse={limitUse as never} />);
    expect(html).not.toContain("soon-panel");
    expect(html).not.toContain("Soon");
    expect(html).not.toContain("Piece 8");
    expect(html).not.toContain("Risk appetite and limits");
    expect(html).toContain('<section class="card table-card" aria-label="Limit use"><div class="card-title">Limit use</div>');
    expect(html).toContain('<th scope="row" title="rate-demo-v1">Interest-rate risk (demonstration limits)</th><td><span class="status status-pass">✓ Pass</span></td><td class="num">+12.34% of limit <span class="muted">at S200, constraint eve-15</span></td>');
    expect(html).toContain('<td><span class="status status-breach">✕ Breach</span></td><td class="num">−30.00% of limit <span class="muted">at S-100, constraint runoff-50</span></td>');
    expect(html).toContain('<td><span class="status status-unobs">Unobservable</span></td><td class="num"><span class="muted">No headline stored</span></td>');
    expect(html).toContain("Demonstration values: every limit is illustrative, and none is a calibrated or governed limit.");
    expect(html).toContain("Source: /api/runs/r1/lenses, fields lenses[].status, .headline, .worst; labels from /api/lenses");
  });
  it("a failed lens read prints an inline error inside the card and the rest of the Dashboard still renders", () => {
    const html = renderToStaticMarkup(<DashboardView runId="r1" model={model as never} limitUse={{ state: "error", text: "500: lens store unreadable" }} />);
    expect(html).toContain('<p role="alert"><span class="status status-breach">✕ Lenses refused</span> 500: lens store unreadable</p>');
    expect(html).toContain('aria-label="Limit use"');
    expect(html).toContain("Source: /api/runs/r1/result");
    expect(html).toContain('<th scope="row" title="S0">Base</th>');
  });
  it("while the lenses load the card says so and the rest of the Dashboard renders", () => {
    const html = renderToStaticMarkup(<DashboardView runId="r1" model={model as never} limitUse={{ state: "loading" }} />);
    expect(html).toContain("Reading the lenses for r1");
    expect(html).toContain('<th scope="row" title="S0">Base</th>');
  });
  it("an empty lens store says so, with no row", () => {
    const html = renderToStaticMarkup(<DashboardView runId="r1" model={model as never} limitUse={{ state: "ok", rows: [] }} />);
    expect(html).toContain("The store holds no lens definition, so /api/runs/r1/lenses returned none.");
  });
  it("an absent card prints the Not in this run chip, not a headline figure", () => {
    const html = renderToStaticMarkup(<DashboardView runId="r1" model={model as never} limitUse={limitUse as never} />);
    expect(html).toContain('<div class="stat-label">Stress scenario</div><span class="status status-unobs">Not in this run</span><div class="stat-note">Every scenario besides base is on the regulatory grid.</div>');
    expect(html).not.toContain(">Not in this run</div>");
  });
  it("a table row prints the scenario label, the id in the title", () => {
    const html = renderToStaticMarkup(<DashboardView runId="r1" model={model as never} limitUse={limitUse as never} />);
    expect(html).toContain('<th scope="row" title="S0">Base</th>');
  });
});

describe("Dashboard with no book", () => {
  it("prints the no-book sentence and nothing of a book", () => {
    const html = renderToStaticMarkup(<DashboardPage ws="ws-a" bookId={null} marketId="m1" query={{ book: "" }} viewerBase="/" />);
    expect(html).toBe(
      '<section class="card unobs-panel" aria-label="No book"><span class="status status-unobs">No book</span>'
      + '<p class="unobs-text">No book selected. Pick a book in the Book pill.</p></section>',
    );
    expect(html).not.toContain("Go to Runs");
    expect(html).not.toContain("No done run for book");
    expect(html).not.toContain("Reading the run list");
    expect(html).not.toContain("/api/catalog/portfolios");
  });
});

describe("Picked-run note in the run strip", () => {
  const data = { detail: { runId: "run-7", state: "done", label: "L", refs: { portfolioId: "b1", marketId: "m1", scenarioSlateId: "s", assumptionSetIds: [] }, scenarios: [] }, result: null, note: "n" } as never;
  it("appears when the page picked the run itself", () => {
    expect(renderToStaticMarkup(<RunStrip ws="ws-a" runId="run-7" data={data} query={{}} picked={true} />)).toContain("Showing the latest done run. Pick another in the Run pill.");
  });
  it("is absent when the run came from the Run pill", () => {
    expect(renderToStaticMarkup(<RunStrip ws="ws-a" runId="run-7" data={data} query={{}} picked={false} />)).not.toContain("Showing the latest done run");
    expect(renderToStaticMarkup(<RunStrip ws="ws-a" runId="run-7" data={data} query={{}} />)).not.toContain("Showing the latest done run");
  });
});

describe("latestRunFor", () => {
  const runs = [
    { runId: "a", state: "done", submittedAt: "2026-09-26T01:00:00Z", refs: { portfolioId: "b1", marketId: "m", scenarioSlateId: "s", assumptionSetIds: [] } },
    { runId: "b", state: "done", submittedAt: "2026-09-26T03:00:00Z", refs: { portfolioId: "b2", marketId: "m", scenarioSlateId: "s", assumptionSetIds: [] } },
    { runId: "c", state: "error", submittedAt: "2026-09-26T04:00:00Z", refs: { portfolioId: "b1", marketId: "m", scenarioSlateId: "s", assumptionSetIds: [] } },
    { runId: "d", state: "done", mode: "stochastic", submittedAt: "2026-09-26T05:00:00Z", refs: { portfolioId: "b1", marketId: "m", scenarioSlateId: "s", assumptionSetIds: [] } },
  ] as unknown as RunSummary[];
  it("picks the newest done deterministic run of the book", () => {
    expect(latestRunFor(runs, "b1")).toBe("a");
    expect(latestRunFor(runs, "b3")).toBeNull();
  });
});
