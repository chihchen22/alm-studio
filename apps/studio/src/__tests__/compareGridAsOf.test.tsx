/**
 * Results > Compare runs prints Grid as of for both runs (ruling 2026-10-11; spec v3.1 Section 5.4). Under the
 * two pickers: one line per chosen run with the cut-off clash badge, a "Grid dates differ" badge and its sentence when
 * the two runs' grid dates differ, and the not-recorded words of the Stochastic frame for a run with no grid as-of.
 * The pickers offer the workspace's done runs only. Studio tests have no DOM: the markup is the server render; expected
 * texts are restated here by hand.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { CompareReply, RunSummary, WorkspaceRunRow } from "@alm/reader";
import { CompareBody, CompareChosen, loadCompareRuns } from "../pages/compare/ComparePage";
import { loadGridAsOf } from "../pages/compare/CompareGridAsOf";
import { StochasticCompareBody } from "../pages/compare/StochasticCompareViews";
import { pageFor } from "../pages/pageFor";
import type { Route } from "../router";
import { mockFetch } from "./fixtures/run";
import { HEAD, READINESS } from "./fixtures/workspace";

afterEach(() => vi.unstubAllGlobals());

const CUTOFF = "2026-03-31";
const DIFFER = "These two runs were built on different grids; differences below mix a grid change with a model change.";

const run = (runId: string, over: Partial<RunSummary> = {}): RunSummary => ({
  runId,
  state: "done",
  submittedAt: `2026-09-2${runId.slice(-1)}T10:00:00Z`,
  platformRequestHash: `prh-${runId}`,
  mode: "deterministic",
  ...over,
});

const RUNS = [run("run-1", { label: "Base book" }), run("run-2")];

const REPLY: CompareReply = {
  table: "nii",
  columns: [{ name: "scenarioId", role: "key" }, { name: "net12", role: "num" }],
  rows: [{ key: { scenarioId: "S0" }, a: { net12: 1 }, b: { net12: 2 }, delta: { net12: 1 } }],
  provenance: {
    a: { runId: "run-1", inputsHash: "hash-a", schemaVersion: "1.3.0", engineVersion: "2.0.0" },
    b: { runId: "run-2", inputsHash: "hash-b", schemaVersion: "1.3.0", engineVersion: "2.0.0" },
  },
  note: "derived columns are B - A",
};

/** The rendered text with tags removed and whitespace runs folded. */
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

const ok = (value: string | null) => ({ state: "ok" as const, value });

function body(a: string | null, b: string | null) {
  return renderToStaticMarkup(
    <CompareBody ws="ws-a" runs={RUNS} query={{ runs: "run-1,run-2" }} compare={{ state: "ok", value: REPLY }} grid={{ cutoff: CUTOFF, a: ok(a), b: ok(b) }} />,
  );
}

describe("Compare runs prints Grid as of for both runs", () => {
  it("prints one line per run with its own date", () => {
    const t = text(body("2026-03-31", "2026-03-31"));
    expect(t).toContain("Run A run-1: Grid as of 2026-03-31");
    expect(t).toContain("Run B run-2: Grid as of 2026-03-31");
  });

  it("carries one cut-off clash badge when run A's date differs from the cut-off", () => {
    const html = body("2026-02-28", "2026-03-31");
    expect(text(html)).toContain("Run A run-1: Grid as of 2026-02-28 workspace cut-off 2026-03-31");
    expect(html.split('class="result-clash" title="The run&#x27;s grid as-of differs from the workspace&#x27;s cut-off date"').length - 1).toBe(1);
  });

  it("says Grid dates differ, with its sentence, only when the two dates differ", () => {
    const differ = text(body("2026-02-28", "2026-03-31"));
    expect(differ).toContain("Grid dates differ");
    expect(differ).toContain(DIFFER);
    const same = text(body("2026-03-31", "2026-03-31"));
    expect(same).not.toContain("Grid dates differ");
    expect(same).not.toContain(DIFFER);
  });

  it("a run with no grid as-of reads the Stochastic frame's words, and no differ badge is claimed", () => {
    const t = text(body(null, "2026-03-31"));
    expect(t).toContain("Run A run-1: Grid as of: not recorded on this run");
    expect(t).not.toContain("Grid dates differ");
  });

  it("a stochastic pair prints the same lines under the pickers", () => {
    const html = renderToStaticMarkup(
      <StochasticCompareBody ws="ws-a" runs={RUNS} query={{ runs: "run-1,run-2" }} compare={{ state: "loading" }} grid={{ cutoff: CUTOFF, a: ok(null), b: ok(null) }} />,
    );
    const t = text(html);
    expect(t).toContain("Run A run-1: Grid as of: not recorded on this run");
    expect(t).toContain("Run B run-2: Grid as of: not recorded on this run");
    expect(html.indexOf("Run A")).toBeLessThan(html.indexOf("Reading the stochastic comparison"));
  });

  it("pageFor hands Compare its frame, so the lines know the workspace cut-off", () => {
    const route = { kind: "screen", ws: HEAD.id, section: "results", screen: "compare", query: {} } as Route;
    const el = pageFor(route, HEAD, { workspaces: [HEAD], readiness: READINESS, refresh: () => {} }) as ReactElement<{ frame?: { cutoffDate: string | null } }>;
    expect(el.props.frame?.cutoffDate).toBe(CUTOFF);
  });
});

describe("Compare pickers are the workspace's done runs", () => {
  const attached = (runId: string): WorkspaceRunRow => ({
    runId,
    attachedBy: "launch",
    at: "2026-10-08T09:00:00Z",
    pins: "consumed",
    setupLineageId: "setup-standard-alco",
    launchNo: 1,
    status: {
      runId,
      state: "done",
      label: "Standard ALCO",
      submittedAt: "2026-10-08T09:00:00Z",
      platformRequestHash: "req",
      summary: { portfolioId: "synthetic-2500-v1", marketId: "market-public-2026-03-31", scenarioSlateId: "plan-x", scenarioCount: 3, workspaceId: "ws-a" },
    },
    basisLabel: "Runoff",
  });

  it("a run not in the workspace's run list is not offered; rows read like the result picker", async () => {
    mockFetch([
      ["/api/workspaces/ws-a/runs", [attached("r-attached")]],
      ["/api/runs", [
        { runId: "r-attached", state: "done", submittedAt: "2026-10-08T09:00:00Z", platformRequestHash: "a", mode: "deterministic" },
        { runId: "r-other", state: "done", submittedAt: "2026-10-09T09:00:00Z", platformRequestHash: "b", mode: "deterministic" },
      ]],
    ]);
    const loaded = await loadCompareRuns("ws-a");
    expect(loaded.scope?.ids).toEqual(["r-attached"]);
    const html = renderToStaticMarkup(<CompareBody ws="ws-a" runs={loaded.runs} scope={loaded.scope} query={{}} compare={null} />);
    expect(html).not.toContain("r-other");
    expect(html).toContain(">Standard ALCO · 2026-10-08 · 3 scenarios · Runoff</option>");
  });

  it("a failed workspace run list leaves the pickers unscoped with a note, not a failed screen", async () => {
    mockFetch([
      ["/api/workspaces/ws-a/runs", { error: { code: "internal", message: "the workspace runs could not be read" } }, 500],
      ["/api/runs", [
        { runId: "r-one", state: "done", submittedAt: "2026-10-08T09:00:00Z", platformRequestHash: "a", mode: "deterministic" },
        { runId: "r-two", state: "done", submittedAt: "2026-10-09T09:00:00Z", platformRequestHash: "b", mode: "deterministic" },
      ]],
    ]);
    const loaded = await loadCompareRuns("ws-a");
    expect(loaded.scope).toBeUndefined();
    const html = renderToStaticMarkup(<CompareBody ws="ws-a" runs={loaded.runs} scope={loaded.scope} scopeNote={loaded.scopeNote} query={{}} compare={null} />);
    expect(html).toContain("r-one");
    expect(html).toContain("r-two");
    expect(html).toContain("The workspace&#x27;s run list could not be read; all stored runs are listed.");
  });

  it("a stochastic pair from outside the workspace (a bookmarked link) still reads the stochastic comparison", async () => {
    mockFetch([
      ["/api/workspaces/ws-a/runs", [attached("r-in")]],
      ["/api/runs", [
        { runId: "r-in", state: "done", submittedAt: "2026-10-07T09:00:00Z", platformRequestHash: "a", mode: "deterministic" },
        { runId: "mc-out-1", state: "done", submittedAt: "2026-10-08T09:00:00Z", platformRequestHash: "b", mode: "stochastic" },
        { runId: "mc-out-2", state: "done", submittedAt: "2026-10-09T09:00:00Z", platformRequestHash: "c", mode: "stochastic" },
      ]],
    ]);
    const loaded = await loadCompareRuns("ws-a");
    const html = renderToStaticMarkup(<CompareChosen ws="ws-a" listed={loaded} query={{ runs: "mc-out-1,mc-out-2" }} cutoff={CUTOFF} />);
    expect(html).toContain("Reading the stochastic comparison of mc-out-1 and mc-out-2");
    expect(html).not.toContain("Reading the comparison of");
    // The address names runs the pickers do not offer; each stays visible as chosen with why.
    expect(html).toContain("mc-out-1, not a done run of this workspace");
    expect(html).toContain("mc-out-2, not a done run of this workspace");
  });
});

describe("the Grid as of date is the run detail's grid, for both modes", () => {
  const detail = (runId: string, mode: string, asOf: string | null) => ({
    runId,
    state: "done",
    submittedAt: "2026-10-08T09:00:00Z",
    platformRequestHash: "h",
    mode,
    scenarios: [],
    ...(asOf === null ? {} : { grid: { horizonMonths: 360, asOf } }),
  });

  it("reads GET /api/runs/:id and never the stored result", async () => {
    mockFetch([
      ["/api/runs/run-1/result", { error: { code: "not-found", message: "the result is not read here" } }, 404],
      ["/api/runs/run-1", detail("run-1", "deterministic", "2026-02-28")],
    ]);
    expect(await loadGridAsOf("run-1")).toBe("2026-02-28");
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(["/api/runs/run-1"]);
  });

  it("a stochastic run records its grid as-of; a pair on different grids prints both dates and the differ badge", async () => {
    mockFetch([
      ["/api/runs/mc-1", detail("mc-1", "stochastic", "2026-02-28")],
      ["/api/runs/mc-2", detail("mc-2", "stochastic", "2026-03-31")],
    ]);
    const a = await loadGridAsOf("mc-1");
    const b = await loadGridAsOf("mc-2");
    expect([a, b]).toEqual(["2026-02-28", "2026-03-31"]);
    const runs = [run("mc-1", { mode: "stochastic" }), run("mc-2", { mode: "stochastic" })];
    const t = text(renderToStaticMarkup(
      <StochasticCompareBody ws="ws-a" runs={runs} query={{ runs: "mc-1,mc-2" }} compare={{ state: "loading" }} grid={{ cutoff: CUTOFF, a: ok(a), b: ok(b) }} />,
    ));
    expect(t).toContain("Run A mc-1: Grid as of 2026-02-28 workspace cut-off 2026-03-31");
    expect(t).toContain("Run B mc-2: Grid as of 2026-03-31");
    expect(t).toContain("Grid dates differ");
    expect(t).toContain(DIFFER);
  });

  it("a run whose detail carries no grid reads not recorded", async () => {
    mockFetch([["/api/runs/old-1", detail("old-1", "deterministic", null)]]);
    expect(await loadGridAsOf("old-1")).toBeNull();
  });

  it("one side's failed read prints its error on that line; the other line and the comparison still show", () => {
    const html = renderToStaticMarkup(
      <CompareBody ws="ws-a" runs={RUNS} query={{ runs: "run-1,run-2" }} compare={{ state: "ok", value: REPLY }}
        grid={{ cutoff: CUTOFF, a: { state: "error", error: new Error("run run-1 is gone") }, b: ok("2026-03-31") }} />,
    );
    const t = text(html);
    expect(t).toContain("Run A run-1: Grid as of: not read. run run-1 is gone");
    expect(t).toContain("Run B run-2: Grid as of 2026-03-31");
    expect(t).not.toContain("Grid dates differ");
    expect(html).toContain(">Download CSV</a>");
    expect(html).toContain("hash-a");
  });
});
