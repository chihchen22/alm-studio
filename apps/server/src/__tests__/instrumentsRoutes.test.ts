/**
 * The per-position results file through
 * the real spawned child and the two routes. The submission opts in with
 * instrumentResults.save; the child writes instruments.json after result.json;
 * GET /api/runs/:id/instruments serves it verbatim, .../instruments.csv
 * flattens it, a run without the file answers 404 in a sentence, and a failure
 * inside the pass is a run-log line that leaves the run done.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildVanillaPortfolio, vanillaAssumptionSet, vanillaScenarios } from "@alm/data";
import type { InstrumentsFile, PortfolioSpec, RunResult } from "@alm/engine";
import { buildSyntheticPortfolio } from "../../scripts/seed-store";
import type { RunStatus } from "../jobs/types";
import { api, bootTestPlatform, loadTestMarket, waitFor, type TestPlatform } from "./harness";

let tp: TestPlatform;
let synthetic: PortfolioSpec;

beforeAll(async () => {
  tp = await bootTestPlatform();
  const store = tp.platform.context.store;
  const market = await loadTestMarket();
  const set = vanillaAssumptionSet();
  const scenarios = vanillaScenarios(set.id);
  synthetic = buildSyntheticPortfolio();
  for (const book of [buildVanillaPortfolio(), synthetic]) {
    store.putDocument("portfolios", book.id, book, { label: book.label, asOf: book.asOf, positionCount: book.positions.length });
  }
  store.putDocument("market", "market-test", market, { label: "test market" });
  store.putDocument("assumption-sets", set.id, { ...set }, { label: set.label });
  store.putDocument("scenario-slates", "grid", { id: "grid", label: "grid", scenarios }, { label: "grid", scenarioCount: scenarios.length });
}, 120_000);

afterAll(async () => {
  await tp.close();
});

const body = (portfolioId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  portfolioId,
  marketId: "market-test",
  scenarioSlateId: "grid",
  assumptionSetIds: ["vanilla-empty-v1"],
  ...extra,
});

const waitDone = async (runId: string): Promise<RunStatus> => {
  const done = await waitFor(
    async () => (await api<RunStatus>(tp.base, "GET", `/api/runs/${runId}`)).body,
    (s) => s.state === "done" || s.state === "error",
    280_000,
  );
  expect(done.state, JSON.stringify(done.error ?? {})).toBe("done");
  return done;
};

const submit = async (extra: Record<string, unknown>, portfolioId = synthetic.id): Promise<string> => {
  const sub = await api<{ runId: string }>(tp.base, "POST", "/api/runs", body(portfolioId, extra));
  expect(sub.status, sub.text).toBe(202);
  return sub.body.runId;
};

const HEADER =
  "positionId,parentPositionId,familyId,coaNodeId,side,type,notional,discountSpreadBp,walMonths,firstRepricingMonth," +
  "scenarioId,pv,nii12,balance12,principal12,segNiiBase12,segNiiUp12,segNiiDown12,segPeak";

describe("instruments file: the spawned child and the routes", () => {
  let savedRun: string;
  let file: InstrumentsFile;
  let result: RunResult;

  it(
    "writes instruments.json after result.json for a run submitted with instrumentResults.save, and result.json carries no pointer",
    async () => {
      savedRun = await submit({ instrumentResults: { save: true }, engineOptions: { seg: true } });
      await waitDone(savedRun);
      const store = tp.platform.context.store;
      expect(store.runFileExists(savedRun, "instruments.json")).toBe(true);
      const resultPath = store.paths.runFile(savedRun, "result.json");
      const instrumentsPath = store.paths.runFile(savedRun, "instruments.json");
      expect(statSync(instrumentsPath).mtimeMs).toBeGreaterThanOrEqual(statSync(resultPath).mtimeMs);
      // The envelope is the engine's, untouched by the pass: no pointer was written back into it.
      expect("instrumentsFile" in JSON.parse(readFileSync(resultPath, "utf8"))).toBe(false);
      // The opt-in rode on request.json, and only because it was on.
      const stored = store.readRunJson<{ instrumentResults?: unknown }>(savedRun, "request.json");
      expect(stored.instrumentResults).toEqual({ save: true });
      // Atomic landing: no temp file left beside it.
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(store.paths.runDir(savedRun)).filter((f) => f.startsWith(".tmp-"))).toEqual([]);
      result = (await api<RunResult>(tp.base, "GET", `/api/runs/${savedRun}/result`)).body;
    },
    300_000,
  );

  it("GET /api/runs/:id/instruments serves the file verbatim with one row per position", async () => {
    const res = await api<InstrumentsFile>(tp.base, "GET", `/api/runs/${savedRun}/instruments`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const onDisk = readFileSync(tp.platform.context.store.paths.runFile(savedRun, "instruments.json"), "utf8");
    expect(res.text).toBe(onDisk);
    file = res.body;
    // The seeded synthetic book is labelled 2,500 positions; its generator yields 2,351.
    expect(file.positions).toHaveLength(synthetic.positions.length);
    expect(file.positions).toHaveLength(2_351);
    expect(file.runId).toBe(savedRun);
    expect(file.scenarios).toEqual(result.cashflows.byScenario.map((s) => s.scenarioId));
  });

  it("rows sum to the envelope: balance12 to the family balance at month 12, pv to the EVE family PV", () => {
    const base = file.scenarios[0]!;
    const sums = new Map<string, { bal: number; pv: number; notional: number }>();
    for (const row of file.positions) {
      const s = row.byScenario.find((x) => x.scenarioId === base)!;
      const acc = sums.get(row.familyId) ?? { bal: 0, pv: 0, notional: 0 };
      acc.bal += s.balance12;
      acc.pv += s.pv;
      acc.notional += row.notional;
      sums.set(row.familyId, acc);
    }
    const cf = result.cashflows.byScenario.find((s) => s.scenarioId === base)!;
    const eve = result.eve.byScenario.find((s) => s.scenarioId === base)!;
    for (const fam of cf.byFamily) {
      const got = sums.get(fam.familyId);
      if (got === undefined) continue;
      expect(Math.abs(got.bal - fam.series.balance[11]!)).toBeLessThanOrEqual(1e-6 * got.notional);
      const famPv = eve.byFamily.find((f) => f.familyId === fam.familyId)!.pv;
      expect(Math.abs(got.pv - famPv)).toBeLessThanOrEqual(1e-6 * Math.max(Math.abs(famPv), 1));
    }
  });

  it("carries the seg scalars because the run opted in to seg, and no arrays on a book over 100 positions", () => {
    expect(result.seg).toBeDefined();
    const covered = file.positions.filter((p) => p.seg !== undefined);
    expect(covered.length).toBe(file.positions.length - result.seg!.uncovered.length);
    expect(covered.every((p) => p.seg!.segOutstanding === undefined && p.seg!.ebp === undefined)).toBe(true);
    let niiBase = 0;
    for (const p of covered) niiBase += p.seg!.niiBase12;
    expect(Math.abs(niiBase - result.seg!.book.nii.base12)).toBeLessThanOrEqual(1e-6 * Math.abs(result.seg!.totalAssetNotional));
  });

  it("GET /api/runs/:id/instruments.csv starts with the header line and flattens one row per position per scenario", async () => {
    const res = await api(tp.base, "GET", `/api/runs/${savedRun}/instruments.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain(`${savedRun}-instruments.csv`);
    const lines = res.text.split(/\r?\n/).filter((l) => l !== "");
    expect(lines[0]).toBe(HEADER);
    expect(lines).toHaveLength(1 + file.positions.length * file.scenarios.length);
    const first = file.positions[0]!;
    const cells = lines[1]!.split(",");
    expect(cells[0]).toBe(first.positionId);
    expect(cells[10]).toBe(first.byScenario[0]!.scenarioId);
    expect(Number(cells[11])).toBe(first.byScenario[0]!.pv);
    // The second row is the same position under the second scenario.
    expect(lines[2]!.split(",")[10]).toBe(first.byScenario[1]!.scenarioId);
  });

  it("answers 404 in a sentence for a done run submitted without the opt-in, on both routes", async () => {
    const plain = await submit({}, "vanilla-book-v1");
    await waitDone(plain);
    const store = tp.platform.context.store;
    expect(store.runFileExists(plain, "instruments.json")).toBe(false);
    expect("instrumentResults" in store.readRunJson<Record<string, unknown>>(plain, "request.json")).toBe(false);
    for (const path of ["instruments", "instruments.csv"]) {
      const res = await api<{ error: { message: string } }>(tp.base, "GET", `/api/runs/${plain}/${path}`);
      expect(res.status).toBe(404);
      expect(res.body.error.message).toContain("no per-position results file");
    }
    expect((await api(tp.base, "GET", "/api/runs/run-does-not-exist/instruments")).status).toBe(404);
  }, 200_000);

  it("limits the file to the positions under the named COA nodes", async () => {
    const vanilla = buildVanillaPortfolio();
    const node = vanilla.positions.find((p) => p.familyId === "fixed-loans")!.coaNodeId;
    const run = await submit({ instrumentResults: { save: true, coaNodeIds: [node] } }, "vanilla-book-v1");
    await waitDone(run);
    const res = await api<InstrumentsFile>(tp.base, "GET", `/api/runs/${run}/instruments`);
    expect(res.status).toBe(200);
    const expected = vanilla.positions.filter((p) => p.coaNodeId === node).map((p) => p.id);
    expect(res.body.positions.map((p) => p.positionId)).toEqual(expected);
    expect(res.body.positions.length).toBeGreaterThan(0);
    expect(res.body.positions.length).toBeLessThan(vanilla.positions.length);
    // A small book carries the SEG series only when the run asked for seg; this run did not.
    expect(res.body.positions.every((p) => p.seg === undefined)).toBe(true);
    const stored = tp.platform.context.store.readRunJson<{ instrumentResults?: unknown }>(run, "request.json");
    expect(stored.instrumentResults).toEqual({ save: true, coaNodeIds: [node] });
  }, 200_000);

  it("refuses a malformed or unknown instrumentResults at submission, naming the field, and queues nothing", async () => {
    const refuse = async (extra: Record<string, unknown>, pattern: RegExp, portfolioId = "vanilla-book-v1"): Promise<void> => {
      const before = (await api<unknown[]>(tp.base, "GET", "/api/runs")).body.length;
      const res = await api<{ error: { message: string } }>(tp.base, "POST", "/api/runs", body(portfolioId, extra));
      expect(res.status, res.text).toBe(422);
      expect(res.body.error.message).toMatch(pattern);
      expect((await api<unknown[]>(tp.base, "GET", "/api/runs")).body.length).toBe(before);
    };
    await refuse({ instrumentResults: { save: "yes" } }, /instrumentResults\.save must be a boolean/);
    await refuse({ instrumentResults: { save: true, coaNodeIds: "coa-cash" } }, /instrumentResults\.coaNodeIds must be an array/);
    await refuse({ instrumentResults: { save: true, coaNodeIds: ["coa-nowhere"] } }, /instrumentResults\.coaNodeIds names "coa-nowhere"/);
    await refuse({ instrumentResults: { save: true }, mode: "stochastic" }, /instrumentResults\.save applies to a deterministic run only/);
  });

  it("save: false stores the request it always did", async () => {
    const run = await submit({ instrumentResults: { save: false } }, "vanilla-book-v1");
    await waitDone(run);
    const store = tp.platform.context.store;
    expect("instrumentResults" in store.readRunJson<Record<string, unknown>>(run, "request.json")).toBe(false);
    expect(store.runFileExists(run, "instruments.json")).toBe(false);
  }, 200_000);

  it("a failure inside the pass is an instruments-pass-failed log line and the run still reports done", async () => {
    const run = await submit({ instrumentResults: { save: true } }, "vanilla-book-v1");
    // The run directory exists from submission; a non-empty directory squatting on the file's name makes the
    // pass's atomic rename fail, long before the child has booted and reached the pass.
    const squat = join(tp.platform.context.store.paths.runDir(run), "instruments.json");
    mkdirSync(squat, { recursive: true });
    writeFileSync(join(squat, "squatter"), "x");
    await waitDone(run);
    const store = tp.platform.context.store;
    const lines = store.readRunLog(run) as Array<{ t?: string; line?: string }>;
    const failed = lines.find((l) => l.t === "log" && (l.line ?? "").startsWith("instruments-pass-failed"));
    expect(failed, JSON.stringify(lines.slice(-6))).toBeDefined();
    expect(existsSync(join(squat, "squatter"))).toBe(true);
    // The envelope is intact: the failed pass touched nothing else.
    const res = await api(tp.base, "GET", `/api/runs/${run}/result`);
    expect(res.status).toBe(200);
  }, 200_000);
});
