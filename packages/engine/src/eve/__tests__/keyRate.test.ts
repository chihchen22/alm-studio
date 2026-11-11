/**
 * Key-rate durations. Anchors:
 *
 *  - HAND CASE: a single 5Y zero-coupon bullet on a hand-rolled flat curve
 *    with nodes at 1/3/7/10y concentrates its key-rate mass at the bracketing
 *    3y and 7y nodes with interpolation weights 0.5/0.5 (computable on paper:
 *    z(5) moves by half the node bump), the non-bracketing nodes read EXACTLY
 *    zero (their tents leave z(5) untouched and the position is
 *    path-independent), and the weights sum to 1.
 *  - ADDITIVITY + CONVERGENCE (the gate, alm-eve cross-model #104): node
 *    durations sum to the same-machinery parallel reference, and the residual
 *    falls roughly four-fold when the bump halves. Also measured at 25 vs 10bp
 *    (the plan's literal pair): second-order scaling predicts a residual
 *    ratio near (25/10)² = 6.25.
 *  - BASE-LEG IDENTITY: the module's regenerated base EVE equals the duration
 *    engine's base-leg EVE (same generator convention, independently coded
 *    accumulation) to 1e-9 relative.
 *  - Refusals: single-node curve, zero-equity book, malformed bump.
 *  - Determinism: two measurements serialize identically.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  bootstrapZeroCurve,
  buildTLPCurve,
  buildWarmupSOFR1M,
  loadMarketSnapshot,
  NMD_TERMS_DEFAULTS,
  type TLPCurve,
  type ZeroCurve,
} from "@alm/kernel";
import {
  collectSidedPositions,
  computeKeyRateDurations,
  DEFAULT_KEY_RATE_BUMP_BP,
  KEY_RATE_CONVERGENCE_RATIO_MIN,
  KEY_RATE_CONVERGENCE_RATIO_MAX,
  regeneratedEve,
} from "../keyRate";
import { computeEnvironmentDurations, type FamilyPositions } from "../effectiveDuration";
import { NotImplementedError } from "../../runtime/notImplemented";
import type { PortfolioSpec } from "../../contracts/position";
import {
  fixedPosition,
  makeCoa,
  makePortfolio,
  mortgagePosition,
  nmdBetaPosition,
  nmdPosition,
} from "./fixtures";

const MARKET = fileURLToPath(
  new URL("../../../../kernel/public/market_public.json", import.meta.url),
);
const ZERO_TLP: TLPCurve = buildTLPCurve([{ tYears: 1, spread: 0 }]);
const HORIZON = 360;

let base: ZeroCurve;
beforeAll(async () => {
  base = bootstrapZeroCurve(await loadMarketSnapshot(MARKET));
});

/**
 * Hand-rolled flat zero curve with the kernel's interpolation semantics
 * (linear in zero rate between nodes, flat outside; DF = exp(-z·t)). Built in
 * the test so the hand case's expected weights are computable on paper from
 * the node grid, independent of the bootstrap.
 */
function flatCurve(t: number[], zFlat: number): ZeroCurve {
  const z = t.map(() => zFlat);
  const lerp = (x: number): number => {
    if (x <= t[0]) return z[0];
    if (x >= t[t.length - 1]) return z[z.length - 1];
    for (let i = 0; i < t.length - 1; i++) {
      if (x >= t[i] && x <= t[i + 1]) {
        const w = (x - t[i]) / (t[i + 1] - t[i]);
        return z[i] * (1 - w) + z[i + 1] * w;
      }
    }
    return z[z.length - 1];
  };
  return {
    t,
    z,
    convention: "annual_act360",
    zeroRate: lerp,
    discountFactor: (x: number) => Math.exp(-lerp(x) * x),
    forwardRate(t1: number, t2: number): number {
      return (this.discountFactor(t1) / this.discountFactor(t2) - 1) / (t2 - t1);
    },
    forwardRateBey(t1: number, t2: number): number {
      return this.forwardRate(t1, t2);
    },
    forwardSwapRate(t1: number, t2: number): number {
      return this.forwardRate(t1, t2);
    },
  };
}

/** A one-position book: a 5Y zero-coupon bullet (coupon 0) asset. */
function zeroCouponBook(): PortfolioSpec {
  return makePortfolio([
    fixedPosition("Z1", {
      notional: 1_000_000,
      coupon: 0,
      maturityMonths: 60,
      amortType: "bullet",
    }),
  ]);
}

describe("key-rate hand case — 5Y zero on a 1/3/7/10y flat curve", () => {
  const NODES = [1, 3, 7, 10];

  function measure() {
    return computeKeyRateDurations({
      portfolio: zeroCouponBook(),
      scenarioId: "S0",
      curve: flatCurve(NODES, 0.03),
      tlp: ZERO_TLP,
      horizonMonths: 72,
      discountBasis: "risk-free",
    });
  }

  it("concentrates mass at the bracketing 3y/7y nodes, weights summing to 1", () => {
    const kr = measure();
    expect(kr.nodes.map((n) => n.tenorYears)).toEqual(NODES);
    const d = new Map(kr.nodes.map((n) => [n.tenorYears, n.duration]));

    // Non-bracketing nodes: their tents are zero at both nodes the 5Y point
    // interpolates between, so z(5) — and hence the single cash flow's PV —
    // is bit-identical across their up/down legs. Exactly zero, not "small".
    expect(d.get(1)).toBe(0);
    expect(d.get(10)).toBe(0);

    // Bracketing nodes: z(5) moves by half the bump (paper: w = (7-5)/(7-3)
    // = 0.5 toward 3y, 0.5 toward 7y), so each key-rate duration is
    // 0.5 · T = 2.5y up to central-difference convexity (~(whT)²/6 ≈ 7e-6
    // relative at 25bp).
    expect(d.get(3)).toBeCloseTo(2.5, 4);
    expect(d.get(7)).toBeCloseTo(2.5, 4);

    // Symmetric interpolation: the two bracketing durations are IDENTICAL
    // arithmetic (0.5-weighted lerp both ways), so the weights are exactly
    // 0.5/0.5 and sum to 1.
    expect(d.get(3)).toBe(d.get(7));
    const wSum = (d.get(3)! + d.get(7)!) / kr.sum;
    expect(wSum).toBe(1); // the two bracketing nodes carry ALL the mass

    // A zero's duration is its maturity (continuous-compounding limit).
    expect(kr.parallelReference).toBeCloseTo(5, 3);
    expect(kr.sum).toBeCloseTo(kr.parallelReference, 3);
  });

  it("passes the additivity-plus-convergence gate with a clean second-order ratio", () => {
    const kr = measure();
    // Smooth exponential PV: the residual is pure convexity and the halving
    // ratio sits tight on 4.
    expect(kr.convergence.converged).toBe(true);
    expect(kr.convergence.ratio).toBeDefined();
    expect(kr.convergence.ratio!).toBeGreaterThan(3.8);
    expect(kr.convergence.ratio!).toBeLessThan(4.2);
    // eslint-disable-next-line no-console
    console.log(
      `[keyRate hand case] sum=${kr.sum} parallel=${kr.parallelReference} ` +
        `residual(25bp)=${kr.convergence.residualYears} ` +
        `residual(12.5bp)=${kr.convergence.residualYearsAtHalvedBump} ratio=${kr.convergence.ratio}`,
    );
  });
});

describe("key-rate additivity gate — behavioral two-sided book on the real curve", () => {
  // The Non-IB NMD carries regimeAlpha 0 here: a nonzero one-sided regime
  // amplifier is REFUSED typed by the module (its excursion cannot be pinned
  // under a shaped node bump — see the refusal test below and the module doc's
  // measured evidence). The rest of the behavioral surface (mortgage prepay,
  // NMD decay, NMD-B beta) is fully live.
  function behavioralBook(): PortfolioSpec {
    return makePortfolio([
      fixedPosition("F1", { notional: 5_000_000, coupon: 0.05, maturityMonths: 60 }),
      mortgagePosition("M1", { notional: 4_000_000, originalBalance: 4_000_000 }),
      nmdPosition("D1", {
        notional: 3_000_000,
        nmdParams: { ...NMD_TERMS_DEFAULTS.nmdParams, regimeAlpha: 0 },
      }),
      nmdBetaPosition("B1", { notional: 2_000_000 }),
    ]);
  }

  it("sums to the parallel reference with a four-fold-converging residual", () => {
    const kr = computeKeyRateDurations({
      portfolio: behavioralBook(),
      scenarioId: "S0",
      curve: base,
      tlp: ZERO_TLP,
      horizonMonths: HORIZON,
    });
    expect(kr.bumpBp).toBe(DEFAULT_KEY_RATE_BUMP_BP);
    expect(kr.nodes).toHaveLength(base.t.length);
    // The gate itself.
    expect(kr.convergence.converged).toBe(true);
    if (kr.convergence.ratio !== undefined) {
      expect(kr.convergence.ratio).toBeGreaterThanOrEqual(KEY_RATE_CONVERGENCE_RATIO_MIN);
      expect(kr.convergence.ratio).toBeLessThanOrEqual(KEY_RATE_CONVERGENCE_RATIO_MAX);
    }
    // Additivity in absolute terms: the residual is small against the sum.
    // Measured 2.74% at the default 25bp (mortgage ITM/burnout kink
    // contamination; falls to 0.56% at 10bp) — bound at 5%.
    expect(Math.abs(kr.convergence.residualYears)).toBeLessThan(
      0.05 * Math.max(1, Math.abs(kr.sum)),
    );
    // eslint-disable-next-line no-console
    console.log(
      `[keyRate behavioral] sum=${kr.sum} parallel=${kr.parallelReference} ` +
        `residual(25bp)=${kr.convergence.residualYears} ` +
        `residual(12.5bp)=${kr.convergence.residualYearsAtHalvedBump} ratio=${kr.convergence.ratio}`,
    );
  }, 120_000);

  it("base-leg EVE equals the duration engine's base leg to 1e-9 relative", () => {
    const book = behavioralBook();
    const coa = makeCoa();
    const famInputs: FamilyPositions[] = coa.families.map((family) => ({
      family,
      positions: book.positions.filter((p) => p.familyId === family.id),
    }));
    const envDur = computeEnvironmentDurations(famInputs, base, ZERO_TLP, HORIZON, 100, "all-in");
    // The module's own base-leg regeneration (the EVE_0 every node duration
    // divides by) against the duration engine's base-leg EVE: same generator
    // convention, independently written accumulation loops.
    const mine = regeneratedEve(
      collectSidedPositions(book), base, ZERO_TLP, "all-in", HORIZON, buildWarmupSOFR1M(), 0,
    );
    expect(Math.abs(mine - envDur.eve) / Math.abs(envDur.eve)).toBeLessThan(1e-9);

    // Weld to the duration engine AT THE SAME BUMP (25bp): the remaining gap
    // is the path convention alone — the engine's ParallelShockPath shifts
    // path rates by exactly the bump, the KRD machinery rebuilds the path from
    // the shifted curve (forward-consistent, the alm-eve rule), and the two
    // differ where a behavioral driver reads the path (measured 4.8% on this
    // book, concentrated in the mortgage prepay driver; 0.0006% on a
    // path-independent book). NOT compared across widths: engine(100bp) is
    // −1.03y on this book vs −4.3y at 25bp — width dependence is genuine
    // behavioral convexity (alm-eve), not error.
    const env25 = computeEnvironmentDurations(famInputs, base, ZERO_TLP, HORIZON, 25, "all-in");
    const kr = computeKeyRateDurations({
      portfolio: book,
      scenarioId: "S0",
      curve: base,
      tlp: ZERO_TLP,
      horizonMonths: HORIZON,
    });
    const rel =
      Math.abs(kr.parallelReference - env25.effectiveDurationEquity) /
      Math.abs(env25.effectiveDurationEquity);
    expect(Math.sign(kr.parallelReference)).toBe(Math.sign(env25.effectiveDurationEquity));
    expect(rel).toBeLessThan(0.1);
    // eslint-disable-next-line no-console
    console.log(
      `[keyRate vs engine] parallelRef(25bp)=${kr.parallelReference} ` +
        `engine(25bp)=${env25.effectiveDurationEquity} rel=${rel} ` +
        `engine(100bp)=${envDur.effectiveDurationEquity}`,
    );
  }, 120_000);
});

describe("key-rate second-order scaling — 25bp vs 10bp (the plan pair)", () => {
  it("residual ratio lands near (25/10)² = 6.25 on a smooth fixed-rate book", () => {
    const book = makePortfolio([
      fixedPosition("F1", { notional: 5_000_000, coupon: 0.05, maturityMonths: 120, amortType: "level-pay" }),
      fixedPosition("F2", { notional: 3_000_000, coupon: 0.04, maturityMonths: 240, amortType: "bullet" }),
    ]);
    const at = (bumpBp: number) =>
      computeKeyRateDurations({
        portfolio: book,
        scenarioId: "S0",
        curve: base,
        tlp: ZERO_TLP,
        horizonMonths: HORIZON,
        bumpBp,
      });
    const r25 = at(25).convergence.residualYears;
    const r10 = at(10).convergence.residualYears;
    const ratio = Math.abs(r25) / Math.abs(r10);
    // eslint-disable-next-line no-console
    console.log(`[keyRate 25v10] residual(25bp)=${r25} residual(10bp)=${r10} ratio=${ratio}`);
    expect(ratio).toBeGreaterThan(5);
    expect(ratio).toBeLessThan(8);
  }, 120_000);
});

describe("key-rate refusals and determinism", () => {
  it("refuses typed on a single-node curve (layer eve.key-rate)", () => {
    expect(() =>
      computeKeyRateDurations({
        portfolio: zeroCouponBook(),
        scenarioId: "S0",
        curve: flatCurve([5], 0.03),
        tlp: ZERO_TLP,
        horizonMonths: 72,
      }),
    ).toThrowError(NotImplementedError);
    try {
      computeKeyRateDurations({
        portfolio: zeroCouponBook(),
        scenarioId: "S0",
        curve: flatCurve([5], 0.03),
        tlp: ZERO_TLP,
        horizonMonths: 72,
      });
    } catch (e) {
      expect((e as NotImplementedError).layer).toBe("eve.key-rate");
    }
  });

  it("refuses typed on a book with a one-sided regime amplifier (the structural non-additivity)", () => {
    // Default Non-IB NMD terms carry regimeAlpha 2.0. Measured evidence (probe,
    // module doc): additivity residual −0.69..−1.18y across 5-50bp bumps —
    // NON-vanishing with the bump — versus 4.24/4.04 halving ratios the moment
    // the amplifier is off. Refuse, never emit past a failed anchor.
    const ampBook = makePortfolio([nmdPosition("D1", { notional: 3_000_000 })]);
    try {
      computeKeyRateDurations({
        portfolio: ampBook,
        scenarioId: "S0",
        curve: base,
        tlp: ZERO_TLP,
        horizonMonths: 72,
      });
      expect.unreachable("regime-amplified book must refuse");
    } catch (e) {
      expect(e).toBeInstanceOf(NotImplementedError);
      expect((e as NotImplementedError).layer).toBe("eve.key-rate");
      expect((e as NotImplementedError).reason).toContain("D1");
      expect((e as NotImplementedError).reason).toContain("regime");
    }
  });

  it("refuses typed at zero base EVE (empty book)", () => {
    expect(() =>
      computeKeyRateDurations({
        portfolio: makePortfolio([]),
        scenarioId: "S0",
        curve: flatCurve([1, 3, 7, 10], 0.03),
        tlp: ZERO_TLP,
        horizonMonths: 72,
      }),
    ).toThrowError(NotImplementedError);
  });

  it("rejects a malformed bump", () => {
    expect(() =>
      computeKeyRateDurations({
        portfolio: zeroCouponBook(),
        scenarioId: "S0",
        curve: flatCurve([1, 3, 7, 10], 0.03),
        tlp: ZERO_TLP,
        horizonMonths: 72,
        bumpBp: -25,
      }),
    ).toThrowError(/bumpBp/);
  });

  it("is deterministic: two measurements serialize identically", () => {
    const run = () =>
      computeKeyRateDurations({
        portfolio: zeroCouponBook(),
        scenarioId: "S0",
        curve: flatCurve([1, 3, 7, 10], 0.03),
        tlp: ZERO_TLP,
        horizonMonths: 72,
      });
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
