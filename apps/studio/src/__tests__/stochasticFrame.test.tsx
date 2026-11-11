/**
 * Results > Stochastic distributions takes the Results frame (final review M7; spec v3.1 Section 5.4): the result
 * picker first, defaulting to the newest done stochastic run of the workspace, then the Grid as of line above the
 * body. The date is the run detail's grid (request.json records it for a stochastic run too); a detail with no grid
 * reads not recorded on the run. Expected
 * texts are restated here by hand.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { RunDetail, WorkspaceRunRow } from "@alm/reader";
import { chooseResult, pickerRuns } from "../pages/results/resultChoice";
import { ResultPicker } from "../pages/results/ResultPicker";
import { StochasticFramedBody } from "../pages/results/StochasticRunPage";
import type { Route } from "../router";
import { pageFor } from "../pages/pageFor";
import { HEAD, READINESS } from "./fixtures/workspace";

const WS = "ws-synthetic-2500-v1";

function row(runId: string, submittedAt: string, label: string): WorkspaceRunRow {
  return {
    runId,
    attachedBy: "launch",
    at: submittedAt,
    pins: "consumed",
    setupLineageId: "setup-standard-alco",
    launchNo: 1,
    status: {
      runId,
      state: "done",
      label,
      submittedAt,
      platformRequestHash: "req",
      summary: { portfolioId: "synthetic-2500-v1", marketId: "market-public-2026-03-31", scenarioSlateId: "plan-x", scenarioCount: 1, workspaceId: WS },
    },
    basisLabel: "Runoff",
  };
}

const ROWS = [row("run-det", "2026-10-08T09:00:00Z", "Standard ALCO"), row("run-mc-old", "2026-10-01T09:00:00Z", "MC one"), row("run-mc", "2026-10-05T09:00:00Z", "MC two")];
const MODES = { "run-mc-old": "stochastic", "run-mc": "stochastic" };

describe("Stochastic distributions in the Results frame", () => {
  it("pageFor hands the screen its frame", () => {
    const route = { kind: "screen", ws: WS, section: "results", screen: "stochastic", query: {} } as Route;
    const el = pageFor(route, HEAD, { workspaces: [HEAD], readiness: READINESS, refresh: () => {} }) as ReactElement<{ frame?: unknown }>;
    expect(el.props.frame).toEqual({ ws: WS, screen: "stochastic", cutoffDate: "2026-03-31", readiness: READINESS });
  });
  it("the default is the newest done stochastic run; an explicit choice still wins", () => {
    const runs = pickerRuns(ROWS, MODES, null);
    expect(chooseResult(runs, undefined, "stochastic")).toMatchObject({ kind: "newest", runId: "run-mc" });
    expect(chooseResult(runs, undefined)).toMatchObject({ kind: "newest", runId: "run-det" });
    expect(chooseResult(runs, "run-mc-old", "stochastic")).toMatchObject({ kind: "explicit", runId: "run-mc-old" });
    expect(chooseResult(pickerRuns([ROWS[0]!], {}, null), undefined, "stochastic")).toEqual({ kind: "none" });
  });
  it("with no stochastic run the picker says so and points at the Analysis path's Run step", () => {
    const runs = pickerRuns([ROWS[0]!], {}, null);
    const html = renderToStaticMarkup(<ResultPicker ws={WS} screen="stochastic" query={{}} runs={runs} choice={chooseResult(runs, undefined, "stochastic")} want="stochastic" />);
    expect(html).toContain("This workspace holds no done stochastic run to show.");
    expect(html).toContain("Choose a stochastic run on the Analysis path&#x27;s Simulation step and launch it on the Run step; it is attached to this workspace and listed here.");
    expect(html).not.toContain("a later release");
  });
  it("a run whose detail has no grid prints the not-recorded line and the basis label above the body", () => {
    const detail = { runId: "run-mc", state: "done", submittedAt: "2026-10-05T09:00:00Z", mode: "stochastic", scenarios: [] } as unknown as RunDetail;
    const html = renderToStaticMarkup(<StochasticFramedBody runId="run-mc" data={{ detail, summary: null, note: "The run is gone." }} meta={{ cutoff: "2026-03-31", basisLabel: "Runoff" }} />);
    expect(html).toContain("Grid as of: not recorded on this run");
    expect(html).toContain("Basis: Runoff");
    expect(html.indexOf("Grid as of")).toBeLessThan(html.indexOf("The run is gone."));
  });
  it("a stochastic run's detail grid as-of is printed, with the clash badge when it differs from the cut-off", () => {
    const detail = (asOf: string) => ({ runId: "run-mc", state: "done", submittedAt: "2026-10-05T09:00:00Z", mode: "stochastic", scenarios: [], grid: { horizonMonths: 360, asOf } }) as unknown as RunDetail;
    const render = (asOf: string) => renderToStaticMarkup(<StochasticFramedBody runId="run-mc" data={{ detail: detail(asOf), summary: null, note: "n" }} meta={{ cutoff: "2026-03-31", basisLabel: "Runoff" }} />);
    const same = render("2026-03-31");
    expect(same).toContain("Grid as of 2026-03-31");
    expect(same).not.toContain("not recorded on this run");
    expect(same).not.toContain("result-clash");
    const clash = render("2026-02-28");
    expect(clash).toContain("Grid as of 2026-02-28");
    expect(clash).toContain(">workspace cut-off 2026-03-31</span>");
  });
});
