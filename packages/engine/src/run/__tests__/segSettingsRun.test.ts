/**
 * The SEG knobs on the run pipeline. A run that names no knob, or an empty settings object,
 * is byte-identical to the run it always was; a named knob reaches the block and the result records it; malformed
 * settings are refused before the walk.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { defaultHarness } from "../../plugins/defaultHarness";
import { computeSegBlock } from "../../seg";
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

describe("run pipeline: the SEG knobs (teach slice C2)", () => {
  it("empty settings change no byte of a seg run", () => {
    const plain = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ seg: true }));
    const empty = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ seg: true, segSettings: {} }));
    expect(JSON.stringify(empty)).toBe(JSON.stringify(plain));
  });

  it("a named shock, horizon and NII shock reach the block, which equals computeSegBlock on the run's path", () => {
    const settings = { shockBp: 25, horizonMonths: 400, niiShockBp: 25 };
    const result = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ seg: true, segSettings: settings }));
    const seg = result.seg!;
    expect([seg.shockBp, seg.horizonMonths, seg.niiShockBp, seg.niiHorizonMonths]).toEqual([25, 400, 25, 12]);
    expect(seg.book.segOutstanding).toHaveLength(401);
    expect(seg.book.ebpAssets).toHaveLength(400);
    const h = defaultHarness();
    const base = makeRunRequest(market).scenarios[0]!;
    const path = h.get("ratePaths").get("deterministic")(h.get("curves").build(market), base, 401);
    const direct = computeSegBlock({
      book: twoSidedBook(),
      basePath: path,
      scenarioId: base.id,
      horizonMonths: 400,
      niiHorizonMonths: 12,
      shockBp: 25,
      niiShockBp: 25,
      makeInstrument: (p) => makeInstrument(p.terms),
    }).result;
    expect(JSON.stringify(seg)).toBe(JSON.stringify(direct));
  });

  it("the cohort-0 overlay moves the mortgage family only", () => {
    const plain = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ seg: true, segSettings: { shockBp: 25 } })).seg!;
    const over = buildRunResult(
      makeRunRequest(market),
      twoSidedBook(),
      ctx({ seg: true, segSettings: { shockBp: 25, cprOverlay: [{ familyId: "MORTGAGE", upAnnualCpr: 0.09, downAnnualCpr: 0.14 }] } }),
    ).seg!;
    for (const fam of ["FIXED", "DDA", "MMA"]) expect(JSON.stringify(over.byFamily[fam])).toBe(JSON.stringify(plain.byFamily[fam]));
    expect(over.byFamily.MORTGAGE!.segOutstanding).not.toEqual(plain.byFamily.MORTGAGE!.segOutstanding);
    // The 12-month NII block keeps the family model.
    expect(over.byFamily.MORTGAGE!.nii).toEqual(plain.byFamily.MORTGAGE!.nii);
  });

  it("refuses settings without the seg opt-in, malformed settings and a non-mortgage overlay family", () => {
    const run = (extra: Partial<RunPipelineContext>) => () => buildRunResult(makeRunRequest(market), twoSidedBook(), ctx(extra));
    expect(run({ segSettings: { shockBp: 25 } })).toThrow(/does not opt in to seg/);
    expect(run({ seg: true, segSettings: { shockBp: -1 } })).toThrow(/context\.segSettings\.shockBp must be/);
    expect(run({ seg: true, segSettings: { cprOverlay: [{ familyId: "FIXED", upAnnualCpr: 0.09, downAnnualCpr: 0.14 }] } })).toThrow(
      /a fixed-loan family/,
    );
  });
});
