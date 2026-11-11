/**
 * The full beta form of an nmd-b, its instrument, the factory arm and the schema check.
 *
 * Expected values are worked by hand from the form's definition, on round
 * parameters chosen so the arithmetic is exact: a static beta 0.20 with dampening 0.5 after a rise gives
 * beta_eff 0.10, so at the 4 percent base state the paid rate is 0.10 + 0.10 x 4 = 0.50 percent.
 */
import { describe, expect, it } from "vitest";
import { NMD_B_TERMS_DEFAULTS, NMDBeta, DeterministicRatePath, bootstrapZeroCurve, loadMarketSnapshot } from "@alm/kernel";
import type { DepositBetaFullForm, EngineNMDBetaTerms } from "../../contracts/position";
import { checkOverlayParams, fullFormIssues } from "../../contracts/paramSchema";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { bindAssumptions } from "../../scenario/bindAssumptions";
import {
  FullBetaDeposit,
  baseState,
  dampeningMultiplier,
  effectiveBeta,
  scenarioState,
  slottedCore,
  type FullBetaTerms,
} from "../fullBeta";

const FORM: DepositBetaFullForm = {
  alphaPct: 0.1,
  deltaUp: 0.5,
  deltaDown: 0.25,
  volRatio: 1,
  baseShortRatePct: 4,
  baseLastMove: "rise",
  staticBeta: 0.2,
  balances: "flat",
};
const S_CURVE = { betaMin: 0.1, betaMax: 0.5, k: 1, m: 3, lambda: 0.5 };

function terms(form: DepositBetaFullForm = FORM, extra: Partial<EngineNMDBetaTerms> = {}): FullBetaTerms {
  return {
    ...NMD_B_TERMS_DEFAULTS,
    id: "mma",
    notional: 1000,
    maturityMonths: 24,
    sCurve: S_CURVE,
    fullBeta: form,
    ...extra,
  } as FullBetaTerms;
}

describe("full beta form: the schedule", () => {
  it("the multiplier is 1 - delta v after a rise and after a fall, clipped to [0, 2]", () => {
    expect(dampeningMultiplier(FORM, true)).toBe(0.5);
    expect(dampeningMultiplier(FORM, false)).toBe(0.75);
    expect(dampeningMultiplier({ ...FORM, deltaUp: 1, volRatio: 3 }, true)).toBe(0);
    expect(dampeningMultiplier({ ...FORM, deltaDown: -1, volRatio: 3 }, false)).toBe(2);
  });

  it("the static beta replaces the S-curve; without it the S-curve at r percent is damped", () => {
    expect(effectiveBeta(4, S_CURVE, FORM, true)).toBeCloseTo(0.1, 15);
    const { staticBeta: _s, ...curveForm } = FORM;
    void _s;
    const logistic = 0.1 + 0.4 / (1 + Math.exp(-(4 - 3)));
    expect(effectiveBeta(4, S_CURVE, curveForm, false)).toBeCloseTo(logistic * 0.75, 15);
  });

  it("the base state pays alpha + beta_eff r at the base short rate, on the base move's multiplier", () => {
    const b = baseState(S_CURVE, FORM);
    expect(b.levelPct).toBe(4);
    expect(b.rising).toBe(true);
    expect(b.paidRatePct).toBeCloseTo(0.5, 15);
    expect(baseState(S_CURVE, { ...FORM, startPaidRatePct: 0.42 }).paidRatePct).toBe(0.42);
  });

  it("a scenario moves the level by its shift, floored at 0; the shift's sign sets the direction", () => {
    const up = scenarioState(S_CURVE, FORM, 1);
    expect(up.levelPct).toBe(5);
    expect(up.rising).toBe(true);
    expect(up.targetPct).toBeCloseTo(0.1 + 0.1 * 5, 15);
    const down = scenarioState(S_CURVE, FORM, -1);
    expect(down.rising).toBe(false);
    expect(down.targetPct).toBeCloseTo(0.1 + 0.2 * 0.75 * 3, 15);
    expect(scenarioState(S_CURVE, FORM, -9).levelPct).toBe(0);
    expect(scenarioState(S_CURVE, { ...FORM, baseLastMove: "fall" }, 0).rising).toBe(false);
  });
});

describe("full beta form: the instrument", () => {
  it("month 1 is one partial-adjustment step from the base state, not the shocked target (no step-0 snap)", () => {
    const cfs = new FullBetaDeposit(terms(), 1).generateCashflows();
    // D(0) = 0.50, D* = 0.60, lambda 0.5: D(1) = 0.55, D(2) = 0.575.
    expect(cfs[0]!.couponRate * 100).toBeCloseTo(0.55, 13);
    expect(cfs[1]!.couponRate * 100).toBeCloseTo(0.575, 13);
    expect(cfs[0]!.interestPaid).toBeCloseTo((1000 * 0.0055) / 12, 12);
  });

  it("the kernel NMDBeta does snap D(0) to the target at the path's step-0 rate (the catch the form avoids)", async () => {
    const market = await loadMarketSnapshot(new URL("../../../../kernel/public/market_public.json", import.meta.url).pathname);
    const path = new DeterministicRatePath(bootstrapZeroCurve(market), 24);
    const kernel = new NMDBeta({ ...NMD_B_TERMS_DEFAULTS, sCurve: { ...S_CURVE, lambda: 0.5 } });
    const r0 = path.rateAt(0) * 100;
    const beta0 = 0.1 + 0.4 / (1 + Math.exp(-(r0 - 3)));
    expect(kernel.depositRatePath(path).dPct[0]).toBeCloseTo(beta0 * r0, 12);
  });

  it("balances are flat and the whole notional leaves at maturity; the base scenario's path is flat", () => {
    const cfs = new FullBetaDeposit(terms(), 0).generateCashflows();
    expect(cfs).toHaveLength(24);
    expect(cfs.every((c) => c.balance === 1000)).toBe(true);
    expect(cfs.slice(0, 23).every((c) => c.principalPaid === 0)).toBe(true);
    expect(cfs[23]!.principalPaid).toBe(1000);
    expect(cfs.every((c) => Math.abs(c.couponRate - 0.005) < 1e-15)).toBe(true);
  });

  it("the repricing fraction is beta_eff at the scenario's level unslotted, and 0 slotted", () => {
    expect(new FullBetaDeposit(terms(), 1).initialBeta()).toBeCloseTo(0.1, 15);
    expect(new FullBetaDeposit(terms(FORM, { depositSlotting: "frozen" }), 1).initialBeta()).toBe(0);
  });

  it('"frozen" slots min(1 - min(beta_eff at base, 0.50), 0.90) on ten rungs of a five-year ladder at the base paid rate', () => {
    // beta_eff at base 0.10, so the core is min(0.90, 0.90) = 0.90 in every scenario.
    const t = terms(FORM, { depositSlotting: "frozen" });
    expect(slottedCore(t, -2)).toEqual({ coreShare: 0.9, lifeYears: 5 });
    const cfs = new FullBetaDeposit(t, -2).generateCashflows();
    expect(cfs).toHaveLength(114);
    expect(cfs[0]!.principalPaid).toBeCloseTo(100, 12);
    expect(cfs[5]!.principalPaid).toBeCloseTo(90, 12);
    expect(cfs[17]!.principalPaid).toBeCloseTo(90, 12);
    expect(cfs[113]!.principalPaid).toBeCloseTo(90, 12);
    expect(cfs.reduce((s, c) => s + c.principalPaid, 0)).toBeCloseTo(1000, 9);
    expect(cfs.every((c) => Math.abs(c.couponRate - 0.005) < 1e-15)).toBe(true);
    expect(cfs[0]!.interestPaid).toBeCloseTo((1000 * 0.005) / 12, 12);
    expect(cfs[1]!.interestPaid).toBeCloseTo((900 * 0.005) / 12, 12);
  });

  it('"frozen" caps the core share at 0.90 when the base beta is below 0.10', () => {
    const t = terms({ ...FORM, staticBeta: 0.08 }, { depositSlotting: "frozen" });
    expect(slottedCore(t, 0).coreShare).toBe(0.9);
  });

  it('"shocked-level" slots 1 - beta_eff at the shocked level, uncapped, on the form\'s core life', () => {
    const t = terms({ ...FORM, coreLifeYears: 7 }, { depositSlotting: "shocked-level" });
    // A fall of 1 point: beta_eff = 0.20 x 0.75 = 0.15, core 0.85; seven years puts the last rung at month 160.
    expect(slottedCore(t, -1).coreShare).toBeCloseTo(0.85, 15);
    const cfs = new FullBetaDeposit(t, -1).generateCashflows();
    expect(cfs).toHaveLength(160);
    expect(cfs[0]!.principalPaid).toBeCloseTo(150, 9);
    expect(cfs[159]!.principalPaid).toBeCloseTo(85, 9);
  });

  it("refuses balances other than flat and a non-finite shift; it has no bucket simulation", () => {
    expect(() => new FullBetaDeposit(terms({ ...FORM, balances: "decay" as never }))).toThrow(/balances must be "flat"/);
    expect(() => new FullBetaDeposit(terms(), Number.NaN)).toThrow(/finite percent/);
    expect(() => new FullBetaDeposit(terms()).simulateBook()).toThrow(/no bucket simulation/);
  });
});

describe("full beta form: the factory arm", () => {
  it("terms with fullBeta build FullBetaDeposit at the given shift; without, the kernel NMDBeta", () => {
    const full = makeInstrument(terms(), { depositShiftPct: 1 });
    expect(full).toBeInstanceOf(FullBetaDeposit);
    expect((full as FullBetaDeposit).shiftPct).toBe(1);
    expect((makeInstrument(terms()) as FullBetaDeposit).shiftPct).toBe(0);
    const plain = makeInstrument({ ...NMD_B_TERMS_DEFAULTS });
    expect(plain).toBeInstanceOf(NMDBeta);
    expect(plain).not.toBeInstanceOf(FullBetaDeposit);
  });

  it("a slotting mark without the full form refuses", () => {
    expect(() => makeInstrument({ ...NMD_B_TERMS_DEFAULTS, depositSlotting: "frozen" } as EngineNMDBetaTerms)).toThrow(
      /carries no full beta form/,
    );
  });
});

describe("full beta form: the schema check", () => {
  it("a well-formed form has no issue", () => {
    expect(fullFormIssues(FORM)).toEqual([]);
    expect(checkOverlayParams({ kind: "deposit-beta", params: S_CURVE, fullForm: FORM })).toEqual([]);
  });

  it("names each bad field: a missing number, an out-of-range fraction, a bad move, balances, an unknown key", () => {
    const bad = { ...FORM, alphaPct: undefined, deltaUp: 1.5, baseLastMove: "up", balances: "decay", extra: 1 } as unknown;
    const paths = fullFormIssues(bad).map((i) => i.path);
    expect(paths).toEqual(["fullForm.extra", "fullForm.alphaPct", "fullForm.deltaUp", "fullForm.baseLastMove", "fullForm.balances"]);
  });

  it("bindAssumptions refuses a set whose deposit-beta full form is malformed", () => {
    const set = {
      schemaVersion: "1.0.0",
      id: "AS-FULL-BAD",
      label: "bad",
      bindings: [{ familyId: "MMA", modelVersion: "t", overlay: { kind: "deposit-beta" as const, params: S_CURVE, fullForm: { ...FORM, volRatio: -1 } } }],
    };
    expect(() => bindAssumptions(set)).toThrow(/fullForm\.volRatio/);
  });
});
