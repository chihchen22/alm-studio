// packages/engine/src/run/__tests__/housingCashflowHeadline.test.ts
/**
 * A4 (C8): the cash-flow headline on synthetic-2500-v1.
 * Prepaid principal per family and coupon bucket over months 25 to 36 is a
 * conformance check against the Section 3 formula restated here; the
 * mapped-over-unmapped ratio is printed, not asserted. Family WAL extends under
 * hpi-down-30 and shortens under hpi-up-15. Monitoring trigger (Section 13):
 * a market or seed refresh; a failing WAL direction is a spec claim, reported
 * with the measured WALs, never re-pinned without a recorded hand check.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { FourFactorCPR, Mortgage, type MarketSnapshot, type MortgageTerms, type PrepayContext, type RatePath } from "@alm/kernel";
import { HousingMortgage } from "../../macro/housingMortgage";
import { buildBaseCurve, buildRatePath } from "../../scenario/rateEnvironment";
import { H, housingSet, macroMarket, ramp, runOn, syntheticBook } from "./macroFixtures";

let market: MarketSnapshot; let path: RatePath;
beforeAll(async () => { market = await macroMarket(); path = buildRatePath(buildBaseCurve(market), 360); }, 120_000);
const bucketOf = (rPct: number) => (rPct < 5 ? "lt5" : rPct < 6 ? "5to6" : rPct < 6.5 ? "6to6.5" : "ge6.5");
// CPR* restated from Section 3 (same restatement as housingMortgage.test.ts; restated here, not imported).
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
/** Prepaid principal, months 25 to 36: principalPaid less the annuity scheduled principal on the realized balance. */
function prepaid25to36(rows: ReturnType<Mortgage["generateCashflows"]>, t: MortgageTerms): number {
  const i = t.noteRate / 12, n = t.maturityMonths;
  let s = 0;
  for (const r of rows) {
    const m = r.monthOffset; if (m < 25 || m > 36 || m === n) continue;
    const rem = n - m + 1, sp = i > 1e-12 ? r.balance * (i / (Math.pow(1 + i, rem) - 1)) : r.balance / rem;
    s += r.principalPaid - sp;
  }
  return s;
}

describe("A4 prepaid principal per family and coupon bucket, months 25 to 36 (a conformance check)", () => {
  it("equals the restated formula to 1e-9 relative", () => {
    expect(H).toEqual({ asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 });
    const hpi = ramp(0.7);
    const got = new Map<string, number>(), want = new Map<string, number>(), base = new Map<string, number>();
    const fam = new Map<string, { mapped: number; base: number; up: number }>();
    const up = ramp(1.15);
    for (const pos of syntheticBook().positions.filter((x) => x.terms.type === "mortgage")) {
      const t = pos.terms as MortgageTerms, key = `${pos.familyId}:${bucketOf(t.noteRate * 100)}`, i = t.noteRate / 12, n = t.maturityMonths;
      const rows = new HousingMortgage(t, H, hpi).generateCashflows(path), cpr = cprStar(t, hpi);
      for (const r of rows) {
        const m = r.monthOffset; if (m < 25 || m > 36 || m === n) continue;
        const rem = n - m + 1, sp = i > 1e-12 ? r.balance * (i / (Math.pow(1 + i, rem) - 1)) : r.balance / rem;
        got.set(key, (got.get(key) ?? 0) + (r.principalPaid - sp));
        want.set(key, (want.get(key) ?? 0) + Math.max(0, r.balance - sp) * (1 - Math.pow(1 - cpr[m - 1]!, 1 / 12)));
      }
      const unmapped = prepaid25to36(new Mortgage(t).generateCashflows(path), t);
      base.set(key, (base.get(key) ?? 0) + unmapped);
      const f = fam.get(pos.familyId) ?? { mapped: 0, base: 0, up: 0 };
      f.mapped += prepaid25to36(rows, t); f.base += unmapped; f.up += prepaid25to36(new HousingMortgage(t, H, up).generateCashflows(path), t);
      fam.set(pos.familyId, f);
    }
    expect(want.size).toBe(8);  // power: the two families times the four coupon buckets
    for (const [k, v] of want) expect(Math.abs(got.get(k)! - v), k).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(v)));
    for (const [k, v] of [...got].sort()) console.info(`A4 ratio ${k} hpi-down-30 over unmapped`, v / base.get(k)!);
    for (const [k, f] of fam) console.info(`A4 family ${k} months 25-36 prepaid ratio hpi-down-30`, f.mapped / f.base, "hpi-up-15", f.up / f.base);
  });
  it("family WAL extends under hpi-down-30 and shortens under hpi-up-15 (monitoring trigger: market or seed refresh)", () => {
    const wal = (r: ReturnType<typeof runOn>, f: string) => r.cashflows.byScenario.find((s) => s.scenarioId === "S0")!.byFamily.find((x) => x.familyId === f)!.walYears!;
    const base = runOn(market, housingSet("u", null)), down = runOn(market, housingSet("d", "hpi-down-30")), up = runOn(market, housingSet("p", "hpi-up-15"));
    for (const f of ["mortgages", "mbs"]) {
      console.info(`A4 WAL ${f} unmapped`, wal(base, f), "hpi-down-30", wal(down, f), "hpi-up-15", wal(up, f));
      expect(wal(down, f)).toBeGreaterThan(wal(base, f));
      expect(wal(up, f)).toBeLessThan(wal(base, f));
    }
  }, 600_000);
});
