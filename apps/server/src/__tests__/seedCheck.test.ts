/**
 * `seed-store.ts --check` (spec 2026-09-23 Section 4 and Section 7
 * tests 3 and 6): computes the report, writes nothing (no document, no meta,
 * no directory, no database), exits 1 on a stale store and 0 otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { parseSeedArgs, runSeedCli, SEED_IDS, seedStore } from "../../scripts/seed-store";
import { copyStoreWithoutDb, plantStaleVanillaSlate, seededTemplate, snapshotTree } from "./seedFixtures";

const made: string[] = [];
let template: string;
beforeAll(async () => {
  template = await seededTemplate();
  made.push(template);
}, 120_000);
afterAll(() => {
  for (const d of made) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // The OS temp cleaner owns the leftovers.
    }
  }
});
const copy = (prefix: string): string => {
  const d = copyStoreWithoutDb(template, prefix);
  made.push(d);
  return d;
};

describe("seed --check", () => {
  it("exits 1 on a stale store, prints the STALE block, and writes nothing", async () => {
    const root = copy("alm-seed-check-stale-");
    plantStaleVanillaSlate(root);
    const before = snapshotTree(root);
    const lines: string[] = [];
    const code = await runSeedCli(["--check"], new FileStore(root), repoRoot(), (l) => lines.push(l));
    expect(code).toBe(1);
    expect(lines).toContain(`seed: STALE scenario-slates/${SEED_IDS.vanillaSlate}`);
    expect([...snapshotTree(root)]).toEqual([...before]);
  }, 60_000);

  it("exits 0 on a freshly seeded store, reports nothing stale, and writes nothing", async () => {
    const root = copy("alm-seed-check-fresh-");
    const before = snapshotTree(root);
    const code = await runSeedCli(["--check"], new FileStore(root), repoRoot(), () => undefined);
    expect(code).toBe(0);
    const report = await seedStore(new FileStore(root), repoRoot(), { mode: "check" });
    expect(report.stale).toEqual([]);
    expect(report.missing).toEqual([]);
    expect([...snapshotTree(root)]).toEqual([...before]);
  }, 60_000);

  it("on an empty directory creates nothing and lists all 76 seeded documents as missing (Studio slice S3a-1: 53 to 54, the example bank's chart; S3b-1: 54 to 63, the feature demos; S3c-1: 63 to 75, the deposit desk's sets and the deposit-form setups; S3d-1: 75 to 76, the survival-path setup)", async () => {
    const root = mkdtempSync(join(tmpdir(), "alm-seed-check-empty-"));
    made.push(root);
    const report = await seedStore(new FileStore(root), repoRoot(), { mode: "check" });
    expect(readdirSync(root)).toEqual([]);
    expect(report.written).toEqual([]);
    // Re-expectation: was 40; +2 for the liability book and its plan.
    // Re-expectation: was 42; +1 for the tlp-shock-demo-v1 derived market.
    // Re-expectation: was 43; +3 for the rate-indices-demo-v1 market, the synthetic-2500-indexed-v1 book and the plan-synthetic-2500-indexed-v1 plan.
    // Re-expectation: was 46; +1 for the vol-shock-demo-v1 derived market.
    // Re-expectation: was 47; +1 for the macro-demo-v1 derived market.
    // Re-expectation (Studio Piece 7b slice 4): was 48; +5 for the two housing sets and the three macro plans.
    // Re-expectation: was 63; +12 for the deposit desk's five sets and the seven deposit-form setups.
    // Re-expectation: was 75; +1 for the survival-path setup.
    expect(report.missing).toHaveLength(76);
    expect(report.missing).toContain("portfolios/vanilla-book-v1");
    expect(report.dbSync).toBeUndefined();
  }, 60_000);

  it("parses --check and refuses anything it does not know", () => {
    expect(parseSeedArgs([])).toEqual({ mode: "seed" });
    expect(parseSeedArgs(["--check"])).toEqual({ mode: "check" });
    expect(() => parseSeedArgs(["--chek"])).toThrow(/unrecognized arguments/);
  });
});
