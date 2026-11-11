/**
 * Kernel cross-check: the engine solver, run under linear-zero, agrees with
 * bootstrapZeroCurve at every node to 1e-10 on both stored packs. This proves
 * the engine solver where it is NOT delegating to the kernel; the kernel is
 * imported, the engine's own formulas are not.
 *
 * The public pack runs as stored. The retired constructed pack runs through
 * monthExactSnapshot for BOTH kernel and engine (Task 4 ruling):
 * its 1D quote cannot be a whole-month setup row and its 1M quote is stored as
 * 0.083333 years, so the gate compares the two on the same month-exact copy.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bootstrapZeroCurve, parseMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { solveNodes } from "../solve";
import { monthExactSnapshot, setupFromSnapshot } from "./helpers";

const load = (url: URL): MarketSnapshot => parseMarketSnapshot(JSON.parse(readFileSync(url, "utf8")));

const expectAgreement = (snap: MarketSnapshot): void => {
  const kernel = bootstrapZeroCurve(snap);
  const engine = solveNodes(setupFromSnapshot(snap, "linear-zero"));
  expect(engine.t).toHaveLength(kernel.t.length);
  // Same nodes in the same order. The public pack stores 1M as 0.083333 years, so tenors match to 1e-6, not exactly.
  engine.t.forEach((ti, i) => expect(Math.abs(ti - kernel.t[i])).toBeLessThan(1e-6));
  engine.z.forEach((zi, i) => expect(Math.abs(zi - kernel.z[i])).toBeLessThan(1e-10));
};

describe("engine solver against bootstrapZeroCurve, linear-zero", () => {
  it("pack market_public.json, as stored (semiannual_bond)", () => {
    const snap = load(new URL("../../../../kernel/public/market_public.json", import.meta.url));
    expect(snap.curveConvention).toBe("semiannual_bond");
    expectAgreement(snap);
  });

  it("pack market_constructed.json, month-exact copy for both (annual_act360)", () => {
    const raw = load(
      new URL("../../../../kernel/src/math/rates/__tests__/fixtures/market_constructed.json", import.meta.url),
    );
    expect(raw.curveConvention).toBe("annual_act360");
    const { snapshot, dropped } = monthExactSnapshot(raw);
    expect(dropped).toEqual(["1D"]);
    expect(snapshot.curveQuotes).toHaveLength(raw.curveQuotes.length - 1);
    expectAgreement(snapshot);
  });

  it("monthExactSnapshot refuses a quote off a whole month, naming its term", () => {
    const raw = load(new URL("../../../../kernel/public/market_public.json", import.meta.url));
    const bent = { ...raw, curveQuotes: raw.curveQuotes.map((q) => (q.term === "2Y" ? { ...q, tYears: 2.01 } : q)) };
    expect(() => monthExactSnapshot(bent)).toThrow(/quote 2Y/);
  });
});
