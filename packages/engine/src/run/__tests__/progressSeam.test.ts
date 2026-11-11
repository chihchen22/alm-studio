/**
 * The progress seam (M2):
 *
 *  - with an onProgress callback on the RunPipelineContext, the pipeline emits
 *    exactly the four frozen phases, once each, in order:
 *    resolve -> project -> report -> done;
 *  - the seam is purely observational: the same request run with and without
 *    the callback serializes byte-identically, so the callback's presence
 *    cannot move a number (the module's acceptance invariant, stated
 *    relatively here so future ADDITIVE envelope fields do not false-fail it);
 *  - a throwing callback aborts the run rather than being swallowed into a
 *    green result;
 *  - the package barrel re-exports the platform-facing run surface
 *    (buildRunResult, sliceResult, explainResult) so apps/server can drop its
 *    deep import of @alm/engine/src/run.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import {
  buildRunResult as barrelBuildRunResult,
  sliceResult as barrelSliceResult,
  explainResult as barrelExplainResult,
} from "../../index";
import { buildRunResult, type RunPipelineContext, type RunProgressPhase } from "../orchestrate";
import { resolveDefaultContext } from "../engine";
import { loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

const FROZEN_ORDER: RunProgressPhase[] = ["resolve", "project", "report", "done"];

describe("run progress seam", () => {
  it("emits the four frozen phases once each, in order", () => {
    const seen: RunProgressPhase[] = [];
    const context: RunPipelineContext = {
      ...resolveDefaultContext(),
      onProgress: (phase) => seen.push(phase),
    };
    buildRunResult(makeRunRequest(market), twoSidedBook(), context);
    expect(seen).toEqual(FROZEN_ORDER);
  });

  it("is observational only: results with and without the callback are byte-identical", () => {
    const base = resolveDefaultContext();
    const without = buildRunResult(makeRunRequest(market), twoSidedBook(), base);
    const with_ = buildRunResult(makeRunRequest(market), twoSidedBook(), {
      ...base,
      onProgress: () => undefined,
    });
    expect(JSON.stringify(with_)).toBe(JSON.stringify(without));
  });

  it("does not swallow a throwing callback into a green result", () => {
    const context: RunPipelineContext = {
      ...resolveDefaultContext(),
      onProgress: (phase) => {
        if (phase === "project") throw new Error("observer failed");
      },
    };
    expect(() => buildRunResult(makeRunRequest(market), twoSidedBook(), context)).toThrow(
      "observer failed",
    );
  });

  it("re-exports the platform-facing run surface from the package barrel", () => {
    expect(barrelBuildRunResult).toBe(buildRunResult);
    expect(typeof barrelSliceResult).toBe("function");
    expect(typeof barrelExplainResult).toBe("function");
  });
});
