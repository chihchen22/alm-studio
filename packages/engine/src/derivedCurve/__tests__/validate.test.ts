import { describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { validateDerivedCurve, validateDerivedCurves } from "../validate";
import { estimatedOnDefaultOf, runCurveIdOf } from "../runCurve";
import { MAX_DERIVED_CURVES } from "../../contracts/derivedCurve";
const ok = { id: "ust-sofr", label: "UST over SOFR", base: "platform-default", spreads: [{ tenorMonths: 3, spreadBp: 12 }] };

describe("validateDerivedCurve", () => {
  it("accepts a minimal curve and keeps it unchanged", () => {
    expect(validateDerivedCurve(ok)).toEqual({ ok: true, block: ok });
  });
  it.each([
    [{ ...ok, id: "bad id" }, `the derived curve's "id" must be 1 to 70 characters from A-Z a-z 0-9 . _ -`],
    [{ ...ok, label: "" }, `the derived curve's "label" must be 1 to 80 characters`],
    [{ ...ok, base: "" }, `the derived curve's "base" must name a curve setup id or platform-default`],
    [{ ...ok, spreads: [] }, "a derived curve needs 1 to 60 spread rows"],
    [{ ...ok, spreads: [{ tenorMonths: 1.5, spreadBp: 1 }] }, "row 1 tenor must be a whole number of months from 1 to 360; got 1.5"],
    [{ ...ok, spreads: [{ tenorMonths: 6, spreadBp: 1 }, { tenorMonths: 3, spreadBp: 1 }] }, "row 2 tenor 3 months must be above row 1 (6 months)"],
    [{ ...ok, spreads: [{ tenorMonths: 3, spreadBp: 1001 }] }, "row 1 spread must be a finite number of basis points from -1000 to 1000; got 1001"],
    [{ ...ok, extra: 1 }, `unknown field "extra"; a derived curve carries id, label, base, spreads, an optional source and an optional estimatedOnDefault`],
  ])("refuses %j with a sentence", (raw, sentence) => {
    const r = validateDerivedCurve(raw);
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.refusals).toContain(sentence);
  });
  it("refuses a 61-row grid once, without judging every row", () => {
    const spreads = Array.from({ length: 61 }, (_, i) => ({ tenorMonths: i + 1, spreadBp: 1 }));
    const r = validateDerivedCurve({ ...ok, spreads });
    expect(r.ok ? [] : r.refusals).toEqual(["a derived curve needs 1 to 60 spread rows"]);
  });
  it("judges the label before the spreads: an empty label and no rows give both refusals (R2)", () => {
    const r = validateDerivedCurve({ ...ok, label: "", spreads: [] });
    expect(r.ok ? [] : r.refusals).toEqual([
      `the derived curve's "label" must be 1 to 80 characters`,
      "a derived curve needs 1 to 60 spread rows",
    ]);
  });
  it("trims the label before the length check and stores the trimmed value (M3)", () => {
    expect(validateDerivedCurve({ ...ok, label: "x " })).toEqual({ ok: true, block: { ...ok, label: "x" } });
    const blank = validateDerivedCurve({ ...ok, label: "   " });
    expect(blank.ok ? [] : blank.refusals).toEqual([`the derived curve's "label" must be 1 to 80 characters`]);
    // Eighty characters with padding fit once trimmed; eighty-one do not.
    const eighty = "a".repeat(80);
    expect(validateDerivedCurve({ ...ok, label: `  ${eighty}  ` })).toEqual({ ok: true, block: { ...ok, label: eighty } });
    const long = validateDerivedCurve({ ...ok, label: ` ${eighty}b ` });
    expect(long.ok ? [] : long.refusals).toEqual([`the derived curve's "label" must be 1 to 80 characters`]);
  });
  it("keeps a source when present and leaves it out when absent", () => {
    const withSource = { ...ok, source: { from: "ust-setup", minus: "platform-default" } };
    expect(validateDerivedCurve(withSource)).toEqual({ ok: true, block: withSource });
    const r = validateDerivedCurve(ok);
    expect(r.ok && "source" in r.block).toBe(false);
  });
  it("refuses a source with an empty side", () => {
    const r = validateDerivedCurve({ ...ok, source: { from: "", minus: "platform-default" } });
    expect(r.ok ? [] : r.refusals).toEqual([`the derived curve's source "from" must name a curve setup id or platform-default`]);
  });
  it("refuses a base that is not an id (R6), and accepts platform-default or a setup id", () => {
    const sentence = `the derived curve's "base" must name a curve setup id or platform-default`;
    for (const base of [" ust setup ", "a/b"]) {
      const r = validateDerivedCurve({ ...ok, base });
      expect(r.ok ? [] : r.refusals).toEqual([sentence]);
    }
    for (const base of ["platform-default", "sofr-main"]) expect(validateDerivedCurve({ ...ok, base })).toEqual({ ok: true, block: { ...ok, base } });
  });
  it("refuses a source side that is not an id (R6)", () => {
    const r = validateDerivedCurve({ ...ok, source: { from: "ust setup", minus: "platform-default" } });
    expect(r.ok ? [] : r.refusals).toEqual([`the derived curve's source "from" must name a curve setup id or platform-default`]);
  });
  it("refuses a hole in a sparse spread list as a row", () => {
    const spreads = [{ tenorMonths: 3, spreadBp: 1 }, , { tenorMonths: 12, spreadBp: 1 }];
    const r = validateDerivedCurve({ ...ok, spreads });
    expect(r.ok ? [] : r.refusals).toEqual(["row 2 is not a row; expected tenorMonths and spreadBp"]);
  });
  // The platform default curve version a curve's spreads were estimated on.
  it("keeps an estimatedOnDefault of 1 or 2 and leaves it out when absent", () => {
    const source = { from: "ust-setup", minus: "platform-default" };
    for (const v of [1, 2]) {
      const stamped = { ...ok, source, estimatedOnDefault: v };
      expect(validateDerivedCurve(stamped)).toEqual({ ok: true, block: stamped });
    }
    const r = validateDerivedCurve({ ...ok, source });
    expect(r.ok && "estimatedOnDefault" in r.block).toBe(false);
    // Written as undefined, it is left out, as an undefined source is.
    const u = validateDerivedCurve({ ...ok, source, estimatedOnDefault: undefined });
    expect(u.ok && "estimatedOnDefault" in u.block).toBe(false);
  });
  it("refuses an estimatedOnDefault other than the number 1 or 2", () => {
    const sentence = (got: string) =>
      `the derived curve's "estimatedOnDefault" must be 1 or 2, the platform default curve version its spreads were estimated on; got ${got}`;
    for (const [v, got] of [[3, "3"], ["2", `"2"`], [0, "0"], [1.5, "1.5"], [null, "null"]] as const) {
      const r = validateDerivedCurve({ ...ok, estimatedOnDefault: v });
      expect(r.ok ? [] : r.refusals).toEqual([sentence(got)]);
    }
  });
  it("refuses a stamp on a typed grid or on a source of two setups: only a curve estimated on platform-default carries one", () => {
    const sentence = `the derived curve's "estimatedOnDefault" belongs only to a curve whose source names platform-default; a typed grid or a source of two curve setups carries none`;
    for (const raw of [{ ...ok, estimatedOnDefault: 2 }, { ...ok, source: { from: "a", minus: "b" }, estimatedOnDefault: 1 }]) {
      const r = validateDerivedCurve(raw);
      expect(r.ok ? [] : r.refusals).toEqual([sentence]);
    }
  });
  it("names the new optional field when the curve is not an object", () => {
    const r = validateDerivedCurve([]);
    expect(r.ok ? [] : r.refusals).toEqual(["a derived curve must be an object with id, label, base, spreads, an optional source and an optional estimatedOnDefault"]);
  });
  it("a stored curve without estimatedOnDefault still reads, unchanged (the field is optional)", () => {
    const stored = { ...ok, source: { from: "platform-default", minus: "ust-setup" } };
    expect(validateDerivedCurve(stored)).toEqual({ ok: true, block: stored });
    expect(validateDerivedCurves([stored, { ...stored, id: "two", estimatedOnDefault: 2 }])).toEqual([]);
  });
  it("refuses a non-finite spread", () => {
    const r = validateDerivedCurve({ ...ok, spreads: [{ tenorMonths: 3, spreadBp: Number.NaN }] });
    expect(r.ok ? [] : r.refusals).toEqual(["row 1 spread must be a finite number of basis points from -1000 to 1000; got NaN"]);
  });
});
describe("validateDerivedCurves", () => {
  it("refuses a repeated id", () => {
    expect(validateDerivedCurves([ok, ok])).toContain(`derived curve id "ust-sofr" appears more than once`);
  });
  it("accepts a list of valid curves with unique ids", () => {
    expect(validateDerivedCurves([ok, { ...ok, id: "ust-sofr-2" }])).toEqual([]);
  });
  it("refuses more than MAX_DERIVED_CURVES (12) curves", () => {
    expect(MAX_DERIVED_CURVES).toBe(12);
    const many = Array.from({ length: 13 }, (_, i) => ({ ...ok, id: `c${i}` }));
    expect(validateDerivedCurves(many)).toEqual(["a market carries at most 12 derived curves; got 13"]);
    expect(validateDerivedCurves(many.slice(0, 12))).toEqual([]);
  });
  it("names the curve in a per-curve refusal", () => {
    expect(validateDerivedCurves([{ ...ok, spreads: [] }])).toEqual([`derived curve "ust-sofr": a derived curve needs 1 to 60 spread rows`]);
  });
});
describe("estimatedOnDefaultOf (B4 Task 7)", () => {
  it("reads the stamp, 1 for an unstamped platform-default source, and null for a typed grid or two setups", () => {
    expect(estimatedOnDefaultOf({ ...ok, source: { from: "platform-default", minus: "s" }, estimatedOnDefault: 2 })).toBe(2);
    expect(estimatedOnDefaultOf({ ...ok, source: { from: "s", minus: "platform-default" }, estimatedOnDefault: 1 })).toBe(1);
    expect(estimatedOnDefaultOf({ ...ok, source: { from: "s", minus: "platform-default" } })).toBe(1);
    expect(estimatedOnDefaultOf(ok)).toBeNull();
    expect(estimatedOnDefaultOf({ ...ok, estimatedOnDefault: 2 })).toBeNull();
    expect(estimatedOnDefaultOf({ ...ok, source: { from: "a", minus: "b" }, estimatedOnDefault: 2 })).toBeNull();
  });
});
describe("runCurveIdOf", () => {
  it("reads platform-default without a curve setup and the setup id with one", () => {
    const market = {} as MarketSnapshot;
    expect(runCurveIdOf(market)).toBe("platform-default");
    expect(runCurveIdOf({ curveSetup: { id: "ust-setup" } } as unknown as MarketSnapshot)).toBe("ust-setup");
  });
});
