// packages/engine/src/gap/__tests__/gapSwaps.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { RunResult } from "../../contracts/run";
import { loadMarket, twoSidedBook } from "../../run/__tests__/fixtures";
import { DERIVATIVE_ROOT_ID, hedgedBook, N_SWAP, runBook, swapPosition, SWAP_FAMILY_ID } from "../../swap/__tests__/fixtures";
import { ConstantRatePath } from "../../runtime/__tests__/stubRatePath";
import { makeInstrument } from "../../runtime/instrumentFactory";
import type { SwapCashflow } from "../../swap/swapInstrument";
import { bandForBucket, buildBands } from "../bands";
import { accumulateGapPosition, type BucketSeriesPair } from "../gapEngine";

let unhedged: RunResult;
let hedged: RunResult;
let receiver: RunResult;
let market: MarketSnapshot;

beforeAll(async () => {
  market = await loadMarket();
  unhedged = runBook(market, twoSidedBook("PF-GAP-0"));
  hedged = runBook(market, hedgedBook("PF-GAP-1", [swapPosition("SW1", SWAP_FAMILY_ID, { maturityMonths: 60 })]));
  receiver = runBook(
    market,
    hedgedBook("PF-GAP-2", [swapPosition("SW1", SWAP_FAMILY_ID, { maturityMonths: 60, direction: "receive-fixed" })]),
  );
}, 180_000);

describe("the repricing ladder carries both legs of a pay-fixed swap", () => {
  it("adds +N at the floating leg's next reset and -N at the fixed leg's maturity, in the assets column", () => {
    const bands = buildBands(360);
    const bReset = bandForBucket(0, bands); // monthly floater: next reset is month 2, bucket 0
    const bMat = bandForBucket(59, bands); // 60-month fixed leg reprices at bucket 59
    for (const a of unhedged.gap.repricing) {
      const b = hedged.gap.repricing.find((x) => x.scenarioId === a.scenarioId)!;
      for (let i = 0; i < a.rows.length; i++) {
        const want = a.rows[i]!.assets + (i === bReset ? N_SWAP : 0) + (i === bMat ? -N_SWAP : 0);
        expect(b.rows[i]!.assets, `${a.scenarioId} band ${i}: hedged ${b.rows[i]!.assets} unhedged ${a.rows[i]!.assets}`).toBe(want);
        expect(b.rows[i]!.liabilities, `${a.scenarioId} band ${i}`).toBe(a.rows[i]!.liabilities);
      }
    }
  });

  it("drills down to the derivative node with the same two entries", () => {
    const b = hedged.gap.repricing[0]!;
    const node = b.byCoaNode.find((n) => n.coaNodeId === DERIVATIVE_ROOT_ID)!;
    const nonzero = node.rows.map((r, i) => [i, r.assets] as const).filter(([, v]) => v !== 0);
    const bands = buildBands(360);
    expect(nonzero).toEqual([
      [bandForBucket(0, bands), N_SWAP],
      [bandForBucket(59, bands), -N_SWAP],
    ]);
  });
});

describe("the repricing ladder carries both legs of a receive-fixed swap, signs reversed", () => {
  it("adds -N at the floating leg's next reset and +N at the fixed leg's maturity, in the assets column", () => {
    const bands = buildBands(360);
    const bReset = bandForBucket(0, bands);
    const bMat = bandForBucket(59, bands);
    for (const a of unhedged.gap.repricing) {
      const b = receiver.gap.repricing.find((x) => x.scenarioId === a.scenarioId)!;
      for (let i = 0; i < a.rows.length; i++) {
        const want = a.rows[i]!.assets + (i === bReset ? -N_SWAP : 0) + (i === bMat ? N_SWAP : 0);
        expect(b.rows[i]!.assets, `${a.scenarioId} band ${i}: receiver ${b.rows[i]!.assets} unhedged ${a.rows[i]!.assets}`).toBe(want);
        expect(b.rows[i]!.liabilities, `${a.scenarioId} band ${i}`).toBe(a.rows[i]!.liabilities);
      }
    }
  });
});

describe("the liquidity ladder carries nothing for a swap", () => {
  it("is bit-identical to the unhedged ladder in every scenario", () => {
    for (const a of unhedged.gap.liquidity) {
      const b = hedged.gap.liquidity.find((x) => x.scenarioId === a.scenarioId)!;
      expect(b.rows, a.scenarioId).toEqual(a.rows);
    }
  });
});

describe("the fold skips a swap's principal rather than letting the bullets cancel", () => {
  it("writes no principal for a one-sided (receive-only) leg set, and reprices it at the next reset", () => {
    const horizon = 360;
    const series: BucketSeriesPair = {
      repricing: [new Float64Array(horizon)],
      principal: [new Float64Array(horizon)],
    };
    const inst = makeInstrument(swapPosition("SW-U", SWAP_FAMILY_ID, { maturityMonths: 60 }).terms);
    const rows = inst.generateCashflows(new ConstantRatePath(0.04, horizon)) as SwapCashflow[];
    const receive = rows.filter((cf) => cf.leg === "receive");
    accumulateGapPosition(series, 0, inst, receive, horizon);
    const prin = series.principal[0]!;
    const leaked = [...prin.entries()].filter(([, v]) => v !== 0);
    expect(leaked, `principal written at [bucket, value]: ${JSON.stringify(leaked)}`).toEqual([]);
    // Pay-fixed: the receive leg is the monthly floater, whose next reset is
    // month 2, bucket 0; its bullet balance there is the full notional.
    const repr = series.repricing[0]!;
    expect(repr[0], `repricing bucket 0: ${repr[0]}`).toBe(N_SWAP);
  });
});
