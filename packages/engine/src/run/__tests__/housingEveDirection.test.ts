// packages/engine/src/run/__tests__/housingEveDirection.test.ts
// Monitoring trigger (Section 13): market or seed refresh; re-pin only with a recorded hand check.
/**
 * A5 (C7, F4). Per coupon bucket, the sign of the EVE change
 * under the mapping agrees with the sign of the directional finite difference
 * along the mapping, K + lambda (CPR* - K) with lambda = 0.001, both restated
 * here; a bucket is asserted only where that difference clears THRESHOLD
 * relative to the bucket's unmapped PV, and a near-zero bucket is reported. At
 * least one bucket of each sign must be asserted, so the discount-coupon cohorts
 * (negative) are tested beside the premium ones (positive). The engine is tied
 * in: each family's sum over its buckets of the restated EVE change equals the
 * run's family EVE delta to 1e-9 relative. Family EVE deltas (hpi-down-30
 * against unmapped, base scenario) are pinned in golden/housing-eve.json with a
 * tolerance and no sign claim.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { FourFactorCPR, amortizeMortgage, type MarketSnapshot, type MortgageTerms, type PrepayContext, type RatePath } from "@alm/kernel";
import { discountFunction } from "../../eve/discount";
import { tlpFromSnapshot } from "../stages/curve";
import { buildBaseCurve, buildRatePath } from "../../scenario/rateEnvironment";
import { housingSet, macroMarket, ramp, runOn, syntheticBook } from "./macroFixtures";

// THRESHOLD is roundoff, not signal: the restated bucket sums and the run's family deltas disagree by about
// 1.7e-12 relative (measured, mbs; 3.8e-13 on mortgages), while the smallest bucket finite difference is about
// 2e-7 relative (mortgages 5.0 to 6.0). 1e-10 sits two orders above the noise and three below the smallest signal.
const LAMBDA = 0.001, THRESHOLD = 1e-10, TIE = 1e-9;
let market: MarketSnapshot; let path: RatePath; let df: (t: number) => number;
beforeAll(async () => { market = await macroMarket(); const c = buildBaseCurve(market); path = buildRatePath(c, 360);
  df = discountFunction(c, tlpFromSnapshot({ marketSnapshot: market } as never), 0, "all-in"); }, 120_000);
const bucketOf = (rPct: number) => (rPct < 5 ? "lt5" : rPct < 6 ? "5to6" : rPct < 6.5 ? "6to6.5" : "ge6.5");
// CPR* restated from Section 3 (copied from housingCashflowHeadline.test.ts; restated here, not imported).
// The seven parameters are the record's: L0 0.70, L_R 0.97, k_R 20, L_T 1.00, k_T 10, f_T 0.75, c_min 1.5 percent CPR.
function cprStar(t: MortgageTerms, hpi: number[]): number[] {
  const p = { ...t.cprParams, wac: t.noteRate * 100 }, sp = (p.secSpread + p.primSpread) / 1e4;
  const ctx: PrepayContext = { term: t.maturityMonths, age: t.ageMonths, noteRate: t.noteRate, mortgageRateAt: (m) => path.forwardRateAt(m - 1, 10) + sp };
  const K = new FourFactorCPR(p).cprSchedule(ctx), T = new FourFactorCPR({ ...p, maxCpr: p.minCpr }).cprSchedule(ctx);
  const n = t.maturityMonths, i = t.noteRate / 12, SR = (L: number) => 1 / (1 + Math.exp(20 * (L - 0.97))), ST = (L: number) => 0.75 + 0.25 / (1 + Math.exp(10 * (L - 1)));
  return Array.from({ length: n }, (_, k) => {
    const b = i > 1e-12 ? (Math.pow(1 + i, n) - Math.pow(1 + i, k)) / (Math.pow(1 + i, n) - 1) : 1 - k / n;
    const lb = 0.7 * b, L = lb / hpi[Math.min(k, hpi.length - 1)]!, MR = SR(L) / SR(lb), MT = ST(L) / ST(lb);
    return MR === 1 && MT === 1 ? K[k]! : Math.min(1, (K[k]! - T[k]!) * MR + Math.max(T[k]! * MT, Math.min(T[k]!, 0.015)));
  });
}
const pv = (t: MortgageTerms, cpr: ArrayLike<number>) => amortizeMortgage({ notional: t.notional, noteRate: t.noteRate, term: t.maturityMonths, cprSchedule: cpr })
  .reduce((s, r) => s + df(r.monthOffset / 12) * (r.principalPaid + r.interestPaid), 0);

/** Per family and coupon bucket: the restated PV under K, under CPR*, and along K + lambda (CPR* - K). Built once. */
let bucketsMemo: Map<string, { k: number; star: number; lam: number }> | null = null;
function buckets(): Map<string, { k: number; star: number; lam: number }> {
  if (bucketsMemo !== null) return bucketsMemo;
  const hpi = ramp(0.7), acc = new Map<string, { k: number; star: number; lam: number }>();
    for (const pos of syntheticBook().positions.filter((x) => x.terms.type === "mortgage")) {
      const t = pos.terms as MortgageTerms;
      const p = { ...t.cprParams, wac: t.noteRate * 100 }, sp = (p.secSpread + p.primSpread) / 1e4;
      const ctx: PrepayContext = { term: t.maturityMonths, age: t.ageMonths, noteRate: t.noteRate, mortgageRateAt: (m) => path.forwardRateAt(m - 1, 10) + sp };
      const K = new FourFactorCPR(p).cprSchedule(ctx), S = cprStar(t, hpi), Lm = Array.from(K, (k, j) => k + LAMBDA * (S[j]! - k));
      const key = `${pos.familyId}:${bucketOf(t.noteRate * 100)}`, a = acc.get(key) ?? { k: 0, star: 0, lam: 0 };
      a.k += pv(t, K); a.star += pv(t, S); a.lam += pv(t, Lm); acc.set(key, a);
  }
  bucketsMemo = acc;
  return acc;
}

describe("A5 directional finite difference along the mapping", () => {
  it("each bucket's EVE change has the sign of K + lambda (CPR* - K), where the difference clears the threshold", () => {
    const acc = buckets();
    const asserted = { pos: 0, neg: 0 };
    for (const [key, a] of [...acc].sort()) {
      console.info(`A5 ${key} EVE change ${a.star - a.k} finite difference ${a.lam - a.k} relative ${(a.lam - a.k) / Math.abs(a.k)}`);
      if (Math.abs(a.lam - a.k) <= THRESHOLD * Math.abs(a.k)) { console.info(`A5 near-zero ${key}`); continue; }
      expect(Math.sign(a.star - a.k), key).toBe(Math.sign(a.lam - a.k));
      if (a.lam > a.k) asserted.pos++; else asserted.neg++;
    }
    console.info("A5 buckets asserted", asserted, "of", acc.size);
    // Power: the two families times the four coupon buckets, and at least one asserted bucket of each sign.
    expect(acc.size).toBe(8);
    expect(asserted.pos, "positive-sign buckets asserted").toBeGreaterThan(0);
    expect(asserted.neg, "negative-sign buckets asserted").toBeGreaterThan(0);
  });
  it("family EVE deltas match the golden at 1e-6 relative, no sign asserted", () => {
    // Golden/housing-eve.json re-pinned on curve default 2 (mortgages 667790.6944314241 to 555080.7498794794, mbs
    // 1156048.2392528057 to 779507.7343945503). Hand check of record: the restated bucket sum below ties each delta to
    // 1e-9, and the same market with the curveDefault: 1 marker reproduces the old values to the last digit. Deltas Step 1.
    const g = JSON.parse(readFileSync(fileURLToPath(new URL("./golden/housing-eve.json", import.meta.url)), "utf8")) as { tolerance: number; mortgages: number; mbs: number };
    const fam = (r: ReturnType<typeof runOn>, f: string) => r.eve.byScenario.find((s) => s.scenarioId === "S0")!.byFamily.find((x) => x.familyId === f)!.pv;
    const u = runOn(market, housingSet("u", null)), d = runOn(market, housingSet("d", "hpi-down-30")), p = runOn(market, housingSet("p", "hpi-up-15"));
    for (const f of ["mortgages", "mbs"] as const) {
      console.info(`A5 family EVE ${f} unmapped ${fam(u, f)} delta hpi-down-30 ${fam(d, f) - fam(u, f)} delta hpi-up-15 ${fam(p, f) - fam(u, f)}`);
    }
    for (const f of ["mortgages", "mbs"] as const) {
      const delta = fam(d, f) - fam(u, f);
      expect(Math.abs(delta - g[f]), f).toBeLessThanOrEqual(g.tolerance * Math.abs(g[f]));
      // The engine tie: the run's family delta equals the sum of the family's restated bucket EVE changes.
      const restated = [...buckets()].filter(([key]) => key.startsWith(`${f}:`)).reduce((s, [, a]) => s + (a.star - a.k), 0);
      expect(Math.abs(delta - restated), `${f} run delta against the restated bucket sum`).toBeLessThanOrEqual(TIE * Math.abs(restated));
    }
  }, 600_000);
});
