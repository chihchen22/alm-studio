import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { loadMarketSnapshot, shockCurve, type MarketSnapshot, type ZeroCurve } from "@alm/kernel";
import type { OverlayBinding } from "../../contracts/assumptions";
import type { PositionTerms } from "../../contracts/position";
import type { Scenario } from "../../contracts/scenario";
import { buildBaseCurve } from "../../scenario/rateEnvironment";
import { engineParRate, payerPvRiskFree, swapTerms, SWAP_FAMILY_ID } from "../../swap/__tests__/fixtures";
import type { SwapTerms } from "../../swap/terms";
import { netSwapLegs, projectInstrument, ProjectInstrumentError, type BareScheduleRow } from "../projectInstrument";

const FIXTURE = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
let snapshot: MarketSnapshot;
let base: ZeroCurve;
beforeAll(async () => {
  snapshot = await loadMarketSnapshot(FIXTURE);
  base = buildBaseCurve(snapshot);
});

const N = 10_000_000;
const scenario: Scenario = { id: "S0", label: "S0", rateSpec: { kind: "base" }, assumptionSetId: "none", newBusiness: { mode: "static", rules: [] } };

function drill(terms: SwapTerms) {
  return projectInstrument({
    terms: terms as unknown as PositionTerms,
    familyId: SWAP_FAMILY_ID,
    side: "derivative",
    marketSnapshot: snapshot,
    scenarios: [scenario],
    horizonMonths: 360,
  });
}

/** What the drill answered, as a string, so a RED run prints the numbers. */
function outcomeOf(terms: SwapTerms): string {
  try {
    const s = drill(terms).byScenario[0]!;
    return `rows=${s.rows.length} legs=${s.legs ? `${s.legs.receive.length}/${s.legs.pay.length}` : "none"} pvRiskFree=${s.pvRiskFree} pvAllIn=${s.pvAllIn} basis=${s.durationBasis ?? "pv"}`;
  } catch (err) {
    return `THREW: ${String(err)}`;
  }
}

describe("the drill answers a swap", () => {
  it("returns a net schedule and both legs, one row per month each", () => {
    const rate = engineParRate(base, 60);
    expect(outcomeOf(swapTerms("D1", { notional: N, fixedRate: rate }))).toMatch(/^rows=60 legs=60\/60 /);
  });

  it("values it on the risk-free curve, restated, and reports pvAllIn equal to pvRiskFree", () => {
    const rate = engineParRate(base, 60) + 0.003;
    const s = drill(swapTerms("D2", { notional: N, fixedRate: rate })).byScenario[0]!;
    const expected = payerPvRiskFree(base, N, rate, 60);
    expect(Math.abs(s.pvRiskFree - expected), outcomeOf(swapTerms("D2", { notional: N, fixedRate: rate }))).toBeLessThanOrEqual(1e-9 * N);
    expect(s.pvAllIn).toBe(s.pvRiskFree);
  });

  it("signs the legs: receive rows positive interest, pay rows negative, net balance 0", () => {
    const s = drill(swapTerms("D3", { notional: N })).byScenario[0]!;
    expect(s.legs!.receive.every((r) => r.interest > 0)).toBe(true);
    expect(s.legs!.pay.every((r) => r.interest < 0)).toBe(true);
    expect(s.rows.every((r) => r.balance === 0)).toBe(true);
    expect("walMonths" in s).toBe(false);
  });

  it("measures duration per unit of notional, restated from bumped curves", () => {
    const rate = engineParRate(base, 60);
    const s = drill(swapTerms("D4", { notional: N, fixedRate: rate })).byScenario[0]!;
    const up = payerPvRiskFree(shockCurve(base, 100), N, rate, 60);
    const down = payerPvRiskFree(shockCurve(base, -100), N, rate, 60);
    const expected = (down - up) / (2 * N * 0.01);
    expect(s.durationBasis).toBe("notional");
    expect(Math.abs(s.effectiveDuration! - expected), `drill ${s.effectiveDuration} restated ${expected}`).toBeLessThanOrEqual(1e-9);
    expect(s.effectiveDuration!).toBeLessThan(0); // pay-fixed gains as rates rise
  });

  it("refuses an assumption set that binds the swap's family, on field \"assumptions\"", () => {
    const err = refusalOf([{ familyId: SWAP_FAMILY_ID, overlay: REGISTERED, modelVersion: "1" }]);
    expect(err).toBeInstanceOf(ProjectInstrumentError);
    expect((err as ProjectInstrumentError).field).toBe("assumptions");
  });

  it("refuses the swap's family even when the binding's selector does not match the swap (selector-blind)", () => {
    const err = refusalOf([
      { familyId: SWAP_FAMILY_ID, overlay: REGISTERED, modelVersion: "1", selector: { region: "no-such-region" } },
    ]);
    expect(err).toBeInstanceOf(ProjectInstrumentError);
    expect((err as ProjectInstrumentError).field).toBe("assumptions");
  });

  it("does not refuse a binding on another family", () => {
    expect(refusalOf([{ familyId: "SOME-OTHER-FAMILY", overlay: REGISTERED, modelVersion: "1" }])).toBeUndefined();
  });
});

describe("netSwapLegs pairs the two legs month for month", () => {
  const row = (month: number, sign: 1 | -1): BareScheduleRow => ({
    month,
    pathRate: 0.04,
    couponRate: sign > 0 ? 0.041 : 0.03,
    balance: sign * 100,
    principal: 0,
    interest: sign * 2,
    payment: sign * 2,
  });
  const legs = (n: number, sign: 1 | -1) => Array.from({ length: n }, (_, i) => row(i + 1, sign));

  it("nets equal legs into receive plus pay, field by field", () => {
    const net = netSwapLegs(legs(2, 1), legs(2, -1));
    expect(net).toEqual([
      { month: 1, pathRate: 0.04, couponRate: 0.041 - 0.03, balance: 0, principal: 0, interest: 0, payment: 0 },
      { month: 2, pathRate: 0.04, couponRate: 0.041 - 0.03, balance: 0, principal: 0, interest: 0, payment: 0 },
    ]);
  });

  it("refuses a pay leg longer than the receive leg, rather than dropping its tail", () => {
    const err = (() => {
      try {
        netSwapLegs(legs(2, 1), legs(3, -1));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ProjectInstrumentError);
    expect((err as ProjectInstrumentError).field).toBe("terms");
  });

  it("refuses a receive leg longer than the pay leg, as a ProjectInstrumentError and not a TypeError", () => {
    const err = (() => {
      try {
        netSwapLegs(legs(3, 1), legs(2, -1));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ProjectInstrumentError);
    expect((err as ProjectInstrumentError).field).toBe("terms");
  });
});

const REGISTERED = { kind: "registered", registeredKind: "k", params: {} } as const;

/** The drill's refusal for these bindings, or undefined when it projects. */
function refusalOf(bindings: OverlayBinding[]): unknown {
  try {
    projectInstrument({
      terms: swapTerms("D5") as unknown as PositionTerms,
      familyId: SWAP_FAMILY_ID,
      side: "derivative",
      marketSnapshot: snapshot,
      scenarios: [scenario],
      assumptions: { schemaVersion: "1.0.0", id: "AS-X", label: "x", bindings },
    });
    return undefined;
  } catch (err) {
    return err;
  }
}
