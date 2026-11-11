import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { LAYERS, SCREENS, forwardTarget, type LayerId, type Route } from "../router";
import { pageFor, pageQuery } from "../pages/pageFor";
import { HEAD } from "./fixtures/workspace";

const nameOf = (el: unknown) => ((el as ReactElement).type as { name: string }).name;
const screen = (section: string, id: string, query: Record<string, string> = {}): Route => ({ kind: "screen", ws: HEAD.id, section, screen: id, query }) as Route;

/** Every screen of the frame and the component its arm returns; restated here, not read from pageFor. */
const EXPECTED: Record<string, string> = {
  "workspace/overview": "OverviewPage",
  "market/curves": "MarketPage",
  "market/curve-builder": "CurveBuilderPage",
  "market/derived-curves": "DerivedCurvesPage",
  "market/vols": "MarketPage",
  "market/rate-model": "RateModelPage",
  "market/indices": "RateIndicesPage",
  "market/macro": "MacroFactorsPage",
  "balance/positions": "BalancePage",
  "balance/coa": "CoaPage",
  "balance/hierarchies": "HierarchiesPage",
  "balance/templates": "TemplatesPage",
  "balance/strategy": "TargetsPage",
  "assumptions/prepay": "ByKindPage",
  "assumptions/decay": "ByKindPage",
  "assumptions/deposit-repricing": "ByKindPage",
  "assumptions/renewals-draws": "ByKindPage",
  "assumptions/loan-client-rate": "LoanRepricingPage",
  "assumptions/mapping": "MappingPage",
  "assumptions/sets": "AssumptionsPage",
  "run/setups": "SetupsPage",
  "run/scenarios": "ScenariosPage",
  "run/batches": "BatchesPage",
  "run/queue": "RunPage",
  "run/instrument": "SingleInstrumentPage",
  "results/dashboard": "DashboardPage",
  "results/nii": "ResultsLayer",
  "results/eve": "ResultsLayer",
  "results/gap": "ResultsLayer",
  "results/ftp": "ResultsLayer",
  "results/seg": "ResultsLayer",
  "results/liquidity": "ResultsLayer",
  "results/instruments": "ResultsLayer",
  "results/rates": "ResultsLayer",
  "results/stochastic": "StochasticRunPage",
  "results/attribution": "ResultsLayer",
  "results/views": "ResultsLayer",
  "results/metrics": "ResultsLayer",
  "results/lenses": "ResultsLayer",
  "results/compare": "ComparePage",
  "govern/lineage": "LineagePage",
  "govern/inventory": "InventoryPage",
  "govern/audit": "AuditPage",
  "govern/limits": "LimitsPage",
  "govern/approvals": "ApprovalsPage",
};

/** The page each of the 42 old layers rendered, and what its forward renders now. A name that moved says why. */
const LEGACY: Record<LayerId, string> = {
  "data/balance/book": "BalancePage",
  "data/balance/coa": "CoaPage",
  "data/balance/targets": "TargetsPage",
  "data/balance/hierarchies": "HierarchiesPage",
  "data/market/curves": "MarketPage",
  "data/market/vols": "MarketPage",
  "data/market/spreads": "MarketPage",
  "data/market/indices": "RateIndicesPage",
  "data/market/macro": "MacroFactorsPage",
  "data/assumptions/prepay": "ByKindPage",
  "data/assumptions/decay": "ByKindPage",
  "data/assumptions/deposit-repricing": "ByKindPage",
  "data/assumptions/renewal-draws": "ByKindPage",
  "data/assumptions/loan-repricing": "LoanRepricingPage",
  "data/assumptions/stacks": "AssumptionsPage",
  // The editor opens on the Assumption sets screen with a `set` in the query; without one the forward shows the stacks.
  "data/assumptions/edit": "AssumptionsPage",
  // A set is a selection inside a run setup (Scenarios tab), so the old sets layer forwards to the setup editor.
  "data/scenarios/sets": "SetupsPage",
  "data/scenarios/library": "ScenariosPage",
  "data/scenarios/custom": "ScenariosPage",
  "data/scenarios/other-shocks": "BehavioralShocksPage",
  "data/scenarios/balance-shocks": "BalanceShocksPage",
  "data/scenarios/funding-spread-shocks": "FundingSpreadShocksPage",
  "data/scenarios/volatility-shocks": "VolatilityShocksPage",
  // The chain canvas is a read-only panel under Run setups (spec Section 7 row 24, ruling 8).
  "model/model/chain": "SetupsPage",
  "model/model/runs": "RunPage",
  "analyze/overview/dashboard": "DashboardPage",
  "analyze/measures/nii": "ResultsLayer",
  "analyze/measures/eve": "ResultsLayer",
  "analyze/measures/gap": "ResultsLayer",
  "analyze/measures/ftp": "ResultsLayer",
  "analyze/measures/rates": "ResultsLayer",
  "analyze/measures/stochastic": "StochasticRunPage",
  "analyze/explain/attribution": "ResultsLayer",
  "analyze/explain/views": "ResultsLayer",
  "analyze/explain/metrics": "ResultsLayer",
  "analyze/explain/lenses": "ResultsLayer",
  "analyze/explain/compare": "ComparePage",
  "govern/records/lineage": "LineagePage",
  "govern/records/inventory": "InventoryPage",
  "govern/records/audit": "AuditPage",
  "govern/controls/limits": "LimitsPage",
  "govern/controls/approvals": "ApprovalsPage",
};

describe("pageFor", () => {
  // The core table only: a pack's screens resolve through the registry's default arm (registry.test.tsx).
  it("the expected table names every screen of the frame and nothing else", () => {
    expect(SCREENS.map((s) => `${s.section}/${s.screen}`).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [key, name] of Object.entries(EXPECTED)) {
    it(`${key} resolves to ${name} without reaching the default-arm throw`, () => {
      const [section, id] = key.split("/") as [string, string];
      expect(nameOf(pageFor(screen(section, id), HEAD))).toBe(name);
    });
  }

  it("every one of the 42 old layers still reaches the page it had, through its forward", () => {
    expect(Object.keys(LEGACY).sort()).toEqual(LAYERS.map((l) => l.id).sort());
    for (const layer of LAYERS) {
      const t = forwardTarget(layer.id);
      const el = pageFor({ kind: "screen", ws: HEAD.id, section: t.section, screen: t.screen, query: t.query }, HEAD);
      expect(nameOf(el), layer.id).toBe(LEGACY[layer.id]);
    }
  });

  it("the page takes the book and the snapshot the head names, not a selection", () => {
    const balance = pageFor(screen("balance", "positions"), HEAD) as ReactElement<{ bookId: string | null; marketId: string | null }>;
    expect(balance.props.bookId).toBe("synthetic-2500-v1");
    expect(balance.props.marketId).toBe("market-public-2026-03-31");
    const empty = { ...HEAD, blocks: { ...HEAD.blocks, positions: { ...HEAD.blocks.positions, book: null }, market: { ...HEAD.blocks.market, snapshot: null } } };
    const none = pageFor(screen("balance", "positions"), empty) as ReactElement<{ bookId: string | null; marketId: string | null }>;
    expect(none.props.bookId).toBeNull();
    expect(none.props.marketId).toBeNull();
  });

  it("the two library arms return one ScenariosPage type with no key, so React keeps one plan editor across them (P3 spec Section 5.1 item 1)", () => {
    const els = [screen("run", "scenarios", { tab: "rate" }), screen("run", "scenarios", { tab: "custom" })].map((r) => pageFor(r, HEAD) as ReactElement);
    for (const el of els) {
      expect(nameOf(el)).toBe("ScenariosPage");
      expect(el.key).toBeNull();
    }
    expect(new Set(els.map((e) => e.type)).size).toBe(1);
  });

  it("the Scenario library's tab picks the old layer's page", () => {
    const byTab: Record<string, string> = { rate: "ScenariosPage", custom: "ScenariosPage", behavioral: "BehavioralShocksPage", balance: "BalanceShocksPage", basis: "FundingSpreadShocksPage", volatility: "VolatilityShocksPage" };
    for (const [tab, name] of Object.entries(byTab)) expect(nameOf(pageFor(screen("run", "scenarios", { tab }), HEAD)), tab).toBe(name);
    expect((pageFor(screen("run", "scenarios", { tab: "custom" }), HEAD) as ReactElement<{ section: string }>).props.section).toBe("custom");
    expect((pageFor(screen("run", "scenarios"), HEAD) as ReactElement<{ section: string }>).props.section).toBe("library");
  });

  it("the TLP instance of Yield curves mounts the spreads section; none mounts the curves", () => {
    expect((pageFor(screen("market", "curves", { instance: "tlp" }), HEAD) as ReactElement<{ section: string }>).props.section).toBe("spreads");
    expect((pageFor(screen("market", "curves"), HEAD) as ReactElement<{ section: string }>).props.section).toBe("curves");
  });

  it("Run setups mounts the setup editor with the workspace id, the head, and the slot the address names", () => {
    const el = pageFor({ kind: "screen", ws: HEAD.id, section: "run", screen: "setups", query: { tab: "scenarios" }, slot: "setup-standard-alco" }, HEAD) as ReactElement<{ ws: string; slot?: string; head: unknown; query: Record<string, string> }>;
    expect(nameOf(el)).toBe("SetupsPage");
    expect(el.props.ws).toBe(HEAD.id);
    expect(el.props.slot).toBe("setup-standard-alco");
    expect(el.props.head).toBe(HEAD);
    expect(el.props.query.tab).toBe("scenarios");
  });

  it("an assumption set named in the query opens the editor on the Assumption sets screen", () => {
    expect(nameOf(pageFor(screen("assumptions", "sets", { set: "demo-behavioral-v1" }), HEAD))).toBe("EditSetPage");
    expect(nameOf(pageFor(screen("assumptions", "sets", { set: "" }), HEAD))).toBe("AssumptionsPage");
  });

  it("a Results measure screen gets its tab, and the result picker's run as the page's run", () => {
    const el = pageFor(screen("results", "eve", { result: "run-1" }), HEAD) as ReactElement<{ tab: string; query: Record<string, string> }>;
    expect(el.props.tab).toBe("eve");
    expect(el.props.query.run).toBe("run-1");
    expect(el.props.query.result).toBeUndefined();
    expect(el.props.query.tab).toBe("eve");
  });

  it("Home, New and Compare render a page of their own kind", () => {
    const expected = { home: "HomePage", new: "NewPage", compare: "WorkspaceComparePage" } as const;
    for (const kind of ["home", "new", "compare"] as const) expect(nameOf(pageFor({ kind, query: {} }, null))).toBe(expected[kind]);
  });
});

describe("pageQuery", () => {
  it("turns result into run, fills the book from the head, and never overwrites a book the route names", () => {
    expect(pageQuery({ result: "r1", scenario: "S0" }, "b1")).toEqual({ run: "r1", scenario: "S0", book: "b1" });
    expect(pageQuery({ book: "other" }, "b1")).toEqual({ book: "other" });
    expect(pageQuery({}, null)).toEqual({});
    expect(pageQuery({ result: "" }, null)).toEqual({});
  });
});
