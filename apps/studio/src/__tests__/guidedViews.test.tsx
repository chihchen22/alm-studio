// apps/studio/src/__tests__/guidedViews.test.tsx
/**
 * The guided flow's views and routes (S2a spec points 1, 2, 3, 5, 8 and 10): the analysis address space, the first
 * screen's three choices (the third only when a pack registers it), the cut-off defaulting to the newest snapshot, the
 * custom shock reader, the assumptions reason on the sets screens, the visible Scenario library pages and the
 * Dashboard's limits staying off unless the workspace attached some. Expected strings are written out here.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MarketListItem, ReadinessItem } from "@alm/reader";
import { analysisHref, ANALYSIS_STEPS, parseHash, type Route } from "../router";
import { routeHref } from "../routeHref";
import { headingFor } from "../shell/Shell";
import { Rail } from "../shell/Rail";
import { HomeView } from "../pages/workspace/HomePage";
import { NewView } from "../pages/workspace/NewPage";
import { readShock } from "../pages/analysis/ScenariosStep";
import { AssumptionReasonsView } from "../pages/assumptions/AssumptionReasons";
import { LimitUseCard } from "../pages/dashboard/DashboardPage";
import { newFormDefaults, withStart } from "../rows/workspaceRows";
import { baseSnapshots, defaultCutoff, freeName, freeWorkspaceId, newestSnapshot } from "../guided/start";
import { registeredStartChoices, registerStartChoice } from "../registry";
import { HEAD } from "./fixtures/workspace";

describe("the Analysis address space", () => {
  it("parses and writes #/ws/<ws>/analysis/<step> for the nine steps, and nothing else under analysis", () => {
    expect(ANALYSIS_STEPS.map((s) => s.id)).toEqual(["market", "balance", "behavior", "new-volume", "calibration", "simulation", "scenarios", "run", "reports"]);
    expect(parseHash("#/ws/ws-a/analysis/new-volume?x=1")).toEqual({ kind: "analysis", ws: "ws-a", step: "new-volume", query: { x: "1" } });
    expect(parseHash("#/ws/ws-a/analysis/nowhere")).toMatchObject({ kind: "home", unknown: "#/ws/ws-a/analysis/nowhere" });
    expect(analysisHref("ws a", "reports", { run: "r1" })).toBe("#/ws/ws%20a/analysis/reports?run=r1");
    const r: Route = { kind: "analysis", ws: "ws-a", step: "run", query: {} };
    expect(routeHref(r)).toBe("#/ws/ws-a/analysis/run");
    expect(headingFor(r)).toEqual({ crumb: "Analysis / Run", title: "Run" });
  });
  it("the rail lists the nine steps in order on the path, and the Scenario library's pages under Run", () => {
    const steps = renderToStaticMarkup(<Rail route={{ kind: "analysis", ws: HEAD.id, step: "behavior", query: {} }} head={HEAD} />);
    expect((steps.match(/class="rail-item rail-step"/g) ?? []).length).toBe(9);
    expect(steps).toMatch(/href="#\/ws\/ws-synthetic-2500-v1\/analysis\/behavior" aria-current="page"/);
    const run = renderToStaticMarkup(<Rail route={{ kind: "screen", ws: HEAD.id, section: "run", screen: "scenarios", query: { tab: "volatility" } }} head={HEAD} />);
    for (const label of ["Custom rate shocks", "Behavioral shocks", "Balance shocks", "Funding spread shocks", "Volatility shocks"]) expect(run).toContain(label);
    expect(run).toMatch(/href="#\/ws\/ws-synthetic-2500-v1\/run\/scenarios\?tab=volatility" aria-current="page"/);
  });
});

describe("the first screen", () => {
  it("offers Start a new analysis and Explore the example bank on an empty store and a full one", () => {
    for (const ws of [[], [HEAD]]) {
      const html = renderToStaticMarkup(<HomeView workspaces={ws} banner={null} />);
      expect(html).toContain("Pick a starting point");
      expect(html).toContain(">Start a new analysis<");
      expect(html).toContain(">Explore the example bank<");
    }
  });
  it("shows a third choice only when a pack registers one", () => {
    const before = renderToStaticMarkup(<HomeView workspaces={[]} banner={null} />);
    expect(before).not.toContain("Reproduce");
    if (!registeredStartChoices().some((c) => c.id === "test-choice")) {
      registerStartChoice({ id: "test-choice", title: "A pack choice", description: "Registered by a test.", render: () => <span>pack action</span> });
    }
    const after = renderToStaticMarkup(<HomeView workspaces={[]} banner={null} />);
    expect(after).toContain("A pack choice");
    expect(after).toContain("pack action");
    expect(() => registerStartChoice({ id: "test-choice", title: "x", description: "x", render: () => null })).toThrow(/already registered/);
  });
  it("a new workspace starts on the newest base snapshot's date, never a derived market's, and frees its id and name", () => {
    const markets: MarketListItem[] = [
      { id: "m-old", calibrationDate: "2025-12-31" },
      { id: "m-new", calibrationDate: "2026-03-31" },
      { id: "m-derived", calibrationDate: "2026-06-30", derivedFromMarketId: "m-new" },
    ];
    expect(baseSnapshots(markets).map((m) => m.id)).toEqual(["m-new", "m-old"]);
    expect(newestSnapshot(markets)?.id).toBe("m-new");
    expect(defaultCutoff(markets, "2026-10-31")).toBe("2026-03-31");
    expect(defaultCutoff([], "2026-10-31")).toBe("2026-10-31");
    expect(freeWorkspaceId("Example bank", [{ id: "ws-example-bank" }])).toBe("ws-example-bank-2");
    expect(freeName("My analysis", [{ name: "My analysis" }, { name: "My analysis 2" }])).toBe("My analysis 3");
    const html = renderToStaticMarkup(<NewView workspaces={[HEAD]} today={new Date(Date.UTC(2026, 9, 9))} marketDate="2026-03-31" />);
    expect(html).toMatch(/value="2026-03-31"/);
    expect(html).not.toMatch(/value="2026-09-30"/);
  });
  it("switching to Roll forward and back to Blank keeps the snapshot's date, never today's month-end (fix round 1, M2)", () => {
    const today = new Date(Date.UTC(2026, 9, 31));
    const source = { ...HEAD, cutoffDate: "2026-03-31" };
    const start = { ...newFormDefaults(today), cutoffDate: "2026-03-31" };
    const rolled = withStart(start, "roll-forward", source, today, "2026-03-31");
    expect(rolled.cutoffDate).toBe("2026-04-30");
    expect(withStart(rolled, "blank", null, today, "2026-03-31").cutoffDate).toBe("2026-03-31");
    // With no snapshot in the store the month-end fallback stands, as before.
    expect(withStart(rolled, "blank", null, today).cutoffDate).toBe("2026-09-30");
  });
});

describe("a custom shock by tenor", () => {
  it("reads knots in order, and names each problem plainly", () => {
    const ok = readShock("BEAR", "", [{ tenor: "1", bp: "25" }, { tenor: "10", bp: "100" }, { tenor: "", bp: "" }], []);
    expect(ok.shock).toEqual({ id: "BEAR", label: "BEAR", knots: [{ tenorYears: 1, shockBp: 25 }, { tenorYears: 10, shockBp: 100 }] });
    expect(readShock("S100", "", [{ tenor: "1", bp: "1" }], []).problems).toEqual(["The name S100 is taken; choose another."]);
    expect(readShock("X", "", [{ tenor: "10", bp: "1" }, { tenor: "1", bp: "2" }], []).problems).toEqual(["List the tenors from shortest to longest, each once."]);
    expect(readShock("", "", [], []).problems).toEqual(["Give the shock a short name: letters, digits, dash or underscore, starting with a letter or digit.", "Type a shock beside at least one tenor."]);
    // The four suggested tenors with two shocks typed: the two blank rows are not used (fix round 1, L1).
    const two = readShock("TWO", "Two knots", [{ tenor: "1", bp: "50" }, { tenor: "5", bp: "" }, { tenor: "10", bp: "-25" }, { tenor: "30", bp: "" }], []);
    expect(two).toEqual({ shock: { id: "TWO", label: "Two knots", knots: [{ tenorYears: 1, shockBp: 50 }, { tenorYears: 10, shockBp: -25 }] }, problems: [] });
    expect(readShock("Z", "", [{ tenor: "", bp: "5" }], []).problems).toEqual(["Row 1: type the tenor in years, above zero."]);
    expect(readShock("Y", "", [{ tenor: "0", bp: "5" }], []).problems).toEqual(["Row 1: type the tenor in years, above zero."]);
  });
});

describe("plain reasons and no demonstration limits", () => {
  it("the sets screens say why the assumptions read Error, and say nothing when all is fine", () => {
    const items: ReadinessItem[] = [{ section: "assumptions", item: "Sets", state: "error", required: true, detail: 'set "demo" binds unknown family "mortgages"' }];
    const html = renderToStaticMarkup(<AssumptionReasonsView ws="ws-a" items={items} />);
    expect(html).toContain("Sets (error): set &quot;demo&quot; binds unknown family &quot;mortgages&quot;");
    expect(html).toContain('href="#/ws/ws-a/analysis/behavior"');
    expect(renderToStaticMarkup(<AssumptionReasonsView ws="ws-a" items={[{ ...items[0]!, state: "valid" }]} />)).toBe("");
  });
  it("a workspace with no limits attached scores none; one with limits sees only its own", () => {
    const model = { state: "ok" as const, rows: [
      { lensId: "rate-demo-v1", label: "Rate", status: "breach" as const, statusText: "Breach", statusClass: "status", headroom: null, worst: null },
      { lensId: "balance-demo-v1", label: "Balance", status: "pass" as const, statusText: "Pass", statusClass: "status", headroom: null, worst: null },
    ] };
    const none = renderToStaticMarkup(<LimitUseCard runId="r" model={model} lensIds={[]} />);
    // The sentence written out here, not read from the code under test (fix round 1, L11).
    expect(none).toContain("No limits are set for this workspace, so nothing is scored against a limit. Demonstration limits stay off until a workspace attaches them.");
    expect(none).not.toContain("Breach");
    const one = renderToStaticMarkup(<LimitUseCard runId="r" model={model} lensIds={["balance-demo-v1"]} />);
    expect(one).toContain("Balance");
    expect(one).not.toContain(">Rate<");
    const legacy = renderToStaticMarkup(<LimitUseCard runId="r" model={model} />);
    expect(legacy).toContain("Breach");
  });
});
