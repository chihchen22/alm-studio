// apps/studio/src/__tests__/fixtures/blocks.ts
/**
 * Schema 1.9.0 block fixtures: envelopes carrying the seg and liquidityStress blocks and an instruments file,
 * hand-built and small on synthetic round numbers. Every figure a test checks is restated there from the inputs here.
 */
import type { InstrumentsFile, LiquidityStressResult, RunResult, SegNii, SegResult, SegSeries } from "@alm/engine";
import type { RunDetail } from "@alm/reader";
import { DETAIL, freshResult } from "./results";

const MUSD = 1e6;

/** The four attribution groups of the constant-balance NII split, synthetic names. */
export const BLOCK_GROUPS = ["fixed_rate_assets", "floating_rate_assets", "deposits", "wholesale_funding"] as const;

const nii = (base: number, up: number, down: number): SegNii => ({
  base12: base, up12: up, down12: down,
  baseMonthly: Array.from({ length: 12 }, () => base / 12),
  upMonthly: Array.from({ length: 12 }, () => up / 12),
  downMonthly: Array.from({ length: 12 }, () => down / 12),
});

function series(scale: number, peak: { value: number; month: number }): SegSeries {
  return {
    nii: nii(60 * scale * MUSD, 66 * scale * MUSD, 52 * scale * MUSD),
    segOutstanding: Array.from({ length: 61 }, (_, t) => scale * (100 - t) * 1e6),
    segPeriodic: Array.from({ length: 61 }, (_, t) => (t === 0 ? 0 : scale * 1e6)),
    ebpAssets: Array.from({ length: 60 }, (_, i) => scale * (500 - i) * 1e6),
    ebpLiabilities: Array.from({ length: 60 }, (_, i) => scale * (300 - i) * 1e6),
    segPeak: peak,
  };
}

/** A well-formed seg block: the bank SEG series peaks at index 3 (month 4) at +1,846.32M. */
export function segFixture(): SegResult {
  return {
    convention: "constant-balance-sheet",
    scenarioId: "S0",
    shockBp: 10,
    niiShockBp: 200,
    horizonMonths: 60,
    niiHorizonMonths: 12,
    nimPct: 2.97,
    totalAssetNotional: 5_000 * MUSD,
    book: series(1, { value: 2_500 * MUSD, month: 2 }),
    segBank: Array.from({ length: 60 }, (_, i) => (i === 0 ? 0 : 1_846.32 * MUSD * (1 - 0.01 * Math.abs(i - 3)))),
    byFamily: { "fixed-loans": series(0.5, { value: 1_200 * MUSD, month: 3 }), "hys-a": series(-0.25, { value: -400 * MUSD, month: 5 }) },
    byAttributionGroup: Object.fromEntries(BLOCK_GROUPS.map((g, i) => [g, nii(10 * MUSD, (10 + i) * MUSD, (10 - i) * MUSD)])),
    uncovered: [{ positionId: "fx-swap-1", reason: "swap: the kernel gives it no replacement vintage" }],
  };
}

/** A synthetic stress table: monthly outflow rates, wholesale renewal and draw rate per scenario. */
const PARAMS = {
  bau: { hysOutflowMonthly: 0.004, wholesaleRenewal: 1, nibOutflowMonthly: 0.001, drawRate: 0 },
  moderate: { hysOutflowMonthly: 0.04, wholesaleRenewal: 0.6, nibOutflowMonthly: 0.008, drawRate: 0.12 },
  severe: { hysOutflowMonthly: 0.08, wholesaleRenewal: 0.2, nibOutflowMonthly: 0.015, drawRate: 0.25 },
} as const;

function ladder(id: "bau" | "moderate" | "severe", out: number): LiquidityStressResult["scenarios"][number] {
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const inflow = months.map(() => 100 * MUSD);
  const hysOut = months.map(() => out * 0.6 * MUSD);
  const nibOut = months.map(() => out * 0.2 * MUSD);
  const wholesaleOut = months.map((m) => (m === 3 ? out * 0.1 * MUSD : 0));
  const draws = months.map(() => out * 0.1 * MUSD);
  const net = months.map((_, i) => inflow[i]! - hysOut[i]! - nibOut[i]! - wholesaleOut[i]! - draws[i]!);
  let run = 0;
  const cumulative = net.map((v) => (run += v));
  const peak = cumulative.reduce((a, b) => (b < a ? b : a), 0);
  return {
    id,
    params: PARAMS[id],
    inflow, hysOut, nibOut, wholesaleOut, draws, net, cumulative,
    survivalMonths: id === "bau" ? null : id === "moderate" ? 9.4 : 3.2,
    peakShortfall: peak,
    peakMonth: cumulative.indexOf(peak) + 1,
  };
}

export function liquidityFixture(): LiquidityStressResult {
  return {
    horizonMonths: 12,
    buffer: 900 * MUSD,
    undrawnFace: 200 * MUSD,
    pools: { hys: 3_000 * MUSD, nib: 1_000 * MUSD },
    wholesaleMaturities: Array.from({ length: 12 }, (_, i) => (i === 2 ? 50 * MUSD : 0)),
    scenarios: [ladder("bau", 20), ladder("moderate", 150), ladder("severe", 300)],
  };
}

/** The viewer's demo envelope with the schema 1.9.0 blocks and the NII engine NIM set from the fixtures above. */
export function blocksResult(): RunResult {
  const r = freshResult() as RunResult & { nmdConvention?: string };
  r.seg = segFixture();
  r.liquidityStress = liquidityFixture();
  r.nmdConvention = "regulatory";
  r.nii.nimPct = 2.5;
  r.instrumentsFile = { schemaVersion: "1.0.0", positions: 5 };
  return r;
}

export const BLOCKS_DETAIL: RunDetail = {
  ...DETAIL,
  refs: { portfolioId: "example-book-v1", marketId: "market-example", scenarioSlateId: "srp31-v1", assumptionSetIds: ["example-behavioral-v1"] },
};

/** Five positions in two families; two dimensions; the seg scalars on every row; the last row has no WAL (a position with no in-horizon principal). */
export function instrumentsFixture(): InstrumentsFile {
  type Row = InstrumentsFile["positions"][number];
  const row = (id: string, family: string, side: "asset" | "liability", notional: number, dims: Record<string, string>, parent?: string, wal: number | null = 30): Row => ({
    positionId: id,
    ...(parent === undefined ? {} : { parentPositionId: parent }),
    familyId: family, coaNodeId: `coa-${family}`, side, type: side === "asset" ? "fixed-loan" : "nmd", notional, dimensions: dims,
    ...(wal === null ? {} : { walMonths: wal }),
    firstRepricingMonth: side === "asset" ? null : 1,
    byScenario: [
      { scenarioId: "S0", pv: notional * 0.98, nii12: notional * 0.05, balance12: notional * 0.8, principal12: notional * 0.2 },
      { scenarioId: "S200", pv: notional * 0.95, nii12: notional * 0.05, balance12: notional * 0.8, principal12: notional * 0.2 },
    ],
    seg: { niiBase12: notional * 0.05, niiUp12: notional * 0.06, niiDown12: notional * 0.04, segPeak: notional * 0.9 },
  });
  return {
    schemaVersion: "1.0.0",
    runId: "run-fixture",
    asOf: "2026-03-31",
    horizonMonths: 360,
    discountBasis: "spread-consistent",
    scenarios: ["S0", "S200"],
    positions: [
      row("small-loan", "fixed-loans", "asset", 1_000_000, { segment: "retail" }),
      row("big-loan", "fixed-loans", "asset", 900_000_000, { segment: "corporate" }),
      row("mid-loan", "fixed-loans", "asset", 40_000_000, { segment: "retail" }),
      row("hys-a-core-1", "hys-a", "liability", 300_000_000, { segment: "retail" }, "hys-a"),
      row("hys-a-noncore", "hys-a", "liability", 120_000_000, { segment: "retail" }, "hys-a", null),
    ],
  };
}
