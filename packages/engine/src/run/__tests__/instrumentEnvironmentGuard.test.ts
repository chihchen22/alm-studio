/**
 * Task 17 (item e): building the instrument environment for the per-position results pass is
 * guarded. The seam is observational, so a plan that left a scenario without a RatePath (which the environment builder
 * refuses by name) must not fail an otherwise finished run: the observer receives the error as a value, and the
 * envelope is the one the run produced.
 *
 * The walk only ever reads the shelf through has and get; the environment builder is the one reader of entries(). The
 * shelf below hides the RatePath entries from entries() alone, which is exactly a plan whose walk left no path on the
 * shelf for a scenario, without disturbing a single stage.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { resolveDefaultContext } from "../engine";
import type { InstrumentEnvironment } from "../instrumentEnvironment";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

const toggle = vi.hoisted(() => ({ hideRatePaths: false }));

vi.mock("../shelf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shelf")>();
  return {
    ...actual,
    makeShelf: () => {
      const shelf = actual.makeShelf();
      return { ...shelf, entries: () => (toggle.hideRatePaths ? shelf.entries().filter((e) => e.type !== "RatePath") : shelf.entries()) };
    },
  };
});

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

describe("run pipeline: the instrument environment guard (Task 17)", () => {
  it("hands the observer an Error value, and the run still completes with the same envelope", () => {
    const plain = JSON.stringify(buildRunResult(makeRunRequest(market), twoSidedBook(), resolveDefaultContext()));
    const seen: Array<InstrumentEnvironment | Error> = [];
    const context: RunPipelineContext = { ...resolveDefaultContext(), onInstrumentEnvironment: (e) => seen.push(e) };
    toggle.hideRatePaths = true;
    let json: string;
    try {
      json = JSON.stringify(buildRunResult(makeRunRequest(market), twoSidedBook(), context));
    } finally {
      toggle.hideRatePaths = false;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Error);
    expect((seen[0] as Error).message).toContain('no stage left a RatePath for scenario "S0"');
    expect(json).toBe(plain);
  });

  it("with the paths on the shelf the observer still receives the environment, not an error", () => {
    const seen: Array<InstrumentEnvironment | Error> = [];
    const context: RunPipelineContext = { ...resolveDefaultContext(), onInstrumentEnvironment: (e) => seen.push(e) };
    buildRunResult(makeRunRequest(market), twoSidedBook(), context);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeInstanceOf(Error);
    expect((seen[0] as InstrumentEnvironment).baseScenarioId).toBe("S0");
  });
});
