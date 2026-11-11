/**
 * Task 5 (spec E1 and E7): the `seg` opt-in on the run
 * pipeline. It runs the block on the base scenario's overlaid book, writes
 * RunResult.seg and NIIResult.nimPct, and leaves every other byte alone; a run
 * without the opt-in carries neither key.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { RunResult } from "../../contracts/run";
import { defaultHarness } from "../../plugins/defaultHarness";
import { computeSegBlock, SEG_DEFAULTS } from "../../seg";
import { makeInstrument } from "../../runtime/instrumentFactory";
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

/** The fixture book's asset notional: F1 5M fixed loan plus M1 4M mortgage. */
const ASSETS = 9_000_000;

/** The serialized run with the two opt-in keys deleted; every other key keeps its place. */
function withoutSeg(r: RunResult): string {
  const copy = JSON.parse(JSON.stringify(r)) as { seg?: unknown; nii: { nimPct?: unknown } };
  delete copy.seg;
  delete copy.nii.nimPct;
  return JSON.stringify(copy);
}

describe("run pipeline: the seg opt-in (spec E1, E7)", () => {
  it("a run with seg writes the block on the base scenario with the book's constants", () => {
    const result = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ seg: true }));
    const seg = result.seg!;
    expect(seg.convention).toBe("constant-balance-sheet");
    expect(seg.scenarioId).toBe("S0");
    expect(seg.shockBp).toBe(10);
    expect(seg.niiShockBp).toBe(200);
    expect(seg.horizonMonths).toBe(60);
    expect(seg.niiHorizonMonths).toBe(12);
    expect(seg.totalAssetNotional).toBe(ASSETS);
    expect(seg.uncovered).toEqual([]);
    expect(Object.keys(seg.byFamily)).toEqual(["FIXED", "MORTGAGE", "DDA", "MMA"]);
    expect(seg.segBank).toHaveLength(60);
    expect(seg.segBank[0]).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/NaN/);
  });

  it("the block equals computeSegBlock on the run's book and base path (the fixture overlays are no-ops)", () => {
    const result = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ seg: true }));
    const h = defaultHarness();
    const base = makeRunRequest(market).scenarios[0]!;
    const path = h.get("ratePaths").get("deterministic")(h.get("curves").build(market), base, 361);
    const direct = computeSegBlock({
      book: twoSidedBook(),
      basePath: path,
      scenarioId: base.id,
      ...SEG_DEFAULTS,
      makeInstrument: (p) => makeInstrument(p.terms),
    }).result;
    expect(JSON.stringify(result.seg)).toBe(JSON.stringify(direct));
  });

  it("nii.nimPct = 100 x base totalNet12 / asset notional, on the engine's runoff convention", () => {
    const result = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ seg: true }));
    const base = result.nii.byScenario.find((s) => s.scenarioId === "S0")!;
    expect(result.nii.nimPct).toBe((100 * base.totalNet12) / ASSETS);
    expect(result.seg!.nimPct).toBe((100 * result.seg!.book.nii.base12) / ASSETS);
  });

  it("the opt-in moves no other byte: the run minus seg and nimPct equals the plain run", () => {
    const plain = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx());
    const withSeg = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ seg: true }));
    expect(withoutSeg(withSeg)).toBe(JSON.stringify(plain));
  });

  it("a run without seg, or with seg false, carries neither the seg key nor nii.nimPct and is byte-identical", () => {
    const plain = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx());
    expect("seg" in plain).toBe(false);
    expect("nimPct" in plain.nii).toBe(false);
    const off = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ seg: false }));
    expect(JSON.stringify(off)).toBe(JSON.stringify(plain));
  });

  it("two seg runs serialize byte-identically", () => {
    const a = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ seg: true }));
    const b = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ seg: true }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
