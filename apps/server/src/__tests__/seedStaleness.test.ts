/**
 * Seed staleness detection (spec 2026-09-23 Section 3 and Section 7
 * tests 1, 2 and 6). A seeded document whose stored contentHash differs from
 * sha256(serializeDocument(today's document)) is STALE: reported with both
 * hashes and up to five differing paths, never rewritten by a default seed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { diffPaths, planSeedDocuments, runSeedCli, SEED_IDS, seedStore } from "../../scripts/seed-store";
import { copyStoreWithoutDb, plantImportedCoa, plantStaleVanillaSlate, seededTemplate, snapshotTree } from "./seedFixtures";

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
const VANILLA_SLATE = `scenario-slates/${SEED_IDS.vanillaSlate}`;

describe("planSeedDocuments", () => {
  it("names the 76 documents the seed writes, in order", async () => {
    // Restated literally from a fresh seed, then restated for Piece 9 (the loan repricing
    // set, slate and plan under new ids) and for Studio Piece 5 (the demonstration hierarchy) and for Studio Piece 6a (the derived decay shock set and its slate) and for Studio Piece 6b (the deposit targets balance plan and its derived shock plan), and for Studio Piece 5b (the liability book and its contractual plan; Re-expectation: 40 to 42), and for Studio Piece 6c (the derived market tlp-shock-demo-v1 right after its base; Re-expectation: 42 to 43), and for Studio Piece 7a (the rate indices market after tlp-shock-demo-v1, the indexed book after the liability book, the indexed plan after the liability plan; Re-expectation: 43 to 46), and for Studio Piece 6d (the derived market vol-shock-demo-v1 right after rate-indices-demo-v1; Re-expectation: 46 to 47), and for Studio Piece 7b (the derived market macro-demo-v1 right after vol-shock-demo-v1; Re-expectation: 47 to 48), and for Studio Piece 7b slice 4 (the two housing sets after decay-shock-demo-v1, the three macro plans after the indexed plan; Re-expectation (Studio Piece 7b slice 4): 48 to 53), and for Studio slice S3a-1 (the example bank's chart right after the demo chart; Re-expectation: 53 to 54), and for Studio slice S3b-1 (the feature demos' two sets and seven run setups, just before the hierarchy; Re-expectation: 54 to 63), and for Studio slice S3c-1 (the deposit desk's five sets and the seven S3c-1 run setups, after the and before the hierarchy; Re-expectation: 63 to 75), and for Studio slice S3d-1 (the survival-path setup, after the and before the hierarchy; Re-expectation: 75 to 76), not read from SEED_IDS.
    expect((await planSeedDocuments(repoRoot())).map((d) => `${d.collection}/${d.id}`)).toEqual([
      "portfolios/vanilla-book-v1",
      "portfolios/synthetic-2500-v1",
      "portfolios/synthetic-2500-hqla-v1",
      "portfolios/synthetic-2500-lcr-v1",
      "portfolios/synthetic-2500-commit-v1",
      "portfolios/synthetic-2500-hedged-v1",
      "portfolios/synthetic-lcr-liabilities-v1",
      "portfolios/synthetic-2500-indexed-v1",
      "market/market-public-2026-03-31",
      "market/tlp-shock-demo-v1",
      "market/rate-indices-demo-v1",
      "market/vol-shock-demo-v1",
      "market/macro-demo-v1",
      "assumption-sets/demo-behavioral-v1",
      "assumption-sets/vanilla-empty-v1",
      "assumption-sets/stress-illustrative-v1",
      "assumption-sets/liquidity-stress-demo-v1",
      "assumption-sets/liquidity-squeeze-demo-v1",
      "assumption-sets/loan-repricing-demo-v1",
      "assumption-sets/decay-shock-demo-v1",
      "assumption-sets/housing-demo-v1",
      "assumption-sets/housing-flat-demo-v1",
      "scenario-slates/regulatory-grid-demo",
      "scenario-slates/regulatory-grid-vanilla",
      "scenario-slates/regulatory-grid-stress",
      "scenario-slates/liquidity-grid-stress",
      "scenario-slates/liquidity-grid-squeeze",
      "scenario-slates/regulatory-grid-loan-repricing",
      "scenario-slates/regulatory-grid-decay-shock",
      "plans/balance-targets-demo-v1",
      "plans/balance-shock-demo-v1",
      "routing-policies/model-map-default-v1",
      "run-plans/plan-synthetic-2500-v1",
      "run-plans/plan-synthetic-2500-hedged-v1",
      "run-plans/plan-vanilla-book-v1",
      "run-plans/plan-synthetic-2500-loan-repricing-v1",
      "run-plans/plan-synthetic-lcr-liabilities-v1",
      "run-plans/plan-synthetic-2500-indexed-v1",
      "run-plans/plan-synthetic-2500-macro-unmapped-v1",
      "run-plans/plan-synthetic-2500-housing-v1",
      "run-plans/plan-synthetic-2500-housing-flat-v1",
      "coa/demo-coa-v1",
      "coa/mid-size-bank-coa-v1",
      "taxonomy/demo-dimensions-v1",
      "taxonomy/hqla-tags-v1",
      "taxonomy/liquidity-tags-v1",
      "taxonomy/liquidity-tags-v2",
      "lens/liquidity-demo-v1",
      "lens/rate-demo-v1",
      "lens/capital-demo-v1",
      "lens/strategy-demo-v1",
      "lens/balance-demo-v1",
      "lens/wal-gap-demo-v1",
      "assumption-sets/quillfield-illustrative-v1",
      "assumption-sets/quillfield-constant-prepay-v1",
      // The seven demo setups carry the model convention, so their content-hash ids moved.
      "run-setups/rs-8bdea9130955246f",
      "run-setups/rs-5bbb0161a5de0eaf",
      "run-setups/rs-0ed630692ab4a79b",
      "run-setups/rs-b59d79cc1705e301",
      "run-setups/rs-7a873feeecd5f0e8",
      "run-setups/rs-6adc639a3bb62a19",
      "run-setups/rs-be877bacf7426290",
      // The deposit desk's five sets, then the seven deposit-form setups.
      "assumption-sets/quillfield-desk-plain-v1",
      "assumption-sets/quillfield-desk-component-decay-v1",
      "assumption-sets/quillfield-desk-full-beta-v1",
      "assumption-sets/quillfield-desk-credit-v1",
      "assumption-sets/quillfield-desk-scenario-credit-v1",
      "run-setups/rs-da90d9413342d732",
      "run-setups/rs-8a4f75c26745d17a",
      "run-setups/rs-fa2e1a4dd654ea36",
      "run-setups/rs-016aea5d82ea48c9",
      "run-setups/rs-a803c39f88ef82ec",
      "run-setups/rs-3e4d2c1ca427e271",
      "run-setups/rs-b68350f06336a9e7",
      // The survival-path setup.
      "run-setups/rs-743d34bc847cb047",
      "hierarchies/liquidity-funding-demo-v1",
    ]);
  });
});

describe("seed staleness detection", () => {
  it("reports a planted stale seeded document with both hashes and its differing paths", async () => {
    const root = copy("alm-seed-stale-");
    const storedHash = plantStaleVanillaSlate(root);
    const report = await seedStore(new FileStore(root), repoRoot());
    expect(report.stale.map((s) => `${s.collection}/${s.id}`)).toEqual([VANILLA_SLATE]);
    const s = report.stale[0];
    expect(s.storedHash).toBe(storedHash);
    expect(s.currentHash).toBe(new FileStore(template).getMeta("scenario-slates", SEED_IDS.vanillaSlate).contentHash);
    expect(s.differences.length).toBeGreaterThan(0);
    expect(s.differences.length).toBeLessThanOrEqual(5);
    const sm200 = s.differences.find((d) => d.stored === "SM200");
    expect(sm200?.path).toMatch(/^scenarios\[\d+\]\.id$/);
    expect(sm200?.current).toBe("S-200");
  }, 60_000);

  it("a default seed over a stale store leaves every existing file byte-identical", async () => {
    const root = copy("alm-seed-stale-bytes-");
    plantStaleVanillaSlate(root);
    const before = snapshotTree(root);
    const report = await seedStore(new FileStore(root), repoRoot());
    const after = snapshotTree(root);
    for (const [path, hash] of before) expect(after.get(path), path).toBe(hash);
    expect(report.written).toEqual([]);
    expect(report.skipped).toContain(VANILLA_SLATE);
  }, 60_000);

  it("a freshly seeded store reports nothing stale", async () => {
    const report = await seedStore(new FileStore(copy("alm-seed-fresh-")), repoRoot());
    expect(report.stale).toEqual([]);
    expect(report.written).toEqual([]);
    // Re-expectation: was 40; +2 for the liability book and its plan.
    // Re-expectation: was 42; +1 for the tlp-shock-demo-v1 derived market.
    // Re-expectation: was 43; +3 for the indices market, the indexed book and the indexed plan.
    // Re-expectation: was 46; +1 for the vol-shock-demo-v1 derived market.
    // Re-expectation: was 47; +1 for the macro-demo-v1 derived market.
    // Re-expectation (Studio Piece 7b slice 4): was 48; +5 for the two housing sets and the three macro plans.
    // Re-expectation: was 63; +12 for the deposit desk's five sets and the seven deposit-form setups.
    expect(report.skipped).toHaveLength(76);
  }, 60_000);

  it("does not check a document imported over a seeded id", async () => {
    const root = copy("alm-seed-imported-");
    plantImportedCoa(root);
    const report = await seedStore(new FileStore(root), repoRoot());
    expect(report.stale).toEqual([]);
    expect(report.skipped).toContain(`coa/${SEED_IDS.demoCoa}`);
  }, 60_000);

  it("the CLI prints one STALE block per stale document and exits 0 in default mode", async () => {
    const root = copy("alm-seed-stale-cli-");
    plantStaleVanillaSlate(root);
    const lines: string[] = [];
    const code = await runSeedCli([], new FileStore(root), repoRoot(), (l) => lines.push(l));
    expect(code).toBe(0);
    expect(lines.filter((l) => l.startsWith("seed: STALE "))).toEqual([`seed: STALE ${VANILLA_SLATE}`]);
    expect(lines).toContain(`seed:   refresh with: npm run platform:seed -- --refresh ${VANILLA_SLATE}`);
  }, 60_000);
});

describe("diffPaths", () => {
  it("names differing leaf paths with both values and stops at five", () => {
    const d = diffPaths({ a: [1, 2, 3, 4, 5, 6, 7], b: "x" }, { a: [0, 0, 0, 0, 0, 0, 0], b: "x" });
    expect(d).toHaveLength(5);
    expect(d[0]).toEqual({ path: "a[0]", stored: 1, current: 0 });
  });
  it("reports an added key and a length change, and nothing for equal documents", () => {
    expect(diffPaths({ x: { y: 1 } }, { x: { y: 1 } })).toEqual([]);
    expect(diffPaths({ k: [1] }, { k: [1, 2], n: true })).toEqual([
      { path: "k[1]", stored: undefined, current: 2 },
      { path: "n", stored: undefined, current: true },
    ]);
  });
});
