/**
 * The seeded deposit targets plan (balance-targets-demo-v1)
 * and the balance shock derived from it (balance-shock-demo-v1). The derived plan is
 * the base run through deriveBalancePlan with one scale op on dda at month 12, so it
 * must be exactly what the derive route writes for the same body, must lower on
 * the synthetic book and be refused on the vanilla book, and must stay current
 * across re-seeds. Everything runs from a scratch store seeded by the real
 * seedStore(). Expected values are restated here, never read back from the seed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BalancePlanUnsupported, lowerBalancePlan } from "@alm/engine";
import type { BalancePlan, PortfolioSpec } from "@alm/engine";
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { buildDemoBalancePlan, seedStore } from "../../scripts/seed-store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

const BASE_ID = "balance-targets-demo-v1";
const SHOCK_ID = "balance-shock-demo-v1";
const BOOK_ID = "synthetic-2500-v1";
const SHOCK_LABEL = "dda target 10% lower at month 12 on the deposit targets (demonstration values, NOT calibrated)";
const OPS = [{ target: { familyId: "dda", month: 12 }, op: "scale", value: 0.9 }];

let t: TestPlatform;
let store: FileStore;
beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
});
afterAll(() => t.close());

const plan = (id: string) => store.getDocument<BalancePlan>("plans", id).doc;
const openingsOf = (book: PortfolioSpec): Map<string, number> => {
  const m = new Map<string, number>();
  for (const p of book.positions) m.set(p.familyId, (m.get(p.familyId) ?? 0) + p.terms.notional);
  return m;
};
const book = (id: string) => store.getDocument<PortfolioSpec>("portfolios", id).doc;

describe("seeded deposit targets plan", () => {
  it("B1: the base is exactly the designed literal, carries no derivedFrom, and its meta is the plain POST meta plus seeded", () => {
    const doc = plan(BASE_ID);
    expect(doc).toEqual({
      schemaVersion: "1.0.0",
      id: BASE_ID,
      label: "Deposit targets held flat at month 12 on the synthetic book (demonstration values)",
      asOf: "2026-03-31",
      targets: [
        { familyId: "dda", path: [{ month: 12, balance: 97178194 }], newBusinessPricing: { spreadOverIndexBp: -100, termMonths: 12 } },
        { familyId: "mma", path: [{ month: 12, balance: 156318023 }], newBusinessPricing: { spreadOverIndexBp: -100, termMonths: 12 } },
      ],
      unlistedFamilies: "runoff",
    });
    expect(Object.keys(doc)).not.toContain("derivedFrom");
    const meta = store.getMeta("plans", BASE_ID);
    expect(meta.label).toBe("Deposit targets held flat at month 12 on the synthetic book (demonstration values)");
    expect(meta.asOf).toBe("2026-03-31");
    expect(meta.targetCount).toBe(2);
    expect(meta.seeded).toBe(true);
    expect(doc).toEqual(buildDemoBalancePlan());
  });
});

describe("seeded balance shock plan", () => {
  it("B2: dda is 10 percent lower at month 12, mma is verbatim, the derivation record and meta are as designed", () => {
    const base = plan(BASE_ID);
    const doc = plan(SHOCK_ID);
    expect(doc.label).toBe(SHOCK_LABEL);
    expect(doc.targets[0]!.familyId).toBe("dda");
    expect(doc.targets[0]!.path).toEqual([{ month: 12, balance: 87460374.6 }]);
    expect(doc.targets[0]!.newBusinessPricing).toEqual({ spreadOverIndexBp: -100, termMonths: 12 });
    expect(doc.targets[1]).toEqual(base.targets[1]);
    expect(doc.derivedFrom).toEqual({
      baseId: BASE_ID,
      baseContentHash: contentHash(base),
      ops: OPS,
    });
    const meta = store.getMeta("plans", SHOCK_ID);
    expect(meta.derivedFromPlanId).toBe(BASE_ID);
    expect(meta.derivedOpCount).toBe(1);
    expect(meta.checkedBookId).toBe(BOOK_ID);
    expect(meta.seeded).toBe(true);
  });

  it("B3: the derive route answers 200 unchanged for the same base, book, ops, id and label", async () => {
    const r = await api<{ outcome: string }>(t.base, "POST", "/api/balance-plans/derive", {
      baseId: BASE_ID,
      bookId: BOOK_ID,
      ops: OPS,
      id: SHOCK_ID,
      label: SHOCK_LABEL,
    });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("unchanged");
  });

  it("B4: both plans lower on the stored synthetic book at 360 months; the shock is refused on the vanilla book", () => {
    const synth = book(BOOK_ID);
    const openings = openingsOf(synth);
    const baseRules = lowerBalancePlan(plan(BASE_ID), openings, 360, synth.asOf);
    expect(baseRules.map((r) => [r.familyId, r.reinvest])).toEqual([["dda", "flat"], ["mma", "flat"]]);
    const rules = lowerBalancePlan(plan(SHOCK_ID), openings, 360, synth.asOf);
    expect(rules[0]!.familyId).toBe("dda");
    expect(rules[0]!.reinvest).toBe("growth");
    expect((rules[0] as { monthlyGrowthRate: number }).monthlyGrowthRate).toBeCloseTo(-0.008741610954696721, 15);
    expect(rules[1]!.familyId).toBe("mma");
    expect(rules[1]!.reinvest).toBe("flat");

    const vanilla = book("vanilla-book-v1");
    let thrown: unknown = null;
    try {
      lowerBalancePlan(plan(SHOCK_ID), openingsOf(vanilla), 360, vanilla.asOf);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BalancePlanUnsupported);
    expect((thrown as Error).message).toContain('"dda"');
  });
});

describe("re-seeding and listing", () => {
  it("B5: a second seed and the check report both docs current, not stale, nothing missing", async () => {
    const report = await seedStore(store, repoRoot());
    expect(report.stale).toEqual([]);
    expect(report.written).toEqual([]);
    expect(report.skipped).toContain(`plans/${BASE_ID}`);
    expect(report.skipped).toContain(`plans/${SHOCK_ID}`);
    const check = await seedStore(store, repoRoot(), { mode: "check" });
    expect(check.stale).toEqual([]);
    expect(check.missing).toEqual([]);
  }, 60_000);

  it("B6: the listing serves derivedFromPlanId only on the derived row", async () => {
    const r = await api<Array<Record<string, unknown>>>(t.base, "GET", "/api/balance-plans");
    expect(r.status).toBe(200);
    const base = r.body.find((x) => x.id === BASE_ID)!;
    const shock = r.body.find((x) => x.id === SHOCK_ID)!;
    expect(Object.keys(base)).not.toContain("derivedFromPlanId");
    expect(shock.derivedFromPlanId).toBe(BASE_ID);
    expect(shock.asOf).toBe("2026-03-31");
  });
});
