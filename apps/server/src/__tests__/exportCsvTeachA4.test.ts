/**
 * Teaching build slice A4, the route: GET /api/runs/:id/export/<table>.csv serves the run's own gap buckets, the
 * interest-inclusive liquidity ladder and FTP, and refuses with a 409 naming why when the run does not store the
 * table. A run that asked for custom repricing buckets, monthly liquidity buckets and principal plus interest gives
 * all four; a plain run gives FTP only. The six older tables keep their header rows: no note row.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunResult } from "@alm/engine";
import { buildVanillaPortfolio, vanillaAssumptionSet, vanillaScenarios } from "@alm/data";
import type { RunStatus } from "../jobs/types";
import { api, bootTestPlatform, loadTestMarket, waitFor, type TestPlatform } from "./harness";

let tp: TestPlatform;
let plain: string;
let rich: string;

const submit = async (engineOptions?: Record<string, unknown>): Promise<string> => {
  const r = await api<{ runId: string }>(tp.base, "POST", "/api/runs", {
    portfolioId: "vanilla-book-v1",
    marketId: "market-test",
    scenarioSlateId: "grid",
    assumptionSetIds: ["vanilla-empty-v1"],
    ...(engineOptions === undefined ? {} : { engineOptions }),
  });
  expect(r.status).toBe(202);
  const done = await waitFor(
    async () => (await api<RunStatus>(tp.base, "GET", `/api/runs/${r.body.runId}`)).body,
    (s) => s.state === "done" || s.state === "error",
    120_000,
  );
  expect(done.state, JSON.stringify(done.error ?? {})).toBe("done");
  return r.body.runId;
};

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
  plain = await submit();
  rich = await submit({
    gapBuckets: { kind: "custom", edgesMonths: [3, 12, 60] },
    liquidityBuckets: { kind: "monthly" },
    liquidityFlows: "principal-plus-interest",
  });
}, 300_000);

afterAll(async () => {
  await tp.close();
});

const NOTE = "# note,Every value is the stored engine figure at full precision; the screen rounds for display.";

describe("slice A4 export routes", () => {
  it("serves the four tables of a run that stores them, each figure verbatim from the envelope", async () => {
    const result = (await api<RunResult>(tp.base, "GET", `/api/runs/${rich}/result`)).body;
    const base = result.gap.liquidity[0]!;
    for (const table of ["repricing-gap-buckets", "liquidity-gap-buckets", "liquidity-gap-interest", "ftp"]) {
      const r = await api(tp.base, "GET", `/api/runs/${rich}/export/${table}.csv`);
      expect(r.status, table).toBe(200);
      expect(r.headers.get("content-disposition")).toBe(`attachment; filename="${rich}-${table}.csv"`);
      const lines = r.text.split("\r\n");
      expect(lines[0]).toBe(`# runId,${rich}`);
      expect(lines[6]).toBe(NOTE);
    }
    const rep = (await api(tp.base, "GET", `/api/runs/${rich}/export/repricing-gap-buckets.csv`)).text.split("\r\n");
    const u = result.gap.repricing[0]!.userBuckets!;
    expect(u.kind).toBe("custom");
    const first = u.rows[0]!;
    expect(rep[8]).toBe(
      [result.gap.repricing[0]!.scenarioId, "custom", first.band.label, first.band.startMonth, first.band.endMonth, first.assets, first.liabilities, first.gap, first.cumulativeGap].join(","),
    );
    const liq = (await api(tp.base, "GET", `/api/runs/${rich}/export/liquidity-gap-buckets.csv`)).text.split("\r\n");
    // Header, note and five comment rows, then one row per month per scenario, then the closing blank.
    const months = result.gap.liquidity.reduce((n, l) => n + (l.userBuckets?.rows.length ?? 0), 0);
    expect(liq.length).toBe(8 + months + 1);
    const int = (await api(tp.base, "GET", `/api/runs/${rich}/export/liquidity-gap-interest.csv`)).text.split("\r\n");
    const t0 = base.withInterest!.rows[0]!;
    const i0 = base.withInterest!.interest.rows[0]!;
    expect(int[8]).toBe(
      [base.scenarioId, "standard", t0.band.label, t0.band.startMonth, t0.band.endMonth, t0.assets, t0.liabilities, t0.gap, t0.cumulativeGap, i0.assets, i0.liabilities, i0.gap, i0.cumulativeGap].join(","),
    );
    const ftp = (await api(tp.base, "GET", `/api/runs/${rich}/export/ftp.csv`)).text.split("\r\n");
    expect(ftp.filter((l) => l.startsWith(`${result.ftp!.scenarioId},family,`))).toHaveLength(result.ftp!.byFamily.length);
    expect(ftp.find((l) => l.startsWith(`${result.ftp!.scenarioId},bridge,`))).toContain(String(result.ftp!.nimBridge.niiNet12));
  });

  it("refuses the bucket and interest tables of a plain run with a 409 naming why, and serves its FTP", async () => {
    type Refusal = { error: { code: string; message: string } };
    const b = await api<Refusal>(tp.base, "GET", `/api/runs/${plain}/export/repricing-gap-buckets.csv`);
    expect(b.status).toBe(409);
    expect(b.body.error.message).toBe(
      `run "${plain}" cannot export repricing-gap-buckets.csv: this run stores the repricing gap in the nine standard bands only ` +
        "(no gap.repricing userBuckets); export repricing-gap.csv instead",
    );
    const i = await api<Refusal>(tp.base, "GET", `/api/runs/${plain}/export/liquidity-gap-interest.csv`);
    expect(i.status).toBe(409);
    expect(i.body.error.message).toMatch(/principal-plus-interest/);
    expect((await api(tp.base, "GET", `/api/runs/${plain}/export/ftp.csv`)).status).toBe(200);
    const c = await api<Refusal>(tp.base, "GET", `/api/compare.csv?runs=${rich},${plain}&table=liquidity-gap-buckets`);
    expect(c.status).toBe(409);
    expect(c.body.error.message).toContain(`run "${plain}" cannot export liquidity-gap-buckets.csv`);
  });

  it("keeps the older tables' header rows: no note row, the column row straight after generatedAt", async () => {
    for (const table of ["nii", "eve", "repricing-gap", "liquidity-gap", "attribution", "cashflows"]) {
      const lines = (await api(tp.base, "GET", `/api/runs/${rich}/export/${table}.csv`)).text.split("\r\n");
      expect(lines[5], table).toMatch(/^# generatedAt,/);
      expect(lines[6], table).not.toMatch(/^#/);
    }
  });

  it("names every table in the unknown-table refusal", async () => {
    const r = await api<{ error: { message: string } }>(tp.base, "GET", `/api/runs/${plain}/export/bogus.csv`);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe(
      'unknown export table "bogus"; tables: nii, eve, repricing-gap, liquidity-gap, attribution, cashflows, ' +
        "repricing-gap-buckets, liquidity-gap-buckets, liquidity-gap-interest, ftp, liquidity-stress, survival-path, rollup-quarterly, rollup-annual",
    );
  });
});
