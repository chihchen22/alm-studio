/**
 * Shared hand-book construction for the acceptance battery (W3-V2 glue).
 *
 * Tiny, hand-authorable portfolios the capability checks assert INDEPENDENT
 * anchors on: every notional, term, and coupon below is chosen so the expected
 * value is computable on paper. Nothing here computes an expectation — the
 * checks do their own independent arithmetic and this module only builds the
 * inputs. Family/COA shapes mirror the engine's own contract examples.
 */
import type {
  AssumptionSet,
  ChartOfAccounts,
  PortfolioSpec,
  Position,
  RunRequest,
  RunResult,
  Scenario,
} from "@alm/engine";
import { createEngine, resolveDefaultContext } from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";

/** Fixed injected timestamps: the two fields outside the deterministic core. */
export const ACCEPT_TS = { startedAt: "2026-08-02T00:00:00.000Z", finishedAt: "2026-08-02T00:00:00.000Z" };

export interface FamilySpec {
  id: string;
  side: "asset" | "liability";
  instrumentType: "fixed-loan" | "floating-loan" | "mortgage" | "nmd" | "nmd-b" | "cd";
  label?: string;
}

/**
 * A minimal two-sided COA: one non-leaf root per side, one leaf node per
 * family (node id `coa-<familyId>`), families in declared order.
 */
export function smallCoa(families: FamilySpec[]): ChartOfAccounts {
  const nodes: ChartOfAccounts["nodes"] = [
    { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
    { id: "liabilities", label: "Total Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
  ];
  let order = 0;
  for (const f of families) {
    nodes.push({
      id: `coa-${f.id}`,
      label: f.label ?? f.id,
      parentId: f.side === "asset" ? "assets" : "liabilities",
      side: f.side,
      isLeaf: true,
      familyId: f.id,
      order: order++,
    });
  }
  return {
    schemaVersion: "1.0.0",
    nodes,
    families: families.map((f) => ({
      id: f.id,
      label: f.label ?? f.id,
      side: f.side,
      instrumentType: f.instrumentType,
      coaNodeId: `coa-${f.id}`,
    })),
  };
}

export function smallBook(id: string, families: FamilySpec[], positions: Position[]): PortfolioSpec {
  return { id, label: `accept hand book ${id}`, asOf: "2026-03-31", coa: smallCoa(families), positions };
}

/** An empty (no-overlay) assumption set, the vanilla convention. */
export function emptySet(id = "accept-empty-v1"): AssumptionSet {
  return { schemaVersion: "1.0.0", id, label: "accept battery: no behavioral overlays", bindings: [] };
}

export function baseScenario(assumptionSetId: string, id = "S0"): Scenario {
  return { id, label: "Base", rateSpec: { kind: "base" }, assumptionSetId, newBusiness: { mode: "static", rules: [] } };
}

/** Base plus the parallel regulatory grid, static balance sheet. */
export function gridScenarios(assumptionSetId: string): Scenario[] {
  return [
    baseScenario(assumptionSetId),
    { id: "SM200", label: "-200bp", rateSpec: { kind: "parallel", shockBp: -200 }, assumptionSetId, newBusiness: { mode: "static", rules: [] } },
    { id: "SM100", label: "-100bp", rateSpec: { kind: "parallel", shockBp: -100 }, assumptionSetId, newBusiness: { mode: "static", rules: [] } },
    { id: "S100", label: "+100bp", rateSpec: { kind: "parallel", shockBp: 100 }, assumptionSetId, newBusiness: { mode: "static", rules: [] } },
    { id: "S200", label: "+200bp", rateSpec: { kind: "parallel", shockBp: 200 }, assumptionSetId, newBusiness: { mode: "static", rules: [] } },
  ];
}

/** Run a hand book through the full engine pipeline (fresh engine per call). */
export function runSmallBook(
  portfolio: PortfolioSpec,
  market: MarketSnapshot,
  scenarios: Scenario[],
  sets: AssumptionSet[],
  runId: string,
): RunResult {
  const request: RunRequest = {
    runId,
    portfolioId: portfolio.id,
    marketSnapshot: market,
    scenarios,
    assumptionSets: sets,
    grid: { horizonMonths: 360, asOf: portfolio.asOf },
    seed: "accept",
    timestamps: { ...ACCEPT_TS },
  };
  const engine = createEngine(resolveDefaultContext());
  engine.loadPortfolio(portfolio);
  return engine.run(request);
}
