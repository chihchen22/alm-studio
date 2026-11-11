/**
 * Studio piece D slice three, Task 1 (spec decisions 110, 111, 116), extended by Task 3 (decision 118): the
 * run options a setup now honours (`gapBuckets`, `liquidityBuckets`, `reportHorizons`, `windowMonths`) travel
 * from the pipeline context to the
 * StageRunEnv under the same names, reach the gap metric as its trailing optional argument, and are
 * checked against the grid before the walk. A run that names none of them builds an env with none of
 * the keys and calls the gap metric with four arguments, so it is byte-identical.
 *
 * The walker is wrapped (not replaced) to read the env it is handed; the gap metric is wrapped to read
 * its arguments. Both pass through to the real functions.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { resolveDefaultContext } from "../engine";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import type { StageRunEnv } from "../stages";
import { gapBucketsConfigError } from "../../gap";
import { reportHorizonsConfigError, windowMonthsConfigError } from "../../nii";
import { HORIZON, loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

const seen = vi.hoisted(() => ({ env: undefined as unknown, gapArgs: [] as unknown[][] }));

vi.mock("../executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../executor")>();
  return {
    ...actual,
    executePlan: (...args: Parameters<typeof actual.executePlan>) => {
      seen.env = args[1];
      return actual.executePlan(...args);
    },
  };
});

vi.mock("../../gap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gap")>();
  return {
    ...actual,
    buildGapFromSeries: (...args: unknown[]) => {
      seen.gapArgs.push(args);
      return (actual.buildGapFromSeries as (...a: unknown[]) => ReturnType<typeof actual.buildGapFromSeries>)(...args);
    },
  };
});

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});
beforeEach(() => {
  seen.env = undefined;
  seen.gapArgs = [];
});

const NEW_KEYS = ["gapBuckets", "liquidityBuckets", "reportHorizons", "windowMonths"] as const;

function run(extra: Partial<RunPipelineContext>) {
  return buildRunResult(makeRunRequest(market), twoSidedBook(), { ...resolveDefaultContext(), ...extra });
}

describe("the three slice-three options reach the StageRunEnv and the gap metric", () => {
  it("carries each option under its own name, value for value", () => {
    run({
      gapBuckets: { kind: "custom", edgesMonths: [3, 12, 60, HORIZON] },
      liquidityBuckets: { kind: "monthly" },
      reportHorizons: [12, 24, 60],
      windowMonths: 36,
    });
    const env = seen.env as StageRunEnv;
    expect(env.gapBuckets).toEqual({ kind: "custom", edgesMonths: [3, 12, 60, HORIZON] });
    expect(env.liquidityBuckets).toEqual({ kind: "monthly" });
    expect(env.reportHorizons).toEqual([12, 24, 60]);
    expect(env.windowMonths).toBe(36);
  });

  it("the NII block reports the horizons and the window the run asked for", () => {
    const r = run({ reportHorizons: [12, 24, 60], windowMonths: 36 });
    expect(r.nii.horizonsMonths).toEqual([12, 24, 60]);
    expect(r.nii.windowMonths).toBe(36);
    for (const s of r.nii.byScenario) expect(Object.keys(s.totalNetByHorizon!)).toEqual(["12", "24", "60"]);
  });

  it("hands the gap metric a trailing argument holding each ladder's setting", () => {
    run({ gapBuckets: { kind: "monthly" }, liquidityBuckets: { kind: "custom", edgesMonths: [1, 6] } });
    expect(seen.gapArgs.length).toBeGreaterThan(0);
    for (const args of seen.gapArgs) {
      expect(args).toHaveLength(5);
      expect(args[4]).toEqual({ repricing: { kind: "monthly" }, liquidity: { kind: "custom", edgesMonths: [1, 6] } });
    }
  });

  it("names only the ladder that asked: a repricing setting alone leaves the liquidity key out", () => {
    run({ gapBuckets: { kind: "monthly" } });
    for (const args of seen.gapArgs) {
      expect(args[4]).toEqual({ repricing: { kind: "monthly" } });
      expect(Object.prototype.hasOwnProperty.call(args[4], "liquidity")).toBe(false);
    }
  });

  it("writes none of the keys on a run that asks for nothing new, and calls the gap metric with four arguments", () => {
    run({});
    const env = seen.env as Record<string, unknown>;
    for (const key of NEW_KEYS) expect(Object.prototype.hasOwnProperty.call(env, key)).toBe(false);
    expect(seen.gapArgs.length).toBeGreaterThan(0);
    for (const args of seen.gapArgs) expect(args).toHaveLength(4);
  });
});

describe("the engine checks the options against the grid before the walk", () => {
  const refusals: Array<[string, Partial<RunPipelineContext>, RegExp]> = [
    ["an edge past the grid", { gapBuckets: { kind: "custom", edgesMonths: [12, HORIZON + 1] } }, /context\.gapBuckets\.edgesMonths\[1\].*at most the grid horizon \(360\)/],
    ["edges that do not increase", { liquidityBuckets: { kind: "custom", edgesMonths: [12, 12] } }, /context\.liquidityBuckets\.edgesMonths\[1\].*strictly increase/],
    ["an edge of zero", { gapBuckets: { kind: "custom", edgesMonths: [0, 12] } }, /context\.gapBuckets\.edgesMonths\[0\].*whole number of months, at least 1/],
    ["an empty edge list", { gapBuckets: { kind: "custom", edgesMonths: [] } }, /context\.gapBuckets\.edgesMonths must be a non-empty array/],
    ["the standard kind, which is never an option", { gapBuckets: { kind: "standard" } as never }, /context\.gapBuckets\.kind must be "monthly" or "custom"/],
    ["a report horizon past the grid", { reportHorizons: [12, 24, HORIZON + 12] }, /context\.reportHorizons\[2\].*at most the grid horizon \(360\)/],
    ["report horizons out of order", { reportHorizons: [24, 12] }, /context\.reportHorizons\[1\].*strictly ascending/],
    ["an empty horizon list", { reportHorizons: [] }, /context\.reportHorizons must be a non-empty array/],
    ["an NII window past the grid", { windowMonths: HORIZON + 1 }, /context\.windowMonths must be at most the grid horizon \(360\), got 361/],
    ["an NII window of zero", { windowMonths: 0 }, /context\.windowMonths must be a whole number of months, at least 1, got 0/],
    ["a fractional NII window", { windowMonths: 30.5 }, /context\.windowMonths must be a whole number of months, at least 1, got 30\.5/],
  ];
  for (const [what, extra, message] of refusals) {
    it(`refuses ${what} with no walk`, () => {
      expect(() => run(extra)).toThrow(message);
      expect(seen.env).toBeUndefined();
    });
  }
});

describe("the shared checks the run route calls", () => {
  it("accept a monthly setting, custom edges ending on the grid, and an ascending horizon list", () => {
    expect(gapBucketsConfigError({ kind: "monthly" }, "x", 360)).toBeUndefined();
    expect(gapBucketsConfigError({ kind: "custom", edgesMonths: [1, 12, 360] }, "x", 360)).toBeUndefined();
    expect(reportHorizonsConfigError([12, 24, 60], "x", 60)).toBeUndefined();
    expect(windowMonthsConfigError(60, "x", 60)).toBeUndefined();
    expect(windowMonthsConfigError(1, "x", 60)).toBeUndefined();
  });

  it("refuse a non-object, an unknown kind, a fraction and a non-array, naming the path", () => {
    expect(gapBucketsConfigError("monthly", "engineOptions.gapBuckets", 360)).toMatch(/^engineOptions\.gapBuckets must be an object/);
    expect(gapBucketsConfigError({ kind: "daily" }, "engineOptions.gapBuckets", 360)).toMatch(/^engineOptions\.gapBuckets\.kind must be "monthly" or "custom"/);
    expect(gapBucketsConfigError({ kind: "custom", edgesMonths: [1.5] }, "p", 360)).toMatch(/^p\.edgesMonths\[0\]/);
    expect(reportHorizonsConfigError("12", "engineOptions.reportHorizons", 360)).toMatch(/^engineOptions\.reportHorizons must be a non-empty array/);
    expect(reportHorizonsConfigError([12, 0], "p", 360)).toMatch(/^p\[1\]/);
    expect(windowMonthsConfigError("60", "engineOptions.windowMonths", 360)).toMatch(/^engineOptions\.windowMonths must be a whole number/);
    expect(windowMonthsConfigError(61, "p", 60)).toBe("p must be at most the grid horizon (60), got 61");
  });
});
