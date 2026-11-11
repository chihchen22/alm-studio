/**
 * buildBaseCurve with an additive curveSetup block (step
 * B1). Absent block: the platform default (since B4 Task 5, curve
 * default version 2; curveDefaultFlip.test.ts), and the kernel bootstrap,
 * unchanged, for a market marked curveDefault: 1. Present block:
 * validated, then built by buildCurveFromSetup; every refusal surfaces as one
 * Error whose message is the refusals joined with "; ". shockedCurve keeps the
 * quote tenors through every rate spec kind.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bootstrapZeroCurve, parseMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { buildBaseCurve, shockedCurve } from "../rateEnvironment";
import { buildCurveFromSetup, CurveBuildError, quoteTenorsOf, validateCurveSetup } from "../../curveBuilder";
import { setupFromSnapshot } from "../../curveBuilder/__tests__/helpers";
import type { CurveSetupBlock, MarketWithCurveSetup } from "../../contracts/curveSetup";
import type { RateSpec } from "../../contracts/scenario";

const url = new URL("../../../../kernel/public/market_public.json", import.meta.url);
const snap = parseMarketSnapshot(JSON.parse(readFileSync(url, "utf8")));

const withSetup = (s: MarketSnapshot, setup: unknown): MarketSnapshot =>
  ({ ...s, curveSetup: setup }) as MarketWithCurveSetup;

const SPECS: RateSpec[] = [
  { kind: "base" },
  { kind: "parallel", shockBp: 100 },
  { kind: "twist", shortBp: 25, longBp: -25, pivotYears: 5 },
  { kind: "custom", shocks: [{ tenorYears: 1, shockBp: 10 }, { tenorYears: 10, shockBp: -20 }] },
];

describe("buildBaseCurve with a curveSetup block", () => {
  it("without the block, on a market marked curveDefault: 1, it is the kernel bootstrap, byte for byte", () => {
    const mine = buildBaseCurve({ ...snap, curveDefault: 1 } as MarketSnapshot);
    const kernel = bootstrapZeroCurve(snap);
    expect(mine.t).toEqual(kernel.t);
    expect(mine.z).toEqual(kernel.z);
    expect(mine.convention).toBe(kernel.convention);
    expect("curveSetup" in snap).toBe(false);
    // An unregistered curve reports its own nodes as its quote tenors.
    expect(quoteTenorsOf(mine)).toEqual(kernel.t);
  });

  it("with a log-linear setup it returns dense nodes and keeps quote tenors through a twist", () => {
    const setup = setupFromSnapshot(snap, "log-linear-df");
    const base = buildBaseCurve(withSetup(snap, setup));
    expect(base.t.length).toBeGreaterThan(snap.curveQuotes.length);
    expect(quoteTenorsOf(base)).toEqual(setup.inputs.map((r) => r.tenorMonths / 12));
    const shocked = shockedCurve(base, { kind: "twist", shortBp: 25, longBp: -25, pivotYears: 5 });
    expect(quoteTenorsOf(shocked)).toEqual(quoteTenorsOf(base));
  });

  it("returns the curve buildCurveFromSetup builds from the validated block", () => {
    const setup = setupFromSnapshot(snap, "monotone-convex");
    const base = buildBaseCurve(withSetup(snap, setup));
    const checked = validateCurveSetup(setup);
    if (!checked.ok) throw new Error(checked.refusals.join("; "));
    const direct = buildCurveFromSetup(checked.block).curve;
    expect(base.t).toEqual(direct.t);
    expect(base.z).toEqual(direct.z);
    expect(base.convention).toBe(direct.convention);
  });

  it("a linear-zero setup restating the pack gives the kernel's z on the month-exact nodes", () => {
    const setup = setupFromSnapshot(snap, "linear-zero");
    const base = buildBaseCurve(withSetup(snap, setup));
    const kernel = bootstrapZeroCurve(snap);
    expect(base.z.length).toBe(kernel.z.length);
    base.z.forEach((z, i) => expect(Math.abs(z - kernel.z[i]!), `node ${i}`).toBeLessThan(1e-12));
  });

  it("quote tenors survive each of the four rate spec kinds", () => {
    const base = buildBaseCurve(withSetup(snap, setupFromSnapshot(snap, "cubic-zero")));
    const want = quoteTenorsOf(base);
    expect(want.length).toBe(snap.curveQuotes.length);
    expect(base.t.length).toBeGreaterThan(want.length);
    for (const spec of SPECS) {
      const shocked = shockedCurve(base, spec);
      expect(quoteTenorsOf(shocked), spec.kind).toEqual(want);
      if (spec.kind === "base") expect(shocked).toBe(base);
      else expect(shocked).not.toBe(base);
      expect(shocked.t.length, spec.kind).toBe(base.t.length);
    }
  });

  it("shocking an unregistered curve leaves its quote tenors equal to its own nodes", () => {
    // The kernel bootstrap registers no quote tenors; since B4 Task 5 the marker selects it.
    const base = buildBaseCurve({ ...snap, curveDefault: 1 } as MarketSnapshot);
    for (const spec of SPECS) expect(quoteTenorsOf(shockedCurve(base, spec)), spec.kind).toEqual([...base.t]);
  });

  it("refuses an invalid setup with every refusal joined in one sentence", () => {
    const setup = setupFromSnapshot(snap, "log-linear-df");
    const bad = { ...setup, compounding: "continuous", inputs: [...setup.inputs, setup.inputs[0]] };
    const checked = validateCurveSetup(bad);
    expect(checked.ok).toBe(false);
    const refusals = (checked as { ok: false; refusals: string[] }).refusals;
    expect(refusals.length).toBeGreaterThan(1);
    let caught: unknown;
    try {
      buildBaseCurve(withSetup(snap, bad));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(refusals.join("; "));
    expect((caught as Error).message).toMatch(/continuous compounding has no coupon schedule/);
  });

  it("rethrows a CurveBuildError as one Error carrying its refusals", () => {
    const setup: CurveSetupBlock = {
      id: "unpriceable",
      label: "unpriceable",
      baseCurve: "SOFR",
      interpolation: "log-linear-df",
      dayCount: "ACT/360",
      compounding: "annual",
      // A 2-year par rate of -90 percent after a zero 1-year cash rate needs a zero rate near -154 percent.
      inputs: [
        { instrument: "cash", tenorMonths: 12, quoteType: "par-rate", value: 0 },
        { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: -0.9 },
      ],
    };
    let built: unknown;
    try {
      buildCurveFromSetup(setup);
    } catch (e) {
      built = e;
    }
    expect(built).toBeInstanceOf(CurveBuildError);
    const refusals = (built as CurveBuildError).refusals;
    let caught: unknown;
    try {
      buildBaseCurve(withSetup(snap, setup));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(CurveBuildError);
    expect((caught as Error).message).toBe(refusals.join("; "));
    expect((caught as Error).message).toMatch(/has no zero rate between -20 and 100 percent/);
  });
});
