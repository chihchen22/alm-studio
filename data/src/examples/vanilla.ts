/**
 * Runnable example: the smallest balance sheet the engine accepts, with no
 * optionality anywhere. The book itself lives in src/vanilla.ts (shared with
 * the viewer's fixture generator); this script runs it through base plus the
 * regulatory grid and prints the standard report.
 *
 *   assets       cash            $150M   1m bullet     4.30%
 *                term loans      $650M   3-10y level-pay
 *   liabilities  term funding    $720M   6m-5y bullet advances
 *   equity       plug             $80M
 *
 * From the repo root: `npm run vanilla` (sub-second).
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMarketSnapshot } from "@alm/kernel";
import {
  createEngine,
  resolveDefaultContext,
  type Explanation,
  type ExplainQuery,
  type RunRequest,
} from "@alm/engine";
import { buildVanillaPortfolio, vanillaAssumptionSet, vanillaScenarios } from "../vanilla";
import { computeBalanceSheetTotals } from "../generate";
import { renderReport } from "../demo/format";

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKET_PATH = resolve(HERE, "../../../packages/kernel/public/market_public.json");

const RUN_ID = "vanilla-1";

async function main(): Promise<void> {
  const portfolio = buildVanillaPortfolio();
  const totals = computeBalanceSheetTotals(portfolio);
  const marketSnapshot = await loadMarketSnapshot(MARKET_PATH);

  const emptySet = vanillaAssumptionSet();
  const scenarios = vanillaScenarios(emptySet.id);

  const startedAt = new Date().toISOString();
  const request: RunRequest = {
    runId: RUN_ID,
    portfolioId: portfolio.id,
    marketSnapshot,
    scenarios,
    assumptionSets: [emptySet],
    grid: { horizonMonths: 360, asOf: portfolio.asOf },
    seed: "vanilla",
    timestamps: { startedAt, finishedAt: startedAt },
  };

  const engine = createEngine(resolveDefaultContext());
  engine.loadPortfolio(portfolio);
  const result = engine.run(request);
  result.provenance.timestamps.finishedAt = new Date().toISOString();

  const explainQuery: ExplainQuery = { runId: RUN_ID, metric: "eve", scenarioId: "S200" };
  const explanation: Explanation = engine.explain(explainQuery);

  console.log(
    renderReport({
      result,
      label: portfolio.label,
      positionCount: portfolio.positions.length,
      totals: { assets: totals.assets, liabilities: totals.liabilities, equity: totals.equity },
      explanation,
      explainQuestion: 'Why did EVE move in the +200bp parallel shock (scenario "S200")?',
      baseScenarioId: "S0",
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
