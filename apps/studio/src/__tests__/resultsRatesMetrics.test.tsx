// apps/studio/src/__tests__/resultsRatesMetrics.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CustomMetricResult, RateDocument, RunResult } from "@alm/engine";
import { ApiError, formatValue, NOT_IN_RUN, pctPoints, UNOBSERVABLE } from "@alm/reader";
import { baseScenarioId, RatesBody, RatesTab, RatesView, styleAt } from "../pages/results/RatesTab";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { LinePlot, type LinePlotProps, type PlotSeries } from "../charts/LinePlot";
import { tipRows } from "../charts/plotScale";
import { MetricsTab } from "../pages/results/MetricsTab";
import { liveTabs } from "../pages/results/tabs";
import { DETAIL, RESULT, freshResult } from "./fixtures/results";

const props = (result: RunResult = RESULT, query: Record<string, string> = {}) => ({ runId: "run-fixture", detail: DETAIL, result, query, scenarioLabel: (id: string) => id });

/** A curve at its own nodes with the engine's identity df = exp(-z t) (curveNodesOf). */
const T = [1, 5, 10];
const curve = (z: number[]) => ({ t: T, z, df: z.map((zi, i) => Math.exp(-zi * T[i]!)) });
/** The builder's own omission text for a scenario naming a registered non-deterministic model (rateDocument.ts). */
const OMITTED = 'rate path model "hw1f-demo" is not the deterministic built-in; the rate document recomputes only the deterministic path';
/** The same text as renderToStaticMarkup escapes it. */
const OMITTED_HTML = OMITTED.replace(/"/g, "&quot;");
const DOC = {
  schemaVersion: "1.0.0", kind: "rate-document", runId: "run-fixture", mode: "deterministic",
  grid: { horizonMonths: 2, dtYears: 1 / 12, asOf: "2026-03-31" },
  base: curve([0.04, 0.042, 0.045]),
  scenarios: [
    { scenarioId: "S0", rateSpecKind: "base", ratePathModel: "deterministic", curve: curve([0.04, 0.042, 0.045]), path: { times: [0, 1 / 12, 2 / 12], rate: [0.041, 0.0415] } },
    { scenarioId: "S100", rateSpecKind: "parallel", ratePathModel: "hw1f-demo", curve: curve([0.05, 0.052, 0.055]), pathOmitted: OMITTED },
  ],
} as unknown as RateDocument;

describe("RatesView", () => {
  it("draws the stored curves and paths in percent and names an omitted path with its reason", () => {
    const html = renderToStaticMarkup(<RatesView doc={DOC} label={(id) => id} runId="run-fixture" />);
    expect(html).toContain(pctPoints(0.052 * 100));
    expect(html).toContain(pctPoints(0.0415 * 100));
    expect(html).toContain(OMITTED_HTML);
    expect(html).toContain("One-month rate path by scenario");
  });

  it("paints each scenario's stored spec kind, path model and the document grid", () => {
    const html = renderToStaticMarkup(<RatesView doc={DOC} label={(id) => id} runId="run-fixture" />);
    expect(html).toContain("parallel");
    expect(html).toContain("hw1f-demo");
    expect(html).toContain("2026-03-31");
    expect(html).toContain("deterministic");
  });

  it("a document the row builders refuse shows the builder's message, not a chart", () => {
    const bad = structuredClone(DOC) as unknown as { scenarios: Array<{ curve: { t: number[] } }> };
    bad.scenarios[1]!.curve.t = [1, 5];
    const html = renderToStaticMarkup(<RatesView doc={bad as unknown as RateDocument} label={(id) => id} runId="r" />);
    expect(html).toContain("curve has 2 nodes");
    expect(html).not.toContain("<svg");
  });

  it("every scenario omitting its path draws no path chart and lists each omission with its reason", () => {
    const none = structuredClone(DOC) as unknown as { scenarios: Array<Record<string, unknown>> };
    const s0 = none.scenarios[0]!;
    delete s0.path;
    s0.ratePathModel = "hw1f-demo";
    s0.pathOmitted = OMITTED;
    const html = renderToStaticMarkup(<RatesView doc={none as unknown as RateDocument} label={(id) => id} runId="r" />);
    expect(html).not.toContain("One-month rate path by scenario");
    expect(html).toContain("Zero curve by scenario");
    const list = html.slice(html.indexOf("Paths the document omits"), html.indexOf("Scenarios in the rate document"));
    expect(list).toContain(`<span class="mono">S0</span> ${OMITTED_HTML}`);
    expect(list).toContain(`<span class="mono">S100</span> ${OMITTED_HTML}`);
  });

  it("a stored stochastic fan is named in the footer as not drawn", () => {
    const fan = { scenarioId: "S0", nPaths: 500, a: 0.03, sigma: 0.01, times: [1 / 12, 2 / 12], mean: [0.041, 0.042], quantiles: [0.05, 0.25, 0.5, 0.75, 0.95].map((p) => ({ p, values: [0.04, 0.041] })) };
    const html = renderToStaticMarkup(<RatesView doc={{ ...DOC, mode: "stochastic", stochastic: fan } as RateDocument} label={(id) => id} runId="r" />);
    expect(html).toContain("stochastic short-rate fan for S0 (500 paths); this tab does not draw it");
    expect(renderToStaticMarkup(<RatesView doc={DOC} label={(id) => id} runId="r" />)).not.toContain("short-rate fan");
  });

  it("a 1.2.0 document keeps the Hull-White fan wording; a BGM fan is named as the 1-day saved forward of the BGM model", () => {
    const quantiles = [0.05, 0.25, 0.5, 0.75, 0.95].map((p) => ({ p, values: [0.04, 0.041] }));
    const hwFan = { scenarioId: "S0", nPaths: 256, a: 0.03, sigma: 0.01, times: [1 / 12, 2 / 12], mean: [0.041, 0.042], quantiles };
    const hw = renderToStaticMarkup(<RatesView doc={{ ...DOC, schemaVersion: "1.2.0", mode: "stochastic", stochastic: hwFan } as RateDocument} label={(id) => id} runId="r" />);
    expect(hw).toContain("The document also stores a stochastic short-rate fan for S0 (256 paths); this tab does not draw it.");
    const bgm = { a: 0.11, b: 0.22, c: 0.33, d: 0.044, beta: 0.15, volScalar: 1, displacement: 0.05, cevBeta: 0.5 };
    const bgmFan = { scenarioId: "S0", nPaths: 64, model: "bgm-lmm-2f", bgm, times: [1 / 12, 2 / 12], mean: [0.041, 0.042], quantiles };
    const html = renderToStaticMarkup(<RatesView doc={{ ...DOC, schemaVersion: "1.2.0", mode: "stochastic", stochastic: bgmFan } as RateDocument} label={(id) => id} runId="r" />);
    expect(html).toContain(
      'The document also stores a BGM fan for S0 (64 paths, model <span class="mono">bgm-lmm-2f</span>): the 1-day saved forward across paths, the short-rate analog BGM discounting uses; this tab does not draw it.',
    );
    expect(html).not.toContain("stochastic short-rate fan");
  });

  it("styles the scenarios in turn: the six series colours, then the same six dashed; the tab reads the route", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 11, 12].map(styleAt)).toEqual([
      { tone: "accent", dash: false }, { tone: "second", dash: false }, { tone: "third", dash: false },
      { tone: "fourth", dash: false }, { tone: "fifth", dash: false }, { tone: "sixth", dash: false },
      { tone: "accent", dash: true }, { tone: "second", dash: true }, { tone: "sixth", dash: true }, { tone: "accent", dash: true },
    ]);
    expect(renderToStaticMarkup(<RatesTab ws="ws-a" {...props()} />)).toContain("Reading the rate document");
  });

  /** Seven scenarios, as on the seeded plan with one built shock (spec Section 5.5 items 1 and 2). */
  const SEVEN = ["S0", "S100", "S-100", "S200", "S-200", "DOWN400", "TW-50-75"];
  const DOC7 = {
    ...DOC,
    scenarios: SEVEN.map((scenarioId) => ({
      scenarioId, rateSpecKind: "parallel", ratePathModel: "deterministic", curve: curve([0.04, 0.042, 0.045]), path: { times: [0, 1 / 12, 2 / 12], rate: [0.041, 0.0415] },
    })),
  } as unknown as RateDocument;
  const LABEL = (id: string) => (id === "TW-50-75" ? "Twist -50/+100bp" : id === "DOWN400" ? "-400bp" : `L${id}`);
  /** Each series line's stroke and dash, in drawing order (LinePlot paths since Polish 10 T2; Lines polylines before). */
  const strokes = (svg: string) => [...svg.matchAll(/<path class="lp-line" [^>]*>/g)].map((m) => [m[0].match(/ stroke="([^"]+)"/)![1], m[0].match(/stroke-dasharray="([^"]+)"/)?.[1] ?? null]);
  const SIX = [1, 2, 3, 4, 5, 6].map((k) => [`var(--series-${k})`, null]);

  it("gives the seventh scenario the first colour dashed on both charts, and draws the base curve last, dashed and muted", () => {
    const html = renderToStaticMarkup(<RatesView doc={DOC7} label={LABEL} runId="r" />);
    const [zero, path] = html.match(/<svg[\s\S]*?<\/svg>/g)!;
    expect(strokes(zero!)).toEqual([...SIX, ["var(--series-1)", "6 4"], ["var(--muted)", "6 4"]]);
    expect(strokes(path!)).toEqual([...SIX, ["var(--series-1)", "6 4"]]);
    // Each legend key is a LinePlot chip, pressed while its line shows (Polish 10 T2).
    expect(html).toContain('<button type="button" class="lp-chip" aria-pressed="true"><i class="key-line" style="background:repeating-linear-gradient(90deg, var(--series-1) 0 4px, transparent 4px 7px)"></i>Twist -50/+100bp TW-50-75</button>');
    expect(html).toContain('<button type="button" class="lp-chip" aria-pressed="true"><i class="key-line" style="background:repeating-linear-gradient(90deg, var(--muted) 0 4px, transparent 4px 7px)"></i>Base curve</button>');
  });

  it("names each scenario by its label and its id, as the EVE layer does: legends, Show table heads and the scenario table", () => {
    const html = renderToStaticMarkup(<RatesView doc={DOC7} label={LABEL} runId="r" />);
    expect(html).toContain('<i class="key-line" style="background:var(--series-6)"></i>-400bp DOWN400</button>');
    expect(html).toContain('<th scope="col" class="num">Twist -50/+100bp TW-50-75</th>');
    expect(html).toContain('<th scope="col" class="num">LS0 S0</th>');
    expect(html).toContain('<th scope="col" class="num">Base curve</th>');
    expect(html).toContain('<th scope="row">Twist -50/+100bp <span class="mono muted">TW-50-75</span></th>');
    expect(html).toContain('<th scope="row">LS0 <span class="mono muted">S0</span></th>');
  });

  it("labels the stored 1M node 1M on the zero curve chart (Polish 1 S5)", () => {
    const T1M = [0.083333, 1, 10];
    const c = (z: number[]) => ({ t: T1M, z, df: z.map((zi, i) => Math.exp(-zi * T1M[i]!)) });
    const doc = { ...DOC, base: c([0.04, 0.042, 0.045]), scenarios: [{ ...DOC.scenarios[0]!, curve: c([0.04, 0.042, 0.045]) }] } as unknown as RateDocument;
    const html = renderToStaticMarkup(<RatesView doc={doc} label={(id) => id} runId="r" />);
    // The x tick is SVG text on the tenor axis (Polish 10 T2); the Show table's Point cell is unchanged.
    expect(html).toContain(">1M</text>");
    expect(html).toContain('<th scope="row">1M</th>');
    expect(html).not.toContain("0.083333");
    // Ruling M11: the grid step prints through the same label (1/12 year reads 1M).
    expect(html).toContain("horizon 2 months on a grid step of 1M.");
  });

  // Through LinePlot (Polish 10 T2).
  /** S0 is the one base-kind scenario and S100 a parallel one, both with paths. */
  const DOCP = {
    ...DOC,
    scenarios: [
      DOC.scenarios[0]!,
      { scenarioId: "S100", rateSpecKind: "parallel", ratePathModel: "deterministic", curve: curve([0.05, 0.052, 0.055]), path: { times: [0, 1 / 12, 2 / 12], rate: [0.051, 0.0505] } },
    ],
  } as unknown as RateDocument;

  it("names the base scenario only when exactly one scenario's stored spec kind is base", () => {
    expect(baseScenarioId(DOC)).toBe("S0");
    expect(baseScenarioId(DOC7)).toBeUndefined();
    const two = { ...DOC, scenarios: [DOC.scenarios[0]!, { ...DOC.scenarios[0]!, scenarioId: "S0b" }] } as unknown as RateDocument;
    expect(baseScenarioId(two)).toBeUndefined();
  });

  it("puts tenors to scale and gives the zero curve table each scenario's gap to the base curve in bp", () => {
    const html = renderToStaticMarkup(<RatesView doc={DOCP} label={(id) => id} runId="r" />);
    const zero = html.slice(html.indexOf("Zero curve by scenario"), html.indexOf("One-month rate path by scenario"));
    expect(zero).toContain("continuously compounded zero rate, percent; tenor to scale on a square-root axis");
    // A scenario whose label is its id prints it once (Polish 11, F11): S0, not S0 S0.
    expect(zero).toContain('<th scope="col" class="num">S0 vs base, bp</th><th scope="col" class="num">S100 vs base, bp</th>');
    expect(zero).toContain('<tr><th scope="row">1Y</th><td class="num lvl">4.00%</td><td class="num lvl">5.00%</td><td class="num lvl">4.00%</td><td class="num lvl">0</td><td class="num lvl">+100</td></tr>');
    expect(zero).toContain("The vs base, bp column (tooltip and Show table) is the scenario rate minus the base curve&#x27;s rate at the same tenor, in bp.");
  });

  it("gives the path chart a drag zoom, year ticks, no markers, and a gap to the one base scenario", () => {
    const html = renderToStaticMarkup(<RatesView doc={DOCP} label={(id) => id} runId="r" />);
    const path = html.slice(html.indexOf("One-month rate path by scenario"), html.indexOf("Scenarios in the rate document"));
    expect(path).toContain("<span>Drag to zoom</span>");
    expect(path).toContain(">M0</text>");
    expect(path).not.toContain("lp-mark");
    expect(path).toContain('<th scope="col" class="num">S100 vs base, bp</th>');
    expect(path).toContain('<tr><th scope="row">M0</th><td class="num lvl">4.10%</td><td class="num lvl">5.10%</td><td class="num lvl">+100</td></tr>');
    expect(path).toContain("The vs base, bp column (tooltip and Show table) is the scenario rate minus S0&#x27;s rate in the same month, in bp.");
  });

  it("prints a scenario whose label equals its id once, and one whose label differs as label and id (Polish 11, F11)", () => {
    const html = renderToStaticMarkup(<RatesView doc={DOCP} label={(id) => id} runId="r" />);
    expect(html).toContain('<i class="key-line" style="background:var(--series-2)"></i>S100</button>');
    expect(html).not.toContain("S100 S100");
    expect(html).not.toContain("S0 S0");
    const named = renderToStaticMarkup(<RatesView doc={DOCP} label={(id) => (id === "S100" ? "+100bp" : id)} runId="r" />);
    expect(named).toContain('<i class="key-line" style="background:var(--series-2)"></i>+100bp S100</button>');
    expect(named).toContain('<th scope="col" class="num">+100bp S100 vs base, bp</th>');
    expect(named).toContain('<i class="key-line" style="background:var(--series-1)"></i>S0</button>');
  });

  it("gives the path chart no gap column and no gap footer when the base scenario's path is omitted (Polish 11)", () => {
    const doc = structuredClone(DOCP) as unknown as { scenarios: Array<Record<string, unknown>> };
    const s0 = doc.scenarios[0]!;
    delete s0.path;
    s0.ratePathModel = "hw1f-demo";
    s0.pathOmitted = OMITTED;
    const html = renderToStaticMarkup(<RatesView doc={doc as unknown as RateDocument} label={(id) => id} runId="r" />);
    const path = html.slice(html.indexOf("One-month rate path by scenario"), html.indexOf("Paths the document omits"));
    // S100's path is drawn alone: its stored 5.10% at M0, and no gap to a base the chart does not hold.
    expect(path).toContain('<tr><th scope="row">M0</th><td class="num lvl">5.10%</td></tr>');
    expect(path).not.toContain("vs base");
    // The zero curve keeps its gap to the base curve: the one footer naming the column is its own.
    expect(html.split("The vs base, bp column").length - 1).toBe(1);
    expect(html).toContain("is the scenario rate minus the base curve&#x27;s rate at the same tenor, in bp.");
  });

  it("gives the path chart no gap column when no single scenario is the base", () => {
    const html = renderToStaticMarkup(<RatesView doc={DOC7} label={LABEL} runId="r" />);
    const path = html.slice(html.indexOf("One-month rate path by scenario"), html.indexOf("Scenarios in the rate document"));
    expect(path).not.toContain("vs base");
    expect(html.split("The vs base, bp column").length - 1).toBe(1);
  });
});

describe("RatesBody", () => {
  const body = (load: Parameters<typeof RatesBody>[0]["load"]) => renderToStaticMarkup(<RatesBody load={load} runId="run-fixture" label={(id) => id} />);

  it("a refused read prints the server's status and message verbatim", () => {
    const msg = 'run "run-fixture" has no rate document: it finished before runs wrote rate documents; re-run to produce one';
    const html = body({ state: "error", error: new ApiError(404, "not_found", msg) });
    expect(html).toContain("No rate document");
    expect(html).toContain(`404: ${msg}`.replace(/"/g, "&quot;"));
    expect(html).not.toContain("<svg");
  });

  it("an ok read draws the document", () => {
    expect(body({ state: "ok", value: DOC })).toContain("Zero curve by scenario");
  });
});

const IDS = ["S0", "S100", "S-100", "S200", "S-200"];
/** One row per run scenario in request order (rule C3); S100 leaves k2 out; only S0 reports a family grain. */
const METRIC = {
  metricId: "balance-demo", label: "Balance demo",
  keys: [{ id: "k1", label: "Runoff", unit: "currency" }, { id: "k2", label: "WAL", unit: "months" }],
  byScenario: IDS.map((scenarioId, i) =>
    scenarioId === "S0"
      ? { scenarioId, values: { k1: 1_500_000, k2: 30.25 }, byFamily: [{ familyId: "dda", values: { k1: 700_000 } }] }
      : scenarioId === "S100"
        ? { scenarioId, values: { k1: 1_200_000 } }
        : { scenarioId, values: { k1: 1_000_000 + i, k2: 29 } },
  ),
} as unknown as CustomMetricResult;

const withMetric = () => {
  const r = freshResult();
  r.custom = { "balance-demo": METRIC };
  return r;
};

describe("MetricsTab", () => {
  it("prints each key by its declared unit and an absent key as unobservable, with the reason", () => {
    const html = renderToStaticMarkup(<MetricsTab ws="ws-a" {...props(withMetric())} />);
    expect(html).toContain(formatValue("currency", 1_500_000));
    expect(html).toContain(formatValue("months", 30.25));
    expect(html).toContain(UNOBSERVABLE);
    expect(html).toContain('title="The metric left key k2 out of this row');
    expect(html).toContain(formatValue("currency", 700_000));
    expect(html).toContain("balance-demo");
    // A scenario row and a family row each open on a row header (Row header scope).
    expect(html).toContain('<tr><th scope="row">S0</th><td class="num">');
    expect(html).toContain('<tr><th scope="row">dda</th><td class="num">');
  });

  it("a scenario with no family rows says so instead of drawing an empty table", () => {
    const html = renderToStaticMarkup(<MetricsTab ws="ws-a" {...props(withMetric(), { scenario: "S100" })} />);
    expect(html).not.toContain(formatValue("currency", 700_000));
    expect(html).toContain("No family rows are stored for S100");
  });

  it("no custom block is not in this run; both tabs are registered", () => {
    const html = renderToStaticMarkup(<MetricsTab ws="ws-a" {...props()} />);
    expect(html).toContain(NOT_IN_RUN);
    expect(html).toContain("no custom metric stage published a result");
    const own = ["rates", "metrics"];
    expect(liveTabs().map((t) => t.id).filter((id) => own.includes(id))).toEqual(own);
  });
});

/** Every LinePlot element in a rendered tree, read off the elements (RatesView holds no hooks, so it is called directly). */
function linePlots(node: ReactNode): Array<ReactElement<LinePlotProps>> {
  if (Array.isArray(node)) return node.flatMap(linePlots);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === LinePlot) return [node as ReactElement<LinePlotProps>];
  return linePlots(el.props.children);
}

describe("the Rates zero curve tooltip (Polish 15 item 4)", () => {
  const zero = () => {
    const plot = linePlots(RatesView({ doc: DOC, label: (id) => id, runId: "run-fixture" })).find((p) => p.props.unit.startsWith("continuously compounded zero rate"));
    expect(plot).toBeDefined();
    return plot!.props;
  };
  const at5 = (s: PlotSeries) => new Map(s.points).get(5) ?? null;

  it("lists the base once at a tenor: the base curve row, not also the base scenario S0 that has the same points", () => {
    const p = zero();
    // At 5Y the fixture's S100 is 5.2% and S0 and the base curve are both 4.2%: rows S100, then the base curve alone.
    const rows = tipRows(p.series, at5, p.delta, p.deltaTwin);
    expect(rows.map((r) => [r.s.id, r.v])).toEqual([["S100", 0.052 * 100], ["base", 0.042 * 100]]);
  });

  it("brings the S0 row back when the base curve is hidden", () => {
    const p = zero();
    const rows = tipRows(p.series.filter((s) => s.id !== "base"), at5, p.delta, p.deltaTwin);
    expect(rows.map((r) => r.s.id)).toEqual(["S100", "S0"]);
  });
});
