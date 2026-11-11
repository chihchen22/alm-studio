/**
 * Slice 4b, T1: the `gap` option on the stochastic entry (rulings 1 to 6 and 9).
 *
 *  - absent: the envelope carries no `gap` key and keeps schema 0.3.0, byte for byte the run without the option;
 *  - present: schema 0.4.0 and a `gap` block with the eight filled bands (0-1M to 5-10Y) plus a beyondHorizon line,
 *    for the repricing gap from SEG (signed net) and the liquidity gap from EBP (assets, liabilities, net, balance
 *    only), each a Monte Carlo distribution carrying N, the antithetic-pair standard error and the pinned quantiles;
 *  - typed refusals, every one before any path is simulated: an unknown key, `enabled` other than true, BGM, the
 *    100,000 position-path size cap, and a run grid too short to carry the 120-month block.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import {
  STOCHASTIC_GAP_HORIZON_MONTHS,
  STOCHASTIC_GAP_SCHEMA_VERSION,
  STOCHASTIC_GAP_SIZE_CAP,
  STOCHASTIC_QUANTILES,
  STOCHASTIC_RESULT_SCHEMA_VERSION,
  type StochasticDistribution,
} from "../../contracts/stochastic";
import type { RunRequest } from "../../contracts/run";
import { runStochastic } from "../stochastic";
import {
  StochasticGapError,
  StochasticGapHorizonError,
  StochasticGapModelError,
  StochasticGapOptionError,
  StochasticGapSizeCapError,
  checkGapSize,
} from "../stochasticGap";
import { loadMarket, makeRunRequest, regulatoryScenarios, twoSidedBook } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

function baseOnlyRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return makeRunRequest(market, { scenarios: regulatoryScenarios().slice(0, 1), ...overrides });
}

const HW = { a: 0.05, sigma: 0.01, reason: "gap contract" };
const BAND_LABELS = ["0-1M", "1-3M", "3-6M", "6-12M", "1-2Y", "2-3Y", "3-5Y", "5-10Y"];

function expectDistribution(d: StochasticDistribution, nPaths: number): void {
  expect(d.nPaths).toBe(nPaths);
  expect(d.quantiles.map((q) => q.p)).toEqual([...STOCHASTIC_QUANTILES]);
  expect(Number.isFinite(d.mean)).toBe(true);
  expect(d.standardError).toBeGreaterThanOrEqual(0);
}

describe("stochastic gap: the option absent", () => {
  it("writes no gap key and keeps the 0.3.0 stamp, byte for byte the run without the option", () => {
    const plain = runStochastic(baseOnlyRequest(), twoSidedBook(), { nPaths: 20, modelParams: HW });
    const undef = runStochastic(baseOnlyRequest(), twoSidedBook(), { nPaths: 20, modelParams: HW, gap: undefined });
    expect(JSON.stringify(undef)).toBe(JSON.stringify(plain));
    expect(plain.schemaVersion).toBe(STOCHASTIC_RESULT_SCHEMA_VERSION);
    expect(plain.schemaVersion).toBe("0.3.0");
    expect("gap" in plain).toBe(false);
  });
});

describe("stochastic gap: the option present", () => {
  it("stamps 0.4.0 and writes the eight bands plus beyondHorizon for SEG repricing and EBP liquidity", () => {
    const sto = runStochastic(baseOnlyRequest(), twoSidedBook(), { nPaths: 20, modelParams: HW, gap: { enabled: true } });
    expect(STOCHASTIC_GAP_SCHEMA_VERSION).toBe("0.4.0");
    expect(sto.schemaVersion).toBe("0.4.0");
    const gap = sto.gap!;
    expect(gap.horizonMonths).toBe(STOCHASTIC_GAP_HORIZON_MONTHS);
    expect(gap.horizonMonths).toBe(120);
    expect(gap.convention).toBe("constant-balance-sheet");
    expect(gap.shockBp).toBe(10);

    expect(gap.repricing.bands.map((b) => b.label)).toEqual(BAND_LABELS);
    expect(gap.liquidity.bands.map((b) => b.label)).toEqual(BAND_LABELS);
    expect(gap.repricing.bands[7]).toMatchObject({ startMonth: 60, endMonth: 120 });
    // The ninth standard band name is not used for the beyond-horizon line (ruling 6).
    expect(JSON.stringify(gap)).not.toContain("10Y+");

    for (const b of gap.repricing.bands) {
      expectDistribution(b.net, 20);
      expectDistribution(b.cumulative, 20);
    }
    expectDistribution(gap.repricing.beyondHorizon.net, 20);
    for (const b of gap.liquidity.bands) {
      for (const side of ["assets", "liabilities", "net"] as const) {
        expectDistribution(b.runOff[side], 20);
        expectDistribution(b.cumulative[side], 20);
      }
    }
    for (const side of ["assets", "liabilities", "net"] as const) {
      expectDistribution(gap.liquidity.beyondHorizon[side], 20);
      expectDistribution(gap.liquidity.month1Balance[side], 20);
    }
    expect(gap.uncovered).toEqual([]);
    expect(gap.uncoveredCount).toBe(0);
    // The deterministic distributions are untouched by the option.
    const plain = runStochastic(baseOnlyRequest(), twoSidedBook(), { nPaths: 20, modelParams: HW });
    expect(sto.eveDistribution).toEqual(plain.eveDistribution);
    expect(sto.nii12mDistribution).toEqual(plain.nii12mDistribution);
    // The envelope with gap is the plain one plus the block and the 0.4.0 stamp.
    const { gap: _g, ...rest } = sto;
    expect(JSON.stringify({ ...rest, schemaVersion: "0.3.0" })).toBe(JSON.stringify(plain));
  });
});

describe("stochastic gap: typed refusals before any path is simulated", () => {
  function refuses(
    opts: Parameters<typeof runStochastic>[2],
    type: new (...a: never[]) => StochasticGapError,
    message: RegExp,
    req: RunRequest = baseOnlyRequest(),
  ): void {
    let built = 0;
    let caught: unknown;
    try {
      runStochastic(req, twoSidedBook(), {
        ...opts,
        onEnvironment: () => built++,
        onBgmEnvironment: () => built++,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(type);
    expect(caught).toBeInstanceOf(StochasticGapError);
    expect((caught as StochasticGapError).layer).toBe("stochastic.gap");
    expect((caught as Error).message).toMatch(message);
    expect(built).toBe(0);
  }

  it("refuses an unknown key in the option", () => {
    refuses(
      { nPaths: 20, modelParams: HW, gap: { enabled: true, horizonMonths: 60 } as never },
      StochasticGapOptionError,
      /unknown key.*horizonMonths/,
    );
  });

  it("refuses enabled other than true, and a non-object option", () => {
    refuses({ nPaths: 20, modelParams: HW, gap: { enabled: false } as never }, StochasticGapOptionError, /enabled/);
    refuses({ nPaths: 20, modelParams: HW, gap: {} as never }, StochasticGapOptionError, /enabled/);
    refuses({ nPaths: 20, modelParams: HW, gap: true as never }, StochasticGapOptionError, /object/);
    refuses({ nPaths: 20, modelParams: HW, gap: null as never }, StochasticGapOptionError, /object/);
  });

  it("refuses BGM, naming the BgmTenorError cause and the general tenor rule", () => {
    refuses(
      { nPaths: 20, model: "bgm-lmm-2f", gap: { enabled: true } },
      StochasticGapModelError,
      /BgmTenorError[\s\S]*BGM gap needs a general tenor rule/,
    );
  });

  it("refuses above 100,000 position-paths, stating positions, paths, product, cap and the planned fix", () => {
    // 4 positions x 25,002 paths = 100,008 position-paths.
    refuses(
      { nPaths: 25_002, modelParams: HW, gap: { enabled: true } },
      StochasticGapSizeCapError,
      /4 positions x 25,002 paths = 100,008 position-paths[\s\S]*100,000[\s\S]*parallel workers are the planned fix/,
    );
  });

  it("the cap is a strict bound: exactly 100,000 passes, the twin passes, the granular book refuses", () => {
    expect(STOCHASTIC_GAP_SIZE_CAP).toBe(100_000);
    expect(() => checkGapSize(20, 5_000)).not.toThrow();
    expect(() => checkGapSize(20, 256)).not.toThrow();
    expect(() => checkGapSize(20, 5_002)).toThrow(StochasticGapSizeCapError);
    let e: StochasticGapSizeCapError | undefined;
    try {
      checkGapSize(10_000, 256);
    } catch (x) {
      e = x as StochasticGapSizeCapError;
    }
    expect(e).toBeInstanceOf(StochasticGapSizeCapError);
    expect(e!.positions).toBe(10_000);
    expect(e!.nPaths).toBe(256);
    expect(e!.positionPaths).toBe(2_560_000);
    expect(e!.cap).toBe(100_000);
  });

  it("a mixed refusal reads the order option, model, grid, cap: the first failing check names the class", () => {
    const short = baseOnlyRequest({ grid: { horizonMonths: 120, asOf: "2026-01-01" } });
    // BGM plus an unknown key: the option shape is read first.
    refuses(
      { nPaths: 20, model: "bgm-lmm-2f", gap: { enabled: true, horizonMonths: 60 } as never },
      StochasticGapOptionError,
      /unknown key.*horizonMonths/,
      short,
    );
    // BGM on a short grid over the cap: the model is read before the grid and the cap.
    refuses({ nPaths: 25_002, model: "bgm-lmm-2f", gap: { enabled: true } }, StochasticGapModelError, /BGM gap needs a general tenor rule/, short);
    // Hull-White on a short grid over the cap: the grid is read before the cap.
    refuses({ nPaths: 25_002, modelParams: HW, gap: { enabled: true } }, StochasticGapHorizonError, /horizonMonths 120/, short);
    // Hull-White on a long grid over the cap: the cap.
    refuses({ nPaths: 25_002, modelParams: HW, gap: { enabled: true } }, StochasticGapSizeCapError, /100,008 position-paths/);
  });

  it("refuses a run grid too short for the 120-month block to read its paths", () => {
    refuses(
      { nPaths: 20, modelParams: HW, gap: { enabled: true } },
      StochasticGapHorizonError,
      /horizonMonths 120[\s\S]*121/,
      baseOnlyRequest({ grid: { horizonMonths: 120, asOf: "2026-01-01" } }),
    );
  });
});
