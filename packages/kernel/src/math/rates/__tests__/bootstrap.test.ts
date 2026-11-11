import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadMarketSnapshot } from "../marketData";
import {
  bootstrapZeroCurve,
  _annualFixSchedule,
  _semiannualFixSchedule,
} from "../bootstrap";

const MARKET_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_public.json");
const CONSTRUCTED_PATH = resolve(__dirname, "fixtures", "market_constructed.json");

describe("bootstrapZeroCurve (TS) vs Python reference", () => {
  it("reads the Treasury convention off the public pack's curve block", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    expect(snap.curveConvention).toBe("semiannual_bond");
    expect(snap.curveConventionFields.fixedPaymentFreq).toBe("semiannual");
    expect(bootstrapZeroCurve(snap).convention).toBe("semiannual_bond");
  });

  it("keeps the retired constructed fixture on annual ACT/360", async () => {
    // The fixture's curve block still declares an annual ACT/360 fixed leg, so
    // the loader must resolve the retired convention and its bootstrapped
    // numbers must not move with the Treasury-convention change.
    const snap = await loadMarketSnapshot(CONSTRUCTED_PATH);
    expect(snap.curveConvention).toBe("annual_act360");
    const curve = bootstrapZeroCurve(snap);
    expect(curve.convention).toBe("annual_act360");
    // Python reference (the Lab's Python reference) on the constructed fixture:
    // z=0.039117547, DF=0.676261481. Unchanged by this lane, and that is the point.
    expect(curve.zeroRate(10.0)).toBeCloseTo(0.039118, 5);
    expect(curve.discountFactor(10.0)).toBeCloseTo(0.676261, 5);
  });

  it("reprices every input par bond to within 0.01 bp", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);

    let maxAbsErrBp = 0;
    let repriced = 0;
    for (const q of snap.curveQuotes) {
      // The public pack labels its nodes CMT_PAR / BILL_BEY, not SWAP: the
      // filter is the tenor, not the label (bootstrap.ts treats the type as
      // metadata under the Treasury convention). Filtering on "SWAP" here
      // used to skip every node and assert nothing.
      if (q.tYears < 1.0) continue;
      repriced++;
      // Treasury convention: semi-annual coupons on exact half-year periods.
      const schedule = _semiannualFixSchedule(q.tYears);
      let pvFixUnit = 0;
      for (const cd of schedule) {
        pvFixUnit += 0.5 * Math.exp(-curve.zeroRate(cd) * cd);
      }
      const dfN = curve.discountFactor(q.tYears);
      const parImplied = (1 - dfN) / pvFixUnit;
      const errBp = Math.abs((parImplied - q.rate) * 1e4);
      maxAbsErrBp = Math.max(maxAbsErrBp, errBp);
    }
    // Guard the guard: the shipped pack carries CMT_PAR coupon nodes from 1Y out.
    expect(snap.curveQuotes.some((q) => q.instrumentType === "CMT_PAR")).toBe(true);
    expect(repriced).toBe(snap.curveQuotes.filter((q) => q.tYears >= 1.0).length);
    expect(repriced).toBeGreaterThan(4);
    expect(maxAbsErrBp).toBeLessThan(0.01);
  });

  it("reprices the public pack's sub-1Y BILL_BEY nodes to their quoted bond-equivalent yield", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const bills = snap.curveQuotes.filter(
      (q) => q.instrumentType === "BILL_BEY" && q.tYears < 1.0,
    );
    expect(bills.length).toBeGreaterThan(0);
    let maxAbsErrBp = 0;
    for (const q of bills) {
      const df = curve.discountFactor(q.tYears);
      // < 6M: pure discount at the BEY. 6M to 1Y: one semi-annual coupon at maturity.
      const impliedRate =
        q.tYears < 0.5 - 1e-9
          ? (Math.pow(df, -1 / (2 * q.tYears)) - 1) * 2
          : (1 / df - 1) * 2;
      maxAbsErrBp = Math.max(maxAbsErrBp, Math.abs((impliedRate - q.rate) * 1e4));
    }
    expect(maxAbsErrBp).toBeLessThan(0.01);
  });

  it("reprices the constructed fixture's swaps on the annual schedule", async () => {
    const snap = await loadMarketSnapshot(CONSTRUCTED_PATH);
    const curve = bootstrapZeroCurve(snap);
    let maxAbsErrBp = 0;
    for (const q of snap.curveQuotes) {
      if (q.instrumentType !== "SWAP" || q.tYears <= 1.0) continue;
      const schedule = _annualFixSchedule(q.tYears);
      let pvFixUnit = 0;
      let prev = 0;
      for (const cd of schedule) {
        pvFixUnit += (cd - prev) * (365 / 360) * Math.exp(-curve.zeroRate(cd) * cd);
        prev = cd;
      }
      const parImplied = (1 - curve.discountFactor(q.tYears)) / pvFixUnit;
      maxAbsErrBp = Math.max(maxAbsErrBp, Math.abs((parImplied - q.rate) * 1e4));
    }
    expect(maxAbsErrBp).toBeLessThan(0.01);
  });

  it("zero rate at 10Y matches Python reference within 1e-6", async () => {
    // PUBLIC BASIS, TREASURY CONVENTION (re-pinned 2026-08-31,
    // Treasury convention). From the Python reference bootstrapper
    // (the Lab's Python reference) on public/market_public.json: t=10y,
    // z=0.043081112410, DF=0.649981665053. TS agrees to 1e-12 at every node.
    // Prior pins, when the same CMT par yields were bootstrapped as annual
    // ACT/360 par swaps: z=0.043208, DF=0.649159. Carrying the CMT convention
    // into the short end left the 10Y node untouched, because the 1Y-and-beyond
    // par bonds only ever interpolate zeros at half-year points from 0.5 up and
    // the 6M node itself is unchanged (see the short-end test below).
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    expect(curve.zeroRate(10.0)).toBeCloseTo(0.043081, 5);
    expect(curve.discountFactor(10.0)).toBeCloseTo(0.649982, 5);
  });

  it("carries the CMT convention into the short end", async () => {
    // Python reference (the Lab's Python reference) on public/market_public.json,
    // re-pinned 2026-08-31 when the bills moved from ACT/360 simple cash onto
    // the bond-equivalent (coupon-equivalent) basis CMT actually quotes:
    //   1M  z=0.037054609228  (was 0.037341839379, -2.87 bp)
    //   3M  z=0.036661913369  (was 0.036829923004, -1.68 bp)
    //   6M  z=0.036858270937  (unchanged: one semi-annual coupon at maturity is
    //       arithmetically the same node as simple compounding over exactly
    //       half a year, so the two treatments coincide at t=0.5)
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    expect(curve.z[0]).toBeCloseTo(0.037054609228, 10);
    expect(curve.z[1]).toBeCloseTo(0.036661913369, 10);
    expect(curve.z[2]).toBeCloseTo(0.036858270937, 10);

    // Bills below the first coupon date are pure discount at the BEY:
    // DF(t) = (1 + y/2)^(-2t), i.e. z_cont = 2·ln(1 + y/2).
    for (const q of snap.curveQuotes) {
      if (q.tYears >= 0.5) continue;
      expect(curve.zeroRate(q.tYears)).toBeCloseTo(2 * Math.log1p(q.rate / 2), 12);
      expect(curve.discountFactor(q.tYears)).toBeCloseTo(
        (1 + q.rate / 2) ** (-2 * q.tYears),
        12,
      );
    }
    // The 6M node is a par bond with its single coupon at maturity.
    const six = snap.curveQuotes.find((q) => q.tYears === 0.5)!;
    expect((1 + six.rate / 2) * curve.discountFactor(0.5)).toBeCloseTo(1, 12);
  });

  it("ignores the instrument type label under the Treasury convention", async () => {
    // The label is descriptive metadata (BILL_BEY / CMT_PAR); the treatment
    // keys off the tenor. Relabelling every node the retired way must not move
    // a single zero, which is what keeps old CASH/SWAP packs and imported
    // workbooks bootstrapping identically.
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const relabelled = {
      ...snap,
      curveQuotes: snap.curveQuotes.map((q) => ({
        ...q,
        instrumentType: (q.tYears < 1 ? "CASH" : "SWAP") as "CASH" | "SWAP",
      })),
    };
    const a = bootstrapZeroCurve(snap);
    const b = bootstrapZeroCurve(relabelled);
    for (let i = 0; i < a.z.length; i++) expect(b.z[i]).toBeCloseTo(a.z[i], 14);
  });

  it("quotes forwards bond-equivalent semiannual under the Treasury convention", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const [t1, t2] = [5.0, 6.0];
    const fCont = Math.log(curve.discountFactor(t1) / curve.discountFactor(t2)) / (t2 - t1);
    expect(curve.forwardRateBey(t1, t2)).toBeCloseTo(2 * (Math.exp(fCont / 2) - 1), 12);
    // BEY sits below the simply-compounded forward at this tenor: semi-annual
    // compounding needs a lower quoted rate to reach the same growth factor.
    expect(curve.forwardRateBey(t1, t2)).toBeLessThan(curve.forwardRate(t1, t2));
    // Python reference: f_BEY(5,6) = 0.045586145600, simple = 0.046105669768.
    expect(curve.forwardRateBey(t1, t2)).toBeCloseTo(0.0455861456, 10);
    expect(curve.forwardRate(t1, t2)).toBeCloseTo(0.0461056698, 10);
  });

  it("leaves the retired convention's forwards on the simple basis", async () => {
    const snap = await loadMarketSnapshot(CONSTRUCTED_PATH);
    const curve = bootstrapZeroCurve(snap);
    expect(curve.forwardRateBey(5, 6)).toBeCloseTo(curve.forwardRate(5, 6), 14);
  });

  it("forward rate at 5Y x 1Y matches direct computation", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const f = curve.forwardRate(5.0, 6.0);
    // simply-compounded forward = (DF(5)/DF(6) - 1)
    const expected = curve.discountFactor(5.0) / curve.discountFactor(6.0) - 1;
    expect(f).toBeCloseTo(expected, 12);
  });

  it("forwardSwapRate(0, T) reproduces EVERY input CMT quote within 0.1 bp", async () => {
    // Under the Treasury convention forwardSwapRate is a forward par TREASURY
    // yield, so the round-trip now covers the bills too, not just the coupon
    // nodes: the same three-branch treatment the bootstrap applies is solved on
    // forward discount factors.
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    for (const q of snap.curveQuotes) {
      const s = curve.forwardSwapRate(0, q.tYears);
      expect(Math.abs((s - q.rate) * 1e4)).toBeLessThan(0.1);
    }
  });

  it("forwardSwapRate at 1M is the bond-equivalent quote, not the money-market one", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const tau = 1 / 12;
    // Below the first coupon date the forward par Treasury yield collapses onto
    // f_BEY, so the 1M node round-trips its own CMT quote (3.74%) exactly...
    expect(curve.forwardSwapRate(0, tau)).toBeCloseTo(curve.forwardRateBey(0, tau), 12);
    expect(curve.forwardSwapRate(0, tau)).toBeCloseTo(0.0374, 8);
    // ...and sits ~2.9 bp above the simply-compounded money-market forward,
    // which is the whole point of the coupon-equivalent conversion.
    expect(curve.forwardSwapRate(0, tau) - curve.forwardRate(0, tau)).toBeGreaterThan(
      0.00025,
    );
  });

  it("forwardSwapRate at 10Y is substantially below simply-compounded 10Y forward", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const simple = curve.forwardRate(0, 10);
    const swap = curve.forwardSwapRate(0, 10);
    // Expect at least 50 bps gap given a ~4.3% 10Y rate (compounding effect).
    expect(simple - swap).toBeGreaterThan(0.005);
  });
});
