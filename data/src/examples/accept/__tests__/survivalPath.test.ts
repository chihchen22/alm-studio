/**
 * The liquidity-survival-path check on Quillfield Bank version 1.3.
 *
 *  - Every line passes on this build, no `s3d.pin.*` line is left, and each of the six pin stems is a replica line
 *    on replica/targets/demo-survival-path-v1.json.
 *  - The replica comparison fails on edited targets: a survival moved by two parts in a billion, a dropped path row, an
 *    added key, a dollar of severe CD outflow in month 1, a buffer position's haircut moved.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { DemoTally } from "../replicaDemoTieOut";
import { readSurvivalTargets, survivalPathCheck } from "../survivalPath";
import { runSurvivalPathDemo } from "../survivalPathRuns";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarketSnapshot(resolve(REPO_ROOT, "packages/kernel/public/market_public.json"));
});

const STEMS = ["s3d.buffer", "s3d.severe-survival", "s3d.severe-peak", "s3d.path-survival", "s3d.path-survival-facility", "s3d.path-peak"];

describe("the survival path check", () => {
  it("passes on this build, every line, each former pin stem a replica line and no pin left", async () => {
    const lines = (await survivalPathCheck.run({ repoRoot: REPO_ROOT, market })).lines;
    expect(lines.filter((l) => l.status !== "pass").map((l) => `${l.id}: ${l.detail}`)).toEqual([]);
    expect(lines.filter((l) => l.id.startsWith("s3d.pin."))).toEqual([]);
    for (const s of STEMS) expect(lines.find((l) => l.id === s)?.detail, s).toContain("Python replica's targets");
  }, 300_000);

  describe("the replica comparison refuses edited targets", () => {
    const passes = (engine: unknown, target: unknown): boolean => {
      const t = new DemoTally(0);
      t.walk("liquidityStress", "liquidityStress", engine, target, () => true);
      return t.fails.length === 0 && t.cells > 0;
    };
    const tl = () => structuredClone(readSurvivalTargets(REPO_ROOT).liquidityStress) as Record<string, any>;

    it("passes on the committed targets and fails on each edit", () => {
      const ls = runSurvivalPathDemo(REPO_ROOT, market).result.liquidityStress;
      expect(passes(ls, tl())).toBe(true);
      const a = tl();
      a.survivalPath.withFacility.survivalMonths *= 1 + 2e-9;
      expect(passes(ls, a)).toBe(false);
      const b = tl();
      b.survivalPath.rows.pop();
      expect(passes(ls, b)).toBe(false);
      const c = tl();
      c.survivalPath.extra = 0;
      expect(passes(ls, c)).toBe(false);
      const d = tl();
      const sev = d.scenarios.find((s: { id: string }) => s.id === "severe");
      sev.cdOut[0] += 1;
      expect(passes(ls, d)).toBe(false);
      const e = tl();
      e.bufferDerivation.positions[3].haircut = 0.150000001;
      expect(passes(ls, e)).toBe(false);
    });
  });
});
