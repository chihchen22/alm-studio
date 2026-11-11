/**
 * W2-A2 acceptance anchors for the CD competing-risk adapter.
 *
 * Anchor 1 (kernel identity): at shockBp = 0 the adapter's cashflow stream is
 * BIT-identical to a direct kernel `cdCashflows` call on the same cohort book
 * (the adapter mirrors the row construction operation-for-operation).
 *
 * Anchor 2 (zero-hazard degeneracy): with the early-withdrawal hazard exactly
 * zero and renewals off, the adapter reproduces the fixed-rate bullet
 * (kernel `FixedLoan`, amortType "bullet") to 1e-12 relative, per field, per
 * month — the anchor that proves the wiring moved nothing it did not intend.
 *
 * Anchor 3 (directional): versus the zero-hazard bullet, the calibrated
 * hazard SHORTENS effective duration (both +/-100 and +/-200 pairs) and
 * FRONT-LOADS liquidity (cumulative principal dominance, shorter run-off
 * WAL). Directional only; the Lab's CD pins are plausibility bounds, not
 * oracles, and no expected value below is imported from them.
 *
 * Cross-checks: analytics derived from the adapter stream reconcile with the
 * kernel's own runoffEve / prepayWal / liquidityProfile on the same book.
 *
 * The cohort book here is hand-set illustrative (stylized units, terms from
 * the kernel's structural term-bucket map, rates near the vendored curve).
 */
import { describe, expect, it } from "vitest";
import {
  CD_DEFAULT_PARAMS,
  cdCashflows,
  discountFactor,
  effDuration,
  FixedLoan,
  hazardCore,
  liquidityProfile,
  prepayWal,
  runoffEve,
  type Cashflow,
  type CdBookRow,
  type CdModelParams,
  type RatePath,
} from "@alm/kernel";
import { CdBookInstrument } from "../cdInstrument";
import { resolveCdParams, zeroHazardParams } from "../params";
import { CdAdapterError, cdMaturityMonths, type CdCohortSpec, type CdTerms } from "../terms";

const NO_PATH = {} as RatePath; // the adapter does not read the path (module doc)

/** Hand-set illustrative cohort book, stylized units summing to 100. */
const BOOK: readonly CdCohortSpec[] = [
  { termMonths: 6, monthsToMaturity: 3, balance: 20, contractRate: 0.03 },
  { termMonths: 12, monthsToMaturity: 6, balance: 25, contractRate: 0.032 },
  { termMonths: 12, monthsToMaturity: 12, balance: 15, contractRate: 0.041 },
  { termMonths: 24, monthsToMaturity: 12, balance: 20, contractRate: 0.035 },
  { termMonths: 36, monthsToMaturity: 24, balance: 12, contractRate: 0.038 },
  { termMonths: 60, monthsToMaturity: 48, balance: 8, contractRate: 0.042 },
];

function mkTerms(cohorts: readonly CdCohortSpec[], notional = 1_000_000): CdTerms {
  return {
    id: "cd-test",
    type: "cd",
    label: "CD test book",
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

/** Max relative deviation across two streams, all five fields. */
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

function walMonthsOf(stream: Cashflow[]): number {
  let num = 0;
  let tot = 0;
  for (const r of stream) {
    num += r.monthOffset * r.principalPaid;
    tot += r.principalPaid;
  }
  return num / tot;
}

function pvOf(stream: Cashflow[], shockBp: number, params: CdModelParams): number {
  let pv = 0;
  for (const r of stream) {
    pv += (r.principalPaid + r.interestPaid) * discountFactor(r.monthOffset / 12, shockBp, params);
  }
  return pv;
}

const SHOCKS = [-200, -100, 0, 100, 200] as const;

function pvByShock(
  cohorts: readonly CdCohortSpec[],
  params: CdModelParams,
): Record<number, number> {
  const out: Record<number, number> = {};
  for (const s of SHOCKS) {
    const inst = new CdBookInstrument(mkTerms(cohorts), { shockBp: s, params });
    out[s] = pvOf(inst.generateCashflows(NO_PATH), s, params);
  }
  return out;
}

describe("anchor 1: kernel identity (adapter stream === direct cdCashflows call)", () => {
  it("run-off view is bit-identical to cdCashflows(renewals: false)", () => {
    const terms = mkTerms(BOOK);
    const adapter = new CdBookInstrument(terms); // defaults: renewals false, shock 0
    const got = adapter.generateCashflows(NO_PATH);
    const want = cdCashflows(
      terms.notional,
      { renewals: false },
      CD_DEFAULT_PARAMS,
      toKernelRows(BOOK),
    );
    expect(got.length).toBe(want.length);
    for (let i = 0; i < got.length; i++) {
      expect(got[i].monthOffset).toBe(want[i].monthOffset);
      expect(got[i].balance).toBe(want[i].balance);
      expect(got[i].principalPaid).toBe(want[i].principalPaid);
      expect(got[i].interestPaid).toBe(want[i].interestPaid);
      expect(got[i].couponRate).toBe(want[i].couponRate);
    }
  });

  it("going-concern view is bit-identical to cdCashflows(renewals: true)", () => {
    const terms = mkTerms(BOOK);
    const adapter = new CdBookInstrument(terms, { renewals: true });
    const got = adapter.generateCashflows(NO_PATH);
    const want = cdCashflows(
      terms.notional,
      { renewals: true },
      CD_DEFAULT_PARAMS,
      toKernelRows(BOOK),
    );
    expect(got.length).toBe(want.length);
    for (let i = 0; i < got.length; i++) {
      expect(got[i].balance).toBe(want[i].balance);
      expect(got[i].principalPaid).toBe(want[i].principalPaid);
      expect(got[i].interestPaid).toBe(want[i].interestPaid);
      expect(got[i].couponRate).toBe(want[i].couponRate);
    }
  });

  it("generateCashflows is pure: repeated calls are identical", () => {
    const adapter = new CdBookInstrument(mkTerms(BOOK));
    expect(adapter.generateCashflows(NO_PATH)).toEqual(adapter.generateCashflows(NO_PATH));
  });
});

describe("anchor 2: zero-hazard degeneracy reproduces the bullet", () => {
  const zp = zeroHazardParams();

  it("the zero-hazard configuration makes the kernel hazard EXACTLY zero", () => {
    expect(hazardCore(0.02, 12, 5e7, zp)).toBe(0);
    expect(hazardCore(-0.01, 3, 1e3, zp)).toBe(0);
    expect(hazardCore(0.054085, 59, 1e9, zp)).toBe(0);
  });

  it("single fresh cohort equals the FixedLoan bullet to 1e-12 relative", () => {
    const cohorts: CdCohortSpec[] = [
      { termMonths: 24, monthsToMaturity: 24, balance: 100, contractRate: 0.04 },
    ];
    const adapter = new CdBookInstrument(mkTerms(cohorts), { params: zp });
    const got = adapter.generateCashflows(NO_PATH);
    const bullet = new FixedLoan({
      id: "bullet-cmp",
      type: "fixed-loan",
      notional: 1_000_000,
      maturityMonths: 24,
      originationOffsetMonths: 0,
      amortType: "bullet",
      coupon: 0.04,
    }).generateCashflows(NO_PATH);
    // No early withdrawal at all: principal is EXACTLY zero before maturity.
    for (let i = 0; i < got.length - 1; i++) expect(got[i].principalPaid).toBe(0);
    const worst = maxStreamRelDiff(got, bullet);
    expect(worst).toBeLessThanOrEqual(1e-12);
  });

  it("seasoned single cohort (term 12, 7 months left) equals a 7-month bullet", () => {
    const cohorts: CdCohortSpec[] = [
      { termMonths: 12, monthsToMaturity: 7, balance: 100, contractRate: 0.035 },
    ];
    const adapter = new CdBookInstrument(mkTerms(cohorts), { params: zp });
    const got = adapter.generateCashflows(NO_PATH);
    const bullet = new FixedLoan({
      id: "bullet-cmp-seasoned",
      type: "fixed-loan",
      notional: 1_000_000,
      maturityMonths: 7,
      originationOffsetMonths: 0,
      amortType: "bullet",
      coupon: 0.035,
    }).generateCashflows(NO_PATH);
    expect(maxStreamRelDiff(got, bullet)).toBeLessThanOrEqual(1e-12);
  });

  it("multi-cohort book equals the aggregated per-cohort bullets to 1e-12 relative", () => {
    const notional = 1_000_000;
    const terms = mkTerms(BOOK, notional);
    const adapter = new CdBookInstrument(terms, { params: zp });
    const got = adapter.generateCashflows(NO_PATH);

    let bookTotal = 0;
    for (const c of BOOK) bookTotal += c.balance;
    const unitScale = notional / bookTotal;
    const maxM = cdMaturityMonths(BOOK);
    const principal = new Array<number>(maxM + 1).fill(0);
    const interest = new Array<number>(maxM + 1).fill(0);
    const balance = new Array<number>(maxM + 1).fill(0);
    for (const c of BOOK) {
      const cf = new FixedLoan({
        id: `bullet-${c.termMonths}-${c.monthsToMaturity}`,
        type: "fixed-loan",
        notional: c.balance * unitScale,
        maturityMonths: c.monthsToMaturity,
        originationOffsetMonths: 0,
        amortType: "bullet",
        coupon: c.contractRate,
      }).generateCashflows(NO_PATH);
      for (const r of cf) {
        principal[r.monthOffset] += r.principalPaid;
        interest[r.monthOffset] += r.interestPaid;
        balance[r.monthOffset] += r.balance;
      }
    }
    expect(got.length).toBe(maxM);
    let worst = 0;
    for (const r of got) {
      worst = Math.max(
        worst,
        relDiff(r.principalPaid, principal[r.monthOffset]),
        relDiff(r.interestPaid, interest[r.monthOffset]),
        relDiff(r.balance, balance[r.monthOffset]),
      );
    }
    expect(worst).toBeLessThanOrEqual(1e-12);
  });
});

describe("anchor 3: directional — duration shortens, liquidity front-loads vs the bullet", () => {
  const calibrated = resolveCdParams();
  const zero = zeroHazardParams();

  it("effective duration shortens under the calibrated hazard (both shock pairs)", () => {
    const pvOn = pvByShock(BOOK, calibrated);
    const pvZero = pvByShock(BOOK, zero);
    const d100On = effDuration(pvOn, 100);
    const d100Zero = effDuration(pvZero, 100);
    const d200On = effDuration(pvOn, 200);
    const d200Zero = effDuration(pvZero, 200);
    expect(d100On).toBeGreaterThan(0);
    expect(d200On).toBeGreaterThan(0);
    expect(d100On).toBeLessThan(d100Zero);
    expect(d200On).toBeLessThan(d200Zero);
  });

  it("liquidity front-loads: cumulative principal dominates the bullet month by month", () => {
    const on = new CdBookInstrument(mkTerms(BOOK), { params: calibrated }).generateCashflows(NO_PATH);
    const off = new CdBookInstrument(mkTerms(BOOK), { params: zero }).generateCashflows(NO_PATH);
    expect(on.length).toBe(off.length);
    let cumOn = 0;
    let cumOff = 0;
    for (let i = 0; i < on.length; i++) {
      cumOn += on[i].principalPaid;
      cumOff += off[i].principalPaid;
      expect(cumOn).toBeGreaterThanOrEqual(cumOff - 1e-9);
    }
    // Strict at month 1: the calibrated hazard withdraws while the bullet pays nothing.
    expect(on[0].principalPaid).toBeGreaterThan(0);
    expect(off[0].principalPaid).toBe(0);
    // Total principal conserved either way: the book fully exits in run-off.
    expect(relDiff(cumOn, 1_000_000)).toBeLessThanOrEqual(1e-9);
    expect(relDiff(cumOff, 1_000_000)).toBeLessThanOrEqual(1e-9);
  });

  it("run-off WAL shortens under the calibrated hazard", () => {
    const on = new CdBookInstrument(mkTerms(BOOK), { params: calibrated }).generateCashflows(NO_PATH);
    const off = new CdBookInstrument(mkTerms(BOOK), { params: zero }).generateCashflows(NO_PATH);
    expect(walMonthsOf(on)).toBeLessThan(walMonthsOf(off));
  });
});

describe("cross-checks: adapter-derived analytics reconcile with the kernel's own functions", () => {
  const params = resolveCdParams();
  const rows = toKernelRows(BOOK);

  it("stream-PV effective durations match kernel runoffEve on the same book", () => {
    const eve = runoffEve(rows, SHOCKS, params);
    const pv = pvByShock(BOOK, params);
    expect(relDiff(effDuration(pv, 100), eve.effDurPm100Years)).toBeLessThanOrEqual(1e-9);
    expect(relDiff(effDuration(pv, 200), eve.effDurPm200Years)).toBeLessThanOrEqual(1e-9);
  });

  it("run-off stream WAL matches kernel prepayWal", () => {
    const stream = new CdBookInstrument(mkTerms(BOOK), { params }).generateCashflows(NO_PATH);
    expect(relDiff(walMonthsOf(stream), prepayWal(rows, params).walMonths)).toBeLessThanOrEqual(1e-9);
  });

  it("going-concern stream WAL matches kernel liquidityProfile", () => {
    const stream = new CdBookInstrument(mkTerms(BOOK), {
      renewals: true,
      params,
    }).generateCashflows(NO_PATH);
    expect(relDiff(walMonthsOf(stream), liquidityProfile(rows, 0, params).walMonths)).toBeLessThanOrEqual(
      1e-9,
    );
  });

  it("going-concern residual tail is disclosed via walkDetail, not dropped silently", () => {
    const inst = new CdBookInstrument(mkTerms(BOOK), { renewals: true, params });
    const detail = inst.walkDetail();
    expect(detail.residualTYears).toBe(params.horizonMonths / 12);
    expect(detail.residualBalance).toBeGreaterThanOrEqual(0);
    // Run-off tail is zero to cull dust by construction.
    const runoff = new CdBookInstrument(mkTerms(BOOK), { params }).walkDetail();
    expect(runoff.residualBalance).toBeLessThanOrEqual(1e-6);
  });
});

describe("typed refusals: malformed terms and configurations never produce a stream", () => {
  const base = mkTerms(BOOK);

  function expectRefusal(fn: () => unknown, code: string): void {
    try {
      fn();
      expect.fail(`expected CdAdapterError ${code}, got no throw`);
    } catch (e) {
      expect(e).toBeInstanceOf(CdAdapterError);
      expect((e as CdAdapterError).code).toBe(code);
    }
  }

  it("refuses a term outside the kernel term-bucket map", () => {
    const cohorts = [{ termMonths: 5, monthsToMaturity: 3, balance: 10, contractRate: 0.03 }];
    expectRefusal(
      () => new CdBookInstrument({ ...base, cohorts, maturityMonths: 3 }),
      "cd-terms-term",
    );
  });

  it("refuses monthsToMaturity beyond the original term, or below 1", () => {
    expectRefusal(
      () =>
        new CdBookInstrument({
          ...base,
          cohorts: [{ termMonths: 12, monthsToMaturity: 13, balance: 10, contractRate: 0.03 }],
          maturityMonths: 13,
        }),
      "cd-terms-mtm",
    );
    expectRefusal(
      () =>
        new CdBookInstrument({
          ...base,
          cohorts: [{ termMonths: 12, monthsToMaturity: 0, balance: 10, contractRate: 0.03 }],
          maturityMonths: 0,
        }),
      "cd-terms-mtm",
    );
  });

  it("refuses an empty cohort book", () => {
    expectRefusal(
      () => new CdBookInstrument({ ...base, cohorts: [], maturityMonths: 0 }),
      "cd-terms-cohorts-empty",
    );
  });

  it("refuses a maturityMonths that disagrees with the cohort book", () => {
    expectRefusal(() => new CdBookInstrument({ ...base, maturityMonths: 60 }), "cd-terms-maturity");
  });

  it("refuses a nonzero originationOffsetMonths (age would double-count)", () => {
    expectRefusal(
      () => new CdBookInstrument({ ...base, originationOffsetMonths: -6 }),
      "cd-terms-origination-offset",
    );
  });

  it("refuses non-positive notional and non-bullet amortType", () => {
    expectRefusal(() => new CdBookInstrument({ ...base, notional: 0 }), "cd-terms-notional");
    expectRefusal(
      () =>
        new CdBookInstrument({
          ...base,
          amortType: "level-pay" as unknown as "bullet",
        }),
      "cd-terms-amort",
    );
  });

  it("refuses a run-off horizon shorter than the book's final maturity", () => {
    const short = resolveCdParams({ horizonMonths: 24 }); // book matures at 48
    expectRefusal(() => new CdBookInstrument(base, { params: short }), "cd-horizon-short");
  });

  it("refuses a renewals view when a term has no offer spread", () => {
    const noSpread = resolveCdParams({ offerSpreadByTerm: {} });
    expectRefusal(
      () => new CdBookInstrument(base, { renewals: true, params: noSpread }),
      "cd-offer-spread-missing",
    );
  });

  it("refuses a non-finite shockBp", () => {
    expectRefusal(() => new CdBookInstrument(base, { shockBp: Number.NaN }), "cd-shock-invalid");
  });
});

describe("parameter mapping (the kernel's illustrative defaults only)", () => {
  it("resolveCdParams() reproduces the kernel's vendored defaults exactly", () => {
    expect(resolveCdParams()).toEqual(CD_DEFAULT_PARAMS);
  });

  it("resolveCdParams() returns fresh objects, never the kernel singleton", () => {
    const p = resolveCdParams();
    expect(p).not.toBe(CD_DEFAULT_PARAMS);
    expect(p.hazard).not.toBe(CD_DEFAULT_PARAMS.hazard);
    expect(p.curve).not.toBe(CD_DEFAULT_PARAMS.curve);
  });

  it("section overrides merge field-wise without touching siblings", () => {
    const p = resolveCdParams({ horizonMonths: 60, hazard: { b1Moneyness: 0 } });
    expect(p.horizonMonths).toBe(60);
    expect(p.hazard.b1Moneyness).toBe(0);
    expect(p.hazard.intercept).toBe(CD_DEFAULT_PARAMS.hazard.intercept);
    expect(p.renewal).toEqual(CD_DEFAULT_PARAMS.renewal);
  });
});
