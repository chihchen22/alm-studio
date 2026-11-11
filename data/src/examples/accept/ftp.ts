/**
 * Acceptance check: ftp-deterministic.
 *
 * Anchors, strongest first:
 *
 *   1. FLAT-CURVE TWO-PERIOD HAND CASE — the par-matched rate of a 2-month
 *      bullet on a flat curve has the closed form
 *        r = (1 - D(2/12)) / ((D(1/12) + D(2/12)) * (1/12)),
 *      computed HERE with independent arithmetic and asserted against the
 *      engine block to 1e-12 for the IR leg (flat z), the all-in leg
 *      (flat z + TLP), and the LP residual.
 *   2. LP IDENTITY on the vanilla run — allIn - IR = LP per family (it is a
 *      definition; asserting it catches wiring transpositions).
 *   3. BOOK CONSERVATION — charges12 - credits12 = mismatchCenter12 to 1e-9.
 *   4. NIM BRIDGE — lending + funding + mismatch re-sums to computeNII's base
 *      totalNet12 to 1e-9 relative, with niiNet12 a VERBATIM copy (toBe).
 *   5. ADR-018 REFUSAL — computeFtpResult at a shocked base scenario throws
 *      typed (layer ftp.shocked-scenarios); the emitted block's in-block tag
 *      names every refused grid id; the run-level register stays empty.
 *
 * External corroboration, cited not reproduced: an independent spreadsheet
 * par-match, recorded outside this repository, matched the SAME vendored kernel
 * ftp.ts on a fixed 24-month case.
 */
import { buildTLPCurve, FIXED_LOAN_DEFAULTS, type FixedLoanTerms, type ZeroCurve } from "@alm/kernel";
import {
  computeFtpResult,
  createEngine,
  resolveDefaultContext,
  FTP_SHOCKED_SERIES_LAYER,
  type PortfolioSpec,
  type RunRequest,
  type RunResult,
  type Scenario,
} from "@alm/engine";
import { buildScenarioRatePath } from "@alm/engine/src/projection/static";
import { buildVanillaPortfolio, vanillaAssumptionSet, vanillaScenarios } from "../../vanilla";
import { ACCEPT_TS, baseScenario, emptySet, smallBook } from "./handBooks";
import type { CapabilityCheck, CheckLine } from "./types";

const Z = 0.04;
const LAMBDA = 0.005;
const COUPON = 0.06;
const NOTIONAL = 1_000_000;
const DT = 1 / 12;

/** Flat continuously-compounded zero curve (fixed loans read no rates off it). */
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

/** Independent closed form for the 2-month bullet par-matched rate. */
function handRate(zAllIn: number): number {
  const d1 = Math.exp(-zAllIn * DT);
  const d2 = Math.exp(-zAllIn * 2 * DT);
  return (1 - d2) / ((d1 + d2) * DT);
}

export const ftpCheck: CapabilityCheck = {
  capabilityId: "ftp-deterministic",
  title: "FTP three-leg par-match with book NIM bridge, base scenario only",
  run({ market }) {
    const lines: CheckLine[] = [];
    const observed: string[] = [];

    // --- 1. The flat-curve hand case, machine precision. ---------------------
    {
      const set = emptySet();
      const terms: FixedLoanTerms = {
        ...FIXED_LOAN_DEFAULTS,
        id: "hand-1",
        notional: NOTIONAL,
        maturityMonths: 2,
        amortType: "bullet",
        coupon: COUPON,
      };
      const book: PortfolioSpec = smallBook(
        "accept-ftp-hand",
        [{ id: "FIXED", side: "asset", instrumentType: "fixed-loan" }],
        [{ id: "hand-1", familyId: "FIXED", coaNodeId: "coa-FIXED", terms }],
      );
      const scenario = baseScenario(set.id);
      const curve = flatCurve(Z);
      const path = buildScenarioRatePath(curve, scenario, 12);
      const block = computeFtpResult({
        portfolio: book,
        scenarios: [scenario],
        baseScenarioId: "S0",
        curve,
        tlp: buildTLPCurve([{ tYears: 0, spread: LAMBDA }]),
        path,
        horizonMonths: 12,
        // Hand-computed coupon sum the module never saw: two months of N*c/12.
        niiBase: { scenarioId: "S0", totalNet12: NOTIONAL * COUPON * DT * 2 },
      });
      const row = block.byFamily.find((f) => f.familyId === "FIXED")!;
      const irHand = handRate(Z);
      const allInHand = handRate(Z + LAMBDA);
      const dIr = Math.abs(row.irFtpRate! - irHand);
      const dAllIn = Math.abs(row.allInFtpRate! - allInHand);
      const dLp = Math.abs(row.lpFtpRate! - (allInHand - irHand));
      const ok = dIr < 1e-12 && dAllIn < 1e-12 && dLp < 1e-12;
      lines.push({
        id: "hand-case",
        status: ok ? "pass" : "fail",
        detail:
          `flat-curve 2-month bullet: engine IR ${row.irFtpRate} vs closed form ${irHand} ` +
          `(|d| ${dIr.toExponential(2)}), all-in vs ${allInHand} (|d| ${dAllIn.toExponential(2)}), ` +
          `LP residual |d| ${dLp.toExponential(2)} — all < 1e-12 (anchor: independent closed-form ` +
          `arithmetic in this check, r = (1-D2)/((D1+D2)*dt))`,
      });
    }

    // --- 2-5 on the vanilla run's emitted block. ------------------------------
    const portfolio = buildVanillaPortfolio();
    const set = vanillaAssumptionSet();
    const request: RunRequest = {
      runId: "accept-ftp-vanilla",
      portfolioId: portfolio.id,
      marketSnapshot: market,
      scenarios: vanillaScenarios(set.id),
      assumptionSets: [set],
      grid: { horizonMonths: 360, asOf: portfolio.asOf },
      seed: "accept",
      timestamps: { ...ACCEPT_TS },
    };
    const engine = createEngine(resolveDefaultContext());
    engine.loadPortfolio(portfolio);
    const result: RunResult = engine.run(request);
    observed.push(...result.notImplemented.map((t) => t.layer));
    const ftp = result.ftp;
    if (!ftp) {
      lines.push({ id: "block-present", status: "fail", detail: "vanilla envelope carries no ftp block" });
      return { lines, observedNotImplemented: observed };
    }

    // 2. LP identity per non-empty family at the weighted grain.
    let worstLp = 0;
    let familiesChecked = 0;
    for (const f of ftp.byFamily) {
      if (f.irFtpRate === undefined || f.allInFtpRate === undefined || f.lpFtpRate === undefined) continue;
      familiesChecked++;
      worstLp = Math.max(worstLp, Math.abs(f.lpFtpRate - (f.allInFtpRate - f.irFtpRate)));
    }
    lines.push({
      id: "lp-identity",
      status: familiesChecked > 0 && worstLp <= 1e-12 ? "pass" : "fail",
      detail:
        `all-in - IR = LP across ${familiesChecked} non-empty families: worst |deviation| ` +
        `${worstLp.toExponential(2)} <= 1e-12 (anchor: the decomposition is definitional; ` +
        `asserting it catches wiring transpositions)`,
    });

    // 3. Book conservation.
    const b = ftp.book;
    const residGap = Math.abs(b.mismatchCenter12 - (b.charges12 - b.credits12));
    const residRel = residGap / Math.max(1, Math.abs(b.charges12), Math.abs(b.credits12));
    lines.push({
      id: "book-conservation",
      status: residRel <= 1e-9 ? "pass" : "fail",
      detail:
        `charges12 $${b.charges12.toFixed(2)} - credits12 $${b.credits12.toFixed(2)} = ` +
        `mismatchCenter12 $${b.mismatchCenter12.toFixed(2)} to ${residRel.toExponential(2)} ` +
        `relative <= 1e-9 (anchor: FTP charges and credits net to the central desk's stated residual)`,
    });

    // 4. NIM bridge: verbatim copy plus 1e-9 reconciliation to computeNII.
    const bridge = ftp.nimBridge;
    const niiBase = result.nii.byScenario.find((s) => s.scenarioId === ftp.scenarioId)!;
    const verbatim = Object.is(bridge.niiNet12, niiBase.totalNet12);
    const bridgeRel = Math.abs(bridge.bridgeNet12 - bridge.niiNet12) / Math.max(1, Math.abs(bridge.niiNet12));
    lines.push({
      id: "nim-bridge",
      status: verbatim && bridgeRel <= 1e-9 ? "pass" : "fail",
      detail:
        `lending $${bridge.lendingMargin12.toFixed(2)} + funding $${bridge.fundingMargin12.toFixed(2)} ` +
        `+ mismatch $${bridge.mismatchCenter12.toFixed(2)} = bridgeNet12 $${bridge.bridgeNet12.toFixed(2)} ` +
        `vs computeNII totalNet12 $${niiBase.totalNet12.toFixed(2)}: relative gap ` +
        `${bridgeRel.toExponential(2)} <= 1e-9, niiNet12 verbatim copy = ${verbatim} ` +
        `(anchor: welds FTP to the already-validated NII number instead of letting it float free)`,
    });

    // 5. Typed refusal at a shocked scenario + in-block tag; run
    // register untouched by FTP.
    let threw = "no error";
    try {
      const shocked: Scenario = {
        ...vanillaScenarios(set.id)[3],
        id: "S100",
      };
      computeFtpResult({
        portfolio,
        scenarios: vanillaScenarios(set.id),
        baseScenarioId: "S100",
        curve: flatCurve(Z),
        tlp: buildTLPCurve([{ tYears: 0, spread: LAMBDA }]),
        path: buildScenarioRatePath(flatCurve(Z), shocked, 12),
        horizonMonths: 12,
        niiBase: { scenarioId: "S100", totalNet12: 0 },
      });
    } catch (err) {
      const e = err as Error & { layer?: string };
      threw = `${e.name}:${e.layer}`;
    }
    const tag = ftp.shockedScenarios;
    const refusedIds = /SM200/.test(tag.reason) && /S200/.test(tag.reason) && /SM100/.test(tag.reason) && /S100/.test(tag.reason);
    const runRegisterCleanOfFtp = !result.notImplemented.some((t) => t.layer === FTP_SHOCKED_SERIES_LAYER);
    const ok = threw === `NotImplementedError:${FTP_SHOCKED_SERIES_LAYER}` && tag.layer === FTP_SHOCKED_SERIES_LAYER && refusedIds && runRegisterCleanOfFtp;
    lines.push({
      id: "shocked-scenario-refusal",
      status: ok ? "pass" : "fail",
      detail:
        `shocked-scenario FTP throws ${threw} (want NotImplementedError:${FTP_SHOCKED_SERIES_LAYER}); ` +
        `emitted block carries the in-block tag naming SM200/SM100/S100/S200: ${refusedIds}; ` +
        `run-level register carries no ftp layer: ${runRegisterCleanOfFtp} (anchor: no ` +
        `series ships on the convention flagged wrong-by-one-coupon-month)`,
    });

    return { lines, observedNotImplemented: observed };
  },
};
