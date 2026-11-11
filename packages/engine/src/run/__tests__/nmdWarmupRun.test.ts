/**
 * The `nmdWarmup` run option end to end.
 *
 * A run that names it builds every deposit of the static projection on a flat
 * history at r0 re-levelled by the scenario's shift, records the resolved
 * option, and leaves every non-deposit family where it was. The expected
 * deposit PV is restated here from the kernel constructor and the discount
 * function, never read off the module under test. The fixture DDA family runs
 * the kernel NMD defaults, whose regime amplifier (alpha 2.0) is what reads the
 * history.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { NMDeposit, buildTLPCurve, type MarketSnapshot, type NMDTerms } from "@alm/kernel";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { RunResult } from "../../contracts/run";
import { discountFunction } from "../../eve/discount";
import { applyStaticOverlays } from "../../projection/static/applyOverlays";
import { buildBaseCurve } from "../../scenario";
import { buildRatePath, shockedCurve } from "../../scenario/rateEnvironment";
import { resolveDefaultContext } from "../index";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { SHARD_CHUNK } from "../shard/chunk";
import { AS_OF, baseAssumptions, HORIZON, loadMarket, makeCoa, makeRunRequest, nmdPosition, twoSidedBook } from "./fixtures";

const WARMUP = { kind: "flat-at-r0" as const, months: 36 };

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

function ctx(extra?: Partial<RunPipelineContext>): RunPipelineContext {
  return { ...resolveDefaultContext(), ...extra };
}

function familyPv(result: RunResult, scenarioId: string, familyId: string): number {
  return result.eve.byScenario.find((s) => s.scenarioId === scenarioId)!.byFamily.find((f) => f.familyId === familyId)!.pv;
}

describe("run pipeline: nmdWarmup (Task 16)", () => {
  it("a run that does not name the option carries no nmdWarmup key", () => {
    const book = twoSidedBook();
    const result = buildRunResult(makeRunRequest(market), book, ctx());
    expect("nmdWarmup" in result).toBe(false);
  });

  it("records the resolved option: r0 from the base path at step 0, one shift per scenario in request order", () => {
    const book = twoSidedBook();
    const result = buildRunResult(makeRunRequest(market), book, ctx({ nmdWarmup: WARMUP }));
    const r0Pct = buildRatePath(buildBaseCurve(market), HORIZON).rateAt(0) * 100;
    expect(result.nmdWarmup).toEqual({
      kind: "flat-at-r0",
      months: 36,
      levelPct: r0Pct,
      shiftPctByScenario: { S0: 0, S100: 1, "S-100": -1, S200: 2, "S-200": -2 },
    });
  });

  it("the deposit family PV per scenario is the flat re-levelled history's, and the other families do not move", () => {
    const book = twoSidedBook();
    const request = makeRunRequest(market);
    const plain = buildRunResult(request, book, ctx());
    const warm = buildRunResult(request, book, ctx({ nmdWarmup: WARMUP }));
    const base = buildBaseCurve(market);
    const tlp = buildTLPCurve(market.tlpNodes);
    const r0Pct = buildRatePath(base, HORIZON).rateAt(0) * 100;
    const effective = applyStaticOverlays(book, baseAssumptions());
    const d1 = effective.positions.find((p: Position) => p.id === "D1")!;
    let moved = 0;
    for (const sc of request.scenarios) {
      const shiftPct = sc.rateSpec.kind === "parallel" ? sc.rateSpec.shockBp / 100 : 0;
      const curve = shockedCurve(base, sc.rateSpec);
      const path = buildRatePath(curve, HORIZON);
      const df = discountFunction(curve, tlp, 0, "all-in");
      let expected = 0;
      for (const cf of new NMDeposit(d1.terms as NMDTerms, new Array(36).fill(r0Pct + shiftPct)).generateCashflows(path)) {
        if (cf.monthOffset > HORIZON) continue;
        expected += df(cf.monthOffset / 12) * (cf.principalPaid + cf.interestPaid);
      }
      expect(Math.abs(familyPv(warm, sc.id, "DDA") - expected)).toBeLessThan(1e-6);
      moved = Math.max(moved, Math.abs(familyPv(warm, sc.id, "DDA") - familyPv(plain, sc.id, "DDA")));
      for (const f of ["FIXED", "MORTGAGE"]) expect(familyPv(warm, sc.id, f)).toBe(familyPv(plain, sc.id, f));
    }
    // The amplifier reads the history, so at least one scenario moves.
    expect(moved).toBeGreaterThan(1);
  });

  it("refuses the option beside eveChannels, whose regenerated legs build deposits on the kernel warmup", () => {
    const book = twoSidedBook();
    expect(() => buildRunResult(makeRunRequest(market), book, ctx({ nmdWarmup: WARMUP, eveChannels: true }))).toThrow(
      /nmdWarmup.*eveChannels/,
    );
  });

  it("a malformed option is refused before any number is computed", () => {
    const book = twoSidedBook();
    expect(() => buildRunResult(makeRunRequest(market), book, ctx({ nmdWarmup: { kind: "flat-at-r0", months: -1 } }))).toThrow(
      /nmdWarmup\.months/,
    );
  });

  it(
    "shards 2 equal shards 1 byte for byte with the option on a two-chunk deposit book",
    () => {
      const positions: Position[] = [];
      for (let i = 0; i < SHARD_CHUNK + 8; i++) positions.push(nmdPosition(`D${i}`, { notional: 100_000 * (1 + (i % 50) / 1000) }));
      const book: PortfolioSpec = { id: "PF-WARM-SHARD", label: "warmup shard book", asOf: AS_OF, coa: makeCoa(), positions };
      const scenarios = makeRunRequest(market).scenarios.filter((s) => s.id === "S0" || s.id === "S200");
      const request = makeRunRequest(market, { runId: "WARM-SHARD", portfolioId: book.id, scenarios });
      const run = (shards: number | undefined) =>
        buildRunResult(request, book, ctx({ shards, nmdWarmup: WARMUP, durationMode: "base-only" }));
      const single = run(undefined);
      const sharded = run(2);
      expect(single.nmdWarmup).toBeDefined();
      expect(JSON.stringify(sharded)).toEqual(JSON.stringify(single));
    },
    300_000,
  );
});
