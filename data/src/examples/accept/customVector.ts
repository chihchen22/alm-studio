/**
 * Acceptance check: custom-rate-vector.
 *
 * Anchors and the module report:
 *
 *   1. TWIST EQUIVALENCE — a custom vector on the twist's own breakpoints
 *      {0: shortBp, pivot: 0, maxTenor: longBp} reproduces `twistCurve` at
 *      every curve node and a dense tenor sweep to 1e-12 (measured exact 0 in
 *      the module tests: both arms share the same lerp and curve factory).
 *      The oracle is the INDEPENDENT twist implementation, not the custom arm.
 *   2. ZERO ROUND-TRIP — an all-zero vector reproduces the base curve
 *      bitwise (Object.is on zeroRate and discountFactor at every sample).
 *   3. TYPED REFUSAL — a non-ascending tenor vector throws CustomShockError
 *      naming the offending knot (the 422 the platform serves verbatim).
 */
import { buildBaseCurve, customCurve, twistCurve, CustomShockError } from "@alm/engine/src/scenario";
import type { CapabilityCheck, CheckLine } from "./types";

const SHORT_BP = -150;
const LONG_BP = 200;
const PIVOT_YEARS = 5;

export const customVectorCheck: CapabilityCheck = {
  capabilityId: "custom-rate-vector",
  title: "Custom per-tenor bp shock vector RateSpec arm",
  run({ market }) {
    const lines: CheckLine[] = [];
    const base = buildBaseCurve(market);
    const maxTenor = base.t[base.t.length - 1];

    // Dense sweep: every curve node plus a 0.1y grid to the last node.
    const samples: number[] = [...base.t];
    for (let t = 0; t <= maxTenor + 1e-9; t += 0.1) samples.push(Number(t.toFixed(1)));

    // 1. Twist equivalence.
    const twist = twistCurve(base, SHORT_BP, LONG_BP, PIVOT_YEARS);
    const viaCustom = customCurve(base, [
      { tenorYears: 0, shockBp: SHORT_BP },
      { tenorYears: PIVOT_YEARS, shockBp: 0 },
      { tenorYears: maxTenor, shockBp: LONG_BP },
    ]);
    let worstZ = 0;
    let worstDf = 0;
    for (const t of samples) {
      worstZ = Math.max(worstZ, Math.abs(viaCustom.zeroRate(t) - twist.zeroRate(t)));
      worstDf = Math.max(worstDf, Math.abs(viaCustom.discountFactor(t) - twist.discountFactor(t)));
    }
    lines.push({
      id: "twist-equivalence",
      status: worstZ < 1e-12 && worstDf < 1e-12 ? "pass" : "fail",
      detail:
        `custom vector {0y:${SHORT_BP}, ${PIVOT_YEARS}y:0, ${maxTenor}y:+${LONG_BP}} vs twistCurve ` +
        `over ${samples.length} tenors: max |dzero| ${worstZ.toExponential(2)}, max |dDF| ` +
        `${worstDf.toExponential(2)} — both < 1e-12 (anchor: the independent twist arm is the ` +
        `oracle; a custom vector that claims to be a twist must BE the twist)`,
    });

    // 2. Zero vector round-trips base bitwise.
    const zero = customCurve(base, [
      { tenorYears: 0, shockBp: 0 },
      { tenorYears: PIVOT_YEARS, shockBp: 0 },
      { tenorYears: maxTenor, shockBp: 0 },
    ]);
    let bitwise = true;
    for (const t of samples) {
      if (!Object.is(zero.zeroRate(t), base.zeroRate(t)) || !Object.is(zero.discountFactor(t), base.discountFactor(t))) {
        bitwise = false;
        break;
      }
    }
    lines.push({
      id: "zero-round-trip",
      status: bitwise ? "pass" : "fail",
      detail:
        `all-zero knot vector reproduces the base curve bitwise (Object.is on zeroRate and ` +
        `discountFactor at every sample): ${bitwise} (anchor: a zero shock is the identity — ` +
        `exact, not approximate)`,
    });

    // 3. Typed refusal on non-ascending tenors.
    let refusal = "no error";
    try {
      customCurve(base, [
        { tenorYears: 5, shockBp: 10 },
        { tenorYears: 3, shockBp: 10 },
      ]);
    } catch (err) {
      const e = err as CustomShockError;
      refusal = e.name === "CustomShockError" && /shocks\[1\]/.test(e.field ?? "") ? "typed-naming-knot" : `${e.name}`;
    }
    lines.push({
      id: "typed-refusal",
      status: refusal === "typed-naming-knot" ? "pass" : "fail",
      detail:
        `non-ascending tenor vector (5y then 3y) -> CustomShockError naming shocks[1]: ` +
        `${refusal} (anchor: the engine gate behind the platform's 422; a malformed vector ` +
        `never becomes a curve)`,
    });

    return { lines, observedNotImplemented: [] };
  },
};
