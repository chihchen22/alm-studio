/**
 * The CSV `dim.` taxonomy round trip. The guided CSV template, with a `dim.region` column
 * added by hand, is imported through POST /api/portfolios/import with no taxonomyId; the stored book carries an open
 * taxonomy inferred from the column and every position's tag. A run with a view by region then pivots, and each tag
 * report sums to the run's own family totals (NII over 12 and 24 months, the balance and interest series, value).
 * The expected side is the engine's family-level result, which the pivot never reads.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildChartOfAccounts, vanillaAssumptionSet, vanillaScenarios } from "@alm/data";
import { pivot, type PortfolioSpec, type RunResult } from "@alm/engine";
import { buildRunResult } from "@alm/engine/src/run/orchestrate";
import { resolveDefaultContext } from "@alm/engine/src/run/engine";
import { repoRoot } from "../config";
import { api, bootTestPlatform, loadTestMarket, type TestPlatform } from "./harness";

let tp: TestPlatform;
let book: PortfolioSpec;
let result: RunResult;
const REGIONS = ["east", "west", "north"];

beforeAll(async () => {
  tp = await bootTestPlatform();
  tp.platform.context.store.putDocument("coa", "demo-coa-v1", buildChartOfAccounts(), { label: "demo coa" });
  const lines = readFileSync(join(repoRoot(), "examples", "positions-template-v1.csv"), "utf8").trim().split(/\r?\n/);
  const csv = [`${lines[0]},dim.region`, ...lines.slice(1).map((l, i) => `${l},${REGIONS[i % 3]}`)].join("\r\n");
  const r = await api<{ id: string; warnings: string[] }>(tp.base, "POST", "/api/portfolios/import?format=csv&coaId=demo-coa-v1&label=Tagged%20template&portfolioId=tagged-template&asOf=2026-03-31", csv);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  book = (await api<PortfolioSpec>(tp.base, "GET", `/api/portfolios/${r.body.id}`)).body;
  const set = vanillaAssumptionSet();
  result = buildRunResult(
    {
      runId: "RUN-TAGS",
      portfolioId: book.id,
      marketSnapshot: await loadTestMarket(),
      scenarios: vanillaScenarios(set.id),
      assumptionSets: [set],
      grid: { horizonMonths: 360, asOf: book.asOf },
      views: [{ id: "by-region", label: "By region", groupBy: ["region"] }],
      seed: "7",
      timestamps: { startedAt: "", finishedAt: "" },
    },
    book,
    resolveDefaultContext(),
  );
}, 120_000);

afterAll(async () => {
  await tp.close();
});

describe("CSV dim. columns: an inferred open taxonomy, then a tag report", () => {
  it("stores the book with the inferred taxonomy and every position's tag", () => {
    expect(book.taxonomy).toEqual({
      schemaVersion: "1.0.0",
      id: "tagged-template-tags",
      label: "Tags read from the columns of Tagged template",
      dimensions: [{ id: "region", label: "region" }],
    });
    expect(book.positions.length).toBe(8);
    expect(book.positions.map((p) => p.dimensions?.region)).toEqual(["east", "west", "north", "east", "west", "north", "east", "west"]);
  });

  it("each tag report sums to the run's family totals, in every scenario", () => {
    for (const s of result.nii.byScenario) {
      const nii = pivot(result, { viewId: "by-region", metric: "nii", scenarioId: s.scenarioId });
      expect(nii.rows.map((r) => r.key.region).sort()).toEqual([...REGIONS].sort());
      const net12 = nii.rows.reduce((a, r) => a + r.nii!.net12, 0);
      const net24 = nii.rows.reduce((a, r) => a + r.nii!.net24, 0);
      expect(Math.abs(net12 - s.byFamily.reduce((a, f) => a + f.net12, 0))).toBeLessThan(1e-6);
      expect(Math.abs(net24 - s.byFamily.reduce((a, f) => a + f.net24, 0))).toBeLessThan(1e-6);
      const cf = result.cashflows.byScenario.find((x) => x.scenarioId === s.scenarioId)!;
      for (const metric of ["balance", "interest", "principal"] as const) {
        const p = pivot(result, { viewId: "by-region", metric, scenarioId: s.scenarioId });
        for (const k of [0, 11, 59]) {
          const byTag = p.rows.reduce((a, r) => a + r.series![k]!, 0);
          const byFam = cf.byFamily.reduce((a, f) => a + f.series[metric][k]!, 0);
          expect(Math.abs(byTag - byFam), `${metric} ${k}`).toBeLessThan(1e-6 * Math.max(1, Math.abs(byFam)));
        }
      }
      const eve = result.eve.byScenario.find((x) => x.scenarioId === s.scenarioId)!;
      const pv = pivot(result, { viewId: "by-region", metric: "evePv", scenarioId: s.scenarioId });
      const gross = eve.byFamily.reduce((a, f) => a + f.pv, 0);
      expect(Math.abs(pv.rows.reduce((a, r) => a + r.value!, 0) - gross)).toBeLessThan(1e-6 * Math.abs(gross));
    }
  });

  it("fix round M2: blank cells import as Unassigned, counted in one line, and a run with a view by the tag does not fail", async () => {
    const lines = readFileSync(join(repoRoot(), "examples", "positions-template-v1.csv"), "utf8").trim().split(/\r?\n/);
    // Positions 2 and 5 carry no region.
    const csv = [`${lines[0]},dim.region`, ...lines.slice(1).map((l, i) => `${l},${i === 1 || i === 4 ? "" : REGIONS[i % 3]}`)].join("\r\n");
    const r = await api<{ id: string; warnings: string[] }>(tp.base, "POST", "/api/portfolios/import?format=csv&coaId=demo-coa-v1&label=Blank%20tags&portfolioId=blank-tags&asOf=2026-03-31", csv);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.warnings).toContain("2 positions have no region; they are grouped as Unassigned.");
    const blank = (await api<PortfolioSpec>(tp.base, "GET", `/api/portfolios/${r.body.id}`)).body;
    expect(blank.positions.map((p) => p.dimensions?.region)).toEqual(["east", "Unassigned", "north", "east", "Unassigned", "north", "east", "west"]);
    const set = vanillaAssumptionSet();
    const run = buildRunResult(
      { runId: "RUN-BLANK", portfolioId: blank.id, marketSnapshot: await loadTestMarket(), scenarios: vanillaScenarios(set.id).slice(0, 1), assumptionSets: [set], grid: { horizonMonths: 360, asOf: blank.asOf }, views: [{ id: "by-region", label: "By region", groupBy: ["region"] }], seed: "7", timestamps: { startedAt: "", finishedAt: "" } },
      blank,
      resolveDefaultContext(),
    );
    const p = pivot(run, { viewId: "by-region", metric: "balance", scenarioId: "S0" });
    expect(p.rows.map((x) => x.key.region)).toEqual(["Unassigned", "east", "north", "west"]);
    const byFam = run.cashflows.byScenario[0]!.byFamily.reduce((a, f) => a + f.series.balance[0]!, 0);
    expect(Math.abs(p.rows.reduce((a, x) => a + x.series![0]!, 0) - byFam)).toBeLessThan(1e-6);
  });

  it("fix round M2: a dim. column blank on every row declares no tag, and the summary says so", async () => {
    const lines = readFileSync(join(repoRoot(), "examples", "positions-template-v1.csv"), "utf8").trim().split(/\r?\n/);
    const csv = [`${lines[0]},dim.region`, ...lines.slice(1).map((l) => `${l},`)].join("\r\n");
    const r = await api<{ id: string; warnings: string[] }>(tp.base, "POST", "/api/portfolios/import?format=csv&coaId=demo-coa-v1&label=No%20tags&portfolioId=no-tags&asOf=2026-03-31", csv);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.warnings).toContain("The column dim.region is blank on every row, so it is not read as a tag.");
    const b = (await api<PortfolioSpec>(tp.base, "GET", `/api/portfolios/${r.body.id}`)).body;
    expect(b.taxonomy).toBeUndefined();
  });

  it("fix round M1: on a scenario with new volume the pivot keeps value and both gap ladders by tag, and refuses the cell measures", async () => {
    const set = vanillaAssumptionSet();
    const dynamic = vanillaScenarios(set.id).slice(0, 2).map((sc) => ({ ...sc, newBusiness: { mode: "dynamic" as const, rules: book.coa.families.filter((f) => book.positions.some((p) => p.familyId === f.id)).map((f) => ({ familyId: f.id, reinvest: "flat" as const })) } }));
    const run = buildRunResult(
      { runId: "RUN-DYN", portfolioId: book.id, marketSnapshot: await loadTestMarket(), scenarios: dynamic, assumptionSets: [set], grid: { horizonMonths: 360, asOf: book.asOf }, views: [{ id: "by-region", label: "By region", groupBy: ["region"] }], seed: "7", timestamps: { startedAt: "", finishedAt: "" } },
      book,
      resolveDefaultContext(),
    );
    for (const s of run.eve.byScenario) {
      expect(run.cashflows.byScenario.find((c) => c.scenarioId === s.scenarioId)!.byCell).toBeUndefined();
      for (const m of ["balance", "principal", "interest", "nii"] as const) expect(() => pivot(run, { viewId: "by-region", metric: m, scenarioId: s.scenarioId })).toThrow(/cannot be answered/);
      const pv = pivot(run, { viewId: "by-region", metric: "evePv", scenarioId: s.scenarioId });
      const gross = s.byFamily.reduce((a, f) => a + f.pv, 0);
      expect(Math.abs(pv.rows.reduce((a, r) => a + r.value!, 0) - gross)).toBeLessThan(1e-6 * Math.abs(gross));
      for (const [metric, ladders] of [["repricing", run.gap.repricing], ["gapPrincipal", run.gap.liquidity]] as const) {
        const g = pivot(run, { viewId: "by-region", metric, scenarioId: s.scenarioId });
        const rows = ladders.find((l) => l.scenarioId === s.scenarioId)!.rows;
        rows.forEach((band, i) => expect(Math.abs(g.rows.reduce((a, r) => a + r.series![i]!, 0) - (band.assets - band.liabilities))).toBeLessThan(1e-4));
      }
    }
  });
});
