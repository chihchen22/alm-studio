/**
 * The observational seam the server's
 * per-position results pass reads. It hands over the book, the rate paths and
 * the curve legs the walk used, so the pass computes on the very objects the
 * run computed on, and it moves no byte of the run.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { resolveDefaultContext } from "../engine";
import type { InstrumentEnvironment } from "../instrumentEnvironment";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

function capture(extra?: Partial<RunPipelineContext>): { env: InstrumentEnvironment[]; json: string } {
  const env: InstrumentEnvironment[] = [];
  const context: RunPipelineContext = {
    ...resolveDefaultContext(),
    ...extra,
    onInstrumentEnvironment: (e) => {
      if (e instanceof Error) throw e;
      env.push(e);
    },
  };
  const result = buildRunResult(makeRunRequest(market), twoSidedBook(), context);
  return { env, json: JSON.stringify(result) };
}

describe("run pipeline: the instrument environment seam (spec E6)", () => {
  it("calls the observer once with the books, paths and legs the walk used", () => {
    const request = makeRunRequest(market);
    const { env } = capture();
    expect(env).toHaveLength(1);
    const e = env[0]!;
    expect(e.baseScenarioId).toBe("S0");
    expect([...e.ratePaths.keys()]).toEqual(request.scenarios.map((s) => s.id));
    const setIds = [...new Set(request.scenarios.map((s) => s.assumptionSetId))];
    expect([...e.booksBySet.keys()]).toEqual(setIds);
    for (const book of e.booksBySet.values()) {
      expect(book.positions.map((p) => p.id)).toEqual(twoSidedBook().positions.map((p) => p.id));
    }
    expect(e.discountBasis).toBe("all-in");
    expect(typeof e.baseCurve.discountFactor(1)).toBe("number");
    expect(typeof e.tlp.tlp(1)).toBe("number");
    expect(e.perPositionSeg).toBeUndefined();
  });

  it("carries the per-position SEG rows when the run opted in to seg, and the basis when one was named", () => {
    const { env } = capture({ seg: true, discountBasis: "spread-consistent" });
    const e = env[0]!;
    expect(e.discountBasis).toBe("spread-consistent");
    expect([...e.perPositionSeg!.keys()]).toEqual(["F1", "M1", "D1", "B1"]);
  });

  it("is observational only: the serialized run is byte-identical with and without the observer", () => {
    const plain = JSON.stringify(
      buildRunResult(makeRunRequest(market), twoSidedBook(), resolveDefaultContext()),
    );
    expect(capture().json).toBe(plain);
  });

  it("does not swallow a throwing observer into a green result", () => {
    const context: RunPipelineContext = {
      ...resolveDefaultContext(),
      onInstrumentEnvironment: () => {
        throw new Error("observer failed");
      },
    };
    expect(() => buildRunResult(makeRunRequest(market), twoSidedBook(), context)).toThrow("observer failed");
  });
});
