/**
 * Slice K1 point 4 (D6): an SEG replacement deposit vintage reads the run's deposit history.
 *
 * The expectation is derived, not read from the seam. A deposit on a flat 6 percent path whose history is flat at
 * 6 percent has its 24-month moving average at 6 percent in every month, parent and vintages alike, so its regime
 * amplifier 1 + alpha max(0, r - MA) is 1 throughout: its constant-balance walk must equal the same deposit's walk
 * with alpha 0, where no history is read at all. The kernel's own warmup series averages 4.97 percent on its 24-month
 * window, so a vintage built on it sees the amplifier fire at 6 percent: the original convention cannot match.
 */
import { describe, expect, it } from "vitest";
import { NMDeposit, NMD_TERMS_DEFAULTS, buildWarmupSOFR1M, type NMDTerms, type RatePath } from "@alm/kernel";
import { runStaticBalance } from "../../loanPrepay";

function flatPath(z: number, nSteps = 61): RatePath {
  const dt = 1 / 12;
  const r = (Math.exp(z * dt) - 1) / dt;
  return { nSteps, times: Array.from({ length: nSteps + 1 }, (_, k) => k * dt), rateAt: () => r, forwardRateAt: () => r };
}

function deposit(alpha: number): NMDTerms {
  return { ...NMD_TERMS_DEFAULTS, id: "nmd-k1", notional: 1_000_000, maturityMonths: 360, nmdParams: { ...NMD_TERMS_DEFAULTS.nmdParams, regimeAlpha: alpha } };
}

const PATH = flatPath(0.06);
const H = 60;

describe("K1 point 4 (D6): SEG deposit vintages read the run's history", () => {
  // The flat history at the path's own one-month rate, in percent, 36 months.
  const history = new Array<number>(36).fill(PATH.rateAt(0) * 100);

  it("the kernel's own series sits below 6 percent on its 24-month window, so the amplifier can fire on it", () => {
    const k = buildWarmupSOFR1M();
    const ma = k.slice(-24).reduce((s, x) => s + x, 0) / 24;
    expect(ma).toBeLessThan(PATH.rateAt(0) * 100 - 0.5);
  });

  it("corrected: the walk on the flat history equals the walk with no regime amplifier at all", () => {
    const corrected = runStaticBalance(new NMDeposit(deposit(2), history), PATH, PATH, PATH, H, history);
    const noAmplifier = runStaticBalance(new NMDeposit(deposit(0), history), PATH, PATH, PATH, H);
    expect(corrected.vintages.length).toBeGreaterThan(10);
    for (let m = 0; m < H; m++) expect(corrected.totalInterest[m]).toBeCloseTo(noAmplifier.totalInterest[m]!, 9);
    for (let i = 0; i < corrected.vintages.length; i++) {
      const a = corrected.vintages[i]!.cashflows;
      const b = noAmplifier.vintages[i]!.cashflows;
      for (let k = 0; k < a.length; k++) expect(a[k]!.principalPaid).toBeCloseTo(b[k]!.principalPaid, 9);
    }
  });

  it("original convention: the vintages read the kernel series and run off faster than the parent's history implies", () => {
    const book = runStaticBalance(new NMDeposit(deposit(2), history), PATH, PATH, PATH, H);
    const noAmplifier = runStaticBalance(new NMDeposit(deposit(0), history), PATH, PATH, PATH, H);
    const v = (r: typeof book) => r.vintages[5]!.cashflows[0]!.principalPaid;
    expect(v(book)).toBeGreaterThan(v(noAmplifier) * 1.01);
  });

  it("a history equal to the kernel's own series leaves the walk where the original convention has it, bit for bit", () => {
    const k = buildWarmupSOFR1M();
    const withSeries = runStaticBalance(new NMDeposit(deposit(2), k), PATH, PATH, PATH, H, k);
    const book = runStaticBalance(new NMDeposit(deposit(2)), PATH, PATH, PATH, H);
    expect(Array.from(withSeries.totalInterest)).toEqual(Array.from(book.totalInterest));
  });
});
