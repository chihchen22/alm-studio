/**
 * The component decay form on the engine deposit. The form is small and round so every
 * expected number is worked by hand from the form's formula:
 *
 *   series 2020-01..2020-04 = 1, 3, 4, 2 percent; lookback 2; window 2020-03..2020-04
 *   benchmarks: mean(1, 3) = 2 and mean(3, 4) = 3.5, realized, whatever the shift
 *   base:  x = 2, 0      g = 0.98 x (1 + 0.01 - 0.01 x 2) = 0.9702, then 0.98 x 1.01 = 0.9898 held past the window
 *   +200:  x = 4, 0.5    g = 0.98 x 0.97 = 0.9506, then 0.98 x 1.005 = 0.9849
 *   -200:  x = 0, 0      g = 0.98 x 1.01 = 0.9898 throughout
 *
 * The full-runoff WAL is checked against a brute-force sum over 20,000 months, an independent route to the closed form.
 */
import { NMD_DEFAULTS, NMDeposit, type NMDTerms } from "@alm/kernel";
import { describe, expect, it } from "vitest";
import { componentDecayIssues } from "../../contracts/paramSchema";
import type { ComponentDecayForm, EngineNMDTerms } from "../../contracts/position";
import { applyOverlayToTerms } from "../../projection/static/applyOverlays";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { ComponentDecayDeposit, benchmarksPct, driverPct, monthlyFactors, type ComponentDecayTerms } from "../componentDecay";

const FORM: ComponentDecayForm = {
  retention: 0.98,
  drift: 0.01,
  coefficientPerPp: -0.01,
  lookbackMonths: 2,
  series: { firstMonth: "2020-01", label: "a round test series", valuesPct: [1, 3, 4, 2] },
  window: { firstMonth: "2020-03", lastMonth: "2020-04" },
  beyondWindow: "hold-last",
};

const nmd = (o: Partial<EngineNMDTerms> = {}): EngineNMDTerms => ({
  id: "dep",
  type: "nmd",
  label: "test deposit",
  notional: 100,
  maturityMonths: 6,
  originationOffsetMonths: 0,
  amortType: "level-pay",
  side: "liability",
  depositRate: 0,
  beta: 0,
  nmdParams: { ...NMD_DEFAULTS },
  ...o,
});
const withForm = (form: ComponentDecayForm = FORM, o: Partial<EngineNMDTerms> = {}): ComponentDecayTerms => ({ ...nmd(o), componentDecay: form });

/** The full-runoff WAL in years by brute force: the balance decays month by month until nothing is left. */
function bruteWal(factors: number[]): number {
  let b = 1;
  let dollarMonths = 0;
  for (let m = 1; m <= 20_000; m++) {
    const next = b * factors[Math.min(m, factors.length) - 1]!;
    dollarMonths += m * (b - next);
    b = next;
  }
  return dollarMonths / 12;
}

describe("the component decay form, by hand", () => {
  it("the benchmark stays on realized history and the shift moves the window level only", () => {
    expect(benchmarksPct(FORM)).toEqual([2, 3.5]);
    expect(driverPct(FORM, 0)).toEqual([2, 0]);
    expect(driverPct(FORM, 2)).toEqual([4, 0.5]);
    expect(driverPct(FORM, -2)).toEqual([0, 0]);
    const g = monthlyFactors(FORM, 2);
    expect(g[0]).toBeCloseTo(0.9506, 15);
    expect(g[1]).toBeCloseTo(0.98490, 15);
  });

  it("the cash flows: opening balance, the month's runoff, the remainder at maturity; the driver held past the window", () => {
    const cfs = new ComponentDecayDeposit(withForm(), 0).generateCashflows();
    const b = [100, 97.02, 97.02 * 0.9898];
    for (let m = 3; m <= 6; m++) b.push(b[m - 1]! * 0.9898);
    for (let m = 1; m <= 6; m++) {
      expect(cfs[m - 1]!.balance).toBeCloseTo(b[m - 1]!, 12);
      expect(cfs[m - 1]!.principalPaid).toBeCloseTo(m < 6 ? b[m - 1]! - b[m]! : b[5]!, 12);
      expect(cfs[m - 1]!.interestPaid).toBe(0);
    }
  });

  it("the static bifurcation: the share on the frozen base schedule in every scenario, the rest gone in month 1", () => {
    const form = { ...FORM, staticShare: 0.5 };
    for (const shift of [0, 2, -2]) {
      const cfs = new ComponentDecayDeposit(withForm(form), shift).generateCashflows();
      expect(cfs[0]!.balance).toBe(100);
      expect(cfs[1]!.balance).toBeCloseTo(50 * 0.9702, 12);
      expect(cfs[0]!.principalPaid).toBeCloseTo(100 - 50 * 0.9702, 12);
      expect(cfs[2]!.balance).toBeCloseTo(50 * 0.9702 * 0.9898, 12);
    }
  });

  it("the WAL readout adds the exact tail: in-horizon fold plus the correction equals the full runoff, on a long or a short grid", () => {
    for (const [form, shift] of [[FORM, 0], [FORM, 2], [FORM, -2], [{ ...FORM, staticShare: 0.5 }, 2]] as const) {
      const dep = new ComponentDecayDeposit(withForm(form), shift);
      // The static bifurcation's overnight remainder counts zero life: its WAL is the share times the base schedule's.
      const expected = form.staticShare === undefined ? bruteWal(monthlyFactors(form, shift)) : form.staticShare * bruteWal(monthlyFactors(form, 0));
      for (const horizon of [6, 4, 1]) {
        const cfs = dep.generateCashflows().filter((c) => c.monthOffset <= horizon);
        const fold = cfs.reduce((s, c) => s + (c.principalPaid * c.monthOffset) / 12, 0);
        const total = cfs.reduce((s, c) => s + c.principalPaid, 0);
        const c = dep.walCorrection(horizon);
        expect(Math.abs((fold + c.dollarYears) / (total + c.principal) - expected)).toBeLessThan(1e-9);
      }
    }
  });

  it("the factory builds it only for nmd terms carrying the form; any other nmd is the kernel's", () => {
    expect(makeInstrument(withForm(), { depositShiftPct: 2 })).toBeInstanceOf(ComponentDecayDeposit);
    expect((makeInstrument(withForm(), { depositShiftPct: 2 }) as ComponentDecayDeposit).shiftPct).toBe(2);
    const plain = makeInstrument(nmd() as NMDTerms);
    expect(plain).toBeInstanceOf(NMDeposit);
    expect(plain).not.toBeInstanceOf(ComponentDecayDeposit);
  });

  it("the overlay merge writes the form onto nmd terms and refuses it on nmd-b", () => {
    const overlay = { kind: "nmd-decay" as const, params: { ...NMD_DEFAULTS }, componentDecay: FORM };
    const merged = applyOverlayToTerms(nmd() as NMDTerms, overlay, "dep") as EngineNMDTerms;
    expect(merged.componentDecay).toEqual(FORM);
    const nmdb = { ...nmd(), type: "nmd-b" as const, sCurve: { betaMin: 0, betaMax: 0.5, k: 1, m: 2, lambda: 0.5 } };
    expect(() => applyOverlayToTerms(nmdb as never, overlay, "dep")).toThrow(/applies only to "nmd"/);
    const withoutForm = applyOverlayToTerms(nmd() as NMDTerms, { kind: "nmd-decay", params: { ...NMD_DEFAULTS } }, "dep") as EngineNMDTerms;
    expect(withoutForm.componentDecay).toBeUndefined();
  });

  it("the schema refuses a malformed form by path, and a window the series cannot feed", () => {
    expect(componentDecayIssues(FORM)).toEqual([]);
    expect(componentDecayIssues({ ...FORM, retention: 1.2 }).map((i) => i.path)).toEqual(["componentDecay.retention"]);
    expect(componentDecayIssues({ ...FORM, beyondWindow: "flat" }).map((i) => i.path)).toEqual(["componentDecay.beyondWindow"]);
    expect(componentDecayIssues({ ...FORM, extra: 1 }).map((i) => i.path)).toEqual(["componentDecay.extra"]);
    expect(componentDecayIssues({ ...FORM, window: { firstMonth: "2020-02", lastMonth: "2020-04" } })[0]!.message).toMatch(/needs 2 months of the series before it/);
    expect(componentDecayIssues({ ...FORM, window: { firstMonth: "2020-03", lastMonth: "2020-05" } })[0]!.message).toMatch(/ends after the series/);
    expect(componentDecayIssues({ ...FORM, series: { ...FORM.series, valuesPct: [1, 3, Number.NaN, 2] } })[0]!.path).toBe("componentDecay.series.valuesPct[2]");
  });

  it("refuses a path that never runs the book off", () => {
    expect(() => new ComponentDecayDeposit(withForm({ ...FORM, retention: 1, drift: 0.01 }), -2)).toThrow(/never runs the book off/);
  });
});
