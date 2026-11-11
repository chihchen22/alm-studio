/**
 * FTP module acceptance. Anchors:
 *
 *   1. Flat-curve two-period hand case to machine precision: the par-matched
 *      rate of a 2-month bullet on a flat curve has the closed form
 *      r = (1 - D(2/12)) / ((D(1/12) + D(2/12)) * (1/12)), computed here with
 *      independent arithmetic and asserted against the engine block.
 *   2. all-in minus IR equals LP for every position, identically (kernel rows),
 *      and to 1e-12 at the family aggregation.
 *   3. Book conservation: charges minus credits equals the stated mismatch
 *      residual to 1e-9.
 *   4. NIM bridge: lending + funding + mismatch re-sums to computeNII's base
 *      totalNet12 to 1e-9 (relative), and niiNet12 is a VERBATIM copy.
 *   5. ADR-018 refusal: typed throw at a shocked scenario; typed in-block
 *      NotImplemented tag on every emitted block; the run-level notImplemented
 *      register stays empty.
 *
 * Plus the side-classification guards this wrapper exists for: a liability
 * family whose position terms omit `side` (the vanilla book's funding legs)
 * must get the liability margin orientation, and an explicit terms.side that
 * contradicts the family side must refuse loudly.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildTLPCurve,
  computeFTP,
  DEFAULT_TLP_CURVE,
  type Instrument,
  type MarketSnapshot,
  type TLPCurve,
  type ZeroCurve,
} from "@alm/kernel";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunResult } from "../../contracts/run";
import type { FtpResult } from "../../contracts/results";
import type { Scenario } from "../../contracts/scenario";
import { clearPortfolios } from "../../portfolio/registry";
import { buildScenarioRatePath } from "../../projection/static";
import { createEngine, resolveDefaultContext } from "../../run";
import {
  fixedPosition,
  loadMarket,
  makeCoa,
  makeRunRequest,
  twoSidedBook,
  HORIZON,
} from "../../run/__tests__/fixtures";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { NotImplementedError } from "../../runtime/notImplemented";
import { buildBaseCurve } from "../../scenario";
import {
  computeFtpResult,
  FTP_BRIDGE_HORIZON_MONTHS,
  FTP_SHOCKED_SERIES_LAYER,
} from "../computeFtp";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

// --- Shared helpers ----------------------------------------------------------

function baseScenario(id = "S0", assumptionSetId = "AS-BASE"): Scenario {
  return {
    id,
    label: id,
    rateSpec: { kind: "base" },
    assumptionSetId,
    newBusiness: { mode: "static", rules: [] },
  };
}

/** Flat continuously-compounded zero curve (test stub; fixed loans read no rates). */
function flatCurve(z: number): ZeroCurve {
  const df = (t: number) => Math.exp(-z * t);
  return {
    t: [0, 30],
    z: [z, z],
    convention: "annual_act360",
    zeroRate: () => z,
    discountFactor: df,
    forwardRate: (t1, t2) => (df(t1) / df(t2) - 1) / (t2 - t1),
    forwardRateBey: (t1, t2) => (df(t1) / df(t2) - 1) / (t2 - t1),
    forwardSwapRate: (t1, t2) => (df(t1) / df(t2) - 1) / (t2 - t1),
  };
}

/** Flat TLP spread at every tenor. */
function flatTlp(spread: number): TLPCurve {
  return buildTLPCurve([{ tYears: 0, spread }]);
}

function runFixture(): RunResult {
  clearPortfolios();
  const engine = createEngine(resolveDefaultContext());
  engine.loadPortfolio(twoSidedBook());
  return engine.run(makeRunRequest(market));
}

/** The exact curve/TLP/path triple the run pipeline hands the FTP block. */
function fixtureEnvironment() {
  const curve = buildBaseCurve(market);
  const tlp = market.tlpNodes.length > 0 ? buildTLPCurve(market.tlpNodes) : DEFAULT_TLP_CURVE;
  const path = buildScenarioRatePath(curve, baseScenario(), HORIZON);
  return { curve, tlp, path };
}

/** Kernel rows for the fixture book with the family-side correction applied. */
function fixtureKernelRows() {
  const book = twoSidedBook();
  const sideOf = new Map(book.coa.families.map((f) => [f.id, f.side]));
  const insts: Instrument[] = book.positions.map((p) => {
    const famSide = sideOf.get(p.familyId) as "asset" | "liability";
    return makeInstrument(p.terms.side === undefined ? { ...p.terms, side: famSide } : p.terms);
  });
  const { curve, tlp, path } = fixtureEnvironment();
  return { book, kernel: computeFTP(insts, curve, tlp, path) };
}

// --- Anchor 1: flat-curve two-period hand case -------------------------------

describe("flat-curve two-period hand case (machine precision)", () => {
  const Z = 0.04;
  const LAMBDA = 0.005;
  const COUPON = 0.06;
  const NOTIONAL = 1_000_000;
  const DT = 1 / 12;

  // Independent closed form: 2-month bullet, interest N*c/12 in months 1 and 2,
  // principal N in month 2. Par match: N = D1*(r*N*dt) + D2*(N + r*N*dt)
  //   =>  r = (1 - D2) / ((D1 + D2) * dt).
  function handRate(zAllIn: number): number {
    const d1 = Math.exp(-zAllIn * DT);
    const d2 = Math.exp(-zAllIn * 2 * DT);
    return (1 - d2) / ((d1 + d2) * DT);
  }

  function handBlock(): FtpResult {
    const coa = makeCoa();
    const portfolio: PortfolioSpec = {
      id: "PF-HAND",
      label: "Hand case",
      asOf: "2026-01-01",
      coa,
      positions: [
        fixedPosition("HAND1", {
          notional: NOTIONAL,
          coupon: COUPON,
          maturityMonths: 2,
          amortType: "bullet",
        }),
      ],
    };
    const curve = flatCurve(Z);
    const scenario = baseScenario();
    const path = buildScenarioRatePath(curve, scenario, 12);
    // niiBase is the independently hand-computed coupon sum: two months of
    // N*c/12 — so the bridge is checked against a value this module never saw.
    const niiNet12Hand = NOTIONAL * COUPON * DT * 2;
    return computeFtpResult({
      portfolio,
      scenarios: [scenario],
      baseScenarioId: "S0",
      curve,
      tlp: flatTlp(LAMBDA),
      path,
      horizonMonths: 12,
      niiBase: { scenarioId: "S0", totalNet12: niiNet12Hand },
    });
  }

  it("reproduces the closed-form IR, all-in, and LP rates to machine precision", () => {
    const ftp = handBlock();
    const row = ftp.byFamily.find((f) => f.familyId === "FIXED")!;
    const irHand = handRate(Z);
    const allInHand = handRate(Z + LAMBDA);
    expect(row.irFtpRate).toBeDefined();
    expect(Math.abs(row.irFtpRate! - irHand)).toBeLessThan(1e-12);
    expect(Math.abs(row.allInFtpRate! - allInHand)).toBeLessThan(1e-12);
    expect(Math.abs(row.lpFtpRate! - (allInHand - irHand))).toBeLessThan(1e-12);
    // Coupon and margin from the same hand values.
    expect(Math.abs(row.couponRate! - COUPON)).toBeLessThan(1e-15);
    expect(Math.abs(row.ftpMarginRate! - (COUPON - allInHand))).toBeLessThan(1e-12);
  });

  it("round-trips: the solved all-in rate re-prices the strip to par", () => {
    const ftp = handBlock();
    const row = ftp.byFamily.find((f) => f.familyId === "FIXED")!;
    const r = row.allInFtpRate!;
    const dfAllIn = (t: number) => Math.exp(-(Z + LAMBDA) * t);
    const pv =
      dfAllIn(1 / 12) * (r * NOTIONAL * DT) + dfAllIn(2 / 12) * (NOTIONAL + r * NOTIONAL * DT);
    expect(Math.abs(pv - NOTIONAL) / NOTIONAL).toBeLessThan(1e-12);
  });

  it("bridges to the hand-computed NII: lending + funding + mismatch = N*c/12*2", () => {
    const ftp = handBlock();
    const b = ftp.nimBridge;
    expect(b.horizonMonths).toBe(FTP_BRIDGE_HORIZON_MONTHS);
    expect(Math.abs(b.bridgeNet12 - b.niiNet12) / Math.abs(b.niiNet12)).toBeLessThan(1e-12);
    // Decomposition detail on a one-asset book: funding leg is empty.
    expect(b.fundingMargin12).toBe(0);
    expect(b.bridgeNet12).toBe(b.lendingMargin12 + b.fundingMargin12 + b.mismatchCenter12);
  });

  it("emits empty families honestly: zero dollars, NO fabricated rates", () => {
    const ftp = handBlock();
    const empty = ftp.byFamily.find((f) => f.familyId === "MORTGAGE")!;
    expect(empty.positionCount).toBe(0);
    expect(empty.notional).toBe(0);
    expect("irFtpRate" in empty).toBe(false);
    expect("ftpMarginRate" in empty).toBe(false);
    expect(empty.couponInterest12).toBe(0);
    expect(empty.ftpAccrual12).toBe(0);
    expect(empty.margin12).toBe(0);
    expect(empty.monthly.balance.every((v) => v === 0)).toBe(true);
  });
});

// --- Anchors 2-4 on the two-sided fixture book with the real snapshot --------

describe("identities and aggregation on the two-sided book", () => {
  it("all-in minus IR equals LP for every position, identically (kernel rows)", () => {
    const { kernel } = fixtureKernelRows();
    expect(kernel.perInstrument.length).toBe(4);
    for (const row of kernel.perInstrument) {
      // The kernel defines LP as the subtraction; assert it anyway — it
      // catches wiring transpositions between the three legs.
      expect(row.lpFtpRate).toBe(row.allInFtpRate - row.irFtpRate);
    }
  });

  it("family rows carry the kernel's rates verbatim (one position per family)", () => {
    const result = runFixture();
    const ftp = result.ftp!;
    const { book, kernel } = fixtureKernelRows();
    for (let i = 0; i < book.positions.length; i++) {
      const pos = book.positions[i];
      const kRow = kernel.perInstrument[i];
      const fRow = ftp.byFamily.find((f) => f.familyId === pos.familyId)!;
      expect(fRow.positionCount).toBe(1);
      expect(Math.abs(fRow.irFtpRate! - kRow.irFtpRate)).toBeLessThan(1e-12);
      expect(Math.abs(fRow.allInFtpRate! - kRow.allInFtpRate)).toBeLessThan(1e-12);
      expect(Math.abs(fRow.lpFtpRate! - kRow.lpFtpRate)).toBeLessThan(1e-12);
      expect(Math.abs(fRow.couponRate! - kRow.assetRate)).toBeLessThan(1e-12);
      expect(Math.abs(fRow.ftpMarginRate! - kRow.ftpMargin)).toBeLessThan(1e-12);
      // Family-level LP identity survives the notional weighting.
      expect(Math.abs(fRow.lpFtpRate! - (fRow.allInFtpRate! - fRow.irFtpRate!))).toBeLessThan(
        1e-12,
      );
    }
    // Book NIM matches the kernel's own notional-weighted fold.
    expect(Math.abs(ftp.book.bookNimRate - kernel.bookNim)).toBeLessThan(1e-15);
  });

  it("book charges and credits net to the stated mismatch residual (1e-9)", () => {
    const ftp = runFixture().ftp!;
    let charges = 0;
    let credits = 0;
    for (const row of ftp.byFamily) {
      if (row.side === "asset") charges += row.ftpAccrual12;
      else if (row.side === "liability") credits += row.ftpAccrual12;
    }
    expect(Math.abs(charges - ftp.book.charges12)).toBeLessThan(1e-9);
    expect(Math.abs(credits - ftp.book.credits12)).toBeLessThan(1e-9);
    expect(Math.abs(charges - credits - ftp.book.mismatchCenter12)).toBeLessThan(1e-9);
    expect(ftp.nimBridge.mismatchCenter12).toBe(ftp.book.mismatchCenter12);
  });

  it("NIM bridge re-sums to computeNII's base totalNet12 (1e-9 relative)", () => {
    const result = runFixture();
    const ftp = result.ftp!;
    const niiBase = result.nii.byScenario.find((s) => s.scenarioId === "S0")!;
    // Verbatim copy, never a recomputation:
    expect(ftp.nimBridge.niiNet12).toBe(niiBase.totalNet12);
    const scale = Math.max(1, Math.abs(niiBase.totalNet12));
    expect(Math.abs(ftp.nimBridge.bridgeNet12 - niiBase.totalNet12) / scale).toBeLessThan(1e-9);
    // And per family: the FTP coupon dollars are the same interest computeNII
    // summed (asset interest is income, liability interest is expense).
    for (const fam of niiBase.byFamily) {
      const fRow = ftp.byFamily.find((f) => f.familyId === fam.familyId)!;
      const niiInt12 = fRow.side === "asset" ? fam.interestIncome12 : fam.interestExpense12;
      expect(Math.abs(fRow.couponInterest12 - niiInt12) / Math.max(1, niiInt12)).toBeLessThan(
        1e-9,
      );
    }
  });

  it("12-month aggregates equal the head sums of the monthly series", () => {
    const ftp = runFixture().ftp!;
    for (const row of ftp.byFamily) {
      let coupon = 0;
      let accrual = 0;
      for (let k = 0; k < FTP_BRIDGE_HORIZON_MONTHS; k++) {
        coupon += row.monthly.couponInterest[k];
        accrual += row.monthly.ftpAccrual[k];
      }
      expect(Math.abs(coupon - row.couponInterest12)).toBeLessThan(1e-9);
      expect(Math.abs(accrual - row.ftpAccrual12)).toBeLessThan(1e-9);
      expect(row.monthly.balance.length).toBe(HORIZON);
    }
  });

  it("serializes finite everywhere and byte-deterministically", () => {
    const a = runFixture().ftp!;
    const b = runFixture().ftp!;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const bad: string[] = [];
    const walk = (x: unknown, path: string): void => {
      if (typeof x === "number") {
        if (!Number.isFinite(x)) bad.push(`${path} = ${x}`);
      } else if (Array.isArray(x)) {
        x.forEach((v, i) => walk(v, `${path}[${i}]`));
      } else if (x !== null && typeof x === "object") {
        for (const [k, v] of Object.entries(x)) walk(v, `${path}.${k}`);
      }
    };
    walk(JSON.parse(JSON.stringify(a)), "ftp");
    expect(bad).toEqual([]);
  });
});

// --- Base-only with typed refusals ----------------------------------

describe("refusals", () => {
  it("throws the typed NotImplementedError when asked for a shocked scenario", () => {
    const { curve, tlp, path } = fixtureEnvironment();
    const book = twoSidedBook();
    const shocked: Scenario = {
      id: "S100",
      label: "S100",
      rateSpec: { kind: "parallel", shockBp: 100 },
      assumptionSetId: "AS-BASE",
      newBusiness: { mode: "static", rules: [] },
    };
    let thrown: unknown;
    try {
      computeFtpResult({
        portfolio: book,
        scenarios: [baseScenario(), shocked],
        baseScenarioId: "S100",
        curve,
        tlp,
        path,
        horizonMonths: HORIZON,
        niiBase: { scenarioId: "S100", totalNet12: 0 },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotImplementedError);
    expect((thrown as NotImplementedError).layer).toBe(FTP_SHOCKED_SERIES_LAYER);
    expect((thrown as NotImplementedError).message).toContain("not implemented this window");
  });

  it("carries the typed in-block refusal tag naming every shocked scenario", () => {
    const result = runFixture();
    const tag = result.ftp!.shockedScenarios;
    expect(tag._tag).toBe("not-implemented");
    expect(tag.layer).toBe(FTP_SHOCKED_SERIES_LAYER);
    expect(tag.reason).toContain("shocked-NII path convention");
    for (const id of ["S100", "S-100", "S200", "S-200"]) {
      expect(tag.reason).toContain(id);
    }
    // The refusal lives in the block; the run-level register is untouched
    // (stage 4 of npm run accept asserts exact set equality against the
    // declared-deferred ledger, which expects the empty set here).
    expect(result.notImplemented).toEqual([]);
    expect(result.ftp!.scenarioId).toBe("S0");
    expect(result.ftp!.irBasis).toBe("risk-free");
    expect(result.ftp!.allInBasis).toBe("risk-free-plus-tlp");
  });
});

// --- Side classification guards ----------------------------------------------

describe("family-side classification (the vanilla funding-leg case)", () => {
  const Z = 0.04;
  const LAMBDA = 0.005;

  function twoSidedBulletCoa(): ChartOfAccounts {
    return {
      schemaVersion: "1.0.0",
      nodes: [
        { id: "a", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
        { id: "a-loan", label: "Loans", parentId: "a", side: "asset", isLeaf: true, familyId: "LOAN", order: 0 },
        { id: "l", label: "Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
        { id: "l-fund", label: "Funding", parentId: "l", side: "liability", isLeaf: true, familyId: "FUND", order: 0 },
      ],
      families: [
        { id: "LOAN", label: "Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "a-loan" },
        { id: "FUND", label: "Funding", side: "liability", instrumentType: "fixed-loan", coaNodeId: "l-fund" },
      ],
    };
  }

  it("a liability position with NO terms.side gets the liability margin orientation", () => {
    // The vanilla book's funding legs omit terms.side; the kernel alone would
    // read them as assets and flip the margin sign. The engine classifies by
    // the COA family side.
    const coa = twoSidedBulletCoa();
    const coupon = 0.044;
    const portfolio: PortfolioSpec = {
      id: "PF-SIDE",
      label: "Side case",
      asOf: "2026-01-01",
      coa,
      positions: [
        {
          id: "FUND1",
          familyId: "FUND",
          coaNodeId: "l-fund",
          // No `side` on terms, exactly like data/src/vanilla.ts fund legs.
          terms: {
            id: "FUND1",
            type: "fixed-loan",
            notional: 1_000_000,
            maturityMonths: 2,
            originationOffsetMonths: 0,
            amortType: "bullet",
            coupon,
          },
        },
      ],
    };
    const curve = flatCurve(Z);
    const scenario = baseScenario();
    const path = buildScenarioRatePath(curve, scenario, 12);
    const niiNet12 = -(1_000_000 * coupon * (1 / 12) * 2); // liability cost, hand value
    const ftp = computeFtpResult({
      portfolio,
      scenarios: [scenario],
      baseScenarioId: "S0",
      curve,
      tlp: flatTlp(LAMBDA),
      path,
      horizonMonths: 12,
      niiBase: { scenarioId: "S0", totalNet12: niiNet12 },
    });
    const fund = ftp.byFamily.find((f) => f.familyId === "FUND")!;
    expect(fund.side).toBe("liability");
    // Liability orientation: margin = all-in FTP credit minus deposit cost.
    expect(Math.abs(fund.ftpMarginRate! - (fund.allInFtpRate! - fund.couponRate!))).toBeLessThan(
      1e-15,
    );
    expect(fund.margin12).toBe(fund.ftpAccrual12 - fund.couponInterest12);
    // Its accrual is a CREDIT, not a charge.
    expect(ftp.book.credits12).toBe(fund.ftpAccrual12);
    expect(ftp.book.charges12).toBe(0);
    // And the bridge still reconciles to the hand NII (funding-only book).
    expect(
      Math.abs(ftp.nimBridge.bridgeNet12 - niiNet12) / Math.max(1, Math.abs(niiNet12)),
    ).toBeLessThan(1e-12);
  });

  it("refuses loudly when terms.side contradicts the family side", () => {
    const book = twoSidedBook();
    const conflicted: PortfolioSpec = {
      ...book,
      positions: book.positions.map((p) =>
        p.id === "B1" ? { ...p, terms: { ...p.terms, side: "asset" as const } } : p,
      ),
    };
    const { curve, tlp, path } = fixtureEnvironment();
    expect(() =>
      computeFtpResult({
        portfolio: conflicted,
        scenarios: [baseScenario()],
        baseScenarioId: "S0",
        curve,
        tlp,
        path,
        horizonMonths: HORIZON,
        niiBase: { scenarioId: "S0", totalNet12: 0 },
      }),
    ).toThrow(/terms\.side "asset".*"MMA".*"liability"/);
  });
});
