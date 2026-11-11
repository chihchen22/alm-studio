/**
 * The straight-line runoff deposit. A $100M deposit over 24 months leaves $100M / 24
 * at the end of each month, so its month-end balances are 100 x (1 - t / 24) and its life is 12.5 months (95.8 at
 * month 1, 75.0 at month 6, 50.0 at month 12, 25.0 at month 18, 0 at month 24).
 */
import { NMD_DEFAULTS } from "@alm/kernel";
import { describe, expect, it } from "vitest";
import type { EngineNMDTerms } from "../../contracts/position";
import { linearDecayIssues } from "../../contracts/paramSchema";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { LinearDecayDeposit, hasLinearDecay, type LinearDecayTerms } from "../linearDecay";

const terms = (o: Partial<EngineNMDTerms> = {}): LinearDecayTerms => ({
  id: "dep-1",
  type: "nmd",
  notional: 100e6,
  maturityMonths: 24,
  originationOffsetMonths: 0,
  amortType: "level-pay",
  side: "liability",
  depositRate: 0.012,
  beta: 0.5,
  nmdParams: { ...NMD_DEFAULTS },
  linearDecay: { horizonMonths: 24 },
  ...o,
}) as LinearDecayTerms;

describe("LinearDecayDeposit", () => {
  it("runs off in a straight line: 100 x (1 - t / 24) at each month-end", () => {
    const b = new LinearDecayDeposit(terms()).balances();
    expect(b.length).toBe(25);
    for (const [t, printed] of [[0, 100], [1, 95.8], [6, 75], [12, 50], [18, 25], [24, 0]] as const) {
      expect(Math.round((b[t]! / 1e6) * 10) / 10).toBe(printed);
    }
  });

  it("books one n-th of the deposit each month, interest on the opening balance, and a life of (n + 1) / 2", () => {
    const dep = new LinearDecayDeposit(terms());
    const cf = dep.generateCashflows();
    expect(cf.length).toBe(24);
    expect(cf[0]).toEqual({ monthOffset: 1, balance: 100e6, principalPaid: 100e6 / 24, interestPaid: (100e6 * 0.012) / 12, couponRate: 0.012 });
    expect(cf.reduce((s, c) => s + c.principalPaid, 0)).toBeCloseTo(100e6, 6);
    const wal = cf.reduce((s, c) => s + c.monthOffset * c.principalPaid, 0) / 100e6;
    expect(wal).toBeCloseTo(12.5, 12);
    expect(dep.lifeMonths()).toBe(12.5);
  });

  it("the factory builds it for nmd terms that carry a linear decay, and the kernel deposit for any other", () => {
    expect(makeInstrument(terms())).toBeInstanceOf(LinearDecayDeposit);
    const { linearDecay: _drop, ...plain } = terms();
    expect(makeInstrument(plain)).not.toBeInstanceOf(LinearDecayDeposit);
    expect(hasLinearDecay(plain)).toBe(false);
  });

  it("refuses a runoff that is not the maturity, a fraction of a month, or an unknown field", () => {
    expect(() => new LinearDecayDeposit(terms({ maturityMonths: 360 }))).toThrow(/must equal the deposit's maturityMonths, 360/);
    expect(linearDecayIssues({ horizonMonths: 12.5 }, 12)[0]?.message).toMatch(/whole/);
    expect(linearDecayIssues({ horizonMonths: 24, life: 3 }, 24)[0]?.path).toBe("linearDecay.life");
    expect(() => new LinearDecayDeposit(terms()).simulateBook()).toThrow(/no account-size buckets/);
  });
});
