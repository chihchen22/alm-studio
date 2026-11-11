/**
 * W3-A2b integration anchors: the cd arm of the instrument factory.
 *
 * W2-A2 proved the adapter standalone; these tests prove the WIRING — the
 * same anchors re-run THROUGH `makeInstrument`, which is the seam every run
 * consumer (static pass, duration engine, FTP, gap fold) constructs from.
 *
 * Anchor 1 (kernel identity through the factory): the factory-built cd
 * instrument's stream is BIT-identical to a direct kernel `cdCashflows` call
 * on the same cohort book.
 *
 * Anchor 2 (zero-hazard degeneracy through the factory): with the hazard
 * forced exactly to zero via the factory's `options.cd.params` seam, the
 * factory-built instrument reproduces the fixed bullet (aggregated
 * kernel `FixedLoan` streams per cohort) to 1e-12 relative — the ADR-020
 * precondition, re-verified at the integration seam.
 *
 * Anchor 3 (scenario seam): `options.cd.shockBp` is honored (bit-identity
 * with a directly constructed adapter) and moves early withdrawal in the
 * calibrated direction (+shock => depositors further below market => more
 * early withdrawal). The RATE PATH is deliberately NOT read (disclosed v0
 * semantics): the stream under a +200bp ParallelShockPath is
 * bit-identical to the base-path stream, asserted here so the disclosed
 * limitation is pinned by a test rather than implied by silence.
 *
 * Refusal cases: malformed cd terms refuse typed at construction through the
 * factory; the run-pipeline seasoning gate accepts cd terms at offset 0.
 */
import { describe, expect, it } from "vitest";
import {
  cdCashflows,
  DeterministicRatePath,
  FixedLoan,
  ParallelShockPath,
  bootstrapZeroCurve,
  loadMarketSnapshot,
  type Cashflow,
  type CdBookRow,
} from "@alm/kernel";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CdAdapterError, cdMaturityMonths, type CdCohortSpec, type CdTerms } from "../../cd/terms";
import { CdBookInstrument } from "../../cd/cdInstrument";
import { resolveCdParams, zeroHazardParams } from "../../cd/params";
import { assertRunPipelineUnseasoned } from "../../portfolio/seasoning";
import { makeInstrument } from "../instrumentFactory";

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKET_PATH = resolve(
  HERE,
  "../../../../../packages/kernel/public/market_public.json",
);

/** Hand-set illustrative cohort book (stylized units summing 100). */
const BOOK: readonly CdCohortSpec[] = [
  { termMonths: 6, monthsToMaturity: 3, balance: 20, contractRate: 0.03 },
  { termMonths: 12, monthsToMaturity: 6, balance: 25, contractRate: 0.032 },
  { termMonths: 12, monthsToMaturity: 12, balance: 15, contractRate: 0.041 },
  { termMonths: 24, monthsToMaturity: 12, balance: 20, contractRate: 0.035 },
  { termMonths: 36, monthsToMaturity: 24, balance: 12, contractRate: 0.038 },
  { termMonths: 60, monthsToMaturity: 48, balance: 8, contractRate: 0.042 },
];

const NOTIONAL = 1_000_000;

function mkTerms(cohorts: readonly CdCohortSpec[] = BOOK, notional = NOTIONAL): CdTerms {
  return {
    id: "cd-factory-test",
    type: "cd",
    label: "CD factory test book",
    notional,
    maturityMonths: cdMaturityMonths(cohorts),
    originationOffsetMonths: 0,
    amortType: "bullet",
    side: "liability",
    cohorts,
  };
}

function toKernelRows(cohorts: readonly CdCohortSpec[]): CdBookRow[] {
  return cohorts.map((c) => ({
    termMonths: c.termMonths,
    monthsToMaturity: c.monthsToMaturity,
    balance: c.balance,
    contractRate: c.contractRate,
  }));
}

/** |a-b| relative to max(1, |a|, |b|). */
function relDiff(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
}

function maxStreamRelDiff(a: Cashflow[], b: Cashflow[]): number {
  expect(a.length).toBe(b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    expect(a[i].monthOffset).toBe(b[i].monthOffset);
    worst = Math.max(
      worst,
      relDiff(a[i].balance, b[i].balance),
      relDiff(a[i].principalPaid, b[i].principalPaid),
      relDiff(a[i].interestPaid, b[i].interestPaid),
      relDiff(a[i].couponRate, b[i].couponRate),
    );
  }
  return worst;
}

async function realPath(nSteps = 360): Promise<DeterministicRatePath> {
  const snapshot = await loadMarketSnapshot(MARKET_PATH);
  return new DeterministicRatePath(bootstrapZeroCurve(snapshot), nSteps);
}

describe("makeInstrument cd arm — kernel identity (anchor 1)", () => {
  it("factory stream is bit-identical to a direct kernel cdCashflows call", async () => {
    const path = await realPath();
    const inst = makeInstrument(mkTerms());
    const got = inst.generateCashflows(path);
    const want = cdCashflows(NOTIONAL, { renewals: false }, resolveCdParams(), toKernelRows(BOOK));
    expect(got.length).toBe(want.length);
    for (let i = 0; i < got.length; i++) {
      expect(Object.is(got[i].monthOffset, want[i].monthOffset)).toBe(true);
      expect(Object.is(got[i].balance, want[i].balance)).toBe(true);
      expect(Object.is(got[i].principalPaid, want[i].principalPaid)).toBe(true);
      expect(Object.is(got[i].interestPaid, want[i].interestPaid)).toBe(true);
      expect(Object.is(got[i].couponRate, want[i].couponRate)).toBe(true);
    }
  });

  it("terms round-trip and the repricing schedule is empty (fixed to contractual maturity)", () => {
    const terms = mkTerms();
    const inst = makeInstrument(terms);
    expect(inst.terms).toBe(terms);
    expect(inst.repricingSchedule()).toEqual([]);
  });
});

describe("makeInstrument cd arm — zero-hazard degeneracy (anchor 2, precondition)", () => {
  it("zero hazard through options.cd.params reproduces the bullet book to 1e-12", async () => {
    const path = await realPath();
    const inst = makeInstrument(mkTerms(), { cd: { params: zeroHazardParams() } });
    const got = inst.generateCashflows(path);

    // Comparator built independently from kernel FixedLoan bullets, one per
    // cohort, aggregated on the month grid — the representation the
    // adapter replaces. unitScale mirrors cdCashflows: notional over the
    // stylized book total.
    let bookTotal = 0;
    for (const c of BOOK) bookTotal += c.balance;
    const unitScale = NOTIONAL / bookTotal;
    const horizon = cdMaturityMonths(BOOK);
    const balance = new Float64Array(horizon + 1);
    const principal = new Float64Array(horizon + 1);
    const interest = new Float64Array(horizon + 1);
    for (const c of BOOK) {
      const loan = new FixedLoan({
        id: `bullet-${c.termMonths}-${c.monthsToMaturity}`,
        type: "fixed-loan",
        notional: c.balance * unitScale,
        maturityMonths: c.monthsToMaturity,
        originationOffsetMonths: 0,
        amortType: "bullet",
        side: "liability",
        coupon: c.contractRate,
      });
      for (const cf of loan.generateCashflows(path)) {
        balance[cf.monthOffset] += cf.balance;
        principal[cf.monthOffset] += cf.principalPaid;
        interest[cf.monthOffset] += cf.interestPaid;
      }
    }

    expect(got.length).toBe(horizon);
    let worst = 0;
    for (const row of got) {
      worst = Math.max(
        worst,
        relDiff(row.balance, balance[row.monthOffset]),
        relDiff(row.principalPaid, principal[row.monthOffset]),
        relDiff(row.interestPaid, interest[row.monthOffset]),
      );
    }
    expect(worst).toBeLessThanOrEqual(1e-12);
    // Pre-maturity months pay exactly zero principal under zero hazard.
    const maturities = new Set(BOOK.map((c) => c.monthsToMaturity));
    for (const row of got) {
      if (!maturities.has(row.monthOffset)) expect(row.principalPaid).toBe(0);
    }
  });
});

describe("makeInstrument cd arm — scenario seam and v0 path semantics (anchor 3)", () => {
  it("options.cd.shockBp is honored bit-exactly and raises early withdrawal when positive", async () => {
    const path = await realPath();
    const terms = mkTerms();
    const viaFactory = makeInstrument(terms, { cd: { shockBp: 100 } }).generateCashflows(path);
    const direct = new CdBookInstrument(terms, { shockBp: 100 }).generateCashflows(path);
    expect(maxStreamRelDiff(viaFactory, direct)).toBe(0);

    // Directional: +100bp puts depositors further below market, so month-1
    // early withdrawal (principal before any maturity month) must rise vs base.
    const base = makeInstrument(terms).generateCashflows(path);
    expect(viaFactory[0].principalPaid).toBeGreaterThan(base[0].principalPaid);
  });

  it("the rate path is NOT read: a +200bp ParallelShockPath leaves the stream bit-identical (disclosed v0)", async () => {
    const basePath = await realPath();
    const shocked = new ParallelShockPath(basePath, 200);
    const terms = mkTerms();
    const a = makeInstrument(terms).generateCashflows(basePath);
    const b = makeInstrument(terms).generateCashflows(shocked);
    expect(maxStreamRelDiff(a, b)).toBe(0);
  });
});

describe("makeInstrument cd arm — refusals and gates", () => {
  it("malformed cd terms refuse typed at construction (mtm exceeds original term)", () => {
    const bad = mkTerms([{ termMonths: 12, monthsToMaturity: 24, balance: 10, contractRate: 0.03 }]);
    let threw: unknown;
    try {
      makeInstrument({ ...bad, maturityMonths: 24 });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(CdAdapterError);
    expect((threw as CdAdapterError).code).toBe("cd-terms-mtm");
  });

  it("the run-pipeline seasoning gate accepts cd terms at offset 0 and refuses nonzero", () => {
    expect(() => assertRunPipelineUnseasoned("cd-pos", mkTerms())).not.toThrow();
    expect(() =>
      assertRunPipelineUnseasoned("cd-pos", { ...mkTerms(), originationOffsetMonths: -6 }),
    ).toThrow(/cannot be applied to a CD cohort; only a fixed-loan can be seasoned/);
  });
});
