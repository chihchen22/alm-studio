/**
 * W3-A2b run-level anchors: the seeded book with the cds family LIVE on the
 * kernel competing-risk cohort walk, measured against the ADR-010
 * bullet twin it replaces.
 *
 * The twin is built HERE, independently of the generator's history: the same
 * book with the cd cohort-book position replaced by one kernel fixed-loan
 * bullet per cohort (same dollars, same maturities, same rates) and the cds
 * family re-declared "fixed-loan". Whatever the generator does, the twin is
 * the bullet representation of the SAME cohort schedule, so the comparisons
 * below are anchored, not self-referential.
 *
 * Anchors:
 *  1. Zero-hazard degeneracy ON THE SEEDED COHORT BOOK through the factory:
 *     the cd instrument under zeroHazardParams reproduces the aggregated
 *     bullet streams to 1e-12 relative (the flip precondition, on the
 *     actual seeded cohorts, not just a hand-built test book).
 *  2. Principal conservation: the live behavioral stream returns the full
 *     position notional inside the walk horizon (1e-9 relative).
 *  3. Direction of travel (economics of early withdrawal): versus the bullet
 *     twin, the cds family's base-environment effective duration SHORTENS and
 *     its repricing/liquidity ladders FRONT-LOAD (cumulative principal through
 *     every band at least the bullet's, strictly greater inside the horizon).
 *  4. The full demo request (base + regulatory grid) runs green with CDs live:
 *     every layer populated, notImplemented empty.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FixedLoan,
  loadMarketSnapshot,
  bootstrapZeroCurve,
  DeterministicRatePath,
  type FixedLoanTerms,
  type MarketSnapshot,
} from "@alm/kernel";
import {
  createEngine,
  resolveDefaultContext,
  type PortfolioSpec,
  type Position,
  type RunResult,
} from "@alm/engine";
import { makeInstrument } from "@alm/engine/src/runtime/instrumentFactory";
import { zeroHazardParams } from "@alm/engine/src/cd/params";
import type { CdTerms } from "@alm/engine";
import { DEFAULT_GENERATOR_CONFIG, generatePortfolio } from "../generate";
import { buildDemoRequest } from "../demo/request";

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKET_PATH = resolve(HERE, "../../../packages/kernel/public/market_public.json");
const SMALL_CONFIG = { ...DEFAULT_GENERATOR_CONFIG, targetPositions: 400 };
const TS = { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" };

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarketSnapshot(MARKET_PATH);
});

function cdPositionOf(spec: PortfolioSpec): Position & { terms: CdTerms } {
  const pos = spec.positions.find((p) => p.familyId === "cds");
  expect(pos).toBeDefined();
  if (pos!.terms.type !== "cd") throw new Error("seeded cds position must carry cd terms");
  return pos as Position & { terms: CdTerms };
}

/** The twin: cds cohorts as one kernel bullet per cohort. */
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
    positions: spec.positions.map((p) => (p.familyId === "cds" ? null : p)).filter((p): p is Position => p !== null).concat(bullets),
  };
}

function run(spec: PortfolioSpec): RunResult {
  const engine = createEngine(resolveDefaultContext());
  engine.loadPortfolio(spec);
  const request = buildDemoRequest(spec, market, TS);
  return engine.run({ ...request, runId: `cd-anchor-${spec.id}`, portfolioId: spec.id });
}

function cdBands(result: RunResult, kind: "repricing" | "liquidity"): number[] {
  const ladder = result.gap[kind].find((g) => g.scenarioId === "S0")!;
  const node = ladder.byCoaNode.find((n) => n.coaNodeId === "coa-cds");
  expect(node).toBeDefined();
  return node!.rows.map((r) => r.liabilities);
}

describe("seeded book: cds family live on the competing-risk walk", () => {
  it("zero-hazard degeneracy holds on the seeded cohorts through the factory (1e-12)", async () => {
    const spec = generatePortfolio(SMALL_CONFIG);
    const cdPos = cdPositionOf(spec);
    const path = new DeterministicRatePath(bootstrapZeroCurve(market), 360);
    const got = makeInstrument(cdPos.terms, { cd: { params: zeroHazardParams() } })
      .generateCashflows(path);

    const { cohorts, notional, maturityMonths } = cdPos.terms;
    let stylized = 0;
    for (const c of cohorts) stylized += c.balance;
    const unitScale = notional / stylized;
    const balance = new Float64Array(maturityMonths + 1);
    const principal = new Float64Array(maturityMonths + 1);
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
    const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
    for (const row of got) {
      worst = Math.max(
        worst,
        rel(row.balance, balance[row.monthOffset]),
        rel(row.principalPaid, principal[row.monthOffset]),
        rel(row.interestPaid, interest[row.monthOffset]),
      );
    }
    expect(worst).toBeLessThanOrEqual(1e-12);
  });

  it("the live behavioral stream conserves principal to the position notional (1e-9 relative)", () => {
    const spec = generatePortfolio(SMALL_CONFIG);
    const cdPos = cdPositionOf(spec);
    const path = new DeterministicRatePath(bootstrapZeroCurve(market), 360);
    const stream = makeInstrument(cdPos.terms).generateCashflows(path);
    let principal = 0;
    for (const cf of stream) principal += cf.principalPaid;
    expect(Math.abs(principal - cdPos.terms.notional) / cdPos.terms.notional).toBeLessThan(1e-9);
  });

  it("versus the bullet comparator: duration shortens and both ladders front-load", () => {
    const spec = generatePortfolio(SMALL_CONFIG);
    const twin = bulletTwin(spec);
    const live = run(spec);
    const bullet = run(twin);

    // Effective duration of the cds family at the base environment shortens.
    const durOf = (r: RunResult) =>
      r.eve.byScenario
        .find((s) => s.scenarioId === "S0")!
        .byFamily.find((f) => f.familyId === "cds")!.effectiveDuration;
    const liveDur = durOf(live);
    const bulletDur = durOf(bullet);
    expect(liveDur).toBeDefined();
    expect(bulletDur).toBeDefined();
    expect(liveDur!).toBeLessThan(bulletDur!);
    expect(liveDur!).toBeGreaterThan(0);

    // Ladders front-load: cumulative cds principal through every band is at
    // least the bullet twin's, and strictly greater in the first year.
    for (const kind of ["repricing", "liquidity"] as const) {
      const a = cdBands(live, kind);
      const b = cdBands(bullet, kind);
      expect(a.length).toBe(b.length);
      // Total principal equal (both are full-runoff representations, 1e-6 rel).
      const sum = (v: number[]) => v.reduce((x, y) => x + y, 0);
      expect(Math.abs(sum(a) - sum(b)) / sum(b)).toBeLessThan(1e-6);
      let cumA = 0;
      let cumB = 0;
      for (let i = 0; i < a.length; i++) {
        cumA += a[i];
        cumB += b[i];
        expect(cumA).toBeGreaterThanOrEqual(cumB - 1e-9);
      }
      // Strict front-load inside the first year (bands 0-1M..6-12M).
      const yearA = a[0] + a[1] + a[2] + a[3];
      const yearB = b[0] + b[1] + b[2] + b[3];
      expect(yearA).toBeGreaterThan(yearB);
    }
  });

  it("the full demo request runs green with CDs live: every layer populated, nothing not-implemented", () => {
    const spec = generatePortfolio(SMALL_CONFIG);
    const result = run(spec);
    expect(result.notImplemented).toEqual([]);
    expect(result.eve.byScenario).toHaveLength(5);
    expect(result.nii.byScenario).toHaveLength(5);
    expect(result.gap.repricing).toHaveLength(5);
    expect(result.gap.liquidity).toHaveLength(5);
    const base = result.eve.byScenario.find((s) => s.scenarioId === "S0")!;
    expect(base.durationSanityPassed).toBe(true);
    expect(base.effectiveDurationEquity).toBeDefined();
  });
});
