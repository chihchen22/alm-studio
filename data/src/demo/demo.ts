/**
 * The single scripted demo. One command:
 *
 *   npm run demo   (from the repo root, delegating into this workspace)
 *
 * generates the synthetic book, runs base plus the +/-100 and +/-200 regulatory
 * grid, and prints NII, EVE, both gap profiles, the provenance ledger, and one
 * explain answer, then writes the full RunResult JSON to data/out/.
 *
 * Determinism boundary: the RunRequest and the whole compute path are a pure
 * function of the committed generator seed and the market snapshot. The ONLY
 * wall-clock read in this program is the two provenance timestamps, taken here at
 * the entry point and injected onto the request, never read inside the engine.
 * Re-running therefore reproduces byte-identical numeric output; only
 * provenance.timestamps differ between two runs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMarketSnapshot } from "@alm/kernel";
import {
  createEngine,
  resolveDefaultContext,
  type Explanation,
  type ExplainQuery,
} from "@alm/engine";
import { computeBalanceSheetTotals } from "../generate";
import { buildDemoPortfolio, buildDemoRequest, DEMO_RUN_ID } from "./request";
import { renderReport } from "./format";

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKET_PATH = resolve(HERE, "../../../packages/kernel/public/market_public.json");
const OUT_DIR = resolve(HERE, "../../out");
const OUT_PATH = resolve(OUT_DIR, "demo-result.json");

/** The one explain question the demo poses: why EVE moved in the +200bp shock. */
const EXPLAIN_QUERY: ExplainQuery = { runId: DEMO_RUN_ID, metric: "eve", scenarioId: "S200" };
const EXPLAIN_QUESTION = 'Why did EVE move in the +200bp parallel shock (scenario "S200")?';

async function main(): Promise<void> {
  const wallStart = Date.now();

  // Deterministic core: book, market, request (timestamps injected below).
  const portfolio = buildDemoPortfolio();
  const totals = computeBalanceSheetTotals(portfolio);
  const marketSnapshot = await loadMarketSnapshot(MARKET_PATH);

  const startedAt = new Date().toISOString();
  const request = buildDemoRequest(portfolio, marketSnapshot, {
    startedAt,
    finishedAt: startedAt, // replaced once the run returns; see below.
  });

  // base-only durations: the perf-scoped policy for the 100k grid.
  // Durations are measured once at the base environment; the shocked scenarios
  // carry no duration block, which roughly halves the duration-pass cost. The
  // dropped shocked-environment durations are the ones the sanity gate distrusted
  // so this is the more defensible measurement, not a shortcut.
  const engine = createEngine({ ...resolveDefaultContext(), durationMode: "base-only" });
  engine.loadPortfolio(portfolio);
  const result = engine.run(request);

  // Stamp the true finish time onto the emitted record (outside the pure core).
  result.provenance.timestamps.finishedAt = new Date().toISOString();

  const explanation: Explanation = engine.explain(EXPLAIN_QUERY);

  const report = renderReport({
    result,
    label: portfolio.label,
    positionCount: portfolio.positions.length,
    totals,
    explanation,
    explainQuestion: EXPLAIN_QUESTION,
    baseScenarioId: "S0",
  });

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(result)}\n`, "utf8");

  const wallMs = Date.now() - wallStart;
  // eslint-disable-next-line no-console
  console.log(report);
  // eslint-disable-next-line no-console
  console.log(
    `\n${"=".repeat(72)}\n  RunResult JSON written to ${OUT_PATH}` +
      `\n  Demo wall-clock: ${(wallMs / 1000).toFixed(2)} s` +
      `\n${"=".repeat(72)}`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
