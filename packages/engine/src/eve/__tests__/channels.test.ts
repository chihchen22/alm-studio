/**
 * EVE channel decomposition. Anchors:
 *
 *  - PATH-INDEPENDENCE DEGENERACY: on a fixed-rate book the projection leg
 *    regenerates BIT-IDENTICAL cash flows under any path, so projectionDelta
 *    and interactionResidual are EXACTLY zero and totalDelta EXACTLY equals
 *    discountingDelta — for parallel, twist, and custom shocks alike.
 *  - BUCKETED-MACHINERY RECONCILIATION: totalDelta equals the delta computed
 *    through the run's own independent EVE machinery (aggregateScenario's
 *    BucketAccumulator + pvBucketedSeries) to 1e-9 relative on an in-horizon
 *    book — a different code path term for term (kernel pvCashflows at
 *    monthOffset/12 vs bucket PV at (k+1)/12).
 *  - DEFINITIONAL RECONSTRUCTION: projection + discounting + interaction
 *    re-sums to totalDelta exactly (wiring check), and the interaction is
 *    genuinely nonzero on a behavioral (NMD) book at ±200bp — the negative
 *    convexity the remainder is FOR.
 *  - Refusal: no base scenario -> typed NotImplementedError (eve.channels).
 *  - Determinism: two computations serialize identically.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  bootstrapZeroCurve,
  buildTLPCurve,
  loadMarketSnapshot,
  type TLPCurve,
  type ZeroCurve,
} from "@alm/kernel";
import { computeEveChannels } from "../channels";
import { discountFunction } from "../discount";
import { pvBucketedSeries } from "../pv";
import { aggregateScenario } from "../../portfolio";
import { buildRatePath, shockedCurve } from "../../scenario/rateEnvironment";
import { NotImplementedError } from "../../runtime/notImplemented";
import type { PortfolioSpec } from "../../contracts/position";
import type { Scenario } from "../../contracts/scenario";
import { fixedPosition, makePortfolio, nmdPosition, staticScenario } from "./fixtures";

const MARKET = fileURLToPath(
  new URL("../../../../kernel/public/market_public.json", import.meta.url),
);
const ZERO_TLP: TLPCurve = buildTLPCurve([{ tYears: 1, spread: 0 }]);
const HORIZON = 360;

let base: ZeroCurve;
beforeAll(async () => {
  base = bootstrapZeroCurve(await loadMarketSnapshot(MARKET));
});

/** Fixed-rate two-position book: fully path-independent, matures in-horizon. */
function fixedBook(): PortfolioSpec {
  return makePortfolio([
    fixedPosition("F1", { notional: 5_000_000, coupon: 0.05, maturityMonths: 60, amortType: "level-pay" }),
    fixedPosition("F2", { notional: 3_000_000, coupon: 0.04, maturityMonths: 240, amortType: "bullet" }),
  ]);
}

function twistScenario(id: string): Scenario {
  return {
    id,
    label: id,
    rateSpec: { kind: "twist", shortBp: -100, longBp: 150, pivotYears: 2 },
    assumptionSetId: "AS-BASE",
    newBusiness: { mode: "static", rules: [] },
  };
}

function customScenario(id: string): Scenario {
  return {
    id,
    label: id,
    rateSpec: {
      kind: "custom",
      shocks: [
        { tenorYears: 0.25, shockBp: 50 },
        { tenorYears: 2, shockBp: -25 },
        { tenorYears: 10, shockBp: 120 },
      ],
    },
    assumptionSetId: "AS-BASE",
    newBusiness: { mode: "static", rules: [] },
  };
}

describe("channels — path-independence degeneracy (fixed-rate book)", () => {
  it("projection and interaction are EXACTLY zero for parallel, twist, and custom shocks", () => {
    const scenarios = [
      staticScenario("S0", 0),
      staticScenario("S200", 200),
      staticScenario("SM200", -200),
      twistScenario("TWIST"),
      customScenario("CUSTOM"),
    ];
    const out = computeEveChannels({
      portfolio: fixedBook(),
      scenarios,
      baseCurve: base,
      tlp: ZERO_TLP,
      horizonMonths: HORIZON,
    });
    expect(out.byScenario.map((r) => r.scenarioId)).toEqual([
      "S200",
      "SM200",
      "TWIST",
      "CUSTOM",
    ]);
    for (const row of out.byScenario) {
      // Bit-identical regenerated cash flows + the same discount function:
      // exact zeros, not tolerances.
      expect(row.projectionDelta).toBe(0);
      expect(row.interactionResidual).toBe(0);
      expect(row.totalDelta).toBe(row.discountingDelta);
      // And the shock genuinely moved the valuation.
      expect(Math.abs(row.totalDelta)).toBeGreaterThan(0);
    }
  });
});

describe("channels — reconciliation to the run's bucketed EVE machinery", () => {
  it("totalDelta matches the BucketAccumulator + pvBucketedSeries delta to 1e-9 relative", () => {
    const book = fixedBook();
    const scenarios = [staticScenario("S0", 0), staticScenario("S100", 100), twistScenario("TWIST")];
    const out = computeEveChannels({
      portfolio: book,
      scenarios,
      baseCurve: base,
      tlp: ZERO_TLP,
      horizonMonths: HORIZON,
    });

    // Independent machinery: the run's static-projection aggregation and
    // bucket PV (m03 + m06), term-for-term a different code path.
    const grid = { horizonMonths: HORIZON, asOf: "2026-01-01" };
    const bucketedEve = (scenario: Scenario): number => {
      const curve = shockedCurve(base, scenario.rateSpec);
      const path = buildRatePath(curve, HORIZON);
      const cf = aggregateScenario(book, { scenarioId: scenario.id, path }, grid);
      const df = discountFunction(curve, ZERO_TLP, 0, "all-in");
      let assets = 0;
      for (const fam of cf.byFamily) {
        const famDef = book.coa.families.find((f) => f.id === fam.familyId)!;
        const pv = pvBucketedSeries(fam.series, df);
        if (famDef.side === "asset") assets += pv;
        else if (famDef.side === "liability") assets -= pv;
      }
      return assets;
    };
    const eveBase = bucketedEve(scenarios[0]);
    for (const row of out.byScenario) {
      const scenario = scenarios.find((s) => s.id === row.scenarioId)!;
      const delta = bucketedEve(scenario) - eveBase;
      const rel = Math.abs(row.totalDelta - delta) / Math.max(1, Math.abs(delta));
      expect(rel).toBeLessThan(1e-9);
    }
  });
});

describe("channels — behavioral book: real interaction, exact reconstruction", () => {
  function nmdBook(): PortfolioSpec {
    return makePortfolio([
      fixedPosition("F1", { notional: 5_000_000, coupon: 0.05, maturityMonths: 60 }),
      nmdPosition("D1", { notional: 3_000_000 }),
    ]);
  }

  it("interaction is nonzero at ±200bp and the split re-sums to the total exactly", () => {
    const scenarios = [
      staticScenario("S0", 0),
      staticScenario("S200", 200),
      staticScenario("SM200", -200),
    ];
    const out = computeEveChannels({
      portfolio: nmdBook(),
      scenarios,
      baseCurve: base,
      tlp: ZERO_TLP,
      horizonMonths: HORIZON,
    });
    for (const row of out.byScenario) {
      // Definitional reconstruction, exact in floating point.
      expect(row.projectionDelta + row.discountingDelta + row.interactionResidual).toBe(
        row.totalDelta,
      );
      // The NMD's decay responds to the path, so the projection channel is
      // live and the projection-discounting interaction is genuinely nonzero.
      expect(Math.abs(row.projectionDelta)).toBeGreaterThan(0);
      expect(Math.abs(row.interactionResidual)).toBeGreaterThan(0);
    }
    // eslint-disable-next-line no-console
    console.log(
      out.byScenario
        .map(
          (r) =>
            `[channels ${r.scenarioId}] total=${r.totalDelta.toFixed(2)} proj=${r.projectionDelta.toFixed(2)} ` +
            `disc=${r.discountingDelta.toFixed(2)} interaction=${r.interactionResidual.toFixed(2)}`,
        )
        .join("\n"),
    );
  });

  it("is deterministic: two computations serialize identically", () => {
    const scenarios = [staticScenario("S0", 0), staticScenario("S100", 100)];
    const run = () =>
      computeEveChannels({
        portfolio: nmdBook(),
        scenarios,
        baseCurve: base,
        tlp: ZERO_TLP,
        horizonMonths: HORIZON,
      });
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

describe("channels — refusal", () => {
  it("throws typed when no base scenario is present", () => {
    expect(() =>
      computeEveChannels({
        portfolio: fixedBook(),
        scenarios: [staticScenario("S100", 100)],
        baseCurve: base,
        tlp: ZERO_TLP,
        horizonMonths: HORIZON,
      }),
    ).toThrowError(NotImplementedError);
    try {
      computeEveChannels({
        portfolio: fixedBook(),
        scenarios: [staticScenario("S100", 100)],
        baseCurve: base,
        tlp: ZERO_TLP,
        horizonMonths: HORIZON,
      });
    } catch (e) {
      expect((e as NotImplementedError).layer).toBe("eve.channels");
    }
  });
});
