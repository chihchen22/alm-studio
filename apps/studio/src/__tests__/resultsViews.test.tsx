// apps/studio/src/__tests__/resultsViews.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cellIdOf, pivot, PivotUnavailableError, type PivotMetric, type PivotResult, type RunResult } from "@alm/engine";
import { ApiError, EVE_PV_CAVEAT, NOT_IN_RUN, usdMM } from "@alm/reader";
import { PivotTable, ViewsBody, ViewsTab, viewPick } from "../pages/results/ViewsTab";
import { liveTabs } from "../pages/results/tabs";
import { DETAIL, RESULT, freshResult } from "./fixtures/results";

const props = (result: RunResult = RESULT, query: Record<string, string> = {}) => ({ runId: "run-fixture", detail: DETAIL, result, query, scenarioLabel: (id: string) => id });

/** Each family's side, as the stored ftp.byFamily carries it; the engine derives the side dimension from the family (portfolio/dimensions.ts). */
const SIDE = new Map(RESULT.ftp!.byFamily.map((f) => [f.familyId, f.side]));
const tagsOf = (familyId: string) => ({ productFamily: familyId, side: SIDE.get(familyId)! });
const cellOf = (familyId: string) => cellIdOf(familyId, tagsOf(familyId));

/**
 * The demo synthetic envelope as a run declaring two views, by productFamily
 * and by side, would store it. The cell pins both dimensions; side is a
 * function of the family, so there is still one cell per family, each cell's
 * stored arm is its family's row and each cell's position count is the
 * family's (read off the stored ftp.byFamily, which sums to the book's 2351).
 * Groups sort by canonical key; cells run family-major and a group lists its
 * cells in that order (portfolio/cells.ts buildCellPlan and toViewResults).
 * The gap ladders' cell arms are left out: no test here reads a gap metric.
 */
function withView(): RunResult {
  const r = freshResult();
  const counts = new Map(r.ftp!.byFamily.map((f) => [f.familyId, f.positionCount]));
  const families = r.nii.byScenario[0]!.byFamily.map((f) => f.familyId);
  r.cashflows.cells = families.map((f) => ({ id: cellOf(f), familyId: f, tags: tagsOf(f), positionCount: counts.get(f)! }));
  const sides = [...new Set(families.map((f) => SIDE.get(f)!))].sort();
  const onSide = (side: string) => families.filter((f) => SIDE.get(f) === side);
  r.views = [
    {
      viewId: "by-family", label: "By product family", groupBy: ["productFamily"],
      groups: [...families].sort().map((f) => ({ key: { productFamily: f }, cellIds: [cellOf(f)], positionCount: counts.get(f)! })),
    },
    {
      viewId: "by-side", label: "By side", groupBy: ["side"],
      groups: sides.map((side) => ({
        key: { side }, cellIds: onSide(side).map(cellOf), positionCount: onSide(side).reduce((n, f) => n + counts.get(f)!, 0),
      })),
    },
  ];
  for (const s of r.nii.byScenario) {
    s.byCell = s.byFamily.map(({ familyId, ...row }) => ({ cellId: cellOf(familyId), ...row }));
  }
  for (const s of r.cashflows.byScenario) s.byCell = s.byFamily.map((f) => ({ cellId: cellOf(f.familyId), series: f.series }));
  for (const s of r.eve.byScenario) s.byCell = s.byFamily.map((f) => ({ cellId: cellOf(f.familyId), pv: f.pv }));
  return r;
}

/** What GET /api/runs/:id/pivot serves for this envelope: the route calls the engine's pure pivot on the stored result. */
const served = (r: RunResult, metric: PivotMetric, scenarioId = "S0", viewId = "by-family") => pivot(r, { viewId, metric, scenarioId });

const MORT_S0 = RESULT.nii.byScenario[0]!.byFamily.find((f) => f.familyId === "mortgages")!;

describe("viewPick", () => {
  it("picks the view, metric and scenario from the query, falling back to the first", () => {
    const r = withView();
    expect(viewPick(r, {})).toMatchObject({ viewId: "by-family", metric: "balance", scenarioId: "S0" });
    expect(viewPick(r, { view: "nope", metric: "nii", scenario: "S100" })).toMatchObject({ viewId: "by-family", metric: "nii", scenarioId: "S100" });
    expect(viewPick(r, { metric: "not-a-metric" }).metric).toBe("balance");
  });
});

describe("PivotTable", () => {
  it("prints the served pivot rows and, when a row is open, each cell's stored numbers", () => {
    const r = withView();
    const p = served(r, "nii");
    const open = p.rows.findIndex((row) => row.key.productFamily === "mortgages");
    const html = renderToStaticMarkup(<PivotTable pivot={p} result={r} initialOpen={new Set([open])} />);
    expect(html).toContain("mortgages");
    expect(html).toContain(usdMM(MORT_S0.net12));
    expect(html).toContain('class="cell-row"');
    expect(html).toContain("productFamily=mortgages");
    expect(html).toContain(usdMM(MORT_S0.net24));
    expect(html).toContain(">750<");
  });

  it("an open side row prints each member family's stored net12 beside the row's served sum", () => {
    const r = withView();
    const p = served(r, "nii", "S0", "by-side");
    const i = p.rows.findIndex((row) => row.key.side === "asset");
    const row = p.rows[i]!;
    const members = RESULT.nii.byScenario[0]!.byFamily.filter((f) => SIDE.get(f.familyId) === "asset");
    expect(row.cellIds).toHaveLength(members.length);
    const closed = renderToStaticMarkup(<PivotTable pivot={p} result={r} />);
    const opened = renderToStaticMarkup(<PivotTable pivot={p} result={r} initialOpen={new Set([i])} />);
    expect(closed).toContain(usdMM(row.nii!.net12));
    expect(opened).toContain(usdMM(row.nii!.net12));
    for (const f of members) {
      const own = usdMM(f.net12);
      expect(own).not.toBe(usdMM(row.nii!.net12));
      expect(closed).not.toContain(`>${own}<`);
      expect(opened).toContain(`>${own}<`);
      expect(opened).toContain(`productFamily=${f.familyId} side=asset`);
    }
  });

  it("names every blank it leaves: the total's counts, the nii total's columns past net12, a cell row's cell count", () => {
    const r = withView();
    const html = renderToStaticMarkup(<PivotTable pivot={served(r, "nii")} result={r} initialOpen={new Set([0])} />);
    expect(html).toContain('title="The served total carries no position or cell count"');
    expect(html).toContain('title="The route&#x27;s nii total is the net12 sum only; it serves no total for this column"');
    expect(html).toContain('title="A cell row is one cell"');
  });

  it("an evePv pivot carries the contract's caveat on its header", () => {
    const r = withView();
    const html = renderToStaticMarkup(<PivotTable pivot={served(r, "evePv")} result={r} />);
    expect(html).toContain(`title="${EVE_PV_CAVEAT}"`);
  });

  /**
   * A guard, not an engine state: the route refuses (422) any pivot whose cell
   * arm is absent, and the envelope in hand is the same stored file, so a
   * served pivot always finds its cells. The table still never paints a blank
   * for a cell it cannot read.
   */
  it("a cell with no stored numbers for the metric says so, with the reason", () => {
    const r = withView();
    const p = served(r, "nii");
    delete r.nii.byScenario[0]!.byCell;
    const html = renderToStaticMarkup(<PivotTable pivot={p} result={r} initialOpen={new Set([0])} />);
    expect(html).toContain("no stored cell numbers for this metric on this scenario");
    expect(html).toContain("the envelope in hand carries no byCell entry for this cell");
  });
});

describe("ViewsBody", () => {
  const body = (load: Parameters<typeof ViewsBody>[0]["load"], metric: PivotMetric = "nii") =>
    renderToStaticMarkup(<ViewsBody load={load} result={withView()} runId="run-fixture" viewId="by-family" metric={metric} scenarioId="S0" />);

  it("a refused read prints the server's status and the engine's message verbatim", () => {
    // A dynamic scenario's cashflow and NII blocks carry no cell arm; the route 422s with the engine's reason.
    const r = withView();
    delete r.cashflows.byScenario[1]!.byCell;
    delete r.nii.byScenario[1]!.byCell;
    let msg = "";
    try { served(r, "nii", "S100"); } catch (e) { if (e instanceof PivotUnavailableError) msg = e.message; }
    expect(msg).toContain("dynamic scenario");
    const html = body({ state: "error", error: new ApiError(422, "validation", msg) });
    expect(html).toContain("No pivot");
    expect(html).toContain(`422: ${msg}`.replace(/"/g, "&quot;").replace(/'/g, "&#x27;"));
    expect(html).not.toContain("<table");
  });

  it("a loading read says so; an ok read prints the table and names the fields it does not paint", () => {
    expect(body({ state: "loading" })).toContain("Reading the pivot");
    const html = body({ state: "ok", value: served(withView(), "nii") });
    expect(html).toContain("<table");
    expect(html).toContain("interestIncome24, interestExpense24, byHorizon and netMonthly");
    expect(html).toContain("/api/runs/run-fixture/pivot?view=by-family&amp;metric=nii&amp;scenarioId=S0");
  });

  /** A guard, not an engine state shown here: no engine-produced envelope in these tests serves a view with no groups. */
  it("an ok read with no rows says why rather than printing an empty table", () => {
    const empty = { ...served(withView(), "balance"), rows: [], total: [] } as PivotResult;
    const html = body({ state: "ok", value: empty }, "balance");
    expect(html).toContain("The served pivot has no rows: the view has no groups for this metric and scenario");
    expect(html).not.toContain("<table");
  });
});

describe("ViewsTab", () => {
  it("a run that declared no views is not in this run; the tab is registered in order", () => {
    const html = renderToStaticMarkup(<ViewsTab ws="ws-a" {...props()} />);
    expect(html).toContain(NOT_IN_RUN);
    expect(html).toContain("declared no views");
    expect(liveTabs().map((t) => t.id)).toEqual(["overview", "nii", "eve", "gap", "ftp", "seg", "liquidity", "instruments", "attribution", "lenses", "rates", "views", "metrics"]);
  });

  it("a run with views shows the view, metric and scenario pickers and reads the route", () => {
    const html = renderToStaticMarkup(<ViewsTab ws="ws-a" {...props(withView(), { view: "by-family", metric: "evePv" })} />);
    expect(html).toContain("By product family");
    expect(html).toContain('aria-label="Metric"');
    expect(html).toContain('aria-label="Scenario"');
    expect(html).toContain(EVE_PV_CAVEAT);
    expect(html).toContain("Reading the pivot");
  });
});
