/**
 * The derive routes (preview and save), the plain-save
 * guard on derivedFrom, and the listing's derivedFromSetId. Runs on a scratch
 * store seeded by the real seedStore() through the test-platform harness.
 * Every expected value is restated from the approved design, never read back
 * from the code under test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssumptionSet, DerivationChange } from "@alm/engine";
import { buildDemoAssumptions } from "@alm/data/src/demo/request";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { seedStore } from "../../scripts/seed-store";
import { api, bootTestPlatform, warmCatalog, type TestPlatform } from "./harness";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
});
afterAll(() => t.close());

interface Err {
  error: { code: string; message: string; detail?: { problems?: Array<{ at: string; message: string }> } };
}
interface Preview {
  set: AssumptionSet;
  changes: DerivationChange[];
}
interface SaveReply extends Preview {
  outcome: string;
}
interface ListRow {
  id: string;
  label: string;
  contentHash: string;
  bindingCount?: number;
  derivedFromSetId?: string;
}

const BASE = "demo-behavioral-v1";
const DECAY_UP = {
  target: { familyId: "dda", kind: "nmd-decay" },
  path: "params.closureSteady",
  op: "scale",
  value: 1.25,
};
const body = (extra: Record<string, unknown> = {}) => ({ baseId: BASE, ops: [DECAY_UP], ...extra });
const metaOf = (id: string) => t.platform.context.store.getMeta("assumption-sets", id);
const rows = async () => (await api<ListRow[]>(t.base, "GET", "/api/assumption-sets")).body;

describe("POST /api/assumption-sets/derive/preview", () => {
  it("R1: answers 200 with the derived set and its changes, and stores nothing", async () => {
    const r = await api<Preview>(t.base, "POST", "/api/assumption-sets/derive/preview", body());
    expect(r.status).toBe(200);
    expect(r.body.set.id).toMatch(/^derived-[0-9a-f]{12}$/);
    expect(r.body.changes[0]).toMatchObject({ path: "params.closureSteady", from: 0.75, to: 0.9375 });
    const baseRow = (await rows()).find((x) => x.id === BASE)!;
    expect(r.body.set.derivedFrom!.baseContentHash).toBe(baseRow.contentHash);
    expect(t.platform.context.store.has("assumption-sets", r.body.set.id)).toBe(false);
  });

  it("R9: a caller id is used verbatim on preview", async () => {
    const r = await api<Preview>(t.base, "POST", "/api/assumption-sets/derive/preview", body({ id: "my-decay-shock" }));
    expect(r.status).toBe(200);
    expect(r.body.set.id).toBe("my-decay-shock");
    expect(t.platform.context.store.has("assumption-sets", "my-decay-shock")).toBe(false);
  });
});

describe("POST /api/assumption-sets/derive", () => {
  let derivedId = "";
  let created: SaveReply;
  let importedAt = "";

  it("R2: 201 created; the stored set, the listing row and the meta agree", async () => {
    const r = await api<SaveReply>(t.base, "POST", "/api/assumption-sets/derive", body());
    expect(r.status).toBe(201);
    expect(r.body.outcome).toBe("created");
    created = r.body;
    derivedId = r.body.set.id;
    const stored = await api<AssumptionSet>(t.base, "GET", `/api/assumption-sets/${derivedId}`);
    expect(stored.body).toEqual(r.body.set);
    const row = (await rows()).find((x) => x.id === derivedId)!;
    expect(row.derivedFromSetId).toBe(BASE);
    expect(row.contentHash).toBe(r.body.set.contentHash);
    expect(row.bindingCount).toBe(4);
    const meta = metaOf(derivedId);
    expect(meta.derivedOpCount).toBe(1);
    expect(meta.derivedFromSetId).toBe(BASE);
    importedAt = meta.importedAt;
  });

  it("a plain row carries no derivedFromSetId key", async () => {
    const row = (await rows()).find((x) => x.id === BASE)!;
    expect("derivedFromSetId" in row).toBe(false);
  });

  it("R3: the same save again answers 200 unchanged and rewrites nothing", async () => {
    const r = await api<SaveReply>(t.base, "POST", "/api/assumption-sets/derive", body());
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("unchanged");
    expect(r.body.set).toEqual(created.set);
    expect(metaOf(derivedId).importedAt).toBe(importedAt);
  });

  it("R4: the same ops under another label answer 409", async () => {
    const r = await api<Err>(t.base, "POST", "/api/assumption-sets/derive", body({ label: "Other label" }));
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain("already exists with different content");
  });

  it("R9: a caller id saves under that id", async () => {
    const r = await api<SaveReply>(t.base, "POST", "/api/assumption-sets/derive", body({ id: "my-decay-shock" }));
    expect(r.status).toBe(201);
    expect(r.body.set.id).toBe("my-decay-shock");
    expect(t.platform.context.store.has("assumption-sets", "my-decay-shock")).toBe(true);
    expect(r.body.set.label).toBe("Behavioral shock on demo-behavioral-v1 (demonstration values)");
  });

  it("R5: two out-of-bound ops answer 422 listing both problems, in order", async () => {
    const ops = [
      { target: { familyId: "mortgages", kind: "prepay" }, path: "params.maxCpr", op: "scale", value: 2 },
      { target: { familyId: "mma", kind: "deposit-beta" }, path: "params.lambda", op: "add", value: 0.5 },
    ];
    for (const path of ["/api/assumption-sets/derive", "/api/assumption-sets/derive/preview"]) {
      const r = await api<Err>(t.base, "POST", path, { baseId: BASE, ops });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe("validation");
      expect(r.body.error.detail!.problems).toEqual([
        { at: "bindings[0].overlay.params.maxCpr", message: "mortgages prepay: Maximum CPR must be at most 100" },
        { at: "bindings[3].overlay.params.lambda", message: "mma deposit-beta: Adjustment speed must be at most 1" },
      ]);
    }
  });

  it("R6: an unknown base is 404; an unknown body key, a reserved or malformed id is 422", async () => {
    const missing = await api<Err>(t.base, "POST", "/api/assumption-sets/derive", { baseId: "nope-v1", ops: [DECAY_UP] });
    expect(missing.status).toBe(404);

    const extra = await api<Err>(t.base, "POST", "/api/assumption-sets/derive", body({ extra: 1 }));
    expect(extra.status).toBe(422);
    expect(extra.body.error.message).toBe('unknown field "extra" in the request body; send { baseId, ops, id?, label? }');

    const stack = await api<Err>(t.base, "POST", "/api/assumption-sets/derive", body({ id: "stack-x" }));
    expect(stack.status).toBe(422);
    expect(stack.body.error.message).toBe("ids starting stack- are reserved for assumption stacks");

    const derived = await api<Err>(t.base, "POST", "/api/assumption-sets/derive", body({ id: "derived-abc" }));
    expect(derived.status).toBe(422);
    expect(derived.body.error.message).toBe("ids starting derived- are reserved for the derived id; leave id empty to get it");

    const bad = await api<Err>(t.base, "POST", "/api/assumption-sets/derive", body({ id: "bad id!" }));
    expect(bad.status).toBe(422);
  });

  it("answers 422 with the usage text for a non-object body, a bad baseId, ops or label type", async () => {
    const usage = "POST /api/assumption-sets/derive takes { baseId, ops, id?, label? }";
    const cases: unknown[] = [[], JSON.stringify("x"), { baseId: 7, ops: [] }, { baseId: BASE, ops: "no" }, body({ id: 5 }), body({ label: 5 })];
    for (const c of cases) {
      const r = await api<Err>(t.base, "POST", "/api/assumption-sets/derive/preview", c);
      expect(r.status).toBe(422);
      expect(r.body.error.message).toBe(usage);
    }
  });

  it("R8: the saved derived set binds as a plan default and the plan validates with no refusal", async () => {
    const plan = (await api<Record<string, any>>(t.base, "GET", "/api/run-plans/plan-synthetic-2500-v1")).body;
    const copy = JSON.parse(JSON.stringify(plan)) as Record<string, any>;
    copy.inputs.assumptionSets = [derivedId];
    const r = await api<{ type: { failures: unknown[] }; routing: { failures: unknown[] }; compile: unknown }>(
      t.base, "POST", "/api/plans/validate", { plan: copy },
    );
    expect(r.status).toBe(200);
    expect(r.body.compile).toEqual({ passed: true });
    expect(r.body.type.failures).toEqual([]);
    expect(r.body.routing.failures).toEqual([]);
  });
});

describe("a saved assumption set is mirrored at once", () => {
  it("a derived save answers on the catalog lineage read with no re-sync", async () => {
    await warmCatalog(t.base);
    const r = await api<SaveReply>(t.base, "POST", "/api/assumption-sets/derive", body({ id: "mirror-derived-v1" }));
    expect(r.status).toBe(201);
    const lin = await api<{ collection: string; id: string }>(t.base, "GET", "/api/catalog/lineage/assumption-sets/mirror-derived-v1");
    expect(lin.status).toBe(200);
    expect(lin.body).toMatchObject({ collection: "assumption-sets", id: "mirror-derived-v1" });
  });

  it("a plain save answers on the catalog lineage read with no re-sync", async () => {
    await warmCatalog(t.base);
    const r = await api(t.base, "POST", "/api/assumption-sets", { ...buildDemoAssumptions(), id: "mirror-plain-v1" });
    expect(r.status).toBe(201);
    expect((await api(t.base, "GET", "/api/catalog/lineage/assumption-sets/mirror-plain-v1")).status).toBe(200);
  });
});

describe("POST /api/assumption-sets refuses a forged derivedFrom", () => {
  it("R7: 422 with the decided text, and nothing is stored", async () => {
    const forged = {
      ...buildDemoAssumptions(),
      id: "forged-v1",
      derivedFrom: { baseId: BASE, baseContentHash: "0".repeat(64), ops: [] },
    };
    const r = await api<Err>(t.base, "POST", "/api/assumption-sets", forged);
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe("derivedFrom is written by POST /api/assumption-sets/derive; a plain save cannot carry it");
    expect(t.platform.context.store.has("assumption-sets", "forged-v1")).toBe(false);
  });

  it("a plain save without derivedFrom still answers 201", async () => {
    const r = await api(t.base, "POST", "/api/assumption-sets", { ...buildDemoAssumptions(), id: "plain-copy-v1" });
    expect(r.status).toBe(201);
  });
});
