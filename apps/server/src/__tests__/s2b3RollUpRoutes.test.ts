/**
 * The roll-up route and CSV serve the engine's one roll-up reader. A vanilla run with monthly gap
 * buckets is rolled by quarter and by year: the first year's net interest income equals the run's own stored 12-month
 * total, four quarters add to it, the quarterly repricing gap is the sum of three stored monthly bands, and the CSV
 * writes the reply's figures verbatim. Bad options are refused by name.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RollUpReply, RunResult } from "@alm/engine";
import { buildVanillaPortfolio, vanillaAssumptionSet, vanillaScenarios } from "@alm/data";
import type { RunStatus } from "../jobs/types";
import { api, bootTestPlatform, loadTestMarket, waitFor, type TestPlatform } from "./harness";

let tp: TestPlatform;
let runId: string;
let result: RunResult;

beforeAll(async () => {
  tp = await bootTestPlatform();
  const store = tp.platform.context.store;
  const set = vanillaAssumptionSet();
  const scenarios = vanillaScenarios(set.id);
  const vanilla = buildVanillaPortfolio();
  store.putDocument("portfolios", vanilla.id, vanilla, { label: vanilla.label, asOf: vanilla.asOf, positionCount: vanilla.positions.length });
  store.putDocument("market", "market-test", await loadTestMarket(), { label: "test market" });
  store.putDocument("assumption-sets", set.id, { ...set }, { label: set.label });
  store.putDocument("scenario-slates", "grid", { id: "grid", label: "grid", scenarios }, { label: "grid", scenarioCount: scenarios.length });
  const r = await api<{ runId: string }>(tp.base, "POST", "/api/runs", {
    portfolioId: vanilla.id, marketId: "market-test", scenarioSlateId: "grid", assumptionSetIds: [set.id],
    engineOptions: { gapBuckets: { kind: "monthly" }, liquidityBuckets: { kind: "monthly" } },
  });
  runId = r.body.runId;
  const done = await waitFor(async () => (await api<RunStatus>(tp.base, "GET", `/api/runs/${runId}`)).body, (s) => s.state === "done" || s.state === "error", 120_000);
  expect(done.state).toBe("done");
  result = (await api<RunResult>(tp.base, "GET", `/api/runs/${runId}/result`)).body;
}, 300_000);

afterAll(async () => {
  await tp.close();
});

describe("GET /api/runs/:id/result/rollup and the roll-up CSV", () => {
  it("rolls by year and quarter: the first year is the stored 12-month total, the quarterly gap sums three monthly bands", async () => {
    const y = (await api<RollUpReply>(tp.base, "GET", `/api/runs/${runId}/result/rollup?period=year`)).body;
    const q = (await api<RollUpReply>(tp.base, "GET", `/api/runs/${runId}/result/rollup?period=quarter`)).body;
    if (y.kind !== "rolled" || q.kind !== "rolled") throw new Error("expected roll-ups");
    expect(y.periods.length).toBe(30);
    expect(q.periods[0]).toEqual({ label: "Quarter 1", firstMonth: 1, lastMonth: 3, months: 3, partial: false });
    for (const s of result.nii.byScenario) {
      const ys = y.byScenario.find((x) => x.scenarioId === s.scenarioId)!;
      const qs = q.byScenario.find((x) => x.scenarioId === s.scenarioId)!;
      expect(Math.abs(ys.net[0]! - s.totalNet12)).toBeLessThan(1e-6);
      expect(Math.abs(qs.net.slice(0, 4).reduce((a, b) => a + b, 0) - s.totalNet12)).toBeLessThan(1e-6);
      const bands = result.gap.repricing.find((g) => g.scenarioId === s.scenarioId)!.userBuckets!.rows;
      expect(qs.gap!.repricing![1]!.gap).toBe(bands[3]!.gap + bands[4]!.gap + bands[5]!.gap);
      expect(qs.gap!.repricing![1]!.cumulativeGap).toBe(bands[5]!.cumulativeGap);
    }
  });

  it("writes the reply verbatim in the CSV, periods on the calendar when asked", async () => {
    const q = (await api<RollUpReply>(tp.base, "GET", `/api/runs/${runId}/result/rollup?period=quarter&align=calendar&months=24`)).body;
    if (q.kind !== "rolled") throw new Error("expected a roll-up");
    const r = await api(tp.base, "GET", `/api/runs/${runId}/export/rollup-quarterly.csv?align=calendar&months=24`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toBe(`attachment; filename="${runId}-rollup-quarterly.csv"`);
    const lines = r.text.split("\r\n");
    const head = lines.findIndex((l) => l.startsWith("scenarioId,"));
    const first = lines[head + 1]!.split(",");
    const s0 = q.byScenario[0]!;
    expect(first.slice(0, 4)).toEqual([s0.scenarioId, "total", "", q.periods[0]!.label]);
    expect(Number(first[10])).toBe(s0.net[0]);
    expect(lines.some((l) => l.startsWith("# note,") && l.includes("Rates are a ratio of sums"))).toBe(true);
  });

  it("refuses a bad period, a bad alignment and a month count past the grid, by name", async () => {
    expect((await api(tp.base, "GET", `/api/runs/${runId}/result/rollup?period=month`)).status).toBe(400);
    expect((await api(tp.base, "GET", `/api/runs/${runId}/result/rollup?period=year&align=fiscal`)).status).toBe(400);
    const past = await api<{ error: { message: string } }>(tp.base, "GET", `/api/runs/${runId}/result/rollup?period=year&months=999`);
    expect(past.status).toBe(422);
    expect(past.body.error.message).toContain("from 1 to the run's grid of 360");
  });
});
