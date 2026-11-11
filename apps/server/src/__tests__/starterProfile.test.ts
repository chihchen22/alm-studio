/**
 * The starter seed profile: the demo catalogue's documents, byte for byte, and no
 * workspace, so a newcomer's first screen offers the three start choices and no seeded workspace can read Error.
 * The two plan hashes are the demo profile's pins in seedProfileDemoUnchanged.test.ts, restated here.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot, resolveConfig } from "../config";
import { FileStore, serializeDocument } from "../store/store";
import { planDepositFormDocuments, planFeatureDemoDocuments, planSeedDocuments, planSurvivalPathDocuments, seedStore } from "../../scripts/seed-store";
import { registerSeedProfile } from "../registry";

const DEMO_PLAN_DOC_HASH = "4dc454624c7ed713fa79676e22b0c32060b5c2f2021b6a7ca69e707437773901";
const DEMO_PLAN_META_HASH = "86f2b13373cdc77b53b2b05783fd6a331f0fac67e12e0f9afb718a889ae0984c";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

describe("the starter seed profile", () => {
  it("is a core profile: config accepts it and a pack cannot take its id", () => {
    expect(resolveConfig({ ALM_SEED_PROFILE: "starter" }).seedProfile).toBe("starter");
    expect(() => registerSeedProfile({ id: "starter", plan: async () => [], seedWorkspaces: () => [] })).toThrow(/already registered/);
  });

  it("plans the demo catalogue's 76 documents with the demo bytes and meta", async () => {
    // The plan holds one more document, coa/mid-size-bank-coa-v1; without it the pins hold unchanged.
    // And nine more, the feature demos' two sets and seven run setups; without those too the pins hold.
    // And twelve more, the deposit desk's five sets and seven S3c-1 run setups; without those too.
    // And one more, the survival-path run setup; without it too.
    const all = await planSeedDocuments(repoRoot(), "starter");
    expect(all.length).toBe(76);
    const demos = new Set([...planFeatureDemoDocuments(repoRoot()), ...planDepositFormDocuments(repoRoot()), ...planSurvivalPathDocuments(repoRoot())].map((d) => `${d.collection}/${d.id}`));
    const docs = all.filter((d) => `${d.collection}/${d.id}` !== "coa/mid-size-bank-coa-v1" && !demos.has(`${d.collection}/${d.id}`));
    expect(sha(docs.map((d) => `${d.collection}/${d.id} ${sha(serializeDocument(d.doc))}`).join("\n"))).toBe(DEMO_PLAN_DOC_HASH);
    expect(sha(docs.map((d) => `${d.collection}/${d.id} ${JSON.stringify(d.meta)}`).join("\n"))).toBe(DEMO_PLAN_META_HASH);
  });

  it("seeds a fresh store with every document and no workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "alm-starter-"));
    made.push(root);
    const report = await seedStore(new FileStore(root), repoRoot(), { mode: "seed" }, "starter");
    expect(report.written.length).toBe(76);
    expect(report.workspaces?.created).toEqual([]);
    const wsDir = join(root, "workspaces");
    expect(existsSync(wsDir) ? readdirSync(wsDir).filter((n) => !n.startsWith(".")) : []).toEqual([]);
  }, 120_000);
});
