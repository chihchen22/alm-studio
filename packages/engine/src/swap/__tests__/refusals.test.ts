// packages/engine/src/swap/__tests__/refusals.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { Scenario } from "../../contracts/scenario";
import { projectDynamicScenario } from "../../projection/dynamic/dynamicNewBusiness";
import { buildScenarioRatePath } from "../../projection/static";
import { AS_OF, HORIZON, loadMarket, MORTGAGE_DEFAULT_PARAMS } from "../../run/__tests__/fixtures";
import { buildBaseCurve } from "../../scenario";
import { DerivativeOverlayError, resolveAssumptions } from "../../scenario/resolveAssumptions";
import { hedgedBook, swapPosition, SWAP_FAMILY_ID } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

function setBinding(overlay: AssumptionSet["bindings"][number]["overlay"]): AssumptionSet {
  return {
    schemaVersion: "1.0.0",
    id: "AS-SWAP",
    label: "binds a swap family",
    bindings: [{ familyId: SWAP_FAMILY_ID, overlay, modelVersion: "test-1" }],
  };
}

function resolveOutcome(set: AssumptionSet, registered: string[] = []): string {
  try {
    resolveAssumptions(set, hedgedBook("PF-OVL", [swapPosition("SW1")]).coa.families, registered);
    return "RESOLVED";
  } catch (err) {
    return err instanceof DerivativeOverlayError ? `REFUSED: ${err.message}` : `OTHER ${(err as Error).name}: ${String(err)}`;
  }
}

describe("no behavioral overlay binds to a swap family", () => {
  it("refuses a built-in kind with the derivative refusal, not the compatibility table's", () => {
    expect(
      resolveOutcome(setBinding({ kind: "prepay", model: "four-factor-cpr", params: MORTGAGE_DEFAULT_PARAMS })),
    ).toMatch(/^REFUSED: .*SWAPS.*derivative/);
  });

  it("refuses a REGISTERED kind, which the compatibility gate lets through today", () => {
    expect(
      resolveOutcome(setBinding({ kind: "registered", registeredKind: "custom-hedge", params: {} }), ["custom-hedge"]),
    ).toMatch(/^REFUSED: .*custom-hedge/);
  });
});

describe("no dynamic new-business rule reinvests into a swap family", () => {
  it("refuses the rule: a swap family has no funded balance to reinvest, so any rule on it is meaningless", () => {
    const book = hedgedBook("PF-DYN", [swapPosition("SW1")]);
    const scenario: Scenario = {
      id: "D0",
      label: "D0",
      rateSpec: { kind: "base" },
      assumptionSetId: "none",
      newBusiness: { mode: "dynamic", rules: [{ familyId: SWAP_FAMILY_ID, reinvest: "flat", termMonths: 60 }] },
    };
    const curve = buildBaseCurve(market);
    let outcome: string;
    try {
      const r = projectDynamicScenario(
        book,
        { scenario, ratePath: buildScenarioRatePath(curve, scenario, HORIZON) },
        { horizonMonths: HORIZON, asOf: AS_OF },
      );
      const s = r.cashflows.byFamily.find((f) => f.familyId === SWAP_FAMILY_ID)!.series;
      outcome = `RETURNED: swap family balance[1]=${s.balance[1]} principal[59]=${s.principal[59]}`;
    } catch (err) {
      outcome = `REFUSED: ${(err as Error).message}`;
    }
    expect(outcome).toMatch(/^REFUSED: .*SWAPS.*derivative/);
  });
});
