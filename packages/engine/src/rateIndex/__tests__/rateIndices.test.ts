/**
 * The rateIndices validator and table. Texts are restated here.
 */
import { describe, expect, it } from "vitest";
import { MAX_DERIVED_CURVES } from "../../contracts/derivedCurve";
import { isRateIndexId, MAX_RATE_INDICES, rateIndexTable, validateRateIndices } from "../rateIndices";

const good = (over: Record<string, unknown> = {}) => ({ id: "rfr-3m", label: "Three-month term rate", tenorMonths: 3, basis: 0, ...over });
const messages = (block: unknown, at?: string): string[] => validateRateIndices(block, at).map((p) => p.message);

describe("validateRateIndices", () => {
  it("accepts a valid block and the empty list", () => {
    expect(validateRateIndices([good(), good({ id: "prime-demo", tenorMonths: 1, basis: 0.03 })])).toEqual([]);
    expect(validateRateIndices([])).toEqual([]);
    expect(messages([good({ historyId: "ih-0123456789abcdef" })])).toEqual([]);
  });
  it("refuses a block that is not a list", () => {
    expect(validateRateIndices({})).toEqual([{ at: "rateIndices", message: "rateIndices: expected a list of rate indices" }]);
    expect(messages("x")).toEqual(["rateIndices: expected a list of rate indices"]);
  });
  it("refuses an unknown field", () => {
    expect(validateRateIndices([good({ curve: "x" })])).toEqual([
      { at: "rateIndices[0]", message: 'rateIndices[0]: unknown field "curve"; a rate index carries id, label, tenorMonths, basis and optionally spreadCurve and historyId' },
    ]);
  });
  it("refuses a bad id, naming it", () => {
    expect(messages([good({ id: "Prime" })])).toEqual([
      'rateIndices[0].id: expected a lowercase id of letters, digits and single hyphens, starting with a letter, at most 40 characters; got "Prime"',
    ]);
    for (const bad of ["1x", "a--b", "a-", "-a", "a_b", "", "a".repeat(41)]) expect(isRateIndexId(bad)).toBe(false);
    for (const ok of ["a", "rfr-1m", "prime-demo", "a".repeat(40)]) expect(isRateIndexId(ok)).toBe(true);
    expect(isRateIndexId(7)).toBe(false);
  });
  it("refuses an empty or long label", () => {
    const text = "rateIndices[0].label: expected a non-empty label of at most 120 characters";
    expect(messages([good({ label: "   " })])).toEqual([text]);
    expect(messages([good({ label: "x".repeat(121) })])).toEqual([text]);
    expect(messages([good({ label: 5 })])).toEqual([text]);
    expect(messages([good({ label: "x".repeat(120) })])).toEqual([]);
  });
  it("refuses a tenor outside 1, 3, 6, 12", () => {
    expect(messages([good({ tenorMonths: 2 })])).toEqual(["rateIndices[0].tenorMonths: expected 1, 3, 6 or 12 months; got 2"]);
    for (const t of [1, 3, 6, 12]) expect(messages([good({ tenorMonths: t })])).toEqual([]);
  });
  it("refuses a basis beyond 1000 bp or not finite", () => {
    const head = "rateIndices[0].basis: expected a finite decimal between -0.1 and 0.1 (1000 bp either way); got ";
    expect(messages([good({ basis: 0.11 })])).toEqual([head + "0.11"]);
    expect(messages([good({ basis: -0.11 })])).toEqual([head + "-0.11"]);
    expect(messages([good({ basis: Number.NaN })])).toEqual([head + "NaN"]);
    expect(messages([good({ basis: "0.01" })])).toEqual([head + '"0.01"']);
    expect(messages([good({ basis: 0.1 }), good({ id: "b", basis: -0.1 })])).toEqual([]);
  });
  it("refuses a duplicate id once", () => {
    expect(messages([good(), good(), good()])).toEqual(['rateIndices: index id "rfr-3m" appears more than once']);
  });
  it("refuses more than 50 indices", () => {
    expect(MAX_RATE_INDICES).toBe(50);
    const block = Array.from({ length: 51 }, (_, i) => good({ id: `idx-${i}` }));
    expect(messages(block)).toEqual(["rateIndices: at most 50 indices; got 51"]);
    expect(messages(block.slice(0, 50))).toEqual([]);
  });
  it("refuses indices that name more derived curves than a market carries", () => {
    expect(MAX_DERIVED_CURVES).toBe(12);
    const block = Array.from({ length: 13 }, (_, i) => good({ id: `idx-${i}`, spreadCurve: `curve-${i}` }));
    expect(messages(block)).toEqual(["rateIndices: the indices name 13 derived curves; a market carries at most 12"]);
    expect(messages(block.slice(0, 12))).toEqual([]);
    expect(messages(block.map((b) => ({ ...b, spreadCurve: "one-curve" })))).toEqual([]);
  });
  it("refuses an entry that is not an object", () => {
    expect(messages(["x"])).toEqual(["rateIndices[0]: expected a rate index with id, label, tenorMonths and basis"]);
  });
  it("names the block by the at argument", () => {
    expect(validateRateIndices([good({ tenorMonths: 2 })], "market.rateIndices")).toEqual([
      { at: "market.rateIndices[0].tenorMonths", message: "market.rateIndices[0].tenorMonths: expected 1, 3, 6 or 12 months; got 2" },
    ]);
  });
  it("collects every problem", () => {
    expect(messages([good({ tenorMonths: 2, basis: 1 })])).toHaveLength(2);
  });
  it("admits an optional spreadCurve naming a derived curve id, and refuses one that does not", () => {
    expect(messages([good({ spreadCurve: "ust-sofr" }), good({ id: "b", spreadCurve: "A.b_c-9" })])).toEqual([]);
    const head = "rateIndices[0].spreadCurve: expected a derived curve id of 1 to 70 characters from A-Z a-z 0-9 . _ -; got ";
    expect(messages([good({ spreadCurve: "bad id" })])).toEqual([head + '"bad id"']);
    expect(messages([good({ spreadCurve: "" })])).toEqual([head + '""']);
    expect(messages([good({ spreadCurve: "x".repeat(71) })])).toEqual([head + JSON.stringify("x".repeat(71))]);
    expect(messages([good({ spreadCurve: 7 })])).toEqual([head + "7"]);
  });
});

describe("index kinds and formula chains (Piece B, step B3a)", () => {
  const cms = (over: Record<string, unknown> = {}) => ({ id: "cms-10y", label: "Ten-year swap", kind: "constant-maturity-swap", tenorYears: 10, basis: 0, ...over });
  const beta = (over: Record<string, unknown> = {}) => ({ id: "admin-rate", label: "Administered", kind: "formula", parent: "rfr-3m", beta: 0.4, start: 0.0433, basis: 0, ...over });
  const level = (over: Record<string, unknown> = {}) => ({ id: "prime-like", label: "Prime-like", kind: "formula", parent: "rfr-3m", coefficient: 1, basis: 0.03, ...over });
  const chain = (n: number) => Array.from({ length: n }, (_, i) => level({ id: `f${i + 1}`, parent: i === 0 ? "rfr-3m" : `f${i}` }));

  it("accepts the three kinds, an explicit compounded-window kind and a five-level chain", () => {
    expect(messages([good({ kind: "compounded-window" }), cms(), beta({ lagMonths: 2, floor: 0, cap: 0.08 }), level()])).toEqual([]);
    expect(messages([good(), ...chain(5)])).toEqual([]);
  });
  it.each([
    [cms({ tenorYears: 4 }), "rateIndices[1].tenorYears: expected 1, 2, 3, 5, 7, 10, 20 or 30 years; got 4"],
    [cms({ kind: "average" }), 'rateIndices[1].kind: expected compounded-window, constant-maturity-swap or formula; got "average"'],
    [beta({ coefficient: 1 }), "rateIndices[1]: a formula index carries coefficient (level) or beta (change), not both"],
    [level({ coefficient: undefined }), "rateIndices[1]: a formula index needs coefficient (level) or beta (change)"],
    [level({ coefficient: 80 }), "rateIndices[1].coefficient: expected a finite multiplier of the parent's level from -3 to 3, not 0; got 80"],
    [level({ coefficient: 0 }), "rateIndices[1].coefficient: expected a finite multiplier of the parent's level from -3 to 3, not 0; got 0"],
    [beta({ beta: 80 }), "rateIndices[1].beta: expected a finite share of the parent's change from 0 to 2; got 80"],
    [beta({ start: undefined }), "rateIndices[1].start: missing start value; a beta index starts from its fixing at the cut-off"],
    [level({ start: 0.04 }), "rateIndices[1].start: a start value applies to a beta index only"],
    [beta({ start: 4.5 }), "rateIndices[1].start: expected a finite decimal rate from -0.05 to 0.25 (-500 bp to 2500 bp); got 4.5"],
    [beta({ lagMonths: 90 }), "rateIndices[1].lagMonths: expected a whole number of months from 1 to 12 (leave it out for no lag); got 90"],
    [beta({ lagMonths: 0 }), "rateIndices[1].lagMonths: expected a whole number of months from 1 to 12 (leave it out for no lag); got 0"],
    [level({ floor: 0.05, cap: 0.03 }), "rateIndices[1]: floor 0.05 is above cap 0.03"],
    [beta({ floor: 0.05 }), "rateIndices[1].start: start value 0.0433 is below the floor 0.05"],
    [beta({ cap: 0.04 }), "rateIndices[1].start: start value 0.0433 is above the cap 0.04"],
    [level({ spreadCurve: "ust-sofr" }), "rateIndices[1].spreadCurve: a formula index reads its parent's full rate and names no derived curve; name the curve on the parent"],
    [cms({ tenorMonths: 3 }), 'rateIndices[1]: unknown field "tenorMonths"; a constant-maturity-swap index carries id, label, kind, tenorYears, basis and optionally spreadCurve and historyId'],
    [level({ tenorMonths: 1 }), 'rateIndices[1]: unknown field "tenorMonths"; a formula index carries id, label, kind, parent, coefficient or beta, start (beta only), basis and optionally lagMonths, floor, cap and historyId'],
    [level({ parent: "prime-like" }), "rateIndices[1].parent: an index cannot be its own parent"],
    [level({ parent: "nope" }), 'rateIndices[1].parent: names rate index "nope", which this market does not carry'],
  ])("refuses %j with one sentence naming the row", (entry, sentence) => {
    expect(messages([good(), entry])).toEqual([sentence]);
  });
  it("names a loop once, from its smallest id", () => {
    expect(messages([good(), level({ id: "b", parent: "a" }), level({ id: "a", parent: "b" }), level({ id: "c", parent: "a" })])).toEqual([
      "rateIndices: rate indices form a loop: a -> b -> a; a formula's parent chain must end at a compounded-window or constant-maturity-swap index",
    ]);
  });
  it("refuses a chain six formula levels deep once, naming the chain", () => {
    expect(messages([good(), ...chain(7)])).toEqual([
      'rateIndices: rate index "f6" is 6 formula levels deep (f6 -> f5 -> f4 -> f3 -> f2 -> f1 -> rfr-3m); a chain is at most 5 levels',
    ]);
  });
});

describe("rateIndexTable", () => {
  it("keys the block by id; an absent block is empty", () => {
    const a = { id: "a", label: "A", tenorMonths: 1 as const, basis: 0 };
    const b = { id: "b", label: "B", tenorMonths: 3 as const, basis: 0.01 };
    const t = rateIndexTable([a, b]);
    expect(t.size).toBe(2);
    expect(t.get("b")).toEqual(b);
    expect(rateIndexTable(undefined).size).toBe(0);
  });
});
