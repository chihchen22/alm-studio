import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { contentHash } from "../../runtime/contentHash";
import { baseAssumptions, loadMarket, twoSidedBook } from "../../run/__tests__/fixtures";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { compilePlan } from "../compile";
import { BalancePlanUnsupported, lowerBalancePlan, nodeTargetCoverage } from "../lowerBalancePlan";
import { fixturePlan, loadPolicy, withBalanceStage } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });
const STAMPS = { runId: "RUN-NODE", seed: "42", timestamps: { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" } };
const resolvedInputs = () => ({ portfolio: twoSidedBook(), marketSnapshot: market, assumptionSets: [baseAssumptions()], policy: loadPolicy(), libraries: SHIPPED_LIBRARIES });
const book = twoSidedBook();
const AS_OF = book.asOf;
const opening = () => { const m = new Map<string, number>(); for (const p of book.positions) m.set(p.familyId, (m.get(p.familyId) ?? 0) + p.terms.notional); return m; };
// The fixture COA: FIXED and MORTGAGE hang under one asset parent. Read it off the book rather than assume the id.
const assetParent = book.coa.nodes.find((n) => n.id === book.coa.nodes.find((l) => l.familyId === "FIXED")!.parentId)!;
const pricing = { spreadOverIndexBp: 50, termMonths: 36 };
const planOf = (extra: object) => ({ schemaVersion: "1.0.0" as const, id: "bp-node", label: "node", asOf: AS_OF, targets: [], unlistedFamilies: "runoff" as const, ...extra });

describe("lowerBalancePlan: nodeTargets", () => {
  it("allocates a flat node target to the node's families pro rata on opening balance, each flat", () => {
    const open = opening();
    const total = open.get("FIXED")! + open.get("MORTGAGE")!;
    const plan = planOf({ nodeTargets: [{ coaNodeId: assetParent.id, path: [{ month: 12, balance: total }], newBusinessPricing: pricing }] });
    const rules = lowerBalancePlan(plan, open, 360, AS_OF, book.coa);
    expect(rules.map((r) => r.familyId).sort()).toEqual(["FIXED", "MORTGAGE"]);
    for (const r of rules) expect(r).toEqual({ familyId: r.familyId, reinvest: "flat", spreadOverIndexBp: 50, termMonths: 36 });
  });
  it("a growth node target gives every family the same monthly growth rate, so each family's share of the node is constant", () => {
    const open = opening();
    const total = open.get("FIXED")! + open.get("MORTGAGE")!;
    const plan = planOf({ nodeTargets: [{ coaNodeId: assetParent.id, path: [{ month: 24, balance: total * 1.1 }], newBusinessPricing: pricing }] });
    const rules = lowerBalancePlan(plan, open, 360, AS_OF, book.coa);
    const g = Math.pow(1.1, 1 / 24) - 1;
    expect(rules.map((r) => r.familyId).sort()).toEqual(["FIXED", "MORTGAGE"]);
    for (const r of rules) { expect(r.reinvest).toBe("growth"); expect(r.monthlyGrowthRate!).toBeCloseTo(g, 12); }
  });
  it("refuses a node and a family target over one family", () => {
    const open = opening();
    const plan = planOf({ targets: [{ familyId: "FIXED", path: [{ month: 1, balance: open.get("FIXED")! }], newBusinessPricing: pricing }], nodeTargets: [{ coaNodeId: assetParent.id, path: [{ month: 12, balance: 1 }], newBusinessPricing: pricing }] });
    expect(() => lowerBalancePlan(plan, open, 360, AS_OF, book.coa)).toThrow(BalancePlanUnsupported);
    expect(() => lowerBalancePlan(plan, open, 360, AS_OF, book.coa)).toThrow(/FIXED.*more than one target/);
  });
  it("refuses a node with no eligible family and an unknown node", () => {
    const open = opening();
    const emptyNode = book.coa.nodes.find((n) => n.isLeaf && n.familyId === "DDA")!;
    open.set("DDA", 0);
    expect(() => lowerBalancePlan(planOf({ nodeTargets: [{ coaNodeId: emptyNode.id, path: [{ month: 1, balance: 5 }], newBusinessPricing: pricing }] }), open, 360, AS_OF, book.coa)).toThrow(/no family with a positive opening balance/);
    expect(() => lowerBalancePlan(planOf({ nodeTargets: [{ coaNodeId: "no-such-node", path: [{ month: 1, balance: 5 }], newBusinessPricing: pricing }] }), open, 360, AS_OF, book.coa)).toThrow(/names no chart-of-accounts node/);
  });
  it("allocates only to the asset and liability families under the node; a swap family under it gets no rule and no share", () => {
    // A hand-built chart: one asset root carrying a fixed-loan leaf (opening 6,000,000), a mortgage
    // leaf (opening 2,000,000) and a swap leaf (side derivative, notional 4,000,000 summed into its opening).
    const coa = {
      schemaVersion: "1.0.0" as const,
      nodes: [
        { id: "root-a", label: "Assets", parentId: null, side: "asset" as const, isLeaf: false, order: 0 },
        { id: "leaf-fixed", label: "Fixed", parentId: "root-a", side: "asset" as const, isLeaf: true, familyId: "FX", order: 0 },
        { id: "leaf-mtg", label: "Mortgages", parentId: "root-a", side: "asset" as const, isLeaf: true, familyId: "MT", order: 1 },
        { id: "leaf-swap", label: "Swaps", parentId: "root-a", side: "derivative" as const, isLeaf: true, familyId: "SW", order: 2 },
      ],
      families: [
        { id: "FX", label: "Fixed", side: "asset" as const, instrumentType: "fixed-loan" as const, coaNodeId: "leaf-fixed" },
        { id: "MT", label: "Mortgages", side: "asset" as const, instrumentType: "mortgage" as const, coaNodeId: "leaf-mtg" },
        { id: "SW", label: "Swaps", side: "derivative" as const, instrumentType: "swap" as const, coaNodeId: "leaf-swap" },
      ],
    };
    const open = new Map([["FX", 6_000_000], ["MT", 2_000_000], ["SW", 4_000_000]]);
    // Node path 8,000,000 at month 12. Over FX and MT only (total 8,000,000) the shares are 3/4 and 1/4,
    // so FX gets 6,000,000 and MT 2,000,000: each equals its opening, so both lower flat.
    // Had the swap taken a share (total 12,000,000), FX would get 4,000,000 against 6,000,000 open and
    // lower to growth at (4/6)^(1/12) - 1, and SW would carry a rule the projection refuses.
    const plan = planOf({ nodeTargets: [{ coaNodeId: "root-a", path: [{ month: 12, balance: 8_000_000 }], newBusinessPricing: pricing }] });
    expect(lowerBalancePlan(plan, open, 360, AS_OF, coa)).toEqual([
      { familyId: "FX", reinvest: "flat", spreadOverIndexBp: 50, termMonths: 36 },
      { familyId: "MT", reinvest: "flat", spreadOverIndexBp: 50, termMonths: 36 },
    ]);
    expect(nodeTargetCoverage("root-a", coa, open)).toEqual({ eligible: ["FX", "MT"], skipped: ["SW"] });
    // A node whose only family is the swap covers nothing it can allocate to.
    expect(() => lowerBalancePlan(planOf({ nodeTargets: [{ coaNodeId: "leaf-swap", path: [{ month: 12, balance: 1 }], newBusinessPricing: pricing }] }), open, 360, AS_OF, coa)).toThrow(
      'balance plan: node target "leaf-swap" covers no family with a positive opening balance on the asset or liability side',
    );
  });
  it("compile tags the families a node target skipped", () => {
    // MMA keeps its position (the st-beta selector still binds) at a zero notional, so the
    // liabilities node allocates to DDA alone and the tag names MMA.
    const b = twoSidedBook();
    const positions = b.positions.map((p) => (p.familyId === "MMA" ? { ...p, terms: { ...p.terms, notional: 0 } } : p)) as typeof b.positions;
    const liabilities = b.coa.nodes.find((n) => n.id === b.coa.nodes.find((l) => l.familyId === "DDA")!.parentId)!;
    const bp = planOf({ id: "bp-node-tag", nodeTargets: [{ coaNodeId: liabilities.id, path: [{ month: 12, balance: 3_000_000 }], newBusinessPricing: pricing }] });
    const plan = { ...withBalanceStage(fixturePlan()), balancePlan: "bp-node-tag" };
    const c = compilePlan(plan, { ...resolvedInputs(), portfolio: { ...b, positions }, balancePlan: bp }, STAMPS);
    c.harness.dispose();
    expect(c.request.scenarios[0]!.newBusiness.rules).toEqual([{ familyId: "DDA", reinvest: "flat", spreadOverIndexBp: 50, termMonths: 36 }]);
    const tags = c.notImplemented.filter((t) => t.layer === "plan.balance-plan.node-skipped");
    expect(tags.map((t) => t.reason)).toEqual([
      `balance plan "bp-node-tag" node target "${liabilities.id}" skipped 1 family with no positive opening balance or a side other than asset or liability: MMA`,
    ]);
  });
  it("refuses nodeTargets without a chart of accounts", () => {
    expect(() => lowerBalancePlan(planOf({ nodeTargets: [{ coaNodeId: assetParent.id, path: [{ month: 1, balance: 5 }], newBusinessPricing: pricing }] }), opening(), 360, AS_OF)).toThrow(/chart of accounts/);
  });
  it("a plan without nodeTargets hashes exactly as before", () => {
    const plan = planOf({});
    // contentHash of this plan (asOf 2026-01-01) printed once with `npx tsx` on the hashing source of
    // the unmodified code (packages/engine/src/runtime unchanged since) and pinned as a literal.
    expect(AS_OF).toBe("2026-01-01");
    expect(contentHash(plan)).toBe("d8fef48e644685eb30b2812b1c9e8d75768359fdb574f721105c8176378d8b1e");
    expect(lowerBalancePlan(plan, opening(), 360, AS_OF, book.coa)).toEqual([]);
  });
});
