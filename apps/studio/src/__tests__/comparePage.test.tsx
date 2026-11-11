import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { compareCsvUrl, getCompare, listRuns, type CompareReply, type RunSummary } from "@alm/reader";
import {
  COMPARE_TABLES,
  cellText,
  compareHref,
  compareRouteOf,
  deltaText,
  headerCells,
  modeIn,
  parseCompareQuery,
  runOptions,
  tableLabelOf,
} from "../compare/compareModel";
import { CompareTable, ProvenanceCard, RunPickers } from "../pages/compare/CompareViews";
import { CompareBody, ComparePage } from "../pages/compare/ComparePage";
import { RunStrip } from "../pages/results/ResultsPage";
import { DETAIL } from "./fixtures/results";
import { mockFetch } from "./fixtures/run";

afterEach(() => vi.unstubAllGlobals());

const run = (runId: string, over: Partial<RunSummary> = {}): RunSummary => ({
  runId,
  state: "done",
  submittedAt: `2026-09-2${runId.slice(-1)}T10:00:00Z`,
  platformRequestHash: `prh-${runId}`,
  mode: "deterministic",
  ...over,
});

const RUNS: RunSummary[] = [
  run("run-1", { label: "Base book" }),
  run("run-2"),
  run("run-3", { mode: "stochastic" }),
  run("run-4", { state: "running" }),
];

const REPLY: CompareReply = {
  table: "nii",
  columns: [
    { name: "scenarioId", role: "key" },
    { name: "familyId", role: "key" },
    { name: "net12", role: "num" },
    { name: "note", role: "text" },
  ],
  rows: [
    { key: { scenarioId: "S0", familyId: "mortgage" }, a: { net12: 1234.5678912, note: "x" }, b: { net12: 1300, note: null }, delta: { net12: 65.4321088 } },
    { key: { scenarioId: "S0", familyId: "cards" }, a: { net12: 10, note: "only a" }, b: null, delta: { net12: null } },
    { key: { scenarioId: "S0", familyId: "swaps" }, a: null, b: { net12: -20, note: "only b" }, delta: { net12: null } },
    { key: { scenarioId: "S200", familyId: "TOTAL" }, a: { net12: 50, note: null }, b: { net12: 40, note: null }, delta: { net12: -10 } },
  ],
  provenance: {
    a: { runId: "run-1", inputsHash: "hash-a", schemaVersion: "1.3.0", engineVersion: "2.0.0" },
    b: { runId: "run-2", inputsHash: "hash-b", schemaVersion: "1.3.0", engineVersion: "2.0.1" },
  },
  note: "derived columns are B - A, displayed beside both originals",
};

describe("compare model", () => {
  it("lists the six export tables in csv.ts order", () => {
    expect(COMPARE_TABLES).toEqual(["nii", "eve", "repricing-gap", "liquidity-gap", "attribution", "cashflows"]);
  });

  it("parseCompareQuery reads runs=a,b; a missing or unknown table is nii", () => {
    expect(parseCompareQuery({ runs: "run-1,run-2", table: "eve" })).toEqual({ a: "run-1", b: "run-2", table: "eve" });
    expect(parseCompareQuery({ runs: "run-1," })).toEqual({ a: "run-1", b: null, table: "nii" });
    expect(parseCompareQuery({ runs: ",run-2", table: "bogus" })).toEqual({ a: null, b: "run-2", table: "nii" });
    expect(parseCompareQuery({})).toEqual({ a: null, b: null, table: "nii" });
  });

  it("compareHref keeps the other query keys and writes runs and table", () => {
    expect(compareHref("ws-a", { book: "b1", scenario: "S0" }, "run-1", "run-2", "eve")).toBe("#/ws/ws-a/results/compare?scenario=S0&runs=run-1%2Crun-2&table=eve");
    expect(compareHref("ws-a", {}, "run-1", null, "nii")).toBe("#/ws/ws-a/results/compare?runs=run-1%2C&table=nii");
    expect(compareHref("ws-a", { runs: "x,y" }, null, null, "cashflows")).toBe("#/ws/ws-a/results/compare?table=cashflows");
    const back = compareHref("ws-a", {}, "run-1", "run-2", "attribution");
    expect(parseCompareQuery(Object.fromEntries(new URLSearchParams(back.split("?")[1])))).toEqual({ a: "run-1", b: "run-2", table: "attribution" });
  });

  it("runOptions offers done runs only, newest first; with no other run chosen every done run is enabled", () => {
    expect(runOptions(RUNS)).toEqual([
      { runId: "run-3", text: "run-3", disabled: null },
      { runId: "run-2", text: "run-2", disabled: null },
      { runId: "run-1", text: "run-1 (Base book)", disabled: null },
    ]);
  });

  it("runOptions beside a deterministic run disables the stochastic run with its reason", () => {
    const stochasticReason = "stochastic run: the other run is deterministic, and a distribution compares only with another stochastic run";
    expect(runOptions(RUNS, "deterministic")).toEqual([
      { runId: "run-3", text: "run-3", disabled: stochasticReason },
      { runId: "run-2", text: "run-2", disabled: null },
      { runId: "run-1", text: "run-1 (Base book)", disabled: null },
    ]);
  });

  it("runOptions beside a stochastic run disables the deterministic runs and leaves the stochastic run enabled", () => {
    const deterministicReason = "deterministic run: the other run is stochastic, and a deterministic result compares only with another deterministic run";
    expect(runOptions(RUNS, "stochastic")).toEqual([
      { runId: "run-3", text: "run-3", disabled: null },
      { runId: "run-2", text: "run-2", disabled: deterministicReason },
      { runId: "run-1", text: "run-1 (Base book)", disabled: deterministicReason },
    ]);
  });

  it("modeIn reads the listing mode; an unlisted or unchosen run is null, a row with no mode is deterministic", () => {
    expect(modeIn(RUNS, "run-3")).toBe("stochastic");
    expect(modeIn(RUNS, "run-1")).toBe("deterministic");
    expect(modeIn(RUNS, "run-4")).toBe("deterministic");
    expect(modeIn(RUNS, "ghost")).toBeNull();
    expect(modeIn(RUNS, null)).toBeNull();
    const noMode: RunSummary = { runId: "run-9", state: "done", submittedAt: "2026-09-29T10:00:00Z", platformRequestHash: "prh-9" };
    expect(modeIn([noMode], "run-9")).toBe("deterministic");
  });

  it("compareRouteOf is stochastic when either side is a stochastic run", () => {
    expect(compareRouteOf(RUNS, "run-1", "run-2")).toBe("deterministic");
    expect(compareRouteOf(RUNS, "run-3", "run-3")).toBe("stochastic");
    expect(compareRouteOf(RUNS, "run-1", "run-3")).toBe("stochastic");
    expect(compareRouteOf(RUNS, "run-1", "ghost")).toBe("deterministic");
  });

  it("tableLabelOf is null for a deterministic route and truthful for each other state", () => {
    expect(tableLabelOf(RUNS, "run-1", "run-2")).toBeNull();
    expect(tableLabelOf(RUNS, "run-3", "run-3")).toBe("Table: both distribution tables (a stochastic pair)");
    const mixed = "Table: none, a deterministic run and a stochastic run do not compare (the server's reason is below)";
    expect(tableLabelOf(RUNS, "run-1", "run-3")).toBe(mixed);
    expect(tableLabelOf(RUNS, "run-3", "run-1")).toBe(mixed);
    const once = "Table: both distribution tables, once the other run is a stochastic run";
    expect(tableLabelOf(RUNS, "run-3", null)).toBe(once);
    expect(tableLabelOf(RUNS, null, "run-3")).toBe(once);
  });

  it("cellText prints the reason for a missing cell, never a number", () => {
    expect(cellText(undefined, "B", false)).toBe("not in run B");
    expect(cellText(5, "A", false)).toBe("not in run A");
    expect(cellText(null, "A", true)).toBe("none");
    expect(cellText(undefined, "A", true)).toBe("none");
    expect(cellText(1234.5678912, "A", true)).toBe("1,234.567891");
    expect(cellText(0, "A", true)).toBe("0");
    expect(cellText(-1e-9, "A", true)).toBe("0");
    expect(cellText(-1234.5, "B", true)).toBe("-1,234.5");
    expect(cellText("S0", "A", true)).toBe("S0");
    expect(cellText(true, "B", true)).toBe("true");
  });

  it("deltaText signs a number, prints zero bare and null as none", () => {
    expect(deltaText(null)).toBe("none");
    expect(deltaText(65.4321088)).toBe("+65.432109");
    expect(deltaText(-1234.5)).toBe("-1,234.5");
    expect(deltaText(0)).toBe("0");
    expect(deltaText(-0)).toBe("0");
  });

  it("headerCells: keys, then A, B and the derived B - A for num columns", () => {
    expect(headerCells(REPLY)).toEqual(["scenarioId", "familyId", "net12 A", "net12 B", "net12 B - A (derived)", "note A", "note B"]);
  });
});

describe("CompareTable", () => {
  const html = renderToStaticMarkup(<CompareTable reply={REPLY} />);

  it("prints the header, keys and both sides", () => {
    for (const h of headerCells(REPLY)) expect(html).toContain(`>${h}</th>`);
    expect(html).toContain(">mortgage</td>");
    // Row header scope 2: the first key cell names its row, the other keys stay cells.
    expect(html).toContain('<tr><th scope="row" class="mono">S0</th><td class="mono">mortgage</td>');
    expect(html).toContain('<tr><th scope="row" class="mono">S200</th><td class="mono">TOTAL</td>');
    expect(html).toContain(">1,234.567891</td>");
    expect(html).toContain(">1,300</td>");
  });

  it("an A-only row says not in run B; a B-only row says not in run A; their delta is none", () => {
    expect(html.split(">not in run B</td>").length - 1).toBe(2);
    expect(html.split(">not in run A</td>").length - 1).toBe(2);
    expect(html).toContain(">none</td>");
  });

  it("prints the signed derived delta in num cells", () => {
    expect(html).toContain('<td class="num" title="65.4321088">+65.432109</td>');
    expect(html).toContain('<td class="num" title="-10">-10</td>');
    expect(html).toContain('<th scope="col" class="num">net12 B - A (derived)</th>');
  });

  it("never prints a dash or a zero for a missing cell", () => {
    expect(html).not.toContain(">-</td>");
    expect(html).not.toContain(">0</td>");
  });
});

describe("ProvenanceCard", () => {
  it("prints both run ids, input hashes and the note verbatim", () => {
    const html = renderToStaticMarkup(<ProvenanceCard reply={REPLY} />);
    for (const s of ["run-1", "run-2", "hash-a", "hash-b", "2.0.0", "2.0.1", REPLY.note]) expect(html).toContain(s);
  });
});

describe("RunPickers", () => {
  it("shows the stochastic run disabled beside a deterministic run A, and selects the chosen runs", () => {
    const reason = "stochastic run: the other run is deterministic, and a distribution compares only with another stochastic run";
    const html = renderToStaticMarkup(<RunPickers ws="ws-a" runs={RUNS} a="run-1" b={null} table="eve" query={{}} />);
    // Run B sees run-1 chosen, so the stochastic run-3 is disabled; Run A sees no other run, so run-3 is plain.
    expect(html).toContain(`<option value="run-3" disabled="" title="${reason}">run-3, ${reason}</option>`);
    expect(html).toContain('<option value="run-3">run-3</option>');
    expect(html).toContain('<option value="run-1" selected="">run-1 (Base book)</option>');
    expect(html).not.toContain('value="run-4"');
    expect(html).toContain('<option value="eve" selected="">eve</option>');
    for (const t of COMPARE_TABLES) expect(html).toContain(`<option value="${t}"`);
  });

  it("a chosen label longer than the select's cap is also the select's title, so a clipped label can be read (Part 2 D15)", () => {
    const long = [run("run-20260921-nii-eve-all-families", { label: "Quarter-end base book with the steep scenarios" }), run("run-2")];
    const html = renderToStaticMarkup(<RunPickers ws="ws-a" runs={long} a="run-20260921-nii-eve-all-families" b={null} table="eve" query={{}} />);
    expect(html).toMatch(/<select[^>]*title="run-20260921-nii-eve-all-families \(Quarter-end base book with the steep scenarios\)"/);
    // Run B has nothing chosen: its select carries no title.
    expect(html.match(/<select[^>]*title=/g)).toHaveLength(1);
  });

  it("a label that fits carries no title, so a short comparison's markup is unchanged", () => {
    const html = renderToStaticMarkup(<RunPickers ws="ws-a" runs={RUNS} a="run-1" b={null} table="eve" query={{}} />);
    expect(html).not.toMatch(/<select[^>]*title=/);
  });

  it("a scoped picker titles the select with the row text of the workspace's own list", () => {
    const scope = { ids: ["run-1", "run-2"], rowTexts: { "run-1": "run-1 (Base book, 2026-09-21 10:00, deterministic)", "run-2": "run-2" } };
    const html = renderToStaticMarkup(<RunPickers ws="ws-a" runs={RUNS} a="run-1" b={null} table="eve" query={{}} scope={scope} />);
    expect(html).toMatch(/<select[^>]*title="run-1 \(Base book, 2026-09-21 10:00, deterministic\)"/);
  });

  it("a stochastic run A shows no Table select and says the tables are the distribution tables once the other run is stochastic", () => {
    const html = renderToStaticMarkup(<RunPickers ws="ws-a" runs={RUNS} a="run-3" b={null} table="eve" query={{}} />);
    expect(html).not.toContain('<option value="nii"');
    expect(html).toContain("Table: both distribution tables, once the other run is a stochastic run");
  });

  it("a mixed pair says the two do not compare and never calls itself a stochastic pair", () => {
    const html = renderToStaticMarkup(<RunPickers ws="ws-a" runs={RUNS} a="run-1" b="run-3" table="nii" query={{}} />);
    expect(html).toContain("Table: none, a deterministic run and a stochastic run do not compare (the server&#x27;s reason is below)");
    expect(html).not.toContain("a stochastic pair");
    expect(html).not.toContain('<option value="nii"');
  });

  it("a stochastic pair names the distribution tables", () => {
    const runs = [...RUNS, run("run-5", { mode: "stochastic" })];
    const html = renderToStaticMarkup(<RunPickers ws="ws-a" runs={runs} a="run-3" b="run-5" table="nii" query={{}} />);
    expect(html).toContain("Table: both distribution tables (a stochastic pair)");
    expect(html).not.toContain('<option value="nii"');
  });

  it("a chosen run the listing does not offer stays visible with why", () => {
    const html = renderToStaticMarkup(<RunPickers ws="ws-a" runs={RUNS} a="run-4" b="run-2" table="nii" query={{}} />);
    expect(html).toContain('<option value="run-4" disabled="" selected="">run-4, not a done run in /api/runs</option>');
  });
});

describe("deterministic Compare is unchanged", () => {
  // sha256 of the markup, measured on the unmodified code and never re-pinned.
  const DET_RUNS: RunSummary[] = [run("run-1", { label: "Base book" }), run("run-2"), run("run-4", { state: "running" })];
  const sha = (html: string) => createHash("sha256").update(html, "utf8").digest("hex");

  it("CompareBody, compare ok", () => {
    const html = renderToStaticMarkup(<CompareBody ws="ws-a" runs={DET_RUNS} query={{ runs: "run-1,run-2", table: "nii" }} compare={{ state: "ok", value: REPLY }} />);
    expect(html.length).toBe(2843);
    expect(sha(html)).toBe("dc2125c9483e8afb662e64050fce583b2ce5409eda0370b636c6a67d37ce3f8c");
  });

  it("CompareBody, compare null", () => {
    const html = renderToStaticMarkup(<CompareBody ws="ws-a" runs={DET_RUNS} query={{ runs: "run-1," }} compare={null} />);
    expect(html.length).toBe(849);
    expect(sha(html)).toBe("4ef44b885e34e236d586c66f75fe4a2552ed0a92d1c30974031009c9dfebed4a");
  });

  it("CompareBody, compare error", () => {
    const html = renderToStaticMarkup(<CompareBody ws="ws-a" runs={DET_RUNS} query={{ runs: "run-1,run-4" }} compare={{ state: "error", error: new Error("409 conflict: x") }} />);
    expect(html.length).toBe(811);
    expect(sha(html)).toBe("18bc563924034d7812136a731b0acfc179214680040cdb640681e105ec68bb6d");
  });

  it("CompareTable", () => {
    const html = renderToStaticMarkup(<CompareTable reply={REPLY} />);
    expect(html.length).toBe(1193);
    expect(sha(html)).toBe("e82dcb6c70e144ce5c17b9d3d0f72514849c4d0f7cb0df6b4b177ea51d6227c3");
  });

  it("ProvenanceCard", () => {
    const html = renderToStaticMarkup(<ProvenanceCard reply={REPLY} />);
    expect(html.length).toBe(554);
    expect(sha(html)).toBe("f28e04890daf4d714497fbaf15633a21dee347788089e1eb654583e4b30d8f9f");
  });

  it("RunPickers, run A chosen, run B open", () => {
    const html = renderToStaticMarkup(<RunPickers ws="ws-a" runs={DET_RUNS} a="run-1" b={null} table="eve" query={{}} />);
    expect(html.length).toBe(682);
    expect(sha(html)).toBe("af5c6ae30a29973105a31fa0066f1f564286ec8f07b8307d123d147aa3aa3e51");
  });
});

describe("the page", () => {
  // Effects do not run under renderToStaticMarkup, so the reader calls run
  // here under mockFetch and their answers feed the exported body directly.
  it("renders the table and a Download CSV link to compare.csv", async () => {
    mockFetch([["/api/compare?", REPLY], ["/api/runs", RUNS]]);
    const runs = await listRuns();
    const reply = await getCompare("run-1", "run-2", "nii");
    const html = renderToStaticMarkup(<CompareBody ws="ws-a" runs={runs} query={{ runs: "run-1,run-2" }} compare={{ state: "ok", value: reply }} />);
    expect(html).toContain(`href="${compareCsvUrl("run-1", "run-2", "nii").replace(/&/g, "&amp;")}"`);
    expect(html).toContain(">Download CSV</a>");
    expect(html).toContain(">net12 B - A (derived)</th>");
    expect(html).toContain("Source: GET /api/compare (the aligned table compare.csv renders; B - A is the one derived column)");
    expect(html).toContain("hash-a");
  });

  it("a 409 from /api/compare prints the server's message in an alert", async () => {
    mockFetch([["/api/compare?", { error: { code: "conflict", message: "run run-4 is running; compare requires state done" } }, 409], ["/api/runs", RUNS]]);
    const runs = await listRuns();
    const error = await getCompare("run-1", "run-4", "nii").then(() => null, (e: Error) => e);
    expect(error).not.toBeNull();
    const html = renderToStaticMarkup(<CompareBody ws="ws-a" runs={runs} query={{ runs: "run-1,run-4" }} compare={{ state: "error", error: error! }} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("409: run run-4 is running; compare requires state done");
    expect(html).not.toContain("<table");
  });

  it("with fewer than two runs chosen it asks for two and draws no table", () => {
    const queries: Array<Record<string, string>> = [{}, { runs: "run-1," }];
    for (const query of queries) {
      const html = renderToStaticMarkup(<CompareBody ws="ws-a" runs={RUNS} query={query} compare={null} />);
      expect(html).toContain("Pick two done runs.");
      expect(html).not.toContain("<table");
      expect(html).not.toContain("Download CSV");
    }
  });

  it("renders a loading card before the run list answers", () => {
    expect(renderToStaticMarkup(<ComparePage ws="ws-a" query={{}} />)).toContain("Reading the run list");
  });
});

describe("RunStrip", () => {
  it("carries the Compare with... link seeded with this run as A", () => {
    const html = renderToStaticMarkup(<RunStrip ws="ws-a" runId="run-fixture" data={{ detail: DETAIL, result: null, note: "n" }} query={{ run: "run-fixture" }} />);
    expect(html).toContain('href="#/ws/ws-a/results/compare?runs=run-fixture%2C&amp;table=nii"');
    expect(html).toContain(">Compare with...</a>");
  });

  it("carries nothing of the results query into the Compare with... link: the workspace names the book and the market", () => {
    const query = { book: "synthetic-2500-v1", asOf: "2026-03-31", run: "run-fixture", tab: "eve" };
    const html = renderToStaticMarkup(<RunStrip ws="ws-a" runId="run-fixture" data={{ detail: DETAIL, result: null, note: "n" }} query={query} />);
    expect(html).toContain('href="#/ws/ws-a/results/compare?runs=run-fixture%2C&amp;table=nii"');
    expect(html).not.toContain("asOf=");
  });
});
