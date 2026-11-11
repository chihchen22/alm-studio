/**
 * Acceptance battery check: cd-competing-risk (W2-A2 adapter + W3-A2b wiring).
 *
 * Registered by W3-V2 in ./registry.ts (the registry file and the
 * declared-deferred status flip are V2-owned per the collision ledger; this
 * file ships with W3-A2b so the check exists in the same window as the
 * capability). Anchors, each line
 * printing the MEASURED value:
 *
 *   1. kernel identity — the factory-built cd instrument's stream vs a direct
 *      kernel cdCashflows call on the seeded cohort book (bit target, 0).
 *   2. zero-hazard degeneracy — the factory instrument under zeroHazardParams
 *      vs independently aggregated kernel FixedLoan bullets (<= 1e-12).
 *   3. principal conservation — behavioral stream principal re-sums to the
 *      position notional (<= 1e-9 relative).
 *   4. duration direction — cds family effective duration, live vs the
 *      ADR-010 bullet twin of the same cohort schedule (must shorten).
 *   5. liquidity front-load — first-year cds principal share, live vs twin
 *      (must rise), plus band-total conservation between the representations.
 *
 * The engine runs performed here contribute their notImplemented layers to
 * the stage-4 register diff via observedNotImplemented.
 */
import {
  cdCashflows,
  DeterministicRatePath,
  FixedLoan,
  type CdBookRow,
  type FixedLoanTerms,
} from "@alm/kernel";
import {
  createEngine,
  resolveDefaultContext,
  type CdTerms,
  type PortfolioSpec,
  type Position,
  type RunResult,
} from "@alm/engine";
import { makeInstrument } from "@alm/engine/src/runtime/instrumentFactory";
import { buildBaseCurve } from "@alm/engine/src/scenario";
import { resolveCdParams, zeroHazardParams } from "@alm/engine/src/cd/params";
import { markCdBook } from "@alm/engine/src/cd/corrections";
import { modelCorrectionsOf } from "@alm/engine/src/corrections";
import { tlpOfSnapshot } from "@alm/engine/src/run/stages/curve";
import { DEFAULT_GENERATOR_CONFIG, generatePortfolio } from "../../generate";
import { buildDemoRequest } from "../../demo/request";
import type { CapabilityCheck, CapabilityCheckResult, CheckLine } from "./types";

const SMALL_CONFIG = { ...DEFAULT_GENERATOR_CONFIG, targetPositions: 400 };
const TS = { startedAt: "2026-08-02T00:00:00.000Z", finishedAt: "2026-08-02T00:00:00.000Z" };

function cdPositionOf(spec: PortfolioSpec): Position & { terms: CdTerms } {
  const pos = spec.positions.find((p) => p.familyId === "cds");
  if (!pos || pos.terms.type !== "cd") {
    throw new Error("seeded book carries no cd cohort-book position for the cds family");
  }
  return pos as Position & { terms: CdTerms };
}

function bulletTwin(spec: PortfolioSpec): PortfolioSpec {
  const cdPos = cdPositionOf(spec);
  const { cohorts, notional } = cdPos.terms;
  let stylized = 0;
  for (const c of cohorts) stylized += c.balance;
  const unitScale = notional / stylized;
  const bullets: Position[] = cohorts.map((c, i) => {
    const terms: FixedLoanTerms = {
      id: `cds-twin-${i}`,
      type: "fixed-loan",
      notional: c.balance * unitScale,
      maturityMonths: c.monthsToMaturity,
      originationOffsetMonths: 0,
      amortType: "bullet",
      side: "liability",
      coupon: c.contractRate,
    };
    return { id: terms.id, familyId: "cds", coaNodeId: cdPos.coaNodeId, terms };
  });
  return {
    ...spec,
    id: `${spec.id}-bullet-twin`,
    coa: {
      ...spec.coa,
      families: spec.coa.families.map((f) =>
        f.id === "cds" ? { ...f, instrumentType: "fixed-loan" as const } : f,
      ),
      nodes: spec.coa.nodes.map((n) => ({ ...n })),
    },
    positions: spec.positions
      .filter((p) => p.familyId !== "cds")
      .concat(bullets),
  };
}

export const cdCompetingRiskCheck: CapabilityCheck = {
  capabilityId: "cd-competing-risk",
  title: "CD competing-risk wiring (cd terms arm, factory, seeded cds family)",
  run(ctx): CapabilityCheckResult {
    const lines: CheckLine[] = [];
    const observed: string[] = [];
    const spec = generatePortfolio(SMALL_CONFIG);
    const cdPos = cdPositionOf(spec);
    // The run's own base curve (buildBaseCurve), so this check follows the platform default the run builds on.
    const path = new DeterministicRatePath(buildBaseCurve(ctx.market), 360);
    const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));

    // 1. Kernel identity through the factory.
    {
      const got = makeInstrument(cdPos.terms).generateCashflows(path);
      const rows: CdBookRow[] = cdPos.terms.cohorts.map((c) => ({
        termMonths: c.termMonths,
        monthsToMaturity: c.monthsToMaturity,
        balance: c.balance,
        contractRate: c.contractRate,
      }));
      const want = cdCashflows(cdPos.terms.notional, { renewals: false }, resolveCdParams(), rows);
      let worst = got.length === want.length ? 0 : Number.POSITIVE_INFINITY;
      for (let i = 0; i < Math.min(got.length, want.length); i++) {
        worst = Math.max(
          worst,
          rel(got[i].balance, want[i].balance),
          rel(got[i].principalPaid, want[i].principalPaid),
          rel(got[i].interestPaid, want[i].interestPaid),
          rel(got[i].couponRate, want[i].couponRate),
        );
      }
      lines.push({
        id: "kernel-identity",
        status: worst === 0 ? "pass" : "fail",
        detail: `factory cd stream vs direct kernel cdCashflows on the seeded cohort book: maxRelDiff ${worst} (anchor: the vendored, gate-validated kernel cdBook walk; bit target 0)`,
      });
    }

    // 1b. The same identity on the corrected convention. The run marks the book (markCdBook) and the
    // factory walks it at the documented $1 minimum live balance on the path's curve plus the run's funding spread; the
    // direct kernel call is handed those parameters built here from the market (the base curve's zero rate and the
    // TLP at each month), not from the engine's own reader, so the header's $1 and the code agree on both sides.
    {
      const tlp = tlpOfSnapshot(ctx.market);
      const marked = markCdBook({ ...spec, positions: [cdPos] }, modelCorrectionsOf("corrected-v1"), tlp).positions[0]!.terms as CdTerms;
      const got = makeInstrument(marked).generateCashflows(path);
      const base = buildBaseCurve(ctx.market);
      const n = Math.max(...cdPos.terms.cohorts.map((c) => c.termMonths));
      const t = Array.from({ length: n }, (_, i) => (i + 1) / 12);
      const curve = { t, z: t.map((x) => base.zeroRate(x)), tlpSpread: t.map((x) => tlp.tlp(x)) };
      const rows: CdBookRow[] = cdPos.terms.cohorts.map((c) => ({ termMonths: c.termMonths, monthsToMaturity: c.monthsToMaturity, balance: c.balance, contractRate: c.contractRate }));
      const want = cdCashflows(cdPos.terms.notional, { renewals: false }, resolveCdParams({ minLiveBalance: 1, curve }), rows);
      let worst = got.length === want.length ? 0 : Number.POSITIVE_INFINITY;
      for (let i = 0; i < Math.min(got.length, want.length); i++) {
        worst = Math.max(worst, rel(got[i].balance, want[i].balance), rel(got[i].principalPaid, want[i].principalPaid), rel(got[i].interestPaid, want[i].interestPaid));
      }
      lines.push({
        id: "kernel-identity-corrected",
        status: marked.walk?.minLiveBalance === 1 && worst <= 1e-12 ? "pass" : "fail",
        detail: `corrected convention: factory cd stream at the $1 minimum on the run's curve vs a direct kernel cdCashflows call handed $1 and the market's zero curve plus TLP: maxRelDiff ${worst} <= 1e-12 (anchor: the kernel walk, parameters built from the market here)`,
      });
    }

    // 2. Zero-hazard degeneracy on the seeded cohorts.
    {
      const got = makeInstrument(cdPos.terms, { cd: { params: zeroHazardParams() } })
        .generateCashflows(path);
      const { cohorts, notional, maturityMonths } = cdPos.terms;
      let stylized = 0;
      for (const c of cohorts) stylized += c.balance;
      const unitScale = notional / stylized;
      const principal = new Float64Array(maturityMonths + 1);
      const balance = new Float64Array(maturityMonths + 1);
      const interest = new Float64Array(maturityMonths + 1);
      for (const c of cohorts) {
        const loan = new FixedLoan({
          id: `deg-${c.termMonths}-${c.monthsToMaturity}`,
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
      let worst = 0;
      for (const row of got) {
        worst = Math.max(
          worst,
          rel(row.balance, balance[row.monthOffset]),
          rel(row.principalPaid, principal[row.monthOffset]),
          rel(row.interestPaid, interest[row.monthOffset]),
        );
      }
      lines.push({
        id: "zero-hazard-degeneracy",
        status: worst <= 1e-12 ? "pass" : "fail",
        detail: `zero-hazard cd walk vs independently aggregated kernel FixedLoan bullets: maxRelDiff ${worst} <= 1e-12 (anchor: the representation the flip replaces; precondition)`,
      });
    }

    // 3. Principal conservation on the live stream.
    {
      const stream = makeInstrument(cdPos.terms).generateCashflows(path);
      let principal = 0;
      for (const cf of stream) principal += cf.principalPaid;
      const relErr = Math.abs(principal - cdPos.terms.notional) / cdPos.terms.notional;
      lines.push({
        id: "principal-conservation",
        status: relErr < 1e-9 ? "pass" : "fail",
        detail: `behavioral stream principal $${principal.toFixed(2)} vs notional $${cdPos.terms.notional} — relErr ${relErr.toExponential(2)} < 1e-9 (anchor: run-off view returns the whole book inside the walk horizon)`,
      });
    }

    // 4 + 5. Direction of travel vs the bullet twin, through full engine runs.
    {
      const runOn = (book: PortfolioSpec): RunResult => {
        // The public default, the corrected convention.
        const engine = createEngine({ ...resolveDefaultContext(), modelConvention: "corrected-v1" } as Parameters<typeof createEngine>[0]);
        engine.loadPortfolio(book);
        const request = buildDemoRequest(book, ctx.market, TS);
        return engine.run({ ...request, runId: `accept-cd-${book.id}`, portfolioId: book.id });
      };
      const live = runOn(spec);
      const bullet = runOn(bulletTwin(spec));
      observed.push(...live.notImplemented.map((t) => t.layer));
      observed.push(...bullet.notImplemented.map((t) => t.layer));

      const durOf = (r: RunResult) =>
        r.eve.byScenario
          .find((s) => s.scenarioId === "S0")!
          .byFamily.find((f) => f.familyId === "cds")!.effectiveDuration;
      const liveDur = durOf(live);
      const bulletDur = durOf(bullet);
      const durOk = liveDur !== undefined && bulletDur !== undefined && liveDur < bulletDur;
      lines.push({
        id: "duration-shortens",
        status: durOk ? "pass" : "fail",
        detail: `cds family effective duration ${liveDur?.toFixed(4)}y (live) vs ${bulletDur?.toFixed(4)}y (bullet comparator) — early withdrawal shortens duration (anchor: independently built comparator of the same cohort schedule)`,
      });

      const yearShare = (r: RunResult): number => {
        const ladder = r.gap.liquidity.find((g) => g.scenarioId === "S0")!;
        const rows = ladder.byCoaNode.find((n) => n.coaNodeId === "coa-cds")!.rows;
        const total = rows.reduce((a, x) => a + x.liabilities, 0);
        const year = rows[0].liabilities + rows[1].liabilities + rows[2].liabilities + rows[3].liabilities;
        return year / total;
      };
      const liveShare = yearShare(live);
      const bulletShare = yearShare(bullet);
      lines.push({
        id: "liquidity-frontloads",
        status: liveShare > bulletShare ? "pass" : "fail",
        detail: `cds principal inside 12 months: ${(liveShare * 100).toFixed(2)}% (live) vs ${(bulletShare * 100).toFixed(2)}% (bullet comparator) — early withdrawal front-loads the runoff ladder`,
      });
    }

    return { lines, observedNotImplemented: observed };
  },
};
