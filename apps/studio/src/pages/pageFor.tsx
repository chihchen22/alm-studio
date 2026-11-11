// apps/studio/src/pages/pageFor.tsx
/**
 * One route to its page (Piece E2). The frame is `{ section, screen }` inside a workspace; today's pages are mounted
 * with the ids the workspace head names (`bookId` from the positions block, `marketId` from the market block) in
 * place of the old Book and As of selection.
 *
 * WHERE A SCREEN PLUGS IN. Every screen of spec v3.1 Section 3.1 is one `case` below, grouped by section with a
 * blank line and a comment between groups so tasks that edit different sections merge cleanly:
 *   workspace/overview, and the home, new and compare routes       Task E3
 *   market, balance and assumptions screens                        Task E4
 *   run/setups, run/batches, run/queue                             Task E5
 *   run/instrument                                                 Task E6
 *   results and govern screens                                     Task E7
 * `pageQuery` hands an unmigrated page the query shape it reads: the picker's `result` is its `run`, and the head's
 * book is its `book`, so a link such a page builds to an old address still names its evidence for the forwarder.
 */
import type { ReactNode } from "react";
import type { ReadinessReport, WorkspaceManifest } from "@alm/reader";
import type { Query, Route, ScreenId, SectionId } from "../router";
import { HomePage } from "./workspace/HomePage";
import { NewPage } from "./workspace/NewPage";
import { OverviewPage } from "./workspace/OverviewPage";
import { WorkspaceComparePage } from "./workspace/ComparePage";
import { BalancePage } from "./balance/BalancePage";
import { CoaPage } from "./balance/CoaPage";
import { TargetsPage } from "./balance/TargetsPage";
import { TemplatesPage } from "./balance/TemplatesPage";
import { HierarchiesPage } from "./balance/HierarchiesPage";
import { MarketPage } from "./market/MarketPage";
import { CurveBuilderPage } from "./market/CurveBuilderPage";
import { DerivedCurvesPage } from "./market/DerivedCurvesPage";
import { RateIndicesPage } from "./market/RateIndicesPage";
import { RateModelPage } from "./market/RateModelPage";
import { MacroFactorsPage } from "./market/MacroFactorsPage";
import { AssumptionsPage } from "./assumptions/AssumptionsPage";
import { MappingPage } from "./assumptions/MappingPage";
import { ByKindPage } from "./assumptions/ByKindPage";
import { LoanRepricingPage } from "./assumptions/LoanRepricingPage";
import { EditSetPage } from "./assumptions/EditSetPage";
import { ScenariosPage } from "./scenarios/ScenariosPage";
import { BehavioralShocksPage } from "./scenarios/BehavioralShocksPage";
import { BalanceShocksPage } from "./scenarios/BalanceShocksPage";
import { FundingSpreadShocksPage } from "./scenarios/FundingSpreadShocksPage";
import { VolatilityShocksPage } from "./scenarios/VolatilityShocksPage";
import { RunPage } from "./run/RunPage";
import { SingleInstrumentPage } from "./run/SingleInstrumentPage";
import { SetupsPage } from "./run/SetupsPage";
import { BatchesPage } from "./run/BatchesPage";
import { ResultsLayer } from "./results/ResultsPage";
import { StochasticRunPage } from "./results/StochasticRunPage";
import type { TabId } from "./results/tabs";
import { ComparePage } from "./compare/ComparePage";
import { DashboardPage } from "./dashboard/DashboardPage";
import { AuditPage, InventoryPage, LineagePage } from "./govern/GovernPages";
import { LimitsPage } from "./controls/LimitsPage";
import { ApprovalsPage } from "./controls/ApprovalsPage";
import { VIEWER_BASE } from "../viewerBase";
import { resultsFrame } from "./results/resultChoice";
import { registeredScreen } from "../registry";
import { AnalysisPage } from "./analysis/AnalysisPage";

/** What App loaded beyond the head, for the pages that need it. `refresh` rereads the head and its readiness after a write. */
export interface PageEnv {
  workspaces: WorkspaceManifest[];
  readiness: ReadinessReport | null;
  refresh: () => void;
}

const NO_ENV: PageEnv = { workspaces: [], readiness: null, refresh: () => {} };

/** The book and the snapshot the head names; null where a block holds none. */
export function idsOf(head: WorkspaceManifest | null): { bookId: string | null; marketId: string | null } {
  return { bookId: head?.blocks.positions.book?.id ?? null, marketId: head?.blocks.market.snapshot?.id ?? null };
}

/**
 * The query an unmigrated page reads. The result picker's `result` is the page's `run`; the head's book fills `book`
 * unless the query already names one. A key the route holds is never overwritten except `run`.
 */
export function pageQuery(query: Query, bookId: string | null, tab?: string): Query {
  const q: Query = { ...query };
  if (q.result !== undefined) {
    if (q.result !== "") q.run = q.result;
    delete q.result;
  }
  if (bookId !== null && q.book === undefined) q.book = bookId;
  if (tab !== undefined) q.tab = tab;
  return q;
}

/** The Scenario library's tab: the `tab` the forwarder adds, `rate` when there is none. */
type ScenarioTab = "rate" | "custom" | "behavioral" | "balance" | "basis" | "volatility";

const RESULTS_TAB: Partial<Record<ScreenId, TabId>> = {
  nii: "nii", eve: "eve", gap: "gap", ftp: "ftp", seg: "seg", liquidity: "liquidity", instruments: "instruments", rates: "rates",
  attribution: "attribution", views: "views", metrics: "metrics", lenses: "lenses",
};

export function pageFor(route: Route, head: WorkspaceManifest | null, env: PageEnv = NO_ENV): ReactNode {
  // The guided Analysis path: one page, the step in the route.
  if (route.kind === "analysis") return <AnalysisPage ws={route.ws} step={route.step} head={head} readiness={env.readiness} query={route.query} refresh={env.refresh} />;
  if (route.kind !== "screen") {
    // Workspace Home, New and Compare. A legacy route is resolved before it gets here.
    if (route.kind === "new") return <NewPage workspaces={env.workspaces} />;
    if (route.kind === "compare") return <WorkspaceComparePage workspaces={env.workspaces} query={route.query} />;
    return <HomePage workspaces={env.workspaces} />;
  }
  const { bookId, marketId } = idsOf(head);
  const ws = route.ws;
  const section: SectionId = route.section;
  const q = pageQuery(route.query, bookId);
  switch (`${section}/${route.screen}`) {
    // ---- Workspace
    case "workspace/overview": return <OverviewPage head={head} readiness={env.readiness} workspaces={env.workspaces} refresh={env.refresh} />;

    // ---- Market
    case "market/curves": return <MarketPage ws={ws} bookId={bookId} marketId={marketId} query={q} section={q.instance === "tlp" || q.instance === "term-funding" ? "spreads" : "curves"} head={head} onChanged={env.refresh} />;
    case "market/curve-builder": return <CurveBuilderPage ws={ws} head={head} onChanged={env.refresh} />;
    case "market/derived-curves": return <DerivedCurvesPage ws={ws} head={head} onChanged={env.refresh} />;
    case "market/vols": return <MarketPage ws={ws} bookId={bookId} marketId={marketId} query={q} section="vols" />;
    case "market/rate-model": return <RateModelPage ws={ws} query={q} />;
    case "market/indices": return <RateIndicesPage ws={ws} head={head} onChanged={env.refresh} query={q} />;
    case "market/macro": return <MacroFactorsPage query={q} />;

    // ---- Balance Sheet
    case "balance/positions": return <BalancePage ws={ws} head={head} onChanged={env.refresh} bookId={bookId} marketId={marketId} query={q} />;
    case "balance/coa": return <CoaPage bookId={bookId} />;
    case "balance/hierarchies": return <HierarchiesPage bookId={bookId} />;
    case "balance/templates": return <TemplatesPage ws={ws} />;
    case "balance/strategy": return <TargetsPage bookId={bookId} head={head} onChanged={env.refresh} />;

    // ---- Assumptions
    case "assumptions/prepay": return <ByKindPage ws={ws} head={head} layer="data/assumptions/prepay" query={q} />;
    case "assumptions/decay": return <ByKindPage ws={ws} head={head} layer="data/assumptions/decay" query={q} />;
    case "assumptions/deposit-repricing": return <ByKindPage ws={ws} head={head} layer="data/assumptions/deposit-repricing" query={q} />;
    case "assumptions/renewals-draws": return <ByKindPage ws={ws} head={head} layer="data/assumptions/renewal-draws" query={q} />;
    case "assumptions/loan-client-rate": return <LoanRepricingPage ws={ws} head={head} query={q} />;
    case "assumptions/mapping": return <MappingPage ws={ws} head={head} query={q} />;
    // A set named in the query (`?set=`) is the old Edit a set page; none is the sets of the workspace and the stacks page.
    case "assumptions/sets": return q.set !== undefined && q.set !== "" ? <EditSetPage ws={ws} query={q} bookId={bookId} /> : <AssumptionsPage ws={ws} head={head} onChanged={env.refresh} query={q} />;

    // ---- Run: setups, batches and the queue
    case "run/setups": return <SetupsPage ws={ws} head={head} slot={route.slot} query={q} env={env} />;
    case "run/batches": return <BatchesPage ws={ws} />;
    case "run/queue": return <RunPage ws={ws} query={q} head={head} />;

    // ---- Run: the scenario library, a tab per old layer
    case "run/scenarios": return scenarioTab(ws, q, bookId, (q.tab as ScenarioTab | undefined) ?? "rate", head, env.refresh);

    // ---- Run: single instrument
    case "run/instrument": return <SingleInstrumentPage head={head} query={q} />;

    // ---- Results
    case "results/dashboard": return <DashboardPage ws={ws} bookId={bookId} marketId={marketId} query={q} viewerBase={VIEWER_BASE} frame={resultsFrame(route.ws, route.screen, head, env.readiness)} />;
    case "results/stochastic": return <StochasticRunPage ws={ws} query={q} frame={resultsFrame(route.ws, route.screen, head, env.readiness)} />;
    case "results/compare": return <ComparePage ws={ws} query={q} frame={resultsFrame(route.ws, route.screen, head, env.readiness)} />;
    case "results/nii":
    case "results/eve":
    case "results/gap":
    case "results/ftp":
    case "results/seg":
    case "results/liquidity":
    case "results/instruments":
    case "results/rates":
    case "results/attribution":
    case "results/views":
    case "results/metrics":
    case "results/lenses": {
      const tab = RESULTS_TAB[route.screen]!;
      return <ResultsLayer ws={ws} tab={tab} query={pageQuery(route.query, bookId, tab)} frame={resultsFrame(route.ws, route.screen, head, env.readiness)} />;
    }

    // ---- Govern
    case "govern/lineage": return <LineagePage ws={ws} query={q} head={head} workspaces={env.workspaces} />;
    case "govern/inventory": return <InventoryPage />;
    case "govern/audit": return <AuditPage ws={ws} query={q} />;
    case "govern/limits": return <LimitsPage />;
    case "govern/approvals": return <ApprovalsPage head={head} onSigned={env.refresh} />;
    default: {
      // A screen a pack registered (registry.ts): its own page, or a registered tab in the results frame.
      const r = registeredScreen(section, route.screen);
      if (r?.resultsTab !== undefined) {
        return <ResultsLayer ws={ws} tab={r.resultsTab} query={pageQuery(route.query, bookId, r.resultsTab)} frame={resultsFrame(route.ws, route.screen, head, env.readiness)} />;
      }
      if (r?.page !== undefined) return r.page({ ws, head, query: q });
      throw new Error(`no page for screen ${section}/${route.screen}`);
    }
  }
}

/** The six tabs of Run > Scenario library, each the page of one old Scenarios layer. */
function scenarioTab(ws: string, q: Query, bookId: string | null, tab: ScenarioTab, head: WorkspaceManifest | null, refresh: () => void): ReactNode {
  switch (tab) {
    case "custom": return <ScenariosPage ws={ws} bookId={bookId} query={q} section="custom" head={head} onChanged={refresh} />;
    case "behavioral": return <BehavioralShocksPage ws={ws} query={q} bookId={bookId} />;
    case "balance": return <BalanceShocksPage ws={ws} query={q} bookId={bookId} />;
    case "basis": return <FundingSpreadShocksPage ws={ws} query={q} />;
    case "volatility": return <VolatilityShocksPage ws={ws} query={q} />;
    default: return <ScenariosPage ws={ws} bookId={bookId} query={q} section="library" head={head} onChanged={refresh} />;
  }
}
