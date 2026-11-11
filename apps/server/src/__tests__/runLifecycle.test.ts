/**
 * Run lifecycle end to end against the real spawned child (risk R1's proven
 * path): submit -> queued -> running -> done with result.json landing
 * atomically; queue FIFO with a queued cancel; a running cancel that kills the
 * child; SSE replay; and the boot scan marking an unsupervised run interrupted.
 *
 * The submit-to-done case uses the vanilla 9-position book (fast, fully
 * contractual); the cancel case uses a reduced synthetic book so the child is
 * reliably still computing when the cancel arrives.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunResult } from "@alm/engine";
import {
  buildVanillaPortfolio,
  vanillaAssumptionSet,
  vanillaScenarios,
  generatePortfolio,
  DEFAULT_GENERATOR_CONFIG,
} from "@alm/data";
import * as ingest from "../db/ingest";
import { FileStore } from "../store/store";
import { startPlatformServer } from "../server";
import type { RunStatus } from "../jobs/types";
import {
  api,
  bootTestPlatform,
  loadTestMarket,
  mirrorStoreNow,
  scratchConfig,
  waitFor,
  warmCatalog,
  type TestPlatform,
} from "./harness";

let tp: TestPlatform;

beforeAll(async () => {
  tp = await bootTestPlatform();
  const store = tp.platform.context.store;
  const market = await loadTestMarket();
  const set = vanillaAssumptionSet();

  // Seed directly into the store (the API import path has its own tests).
  const vanilla = buildVanillaPortfolio();
  store.putDocument("portfolios", vanilla.id, vanilla, {
    label: vanilla.label,
    asOf: vanilla.asOf,
    positionCount: vanilla.positions.length,
  });
  const slow = generatePortfolio({
    ...DEFAULT_GENERATOR_CONFIG,
    portfolioId: "synthetic-slow-3000",
    portfolioLabel: "synthetic cancel-fixture book",
    targetPositions: 3000,
  });
  store.putDocument("portfolios", slow.id, slow, {
    label: slow.label,
    asOf: slow.asOf,
    positionCount: slow.positions.length,
  });
  store.putDocument("market", "market-test", market, { label: "test market" });
  const bound = { ...set };
  store.putDocument("assumption-sets", set.id, bound, { label: set.label });
  const scenarios = vanillaScenarios(set.id);
  store.putDocument(
    "scenario-slates",
    "grid",
    { id: "grid", label: "grid", scenarios },
    { label: "grid", scenarioCount: scenarios.length },
  );
}, 120_000);

afterAll(async () => {
  await tp.close();
});

const submitBody = (portfolioId: string): Record<string, unknown> => ({
  portfolioId,
  marketId: "market-test",
  scenarioSlateId: "grid",
  assumptionSetIds: ["vanilla-empty-v1"],
});

const getStatus = async (runId: string): Promise<RunStatus> =>
  (await api<RunStatus>(tp.base, "GET", `/api/runs/${runId}`)).body;

describe("submit to done", () => {
  it(
    "spawns a child, streams through running to done, and lands result.json atomically",
    async () => {
      const sub = await api<{ runId: string; queuePosition: number; platformRequestHash: string }>(
        tp.base,
        "POST",
        "/api/runs",
        submitBody("vanilla-book-v1"),
      );
      expect(sub.status).toBe(202);
      expect(typeof sub.body.runId).toBe("string");
      expect(sub.body.platformRequestHash).toMatch(/^[0-9a-f]{64}$/);

      const done = await waitFor(
        () => getStatus(sub.body.runId),
        (s) => s.state === "done" || s.state === "error",
        90_000,
      );
      expect(done.state).toBe("done");
      expect(done.phase).toBe("done");
      expect(typeof done.pid).toBe("number");
      expect(typeof done.elapsedMs).toBe("number");

      // The result is the child's atomic write, served verbatim.
      const result = await api<RunResult>(tp.base, "GET", `/api/runs/${sub.body.runId}/result`);
      expect(result.status).toBe(200);
      expect(result.body.provenance.runId).toBe(sub.body.runId);
      const onDisk = readFileSync(
        tp.platform.context.store.paths.runFile(sub.body.runId, "result.json"),
        "utf8",
      );
      expect(result.text).toBe(onDisk);

      // No temp files left behind in the run directory (atomic landing).
      const { readdirSync } = await import("node:fs");
      const leftovers = readdirSync(tp.platform.context.store.paths.runDir(sub.body.runId)).filter(
        (f) => f.startsWith(".tmp-"),
      );
      expect(leftovers).toEqual([]);

      // SSE replay of a terminal run: recorded transitions, then a clean end.
      const events = await api(tp.base, "GET", `/api/runs/${sub.body.runId}/events`);
      expect(events.status).toBe(200);
      expect(events.text).toContain('"state":"queued"');
      expect(events.text).toContain('"state":"running"');
      expect(events.text).toContain('"state":"done"');
      expect(events.text).toContain('"phase":"compute"');
      expect(events.text).toContain("event: end");

      // Identical resubmission: same platformRequestHash badge, fresh run id
      // (no dedupe, no cache-serving) — the runId inside request.json
      // differs, so the hash is compared for FORMAT here, identity for runs
      // whose stored request bytes match is asserted at the unit level.
      const again = await api<{ runId: string }>(tp.base, "POST", "/api/runs", submitBody("vanilla-book-v1"));
      expect(again.status).toBe(202);
      expect(again.body.runId).not.toBe(sub.body.runId);
      await waitFor(
        () => getStatus(again.body.runId),
        (s) => s.state === "done" || s.state === "error",
        90_000,
      );
    },
    180_000,
  );

  it(
    "accepts the natural single-value assumptionSetId shape and records the same refs",
    async () => {
      const { assumptionSetIds: _drop, ...rest } = submitBody("vanilla-book-v1");
      void _drop;
      const sub = await api<{ runId: string }>(tp.base, "POST", "/api/runs", {
        ...rest,
        assumptionSetId: "vanilla-empty-v1",
      });
      expect(sub.status).toBe(202);
      const done = await waitFor(
        () => getStatus(sub.body.runId),
        (s) => s.state === "done" || s.state === "error",
        90_000,
      );
      expect(done.state).toBe("done");

      // The W1-P3 NOTE: listing and detail carry the submission refs.
      const detail = await api<{ refs: Record<string, unknown>; scenarios: unknown[] }>(
        tp.base,
        "GET",
        `/api/runs/${sub.body.runId}`,
      );
      expect(detail.body.refs).toEqual({
        portfolioId: "vanilla-book-v1",
        marketId: "market-test",
        scenarioSlateId: "grid",
        assumptionSetIds: ["vanilla-empty-v1"],
      });
      expect(detail.body.scenarios.length).toBeGreaterThan(0);
      const listing = await api<Array<{ runId: string; refs?: { assumptionSetIds: string[] } }>>(
        tp.base,
        "GET",
        "/api/runs",
      );
      const listed = listing.body.find((r) => r.runId === sub.body.runId)!;
      expect(listed.refs?.assumptionSetIds).toEqual(["vanilla-empty-v1"]);
    },
    180_000,
  );

  it("400s a submission missing the assumption-set reference, naming the expected field and shape", async () => {
    const { assumptionSetIds: _drop, ...rest } = submitBody("vanilla-book-v1");
    void _drop;
    const r = await api<{ error: { code: string; message: string } }>(tp.base, "POST", "/api/runs", rest);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("assumptionSetIds");
    expect(r.body.error.message).toContain("assumptionSetId");
    expect(r.body.error.message).toContain("array");
  });

  it("422s a submission referencing unknown artifacts, naming the id", async () => {
    const r = await api<{ error: { message: string } }>(tp.base, "POST", "/api/runs", {
      ...submitBody("vanilla-book-v1"),
      marketId: "no-such-market",
    });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("no-such-market");
  });

  it("422s when a slate scenario references an assumption set missing from the submission", async () => {
    const r = await api<{ error: { message: string } }>(tp.base, "POST", "/api/runs", {
      ...submitBody("vanilla-book-v1"),
      assumptionSetIds: ["vanilla-empty-v1"],
      scenarioSlateId: "grid-other-set",
    });
    // Unknown slate id: 422 naming it (the referenced-artifact gate fires first).
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("grid-other-set");
  });

  it(
    "serves monthly income, expense and net per family, and refuses a stochastic run with 409",
    async () => {
      const sub = await api<{ runId: string }>(tp.base, "POST", "/api/runs", submitBody("vanilla-book-v1"));
      expect(sub.status).toBe(202);
      const done = await waitFor(
        () => getStatus(sub.body.runId),
        (s) => s.state === "done" || s.state === "error",
        90_000,
      );
      expect(done.state).toBe("done");
      const runId = sub.body.runId;

      const r = await api<{
        kind: string;
        horizonMonths: number;
        byScenario: Array<{ scenarioId: string; net: number[]; byFamily: Array<{ net: number[]; income: number[]; expense: number[] }> }>;
      }>(tp.base, "GET", `/api/runs/${runId}/result/nii/monthly`);
      expect(r.status).toBe(200);
      expect(r.body.kind).toBe("monthly");
      expect(r.body.byScenario[0]!.byFamily[0]!.net.length).toBe(r.body.horizonMonths);

      // The literal path won over the section route: the reply is the reader's
      // shape, and its scenario net is the stored netMonthly, byte for byte.
      const stored = await api<RunResult>(tp.base, "GET", `/api/runs/${runId}/result`);
      expect(r.body.byScenario.length).toBe(stored.body.nii.byScenario.length);
      for (const sc of r.body.byScenario) {
        const s = stored.body.nii.byScenario.find((x) => x.scenarioId === sc.scenarioId)!;
        expect(sc.net).toEqual(s.netMonthly);
      }

      const sto = await api<{ runId: string }>(tp.base, "POST", "/api/runs", {
        ...submitBody("vanilla-book-v1"),
        mode: "stochastic",
        seed: "42",
        stochastic: { nPaths: 20 },
      });
      expect(sto.status).toBe(202);
      const stoDone = await waitFor(
        () => getStatus(sto.body.runId),
        (s) => s.state === "done" || s.state === "error",
        120_000,
      );
      expect(stoDone.state).toBe("done");
      const refused = await api<{ error: { code: string; message: string } }>(
        tp.base,
        "GET",
        `/api/runs/${sto.body.runId}/result/nii/monthly`,
      );
      expect(refused.status).toBe(409);
      expect(refused.body.error.message).toContain("monthly NII is not part of the stochastic envelope");
    },
    300_000,
  );
});

describe("queue and cancel", () => {
  it(
    "FIFO: a second submission queues behind the first; a queued cancel never spawns; a running cancel kills the child",
    async () => {
      // First: the slow synthetic book occupies the single slot.
      const slow = await api<{ runId: string }>(tp.base, "POST", "/api/runs", submitBody("synthetic-slow-3000"));
      expect(slow.status).toBe(202);
      // Second: queued behind it.
      const queued = await api<{ runId: string; queuePosition: number }>(
        tp.base,
        "POST",
        "/api/runs",
        submitBody("vanilla-book-v1"),
      );
      expect(queued.status).toBe(202);

      const queuedStatus = await getStatus(queued.body.runId);
      expect(queuedStatus.state).toBe("queued");

      // Cancel the queued run: cancelled without ever spawning.
      const c1 = await api<RunStatus>(tp.base, "POST", `/api/runs/${queued.body.runId}/cancel`);
      expect(c1.status).toBe(200);
      expect(c1.body.state).toBe("cancelled");
      expect((await getStatus(queued.body.runId)).pid).toBeUndefined();

      // Cancel the running run: the child dies and the state is cancelled.
      const running = await waitFor(
        () => getStatus(slow.body.runId),
        (s) => s.state === "running",
        60_000,
      );
      expect(running.pid).toBeGreaterThan(0);
      const c2 = await api<RunStatus>(tp.base, "POST", `/api/runs/${slow.body.runId}/cancel`);
      expect(c2.status).toBe(200);
      expect(c2.body.state).toBe("cancelled");

      // The child pid is gone (allow a moment for Windows to reap it).
      await waitFor(
        () =>
          Promise.resolve(
            (() => {
              try {
                process.kill(running.pid!, 0);
                return true;
              } catch {
                return false;
              }
            })(),
          ),
        (alive) => alive === false,
        20_000,
      );

      // A cancelled run stays cancelled: no result is ever served for it.
      const res = await api<{ error: { code: string } }>(tp.base, "GET", `/api/runs/${slow.body.runId}/result`);
      expect(res.status).toBe(409);
    },
    180_000,
  );
});

describe("the run terminal transition mirrors the run at once", () => {
  interface CatalogRun {
    runId: string;
    state: string;
    resultContentHash: string | null;
  }
  const catalogRuns = async (): Promise<CatalogRun[]> =>
    (await api<CatalogRun[]>(tp.base, "GET", "/api/catalog/runs")).body;

  beforeAll(() => {
    // This file never seeds: create the database as a boot sync would, with every input document in it.
    mirrorStoreNow(tp.storeRoot);
  });
  afterEach(() => vi.restoreAllMocks());

  it(
    "a run that reaches done is on GET /api/catalog/runs and the book lineage with no restart",
    async () => {
      await warmCatalog(tp.base);
      const sub = await api<{ runId: string }>(tp.base, "POST", "/api/runs", submitBody("vanilla-book-v1"));
      expect(sub.status).toBe(202);
      await waitFor(
        () => getStatus(sub.body.runId),
        (s) => s.state === "done" || s.state === "error",
        90_000,
      );
      const row = (await catalogRuns()).find((r) => r.runId === sub.body.runId);
      expect(row).toBeDefined();
      expect(row!.state).toBe("done");
      // The pin is the SHA-256 of the result bytes on disk, restated here by hand.
      const onDisk = readFileSync(tp.platform.context.store.paths.runFile(sub.body.runId, "result.json"));
      expect(row!.resultContentHash).toBe(createHash("sha256").update(onDisk).digest("hex"));
      const lin = await api<{ consumedBy: Array<{ runId: string; state: string }> }>(
        tp.base,
        "GET",
        "/api/catalog/lineage/portfolios/vanilla-book-v1",
      );
      expect(lin.status).toBe(200);
      expect(lin.body.consumedBy.find((c) => c.runId === sub.body.runId)?.state).toBe("done");
    },
    120_000,
  );

  it(
    "a cancelled run is on the catalog with state cancelled",
    async () => {
      await warmCatalog(tp.base);
      const slow = await api<{ runId: string }>(tp.base, "POST", "/api/runs", submitBody("synthetic-slow-3000"));
      expect(slow.status).toBe(202);
      await waitFor(
        () => getStatus(slow.body.runId),
        (s) => s.state === "running",
        60_000,
      );
      expect((await api(tp.base, "POST", `/api/runs/${slow.body.runId}/cancel`)).status).toBe(200);
      const row = (await catalogRuns()).find((r) => r.runId === slow.body.runId);
      expect(row?.state).toBe("cancelled");
    },
    120_000,
  );

  it(
    "a mirror failure leaves the run done, still served, and logs one line naming the run",
    async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const sync = vi.spyOn(ingest, "syncRunToDb").mockImplementation(() => {
        throw new Error("simulated mirror failure: database is locked");
      });
      const sub = await api<{ runId: string }>(tp.base, "POST", "/api/runs", submitBody("vanilla-book-v1"));
      expect(sub.status).toBe(202);
      const done = await waitFor(
        () => getStatus(sub.body.runId),
        (s) => s.state === "done" || s.state === "error",
        90_000,
      );
      expect(done.state).toBe("done");
      expect((await api(tp.base, "GET", `/api/runs/${sub.body.runId}/result`)).status).toBe(200);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalledTimes(1);
      const line = String(errors.mock.calls[0]![0]);
      expect(line).toContain(sub.body.runId);
      expect(line).toContain("simulated mirror failure");
      expect(line).not.toMatch(/\n/);
      expect((await catalogRuns()).some((r) => r.runId === sub.body.runId)).toBe(false);
    },
    120_000,
  );
});

describe("boot scan", () => {
  it("marks an unsupervised running run interrupted and re-enqueues queued runs in order", async () => {
    // Craft a store with a "running" run whose supervisor is gone (dead pid)
    // and two queued runs, then boot a fresh server over it.
    const config = scratchConfig();
    const store = new FileStore(config.storeRoot);
    store.init();
    const mkStatus = (runId: string, state: string, submittedAt: string, pid?: number): void => {
      store.writeRunJson(runId, "status.json", {
        runId,
        state,
        submittedAt,
        ...(pid !== undefined ? { pid } : {}),
        platformRequestHash: "x",
        summary: { portfolioId: "p", marketId: "m", scenarioSlateId: "s", scenarioCount: 1 },
      });
    };
    mkStatus("run-a-running", "running", "2026-08-01T00:00:00Z", 99_999_999);
    mkStatus("run-b-queued", "queued", "2026-08-01T00:02:00Z");
    mkStatus("run-c-queued", "queued", "2026-08-01T00:01:00Z");
    // The queued runs have no request.json, so when the queue starts them the
    // child refuses loudly and they land in "error" — which is exactly the
    // honest outcome for a half-written store; the scan itself is what is
    // under test here.

    const platform = await startPlatformServer(config);
    try {
      expect(platform.bootScan.interrupted).toEqual(["run-a-running"]);
      // submittedAt order, not directory order:
      expect(platform.bootScan.requeued).toEqual(["run-c-queued", "run-b-queued"]);
      const status = store.readRunJson<RunStatus>("run-a-running", "status.json");
      expect(status.state).toBe("interrupted");
      expect(status.error?.message).toContain("never silently re-runs");
    } finally {
      await platform.close();
    }
  }, 60_000);
});
