/**
 * `seed-store.ts --refresh <collection>/<id>` (spec 2026-09-23
 * Section 4 and Section 7 tests 4 and 5). Every refusal happens before any
 * file moves; a refresh moves the stale pair byte for byte into
 * superseded/<stamp>/, writes today's document, and does not sync the database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../config";
import { FileStore, serializeDocument, sha256Hex, type RenameFn } from "../store/store";
import { ID_PATTERN } from "../store/paths";
import {
  parseSeedArgs,
  runSeedCli,
  SEED_IDS,
  SeedRefreshRefusedError,
  seedStore,
  supersedeStamp,
} from "../../scripts/seed-store";
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
const STAMP = "2026-09-23T00-00-00-000Z";
const SLATE = `scenario-slates/${SEED_IDS.vanillaSlate}`;

async function refusal(root: string, targets: string[]): Promise<SeedRefreshRefusedError> {
  try {
    await seedStore(new FileStore(root), repoRoot(), { mode: "refresh", targets, stamp: STAMP });
  } catch (err) {
    if (err instanceof SeedRefreshRefusedError) return err;
    throw err;
  }
  throw new Error("expected a SeedRefreshRefusedError, the refresh went through");
}

describe("seed --refresh", () => {
  it("moves the stale pair byte for byte, writes the manifest line, and leaves today's document", async () => {
    const root = copy("alm-seed-refresh-");
    const oldHash = plantStaleVanillaSlate(root);
    const store = new FileStore(root);
    const oldDoc = readFileSync(store.paths.documentPath("scenario-slates", SEED_IDS.vanillaSlate));
    const oldMeta = readFileSync(store.paths.metaPath("scenario-slates", SEED_IDS.vanillaSlate));
    const todayHash = new FileStore(template).getMeta("scenario-slates", SEED_IDS.vanillaSlate).contentHash;

    const report = await seedStore(store, repoRoot(), { mode: "refresh", targets: [SLATE], stamp: STAMP });

    const dir = join(root, "superseded", STAMP, "scenario-slates");
    expect(readFileSync(join(dir, `${SEED_IDS.vanillaSlate}.json`)).equals(oldDoc)).toBe(true);
    expect(readFileSync(join(dir, `${SEED_IDS.vanillaSlate}.meta.json`)).equals(oldMeta)).toBe(true);
    const line = JSON.parse(readFileSync(join(root, "superseded", STAMP, "manifest.ndjson"), "utf8").trim()) as Record<string, unknown>;
    expect([line.collection, line.id, line.oldHash, line.newHash]).toEqual([
      "scenario-slates",
      SEED_IDS.vanillaSlate,
      oldHash,
      todayHash,
    ]);
    expect(sha256Hex(store.getDocumentBytes("scenario-slates", SEED_IDS.vanillaSlate))).toBe(todayHash);
    expect(store.getMeta("scenario-slates", SEED_IDS.vanillaSlate).seeded).toBe(true);
    expect(report.written).toEqual([SLATE]);
    expect(report.stale).toEqual([]);
    expect(report.superseded?.map((r) => `${r.collection}/${r.id}`)).toEqual([SLATE]);
    expect(report.dbSync).toBeUndefined();
    expect(readdirSync(root).filter((n) => n.startsWith("platform.db"))).toEqual([]);
  }, 60_000);

  it("refuses an unknown id before moving the valid stale target named ahead of it", async () => {
    const root = copy("alm-seed-refresh-unknown-");
    plantStaleVanillaSlate(root);
    const before = snapshotTree(root);
    const err = await refusal(root, [SLATE, "lens/not-a-seeded-lens"]);
    expect([err.reason, err.target]).toEqual(["unknown", "lens/not-a-seeded-lens"]);
    expect([...snapshotTree(root)]).toEqual([...before]);
  }, 60_000);

  it("refuses an imported (non-seeded) document before moving anything", async () => {
    const root = copy("alm-seed-refresh-imported-");
    plantStaleVanillaSlate(root);
    plantImportedCoa(root);
    const before = snapshotTree(root);
    const err = await refusal(root, [SLATE, `coa/${SEED_IDS.demoCoa}`]);
    expect([err.reason, err.target]).toEqual(["not-seeded", `coa/${SEED_IDS.demoCoa}`]);
    expect([...snapshotTree(root)]).toEqual([...before]);
  }, 60_000);

  it("refuses a current (not stale) document before moving anything", async () => {
    const root = copy("alm-seed-refresh-current-");
    plantStaleVanillaSlate(root);
    const before = snapshotTree(root);
    const target = `portfolios/${SEED_IDS.vanillaPortfolio}`;
    const err = await refusal(root, [SLATE, target]);
    expect([err.reason, err.target]).toEqual(["not-stale", target]);
    expect([...snapshotTree(root)]).toEqual([...before]);
  }, 60_000);

  it("refuses a seeded id the store does not hold, creating nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "alm-seed-refresh-absent-"));
    made.push(root);
    const err = await refusal(root, ["lens/rate-demo-v1"]);
    expect(err.reason).toBe("absent");
    expect(readdirSync(root)).toEqual([]);
  }, 60_000);

  it("the CLI prints the move and the database rebuild, and exits 0", async () => {
    const root = copy("alm-seed-refresh-cli-");
    plantStaleVanillaSlate(root);
    const lines: string[] = [];
    const code = await runSeedCli(["--refresh", SLATE], new FileStore(root), repoRoot(), (l) => lines.push(l));
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith(`seed: superseded ${SLATE} into `))).toBe(true);
    expect(lines.some((l) => l.includes("platform.db was NOT synced"))).toBe(true);
    expect(lines.some((l) => l.includes("migrate-store.ts --store"))).toBe(true);
  }, 60_000);

  it("a failure on the second target's move leaves the first rewritten, the second untouched, and prints the rebuild", async () => {
    const root = copy("alm-seed-refresh-partial-");
    plantStaleVanillaSlate(root);
    // A second stale SEEDED target: today's demo coa with changed bytes, meta still seeded: true.
    const store = new FileStore(root);
    const coaId = SEED_IDS.demoCoa;
    const coaBytes = serializeDocument({ ...store.getDocument<Record<string, unknown>>("coa", coaId).doc, staleNote: "old" });
    writeFileSync(store.paths.documentPath("coa", coaId), coaBytes);
    writeFileSync(
      store.paths.metaPath("coa", coaId),
      serializeDocument({ ...store.getMeta("coa", coaId), contentHash: sha256Hex(coaBytes) }),
    );
    const coaDocBefore = readFileSync(store.paths.documentPath("coa", coaId));
    const coaMetaBefore = readFileSync(store.paths.metaPath("coa", coaId));
    const todaySlateHash = new FileStore(template).getMeta("scenario-slates", SEED_IDS.vanillaSlate).contentHash;

    // Seam: supersedeDocument's existing optional rename argument, failing on the second target only.
    const original = store.supersedeDocument.bind(store);
    let calls = 0;
    const failing: RenameFn = () => {
      throw Object.assign(new Error("injected EIO on the second target"), { code: "EIO" });
    };
    store.supersedeDocument = (collection, id, stamp, newHash) => {
      calls++;
      return original(collection, id, stamp, newHash, calls === 2 ? failing : undefined);
    };

    const lines: string[] = [];
    const run = runSeedCli(["--refresh", SLATE, "--refresh", `coa/${coaId}`], store, repoRoot(), (l) => lines.push(l));
    // The CLI entry maps a rejection to process.exit(1): a nonzero exit.
    await expect(run).rejects.toThrow(/injected EIO/);

    const slatePath = store.paths.documentPath("scenario-slates", SEED_IDS.vanillaSlate);
    const target1 = {
      supersededCount: readdirSync(join(root, "superseded")).length,
      rewritten: readdirSync(join(root, "scenario-slates")).includes(`${SEED_IDS.vanillaSlate}.json`),
      hashIsClean: readdirSync(join(root, "scenario-slates")).includes(`${SEED_IDS.vanillaSlate}.json`)
        ? sha256Hex(readFileSync(slatePath)) === todaySlateHash
        : false,
    };
    expect(target1).toEqual({ supersededCount: 1, rewritten: true, hashIsClean: true });
    expect(readFileSync(store.paths.documentPath("coa", coaId)).equals(coaDocBefore)).toBe(true);
    expect(readFileSync(store.paths.metaPath("coa", coaId)).equals(coaMetaBefore)).toBe(true);
    expect({
      supersededLine: lines.some((l) => l.startsWith(`seed: superseded ${SLATE} into `)),
      notSyncedLine: lines.some((l) => l.includes("platform.db was NOT synced")),
      rebuildLine: lines.some((l) => l.includes("migrate-store.ts --store")),
    }).toEqual({ supersededLine: true, notSyncedLine: true, rebuildLine: true });
  }, 60_000);

  it("parses repeated --refresh targets and refuses a bare flag", () => {
    expect(parseSeedArgs(["--refresh", "a/b", "--refresh", "c/d"])).toEqual({ mode: "refresh", targets: ["a/b", "c/d"] });
    expect(() => parseSeedArgs(["--refresh"])).toThrow(/unrecognized arguments/);
    expect(() => parseSeedArgs(["--check", "--refresh", "a/b"])).toThrow(/unrecognized arguments/);
  });

  it("stamps are filesystem-safe ids that sort by time", () => {
    const s = supersedeStamp(new Date(Date.UTC(2026, 8, 23, 14, 5, 9, 123)));
    expect(s).toBe("2026-09-23T14-05-09-123Z");
    expect(ID_PATTERN.test(s)).toBe(true);
  });
});
