// packages/engine/src/run/__tests__/macroBindOrder.test.ts
/**
 * Piece 7b follow-up (mfu-1, Slice 3 M1): the run entry binds every set before
 * it resolves the macro path, so a malformed mapping meets the bind refusal
 * (MacroMappingError) and not the resolver's "differ from the base" text. The
 * stochastic entry already binds first. Texts restated by hand.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import { MacroRefusedError } from "../../macro/runMacro";
import { MacroMappingError } from "../../scenario/macroBindings";
import { buildRunResult } from "../orchestrate";
import { resolveDefaultContext } from "../engine";
import { baseAssumptions, loadMarket, makeRunRequest, regulatoryScenarios, twoSidedBook } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });

describe("bind before resolve", () => {
  it("a scenario set with an empty mapping against an unmapped base: the bind refusal", () => {
    const bad: AssumptionSet = { ...baseAssumptions("AS-BAD"), macroBindings: [] };
    const scenarios = regulatoryScenarios("AS-BASE").map((s) => (s.id === "S100" ? { ...s, assumptionSetId: "AS-BAD" } : s));
    const request = makeRunRequest(market, { assumptionSets: [baseAssumptions(), bad], scenarios });
    let e: unknown = null;
    try { buildRunResult(request, twoSidedBook(), resolveDefaultContext()); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(MacroMappingError);
    expect(e).not.toBeInstanceOf(MacroRefusedError);
    expect((e as Error).message).toBe("invalid assumption set at macroBindings: must be a non-empty list; omit the field for a set with no mapping");
  });
});
