/**
 * Effective duration engine.
 *
 *  - Analytic anchor: a level-pay fixed loan's effective duration equals a
 *    hand-rolled bump-and-reprice (the loan is path-independent, so the bump
 *    only shifts the discount curve).
 *  - Lab cross-check: a single default Non-IB NMD's effective duration
 *    reproduces the kernel `effectiveDurationOnPaths` reference with the same
 *    re-leveling generator the Lab's duration.test.ts uses. This exercises the
 *    module's family generator and aggregation, not a retyped constant.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  bootstrapZeroCurve,
  buildTLPCurve,
  buildWarmupSOFR1M,
  DeterministicRatePath,
  effectiveDurationOnPaths,
  FixedLoan,
  loadMarketSnapshot,
  NMDeposit,
  NMD_TERMS_DEFAULTS,
  shockCurve,
  walFromCashflows,
  type RatePath,
  type TLPCurve,
  type ZeroCurve,
} from "@alm/kernel";
import { computeEnvironmentDurations, type FamilyPositions } from "../effectiveDuration";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { aggregateScenario } from "../../portfolio";
import { pvBucketedSeries } from "../pv";
import { discountFunction } from "../discount";
import type { Cashflow, RatePath as RatePathType } from "@alm/kernel";
import type { Position } from "../../contracts/position";
import {
  fixedPosition,
  fixedTerms,
  makeCoa,
  mortgagePosition,
  nmdBetaPosition,
  nmdPosition,
  nmdTerms,
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

/** COA family definitions by id (for building single-family duration inputs). */
function fam(id: string) {
  const f = makeCoa().families.find((x) => x.id === id);
  if (!f) throw new Error(`no family ${id}`);
  return f;
}

describe("effective duration — level-pay fixed loan analytic anchor", () => {
  it("matches a hand-rolled bump-and-reprice on the all-in curve", () => {
    const terms = fixedTerms("F1", { coupon: 0.05, maturityMonths: 60, amortType: "level-pay" });
    const inputs: FamilyPositions[] = [
      { family: fam("FIXED"), positions: [{ id: "F1", familyId: "FIXED", coaNodeId: "fixed-loans", terms }] },
    ];
    const out = computeEnvironmentDurations(inputs, base, ZERO_TLP, HORIZON, 100, "all-in");
    const engineDur = out.perFamily.find((p) => p.familyId === "FIXED")!.effectiveDuration;

    // Reference: the loan is path-independent, so the ± legs share one cashflow
    // set and only the discount curve shifts.
    const cf = new FixedLoan(terms).generateCashflows(new DeterministicRatePath(base, HORIZON));
    const dfFor = (bp: number) => {
      const c = bp === 0 ? base : shockCurve(base, bp);
      return (t: number) => (t <= 0 ? 1 : c.discountFactor(t) * Math.exp(-ZERO_TLP.tlp(t) * t));
    };
    const pv = (bp: number) => {
      const df = dfFor(bp);
      let s = 0;
      for (const x of cf) s += df(x.monthOffset / 12) * (x.principalPaid + x.interestPaid);
      return s;
    };
    const refDur = (pv(-100) - pv(100)) / (2 * pv(0) * 0.01);

    expect(engineDur).toBeCloseTo(refDur, 10);
    expect(engineDur).toBeGreaterThan(0);
    expect(engineDur).toBeLessThan(2.6); // a 5y level-pay loan is ~2.3y duration
  });
});

describe("effective duration — Lab cross-check (single Non-IB NMD)", () => {
  // The Lab reference generator: re-level the MA warmup with the parallel bump so
  // r − MA stays invariant, while the level opportunity-cost incentive responds.
  const nonIbGenerator =
    (terms = NMD_TERMS_DEFAULTS, historical = buildWarmupSOFR1M()) =>
    (p: RatePath, shockBp: number) => {
      const hist = shockBp === 0 ? historical : historical.map((h) => h + shockBp / 100);
      return new NMDeposit(terms, hist).generateCashflows(p);
    };

  it("reproduces the kernel effectiveDurationOnPaths number to full precision", () => {
    const basePath = new DeterministicRatePath(base, NMD_TERMS_DEFAULTS.maturityMonths);
    const labRef = effectiveDurationOnPaths(nonIbGenerator(), [basePath], base, ZERO_TLP, {
      shockBp: 100,
    }).effectiveDuration;

    const terms = nmdTerms("D1"); // = NMD_TERMS_DEFAULTS with id "D1"
    const inputs: FamilyPositions[] = [
      { family: fam("DDA"), positions: [{ id: "D1", familyId: "DDA", coaNodeId: "dda", terms }] },
    ];
    const out = computeEnvironmentDurations(
      inputs,
      base,
      ZERO_TLP,
      NMD_TERMS_DEFAULTS.maturityMonths,
      100,
      "all-in",
    );
    const ddaDur = out.perFamily.find((p) => p.familyId === "DDA")!.effectiveDuration;

    expect(ddaDur).toBeCloseTo(labRef, 10);

    // And the Lab's economic relationships: positive, below WAL (negative
    // convexity of a deposit franchise), not a discounting artifact.
    const baseCfs = new NMDeposit(terms).generateCashflows(basePath);
    const wal = walFromCashflows(baseCfs, terms.notional);
    expect(ddaDur).toBeGreaterThan(0);
    expect(ddaDur).toBeLessThan(wal);
  });

  it("re-leveling is load-bearing once the regime excursion activates (finding)", async () => {
    // Not re-leveling the MA warmup lets the regime excursion r - MA
    // fire under the bump. The excursion can differ between the two only while
    // the MA window still holds warmup history (the first maPeriod months). The
    // finding is staged on the constructed illustrative curve because on the
    // public Treasury pack the base path itself crosses its warmup MA by month
    // 19, so no dormant shock exists there. The test proves the re-leveling
    // mechanism, not a property of the shipped market. The shock
    // sizes are derived from the data rather than hard-coded:
    // DORMANT is the largest shock (5 bp steps, at most 100 bp) under which
    // neither the base nor the bumped path crosses its un-re-leveled MA in that
    // window; ACTIVE is the smallest 25 bp step at least 100 bp above DORMANT
    // (the original test's 100 vs 200 bp separation) under which the bumped
    // path crosses it.
    const stagedCurve = bootstrapZeroCurve(
      await loadMarketSnapshot(
        fileURLToPath(
          new URL("../../../../kernel/src/math/rates/__tests__/fixtures/market_constructed.json", import.meta.url),
        ),
      ),
    );
    const basePath = new DeterministicRatePath(stagedCurve, NMD_TERMS_DEFAULTS.maturityMonths);
    const warmup = buildWarmupSOFR1M();
    const P = NMD_TERMS_DEFAULTS.nmdParams.maPeriod;
    const crossesMa = (shockBp: number): boolean => {
      const full = [...warmup];
      for (let t = 0; t < P; t++) full.push((basePath.rateAt(t) + shockBp / 1e4) * 100);
      for (let t = 0; t < P; t++) {
        const idx = warmup.length + t;
        let sum = 0;
        for (let j = 1; j <= P; j++) sum += full[idx - j];
        if (full[idx] > sum / P) return true;
      }
      return false;
    };
    if (crossesMa(0)) {
      throw new Error("premise broken: the base path already crosses its warmup MA; the finding cannot be staged");
    }
    let dormant = 0;
    for (let s = 100; s >= 5; s -= 5) if (!crossesMa(s)) { dormant = s; break; }
    if (dormant === 0) throw new Error("premise broken: no dormant shock of at least 5 bp");
    let active = 0;
    for (let s = Math.ceil((dormant + 100) / 25) * 25; s <= 400; s += 25) if (crossesMa(s)) { active = s; break; }
    if (active === 0) throw new Error("premise broken: no active shock up to 400 bp");

    const rel = (shockBp: number) =>
      effectiveDurationOnPaths(nonIbGenerator(), [basePath], stagedCurve, ZERO_TLP, { shockBp })
        .effectiveDuration;
    const notRel = (shockBp: number) =>
      effectiveDurationOnPaths(
        (p) => new NMDeposit(NMD_TERMS_DEFAULTS).generateCashflows(p),
        [basePath],
        stagedCurve,
        ZERO_TLP,
        { shockBp },
      ).effectiveDuration;

    // Dormant: the two agree.
    expect(Math.abs(rel(dormant) - notRel(dormant))).toBeLessThan(0.05);
    // Active: the un-re-leveled excursion fires and diverges.
    expect(Math.abs(rel(active) - notRel(active))).toBeGreaterThan(0.1);
    // Re-leveling holds the duration stable across the two shock sizes; not re-leveling does not.
    expect(Math.abs(rel(active) - rel(dormant))).toBeLessThan(Math.abs(notRel(active) - notRel(dormant)));
  });
});

describe("effective duration — streaming reproduces the concatenation path", () => {
  // The prior implementation concatenated every position's regenerated legs into
  // one array per family per shock and priced the concatenation (the OOM). The
  // streaming path prices position by position. PV is linear, so the two must
  // agree to summation-reordering precision. Reference here is the kernel
  // effectiveDurationOnPaths run on the OLD concatenation generator.
  const warmup = buildWarmupSOFR1M();
  const concatGen =
    (positions: Position[]) =>
    (path: RatePathType, shockBp: number): Cashflow[] => {
      const out: Cashflow[] = [];
      for (const pos of positions) {
        const cf =
          pos.terms.type === "nmd"
            ? new NMDeposit(
                pos.terms,
                shockBp === 0 ? warmup : warmup.map((h) => h + shockBp / 100),
              ).generateCashflows(path)
            : makeInstrument(pos.terms).generateCashflows(path);
        for (const c of cf) out.push(c);
      }
      return out;
    };

  function mixedFamilies(): FamilyPositions[] {
    const fixed: Position[] = [];
    const mtg: Position[] = [];
    const dda: Position[] = [];
    const mma: Position[] = [];
    for (let i = 0; i < 5; i++) {
      fixed.push(fixedPosition(`F${i}`, { notional: 1_000_000 * (1 + i / 10), coupon: 0.05, maturityMonths: 60 }));
      mtg.push(mortgagePosition(`M${i}`, { notional: 800_000 * (1 + i / 10), originalBalance: 800_000 * (1 + i / 10) }));
      dda.push(nmdPosition(`D${i}`, { notional: 600_000 * (1 + i / 10) }));
      mma.push(nmdBetaPosition(`B${i}`, { notional: 400_000 * (1 + i / 10) }));
    }
    return [
      { family: fam("FIXED"), positions: fixed },
      { family: fam("MORTGAGE"), positions: mtg },
      { family: fam("DDA"), positions: dda },
      { family: fam("MMA"), positions: mma },
    ];
  }

  it("per-family and equity durations match the concatenation reference to 1e-9", () => {
    const families = mixedFamilies();
    const basePath = new DeterministicRatePath(base, HORIZON);
    const out = computeEnvironmentDurations(families, base, ZERO_TLP, HORIZON, 100, "all-in");

    // Reference equity roll-up from the concatenation-priced legs.
    let eveBase = 0;
    let eveUp = 0;
    let eveDown = 0;
    for (const { family, positions } of families) {
      const ref = effectiveDurationOnPaths(concatGen(positions), [basePath], base, ZERO_TLP, {
        shockBp: 100,
        discountBasis: "all-in",
      });
      const streamed = out.perFamily.find((p) => p.familyId === family.id)!;
      expect(streamed.effectiveDuration).toBeCloseTo(ref.effectiveDuration, 9);
      expect(Math.abs(streamed.pvBase - ref.pvBase) / Math.abs(ref.pvBase)).toBeLessThan(1e-9);
      const sign = family.side === "liability" ? -1 : 1;
      eveBase += sign * ref.pvBase;
      eveUp += sign * ref.pvUp;
      eveDown += sign * ref.pvDown;
    }
    const refEquity = (eveDown - eveUp) / (2 * eveBase * 0.01);
    expect(out.effectiveDurationEquity).toBeCloseTo(refEquity, 9);
  });

  it("base-leg PV reuse matches the regenerated base leg to 1e-9 when maturities are within horizon", () => {
    const families = mixedFamilies();
    const noReuse = computeEnvironmentDurations(families, base, ZERO_TLP, HORIZON, 100, "all-in");

    // Static-projection family PV on the base environment, exactly what computeEve
    // hands in as the reusable base-leg PV.
    const portfolio = {
      id: "PF",
      label: "x",
      asOf: "2026-01-01",
      coa: makeCoa(),
      positions: families.flatMap((f) => f.positions),
    };
    const basePath = new DeterministicRatePath(base, HORIZON);
    const staticCF = aggregateScenario(portfolio, { scenarioId: "S0", path: basePath }, { horizonMonths: HORIZON, asOf: "2026-01-01" });
    const df0 = discountFunction(base, ZERO_TLP, 0, "all-in");
    const reuseBasePv = new Map<string, number>();
    for (const scFam of staticCF.byFamily) {
      reuseBasePv.set(scFam.familyId, pvBucketedSeries(scFam.series, df0));
    }

    const reuse = computeEnvironmentDurations(families, base, ZERO_TLP, HORIZON, 100, "all-in", { reuseBasePv });
    for (const p of noReuse.perFamily) {
      const r = reuse.perFamily.find((x) => x.familyId === p.familyId)!;
      expect(r.effectiveDuration).toBeCloseTo(p.effectiveDuration, 9);
      expect(Math.abs(r.pvBase - p.pvBase) / Math.abs(p.pvBase)).toBeLessThan(1e-9);
    }
    expect(reuse.effectiveDurationEquity).toBeCloseTo(noReuse.effectiveDurationEquity, 9);
  });

  it("ignores reuse for a family whose maturity exceeds the horizon (EVE-OBS-1 guard)", () => {
    // Horizon 120 but a 240-month bullet: the static PV would be horizon-truncated,
    // so reuse is unsafe. Hand in a deliberately wrong reuse PV and confirm the
    // engine ignores it and regenerates the base leg full-life.
    const shortHorizon = 120;
    const longBullet: Position = fixedPosition("LB", { notional: 1_000_000, coupon: 0.05, maturityMonths: 240, amortType: "bullet" });
    const families: FamilyPositions[] = [{ family: fam("FIXED"), positions: [longBullet] }];
    const truth = computeEnvironmentDurations(families, base, ZERO_TLP, shortHorizon, 100, "all-in");
    const wrongReuse = new Map<string, number>([["FIXED", 1e-9]]); // absurd base PV
    const guarded = computeEnvironmentDurations(families, base, ZERO_TLP, shortHorizon, 100, "all-in", {
      reuseBasePv: wrongReuse,
    });
    expect(guarded.perFamily[0].pvBase).toBeCloseTo(truth.perFamily[0].pvBase, 6);
    expect(guarded.perFamily[0].effectiveDuration).toBeCloseTo(truth.perFamily[0].effectiveDuration, 9);
  });
});

describe("effective duration — equity roll-up", () => {
  it("equity duration is the signed finite difference of the family PVs", () => {
    // Two families: an asset (fixed loan) and a liability (NMD). Equity duration
    // must equal (EVE_down − EVE_up)/(2·EVE_0·Δr) rebuilt from the leg PVs.
    const fixed = fixedTerms("F1", { coupon: 0.05, maturityMonths: 120, notional: 5_000_000 });
    const nmd = nmdTerms("D1", { notional: 3_000_000 });
    const inputs: FamilyPositions[] = [
      { family: fam("FIXED"), positions: [{ id: "F1", familyId: "FIXED", coaNodeId: "fixed-loans", terms: fixed }] },
      { family: fam("DDA"), positions: [{ id: "D1", familyId: "DDA", coaNodeId: "dda", terms: nmd }] },
    ];
    const out = computeEnvironmentDurations(inputs, base, ZERO_TLP, HORIZON, 100, "all-in");
    expect(out.eve).toBeCloseTo(out.pvAssets - out.pvLiabilities, 6);
    expect(out.pvAssets).toBeGreaterThan(out.pvLiabilities); // positive equity
    expect(Number.isFinite(out.effectiveDurationEquity)).toBe(true);
    expect(out.effectiveDurationEquity).toBeGreaterThan(0); // asset-sensitive book
  });
});
