import { describe, it, expect } from "vitest";
import { ConstantRatePath } from "../../runtime/__tests__/stubRatePath";
import { aggregateScenario } from "../aggregate";
import type { BucketGrid } from "../../contracts/results";
import { AS_OF, fixedPosition, mortgagePosition, makePortfolio } from "./fixtures";

const HORIZON = 360;
const grid: BucketGrid = { horizonMonths: HORIZON, asOf: AS_OF };
const path = new ConstantRatePath(0.04, HORIZON);

function nodeSeries(res: ReturnType<typeof aggregateScenario>, id: string) {
  return res.byCoaNode.find((n) => n.coaNodeId === id)!.series;
}
function famSeries(res: ReturnType<typeof aggregateScenario>, id: string) {
  return res.byFamily.find((f) => f.familyId === id)!.series;
}

describe("COA roll-up", () => {
  const pf = makePortfolio([
    fixedPosition("a", { notional: 1_000_000, maturityMonths: 120 }),
    fixedPosition("b", { notional: 400_000, maturityMonths: 60 }),
    mortgagePosition("m"),
  ]);
  const res = aggregateScenario(pf, { scenarioId: "base", path }, grid);

  it("emits every COA node, in declared node-array order", () => {
    expect(res.byCoaNode.map((n) => n.coaNodeId)).toEqual(["assets", "loans", "fixed-loans", "mortgages"]);
  });

  it("a leaf node equals its family series", () => {
    const leaf = nodeSeries(res, "fixed-loans");
    const fam = famSeries(res, "FIXED");
    for (let k = 0; k < HORIZON; k++) {
      expect(leaf.principal[k]).toBe(fam.principal[k]);
      expect(leaf.balance[k]).toBe(fam.balance[k]);
      expect(leaf.interest[k]).toBe(fam.interest[k]);
    }
  });

  it("an intermediate node equals the sum of its leaves", () => {
    const loans = nodeSeries(res, "loans");
    const fx = nodeSeries(res, "fixed-loans");
    const mg = nodeSeries(res, "mortgages");
    for (let k = 0; k < HORIZON; k++) {
      expect(loans.principal[k]).toBeCloseTo(fx.principal[k] + mg.principal[k], 9);
      expect(loans.interest[k]).toBeCloseTo(fx.interest[k] + mg.interest[k], 9);
      expect(loans.balance[k]).toBeCloseTo(fx.balance[k] + mg.balance[k], 9);
    }
  });

  it("the root equals the sum of all its descendant leaves", () => {
    const assets = nodeSeries(res, "assets");
    const fx = nodeSeries(res, "fixed-loans");
    const mg = nodeSeries(res, "mortgages");
    for (let k = 0; k < HORIZON; k++) {
      expect(assets.principal[k]).toBeCloseTo(fx.principal[k] + mg.principal[k], 9);
    }
  });
});
