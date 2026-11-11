// apps/server/src/__tests__/paramSchemaSeeds.test.ts
/**
 * Every seeded assumption set passes the parameter schema. A bound that refused one would be a spec defect, not a data defect:
 * the build stops and asks. Ids and binding counts are restated here.
 */
import { describe, expect, it } from "vitest";
import { checkOverlayParams, type AssumptionSet } from "@alm/engine";
import { bindAssumptions } from "@alm/engine/src/scenario";
import { vanillaAssumptionSet } from "@alm/data";
import { buildDemoAssumptions, buildLoanRepricingAssumptions } from "@alm/data/src/demo/request";
import {
  buildDecayShockAssumptions,
  buildLiquiditySqueezeAssumptions,
  buildLiquidityStressAssumptions,
  buildStressAssumptions,
} from "../../scripts/seed-store";

const SEEDED: Array<[string, () => AssumptionSet, number]> = [
  ["demo-behavioral-v1", buildDemoAssumptions, 4],
  ["vanilla-empty-v1", vanillaAssumptionSet, 0],
  ["stress-illustrative-v1", buildStressAssumptions, 4],
  ["liquidity-stress-demo-v1", buildLiquidityStressAssumptions, 2],
  ["liquidity-squeeze-demo-v1", buildLiquiditySqueezeAssumptions, 8],
  ["loan-repricing-demo-v1", buildLoanRepricingAssumptions, 5],
  ["decay-shock-demo-v1", buildDecayShockAssumptions, 4],
];

describe("seeded assumption sets against the parameter schema", () => {
  for (const [id, build, count] of SEEDED) {
    it(`${id}: every binding passes, and the set binds`, () => {
      const set = build();
      expect(set.id).toBe(id);
      expect(set.bindings).toHaveLength(count);
      expect(set.bindings.flatMap((b) => checkOverlayParams(b.overlay))).toEqual([]);
      expect(() => bindAssumptions(set)).not.toThrow();
    });
  }
});
