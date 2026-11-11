/**
 * Committed-fixture shape and builder.
 *
 * The committed fixture stays small (module guidance): it is the generator's
 * reproduction config plus the content hash of the FULL 100k book, never the
 * expanded book itself. The full book regenerates deterministically from the
 * master seed, and the stored hash is the reproducibility check the test asserts
 * against. Balance-sheet totals are stored too so a conservation regression
 * surfaces even without re-summing the book by hand.
 */
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import {
  DEFAULT_GENERATOR_CONFIG,
  computeBalanceSheetTotals,
  generatePortfolio,
  type GeneratorConfig,
} from "./generate";

export interface PortfolioFixture {
  schemaVersion: string;
  /** Reproduction config: the master seed and scalars the book regenerates from. */
  generator: {
    portfolioId: string;
    asOf: string;
    masterSeed: number;
    targetPositions: number;
    capitalRatio: number;
    familyCount: number;
  };
  positionCount: number;
  totals: { assets: number; liabilities: number; equity: number };
  /** SHA-256 of the full expanded PortfolioSpec. The golden reproducibility key. */
  contentHash: string;
}

const FIXTURE_SCHEMA_VERSION = "1.0.0";

/** Build the committed fixture from a config (defaults to the shipped config). */
export function buildFixture(config: GeneratorConfig = DEFAULT_GENERATOR_CONFIG): PortfolioFixture {
  const spec = generatePortfolio(config);
  const totals = computeBalanceSheetTotals(spec);
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    generator: {
      portfolioId: config.portfolioId,
      asOf: config.asOf,
      masterSeed: config.masterSeed,
      targetPositions: config.targetPositions,
      capitalRatio: config.capitalRatio,
      familyCount: config.families.length,
    },
    positionCount: spec.positions.length,
    totals: { assets: totals.assets, liabilities: totals.liabilities, equity: totals.equity },
    contentHash: contentHash(spec),
  };
}
