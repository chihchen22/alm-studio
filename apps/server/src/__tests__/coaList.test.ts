// apps/server/src/__tests__/coaList.test.ts
// Studio blank-path round, Task 5 (D2): GET /api/coa lists the stored charts of accounts so the positions
// import form can offer a pick instead of a blank free-text id. Expected values are restated by hand:
// the seed stores one chart, "demo-coa-v1", labelled "Demo chart of accounts (11 families)"
// (apps/server/scripts/seed-store.ts). Studio slice S3a-1 adds a second, "mid-size-bank-coa-v1", the example bank's. The route reads the document store listing and writes nothing.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

interface CoaRow { id: string; label: string; contentHash: string }
interface CoaList { coa: CoaRow[] }

/** Every file under a directory as "relative path:size:content", sorted, for a before and after compare. */
function fileTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const here = rel === "" ? name : `${rel}/${name}`;
      if (statSync(full).isDirectory()) walk(full, here);
      else out.push(`${here}:${statSync(full).size}:${readFileSync(full, "utf8")}`);
    }
  };
  if (existsSync(root)) walk(root, "");
  return out.sort();
}

let t: TestPlatform | undefined;
afterEach(async () => {
  if (t !== undefined) await t.close();
  t = undefined;
});

describe("GET /api/coa", () => {
  it("lists the seeded chart of accounts with its label and content hash", async () => {
    t = await bootTestPlatform();
    const store = new FileStore(t.storeRoot);
    await seedStore(store, repoRoot());
    const r = await api<CoaList>(t.base, "GET", "/api/coa");
    expect(r.status).toBe(200);
    expect(r.body.coa.map((c) => c.id)).toEqual(["demo-coa-v1", "mid-size-bank-coa-v1"]);
    expect(r.body.coa[1]!.label).toBe("Quillfield Bank chart of accounts (23 families)");
    expect(r.body.coa[0]!.label).toBe("Demo chart of accounts (11 families)");
    expect(r.body.coa[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.coa[0]!.contentHash).toBe(store.getMeta("coa", "demo-coa-v1").contentHash);
  }, 300_000);

  it("answers an empty list on an empty store", async () => {
    t = await bootTestPlatform();
    const r = await api<CoaList>(t.base, "GET", "/api/coa");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ coa: [] });
  });

  it("sorts by id and gives an empty label for a chart with none", async () => {
    t = await bootTestPlatform();
    const store = new FileStore(t.storeRoot);
    store.putDocument("coa", "zz-coa", { families: [] }, { label: "Last chart" });
    store.putDocument("coa", "aa-coa", { families: [] }, {});
    const r = await api<CoaList>(t.base, "GET", "/api/coa");
    expect(r.body.coa.map((c) => [c.id, c.label])).toEqual([["aa-coa", ""], ["zz-coa", "Last chart"]]);
  });

  it("writes nothing: the store holds the same files before and after the read", async () => {
    t = await bootTestPlatform();
    const store = new FileStore(t.storeRoot);
    store.putDocument("coa", "c1", { families: [] }, { label: "One" });
    const before = fileTree(t.storeRoot);
    const r = await api<CoaList>(t.base, "GET", "/api/coa");
    expect(r.status).toBe(200);
    expect(r.body.coa).toHaveLength(1);
    expect(fileTree(t.storeRoot)).toEqual(before);
  });
});
