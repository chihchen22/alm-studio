/**
 * Studio piece D slice three, Task 1 (spec decisions 108 to 111, 115 and 116): the run setup's bucket settings
 * and report horizons, from the stored setup to the stored engine context.
 *
 *  - The parse gate accepts the new liquidity interval `{ kind: "standard" }`, holds custom edges and report
 *    horizons to the grid, and refuses an empty or out-of-order horizon list, each naming its field.
 *  - `engineOptionsOfSetup` writes `gapBuckets`, `liquidityBuckets` and `reportHorizons` only when the setup asks
 *    for something the engine would not do anyway: nothing for `standard`, nothing for a liquidity ladder that is
 *    switched off or set to the reserved daily interval, nothing for the engine's own horizons [12, 24].
 *  - The run route stores each under the same name with its known keys only, refuses a malformed value or one past
 *    the grid, and refuses all three on a stochastic submission.
 *
 * Task 3 (decisions 111 and 118) adds the NII window, `windowMonths`, through the same hops: written only when the
 * setup's default NII window is not 60, checked against the grid, dropped by the route at 60, refused on a
 * stochastic submission, and handed to the pipeline under the same name.
 *
 * Expected values and sentences are restated by hand.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveEngineOptions } from "../http/routes/runs";
import { parseRunSetup } from "../workspaces/runSetupParse";
import { engineOptionsOfSetup } from "../workspaces/setupCompile";
import { standardAlcoSetup } from "../workspaces/standardAlco";
import type { RunSetup } from "../workspaces/types";
import { pipelineOptionsOf } from "../jobs/pipelineOptions";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

function base(): Omit<RunSetup, "id"> {
  const { id: _id, ...alco } = standardAlcoSetup("ws-slice3");
  return alco;
}

const refused = (mutate: (s: Record<string, any>) => void): string => {
  const s = JSON.parse(JSON.stringify(base())) as Record<string, any>;
  mutate(s);
  try {
    parseRunSetup(s);
  } catch (e) {
    return (e as Error).message;
  }
  return "ACCEPTED";
};

describe("parseRunSetup: the slice-three checks", () => {
  it("accepts the liquidity interval standard and keeps it as stored", () => {
    const s = base();
    const withStandard = { ...s, gap: { ...s.gap, liquidity: { ...s.gap.liquidity, interval: { kind: "standard" as const } } } };
    expect(parseRunSetup(withStandard).gap.liquidity.interval).toEqual({ kind: "standard" });
  });

  it("accepts custom edges and report horizons that end on the grid", () => {
    expect(refused((s) => { s.gap.repricingBuckets = { kind: "custom", edgesMonths: [3, 12, 360] }; })).toBe("ACCEPTED");
    expect(refused((s) => { s.gap.liquidity.interval = { kind: "custom-months", edgesMonths: [1, 360] }; })).toBe("ACCEPTED");
    expect(refused((s) => { s.nii.reportHorizons = [12, 360]; })).toBe("ACCEPTED");
  });

  it("refuses a custom edge past the grid on either ladder, naming the field", () => {
    expect(refused((s) => { s.gap.repricingBuckets = { kind: "custom", edgesMonths: [12, 361] }; })).toBe(
      "gap.repricingBuckets.edgesMonths[1]: expected at most gridHorizonMonths (360), got 361",
    );
    expect(refused((s) => { s.gridHorizonMonths = 120; s.nii.horizonMonths = 60; s.gap.liquidity.interval = { kind: "custom-months", edgesMonths: [6, 121] }; })).toBe(
      "gap.liquidity.interval.edgesMonths[1]: expected at most gridHorizonMonths (120), got 121",
    );
  });

  it("refuses an empty, out-of-order or repeated horizon list, and one past the grid", () => {
    expect(refused((s) => { s.nii.reportHorizons = []; })).toBe("nii.reportHorizons: expected a non-empty array of months");
    expect(refused((s) => { s.nii.reportHorizons = [24, 12]; })).toBe("nii.reportHorizons[1]: horizons must be strictly ascending, 12 follows 24");
    expect(refused((s) => { s.nii.reportHorizons = [12, 12]; })).toBe("nii.reportHorizons[1]: horizons must be strictly ascending, 12 follows 12");
    expect(refused((s) => { s.nii.reportHorizons = [12, 372]; })).toBe("nii.reportHorizons[1]: expected at most gridHorizonMonths (360), got 372");
  });

  it("still refuses an unknown interval kind, listing the four it knows", () => {
    expect(refused((s) => { s.gap.liquidity.interval = { kind: "weekly" }; })).toMatch(
      /gap\.liquidity\.interval\.kind: expected one of "standard", "monthly", "custom-months", "daily"/,
    );
  });
});

describe("engine options of a setup: the three slice-three options", () => {
  it("Standard ALCO asks for monthly on both ladders and [12, 24, 60]", () => {
    expect(engineOptionsOfSetup(base())).toEqual({
      durationMode: "base-only",
      // Standard ALCO carries the corrections.
      modelConvention: "corrected-v1",
      gapBuckets: { kind: "monthly" },
      liquidityBuckets: { kind: "monthly" },
      reportHorizons: [12, 24, 60],
    });
  });

  it("maps custom edges to the envelope's custom kind on both ladders", () => {
    const s = base();
    const custom: Omit<RunSetup, "id"> = {
      ...s,
      gap: {
        ...s.gap,
        repricingBuckets: { kind: "custom", edgesMonths: [3, 12, 60] },
        liquidity: { ...s.gap.liquidity, interval: { kind: "custom-months", edgesMonths: [1, 3, 6] } },
      },
    };
    const o = engineOptionsOfSetup(custom);
    expect(o.gapBuckets).toEqual({ kind: "custom", edgesMonths: [3, 12, 60] });
    expect(o.liquidityBuckets).toEqual({ kind: "custom", edgesMonths: [1, 3, 6] });
    // A copy, not the setup's own array.
    expect(o.gapBuckets).not.toBe(custom.gap.repricingBuckets);
  });

  it("writes no key for standard, a switched-off or daily liquidity ladder, or the engine's own horizons", () => {
    const s = base();
    const none = (setup: Omit<RunSetup, "id">, key: string): void => {
      expect(Object.prototype.hasOwnProperty.call(engineOptionsOfSetup(setup), key)).toBe(false);
    };
    none({ ...s, gap: { ...s.gap, repricingBuckets: { kind: "standard" } } }, "gapBuckets");
    none({ ...s, gap: { ...s.gap, liquidity: { ...s.gap.liquidity, interval: { kind: "standard" } } } }, "liquidityBuckets");
    none({ ...s, gap: { ...s.gap, liquidity: { ...s.gap.liquidity, enabled: false } } }, "liquidityBuckets");
    none({ ...s, gap: { ...s.gap, liquidity: { ...s.gap.liquidity, interval: { kind: "daily" } } } }, "liquidityBuckets");
    none({ ...s, nii: { ...s.nii, reportHorizons: [12, 24] } }, "reportHorizons");
    expect(engineOptionsOfSetup({ ...s, nii: { ...s.nii, reportHorizons: [12] } }).reportHorizons).toEqual([12]);
  });

  it("writes windowMonths only when the default NII window is not 60", () => {
    const s = base();
    expect(s.nii.horizonMonths).toBe(60);
    expect(Object.prototype.hasOwnProperty.call(engineOptionsOfSetup(s), "windowMonths")).toBe(false);
    expect(engineOptionsOfSetup({ ...s, nii: { ...s.nii, horizonMonths: 36 } }).windowMonths).toBe(36);
    expect(engineOptionsOfSetup({ ...s, nii: { ...s.nii, horizonMonths: 120 } }).windowMonths).toBe(120);
  });
});

describe("the run route's engine options: the three slice-three options", () => {
  it("stores each under its own name, known keys only, and drops the engine's own horizons", () => {
    const ctx = resolveEngineOptions(
      {
        gapBuckets: { kind: "custom", edgesMonths: [3, 12], note: "x" } as unknown,
        liquidityBuckets: { kind: "monthly", edgesMonths: [1] } as unknown,
        reportHorizons: [12, 24, 60],
      },
      360,
    );
    expect(ctx).toEqual({
      durationMode: "base-only",
      shards: "auto",
      gapBuckets: { kind: "custom", edgesMonths: [3, 12] },
      liquidityBuckets: { kind: "monthly" },
      reportHorizons: [12, 24, 60],
    });
    const plain = resolveEngineOptions({ reportHorizons: [12, 24] }, 360);
    expect(plain).toEqual({ durationMode: "base-only", shards: "auto" });
  });

  it("stores windowMonths under its own name, and drops 60, the window a run gets without asking", () => {
    expect(resolveEngineOptions({ windowMonths: 36 }, 360)).toEqual({ durationMode: "base-only", shards: "auto", windowMonths: 36 });
    expect(resolveEngineOptions({ windowMonths: 60 }, 360)).toEqual({ durationMode: "base-only", shards: "auto" });
  });

  it("refuses an NII window that is not a positive whole number or is past the grid, naming the field", () => {
    expect(() => resolveEngineOptions({ windowMonths: 121 }, 120)).toThrow(
      "engineOptions.windowMonths must be at most the grid horizon (120), got 121",
    );
    expect(() => resolveEngineOptions({ windowMonths: 0 }, 360)).toThrow(
      "engineOptions.windowMonths must be a whole number of months, at least 1, got 0",
    );
    expect(() => resolveEngineOptions({ windowMonths: "36" }, 360)).toThrow(
      'engineOptions.windowMonths must be a whole number of months, at least 1, got "36"',
    );
  });

  it("refuses a malformed value or one past the grid, naming the field", () => {
    expect(() => resolveEngineOptions({ gapBuckets: { kind: "standard" } }, 360)).toThrow(
      /^engineOptions\.gapBuckets\.kind must be "monthly" or "custom"/,
    );
    expect(() => resolveEngineOptions({ liquidityBuckets: { kind: "custom", edgesMonths: [6, 121] } }, 120)).toThrow(
      "engineOptions.liquidityBuckets.edgesMonths[1] must be at most the grid horizon (120), got 121",
    );
    expect(() => resolveEngineOptions({ reportHorizons: [24, 12] }, 360)).toThrow(
      "engineOptions.reportHorizons[1]: horizons must be strictly ascending, 12 follows 24",
    );
    expect(() => resolveEngineOptions({ reportHorizons: [] }, 360)).toThrow(/^engineOptions\.reportHorizons must be a non-empty array/);
  });

  it("hands the stored options to the pipeline under the same names, and nothing for a context that has none", () => {
    const stored = resolveEngineOptions(
      {
        gapBuckets: { kind: "monthly" },
        liquidityBuckets: { kind: "custom", edgesMonths: [1, 6] },
        reportHorizons: [12, 24, 60],
        windowMonths: 36,
      },
      360,
    );
    const ctx = pipelineOptionsOf(JSON.parse(JSON.stringify(stored)));
    expect(ctx.gapBuckets).toEqual({ kind: "monthly" });
    expect(ctx.liquidityBuckets).toEqual({ kind: "custom", edgesMonths: [1, 6] });
    expect(ctx.reportHorizons).toEqual([12, 24, 60]);
    expect(ctx.windowMonths).toBe(36);
    const none = pipelineOptionsOf(resolveEngineOptions(undefined, 360)) as Record<string, unknown>;
    for (const key of ["gapBuckets", "liquidityBuckets", "reportHorizons", "windowMonths"]) {
      expect(Object.prototype.hasOwnProperty.call(none, key)).toBe(false);
    }
  });
});

describe("POST /api/runs: the three options are refused on a stochastic submission", () => {
  let t: TestPlatform;
  beforeAll(async () => {
    t = await bootTestPlatform();
  }, 120_000);
  afterAll(() => t.close());

  const body = { portfolioId: "p", marketId: "m", scenarioSlateId: "s", assumptionSetIds: ["a"] };
  type Refusal = { error: { message: string } };

  for (const [key, value, sentence] of [
    ["gapBuckets", { kind: "monthly" }, /^engineOptions\.gapBuckets applies to a deterministic run only/],
    ["liquidityBuckets", { kind: "monthly" }, /^engineOptions\.liquidityBuckets applies to a deterministic run only/],
    ["reportHorizons", [12, 24, 60], /^engineOptions\.reportHorizons applies to a deterministic run only/],
    ["windowMonths", 36, /^engineOptions\.windowMonths applies to a deterministic run only/],
  ] as const) {
    it(`refuses ${key} with mode stochastic, before any document is read`, async () => {
      const r = await api<Refusal>(t.base, "POST", "/api/runs", { ...body, mode: "stochastic", engineOptions: { [key]: value } });
      expect(r.status).toBe(422);
      expect(r.body.error.message).toMatch(sentence);
    });
  }

  it("refuses an edge past the submission's own grid", async () => {
    const r = await api<Refusal>(t.base, "POST", "/api/runs", {
      ...body,
      gridHorizonMonths: 120,
      engineOptions: { gapBuckets: { kind: "custom", edgesMonths: [12, 240] } },
    });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe("engineOptions.gapBuckets.edgesMonths[1] must be at most the grid horizon (120), got 240");
  });
});
