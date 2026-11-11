/**
 * deriveMarketSnapshot set-index ops for the Piece B, step B3a kinds: a constant-maturity swap and a formula on a
 * parent. Fixtures and expected values are restated here; the fixture, load, problemsOf, one and d are copied from
 * deriveRateIndices.test.ts.
 */
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import type { MarketWithIndices } from "../../contracts/rateIndex";
import { deriveMarketSnapshot, MarketDerivationError } from "../deriveMarketSnapshot";

const FIXTURE = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const BASE_ID = "market-public-2026-03-31";

let loaded: MarketSnapshot;
beforeAll(async () => {
  loaded = await loadMarketSnapshot(FIXTURE);
});
const load = (): MarketSnapshot => structuredClone(loaded);

function problemsOf(fn: () => unknown): Array<{ at: string; message: string }> {
  try {
    fn();
  } catch (e) {
    if (e instanceof MarketDerivationError) return e.problems;
    throw e;
  }
  throw new Error("expected a MarketDerivationError");
}
const one = (fn: () => unknown): { at: string; message: string } => {
  const p = problemsOf(fn);
  expect(p).toHaveLength(1);
  return p[0]!;
};
const d = (ops: unknown[], base: MarketSnapshot = load(), baseId = BASE_ID) => () => deriveMarketSnapshot(base, ops, { baseId });

const CW = { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 };
const CMS = { op: "set-index", id: "cms-10y", label: "Ten-year swap rate (demonstration index)", kind: "constant-maturity-swap", tenorYears: 10, basisBp: 0 };
const BETA = { op: "set-index", id: "admin-rate", label: "Administered rate (demonstration values)", kind: "formula", parent: "rfr-1m", beta: 0.4, startBp: 433, lagMonths: 2, floorBp: 0, capBp: 800, basisBp: 0 };
const ADMIN = { id: "admin-rate", label: "Administered rate (demonstration values)", kind: "formula", parent: "rfr-1m", beta: 0.4, start: 0.0433, lagMonths: 2, floor: 0, cap: 0.08, basis: 0 };
const block = (r: ReturnType<typeof deriveMarketSnapshot>) => (r.snapshot as MarketWithIndices).rateIndices!;

describe("set-index for the B3a kinds", () => {
  it("stores a formula in its key order and records the op normalized", () => {
    const r = deriveMarketSnapshot(load(), [CW, CMS, BETA], { baseId: BASE_ID });
    const admin = block(r).find((x) => x.id === "admin-rate")!;
    expect(admin).toEqual(ADMIN);
    expect(Object.keys(admin)).toEqual(["id", "label", "kind", "parent", "beta", "start", "lagMonths", "floor", "cap", "basis"]);
    expect(Object.keys(block(r).find((x) => x.id === "cms-10y")!)).toEqual(["id", "label", "kind", "tenorYears", "basis"]);
    expect(r.snapshot.derivedFrom!.ops[2]).toEqual(BETA);
    expect(Object.keys(r.snapshot.derivedFrom!.ops[2]!)).toEqual(Object.keys(BETA));
  });
  it("drops a lag of 0 and an explicit compounded-window kind, so the id equals the op without them", () => {
    const plain = deriveMarketSnapshot(load(), [CW], { baseId: BASE_ID });
    const explicit = deriveMarketSnapshot(load(), [{ ...CW, kind: "compounded-window" }], { baseId: BASE_ID });
    expect(explicit.id).toBe(plain.id);
    expect("kind" in block(explicit)[0]!).toBe(false);
    const noLag = deriveMarketSnapshot(load(), [CW, { ...BETA, lagMonths: 0 }], { baseId: BASE_ID });
    expect("lagMonths" in block(noLag).find((x) => x.id === "admin-rate")!).toBe(false);
    expect("lagMonths" in noLag.snapshot.derivedFrom!.ops[1]!).toBe(false);
  });
  it("Review Focus 3: Shift a basis keeps every formula field, in one derive and on a derived base", () => {
    const one = deriveMarketSnapshot(load(), [CW, BETA, { op: "add-index-basis", indexId: "admin-rate", value: 25 }], { baseId: BASE_ID });
    expect(block(one).find((x) => x.id === "admin-rate")).toEqual({ ...ADMIN, basis: 0.0025 });
    const first = deriveMarketSnapshot(load(), [CW, BETA], { baseId: BASE_ID });
    const again = deriveMarketSnapshot(first.snapshot as MarketSnapshot, [{ op: "add-index-basis", indexId: "admin-rate", value: -10 }], { baseId: first.id });
    const shifted = block(again).find((x) => x.id === "admin-rate")!;
    expect(shifted).toEqual({ ...ADMIN, basis: -0.001 });
    expect(Object.keys(shifted)).toEqual(Object.keys(ADMIN));
  });
  it("Review Focus 3: a later set-index that makes the parent a formula on its child is a loop, named", () => {
    const loop = { op: "set-index", id: "rfr-1m", label: "Loop", kind: "formula", parent: "admin-rate", coefficient: 1, basisBp: 0 };
    expect(problemsOf(() => deriveMarketSnapshot(load(), [CW, BETA, loop], { baseId: BASE_ID }))).toEqual([
      { at: "rateIndices", message: "rateIndices: rate indices form a loop: admin-rate -> rfr-1m -> admin-rate; a formula's parent chain must end at a compounded-window or constant-maturity-swap index" },
    ]);
  });
  it("a later set-index that turns the parent into a swap index keeps the child valid", () => {
    const swap = { op: "set-index", id: "rfr-1m", label: "Now a swap index", kind: "constant-maturity-swap", tenorYears: 2, basisBp: 0 };
    expect(block(deriveMarketSnapshot(load(), [CW, BETA, swap], { baseId: BASE_ID })).find((x) => x.id === "admin-rate")).toEqual(ADMIN);
  });
  it.each([
    [{ ...CW, kind: "average" }, 'ops[0]: kind must be compounded-window, constant-maturity-swap or formula; got "average"'],
    [{ ...CMS, tenorYears: "10" }, "ops[0]: tenorYears must be a number"],
    [{ ...BETA, parent: 3 }, "ops[0]: parent must be a string"],
    [{ ...BETA, beta: "0.4" }, "ops[0]: beta must be a finite number"],
    [{ ...BETA, startBp: Number.NaN }, "ops[0]: startBp must be a finite number of basis points"],
    [{ ...BETA, lagMonths: "2" }, "ops[0]: lagMonths must be a number"],
    [{ ...BETA, spreadCurve: "ust-sofr" }, "ops[0]: a formula index reads its parent's full rate and names no derived curve; name the curve on the parent"],
    [{ ...BETA, tenorMonths: 1 }, 'ops[0]: unknown field "tenorMonths"; a formula set-index op carries op, id, label, kind, parent, coefficient or beta, startBp, lagMonths, floorBp, capBp, basisBp and an optional historyId'],
    [{ ...CMS, tenorMonths: 1 }, 'ops[0]: unknown field "tenorMonths"; a constant-maturity-swap set-index op carries op, id, label, kind, tenorYears, basisBp and optionally spreadCurve and historyId'],
  ])("refuses the op %j in Stage 1 with one sentence", (op, sentence) => {
    expect(one(d([op])).message).toBe(sentence);
  });
});
