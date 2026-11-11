/**
 * The balance-plan derive routes (preview and save),
 * the plain-save guard on derivedFrom, and the listing's derivedFromPlanId.
 * Runs on a scratch store seeded by the real seedStore() through the
 * test-platform harness, with the demo base plan ensured. Every expected value
 * is restated from the approved design, never read back from the code under test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BalanceKnotChange, BalancePlan, NewBusinessRule } from "@alm/engine";
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { seedStore } from "../../scripts/seed-store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";
import { ensureDemoBalancePlan } from "./seedFixtures";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
  ensureDemoBalancePlan(t.platform.context.store);
});
afterAll(() => t.close());

interface Err {
  error: { code: string; message: string; detail?: { problems?: Array<{ at: string; message: string }> } };
}
interface Preview {
  plan: BalancePlan;
  changes: BalanceKnotChange[];
  rules: NewBusinessRule[];
}
interface SaveReply extends Preview {
  outcome: string;
}
interface ListRow {
  id: string;
  label: string;
  asOf: string;
  contentHash: string;
  derivedFromPlanId?: string;
}

const BASE = "balance-targets-demo-v1";
const BOOK = "synthetic-2500-v1";
const SHOCK = { target: { familyId: "dda", month: 12 }, op: "scale", value: 0.9 };
const body = (extra: Record<string, unknown> = {}) => ({ baseId: BASE, bookId: BOOK, ops: [SHOCK], ...extra });
const metaOf = (id: string) => t.platform.context.store.getMeta("plans", id);
const rows = async () => (await api<ListRow[]>(t.base, "GET", "/api/balance-plans")).body;

describe("POST /api/balance-plans/derive/preview", () => {
  it("R1: answers 200 with the derived plan, change rows and lowered rules, and stores nothing", async () => {
    const before = await rows();
    const r = await api<Preview>(t.base, "POST", "/api/balance-plans/derive/preview", body());
    expect(r.status).toBe(200);
    expect(r.body.plan.id).toMatch(/^derived-bp-[0-9a-f]{12}$/);
    expect(r.body.plan.targets[0]!.path).toEqual([{ month: 12, balance: 87460374.6 }]);
    expect(r.body.plan.targets[1]).toEqual({
      familyId: "mma",
      path: [{ month: 12, balance: 156318023 }],
      newBusinessPricing: { spreadOverIndexBp: -100, termMonths: 12 },
    });
    expect(r.body.changes).toEqual([
      { targetIndex: 0, familyId: "dda", month: 12, from: 97178194, to: 87460374.6, ops: [0] },
    ]);
    expect(r.body.rules[0]!.reinvest).toBe("growth");
    expect(r.body.rules[0]!.monthlyGrowthRate).toBeCloseTo(-0.008741610954696721, 15);
    expect(r.body.rules[1]).toMatchObject({ familyId: "mma", reinvest: "flat", spreadOverIndexBp: -100, termMonths: 12 });
    const baseDoc = (await api<BalancePlan>(t.base, "GET", `/api/balance-plans/${BASE}`)).body;
    expect(r.body.plan.derivedFrom!.baseContentHash).toBe(contentHash(baseDoc));
    expect(r.body.plan.derivedFrom!.baseId).toBe(BASE);
    expect(t.platform.context.store.has("plans", r.body.plan.id)).toBe(false);
    expect(await rows()).toEqual(before);
  });
});

describe("POST /api/balance-plans/derive", () => {
  let derivedId = "";
  let created: SaveReply;
  let importedAt = "";

  it("R2: 201 created; the stored plan, the listing row and the meta agree", async () => {
    const r = await api<SaveReply>(t.base, "POST", "/api/balance-plans/derive", body());
    expect(r.status).toBe(201);
    expect(r.body.outcome).toBe("created");
    created = r.body;
    derivedId = r.body.plan.id;
    const stored = await api<BalancePlan>(t.base, "GET", `/api/balance-plans/${derivedId}`);
    expect(stored.body).toEqual(r.body.plan);
    expect(stored.body.derivedFrom!.baseId).toBe(BASE);
    const row = (await rows()).find((x) => x.id === derivedId)!;
    expect(row.derivedFromPlanId).toBe(BASE);
    expect(row.asOf).toBe("2026-03-31");
    const meta = metaOf(derivedId);
    expect(meta.derivedOpCount).toBe(1);
    expect(meta.checkedBookId).toBe(BOOK);
    expect(meta.targetCount).toBe(2);
    expect(meta.derivedFromPlanId).toBe(BASE);
    importedAt = meta.importedAt;
  });

  it("a plain row carries no derivedFromPlanId key", async () => {
    const row = (await rows()).find((x) => x.id === BASE)!;
    expect("derivedFromPlanId" in row).toBe(false);
  });

  it("R3: the same save again answers 200 unchanged and rewrites nothing; another book that lowers is also unchanged", async () => {
    const r = await api<SaveReply>(t.base, "POST", "/api/balance-plans/derive", body());
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("unchanged");
    expect(r.body.plan).toEqual(created.plan);
    expect(metaOf(derivedId).importedAt).toBe(importedAt);

    const other = await api<SaveReply>(t.base, "POST", "/api/balance-plans/derive", body({ bookId: "synthetic-2500-lcr-v1" }));
    expect(other.status).toBe(200);
    expect(other.body.outcome).toBe("unchanged");
    expect(metaOf(derivedId).checkedBookId).toBe(BOOK);
  });

  it("R4: the same ops under another label answer 409", async () => {
    const r = await api<Err>(t.base, "POST", "/api/balance-plans/derive", body({ label: "Other label" }));
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain("already exists with different content");
  });

  it("R5: a caller id saves under that id and the label carries the demonstration suffix", async () => {
    const r = await api<SaveReply>(t.base, "POST", "/api/balance-plans/derive", body({ id: "my-dda-shock", label: "Lower dda" }));
    expect(r.status).toBe(201);
    expect(r.body.plan.id).toBe("my-dda-shock");
    expect(r.body.plan.label).toBe("Lower dda (demonstration values)");
    expect(t.platform.context.store.has("plans", "my-dda-shock")).toBe(true);
  });
});

describe("derive refusals", () => {
  it("R6: two bad ops answer 422 on preview and save, listing both problems in order", async () => {
    const ops = [
      { target: { familyId: "dda", month: 6 }, op: "add", value: 1 },
      { target: { familyId: "cash" }, op: "scale", value: 0.9 },
    ];
    for (const path of ["/api/balance-plans/derive", "/api/balance-plans/derive/preview"]) {
      const r = await api<Err>(t.base, "POST", path, { baseId: BASE, bookId: BOOK, ops });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe("validation");
      expect(r.body.error.detail!.problems).toEqual([
        {
          at: "ops[0]",
          message: 'ops[0]: family "dda" has no knot at month 6; its knots are at months 12, and a balance shock cannot add a knot',
        },
        {
          at: "ops[1]",
          message: `ops[1]: no target for family "cash" in balance plan "${BASE}"; a balance shock changes a listed target and cannot add a family`,
        },
      ]);
    }
  });

  it("R6b: an op carrying newBusinessPricing is one pricing problem", async () => {
    const op = { ...SHOCK, newBusinessPricing: { spreadOverIndexBp: 0, termMonths: 12 } };
    const r = await api<Err>(t.base, "POST", "/api/balance-plans/derive", { baseId: BASE, bookId: BOOK, ops: [op] });
    expect(r.status).toBe(422);
    expect(r.body.error.detail!.problems).toEqual([
      {
        at: "ops[0]",
        message: "ops[0]: new-business pricing cannot be shocked; a balance shock changes the target balance path only",
      },
    ]);
  });

  it("R7: a book without dda and mma openings answers 422 with a problem per target", async () => {
    const r = await api<Err>(t.base, "POST", "/api/balance-plans/derive/preview", body({ bookId: "vanilla-book-v1" }));
    expect(r.status).toBe(422);
    const problems = r.body.error.detail!.problems!;
    expect(problems.map((p) => p.at)).toEqual(["targets[0]", "targets[1]"]);
    expect(problems[0]!.message).toContain('family "dda" has no opening balance in the book');
    expect(problems[1]!.message).toContain('family "mma" has no opening balance in the book');
  });

  it("R8: unknown base or book is 404; an extra key, a reserved or malformed id is 422", async () => {
    const noBase = await api<Err>(t.base, "POST", "/api/balance-plans/derive", body({ baseId: "nope-v1" }));
    expect(noBase.status).toBe(404);
    const noBook = await api<Err>(t.base, "POST", "/api/balance-plans/derive", body({ bookId: "nope-v1" }));
    expect(noBook.status).toBe(404);

    const extra = await api<Err>(t.base, "POST", "/api/balance-plans/derive", body({ extra: 1 }));
    expect(extra.status).toBe(422);
    expect(extra.body.error.message).toBe('unknown field "extra" in the request body; send { baseId, bookId, ops, id?, label? }');

    const reserved = await api<Err>(t.base, "POST", "/api/balance-plans/derive", body({ id: "derived-bp-abc" }));
    expect(reserved.status).toBe(422);
    expect(reserved.body.error.message).toBe("ids starting derived- are reserved for the derived id; leave id empty to get it");

    const bad = await api<Err>(t.base, "POST", "/api/balance-plans/derive", body({ id: "bad id!" }));
    expect(bad.status).toBe(422);
  });

  it("R8: wrong types answer 422 with the usage text", async () => {
    const usage = "POST /api/balance-plans/derive takes { baseId, bookId, ops, id?, label? }";
    const cases: unknown[] = [
      [],
      JSON.stringify("x"),
      { baseId: 7, bookId: BOOK, ops: [] },
      { baseId: BASE, bookId: 7, ops: [] },
      { baseId: BASE, bookId: BOOK, ops: "no" },
      body({ id: 5 }),
      body({ label: 5 }),
    ];
    for (const c of cases) {
      const r = await api<Err>(t.base, "POST", "/api/balance-plans/derive/preview", c);
      expect(r.status).toBe(422);
      expect(r.body.error.message).toBe(usage);
    }
  });
});

describe("POST /api/balance-plans refuses a forged derivedFrom", () => {
  const plain = (id: string): BalancePlan => ({
    schemaVersion: "1.0.0",
    id,
    label: "Plain plan (demonstration values)",
    asOf: "2026-03-31",
    targets: [{ familyId: "dda", path: [{ month: 12, balance: 90000000 }], newBusinessPricing: { spreadOverIndexBp: -100, termMonths: 12 } }],
    unlistedFamilies: "runoff",
  });

  it("R9: 422 with the decided text, and nothing is stored", async () => {
    const forged = { ...plain("forged-bp-v1"), derivedFrom: { baseId: BASE, baseContentHash: "0".repeat(64), ops: [] } };
    const r = await api<Err>(t.base, "POST", "/api/balance-plans", { balancePlan: forged });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe("derivedFrom is written by POST /api/balance-plans/derive; a plain save cannot carry it");
    expect(t.platform.context.store.has("plans", "forged-bp-v1")).toBe(false);
  });

  it("R9: a plain save still answers 201 with no derivedFromPlanId on its row, and an existing id still 409", async () => {
    const r = await api(t.base, "POST", "/api/balance-plans", { balancePlan: plain("plain-bp-v1") });
    expect(r.status).toBe(201);
    const row = (await rows()).find((x) => x.id === "plain-bp-v1")!;
    expect("derivedFromPlanId" in row).toBe(false);
    const again = await api<Err>(t.base, "POST", "/api/balance-plans", { balancePlan: plain("plain-bp-v1") });
    expect(again.status).toBe(409);
  });
});
