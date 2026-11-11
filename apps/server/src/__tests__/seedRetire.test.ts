/**
 * Retired seed ids (2026-09-24): a seeded id the seed no
 * longer writes is reported when a store still holds it, and moves aside only
 * on `--retire <collection>/<id>`. The case of record is the earlier
 * market `market/market-2026-03-31`, which ties on asOf with the public pack
 * and sorts first by id, so Studio would pick it as the default market.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import {
  parseSeedArgs,
  RETIRED_SEED_IDS,
  runSeedCli,
  SEED_IDS,
  SeedRetireRefusedError,
  seedStore,
} from "../../scripts/seed-store";
import { UNATTACHED_SEED_DOCUMENTS } from "../../scripts/seed-workspaces";
import { copyStoreWithoutDb, seededTemplate, snapshotTree } from "./seedFixtures";

const RETIRED_ID = "market-2026-03-31";
const TARGET = `market/${RETIRED_ID}`;
const STAMP = "2026-09-24T00-00-00-000Z";

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

/** An old store: the retired market as the pre-re-base seed wrote it (seeded: true). */
function plantRetiredMarket(root: string): void {
  const store = new FileStore(root);
  const doc = store.getDocument<unknown>("market", SEED_IDS.market).doc;
  store.putDocument("market", RETIRED_ID, doc, { label: "Vendored market snapshot 2026-03-31", seeded: true });
}

/** A stored run whose submission names the retired market. */
function plantRunOnRetiredMarket(root: string, runId: string): void {
  const dir = join(root, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "request.json"),
    JSON.stringify({
      portfolioRef: { id: SEED_IDS.syntheticPortfolio, contentHash: "x" },
      submission: { marketId: RETIRED_ID, scenarioSlateId: SEED_IDS.demoSlate, assumptionSetIds: [] },
    }),
  );
}

describe("retired seed ids", () => {
  it("lists the earlier market as retired", () => {
    expect(RETIRED_SEED_IDS.map((r) => `${r.collection}/${r.id}`)).toContain(TARGET);
  });

  it("a fresh store reports nothing retired", async () => {
    const root = copy("alm-seed-retire-fresh-");
    const report = await seedStore(new FileStore(root), repoRoot(), { mode: "check" });
    expect(report.retired).toEqual([]);
  }, 60_000);

  it("check reports a retired id the store still holds, with the runs that name it, and exits 1", async () => {
    const root = copy("alm-seed-retire-check-");
    plantRetiredMarket(root);
    plantRunOnRetiredMarket(root, "run-20260802-191359-00168e1");
    const before = snapshotTree(root);
    const report = await seedStore(new FileStore(root), repoRoot(), { mode: "check" });
    expect(report.retired.map((r) => [`${r.collection}/${r.id}`, r.runs])).toEqual([
      [TARGET, ["run-20260802-191359-00168e1"]],
    ]);
    expect([...snapshotTree(root)]).toEqual([...before]);

    const lines: string[] = [];
    const code = await runSeedCli(["--check"], new FileStore(root), repoRoot(), (l) => lines.push(l));
    expect(code).toBe(1);
    expect(lines).toContain(`seed: RETIRED ${TARGET}`);
    expect(lines.some((l) => l.includes(`--retire ${TARGET}`))).toBe(true);
  }, 60_000);

  it("--retire moves the pair byte for byte into superseded/<stamp>/ and deletes nothing", async () => {
    const root = copy("alm-seed-retire-move-");
    plantRetiredMarket(root);
    const store = new FileStore(root);
    const oldDoc = readFileSync(store.paths.documentPath("market", RETIRED_ID));
    const oldMeta = readFileSync(store.paths.metaPath("market", RETIRED_ID));

    const report = await seedStore(store, repoRoot(), { mode: "retire", targets: [TARGET], stamp: STAMP });

    const dir = join(root, "superseded", STAMP, "market");
    expect(readFileSync(join(dir, `${RETIRED_ID}.json`)).equals(oldDoc)).toBe(true);
    expect(readFileSync(join(dir, `${RETIRED_ID}.meta.json`)).equals(oldMeta)).toBe(true);
    const line = JSON.parse(readFileSync(join(root, "superseded", STAMP, "manifest.ndjson"), "utf8").trim()) as Record<string, unknown>;
    expect([line.collection, line.id, line.newHash]).toEqual(["market", RETIRED_ID, "retired"]);
    expect(store.has("market", RETIRED_ID)).toBe(false);
    expect(store.has("market", SEED_IDS.market)).toBe(true);
    expect(report.retired).toEqual([]);
    expect(report.written).toEqual([]);
    expect(report.superseded?.map((r) => `${r.collection}/${r.id}`)).toEqual([TARGET]);
    expect(readdirSync(root).filter((n) => n.startsWith("platform.db"))).toEqual([]);
  }, 60_000);

  it("--retire refuses, before any file moves, while a run names the document", async () => {
    const root = copy("alm-seed-retire-runs-");
    plantRetiredMarket(root);
    plantRunOnRetiredMarket(root, "run-20260802-191359-00168e1");
    const before = snapshotTree(root);
    const err = await seedStore(new FileStore(root), repoRoot(), { mode: "retire", targets: [TARGET], stamp: STAMP }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SeedRetireRefusedError);
    expect([(err as SeedRetireRefusedError).reason, (err as SeedRetireRefusedError).runs]).toEqual([
      "named-by-runs",
      ["run-20260802-191359-00168e1"],
    ]);
    expect([...snapshotTree(root)]).toEqual([...before]);
  }, 60_000);

  it("--retire refuses an id that is not on the retired list, and one the store does not hold", async () => {
    const root = copy("alm-seed-retire-unlisted-");
    const before = snapshotTree(root);
    const run = (t: string) =>
      seedStore(new FileStore(root), repoRoot(), { mode: "retire", targets: [t], stamp: STAMP }).then(
        () => null,
        (e: unknown) => (e as SeedRetireRefusedError).reason,
      );
    // The default seed creates workspaces and one pins the base market, so a workspace pin is decided
    // first (named-by-workspaces). "Not on the retired list" is exercised on a seeded document that no
    // seeded workspace pins: the one the seed leaves out of every workspace on purpose.
    const unpinned = UNATTACHED_SEED_DOCUMENTS.find((u) => u.collection === "taxonomy" && u.id === SEED_IDS.demoTaxonomy);
    expect(unpinned).toBeDefined();
    expect(await run(`taxonomy/${SEED_IDS.demoTaxonomy}`)).toBe("not-retired");
    expect(await run(`market/${SEED_IDS.market}`)).toBe("named-by-workspaces");
    expect(await run(TARGET)).toBe("absent");
    expect([...snapshotTree(root)]).toEqual([...before]);
  }, 60_000);

  it("the CLI prints the move and the database rebuild, and exits 0", async () => {
    const root = copy("alm-seed-retire-cli-");
    plantRetiredMarket(root);
    const lines: string[] = [];
    const code = await runSeedCli(["--retire", TARGET], new FileStore(root), repoRoot(), (l) => lines.push(l));
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith(`seed: superseded ${TARGET} into `))).toBe(true);
    expect(lines.some((l) => l.includes("migrate-store.ts --store"))).toBe(true);
  }, 60_000);

  it("parses repeated --retire targets and refuses a mix with --refresh", () => {
    expect(parseSeedArgs(["--retire", "a/b", "--retire", "c/d"])).toEqual({ mode: "retire", targets: ["a/b", "c/d"] });
    expect(() => parseSeedArgs(["--retire"])).toThrow(/unrecognized arguments/);
    expect(() => parseSeedArgs(["--retire", "a/b", "--refresh", "c/d"])).toThrow(/unrecognized arguments/);
  });
});
