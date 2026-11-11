/**
 * The default seed profile is byte-identical.
 *
 * `ALM_SEED_PROFILE` absent or "demo" plans the same 53 documents, with the same bytes and the same meta, as the
 * seed did before the profile existed. The two hashes below were computed then by hashing
 * `planSeedDocuments(repoRoot)` (one line per document: `<collection>/<id> <sha256 of the stored bytes>`, and a
 * second list of `<collection>/<id> <JSON of the meta>`), so a profile change that leaked into the default plan
 * fails here. A default seed of an empty store followed by `--check` reports nothing stale and nothing missing,
 * writes the same workspaces with or without the explicit profile, and never writes a pack profile's workspace.
 * OSS slice S1 re-pinned the two hashes once: the demo routing policy and taxonomy take neutral ids
 * (model-map-default-v1, demo-dimensions-v1), the policy's label and its classes change wording only,
 * and the taxonomy's label is its own; the other 51 documents are byte-identical or differ only by the policy
 * id in a run plan.
 * Studio slice S3a-1 adds one document, coa/mid-size-bank-coa-v1 (the example bank's chart, for the v2 CSV
 * template). The pins are not moved: the plan without that one document still hashes to them, which proves the other
 * 53 documents keep their bytes and meta; the added document is checked against the example file itself.
 * Studio slice S3b-1 adds nine more, just before the hierarchy: the feature demos' two sets and seven run setups. The pins
 * still are not moved: the plan without the ten added documents hashes to them; the nine are checked against the demo
 * module's own plan (planFeatureDemoDocuments) and by count and collection.
 * Studio slice S3c-1 adds twelve more after those, still before the hierarchy: the deposit desk's five sets and the
 * seven S3c-1 run setups. The pins still are not moved: the plan without the twenty-two added documents hashes to them;
 * the twelve are checked against their module's own plan (planDepositFormDocuments).
 * Studio slice S3d-1 adds one more after those, still before the hierarchy: the survival-path run setup. The pins still
 * are not moved: the plan without the twenty-three added documents hashes to them; the one is checked against its
 * module's own plan (planSurvivalPathDocuments).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot, resolveConfig } from "../config";
import { FileStore, serializeDocument } from "../store/store";
import { planDepositFormDocuments, planFeatureDemoDocuments, planSeedDocuments, planSurvivalPathDocuments, runSeedCli, seedStore } from "../../scripts/seed-store";
import { registerSeedProfile } from "../registry";

// A synthetic registered profile: config accepts it once a pack registers it. It is never seeded here.
registerSeedProfile({ id: "demo-extra", plan: async () => [], seedWorkspaces: () => [] });

const DEMO_PLAN_DOC_HASH = "4dc454624c7ed713fa79676e22b0c32060b5c2f2021b6a7ca69e707437773901";
const DEMO_PLAN_META_HASH = "86f2b13373cdc77b53b2b05783fd6a331f0fac67e12e0f9afb718a889ae0984c";

const made: string[] = [];
afterAll(() => {
  for (const d of made) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // The OS temp cleaner owns the leftovers.
    }
  }
});
const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The one document Studio slice S3a-1 adds to the plan. */
const S3A1_DOC = "coa/mid-size-bank-coa-v1";

/** The nine documents Studio slice S3b-1 adds, by key. */
const s3b1Keys = (): Set<string> => new Set(planFeatureDemoDocuments(repoRoot()).map((d) => `${d.collection}/${d.id}`));

/** The twelve documents Studio slice S3c-1 adds, by key. */
const s3c1Keys = (): Set<string> => new Set(planDepositFormDocuments(repoRoot()).map((d) => `${d.collection}/${d.id}`));

/** The one document Studio slice S3d-1 adds, by key. */
const s3d1Keys = (): Set<string> => new Set(planSurvivalPathDocuments(repoRoot()).map((d) => `${d.collection}/${d.id}`));

async function planHashes(profile?: "demo"): Promise<{ count: number; docs: string; meta: string; added: unknown }> {
  const all = profile === undefined ? await planSeedDocuments(repoRoot()) : await planSeedDocuments(repoRoot(), profile);
  const added = all.find((d) => `${d.collection}/${d.id}` === S3A1_DOC)?.doc;
  const s3b1 = s3b1Keys();
  const s3c1 = s3c1Keys();
  const s3d1 = s3d1Keys();
  const docs = all.filter((d) => `${d.collection}/${d.id}` !== S3A1_DOC && !s3b1.has(`${d.collection}/${d.id}`) && !s3c1.has(`${d.collection}/${d.id}`) && !s3d1.has(`${d.collection}/${d.id}`));
  return {
    added,
    count: all.length,
    docs: sha(docs.map((d) => `${d.collection}/${d.id} ${sha(serializeDocument(d.doc))}`).join("\n")),
    meta: sha(docs.map((d) => `${d.collection}/${d.id} ${JSON.stringify(d.meta)}`).join("\n")),
  };
}

describe("the default seed profile", () => {
  it("resolves to demo when ALM_SEED_PROFILE is absent and refuses a profile it does not know", () => {
    expect(resolveConfig({}).seedProfile).toBe("demo");
    expect(resolveConfig({ ALM_SEED_PROFILE: "demo" }).seedProfile).toBe("demo");
    expect(resolveConfig({ ALM_SEED_PROFILE: "demo-extra" }).seedProfile).toBe("demo-extra");
    // The third core profile, "learn", is listed after "starter".
    expect(() => resolveConfig({ ALM_SEED_PROFILE: "nope" })).toThrow(/ALM_SEED_PROFILE must be one of "demo", "starter", "learn", "demo-extra", got "nope"/);
  });

  it("plans the same 53 documents, bytes and meta as before the profile existed, plus the S3a-1 chart, the S3b-1 demos, the S3c-1 documents and the S3d-1 setup, with or without the explicit profile", async () => {
    const implicit = await planHashes();
    const explicit = await planHashes("demo");
    const bankCoa = (JSON.parse(readFileSync(join(repoRoot(), "examples", "mid-size-bank-v1.json"), "utf8")) as { coa: unknown }).coa;
    expect(implicit).toEqual({ count: 76, docs: DEMO_PLAN_DOC_HASH, meta: DEMO_PLAN_META_HASH, added: bankCoa });
    // The nine added documents are the demo module's own, two sets then seven setups; the twelve follow them,
    // five sets then seven setups; the one setup follows those, and the hierarchy is still last.
    const all = await planSeedDocuments(repoRoot());
    const tail = all.slice(-23, -14);
    const s3c = all.slice(-14, -2);
    const s3d = all.slice(-2, -1);
    const ownD = planSurvivalPathDocuments(repoRoot());
    expect(s3d.map((d) => `${d.collection}/${d.id}`)).toEqual(ownD.map((d) => `${d.collection}/${d.id}`));
    expect(s3d.map((d) => sha(serializeDocument(d.doc)))).toEqual(ownD.map((d) => sha(serializeDocument(d.doc))));
    expect(s3d.map((d) => d.collection)).toEqual(["run-setups"]);
    const ownC = planDepositFormDocuments(repoRoot());
    expect(s3c.map((d) => `${d.collection}/${d.id}`)).toEqual(ownC.map((d) => `${d.collection}/${d.id}`));
    expect(s3c.map((d) => sha(serializeDocument(d.doc)))).toEqual(ownC.map((d) => sha(serializeDocument(d.doc))));
    expect(`${all[all.length - 1]!.collection}/${all[all.length - 1]!.id}`).toBe("hierarchies/liquidity-funding-demo-v1");
    const own = planFeatureDemoDocuments(repoRoot());
    expect(tail.map((d) => `${d.collection}/${d.id}`)).toEqual(own.map((d) => `${d.collection}/${d.id}`));
    expect(tail.map((d) => d.collection)).toEqual(["assumption-sets", "assumption-sets", ...Array<string>(7).fill("run-setups")]);
    expect(tail.map((d) => sha(serializeDocument(d.doc)))).toEqual(own.map((d) => sha(serializeDocument(d.doc))));
    expect(explicit).toEqual(implicit);
    // Fix round L7: the added chart read on its own terms, by hand, not only as the file's copy: 23 families, one swap
    // family on the derivative side and one commitment family on the asset side.
    const fams = (implicit.added as { families: Array<{ side: string; instrumentType: string }> }).families;
    expect(fams).toHaveLength(23);
    expect(fams.filter((f) => f.instrumentType === "swap").map((f) => f.side)).toEqual(["derivative"]);
    expect(fams.filter((f) => f.instrumentType === "commitment").map((f) => f.side)).toEqual(["asset"]);
  }, 60_000);

  it("keeps the shared public market without a curveDefault marker (B4 Task 4)", async () => {
    const docs = await planSeedDocuments(repoRoot());
    const market = docs.find((d) => d.collection === "market" && d.id === "market-public-2026-03-31")!;
    expect(sha(serializeDocument(market.doc))).toBe("6d0501f30b0e59a93bb1294e68d5ed6041d473a264d5790e5da1dbdfa3a60731");
    expect("curveDefault" in (market.doc as object)).toBe(false);
    expect(docs.some((d) => d.collection === "market" && d.id !== "market-public-2026-03-31" && "curveDefault" in (d.doc as object))).toBe(false);
  }, 60_000);

  it("seeds an empty store, then --check reports 0 stale and 0 missing, and the explicit profile seeds the same store", async () => {
    const a = temp("alm-seed-demo-implicit-");
    const b = temp("alm-seed-demo-explicit-");
    const ra = await seedStore(new FileStore(a), repoRoot());
    const rb = await seedStore(new FileStore(b), repoRoot(), { mode: "seed" }, "demo");
    expect(ra.written).toHaveLength(76);
    expect(rb.written).toEqual(ra.written);
    expect(rb.workspaces?.created).toEqual(ra.workspaces?.created);
    // A registered profile's workspaces come only from its own seedWorkspaces; the default seed calls none.
    expect(ra.workspaces?.created.length).toBeGreaterThan(0);

    // Same document bytes in both stores, document by document.
    const sa = new FileStore(a);
    const sb = new FileStore(b);
    for (const key of ra.written) {
      const [collection, id] = [key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1)] as [Parameters<FileStore["getMeta"]>[0], string];
      expect(sb.getMeta(collection, id).contentHash, key).toBe(sa.getMeta(collection, id).contentHash);
    }

    const check = await seedStore(new FileStore(a), repoRoot(), { mode: "check" });
    expect(check.stale).toEqual([]);
    expect(check.missing).toEqual([]);
    const lines: string[] = [];
    expect(await runSeedCli(["--check"], new FileStore(a), repoRoot(), (l) => lines.push(l))).toBe(0);
    expect(lines.some((l) => l.includes("STALE"))).toBe(false);
    // The demo output names no profile line, as before the profile existed.
    expect(lines.some((l) => l.includes("profile"))).toBe(false);
  }, 180_000);
});
