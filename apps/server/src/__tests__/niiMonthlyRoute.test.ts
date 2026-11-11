/**
 * Studio A+E contract 7, the refusal half: GET /api/runs/:id/result/nii/monthly
 * answers a cash flow family the pinned portfolio's chart does not carry with a
 * 422 naming the typed engine error and the family, never a 500.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { niiMonthly, niiMonthlyChart } from "@alm/engine";
import { buildRunResult, resolveDefaultContext } from "@alm/engine/src/run";
import { baseAssumptions, regulatoryScenarios, twoSidedBook } from "@alm/engine/src/run/__tests__/fixtures";
import type { RunStatus } from "../jobs/types";
import { api, bootTestPlatform, loadTestMarket, type TestPlatform } from "./harness";

let tp: TestPlatform;
const RUN = "run-nii-monthly-coa-gap";
const PORTFOLIO = "pf-nii-monthly-coa-gap";
const RUN_FULL = "run-nii-monthly-coa-full";
const PORTFOLIO_FULL = "pf-nii-monthly-coa-full";
let fullBook: ReturnType<typeof twoSidedBook>;
let fullResult: ReturnType<typeof buildRunResult>;

beforeAll(async () => {
  tp = await bootTestPlatform();
  const store = tp.platform.context.store;
  const book = twoSidedBook(PORTFOLIO);
  const set = baseAssumptions("AS-NII-MONTHLY");
  const market = await loadTestMarket();
  const startedAt = new Date().toISOString();
  const result = buildRunResult(
    {
      runId: RUN,
      portfolioId: book.id,
      marketSnapshot: market,
      scenarios: regulatoryScenarios(set.id),
      assumptionSets: [set],
      grid: { horizonMonths: 360, asOf: book.asOf },
      seed: "platform-0",
      timestamps: { startedAt, finishedAt: startedAt },
    },
    book,
    { ...resolveDefaultContext(), durationMode: "base-only" },
  );
  // The stored portfolio's chart drops MMA, which the stored cash flow block carries.
  const gapped = { ...book, coa: { ...book.coa, families: book.coa.families.filter((f) => f.id !== "MMA") } };
  store.putDocument("portfolios", PORTFOLIO, gapped, {});
  const { writeFileAtomic } = await import("../store/store");
  const { join } = await import("node:path");
  writeFileAtomic(join(store.paths.runDir(RUN), "result.json"), `${JSON.stringify(result)}\n`);
  store.writeRunJson(RUN, "request.json", {
    submission: { portfolioId: PORTFOLIO, marketId: "m", scenarioSlateId: "s", assumptionSetIds: [set.id], scenarios: [] },
  });
  const status: RunStatus = {
    runId: RUN,
    state: "done",
    phase: "done",
    submittedAt: startedAt,
    startedAt,
    endedAt: new Date().toISOString(),
    platformRequestHash: "test",
    summary: { portfolioId: PORTFOLIO, marketId: "m", scenarioSlateId: "s", scenarioCount: 5 },
  };
  store.writeRunJson(RUN, "status.json", status);
  store.appendRunLog(RUN, { t: "status", state: "done", at: startedAt });
  // The same result over the full chart, for the reply's chart field.
  store.putDocument("portfolios", PORTFOLIO_FULL, { ...book, id: PORTFOLIO_FULL }, {});
  writeFileAtomic(join(store.paths.runDir(RUN_FULL), "result.json"), `${JSON.stringify(result)}\n`);
  store.writeRunJson(RUN_FULL, "request.json", {
    submission: { portfolioId: PORTFOLIO_FULL, marketId: "m", scenarioSlateId: "s", assumptionSetIds: [set.id], scenarios: [] },
  });
  store.writeRunJson(RUN_FULL, "status.json", { ...status, runId: RUN_FULL, summary: { ...status.summary, portfolioId: PORTFOLIO_FULL } });
  store.appendRunLog(RUN_FULL, { t: "status", state: "done", at: startedAt });
  fullBook = book;
  fullResult = result;
}, 180_000);

afterAll(async () => {
  await tp.close();
});

describe("GET /api/runs/:id/result/nii/monthly", () => {
  it("422s a family missing from the pinned chart, naming the typed error and the family", async () => {
    const r = await api<{ error: { code: string; message: string; detail: { error: string; familyId: string } } }>(
      tp.base,
      "GET",
      `/api/runs/${RUN}/result/nii/monthly`,
    );
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("validation");
    expect(r.body.error.detail).toEqual({ error: "NiiMonthlyUnavailableError", familyId: "MMA" });
    expect(r.body.error.message).toBe('monthly NII cannot be read from this run: family "MMA" is in the cash flow block and not in the chart of accounts');
  });

  it("adds the chart the card needs after the reader's fields, which keep their bytes", async () => {
    const r = await api<Record<string, unknown>>(tp.base, "GET", `/api/runs/${RUN_FULL}/result/nii/monthly`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(["kind", "horizonMonths", "byScenario", "coa"]);
    const { coa, ...reader } = r.body;
    expect(JSON.stringify(reader)).toBe(JSON.stringify(niiMonthly(fullResult, fullBook.coa)));
    expect(coa).toEqual(niiMonthlyChart(fullBook.coa));
    const chart = coa as { nodes: unknown[]; families: Array<Record<string, unknown>> };
    expect(chart.nodes.length).toBe(fullBook.coa.nodes.length);
    expect(Object.keys(chart.families[0]!)).toEqual(["id", "side", "instrumentType"]);
    expect(chart.families.map((f) => f.instrumentType)).toEqual(fullBook.coa.families.map((f) => f.instrumentType));
  });
});
