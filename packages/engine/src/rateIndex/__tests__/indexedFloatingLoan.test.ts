/**
 * IndexedFloatingLoan. The three terms are the seeded
 * floating-loans-0, -1 and -2 restated as literals (read from the seed's own
 * builder once, to copy them); expected cash-flow values are measured on
 * unmodified source plus the formula (probe2.ts).
 */
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { FloatingLoan, loadMarketSnapshot, type Cashflow, type FloatingLoanTerms, type RatePath } from "@alm/kernel";
import { buildBaseCurve, buildRatePath, shockedCurve } from "../../scenario/rateEnvironment";
import { IndexedFloatingLoan } from "../indexedFloatingLoan";

const FIXTURE = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));

const floater = (id: string, notional: number, maturityMonths: number, margin: number): FloatingLoanTerms => ({
  id,
  type: "floating-loan",
  notional,
  maturityMonths,
  originationOffsetMonths: 0,
  amortType: "level-pay",
  side: "asset",
  indexTenorMonths: 1,
  margin,
  resetFrequencyMonths: 1,
});
const FL0 = floater("floating-loans-0", 1985293, 32, 0.0228);
const FL1 = floater("floating-loans-1", 2651415, 39, 0.0164);
const FL2 = floater("floating-loans-2", 1265499, 56, 0.0227);

class Stub implements RatePath {
  readonly nSteps = 400;
  readonly times: number[] = [];
  constructor(private readonly r: (s: number) => number) {}
  rateAt(s: number): number {
    return this.r(s);
  }
  forwardRateAt(): number {
    return Number.NaN;
  }
}

const interest = (cfs: Cashflow[], upTo: number): number => cfs.filter((c) => c.monthOffset <= upTo).reduce((s, c) => s + c.interestPaid, 0);

let path: RatePath;
beforeAll(async () => {
  const snap = await loadMarketSnapshot(FIXTURE);
  path = buildRatePath(shockedCurve(buildBaseCurve(snap), { kind: "base" }), 360);
});

describe("identity (tenor 1, basis 0)", () => {
  it("gives JSON-identical cash flows to the kernel loan on the public path", () => {
    const a = new FloatingLoan(FL0).generateCashflows(path);
    const b = new IndexedFloatingLoan(FL0, { id: "rfr-1m", label: "x", tenorMonths: 1, basis: 0 }).generateCashflows(path);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // R(0) on the default curve, 0.03711187754093537 to 0.03711187832875318 (first node at exactly 1/12); interpolation, deltas Step 1
    expect(a[0]!.couponRate).toBeCloseTo(0.03711187832875318 + 0.0228, 15);
  });
});

describe("bullet on a flat 0.04 path with a 300 bp one-month index", () => {
  const bullet: FloatingLoanTerms = { ...FL0, id: "b", notional: 1_000_000, maturityMonths: 12, amortType: "bullet", margin: 0.0125 };
  const flat = new Stub(() => 0.04);
  const unindexed = new FloatingLoan(bullet).generateCashflows(flat);
  const indexed = new IndexedFloatingLoan(bullet, { id: "prime-demo", label: "x", tenorMonths: 1, basis: 0.03 }).generateCashflows(flat);
  it("adds the basis to the coupon", () => {
    expect(indexed[0]!.couponRate).toBeCloseTo(0.0825, 15);
    expect(indexed[0]!.interestPaid).toBeCloseTo(6875, 9);
    expect(unindexed[0]!.interestPaid).toBeCloseTo(4375, 9);
  });
  it("moves twelve-month interest by 30000", () => {
    expect(interest(indexed, 12)).toBeCloseTo(82500, 9);
    expect(interest(unindexed, 12)).toBeCloseTo(52500, 9);
    expect(interest(indexed, 12) - interest(unindexed, 12)).toBeCloseTo(30000, 9);
  });
});

describe("quarterly reset on a three-month index over the step stub", () => {
  const steps = new Stub((s) => [0.03, 0.036, 0.042, 0.048][Math.min(s, 3)]!);
  const bullet: FloatingLoanTerms = { ...FL0, id: "q", notional: 1_000_000, maturityMonths: 12, amortType: "bullet", margin: 0.0125, resetFrequencyMonths: 3 };
  const cfs = new IndexedFloatingLoan(bullet, { id: "rfr-3m", label: "x", tenorMonths: 3, basis: 0 }).generateCashflows(steps);
  it("holds the coupon over each reset window", () => {
    for (const m of [0, 1, 2]) expect(cfs[m]!.couponRate).toBeCloseTo(0.04860710499999925, 9);
    expect(cfs[3]!.couponRate).toBeCloseTo(0.0606922560000001, 9);
    expect(cfs[0]!.interestPaid).toBeCloseTo(4050.5920833332702, 9);
  });
});

describe("seeded floaters on the public path", () => {
  it("floating-loans-1 on a three-month index with no basis", () => {
    const a = new FloatingLoan(FL1).generateCashflows(path);
    const b = new IndexedFloatingLoan(FL1, { id: "rfr-3m", label: "x", tenorMonths: 3, basis: 0 }).generateCashflows(path);
    expect(b[0]!.couponRate).toBeCloseTo(0.053230439837669535, 9);
    expect(b[0]!.interestPaid).toBeCloseTo(11761.332220182881, 9);
    // B4: 2,651,415 (r(0) + 0.0164) / 12 on the moved r(0) (was 11823.516232516595); deltas Step 1
    expect(a[0]!.interestPaid).toBeCloseTo(11823.516406585926, 9);
    // The 3M-index and 1M resets inside the first year read off-node forwards (1M to 1Y gaps), which log-linear
    // on DF moves (was 359.136568314163); deltas Step 1
    expect(interest(b, 12) - interest(a, 12)).toBeCloseTo(531.4326679492515, 9);
    // As above over 24 months (was 651.5877215871296); deltas Step 1
    expect(interest(b, 24) - interest(a, 24)).toBeCloseTo(683.7819861696626, 9);
  });
  it("floating-loans-2 on a 300 bp one-month index", () => {
    const a = new FloatingLoan(FL2).generateCashflows(path);
    const b = new IndexedFloatingLoan(FL2, { id: "prime-demo", label: "x", tenorMonths: 1, basis: 0.03 }).generateCashflows(path);
    // Month 1 on the moved r(0): r(0) + 0.03 + 0.0227, and 1,265,499 x coupon / 12 (were 0.08981187754093536,
    // 9471.403434681346 and 6307.655934681347); deltas Step 1
    expect(b[0]!.couponRate).toBeCloseTo(0.08981187832875318, 9);
    expect(b[0]!.interestPaid).toBeCloseTo(9471.403517763234, 9);
    expect(a[0]!.interestPaid).toBeCloseTo(6307.656017763235, 9);
    expect(b[0]!.interestPaid - a[0]!.interestPaid).toBeCloseTo(3163.7475, 9);
    // The basis accrues on the balance, and the balance amortizes on the moved resets (was 35272.413271358106); deltas Step 1
    expect(interest(b, 12) - interest(a, 12)).toBeCloseTo(35272.402835080895, 9);
    // As above over 24 months (was 64086.40827681031); deltas Step 1
    expect(interest(b, 24) - interest(a, 24)).toBeCloseTo(64087.02510371216, 9);
  });
  it("floating-loans-2 with a 325 bp basis", () => {
    const a = new FloatingLoan(FL2).generateCashflows(path);
    const b = new IndexedFloatingLoan(FL2, { id: "prime-demo", label: "x", tenorMonths: 1, basis: 0.0325 }).generateCashflows(path);
    // B4: 1,265,499 (r(0) + 0.0325 + 0.0227) / 12 on the moved r(0) (was 9735.049059681347); deltas Step 1
    expect(b[0]!.interestPaid).toBeCloseTo(9735.049142763235, 9);
    // As above, on the 325 bp basis (was 38229.04001726709); deltas Step 1
    expect(interest(b, 12) - interest(a, 12)).toBeCloseTo(38229.029290090955, 9);
  });
});

describe("seam", () => {
  it("repricingSchedule equals the kernel's and terms are the kernel's", () => {
    const k = new FloatingLoan(FL1);
    const w = new IndexedFloatingLoan(FL1, { id: "rfr-3m", label: "x", tenorMonths: 3, basis: 0 });
    expect(w.repricingSchedule()).toEqual(k.repricingSchedule());
    expect(w.repricingSchedule()).toHaveLength(39);
    expect(w.terms).toEqual(FL1);
  });
  it("is built with the kernel's own validation", () => {
    expect(() => new IndexedFloatingLoan({ ...FL1, notional: 0 }, { id: "a", label: "x", tenorMonths: 1, basis: 0 })).toThrow("FloatingLoan: notional must be positive");
  });
});
