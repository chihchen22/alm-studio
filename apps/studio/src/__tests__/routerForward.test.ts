import { describe, expect, it } from "vitest";
import {
  LAYERS, LEGACY_PAGE_IDS, MODULES, SCREENS, SECTIONS, SELECTION_KEYS,
  compareHref, hrefFor, homeHref, parseHash, selectionQuery,
} from "../router";
import { resolveLegacyRoute, type LegacyResolution } from "../resolveLegacy";

type Fixture = { workspaces: Array<{ id: string; bookId: string | null; runIds: string[]; setupPlanIds: string[] }> };
const none: Fixture = { workspaces: [] };
const one: Fixture = { workspaces: [{ id: "ws-a", bookId: "book-a", runIds: ["run-1"], setupPlanIds: ["plan-x"] }] };
const two: Fixture = { workspaces: [{ id: "ws-a", bookId: "book-a", runIds: [], setupPlanIds: [] }, { id: "ws-b", bookId: "book-a", runIds: ["run-2"], setupPlanIds: [] }] };
const resolve = (hash: string, f: Fixture): Promise<LegacyResolution> => resolveLegacyRoute(parseHash(hash), {
  listWorkspaces: async () => f.workspaces.map((w) => ({ id: w.id, bookId: w.bookId, setupPlanIds: w.setupPlanIds })),
  workspacesOfRun: async (runId) => f.workspaces.filter((w) => w.runIds.includes(runId)).map((w) => w.id),
});

describe("the SCREENS table", () => {
  it("covers every layer exactly once except the two retired ones, and every screen has a section", () => {
    const covered = SCREENS.flatMap((s) => s.legacyLayers);
    const retired = ["data/assumptions/edit", "model/model/chain"];
    for (const l of LAYERS) expect(covered.filter((x) => x === l.id).length + (retired.includes(l.id) ? 1 : 0), l.id).toBe(1);
    expect(SCREENS.every((s) => ["workspace", "market", "balance", "assumptions", "run", "results", "govern"].includes(s.section))).toBe(true);
  });
  it("lists the seven sections in order and the 40 screens of spec Section 3.1 plus Market > Curve setups (Piece B, B1), Market > Derived curves (Piece B, B2) and the three Results screens of Task 12 (SEG / EBP, Liquidity, Instruments) section by section", () => {
    expect(SECTIONS.map((s) => [s.id, s.label])).toEqual([
      ["workspace", "Workspace"], ["market", "Market"], ["balance", "Balance Sheet"], ["assumptions", "Assumptions"],
      ["run", "Run"], ["results", "Results"], ["govern", "Govern"],
    ]);
    const bySection = (id: string) => SCREENS.filter((s) => s.section === id).map((s) => s.screen);
    expect(bySection("workspace")).toEqual(["overview"]);
    expect(bySection("market")).toEqual(["curves", "curve-builder", "derived-curves", "vols", "rate-model", "indices", "macro"]);
    expect(bySection("balance")).toEqual(["positions", "coa", "hierarchies", "templates", "strategy"]);
    expect(bySection("assumptions")).toEqual(["prepay", "decay", "deposit-repricing", "renewals-draws", "loan-client-rate", "mapping", "sets"]);
    expect(bySection("run")).toEqual(["setups", "scenarios", "batches", "queue", "instrument"]);
    expect(bySection("results")).toEqual(["dashboard", "nii", "eve", "gap", "ftp", "seg", "liquidity", "instruments", "rates", "stochastic", "attribution", "views", "metrics", "lenses", "compare"]);
    expect(bySection("govern")).toEqual(["lineage", "inventory", "audit", "limits", "approvals"]);
    expect(SCREENS).toHaveLength(45); // the core table; a pack registers its own screens
  });
  it("LAYERS stays the 42-row frozen constant the forwarding is tested against", () => {
    expect(LAYERS).toHaveLength(42);
    expect(Object.isFrozen(LAYERS)).toBe(true);
    expect(LEGACY_PAGE_IDS).toEqual(["home", "balance-sheet", "market", "assumptions", "scenarios", "plan", "run", "results", "compare"]);
    expect(MODULES.map((m) => m.id)).toEqual(["data", "model", "analyze", "govern"]);
  });
});

describe("new addresses parse", () => {
  it("workspace screens, home, new and compare", () => {
    expect(parseHash("#/ws/ws-a/results/nii?result=run-1&tab=x")).toEqual({ kind: "screen", ws: "ws-a", section: "results", screen: "nii", query: { result: "run-1", tab: "x" } });
    expect(parseHash("#/ws/ws-a/run/setups/setup-1")).toEqual({ kind: "screen", ws: "ws-a", section: "run", screen: "setups", query: {}, slot: "setup-1" });
    expect(parseHash("#/workspaces")).toEqual({ kind: "home", query: {} });
    expect(parseHash("#/workspaces/compare?a=x&b=y")).toEqual({ kind: "compare", query: { a: "x", b: "y" } });
    expect(parseHash("#/nothing/here")).toEqual({ kind: "home", query: {}, unknown: "#/nothing/here" });
  });
  it("the new-workspace address, the empty hash and addresses that name no screen", () => {
    expect(parseHash("#/workspaces/new")).toEqual({ kind: "new", query: {} });
    expect(parseHash("")).toEqual({ kind: "home", query: {} });
    expect(parseHash("#/")).toEqual({ kind: "home", query: {} });
    // A section with no such screen, a slot outside run/setups and a malformed escape name no screen.
    expect(parseHash("#/ws/ws-a/results/nope")).toEqual({ kind: "home", query: {}, unknown: "#/ws/ws-a/results/nope" });
    expect(parseHash("#/ws/ws-a/results/nii/extra")).toEqual({ kind: "home", query: {}, unknown: "#/ws/ws-a/results/nii/extra" });
    expect(parseHash("#/%E0")).toEqual({ kind: "home", query: {}, unknown: "#/%E0" });
    for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(parseHash(`#/${key}?run=r1`), key).toEqual({ kind: "home", query: { run: "r1" }, unknown: `#/${key}?run=r1` });
    }
  });
  it("an old address parses to a legacy route that keeps the address as typed", () => {
    expect(parseHash("#/analyze/measures/nii?run=r1&book=b1")).toEqual({
      kind: "legacy", layer: "analyze/measures/nii", query: { run: "r1", book: "b1" }, from: "#/analyze/measures/nii?run=r1&book=b1",
    });
    expect(parseHash("#/results?run=r1&tab=eve")).toEqual({ kind: "legacy", layer: "analyze/measures/eve", query: { run: "r1" }, from: "#/results?run=r1&tab=eve" });
    expect(parseHash("#/data?book=b1")).toEqual({ kind: "legacy", layer: "data/balance/book", query: { book: "b1" }, from: "#/data?book=b1" });
  });
});

describe("hrefFor and the selection", () => {
  it("writes the workspace addresses", () => {
    expect(hrefFor({ ws: "ws-a", section: "market", screen: "curves" })).toBe("#/ws/ws-a/market/curves");
    expect(hrefFor({ ws: "ws-a", section: "run", screen: "setups", slot: "setup-1", query: { tab: "scenarios" } })).toBe("#/ws/ws-a/run/setups/setup-1?tab=scenarios");
    expect(hrefFor({ ws: "ws-a", section: "results", screen: "nii", query: { result: "run-1" } })).toBe("#/ws/ws-a/results/nii?result=run-1");
    expect(homeHref()).toBe("#/workspaces");
    expect(compareHref("ws-a", "ws-b")).toBe("#/workspaces/compare?a=ws-a&b=ws-b");
  });
  it("the result key exists only under Results: any other section drops it", () => {
    expect(hrefFor({ ws: "ws-a", section: "govern", screen: "audit", query: { result: "run-1", tab: "x" } })).toBe("#/ws/ws-a/govern/audit?tab=x");
  });
  it("round-trips a screen through parseHash", () => {
    const target = { ws: "ws-a", section: "results" as const, screen: "eve" as const, query: { result: "run-1", scenario: "S100" } };
    expect(parseHash(hrefFor(target))).toEqual({ kind: "screen", ...target });
  });
  it("only result travels as selection, and only inside Results", () => {
    expect([...SELECTION_KEYS]).toEqual(["result"]);
    const q = { book: "b", asOf: "m", plan: "p", run: "r", result: "run-1", tab: "nii", scenario: "S0" };
    expect(selectionQuery(q, "results")).toEqual({ result: "run-1" });
    for (const section of ["workspace", "market", "balance", "assumptions", "run", "govern"] as const) expect(selectionQuery(q, section), section).toEqual({});
  });
});

describe("forwarding every old address", () => {
  const old = [...LAYERS.map((l) => `#/${l.id}`), ...LEGACY_PAGE_IDS.map((p) => `#/${p}`), ...MODULES.map((m) => `#/${m.id}`)];
  const keysets: Array<Record<string, string>> = [{}, { book: "book-a" }, { run: "run-1" }, { book: "book-a", asOf: "mk", plan: "plan-x", run: "run-1" }];
  it("55 addresses, 4 keysets, 3 fixtures: resolves on unambiguous evidence, else Home with a banner, never a silent pick", async () => {
    expect(old).toHaveLength(55);
    for (const addr of old) for (const keys of keysets) {
      const qs = new URLSearchParams(keys).toString();
      const hash = qs ? `${addr}?${qs}` : addr;
      const r0 = await resolve(hash, none);
      expect(r0.kind).toBe("home"); expect(r0.kind === "home" && r0.banner?.oldAddress).toBe(hash);
      const r1 = await resolve(hash, one);
      if ("run" in keys || "book" in keys) { expect(r1.kind).toBe("screen"); if (r1.kind === "screen") expect(r1.ws).toBe("ws-a"); }
      else expect(r1.kind).toBe("home");
      const r2 = await resolve(hash, two);
      if ("run" in keys) { expect(r2.kind).toBe("home"); }   // run-1 is held by no workspace in `two`; a run key with no match never falls through to the book key
      else if ("book" in keys) { expect(r2.kind).toBe("home"); if (r2.kind === "home") expect(r2.banner?.candidates).toEqual(["ws-a", "ws-b"]); }
    }
  });
  it("the run key becomes result on a Results screen only; book, asOf and plan never survive; plan becomes the slot only on run/setups", async () => {
    const nii = await resolve("#/analyze/measures/nii?run=run-1&book=book-a&asOf=mk", one);
    expect(nii).toEqual({ kind: "screen", ws: "ws-a", section: "results", screen: "nii", query: { result: "run-1" } });
    const curves = await resolve("#/data/market/curves?run=run-1&asOf=mk", one);
    expect(curves).toEqual({ kind: "screen", ws: "ws-a", section: "market", screen: "curves", query: {} });
    const setups = await resolve("#/data/scenarios/sets?book=book-a&plan=plan-x", one);
    expect(setups).toEqual({ kind: "screen", ws: "ws-a", section: "run", screen: "setups", query: { tab: "scenarios" }, slot: "setup-plan-x" });
    const chain = await resolve("#/plan?book=book-a", one);
    expect(chain.kind === "screen" && chain.screen).toBe("setups");
    const results = await resolve("#/results?tab=eve&run=run-1", one);
    expect(results).toEqual({ kind: "screen", ws: "ws-a", section: "results", screen: "eve", query: { result: "run-1" } });
  });
  it("a plan key with no importing slot gives no slot, and a slot only ever appears on run/setups", async () => {
    const noSlot = await resolve("#/data/scenarios/sets?book=book-a&plan=plan-missing", one);
    expect(noSlot).toEqual({ kind: "screen", ws: "ws-a", section: "run", screen: "setups", query: { tab: "scenarios" } });
    const elsewhere = await resolve("#/data/balance/book?book=book-a&plan=plan-x", one);
    expect(elsewhere).toEqual({ kind: "screen", ws: "ws-a", section: "balance", screen: "positions", query: {} });
  });
  it("a run key held by exactly one workspace wins over a book key held by another; held by two is Home with both candidates", async () => {
    const f: Fixture = { workspaces: [
      { id: "ws-a", bookId: "book-a", runIds: [], setupPlanIds: [] },
      { id: "ws-b", bookId: "book-b", runIds: ["run-9"], setupPlanIds: [] },
      { id: "ws-c", bookId: "book-c", runIds: ["run-9"], setupPlanIds: [] },
    ] };
    const byRun = await resolve("#/analyze/measures/eve?run=run-9&book=book-a", { workspaces: f.workspaces.slice(0, 2) });
    expect(byRun).toEqual({ kind: "screen", ws: "ws-b", section: "results", screen: "eve", query: { result: "run-9" } });
    const both = await resolve("#/analyze/measures/eve?run=run-9", f);
    expect(both).toEqual({ kind: "home", banner: { oldAddress: "#/analyze/measures/eve?run=run-9", candidates: ["ws-b", "ws-c"] } });
  });
  it("page-state keys survive the forward; the retired Edit a set layer keeps its set key", async () => {
    const edit = await resolve("#/data/assumptions/edit?book=book-a&set=demo-behavioral-v1", one);
    expect(edit).toEqual({ kind: "screen", ws: "ws-a", section: "assumptions", screen: "sets", query: { set: "demo-behavioral-v1" } });
    const scenario = await resolve("#/analyze/measures/nii?run=run-1&scenario=S100", one);
    expect(scenario).toEqual({ kind: "screen", ws: "ws-a", section: "results", screen: "nii", query: { result: "run-1", scenario: "S100" } });
  });
});

// The 42 rows of spec Section 7 (v3), restated by hand: old layer, new section, new screen, the query the forward adds.
const MAPPING: Array<[string, string, string, Record<string, string>]> = [
  ["data/balance/book", "balance", "positions", {}],
  ["data/balance/coa", "balance", "coa", {}],
  ["data/balance/targets", "balance", "strategy", {}],
  ["data/balance/hierarchies", "balance", "hierarchies", {}],
  ["data/market/curves", "market", "curves", {}],
  ["data/market/vols", "market", "vols", {}],
  ["data/market/spreads", "market", "curves", { instance: "tlp" }],
  ["data/market/indices", "market", "indices", {}],
  ["data/market/macro", "market", "macro", {}],
  ["data/assumptions/prepay", "assumptions", "prepay", {}],
  ["data/assumptions/decay", "assumptions", "decay", {}],
  ["data/assumptions/deposit-repricing", "assumptions", "deposit-repricing", {}],
  ["data/assumptions/renewal-draws", "assumptions", "renewals-draws", {}],
  ["data/assumptions/loan-repricing", "assumptions", "loan-client-rate", {}],
  ["data/assumptions/edit", "assumptions", "sets", {}],
  ["data/assumptions/stacks", "assumptions", "sets", {}],
  ["data/scenarios/sets", "run", "setups", { tab: "scenarios" }],
  ["data/scenarios/library", "run", "scenarios", { tab: "rate" }],
  ["data/scenarios/custom", "run", "scenarios", { tab: "custom" }],
  ["data/scenarios/other-shocks", "run", "scenarios", { tab: "behavioral" }],
  ["data/scenarios/balance-shocks", "run", "scenarios", { tab: "balance" }],
  ["data/scenarios/funding-spread-shocks", "run", "scenarios", { tab: "basis" }],
  ["data/scenarios/volatility-shocks", "run", "scenarios", { tab: "volatility" }],
  ["model/model/chain", "run", "setups", {}],
  ["model/model/runs", "run", "queue", {}],
  ["analyze/overview/dashboard", "results", "dashboard", {}],
  ["analyze/measures/nii", "results", "nii", {}],
  ["analyze/measures/eve", "results", "eve", {}],
  ["analyze/measures/gap", "results", "gap", {}],
  ["analyze/measures/ftp", "results", "ftp", {}],
  ["analyze/measures/rates", "results", "rates", {}],
  ["analyze/measures/stochastic", "results", "stochastic", {}],
  ["analyze/explain/attribution", "results", "attribution", {}],
  ["analyze/explain/views", "results", "views", {}],
  ["analyze/explain/metrics", "results", "metrics", {}],
  ["analyze/explain/lenses", "results", "lenses", {}],
  ["analyze/explain/compare", "results", "compare", {}],
  ["govern/records/lineage", "govern", "lineage", {}],
  ["govern/records/inventory", "govern", "inventory", {}],
  ["govern/records/audit", "govern", "audit", {}],
  ["govern/controls/limits", "govern", "limits", {}],
  ["govern/controls/approvals", "govern", "approvals", {}],
];

describe("the mapping table of spec Section 7, row by row", () => {
  it("has 42 rows, one per layer", () => {
    expect(MAPPING).toHaveLength(42);
    expect(MAPPING.map((m) => m[0]).sort()).toEqual(LAYERS.map((l) => l.id as string).sort());
  });
  it("every old layer forwards to the screen the table names, with the table's query and no other", async () => {
    for (const [layer, section, screen, extra] of MAPPING) {
      const r = await resolve(`#/${layer}?book=book-a`, one);
      expect(r, layer).toEqual({ kind: "screen", ws: "ws-a", section, screen, query: extra });
    }
  });
  it("on a Results target the run key arrives as result, and on no other target", async () => {
    for (const [layer, section, screen, extra] of MAPPING) {
      const r = await resolve(`#/${layer}?run=run-1`, one);
      const query = section === "results" ? { ...extra, result: "run-1" } : extra;
      expect(r, layer).toEqual({ kind: "screen", ws: "ws-a", section, screen, query });
    }
  });
  it("the 9 legacy page ids forward", async () => {
    const legacy: Array<[string, string, string, Record<string, string>]> = [
      ["#/home", "results", "dashboard", {}],
      ["#/balance-sheet", "balance", "positions", {}],
      ["#/market", "market", "curves", {}],
      ["#/assumptions", "assumptions", "sets", {}],
      ["#/scenarios", "run", "setups", { tab: "scenarios" }],
      ["#/plan", "run", "setups", {}],
      ["#/run", "run", "queue", {}],
      ["#/results", "results", "dashboard", {}],
      ["#/compare", "results", "compare", {}],
    ];
    expect(legacy).toHaveLength(9);
    for (const [addr, section, screen, query] of legacy) {
      expect(await resolve(`${addr}?book=book-a`, one), addr).toEqual({ kind: "screen", ws: "ws-a", section, screen, query });
    }
  });
  it("each old Results tab forwards to its screen and the tab key is dropped", async () => {
    const tabs: Array<[string, string]> = [
      ["overview", "dashboard"], ["eve", "eve"], ["nii", "nii"], ["gap", "gap"], ["ftp", "ftp"], ["rates", "rates"],
      ["attribution", "attribution"], ["views", "views"], ["metrics", "metrics"], ["lenses", "lenses"],
    ];
    for (const [tab, screen] of tabs) {
      expect(await resolve(`#/results?run=run-1&tab=${tab}`, one), tab).toEqual({ kind: "screen", ws: "ws-a", section: "results", screen, query: { result: "run-1" } });
    }
    expect(await resolve("#/results?run=run-1&tab=no-such-tab", one)).toEqual({ kind: "screen", ws: "ws-a", section: "results", screen: "dashboard", query: { result: "run-1" } });
  });
  it("the 4 bare modules forward to their first layer's screen, keeping page state", async () => {
    const modules: Array<[string, string, string]> = [
      ["#/data", "balance", "positions"],
      ["#/model", "run", "setups"],
      ["#/analyze", "results", "dashboard"],
      ["#/govern", "govern", "lineage"],
    ];
    for (const [addr, section, screen] of modules) {
      expect(await resolve(`${addr}?book=book-a`, one), addr).toEqual({ kind: "screen", ws: "ws-a", section, screen, query: {} });
    }
  });
});
