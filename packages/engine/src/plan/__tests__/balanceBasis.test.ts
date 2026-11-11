// Studio A+E contract 18: RunPlan.balanceBasis, the Flat basis without a stored balance plan.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { baseAssumptions, loadMarket, twoSidedBook } from "../../run/__tests__/fixtures";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { compilePlan, planHash } from "../compile";
import { parseRunPlan, PlanShapeError } from "../parse";
import { fixturePlan, loadPolicy, withBalanceStage } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });
const open: Array<{ dispose(): void }> = [];
afterEach(() => { while (open.length > 0) open.pop()!.dispose(); });
const compiled = (...args: Parameters<typeof compilePlan>) => { const c = compilePlan(...args); open.push(c.harness); return c; };
const STAMPS = { runId: "RUN-1", seed: "42", timestamps: { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" } };
const resolved = () => ({ portfolio: twoSidedBook(), marketSnapshot: market, assumptionSets: [baseAssumptions()], policy: loadPolicy(), libraries: SHIPPED_LIBRARIES });
// The fixture book's four families: FIXED and MORTGAGE (assets), DDA and MMA (liabilities); all four carry a positive opening notional.
const FAMILIES = ["FIXED", "MORTGAGE", "DDA", "MMA"];

describe("parseRunPlan: balanceBasis", () => {
  it("passes the flat arm through with its two optional numbers", () => {
    const p = { ...fixturePlan(), balanceBasis: { kind: "flat", termMonths: 60, spreadOverIndexBp: 0 } };
    expect(parseRunPlan(JSON.parse(JSON.stringify(p))).balanceBasis).toEqual({ kind: "flat", termMonths: 60, spreadOverIndexBp: 0 });
  });
  it("leaves the field absent when the plan omits it, and the schema version is still 1.4.0", () => {
    const parsed = parseRunPlan(JSON.parse(JSON.stringify(fixturePlan())));
    expect("balanceBasis" in parsed).toBe(false);
    expect(parsed.schemaVersion).toBe("1.4.0");
  });
  it("refuses a kind other than flat, naming the field", () => {
    expect(() => parseRunPlan({ ...fixturePlan(), balanceBasis: { kind: "growth" } })).toThrow(PlanShapeError);
    expect(() => parseRunPlan({ ...fixturePlan(), balanceBasis: { kind: "growth" } })).toThrow(/balanceBasis\.kind/);
  });
  it("refuses a non-integer term and a non-finite spread, naming the field", () => {
    expect(() => parseRunPlan({ ...fixturePlan(), balanceBasis: { kind: "flat", termMonths: 0 } })).toThrow(/balanceBasis\.termMonths/);
    expect(() => parseRunPlan({ ...fixturePlan(), balanceBasis: { kind: "flat", termMonths: 1.5 } })).toThrow(/balanceBasis\.termMonths/);
    expect(() => parseRunPlan({ ...fixturePlan(), balanceBasis: { kind: "flat", spreadOverIndexBp: "10" } })).toThrow(/balanceBasis\.spreadOverIndexBp/);
  });
});

describe("compilePlan: balanceBasis flat", () => {
  it("lowers one flat rule per family with a positive opening balance, on every scenario", () => {
    const plan = { ...withBalanceStage(fixturePlan()), balanceBasis: { kind: "flat" as const, termMonths: 60, spreadOverIndexBp: 0 } };
    const c = compiled(plan, resolved(), STAMPS);
    expect(c.request.scenarios.length).toBe(5);
    for (const s of c.request.scenarios) {
      expect(s.newBusiness.mode).toBe("dynamic");
      expect(s.newBusiness.rules.map((r) => r.familyId).sort()).toEqual([...FAMILIES].sort());
      for (const r of s.newBusiness.rules) expect(r).toEqual({ familyId: r.familyId, reinvest: "flat", termMonths: 60, spreadOverIndexBp: 0 });
    }
  });
  it("a bare flat basis yields rules with neither optional key", () => {
    const plan = { ...withBalanceStage(fixturePlan()), balanceBasis: { kind: "flat" as const } };
    const c = compiled(plan, resolved(), STAMPS);
    expect(c.request.scenarios[0]!.newBusiness.rules.length).toBe(4);
    for (const r of c.request.scenarios[0]!.newBusiness.rules) expect(r).toEqual({ familyId: r.familyId, reinvest: "flat" });
  });
  it("stamps request.plan.balanceBasis and leaves balancePlanHash absent", () => {
    const plan = { ...withBalanceStage(fixturePlan()), balanceBasis: { kind: "flat" as const } };
    const c = compiled(plan, resolved(), STAMPS);
    expect(c.request.plan!.balanceBasis).toEqual({ kind: "flat" });
    expect("balancePlanHash" in c.request.plan!).toBe(false);
  });
  it("refuses balanceBasis beside balancePlan", () => {
    const plan = { ...withBalanceStage(fixturePlan()), balanceBasis: { kind: "flat" as const }, balancePlan: "bp-x" };
    expect(() => compiled(plan, { ...resolved(), balancePlan: { schemaVersion: "1.0.0", id: "bp-x", label: "x", asOf: fixturePlan().asOf, targets: [], unlistedFamilies: "runoff" } }, STAMPS)).toThrow(/balanceBasis and balancePlan/);
  });
  it("a plan without the field hashes exactly as before and its request carries no balanceBasis key", () => {
    const plan = fixturePlan();
    // planHash of fixturePlan() on the unmodified code, printed once with `contentHash(fixturePlan())` on unmodified source and pinned here;
    // re-pinned once in OSS slice S1 for the neutral routing policy id (the old id read back gives 677785b7...).
    expect(planHash(plan)).toBe("6daa3ffeddd1685d34d308ab20d591f4e9b22f6f381eb9fdf9ed1f8358f2a063");
    const c = compiled(plan, resolved(), STAMPS);
    expect("balanceBasis" in c.request.plan!).toBe(false);
  });
  it("skips a zero-balance family and tags it", () => {
    // MMA keeps its position (so the st-beta selector still binds, R3) at a zero notional.
    const book = twoSidedBook();
    const zeroMma = book.positions.map((p) => (p.familyId === "MMA" ? { ...p, terms: { ...p.terms, notional: 0 } } : p)) as typeof book.positions;
    const r = { ...resolved(), portfolio: { ...book, positions: zeroMma } };
    const plan = { ...withBalanceStage(fixturePlan()), balanceBasis: { kind: "flat" as const } };
    const c = compiled(plan, r, STAMPS);
    expect(c.request.scenarios[0]!.newBusiness.rules.map((x) => x.familyId).sort()).toEqual(["DDA", "FIXED", "MORTGAGE"]);
    const tag = c.notImplemented.find((t) => t.layer === "plan.balance-basis.skipped");
    expect(tag?.reason).toMatch(/MMA/);
  });
  it("refuses a book with no eligible family", () => {
    // Every position kept (the selectors still bind, R3), every notional zero.
    const book = twoSidedBook();
    const zeroAll = book.positions.map((p) => ({ ...p, terms: { ...p.terms, notional: 0 } })) as typeof book.positions;
    const plan = { ...withBalanceStage(fixturePlan()), balanceBasis: { kind: "flat" as const } };
    expect(() => compiled(plan, { ...resolved(), portfolio: { ...book, positions: zeroAll } }, STAMPS)).toThrow(/no family eligible/);
  });
});
