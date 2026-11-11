import { describe, expect, it } from "vitest";
import { LAYERS, MODULES, SCREENS, firstLayerOf, hrefFor, parseHash, selectionQuery } from "../router";
import { resultsScreenOfTab } from "../pageLinks";

// Piece E1: parseHash returns a Route union; an old address is `{ kind: "legacy", layer, query, from }`.
const legacyOf = (hash: string) => {
  const r = parseHash(hash);
  if (r.kind !== "legacy") throw new Error(`${hash} did not parse as an old address`);
  return r;
};
import { TAB_ORDER } from "../pages/results/tabs";
// The core tab ids the registry refuses to a pack (registry.ts CORE_TAB_IDS) are TAB_ORDER exactly.
import { registerResultTab } from "../registry";

describe("route table", () => {
  it("has the four modules in order", () => {
    expect(MODULES.map((m) => m.label)).toEqual(["Data", "Model", "Analyze", "Govern"]);
  });
  it("every layer id is module/area/layer and unique", () => {
    const ids = LAYERS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of LAYERS) {
      expect(l.id.split("/")).toHaveLength(3);
      expect(l.id.startsWith(`${l.module}/`)).toBe(true);
    }
  });
  it("marks exactly the spec's Soon layers, each with a piece", () => {
    const soon = LAYERS.filter((l) => l.status === "soon").map((l) => [l.id, l.soon?.piece]);
    // Re-expectation: Rate indices is live; only Macro factors stays Soon.
    // Re-expectation: Macro factors is live; no layer is Soon.
    expect(soon).toEqual([]);
    const macro = LAYERS.find((x) => x.id === "data/market/macro");
    expect([macro?.status, macro?.label, macro?.area, macro?.soon]).toEqual(["live", "Macro factors", "Market", undefined]);
  });
  it("Rate indices is live with no soon piece (Piece 7a)", () => {
    const l = LAYERS.find((x) => x.id === "data/market/indices");
    expect(l?.status).toBe("live");
    expect(l?.label).toBe("Rate indices");
    expect(l?.area).toBe("Market");
    expect(l?.soon).toBeUndefined();
  });
  it("Behavioral shocks is live with no soon piece", () => {
    const l = LAYERS.find((x) => x.id === "data/scenarios/other-shocks");
    expect(l?.status).toBe("live");
    expect(l?.label).toBe("Behavioral shocks");
    expect(l?.soon).toBeUndefined();
  });
  it("Balance shocks is live with no soon piece", () => {
    const i = LAYERS.findIndex((x) => x.id === "data/scenarios/balance-shocks");
    const l = LAYERS[i];
    expect(l?.status).toBe("live");
    expect(l?.label).toBe("Balance shocks");
    expect(l?.area).toBe("Scenarios");
    expect(l?.soon).toBeUndefined();
    expect(i).toBe(LAYERS.findIndex((x) => x.id === "data/scenarios/other-shocks") + 1);
  });
  it("Funding spread shocks is live with no soon piece", () => {
    const i = LAYERS.findIndex((x) => x.id === "data/scenarios/funding-spread-shocks");
    const l = LAYERS[i];
    expect(l?.status).toBe("live");
    expect(l?.label).toBe("Funding spread shocks");
    expect(l?.area).toBe("Scenarios");
    expect(l?.soon).toBeUndefined();
    expect(i).toBe(LAYERS.findIndex((x) => x.id === "data/scenarios/balance-shocks") + 1);
  });
  // Re-expectation: Volatility shocks is live and follows Funding spread shocks; only Macro factors stays Soon.
  // Re-expectation: Macro factors is live; no layer is Soon.
  it("Volatility shocks is live with no soon piece, addressed at #/data/scenarios/volatility-shocks", () => {
    const i = LAYERS.findIndex((x) => x.id === "data/scenarios/volatility-shocks");
    const l = LAYERS[i];
    expect(l?.status).toBe("live");
    expect(l?.label).toBe("Volatility shocks");
    expect(l?.area).toBe("Scenarios");
    expect(l?.module).toBe("data");
    expect(l?.soon).toBeUndefined();
    expect(i).toBe(LAYERS.findIndex((x) => x.id === "data/scenarios/funding-spread-shocks") + 1);
  });
  // Re-expectation: Stochastic distributions is a live Measures layer straight after Rate paths, with no tab.
  it("Stochastic distributions is live after Rate paths, with no tab, addressed at #/analyze/measures/stochastic", () => {
    const i = LAYERS.findIndex((x) => x.id === "analyze/measures/stochastic");
    const l = LAYERS[i];
    expect(i).toBe(LAYERS.findIndex((x) => x.id === "analyze/measures/rates") + 1);
    expect(l?.status).toBe("live");
    expect(l?.tab).toBeUndefined();
    expect(l?.label).toBe("Stochastic distributions");
    expect(l?.area).toBe("Measures");
    expect(l?.module).toBe("analyze");
    expect(parseHash("#/analyze/measures/stochastic?run=r1")).toEqual({ kind: "legacy", layer: "analyze/measures/stochastic", query: { run: "r1" }, from: "#/analyze/measures/stochastic?run=r1" });
  });
  it("Hierarchies and mapping is live with no soon piece", () => {
    const l = LAYERS.find((x) => x.id === "data/balance/hierarchies");
    expect(l?.status).toBe("live");
    expect(l?.soon).toBeUndefined();
  });
  it("Loan repricing is live with no soon piece", () => {
    const l = LAYERS.find((x) => x.id === "data/assumptions/loan-repricing");
    expect(l?.status).toBe("live");
    expect(l?.soon).toBeUndefined();
  });
  it("Approvals and sign-off is live with no soon piece", () => {
    const l = LAYERS.find((x) => x.id === "govern/controls/approvals");
    expect(l?.status).toBe("live");
    expect(l?.soon).toBeUndefined();
  });
  it("every layer's tab is a Results tab id", () => {
    const tabIds: string[] = TAB_ORDER.map((t) => t.id);
    const withTab = LAYERS.filter((l) => l.tab !== undefined);
    expect(withTab.length).toBeGreaterThan(0);
    for (const l of withTab) expect(tabIds, l.id).toContain(l.tab);
  });
  it("first layers of each module", () => {
    expect(firstLayerOf("data")).toBe("data/balance/book");
    expect(firstLayerOf("model")).toBe("model/model/chain");
    expect(firstLayerOf("analyze")).toBe("analyze/overview/dashboard");
    expect(firstLayerOf("govern")).toBe("govern/records/lineage");
  });
  it("places Edit a set before Assumption stacks, and parses its set query (Piece 4a)", () => {
    expect(LAYERS.filter((l) => l.area === "Assumptions").map((l) => l.label)).toEqual([
      "Prepayment", "Deposit decay", "Deposit repricing", "Renewal and draws", "Loan repricing", "Edit a set", "Assumption stacks",
    ]);
    expect(parseHash("#/data/assumptions/edit?book=b1&set=demo-behavioral-v1")).toEqual({ kind: "legacy", layer: "data/assumptions/edit", query: { book: "b1", set: "demo-behavioral-v1" }, from: "#/data/assumptions/edit?book=b1&set=demo-behavioral-v1" });
  });
});

describe("parseHash", () => {
  it("reads an old layer path and its query", () => {
    expect(parseHash("#/data/market/curves?book=b1&asOf=m1")).toEqual({ kind: "legacy", layer: "data/market/curves", query: { book: "b1", asOf: "m1" }, from: "#/data/market/curves?book=b1&asOf=m1" });
  });
  it("opens Home for an empty or unknown path", () => {
    expect(parseHash("").kind).toBe("home");
    expect(parseHash("#/").kind).toBe("home");
    expect(parseHash("#/nope/x/y")).toEqual({ kind: "home", query: {}, unknown: "#/nope/x/y" });
  });
  it("opens Home on a malformed escape in the path", () => {
    expect(parseHash("#/%E0")).toEqual({ kind: "home", query: {}, unknown: "#/%E0" });
    expect(parseHash("#/data/%E0/book?book=b1")).toEqual({ kind: "home", query: { book: "b1" }, unknown: "#/data/%E0/book?book=b1" });
  });
  it("opens a module's first layer on a module-only address, keeping the query", () => {
    expect(parseHash("#/analyze")).toEqual({ kind: "legacy", layer: "analyze/overview/dashboard", query: {}, from: "#/analyze" });
    expect(parseHash("#/data?book=b1")).toEqual({ kind: "legacy", layer: "data/balance/book", query: { book: "b1" }, from: "#/data?book=b1" });
    expect(legacyOf("#/model").layer).toBe("model/model/chain");
    expect(legacyOf("#/govern/").layer).toBe("govern/records/lineage");
  });
  it("does not read an object prototype key as an old address", () => {
    for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(parseHash(`#/${key}?run=r1`), key).toEqual({ kind: "home", query: { run: "r1" }, unknown: `#/${key}?run=r1` });
    }
  });
  it("forwards every old address, keeping the query", () => {
    const q = "book=b1&asOf=m1";
    const cases: Array<[string, string]> = [
      ["#/home", "analyze/overview/dashboard"],
      ["#/balance-sheet", "data/balance/book"],
      ["#/market", "data/market/curves"],
      ["#/assumptions", "data/assumptions/stacks"],
      ["#/scenarios", "data/scenarios/sets"],
      ["#/plan", "model/model/chain"],
      ["#/run", "model/model/runs"],
      ["#/results", "analyze/overview/dashboard"],
      ["#/compare", "analyze/explain/compare"],
    ];
    for (const [old, layer] of cases) {
      expect(parseHash(`${old}?${q}`), old).toEqual({ kind: "legacy", layer, query: { book: "b1", asOf: "m1" }, from: `${old}?${q}` });
    }
  });
  it("forwards each old Results tab to its layer and drops tab", () => {
    const tabs: Array<[string, string]> = [
      ["overview", "analyze/overview/dashboard"],
      ["eve", "analyze/measures/eve"],
      ["nii", "analyze/measures/nii"],
      ["gap", "analyze/measures/gap"],
      ["ftp", "analyze/measures/ftp"],
      ["rates", "analyze/measures/rates"],
      ["attribution", "analyze/explain/attribution"],
      ["views", "analyze/explain/views"],
      ["metrics", "analyze/explain/metrics"],
      ["lenses", "analyze/explain/lenses"],
    ];
    for (const [tab, layer] of tabs) {
      expect(parseHash(`#/results?run=r1&tab=${tab}`), tab).toEqual({ kind: "legacy", layer, query: { run: "r1" }, from: `#/results?run=r1&tab=${tab}` });
    }
  });
  it("forwards an old Results address with an unknown tab to the Dashboard", () => {
    expect(parseHash("#/results?run=r1&tab=no-such-tab")).toEqual({ kind: "legacy", layer: "analyze/overview/dashboard", query: { run: "r1" }, from: "#/results?run=r1&tab=no-such-tab" });
  });
});

describe("hrefFor", () => {
  it("writes a workspace screen address", () => {
    expect(hrefFor({ ws: "ws-a", section: "market", screen: "vols", query: { tab: "caps" } })).toBe("#/ws/ws-a/market/vols?tab=caps");
    expect(hrefFor({ ws: "ws-a", section: "results", screen: "dashboard" })).toBe("#/ws/ws-a/results/dashboard");
  });
  it("writes a run setup slot as the fourth segment, and the result key only under Results", () => {
    expect(hrefFor({ ws: "ws-a", section: "run", screen: "setups", slot: "setup-standard-alco", query: { result: "r1", tab: "scenarios" } })).toBe("#/ws/ws-a/run/setups/setup-standard-alco?tab=scenarios");
    expect(hrefFor({ ws: "ws-a", section: "results", screen: "nii", query: { result: "r1" } })).toBe("#/ws/ws-a/results/nii?result=r1");
  });
  it("round-trips a workspace address through parseHash", () => {
    const query = { instance: "tlp" };
    const href = hrefFor({ ws: "ws-a", section: "market", screen: "curves", query });
    expect(parseHash(href)).toEqual({ kind: "screen", ws: "ws-a", section: "market", screen: "curves", query });
  });
});

describe("selectionQuery", () => {
  it("keeps only result, and only for a Results target", () => {
    const q = { book: "b", asOf: "m", plan: "p", run: "r", result: "run-1", tab: "nii", scenario: "S0", table: "eve" };
    expect(selectionQuery(q, "results")).toEqual({ result: "run-1" });
    expect(selectionQuery(q, "run")).toEqual({});
  });
});

describe("the Results tabs of Task 12", () => {
  it("the tab list is Overview, NII, EVE, Gap, FTP, SEG / EBP, Liquidity, Instruments, Attribution, Lenses, Rates, Views, Metrics", () => {
    expect(TAB_ORDER.map((t) => t.label)).toEqual([
      "Overview", "NII", "EVE", "Gap", "FTP", "SEG / EBP", "Liquidity", "Instruments", "Attribution", "Lenses", "Rates", "Views", "Metrics",
    ]);
  });
  it("the registry refuses every core tab id to a pack", () => {
    for (const t of TAB_ORDER) expect(() => registerResultTab({ id: t.id, body: () => null }), t.id).toThrow(/is a core tab/);
  });
  it("every Results tab other than Overview is a Results screen of the same id, and a tab key names its screen", () => {
    const screens: string[] = SCREENS.filter((s) => s.section === "results").map((s) => s.screen);
    for (const t of TAB_ORDER) {
      if (t.id === "overview") continue;
      expect(screens, t.id).toContain(t.id);
      expect(resultsScreenOfTab(t.id), t.id).toBe(t.id);
    }
    expect(resultsScreenOfTab("overview")).toBe("dashboard");
  });
  it("the three new screens carry no old layer address: LAYERS stays the frozen 42", () => {
    for (const id of ["seg", "liquidity", "instruments"]) {
      const s = SCREENS.find((x) => x.section === "results" && x.screen === id)!;
      expect(s.legacyLayers, id).toEqual([]);
    }
    expect(SCREENS.find((x) => x.screen === "seg")!.label).toBe("SEG / EBP");
  });
});
