/**
 * Piece 2b acceptance (e), the HTTP half: the pivot answers off result.json on
 * disk, re-deriving nothing (the roll-up is the engine's pure `pivot` over the
 * stored envelope, not a re-run), 400s a missing parameter and 422s the typed
 * refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRunResult, resolveDefaultContext } from "@alm/engine/src/run";
import {
  BY_SEGMENT_VIEW,
  baseAssumptions,
  regulatoryScenarios,
  viewSegmentedBook,
} from "@alm/engine/src/run/__tests__/fixtures";
import type { RunStatus } from "../jobs/types";
import { api, bootTestPlatform, loadTestMarket, type TestPlatform } from "./harness";

let tp: TestPlatform;
const VIEW_RUN = "run-pivot-view";
const PLAIN_RUN = "run-pivot-plain";

async function seed(runId: string, views: unknown[] | undefined): Promise<void> {
  const store = tp.platform.context.store;
  const book = viewSegmentedBook();
  const set = baseAssumptions("AS-PIVOT-HTTP");
  const market = await loadTestMarket();
  const startedAt = new Date().toISOString();
  const result = buildRunResult(
    {
      runId,
      portfolioId: book.id,
      marketSnapshot: market,
      scenarios: regulatoryScenarios(set.id),
      assumptionSets: [set],
      grid: { horizonMonths: 360, asOf: book.asOf },
      seed: "platform-0",
      timestamps: { startedAt, finishedAt: startedAt },
      ...(views !== undefined ? { views: views as never } : {}),
    },
    book,
    { ...resolveDefaultContext(), durationMode: "base-only" },
  );
  const { writeFileAtomic } = await import("../store/store");
  const { join } = await import("node:path");
  writeFileAtomic(join(store.paths.runDir(runId), "result.json"), `${JSON.stringify(result)}\n`);
  const status: RunStatus = {
    runId,
    state: "done",
    phase: "done",
    submittedAt: startedAt,
    startedAt,
    endedAt: new Date().toISOString(),
    platformRequestHash: "test",
    summary: { portfolioId: book.id, marketId: "m", scenarioSlateId: "s", scenarioCount: 5 },
  };
  store.writeRunJson(runId, "status.json", status);
  store.appendRunLog(runId, { t: "status", state: "done", at: startedAt });
}

beforeAll(async () => {
  tp = await bootTestPlatform();
  await seed(VIEW_RUN, [BY_SEGMENT_VIEW]);
  await seed(PLAIN_RUN, undefined);
}, 180_000);

afterAll(async () => {
  await tp.close();
});

describe("GET /api/runs/:id/pivot", () => {
  it("answers 200 with one row per group, off the stored result", async () => {
    const r = await api<{
      rows: Array<{ key: Record<string, string>; positionCount: number }>;
      groupBy: string[];
    }>(tp.base, "GET", `/api/runs/${VIEW_RUN}/pivot?view=by-segment&metric=balance&scenarioId=S0`);
    expect(r.status).toBe(200);
    expect(r.body.groupBy).toEqual(["segment"]);
    expect(r.body.rows.map((x) => [x.key.segment, x.positionCount])).toEqual([
      ["rate-shopper", 2],
      ["relationship", 1],
      ["whole-book", 3],
    ]);
  });

  /**
   * scenarioId threading. Every other case on this route passes S0, so a route
   * that ignored the parameter and asked the engine for the base scenario would
   * answer all of them. One metric over two scenarios of one run pins it: the
   * echoed id follows the parameter, and the number moves with it. evePv is the
   * metric chosen because the discount function moves under a 100 bp shock, so
   * the inequality rests on discounting a non-empty book rather than on this
   * fixture's particular balance paths.
   */
  it("threads scenarioId through rather than answering off the base scenario", async () => {
    const ask = (scenarioId: string) =>
      api<{ scenarioId: string; total: number }>(
        tp.base,
        "GET",
        `/api/runs/${VIEW_RUN}/pivot?view=by-segment&metric=evePv&scenarioId=${scenarioId}`,
      );
    const base = await ask("S0");
    const up = await ask("S100");
    expect(base.status).toBe(200);
    expect(up.status).toBe(200);
    expect(base.body.scenarioId).toBe("S0");
    expect(up.body.scenarioId).toBe("S100");
    expect(up.body.total).not.toBe(base.body.total);
  });

  it("400s each missing parameter, naming it", async () => {
    const partials = [
      "metric=balance&scenarioId=S0",
      "view=by-segment&scenarioId=S0",
      "view=by-segment&metric=balance",
    ];
    for (const q of partials) {
      const r = await api<{ error: { message: string } }>(tp.base, "GET", `/api/runs/${VIEW_RUN}/pivot?${q}`);
      expect(r.status).toBe(400);
      expect(r.body.error.message).toContain("pivot requires");
    }
  });

  it("422s an unknown view and an unknown metric, with the engine message verbatim", async () => {
    const unknownView = await api<{ error: { message: string; detail: { error: string } } }>(
      tp.base,
      "GET",
      `/api/runs/${VIEW_RUN}/pivot?view=by-vintage&metric=balance&scenarioId=S0`,
    );
    expect(unknownView.status).toBe(422);
    expect(unknownView.body.error.detail.error).toBe("PivotUnavailableError");
    expect(unknownView.body.error.message).toContain("by-vintage");

    const unknownMetric = await api<{ error: { message: string } }>(
      tp.base,
      "GET",
      `/api/runs/${VIEW_RUN}/pivot?view=by-segment&metric=ftpMargin&scenarioId=S0`,
    );
    expect(unknownMetric.status).toBe(422);
    expect(unknownMetric.body.error.message).toContain("ftpMargin");
  });

  it("422s a run that declared no view rather than answering with family numbers", async () => {
    const r = await api<{ error: { message: string } }>(
      tp.base,
      "GET",
      `/api/runs/${PLAIN_RUN}/pivot?view=by-segment&metric=nii&scenarioId=S0`,
    );
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("declared no views");
  });

  it("404s an unknown run id", async () => {
    const r = await api(tp.base, "GET", "/api/runs/no-such-run/pivot?view=v&metric=balance&scenarioId=S0");
    expect(r.status).toBe(404);
  });
});
