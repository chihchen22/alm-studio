/**
 * The per-position results pass.
 *
 * The pass recomputes every position on the books, paths and curve legs the run
 * walked (the engine's onInstrumentEnvironment seam) and writes instruments.json
 * AFTER result.json. These tests run the engine in-process on the seeded 2,354
 * position hedged book (swaps included) and pin the rows to the run's own blocks:
 * per-position balance, principal, NII and PV summed by family equal the
 * envelope's family rows, on every discount basis, and the pass never touches
 * result.json. The spawned-child, route and CSV pins live in
 * instrumentsRoutes.test.ts.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { vanillaAssumptionSet, vanillaScenarios } from "@alm/data";
import { buildRunResult, resolveDefaultContext, type RunPipelineContext } from "@alm/engine/src/run";
import type {
  InstrumentEnvironment,
  InstrumentsFile,
  PortfolioSpec,
  RunRequest,
  RunResult,
} from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";
import { buildHedgedPortfolio, buildSyntheticPortfolio } from "../../scripts/seed-store";
import { buildInstrumentsFile, landInstrumentsFile } from "../jobs/instrumentsPass";
import type { RunEvent } from "../jobs/types";
import { loadTestMarket } from "./harness";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadTestMarket();
});

function requestFor(book: PortfolioSpec): RunRequest {
  const set = vanillaAssumptionSet();
  return {
    runId: "run-pass-test",
    portfolioId: book.id,
    marketSnapshot: market,
    scenarios: vanillaScenarios(set.id),
    assumptionSets: [set],
    grid: { horizonMonths: 360, asOf: book.asOf },
    seed: "platform-0",
    timestamps: { startedAt: "2026-10-14T00:00:00.000Z", finishedAt: "2026-10-14T00:00:01.000Z" },
  };
}

interface Ran {
  request: RunRequest;
  book: PortfolioSpec;
  result: RunResult;
  environment: InstrumentEnvironment;
}

function run(book: PortfolioSpec, extra?: Partial<RunPipelineContext>): Ran {
  const request = requestFor(book);
  let environment: InstrumentEnvironment | undefined;
  const result = buildRunResult(request, book, {
    ...resolveDefaultContext(),
    durationMode: "base-only",
    ...extra,
    onInstrumentEnvironment: (e) => {
      if (e instanceof Error) throw e;
      environment = e;
    },
  });
  return { request, book, result, environment: environment! };
}

/** The base-set effective book, as the runner hands it to the pass. */
function baseBook(r: Ran): PortfolioSpec {
  return r.environment.booksBySet.get(r.request.scenarios[0]!.assumptionSetId)!;
}

/** Hedged book with one discount spread per family (deposits excluded by the engine rule). */
function spreadBook(): PortfolioSpec {
  const book = buildHedgedPortfolio();
  const bpOf = new Map(book.coa.families.map((f, i) => [f.id, 10 + 5 * i] as const));
  return {
    ...book,
    positions: book.positions.map((p) => ({ ...p, discountSpreadBp: bpOf.get(p.familyId)! })),
  };
}

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function sumBy(file: InstrumentsFile, scenarioId: string, pick: (r: InstrumentsFile["positions"][number], s: InstrumentsFile["positions"][number]["byScenario"][number]) => number): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of file.positions) {
    const s = row.byScenario.find((x) => x.scenarioId === scenarioId)!;
    out.set(row.familyId, (out.get(row.familyId) ?? 0) + pick(row, s));
  }
  return out;
}

let hedged: Ran;
let hedgedFile: InstrumentsFile;
let spread: Ran;
let spreadFile: InstrumentsFile;

beforeAll(() => {
  hedged = run(buildHedgedPortfolio());
  hedgedFile = buildInstrumentsFile(hedged.request, baseBook(hedged), hedged.result, undefined, hedged.environment);
  spread = run(spreadBook(), { discountBasis: "spread-consistent", seg: true });
  spreadFile = buildInstrumentsFile(spread.request, baseBook(spread), spread.result, spread.environment.perPositionSeg, spread.environment);
}, 240_000);

describe("instruments pass: the rows are the run's own numbers", () => {
  it("covers every position in book order, every scenario in request order, with the file header", () => {
    // Spec P1: the file schema is 1.1.0, a balance held at book valued at par.
    expect(hedgedFile.schemaVersion as string).toBe("1.1.0");
    expect(hedgedFile.runId).toBe("run-pass-test");
    expect(hedgedFile.asOf).toBe(hedged.book.asOf);
    expect(hedgedFile.horizonMonths).toBe(360);
    expect(hedgedFile.discountBasis).toBe("all-in");
    expect(hedgedFile.scenarios).toEqual(hedged.request.scenarios.map((s) => s.id));
    expect(hedgedFile.positions.map((p) => p.positionId)).toEqual(hedged.book.positions.map((p) => p.id));
    // The seeded synthetic book is labelled 2,500 positions; the generator's cohort rounding yields 2,351, plus 3 swaps.
    expect(hedgedFile.positions).toHaveLength(2_354);
    for (const row of hedgedFile.positions) {
      expect(row.byScenario.map((s) => s.scenarioId)).toEqual(hedgedFile.scenarios);
    }
  });

  it("balance12, principal12 and nii12 summed by family equal the envelope's family rows, per scenario", () => {
    for (const scn of hedged.result.cashflows.byScenario) {
      const bal = sumBy(hedgedFile, scn.scenarioId, (_r, s) => s.balance12);
      const prin = sumBy(hedgedFile, scn.scenarioId, (_r, s) => s.principal12);
      const nii = hedged.result.nii.byScenario.find((s) => s.scenarioId === scn.scenarioId)!;
      const niiBy = sumBy(hedgedFile, scn.scenarioId, (_r, s) => s.nii12);
      for (const fam of scn.byFamily) {
        const notional = hedgedFile.positions
          .filter((p) => p.familyId === fam.familyId)
          .reduce((a, p) => a + Math.abs(p.notional), 0);
        const tol = 1e-6 * Math.max(notional, 1);
        expect(Math.abs((bal.get(fam.familyId) ?? 0) - fam.series.balance[11]!)).toBeLessThanOrEqual(tol);
        let p12 = 0;
        for (let k = 0; k < 12; k++) p12 += fam.series.principal[k]!;
        expect(Math.abs((prin.get(fam.familyId) ?? 0) - p12)).toBeLessThanOrEqual(tol);
        const famNii = nii.byFamily.find((f) => f.familyId === fam.familyId)!;
        expect(Math.abs((niiBy.get(fam.familyId) ?? 0) - famNii.net12)).toBeLessThanOrEqual(tol);
      }
    }
  });

  it("pv summed by family equals the EVE family PV within 1e-6 relative, on every scenario (swaps on the risk-free curve)", () => {
    for (const scn of hedged.result.eve.byScenario) {
      const pv = sumBy(hedgedFile, scn.scenarioId, (_r, s) => s.pv);
      for (const fam of scn.byFamily) {
        const got = pv.get(fam.familyId) ?? 0;
        expect(Math.abs(got - fam.pv)).toBeLessThanOrEqual(1e-6 * Math.max(Math.abs(fam.pv), 1));
      }
    }
  });

  it("on the spread-consistent basis the rows still sum to the family PV, and the spreads ride on the rows", () => {
    expect(spreadFile.discountBasis).toBe("spread-consistent");
    for (const scn of spread.result.eve.byScenario) {
      const pv = sumBy(spreadFile, scn.scenarioId, (_r, s) => s.pv);
      for (const fam of scn.byFamily) {
        expect(Math.abs((pv.get(fam.familyId) ?? 0) - fam.pv)).toBeLessThanOrEqual(1e-6 * Math.max(Math.abs(fam.pv), 1));
      }
    }
    expect(spreadFile.positions.every((p) => typeof p.discountSpreadBp === "number")).toBe(true);
    // The spread moves the PV: the same book on all-in prices differently.
    const allIn = run(spreadBook());
    const allInFile = buildInstrumentsFile(allIn.request, baseBook(allIn), allIn.result, undefined, allIn.environment);
    const loan = spreadFile.positions.findIndex((p) => p.type === "fixed-loan");
    expect(spreadFile.positions[loan]!.byScenario[0]!.pv).not.toBe(allInFile.positions[loan]!.byScenario[0]!.pv);
  });

  it("describes each position: side, type, notional, dimensions, first repricing, WAL where principal exists", () => {
    const swap = hedgedFile.positions.find((p) => p.type === "swap")!;
    expect(swap.side).toBe("derivative");
    expect("walMonths" in swap).toBe(false);
    const fixed = hedgedFile.positions.find((p) => p.type === "fixed-loan")!;
    expect(fixed.side).toBe("asset");
    expect(fixed.walMonths).toBeGreaterThan(0);
    expect(fixed.firstRepricingMonth).toBeGreaterThanOrEqual(1);
    const liability = hedgedFile.positions.find((p) => p.side === "liability")!;
    expect(liability.notional).toBeGreaterThan(0);
    const floater = hedgedFile.positions.find((p) => p.type === "floating-loan");
    if (floater !== undefined) expect(floater.firstRepricingMonth).toBeGreaterThanOrEqual(1);
    for (const p of hedgedFile.positions) {
      expect(p.coaNodeId).toBe(hedged.book.positions.find((x) => x.id === p.positionId)!.coaNodeId);
      expect(typeof p.dimensions).toBe("object");
    }
  });

  it("has no NaN and no Infinity anywhere, and leaves an absent optional field out rather than writing null", () => {
    const text = JSON.stringify(hedgedFile);
    expect(text).not.toMatch(/NaN|Infinity/);
    for (const p of hedgedFile.positions) {
      for (const [key, value] of Object.entries(p)) {
        // firstRepricingMonth is typed number | null by contract; every other absent field is left out.
        if (key !== "firstRepricingMonth") expect(value, `${p.positionId}.${key}`).not.toBeNull();
      }
    }
    const spreadText = JSON.stringify(spreadFile);
    expect(spreadText).not.toMatch(/NaN|Infinity/);
  });
});

describe("instruments pass: SEG scalars and the F6 array rule", () => {
  it("carries seg scalars for covered positions when the run opted in to seg, and no arrays on a 2,500 position book", () => {
    const withSeg = spreadFile.positions.filter((p) => p.seg !== undefined);
    expect(withSeg.length).toBeGreaterThan(0);
    const uncovered = new Set(spread.result.seg!.uncovered.map((u) => u.positionId));
    for (const p of spreadFile.positions) expect(p.seg === undefined).toBe(uncovered.has(p.positionId));
    const first = withSeg[0]!.seg!;
    const row = spread.environment.perPositionSeg!.get(withSeg[0]!.positionId)!;
    expect(first.niiBase12).toBe(row.niiBase12);
    expect(first.niiUp12).toBe(row.niiUp12);
    expect(first.niiDown12).toBe(row.niiDown12);
    expect(first.segPeak).toBe(row.segPeak);
    expect(withSeg.every((p) => p.seg!.segOutstanding === undefined && p.seg!.ebp === undefined)).toBe(true);
    // The seg-less run carries no seg key at all.
    expect(hedgedFile.positions.every((p) => !("seg" in p))).toBe(true);
  });

  it("includes the 61-entry SEG outstanding and 60-entry EBP series on a book of at most 100 positions", () => {
    const small = run(smallBook(), { seg: true });
    const file = buildInstrumentsFile(small.request, baseBook(small), small.result, small.environment.perPositionSeg, small.environment);
    const covered = file.positions.filter((p) => p.seg !== undefined);
    expect(covered.length).toBeGreaterThan(0);
    for (const p of covered) {
      expect(p.seg!.segOutstanding).toHaveLength(61);
      expect(p.seg!.ebp).toHaveLength(60);
    }
  });
});

describe("instruments pass: the COA filter", () => {
  it("keeps only the positions under the named COA nodes, a summation node reaching its leaves", () => {
    const book = baseBook(hedged);
    const leaf = book.positions[0]!;
    const only = buildInstrumentsFile(hedged.request, book, hedged.result, undefined, hedged.environment, { coaNodeIds: [leaf.coaNodeId] });
    expect(only.positions.length).toBeGreaterThan(0);
    expect(only.positions.every((p) => p.coaNodeId === leaf.coaNodeId)).toBe(true);
    const side = book.coa.nodes.find((n) => n.id === leaf.coaNodeId)!;
    let root = side;
    while (root.parentId !== null) root = book.coa.nodes.find((n) => n.id === root.parentId)!;
    const whole = buildInstrumentsFile(hedged.request, book, hedged.result, undefined, hedged.environment, { coaNodeIds: [root.id] });
    expect(whole.positions.every((p) => book.positions.find((x) => x.id === p.positionId) !== undefined)).toBe(true);
    expect(whole.positions.length).toBeGreaterThanOrEqual(only.positions.length);
    const all = buildInstrumentsFile(hedged.request, book, hedged.result, undefined, hedged.environment, {});
    expect(all.positions).toHaveLength(book.positions.length);
  });

  it("refuses a COA node the chart does not carry, by name", () => {
    expect(() =>
      buildInstrumentsFile(hedged.request, baseBook(hedged), hedged.result, undefined, hedged.environment, { coaNodeIds: ["no-such-node"] }),
    ).toThrow(/coaNodeIds.*"no-such-node"/);
  });
});

describe("instruments pass: landing the file", () => {
  function runDirWithResult(r: Ran): { dir: string; resultPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "alm-instruments-pass-"));
    const resultPath = join(dir, "result.json");
    writeFileSync(resultPath, `${JSON.stringify(r.result)}\n`);
    return { dir, resultPath };
  }

  it("writes instruments.json atomically beside result.json and leaves result.json's bytes alone", () => {
    const { dir, resultPath } = runDirWithResult(hedged);
    const before = sha(resultPath);
    const events: RunEvent[] = [];
    const ok = landInstrumentsFile({
      runDir: dir,
      request: hedged.request,
      result: hedged.result,
      environment: hedged.environment,
      settings: {},
      emit: (e) => events.push(e),
    });
    expect(ok).toBe(true);
    expect(sha(resultPath)).toBe(before);
    const landed = JSON.parse(readFileSync(join(dir, "instruments.json"), "utf8")) as InstrumentsFile;
    expect(landed.positions).toHaveLength(hedged.book.positions.length);
    expect(events.filter((e) => e.t === "error")).toEqual([]);
    expect("instrumentsFile" in JSON.parse(readFileSync(resultPath, "utf8"))).toBe(false);
  });

  it("a failure inside the pass emits instruments-pass-failed, writes no file, and leaves result.json intact", () => {
    const { dir, resultPath } = runDirWithResult(hedged);
    const before = sha(resultPath);
    const events: RunEvent[] = [];
    const ok = landInstrumentsFile({
      runDir: dir,
      request: hedged.request,
      result: hedged.result,
      environment: hedged.environment,
      settings: { coaNodeIds: ["no-such-node"] },
      emit: (e) => events.push(e),
    });
    expect(ok).toBe(false);
    const line = events.find((e) => e.t === "log" && e.line.startsWith("instruments-pass-failed"));
    expect(line).toBeDefined();
    expect((line as { line: string }).line).toContain("no-such-node");
    expect(() => readFileSync(join(dir, "instruments.json"))).toThrow();
    expect(sha(resultPath)).toBe(before);
  });

  it("a run whose seam never fired fails the pass in a sentence rather than writing an empty file", () => {
    const { dir } = runDirWithResult(hedged);
    const events: RunEvent[] = [];
    const ok = landInstrumentsFile({
      runDir: dir,
      request: hedged.request,
      result: hedged.result,
      environment: undefined,
      settings: {},
      emit: (e) => events.push(e),
    });
    expect(ok).toBe(false);
    expect(events.some((e) => e.t === "log" && e.line.startsWith("instruments-pass-failed"))).toBe(true);
  });

  it("an environment the engine could not build reaches the log line by its own sentence, and the run is not failed", () => {
    const { dir, resultPath } = runDirWithResult(hedged);
    const before = sha(resultPath);
    const events: RunEvent[] = [];
    const ok = landInstrumentsFile({
      runDir: dir,
      request: hedged.request,
      result: hedged.result,
      environment: undefined,
      environmentError: new Error('run: no stage left a RatePath for scenario "S0", so the per-position results pass has no path to project it on'),
      settings: {},
      emit: (e) => events.push(e),
    });
    expect(ok).toBe(false);
    const line = events.find((e) => e.t === "log" && e.line.startsWith("instruments-pass-failed")) as { line: string } | undefined;
    expect(line?.line).toContain('no stage left a RatePath for scenario "S0"');
    expect(line?.line).not.toContain("never handed over");
    expect(events.filter((e) => e.t === "error")).toEqual([]);
    expect(sha(resultPath)).toBe(before);
  });
});

describe("instruments pass: regulatory children", () => {
  it("carries parentPositionId on every child row and the run's parentOf map says the same", () => {
    const reg = run(buildSyntheticPortfolio(), { nmdConvention: "regulatory" });
    const file = buildInstrumentsFile(reg.request, baseBook(reg), reg.result, undefined, reg.environment);
    const parentOf = reg.result.parentOf!;
    expect(Object.keys(parentOf).length).toBeGreaterThan(0);
    for (const row of file.positions) {
      expect(row.parentPositionId).toBe(parentOf[row.positionId]);
    }
    expect(file.positions.some((p) => p.parentPositionId !== undefined)).toBe(true);
    expect(file.positions.some((p) => !("parentPositionId" in p) || p.parentPositionId === undefined)).toBe(true);
  }, 120_000);
});

describe("instruments pass: deposit warmup (Task 16)", () => {
  it("on a run that named nmdWarmup the deposit rows are rebuilt on their scenario's history and still sum to the family PV", () => {
    const book = buildSyntheticPortfolio();
    const scenarios = requestFor(book).scenarios;
    // Any stated shift serves: the test pins that the pass reads the run's own history, whatever it is.
    const shiftPctByScenario = Object.fromEntries(
      scenarios.filter((s) => s.rateSpec.kind !== "base" && s.rateSpec.kind !== "parallel").map((s) => [s.id, 0.5]),
    );
    const warm = run(book, { nmdWarmup: { kind: "flat-at-r0", months: 36, shiftPctByScenario } });
    const plain = run(book);
    const file = buildInstrumentsFile(warm.request, baseBook(warm), warm.result, undefined, warm.environment);
    let moved = 0;
    for (const scn of warm.result.eve.byScenario) {
      const pv = sumBy(file, scn.scenarioId, (_r, s) => s.pv);
      const plainScn = plain.result.eve.byScenario.find((s) => s.scenarioId === scn.scenarioId)!;
      for (const fam of scn.byFamily) {
        expect(Math.abs((pv.get(fam.familyId) ?? 0) - fam.pv)).toBeLessThanOrEqual(1e-6 * Math.max(Math.abs(fam.pv), 1));
        moved = Math.max(moved, Math.abs(fam.pv - plainScn.byFamily.find((f) => f.familyId === fam.familyId)!.pv));
      }
    }
    // The synthetic book's non-interest-bearing deposits carry the regime amplifier, so the history moves a PV.
    expect(moved).toBeGreaterThan(1);
  }, 240_000);
});

/** Four-position book for the array rule: small enough for the series to ride. */
function smallBook(): PortfolioSpec {
  const full = buildSyntheticPortfolio();
  const seen = new Set<string>();
  const positions = full.positions.filter((p) => {
    if (seen.has(p.familyId) || seen.size >= 4) return false;
    seen.add(p.familyId);
    return true;
  });
  return { ...full, id: "small-pass-book", positions };
}
