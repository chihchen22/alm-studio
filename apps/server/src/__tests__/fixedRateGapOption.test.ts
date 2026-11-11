/**
 * The setup's `gap.fixedRateLadder` switch is honoured. On, the compile writes
 * `engineOptions.fixedRateGap: true` and no warning; off, it writes nothing, so a setup that does not ask submits the
 * body it always did. The stored engine context hands the option to the pipeline only when it is true.
 */
import { describe, expect, it } from "vitest";
import { pipelineOptionsOf } from "../jobs/pipelineOptions";
import type { StoredEngineContext } from "../jobs/types";
import { engineOptionsOfSetup } from "../workspaces/setupCompile";
import { standardAlcoSetup } from "../workspaces/standardAlco";

describe("gap.fixedRateLadder to engineOptions.fixedRateGap", () => {
  it("off writes no fixedRateGap key; on writes fixedRateGap: true and nothing else new", () => {
    const off = standardAlcoSetup("ws-b2");
    expect(off.gap.fixedRateLadder).toBe(false);
    const offOptions = engineOptionsOfSetup(off);
    expect("fixedRateGap" in offOptions).toBe(false);
    const onOptions = engineOptionsOfSetup({ ...off, gap: { ...off.gap, fixedRateLadder: true } });
    expect(onOptions.fixedRateGap).toBe(true);
    const { fixedRateGap: _drop, ...rest } = onOptions;
    void _drop;
    expect(rest).toEqual(offOptions);
  });

  it("the stored context hands the option to the pipeline only when it is true", () => {
    const base: StoredEngineContext = { durationMode: "base-only", shards: "auto" } as StoredEngineContext;
    expect("fixedRateGap" in pipelineOptionsOf(base)).toBe(false);
    expect(pipelineOptionsOf({ ...base, fixedRateGap: true }).fixedRateGap).toBe(true);
  });
});
