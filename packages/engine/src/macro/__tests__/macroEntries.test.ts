// packages/engine/src/macro/__tests__/macroEntries.test.ts (A7, I3: the compile and drill entries)
/**
 * The compile resolves the run's macro mapping under layer plan/macro and tags
 * a set that carries a house-price group with no mapping; the drill resolves
 * the set's mapping on its market, drills the mapped family on the wrapper
 * schedule, and refuses as the run refuses. Expected texts restated here.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { MORTGAGE_DEFAULTS, type MarketSnapshot } from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { RunLogEntry } from "../../contracts/runLog";
import { projectInstrument } from "../../instrument/projectInstrument";
import { compilePlan } from "../../plan/compile";
import { fixturePlan, loadPolicy } from "../../plan/__tests__/fixtures";
import { baseAssumptions, loadMarket, regulatoryScenarios, twoSidedBook } from "../../run/__tests__/fixtures";
import { macroMarket } from "../../run/__tests__/macroFixtures";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { BUILTIN_CATALOG } from "../../plugins/catalog";
import { MacroRefusedError } from "../runMacro";

const H = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const STAMPS = { runId: "R", seed: "1", timestamps: { startedAt: "", finishedAt: "" } };
/** The fixture set with the house-price group on its MORTGAGE four-factor binding; mapped to `seriesId` unless null. */
function housingFixture(seriesId: string | null): AssumptionSet {
  const s = baseAssumptions();
  const bindings = s.bindings.map((b) => (b.familyId === "MORTGAGE" && b.overlay.kind === "prepay" && b.overlay.model === "four-factor-cpr" ? { ...b, overlay: { ...b.overlay, housing: { ...H } } } : b));
  return seriesId === null ? { ...s, bindings } : { ...s, bindings, macroBindings: [{ seriesId, feeder: "prepay-housing", familyId: "MORTGAGE" }] };
}
let plain: MarketSnapshot; let macro: MarketSnapshot;
beforeAll(async () => { plain = await loadMarket(); macro = await macroMarket(); }, 120_000);
const resolved = (market: MarketSnapshot, set: AssumptionSet) => ({
  portfolio: twoSidedBook(), marketSnapshot: market, assumptionSets: [set], policy: loadPolicy(), libraries: SHIPPED_LIBRARIES, catalog: BUILTIN_CATALOG,
});
const UNMAPPED_TAG = "set AS-BASE carries a house-price response for family MORTGAGE but no macro mapping, and inherits none; the run reads the kernel schedule";

describe("compile: plan/macro (spec v4 Sections 5 and 7)", () => {
  it("a mapping the market does not carry refuses under layer plan/macro", () => {
    let err: unknown;
    try { compilePlan(fixturePlan(), resolved(plain, housingFixture("hpi-down-30")), STAMPS); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(MacroRefusedError);
    expect((err as Error).message).toBe('run refused: set "AS-BASE" maps series "hpi-down-30", which market "market-public-2026-03-31" does not carry (it carries none)');
    const refuse = ((err as { runLog?: RunLogEntry[] }).runLog ?? []).filter((e) => e.t === "refuse").at(-1) as RunLogEntry & { t: "refuse" };
    expect(refuse.ids).toEqual({ layer: "plan/macro", planId: fixturePlan().planId });
  });
  it("the same mapping on a market that carries the series compiles with no tag", () => {
    const c = compilePlan(fixturePlan(), resolved(macro, housingFixture("hpi-down-30")), STAMPS);
    expect(c.notImplemented.filter((t) => t.layer === "plan.macro.unmapped")).toEqual([]);
  });
  it("a set carrying the group with no mapping compiles with exactly one plan.macro.unmapped tag", () => {
    const c = compilePlan(fixturePlan(), resolved(plain, housingFixture(null)), STAMPS);
    const tags = c.notImplemented.filter((t) => t.layer === "plan.macro.unmapped");
    expect(tags.map((t) => t.reason)).toEqual([UNMAPPED_TAG]);
  });
  it("a set with no group carries no tag", () => {
    const c = compilePlan(fixturePlan(), resolved(plain, baseAssumptions()), STAMPS);
    expect(c.notImplemented.filter((t) => t.layer === "plan.macro.unmapped")).toEqual([]);
  });
});

describe("drill: the set's mapping on the drill's market", () => {
  const drill = (market: MarketSnapshot, assumptions?: AssumptionSet) => projectInstrument({
    terms: { ...MORTGAGE_DEFAULTS, id: "m1" }, familyId: "MORTGAGE", side: "asset", marketSnapshot: market,
    scenarios: regulatoryScenarios().slice(0, 1), ...(assumptions !== undefined ? { assumptions } : {}),
  });
  const rows = (r: ReturnType<typeof projectInstrument>) => JSON.stringify(r.byScenario);
  it("a mapped drill differs from the unmapped drill; an unmapped group is stripped to the kernel schedule", () => {
    const mapped = drill(macro, housingFixture("hpi-down-30"));
    const unmapped = drill(macro, housingFixture(null));
    expect(rows(mapped)).not.toBe(rows(unmapped));
    expect(rows(unmapped)).toBe(rows(drill(macro, baseAssumptions())));
  });
  it("a mapping the drill's market does not carry is refused", () => {
    expect(() => drill(plain, housingFixture("hpi-down-30"))).toThrow(MacroRefusedError);
    expect(() => drill(plain, housingFixture("hpi-down-30"))).toThrow('run refused: set "AS-BASE" maps series "hpi-down-30", which the run\'s market does not carry (it carries none)');
  });
});
