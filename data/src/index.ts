/**
 * @alm/data: seeded synthetic balance-sheet generator (spec 5.6).
 *
 * Emits a PortfolioSpec (an 11-family chart of accounts across assets and
 * liabilities plus an equity plug, and ~100k Position records carrying kernel
 * terms) from one master seed through the kernel PCG32 with per-family
 * sub-streams. Produces typed @alm/engine objects; holds no bank data. The
 * committed fixture (data/fixtures/portfolio.fixture.json) is the generator
 * config plus the content hash of the full book, never the expanded book.
 */
export type { PortfolioSpec } from "@alm/engine";
export { buildChartOfAccounts, EQUITY_NODE_ID } from "./coa";
export {
  DEFAULT_GENERATOR_CONFIG,
  FAMILY_GEN_SPECS,
  allocateCounts,
  computeBalanceSheetTotals,
  generatePortfolio,
  type BalanceSheetTotals,
  type FamilyGenSpec,
  type GeneratorConfig,
} from "./generate";
export { buildFixture, type PortfolioFixture } from "./fixture";
export {
  buildVanillaPortfolio,
  vanillaAssumptionSet,
  vanillaScenarios,
  VANILLA_AS_OF,
} from "./vanilla";
