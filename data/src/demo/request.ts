/**
 * Deterministic assembly of the demo RunRequest.
 *
 * Everything here is a pure function of the committed generator seed and the
 * loaded market snapshot: the synthetic book, the base behavioral assumption
 * set, and the base-plus-regulatory-grid scenarios. No clock and no Math.random
 * enter this module; the only wall-clock in a run, the provenance timestamps,
 * is injected by the entry point (demo.ts) and passed in here as a value.
 *
 * The assumption set binds each behaviorally active family to the exact kernel
 * default parameter block the generator already embedded in the position terms
 * (MBS_DEFAULTS, NMD_DEFAULTS, BETA_S_CURVE_DEFAULTS). Applying the overlays
 * therefore leaves every number unchanged while still exercising the
 * resolve/apply/provenance path and populating modelVersions in the ledger.
 */
import {
  BETA_S_CURVE_DEFAULTS,
  MBS_DEFAULTS,
  NMD_DEFAULTS,
  type MarketSnapshot,
} from "@alm/kernel";
import type {
  AssumptionSet,
  PortfolioSpec,
  RunRequest,
  Scenario,
} from "@alm/engine";
import { REGULATORY_SHOCKS_BP } from "@alm/engine";
import {
  DEFAULT_GENERATOR_CONFIG,
  generatePortfolio,
  type GeneratorConfig,
} from "../generate";

/** The behavioral assumption set id and the run-level RNG seed, stable inputs. */
export const DEMO_ASSUMPTION_SET_ID = "demo-behavioral-v1";
export const LOAN_REPRICING_ASSUMPTION_SET_ID = "loan-repricing-demo-v1";
export const DEMO_RUN_SEED = "20260716";
export const DEMO_RUN_ID = "demo-run-1";

/** Build the synthetic book from the committed generator config (100k positions). */
export function buildDemoPortfolio(config: GeneratorConfig = DEFAULT_GENERATOR_CONFIG): PortfolioSpec {
  return generatePortfolio(config);
}

/**
 * The base behavioral set. Each binding carries the kernel default the generator
 * baked into the family's terms, so the overlay-applied book equals the raw book
 * numerically; the point of the bindings is provenance (model versions) and
 * exercising the overlay path, not a numeric change.
 */
export function buildDemoAssumptions(): AssumptionSet {
  return {
    schemaVersion: "1.0.0",
    id: DEMO_ASSUMPTION_SET_ID,
    label: "Demo base behavioral set",
    bindings: [
      {
        familyId: "mortgages",
        overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS },
        modelVersion: "kernel-four-factor-cpr-1",
      },
      {
        familyId: "mbs",
        overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS },
        modelVersion: "kernel-four-factor-cpr-1",
      },
      {
        familyId: "dda",
        overlay: { kind: "nmd-decay", params: NMD_DEFAULTS },
        modelVersion: "kernel-nmd-decay-1",
      },
      {
        familyId: "mma",
        overlay: { kind: "deposit-beta", params: BETA_S_CURVE_DEFAULTS },
        modelVersion: "kernel-deposit-beta-1",
      },
    ],
  };
}

/**
 * The demo set again, plus one loan client-rate binding on mortgages.
 * A NEW set under its own id: demo-behavioral-v1 is stored, pinned by content
 * hash and run by three seeded plans, so it is not edited. The four prepay,
 * decay and beta bindings are the demo ones, in order.
 *
 * 250 bp equals the demo prepay binding's 120 + 130 (securitization plus
 * primary spread), as the spread consistency rule requires where a four-factor
 * prepay binding applies to the same position. A demonstration value, not
 * fitted. Nothing reads the client-rate path yet, so no number moves.
 */
export function buildLoanRepricingAssumptions(): AssumptionSet {
  const demo = buildDemoAssumptions();
  return {
    schemaVersion: "1.0.0",
    id: LOAN_REPRICING_ASSUMPTION_SET_ID,
    label: "Demo loan repricing set (demonstration values)",
    bindings: [
      ...demo.bindings,
      {
        familyId: "mortgages",
        overlay: { kind: "loan-client-rate", model: "flat-carry", totalSpreadBp: 250 },
        modelVersion: "illustrative-flat-carry-1",
      },
    ],
  };
}

/** One static regulatory-grid scenario. Base is the sole rateSpec of kind "base". */
function staticScenario(shockBp: number): Scenario {
  const id = `S${shockBp}`;
  return {
    id,
    label: shockBp === 0 ? "Base" : `Parallel ${shockBp > 0 ? "+" : ""}${shockBp}bp`,
    rateSpec: shockBp === 0 ? { kind: "base" } : { kind: "parallel", shockBp },
    assumptionSetId: DEMO_ASSUMPTION_SET_ID,
    newBusiness: { mode: "static", rules: [] },
  };
}

/** Base plus the +/-100, +/-200 parallel regulatory grid, in the pinned order. */
export function buildDemoScenarios(): Scenario[] {
  return REGULATORY_SHOCKS_BP.map(staticScenario);
}

/**
 * Assemble the full RunRequest. `timestamps` is injected by the caller from the
 * wall clock, outside the deterministic core; every other field is a pure
 * function of the committed seeds, so two requests differ only in timestamps.
 */
export function buildDemoRequest(
  portfolio: PortfolioSpec,
  marketSnapshot: MarketSnapshot,
  timestamps: RunRequest["timestamps"],
): RunRequest {
  return {
    runId: DEMO_RUN_ID,
    portfolioId: portfolio.id,
    marketSnapshot,
    scenarios: buildDemoScenarios(),
    assumptionSets: [buildDemoAssumptions()],
    grid: { horizonMonths: 360, asOf: portfolio.asOf },
    seed: DEMO_RUN_SEED,
    timestamps,
  };
}
