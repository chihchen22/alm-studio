/**
 * The `fixedRateGap` opt-in on the run
 * pipeline. It writes GapResult.fixedRate from the run's own overlaid book on
 * the base scenario's path, and leaves every other byte alone; a run without
 * the opt-in carries no key.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { resolveDefaultContext } from "../engine";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

function ctx(extra?: Partial<RunPipelineContext>): RunPipelineContext {
  return { ...resolveDefaultContext(), ...extra };
}

describe("run pipeline: the fixedRateGap opt-in", () => {
  it("a run without the opt-in carries no fixedRate key, and the opt-in adds only that key", () => {
    const plain = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx());
    expect("fixedRate" in plain.gap).toBe(false);
    const opted = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ fixedRateGap: true }));
    expect(opted.gap.fixedRate).toBeDefined();
    const copy = JSON.parse(JSON.stringify(opted)) as { gap: { fixedRate?: unknown } };
    delete copy.gap.fixedRate;
    expect(JSON.stringify(copy)).toBe(JSON.stringify(plain));
    expect(JSON.stringify(opted)).not.toMatch(/NaN|Infinity/);
  });

  it("fixedRateGap false is the same as leaving it out", () => {
    const plain = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx());
    const off = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ fixedRateGap: false }));
    expect(JSON.stringify(off)).toBe(JSON.stringify(plain));
  });

  it("places the fixed loan and the mortgage on the base path, the deposits not, and the whole asset book through the last band", () => {
    const r = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ fixedRateGap: true }));
    const fr = r.gap.fixedRate!;
    expect(fr.scenarioId).toBe(r.gap.liquidity[0]!.scenarioId);
    expect(fr.uncovered).toEqual([]);
    expect(fr.rows.every((row) => row.liabilities === 0)).toBe(true);
    // F1 5M plus M1 4M, all principal returned by maturity on the base path.
    expect(Math.abs(fr.rows[8]!.cumulativeGap - 9_000_000)).toBeLessThan(1e-3);
  });

  it("agrees band by band with the run's own liquidity ladder for the two rate-locked families inside the grid", () => {
    const r = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ fixedRateGap: true }));
    const fr = r.gap.fixedRate!;
    const base = r.gap.liquidity.find((l) => l.scenarioId === fr.scenarioId)!;
    const nodeRows = (id: string) => base.byCoaNode.find((n) => n.coaNodeId === id)!.rows;
    const fixed = nodeRows("fixed-loans");
    const mort = nodeRows("mortgages");
    // The liquidity ladder's last present band ends at the grid horizon; the fixed-rate ladder's is open. Every band
    // before it is the same months on both.
    const compared = base.rows.length - 1;
    expect(compared).toBeGreaterThan(3);
    for (let b = 0; b < compared; b++) {
      expect(fr.rows[b]!.band).toBe(base.rows[b]!.band.label);
      expect(Math.abs(fr.rows[b]!.assets - (fixed[b]!.assets + mort[b]!.assets))).toBeLessThan(1e-6);
    }
  });
});
