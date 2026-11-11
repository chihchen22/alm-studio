import { describe, it, expect } from "vitest";
import { BucketAccumulator } from "../bucketAccumulator";

describe("BucketAccumulator", () => {
  it("starts zeroed at the requested horizon length", () => {
    const acc = new BucketAccumulator(360);
    expect(acc.length).toBe(360);
    expect(acc.balance.length).toBe(360);
    expect(acc.principal.length).toBe(360);
    expect(acc.interest.length).toBe(360);
    expect(acc.balance.every((v) => v === 0)).toBe(true);
    expect(acc.principal.every((v) => v === 0)).toBe(true);
    expect(acc.interest.every((v) => v === 0)).toBe(true);
  });

  it("accumulates repeated adds into the same bucket", () => {
    const acc = new BucketAccumulator(12);
    acc.add(3, 100, 10, 1);
    acc.add(3, 50, 5, 2);
    expect(acc.balance[3]).toBe(150);
    expect(acc.principal[3]).toBe(15);
    expect(acc.interest[3]).toBe(3);
  });

  it("keeps buckets independent", () => {
    const acc = new BucketAccumulator(12);
    acc.add(0, 1, 0, 0);
    acc.add(11, 2, 0, 0);
    expect(acc.balance[0]).toBe(1);
    expect(acc.balance[11]).toBe(2);
    expect(acc.balance[5]).toBe(0);
  });

  it("reduces a Cashflow leg via addCashflow", () => {
    const acc = new BucketAccumulator(12);
    acc.addCashflow(4, {
      monthOffset: 5,
      balance: 200,
      principalPaid: 20,
      interestPaid: 3,
      couponRate: 0.05,
    });
    expect(acc.balance[4]).toBe(200);
    expect(acc.principal[4]).toBe(20);
    expect(acc.interest[4]).toBe(3);
  });

  it("throws on an out-of-range bucket rather than silently dropping cash", () => {
    const acc = new BucketAccumulator(12);
    expect(() => acc.add(12, 1, 1, 1)).toThrow(RangeError);
    expect(() => acc.add(-1, 1, 1, 1)).toThrow(RangeError);
  });

  it("reset zeroes the accumulators without reallocating the arrays", () => {
    const acc = new BucketAccumulator(12);
    const balRef = acc.balance;
    const prinRef = acc.principal;
    const intRef = acc.interest;
    acc.add(2, 100, 10, 1);
    acc.reset();
    expect(acc.balance[2]).toBe(0);
    // Same backing arrays: reset is a fill, not a fresh allocation.
    expect(acc.balance).toBe(balRef);
    expect(acc.principal).toBe(prinRef);
    expect(acc.interest).toBe(intRef);
  });

  it("does not reallocate its arrays across adds (allocation-free hot path)", () => {
    const acc = new BucketAccumulator(12);
    const balRef = acc.balance;
    for (let m = 0; m < 12; m++) acc.add(m, m, m, m);
    expect(acc.balance).toBe(balRef);
  });
});
