// apps/studio/src/__tests__/resultsAttrLenses.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NOT_IN_RUN, sig, signedMM, signedPct, usdMM } from "@alm/reader";
import { waterfallLayout, barBox } from "../results/waterfall";
import { headroomText, lensRows, type LensReadingView } from "../results/lensRows";
import { AttributionTab } from "../pages/results/AttributionTab";
import { LensCard, LensesTab, NO_SCENARIO_HEADLINE } from "../pages/results/LensesTab";
import { liveTabs } from "../pages/results/tabs";
import { DETAIL, RESULT, freshResult } from "./fixtures/results";

const props = (query: Record<string, string> = {}, result = RESULT) => ({ runId: "run-fixture", detail: DETAIL, result, query, scenarioLabel: (id: string) => id });
const H = RESULT.attribution.headlines[2]!; // eve, S100, 77 contributions in the fixture

describe("waterfallLayout", () => {
  it("anchors on the stored base and scenario values and draws each stored contribution", () => {
    const w = waterfallLayout(H, false);
    expect(w.bars[0]).toMatchObject({ label: "Base", amount: H.baseValue, from: 0, to: H.baseValue, kind: "anchor" });
    expect(w.bars[w.bars.length - 1]).toMatchObject({ label: "Scenario", amount: H.scenarioValue, from: 0, to: H.scenarioValue, kind: "anchor" });
    expect(w.bars.slice(1, -1).map((b) => b.amount)).toEqual(H.contributions.map((c) => c.amount));
    expect(w.bars.some((b) => /residual/i.test(b.label))).toBe(false);
  });

  it("the running position only places bars: each contribution starts where the last ended", () => {
    const bars = waterfallLayout(H, false).bars.slice(1, -1);
    expect(bars[0]!.from).toBe(H.baseValue);
    for (let i = 1; i < bars.length; i++) expect(bars[i]!.from).toBe(bars[i - 1]!.to);
  });

  it("drops exact zeros from the chart by default; geometry stays in percent of the span", () => {
    const w = waterfallLayout(H);
    expect(w.bars.slice(1, -1).every((b) => b.amount !== 0)).toBe(true);
    for (const b of w.bars) {
      const box = barBox(b, w.lo, w.hi);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.left + box.width).toBeLessThanOrEqual(100.0000001);
    }
  });
});

describe("AttributionTab", () => {
  it("prints the stored residual and total and lists every stored contribution", () => {
    const html = renderToStaticMarkup(<AttributionTab ws="ws-a" {...props({ headline: "2" })} />);
    expect(html).toContain(sig(H.residual));
    expect(html).toContain(signedMM(H.totalDelta));
    expect((html.match(/<tr class="attr-row">/g) ?? []).length).toBe(H.contributions.length);
    // Row header scope 2: each of the fixture's 77 contribution rows opens on its family as a row header.
    expect((html.match(/<tr class="attr-row"><th scope="row" class="mono">/g) ?? []).length).toBe(77);
  });

  it("prints the base and scenario anchors as the viewer does (usdMM) and each step as signedMM", () => {
    const html = renderToStaticMarkup(<AttributionTab ws="ws-a" {...props({ headline: "2" })} />);
    expect(html).toContain(`title="Base: ${usdMM(H.baseValue)}"`);
    expect(html).toContain(`title="Scenario: ${usdMM(H.scenarioValue)}"`);
    const step = waterfallLayout(H).bars[1]!;
    expect(html).toContain(`title="${step.label}: ${signedMM(step.amount)}"`);
  });

  it("no headline is not in this run, with its reason", () => {
    const r = freshResult();
    r.attribution.headlines = [];
    const html = renderToStaticMarkup(<AttributionTab ws="ws-a" {...props({}, r)} />);
    expect(html).toContain(NOT_IN_RUN);
    expect(html).toContain("attribution.headlines is empty");
  });
});

const READING = {
  lensId: "rate-demo-v1",
  objective: "earnings",
  baseScenarioId: "S0",
  byScenario: [{
    scenarioId: "S100",
    constraints: [
      { constraintId: "c1", reader: "deltaNiiPct", op: ">=", limit: -0.1, value: -0.05, headroom: 0.5, headroomBasis: "fraction", status: "pass" },
      { constraintId: "c2", reader: "customMetric", op: "<=", limit: 0, status: "unobservable", reason: "no custom metric stage ran" },
    ],
    status: "pass",
  }],
  status: "pass",
} as unknown as LensReadingView;

describe("lenses", () => {
  it("flattens constraints with value, limit, headroom, basis and the unobservable reason", () => {
    const rows = lensRows(READING);
    expect(rows[0]).toEqual({ scenarioId: "S100", constraintId: "c1", reader: "deltaNiiPct", op: ">=", limit: -0.1, value: -0.05, headroom: 0.5, basis: "fraction", status: "pass", reason: null });
    expect(rows[1]).toMatchObject({ value: null, headroom: null, basis: null, status: "unobservable", reason: "no custom metric stage ran" });
    expect(headroomText(rows[0]!)).toBe(signedPct(0.5));
    expect(headroomText(rows[1]!)).toBe("");
  });

  it("the lens card prints the reason for an unobservable constraint and no number for it", () => {
    const html = renderToStaticMarkup(<LensCard reading={READING} label={(id) => id} />);
    expect(html).toContain("no custom metric stage ran");
    expect(html).toContain(sig(-0.05));
    expect(html).toContain("rate-demo-v1");
    // Row header scope 2: each constraint row opens on its scenario as a row header.
    expect(html).toContain('<tr><th scope="row">S100</th><td class="mono">c1</td>');
    expect(html).toContain('<tr><th scope="row">S100</th><td class="mono">c2</td>');
  });

  it("every blank cell of an unobservable constraint carries the reason as its title", () => {
    const html = renderToStaticMarkup(<LensCard reading={READING} label={(id) => id} />);
    expect((html.match(/<td[^>]*title="no custom metric stage ran"[^>]*><\/td>/g) ?? []).length).toBe(3);
    const empty = html.match(/<td[^>]*><\/td>/g) ?? [];
    expect(empty.length).toBe(3);
    for (const td of empty) expect(td).toContain('title="no custom metric stage ran"');
  });

  it("reader params and the stored lens headline print as stored", () => {
    const withParams = structuredClone(READING) as unknown as { byScenario: Array<{ constraints: Array<Record<string, unknown>> }>; headline?: number; worst?: unknown };
    withParams.byScenario[0]!.constraints[0]!.params = { horizonMonths: 12 };
    withParams.headline = 0.5;
    withParams.worst = { scenarioId: "S100", constraintId: "c1" };
    const html = renderToStaticMarkup(<LensCard reading={withParams as unknown as LensReadingView} label={(id) => id} />);
    expect(html).toContain("horizonMonths=12");
    expect(html).toContain(signedPct(0.5));
    const none = renderToStaticMarkup(<LensCard reading={READING} label={(id) => id} />);
    expect(none).toContain("no scenario has an observable constraint with a nonzero limit");
  });

  it("each scenario's stored roll-up prints: status, and the headline at its worst constraint", () => {
    const two = structuredClone(READING) as unknown as { byScenario: Array<Record<string, unknown>> };
    two.byScenario[0]!.headline = 0.5;
    two.byScenario[0]!.worstConstraintId = "c1";
    two.byScenario.push({ scenarioId: "S-100", constraints: [], status: "breach" });
    const html = renderToStaticMarkup(<LensCard reading={two as unknown as LensReadingView} label={(id) => `L:${id}`} />);
    expect(html).toContain('<dt>L:S100</dt><dd><span class="status status-pass">pass</span> min headroom <span class="num">' + signedPct(0.5) + '</span> at constraint <span class="mono">c1</span>');
    expect(html).toContain('<dt>L:S-100</dt><dd><span class="status status-breach">breach</span> <span class="status status-unobs" title="' + NO_SCENARIO_HEADLINE + '">Unobservable</span>');
    expect(html).toContain(NO_SCENARIO_HEADLINE + ".");
  });

  it("the tab reads the lenses route; both tabs are registered", () => {
    expect(renderToStaticMarkup(<LensesTab ws="ws-a" {...props()} />)).toContain("Reading the lenses");
    const own = ["attribution", "lenses"];
    expect(liveTabs().map((t) => t.id).filter((id) => own.includes(id))).toEqual(own);
  });
});
