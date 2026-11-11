/**
 * The example bank's feature demo checks: seg-ear, per-position-drilldown and
 * quillfield-feature-demos.
 *
 *  - Every line passes on this build; no provisional pin is left, and each of the ten pin stems is now a replica
 *    tie-out line.
 *  - The replica comparison fails on edited targets: a deleted cell, a dropped scenario row, a deleted family, an added
 *    key, a moved value (the fix round's M1 rule applied to the demos); and, from the S3b fix round, the
 *    review's two passing edits (the book's SEG peak, interest checking's first-year SEG), a short list (L1), a year,
 *    a rate or a month moved below the old floor (L2), and an input repointed at another file (L3).
 *  - No line reads a file from outside this repository: the checks' sources name none.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import type { RunResult } from "@alm/engine";
import { featureDemosCheck, perPositionCheck, segEarCheck } from "../featureDemos";
import { runFeatureDemo } from "../featureDemoRuns";
import { DemoTally, demoInputsLine, readDemoTargets, segFloorOf, segForComparison } from "../replicaDemoTieOut";
import type { CheckLine } from "../types";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarketSnapshot(resolve(REPO_ROOT, "packages/kernel/public/market_public.json"));
});

const linesOf = async (c: typeof segEarCheck): Promise<CheckLine[]> => (await c.run({ repoRoot: REPO_ROOT, market })).lines;

/** the ten provisional stems, each now a replica line. */
const STEMS = [
  "demo.seg.nii-base12", "demo.seg.nii-up12", "demo.seg.nii-down12", "demo.seg.seg-bank", "demo.instruments.pv-total",
  "demo.regulatory.eve", "demo.spread-consistent.eve", "demo.six-shocks.eve", "demo.constant-prepay.inflow", "demo.fixed-ladder.rows",
];

/** Walk one result block against a (possibly edited) target and say whether it passes. */
function passes(root: string, engine: unknown, target: unknown, floor = 0): boolean {
  const t = new DemoTally(floor);
  t.walk(root, root, engine, target, () => true);
  return t.fails.length === 0 && t.cells > 0;
}

describe("the feature demo checks", () => {
  it("pass on this build, every line, with each of the ten former pin stems a replica line and no provisional line left", async () => {
    const all = [...(await linesOf(segEarCheck)), ...(await linesOf(perPositionCheck)), ...(await linesOf(featureDemosCheck))];
    expect(all.filter((l) => l.status !== "pass").map((l) => `${l.id}: ${l.detail}`)).toEqual([]);
    expect(all.filter((l) => l.id.endsWith(".provisional"))).toEqual([]);
    for (const s of STEMS) expect(all.find((l) => l.id === s)?.detail, s).toContain("Python replica's targets");
    for (const l of all) expect(l.id, l.id).toMatch(/^demo\.[a-z-]+\.[a-z0-9-]+$/);
  }, 300_000);

  describe("the replica comparison refuses edited targets", () => {
    let reg: RunResult;
    let seg: RunResult;
    beforeAll(() => {
      reg = runFeatureDemo(REPO_ROOT, market, "regulatory").result;
      seg = runFeatureDemo(REPO_ROOT, market, "seg").result;
    });
    const regEve = () => structuredClone(readDemoTargets(REPO_ROOT, "regulatory").eve) as { byScenario: Array<Record<string, unknown> & { byFamily: Array<Record<string, unknown>> }> };

    it("passes on the committed targets", () => expect(passes("eve", reg.eve, regEve())).toBe(true));

    it("fails on a deleted cell", () => {
      const t = regEve();
      delete t.byScenario.find((s) => s.scenarioId === "S200")!.eve;
      expect(passes("eve", reg.eve, t)).toBe(false);
    });

    it("fails on a dropped scenario row", () => {
      const t = regEve();
      t.byScenario = t.byScenario.filter((s) => s.scenarioId !== "S-200");
      expect(passes("eve", reg.eve, t)).toBe(false);
    });

    it("fails on a deleted family and on an added key", () => {
      const t = regEve();
      t.byScenario[0]!.byFamily = t.byScenario[0]!.byFamily.filter((f) => f.familyId !== "mb-mma");
      expect(passes("eve", reg.eve, t)).toBe(false);
      const u = regEve();
      (u as Record<string, unknown>).excluded = { families: ["mb-savings"] };
      expect(passes("eve", reg.eve, u)).toBe(false);
    });

    it("fails on a value moved by two parts in a billion, and a SEG bank cell moved by a millionth", () => {
      const t = regEve();
      const row = t.byScenario.find((s) => s.scenarioId === "S0")!;
      row.eve = (row.eve as number) * (1 + 2e-9);
      expect(passes("eve", reg.eve, t)).toBe(false);
      const g = structuredClone(readDemoTargets(REPO_ROOT, "seg").seg) as { segBank: number[] };
      g.segBank[60] = g.segBank[60]! * (1 + 1e-6);
      expect(segPasses(g)).toBe(false);
      expect(segPasses(readDemoTargets(REPO_ROOT, "seg").seg)).toBe(true);
    });

    /** The SEG block against a (possibly edited) target, as the check compares it: the whole block (D6 closed in K1). */
    function segPasses(target: unknown): boolean {
      const floor = segFloorOf(seg.seg!.shockBp);
      const e = segForComparison(seg.seg as unknown as Record<string, unknown>, floor);
      return passes("seg", e, segForComparison(target as Record<string, unknown>, floor), floor);
    }
    const segT = () => structuredClone(readDemoTargets(REPO_ROOT, "seg").seg) as Record<string, any>;

    it("compares the book's SEG peak (review M2, case 1)", () => {
      const g = segT();
      g.book.segPeak = { value: 1, month: 99 };
      expect(segPasses(g)).toBe(false);
    });

    it("compares interest checking's SEG and up-shock NII in full, the months D6 once cut included", () => {
      // Months 1 to 12 moved 1%, with the book, the bank print and both periodic series kept consistent (review M2, case 2).
      const g = segT();
      const f = g.byFamily["mb-int-checking"];
      const d = (f.segOutstanding as number[]).map((x, i) => (i >= 1 && i <= 12 ? 0.01 * x : 0));
      const add = (a: number[], b: (i: number) => number) => a.map((x, i) => x + b(i));
      f.segOutstanding = add(f.segOutstanding, (i) => d[i]!);
      g.book.segOutstanding = add(g.book.segOutstanding, (i) => d[i]!);
      g.segBank = add(g.segBank, (i) => d[i] ?? 0);
      f.segPeriodic = add(f.segPeriodic, (i) => (i >= 1 ? d[i - 1]! - d[i]! : 0));
      g.book.segPeriodic = add(g.book.segPeriodic, (i) => (i >= 1 ? d[i - 1]! - d[i]! : 0));
      expect(segPasses(g)).toBe(false);
      // A month the old cut dropped: SEG at month 120 and up-shock NII in month 6, each with the book kept consistent.
      const h = segT();
      const hf = h.byFamily["mb-int-checking"];
      const dx = hf.segOutstanding[120] * 0.01;
      hf.segOutstanding[120] += dx;
      h.book.segOutstanding[120] += dx;
      expect(segPasses(h)).toBe(false);
      const u = segT();
      const dn = u.byFamily["mb-int-checking"].nii.upMonthly[5] * 0.01;
      u.byFamily["mb-int-checking"].nii.upMonthly[5] += dn;
      u.book.nii.upMonthly[5] += dn;
      expect(segPasses(u)).toBe(false);
    });

    it("refuses a target carrying a key the engine does not report, such as the old onset", () => {
      const g = segT();
      g.vintageWarmupOnset = { "mb-int-checking": { seg: 13 } };
      expect(segPasses(g)).toBe(false);
    });

    it("fails on a numeric list shorter than the engine's, even where the engine's tail is zero (L1)", () => {
      const t = structuredClone(readDemoTargets(REPO_ROOT, "regulatory").nii) as { byScenario: Array<{ netMonthly: number[] }> };
      const e = reg.nii as unknown as { byScenario: Array<{ netMonthly: number[] }> };
      const row = e.byScenario[0]!.netMonthly;
      expect(row[row.length - 1]).toBe(0);
      t.byScenario[0]!.netMonthly.pop();
      expect(passes("nii", reg.nii, t)).toBe(false);
    });

    it("holds years and rates to 1e-12 and whole months exactly (L2)", () => {
      const cp = runFeatureDemo(REPO_ROOT, market, "constant-prepay").result;
      const cf = () => structuredClone(readDemoTargets(REPO_ROOT, "constant-prepay").cashflows) as { byScenario: Array<{ byFamily: Array<{ walYears?: number }> }> };
      const a = cf();
      const fam = a.byScenario[0]!.byFamily.find((f) => f.walYears !== undefined)!;
      fam.walYears = fam.walYears! + 9e-7;
      expect(passes("cashflows", cp.cashflows, a)).toBe(false);
      const ls = () => structuredClone(readDemoTargets(REPO_ROOT, "constant-prepay").liquidityStress) as { scenarios: Array<{ id: string; params: { drawRate: number }; peakMonth?: number }> };
      const b = ls();
      b.scenarios.find((s) => s.id === "moderate")!.params.drawRate += 9e-7;
      expect(passes("liquidityStress", cp.liquidityStress, b)).toBe(false);
      const g = segT();
      g.byFamily["mb-mma"].segPeak.month += 1e-7;
      expect(segPasses(g)).toBe(false);
      expect(passes("cashflows", cp.cashflows, cf())).toBe(true);
      expect(passes("liquidityStress", cp.liquidityStress, ls())).toBe(true);
    });

    it("fails the inputs line when the targets point an input at another file, even with that file's hash (L3)", () => {
      const t = structuredClone(readDemoTargets(REPO_ROOT, "regulatory"));
      const path = "examples/example-book-v1.json";
      t.inputs.bank = { path, sha256: createHash("sha256").update(readFileSync(resolve(REPO_ROOT, path))).digest("hex") };
      const ids = reg.eve.byScenario.map((s) => s.scenarioId);
      expect(demoInputsLine(REPO_ROOT, "regulatory", t.setupId, t, ids).status).toBe("fail");
      expect(demoInputsLine(REPO_ROOT, "regulatory", t.setupId, readDemoTargets(REPO_ROOT, "regulatory"), ids).status).toBe("pass");
    });
  });

  it("read no file from outside this repository", () => {
    for (const f of ["featureDemos.ts", "featureDemoRuns.ts", "replicaDemoTieOut.ts"]) {
      const src = readFileSync(resolve(HERE, "..", f), "utf8");
      expect(src, f).not.toMatch(/companion\//);
      expect(src, f).not.toMatch(/Chapter|Table \d/);
    }
  });
});
