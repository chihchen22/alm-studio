// apps/studio/src/__tests__/resultPicker.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { ReadinessReport, WorkspaceRunRow } from "@alm/reader";
import { chooseResult, pickHref, pickerRuns, rowText } from "../pages/results/resultChoice";
import { ResultPicker } from "../pages/results/ResultPicker";
import { GridAsOf, gridAsOfOf } from "../pages/results/GridAsOf";
import { hrefFor, type Route } from "../router";
import { pageFor } from "../pages/pageFor";
import { freshResult } from "./fixtures/results";
import { HEAD, READINESS } from "./fixtures/workspace";

const WS = "ws-synthetic-2500-v1";

/** One attachment line joined to its status, as GET /api/workspaces/:id/runs serves it. */
function row(runId: string, submittedAt: string, label: string | undefined, scenarioCount: number, basisLabel: string | null, over: Partial<WorkspaceRunRow> = {}, state: "done" | "running" | "error" = "done"): WorkspaceRunRow {
  return {
    runId,
    attachedBy: "launch",
    at: submittedAt,
    pins: "consumed",
    setupLineageId: "setup-standard-alco",
    launchNo: 1,
    status: {
      runId,
      state,
      ...(label === undefined ? {} : { label }),
      submittedAt,
      platformRequestHash: "req",
      summary: { portfolioId: "synthetic-2500-v1", marketId: "market-public-2026-03-31", scenarioSlateId: "plan-x", scenarioCount, workspaceId: WS },
    },
    basisLabel,
    ...over,
  };
}

const ROWS: WorkspaceRunRow[] = [
  row("run-old", "2026-10-01T09:00:00Z", "September ALCO", 5, "Runoff"),
  row("run-new", "2026-10-08T09:30:00Z", "Standard ALCO", 5, "Flat (simple top-up)"),
  row("run-live", "2026-10-09T08:00:00Z", "Standard ALCO", 5, "Flat (simple top-up)", {}, "running"),
  row("run-migrated", "2026-09-20T09:00:00Z", "Migrated run", 3, null, { attachedBy: "migration", pins: "reconstructed" }),
  row("run-mc", "2026-10-05T09:00:00Z", "Monte Carlo", 1, "Runoff"),
];
const MODES = { "run-mc": "stochastic" };

describe("the rows the picker lists", () => {
  const runs = pickerRuns(ROWS, MODES, null);
  it("lists done runs only, newest first", () => {
    expect(runs.map((r) => r.runId)).toEqual(["run-new", "run-mc", "run-old", "run-migrated"]);
  });
  it("prints each row as label, date, scenario count and basis label", () => {
    expect(rowText(runs[0]!)).toBe("Standard ALCO · 2026-10-08 · 5 scenarios · Flat (simple top-up)");
    // A stochastic row prints what it is in place of the slate count (teaching build).
    expect(rowText(runs[1]!)).toBe("Monte Carlo · 2026-10-05 · Stochastic, base scenario only · Runoff");
  });
  it("falls back to the run id for a run with no label and says when no basis was recorded", () => {
    const only = pickerRuns([row("run-x", "2026-10-02T00:00:00Z", undefined, 2, null)], {}, null);
    expect(rowText(only[0]!)).toBe("run-x · 2026-10-02 · 2 scenarios · basis not recorded");
  });
  it("marks the stochastic run, the migrated run and nothing else", () => {
    expect(runs.find((r) => r.runId === "run-mc")!.stochastic).toBe(true);
    expect(runs.find((r) => r.runId === "run-migrated")!.reconstructed).toBe(true);
    expect(runs.find((r) => r.runId === "run-new")!.stochastic).toBe(false);
    expect(runs.find((r) => r.runId === "run-new")!.reconstructed).toBe(false);
  });
  it("marks the newest attached run stale when readiness says its consumed pins moved", () => {
    const stale: ReadinessReport = {
      ...READINESS,
      items: [...READINESS.items, { section: "results", item: "Newest result", state: "stale", required: false, detail: "pins moved", staleRoles: [{ role: "book", pinned: "aaa", current: "bbb" }] }],
    };
    // The newest attached run overall is run-live (running): readiness names the newest attachment, so no done row is marked.
    expect(pickerRuns(ROWS, MODES, stale).some((r) => r.stale)).toBe(false);
    const doneOnly = ROWS.filter((r) => r.runId !== "run-live");
    const marked = pickerRuns(doneOnly, MODES, stale);
    expect(marked.filter((r) => r.stale).map((r) => r.runId)).toEqual(["run-new"]);
    expect(marked.find((r) => r.runId === "run-new")!.staleRoles).toEqual(["book"]);
  });
});

describe("the default and the explicit choice", () => {
  const runs = pickerRuns(ROWS, MODES, null);
  it("defaults to the newest done deterministic run and says why", () => {
    const c = chooseResult(runs, undefined);
    expect(c).toMatchObject({ kind: "newest", runId: "run-new" });
  });
  it("skips a newer stochastic run for the default: the deterministic screens cannot read it", () => {
    const withNewerMc = pickerRuns([...ROWS, row("run-mc2", "2026-10-09T10:00:00Z", "MC two", 1, "Runoff")], { ...MODES, "run-mc2": "stochastic" }, null);
    expect(chooseResult(withNewerMc, undefined)).toMatchObject({ kind: "newest", runId: "run-new" });
  });
  it("keeps an explicit result, listed or not", () => {
    expect(chooseResult(runs, "run-old")).toMatchObject({ kind: "explicit", runId: "run-old" });
    const unlisted = chooseResult(runs, "run-elsewhere");
    expect(unlisted).toMatchObject({ kind: "explicit", runId: "run-elsewhere", run: null });
  });
  it("is none when the workspace holds no done run", () => {
    expect(chooseResult([], undefined)).toEqual({ kind: "none" });
  });
});

describe("the picker control", () => {
  const runs = pickerRuns(ROWS, MODES, null);
  const html = (explicit?: string) => renderToStaticMarkup(
    <ResultPicker ws={WS} screen="nii" query={explicit === undefined ? {} : { result: explicit }} runs={runs} choice={chooseResult(runs, explicit)} />,
  );

  it("names the newest run it picked and why, with no clearing control", () => {
    const m = html();
    expect(m).toContain("Showing the newest done run of this workspace");
    expect(m).toContain("Standard ALCO · 2026-10-08 · 5 scenarios · Flat (simple top-up)");
    expect(m).not.toContain("Use the newest run");
  });
  it("names the run the address chose and offers the clear control back to the newest", () => {
    const m = html("run-old");
    expect(m).toContain("Showing the run chosen in the address");
    expect(m).toContain("September ALCO · 2026-10-01 · 5 scenarios · Runoff");
    expect(m).toContain("Use the newest run");
    expect(m).toContain(`href="#/ws/${WS}/results/nii"`);
  });
  it("the list of all done runs counts them in one phrase (Studio Part 2 m8)", () => {
    expect(html()).toContain("All 4 done runs of this workspace");
  });
  it("lists every done run as an option whose value is that run's own Results address", () => {
    const m = html();
    for (const r of runs) expect(m).toContain(`value="#/ws/${WS}/results/nii?result=${r.runId}"`);
  });
  it("prints the Stale, pins reconstructed and Stochastic badges beside the runs that carry them", () => {
    const staleRuns = pickerRuns(ROWS.filter((r) => r.runId !== "run-live"), MODES, {
      ...READINESS,
      items: [{ section: "results", item: "Newest result", state: "stale", required: false, detail: "moved", staleRoles: [{ role: "book", pinned: "a", current: "b" }] }],
    });
    const m = renderToStaticMarkup(<ResultPicker ws={WS} screen="nii" query={{}} runs={staleRuns} choice={chooseResult(staleRuns, undefined)} />);
    expect(m).toContain(">Stale<");
    expect(m).toContain("pins reconstructed");
    expect(m).toContain(">Stochastic<");
  });
  it("carries no Run pill, Book pill or As of pill wording", () => {
    const m = html("run-old");
    expect(m).not.toContain("Run pill");
    expect(m).not.toContain("Book pill");
  });
});

describe("the result key travels inside Results and nowhere else", () => {
  it("is present in a Results link and keeps the page state keys", () => {
    expect(pickHref(WS, "nii", { scenario: "S100", book: "b", tab: "nii", run: "x" }, "run-old")).toBe(`#/ws/${WS}/results/nii?scenario=S100&result=run-old`);
  });
  it("is dropped when the choice is cleared", () => {
    expect(pickHref(WS, "nii", { result: "run-old", scenario: "S100" }, null)).toBe(`#/ws/${WS}/results/nii?scenario=S100`);
  });
  it("is absent from a link to Market > Yield curves", () => {
    expect(hrefFor({ ws: WS, section: "market", screen: "curves", query: { result: "run-old" } })).toBe(`#/ws/${WS}/market/curves`);
    expect(hrefFor({ ws: WS, section: "results", screen: "eve", query: { result: "run-old" } })).toBe(`#/ws/${WS}/results/eve?result=run-old`);
  });
});

describe("Grid as of", () => {
  it("prints the run's grid as-of with no badge when it equals the cut-off", () => {
    const m = renderToStaticMarkup(<GridAsOf asOf="2026-03-31" cutoff="2026-03-31" />);
    expect(m).toContain("Grid as of 2026-03-31");
    expect(m).not.toContain("workspace cut-off");
  });
  it("adds the clash badge naming the cut-off when the two differ", () => {
    const m = renderToStaticMarkup(<GridAsOf asOf="2026-03-31" cutoff="2026-04-30" />);
    expect(m).toContain("Grid as of 2026-03-31");
    expect(m).toContain("workspace cut-off 2026-04-30");
  });
  it("says so when the envelope records no grid", () => {
    expect(renderToStaticMarkup(<GridAsOf asOf={null} cutoff="2026-04-30" />)).toContain("Grid as of: not recorded on this run");
  });
  it("reads the as-of off the stored envelope's cash flow grid", () => {
    expect(gridAsOfOf(freshResult())).toBe("2026-03-31");
    const r = freshResult();
    delete (r.cashflows as { grid?: unknown }).grid;
    expect(gridAsOfOf(r)).toBeNull();
    expect(HEAD.cutoffDate).toBe("2026-03-31");
  });
});

describe("pageFor hands every deterministic Results screen its frame", () => {
  const screenRoute = (section: string, id: string): Route => ({ kind: "screen", ws: WS, section, screen: id, query: {} }) as Route;
  const env = { workspaces: [HEAD], readiness: READINESS, refresh: () => {} };
  it("names the workspace, the screen, the cut-off date and the readiness the picker reads", () => {
    for (const id of ["dashboard", "nii", "eve", "gap", "ftp", "seg", "liquidity", "instruments", "rates", "attribution", "views", "metrics", "lenses"]) {
      const el = pageFor(screenRoute("results", id), HEAD, env) as ReactElement<{ frame?: { ws: string; screen: string; cutoffDate: string | null; readiness: unknown } }>;
      expect(el.props.frame, id).toEqual({ ws: WS, screen: id, cutoffDate: "2026-03-31", readiness: READINESS });
    }
  });
});
