// apps/studio/src/__tests__/curveSetupModel.test.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as model from "../market/curveSetupModel";
import {
  blockFromState,
  COMPOUNDING_OPTIONS,
  compoundingOptionsFor,
  CONVENTION_NOTE,
  DAY_COUNT_OPTIONS,
  defaultSetup,
  FUTURES_NOTE,
  INSTRUMENT_OPTIONS,
  INTERPOLATION_OPTIONS,
  isNativePair,
  labelFor,
  NATIVE_PAIRS,
  unmappedPairNote,
  parsePaste,
  QUOTE_TYPE_OPTIONS,
  rowsFromQuotes,
  tenorTextOf,
  unknownValueLabel,
  type CurveSetupState,
  type GridRow,
} from "../market/curveSetupModel";

const EM_DASH = String.fromCharCode(0x2014);
const SECTION_SIGN = String.fromCharCode(0xa7);

describe("parsePaste", () => {
  it("reads Excel rows with tabs, percents, CRLF and a header", () => {
    const text = "Tenor\tRate\r\n1M\t4.30%\r\n3M\t4.35%\r\n\r\n2Y\t3.9%\r\n10Y\t4,1%";
    const r = parsePaste(text);
    expect(r.rows).toEqual([
      { tenorMonths: 1, value: 0.043 },
      { tenorMonths: 3, value: 0.0435 },
      { tenorMonths: 24, value: 0.039 },
    ]);
    expect(r.skipped.map((s) => s.line)).toEqual([1, 6]);
  });
  it("names the ambiguous decimal comma in the exact sentence", () => {
    const r = parsePaste("10Y\t4,1%");
    expect(r.rows).toEqual([]);
    expect(r.skipped).toEqual([{ line: 1, why: "line 1: 4,1% is ambiguous (decimal comma or thousands)" }]);
  });
  it("treats a bare number as months and a decimal year as months", () => {
    expect(parsePaste("18\t0.04\n0.5y\t0.041").rows.map((x) => x.tenorMonths)).toEqual([18, 6]);
  });
  it("reads 3M, 6m, 1Y, 10y, 0.25y and 18", () => {
    const r = parsePaste("3M\t0.01\n6m\t0.02\n1Y\t0.03\n10y\t0.04\n0.25y\t0.05\n18\t0.06");
    expect(r.rows.map((x) => x.tenorMonths)).toEqual([3, 6, 12, 120, 3, 18]);
    expect(r.skipped).toEqual([]);
  });
  it("skips a non-whole-month tenor and a non-number value with a reason", () => {
    const r = parsePaste("0.3y\t0.04\n6M\tabc");
    expect(r.rows).toEqual([]);
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped).toEqual([
      { line: 1, why: "line 1: 0.3y is not a whole number of months" },
      { line: 2, why: "line 2: abc is not a number" },
    ]);
  });
  it("numbers lines 1-based in the pasted text, the header counted", () => {
    const r = parsePaste("Tenor\tRate\n1M\t0.04\n2M\tx\n3M\t0.05");
    expect(r.rows).toEqual([
      { tenorMonths: 1, value: 0.04 },
      { tenorMonths: 3, value: 0.05 },
    ]);
    expect(r.skipped).toEqual([
      { line: 1, why: "line 1: header row skipped" },
      { line: 3, why: "line 3: x is not a number" },
    ]);
  });
  it("splits on a lone CR and on LF, skipping blank lines silently", () => {
    const r = parsePaste("1M\t0.04\r2M\t0.041\n\n\r3M\t0.042\n");
    expect(r.rows.map((x) => x.tenorMonths)).toEqual([1, 2, 3]);
    expect(r.skipped).toEqual([]);
  });
  it("splits on a comma when the line holds no tab", () => {
    const r = parsePaste("1M,4.3%\n2Y, 0.039");
    expect(r.rows).toEqual([
      { tenorMonths: 1, value: 0.043 },
      { tenorMonths: 24, value: 0.039 },
    ]);
  });
  it("refuses a comma-separated line with more than two cells", () => {
    const r = parsePaste("10Y,4,1%");
    expect(r.rows).toEqual([]);
    expect(r.skipped).toEqual([
      { line: 1, why: "line 1: has more than two comma-separated cells; put a tab between tenor and value" },
    ]);
  });
  it("divides a percent cell by 100 and strips whitespace inside it", () => {
    const r = parsePaste("1M\t 4.3 % \n2M\t-0.25%");
    expect(r.rows).toEqual([
      { tenorMonths: 1, value: 0.043 },
      { tenorMonths: 2, value: -0.0025 },
    ]);
  });
  it("strips thousands commas when a dot or several groups make them unambiguous", () => {
    const r = parsePaste("1M\t1,200.5\n2M\t1,200,000\n3M\t1,200");
    expect(r.rows).toEqual([
      { tenorMonths: 1, value: 1200.5 },
      { tenorMonths: 2, value: 1200000 },
    ]);
    expect(r.skipped).toEqual([{ line: 3, why: "line 3: 1,200 is ambiguous (decimal comma or thousands)" }]);
  });
  it("refuses a malformed comma group as not a number", () => {
    expect(parsePaste("1M\t12,34.5").skipped).toEqual([{ line: 1, why: "line 1: 12,34.5 is not a number" }]);
  });
  it("decimal unit (the default) keeps a plain value above 1 as typed", () => {
    const r = parsePaste("1M\t4.3\n2M\t0.043");
    expect(r.rows.map((x) => x.value)).toEqual([4.3, 0.043]);
    expect(r.unitUsed).toBe("decimal");
    const d = parsePaste("1M\t4.3\n2M\t0.043", { unit: "decimal" });
    expect(d.rows.map((x) => x.value)).toEqual([4.3, 0.043]);
    expect(d.unitUsed).toBe("decimal");
  });
  it("decimal unit still divides an explicit % cell", () => {
    const r = parsePaste("1M\t4.3%\n2M\t0.043", { unit: "decimal" });
    expect(r.rows.map((x) => x.value)).toEqual([0.043, 0.043]);
    expect(r.unitUsed).toBe("decimal");
  });
  it("percent unit divides every plain value, small ones too, and a % cell once", () => {
    const r = parsePaste("1M\t0.85\n2M\t4.3\n3M\t4.3%", { unit: "percent" });
    expect(r.rows.map((x) => x.value)).toEqual([0.0085, 0.043, 0.043]);
    expect(r.unitUsed).toBe("percent");
  });
  it("auto unit decides once for the whole paste: one plain value above 1 makes every plain value a percent", () => {
    const r = parsePaste("1M\t0.85\n3M\t1.00\n6M\t1.25", { unit: "auto" });
    expect(r.rows.map((x) => x.value)).toEqual([0.0085, 0.01, 0.0125]);
    expect(r.unitUsed).toBe("percent");
  });
  it("auto unit keeps an all-decimal paste decimal", () => {
    const r = parsePaste("1M\t0.043\n3M\t0.045", { unit: "auto" });
    expect(r.rows.map((x) => x.value)).toEqual([0.043, 0.045]);
    expect(r.unitUsed).toBe("decimal");
  });
  it("auto unit with mixed % and plain cells: the % cell never counts toward the decision and is divided once", () => {
    const a = parsePaste("1M\t4.3%\n3M\t0.045", { unit: "auto" });
    expect(a.rows.map((x) => x.value)).toEqual([0.043, 0.045]);
    expect(a.unitUsed).toBe("decimal");
    const b = parsePaste("1M\t4.3%\n3M\t4.5\n6M\t-1.5", { unit: "auto" });
    expect(b.rows.map((x) => x.value)).toEqual([0.043, 0.045, -0.015]);
    expect(b.unitUsed).toBe("percent");
    // Magnitude counts: a lone -1.5 alone decides percent.
    expect(parsePaste("1M\t-1.5\n3M\t0.5", { unit: "auto" }).rows.map((x) => x.value)).toEqual([-0.015, 0.005]);
  });
  it("skips a line with one cell, a zero tenor and an unknown unit", () => {
    const r = parsePaste("1M\n0M\t0.04\n1D\t0.04");
    expect(r.rows).toEqual([]);
    expect(r.skipped).toEqual([
      { line: 1, why: "line 1: no value in column 2" },
      { line: 2, why: "line 2: 0M is shorter than one month" },
      { line: 3, why: "line 3: 1D is not a tenor (use 3M, 1Y or a number of months)" },
    ]);
  });
  it("reads the first two cells of a tab line and ignores the rest", () => {
    expect(parsePaste("1M\t0.04\tsource note").rows).toEqual([{ tenorMonths: 1, value: 0.04 }]);
  });
  it("keeps cells positional: a blank Bid never shifts the Ask into the value", () => {
    const r = parsePaste("Tenor\tBid\tAsk\n1M\t\t4.40%\n3M\t4.30%\t4.35%");
    expect(r.rows).toEqual([{ tenorMonths: 3, value: 0.043 }]);
    expect(r.skipped).toEqual([
      { line: 1, why: "line 1: header row skipped" },
      { line: 2, why: "line 2: no value in column 2 (columns after 2 are not read)" },
    ]);
    expect(parsePaste("1M\t\t0.05").skipped).toEqual([{ line: 1, why: "line 1: no value in column 2 (columns after 2 are not read)" }]);
  });
  it("skips a blank first cell as no tenor", () => {
    const r = parsePaste("\t0.04\n1M\t0.04\n\t0.05\t0.06");
    expect(r.rows).toEqual([{ tenorMonths: 1, value: 0.04 }]);
    expect(r.skipped).toEqual([
      { line: 1, why: "line 1: no tenor in column 1" },
      { line: 3, why: "line 3: no tenor in column 1" },
    ]);
  });
  it("ignores trailing tabs and trailing empty cells", () => {
    const r = parsePaste("1M\t0.04\t\t\n3M\t0.045\t \t\n6M,0.05,,");
    expect(r.rows).toEqual([
      { tenorMonths: 1, value: 0.04 },
      { tenorMonths: 3, value: 0.045 },
      { tenorMonths: 6, value: 0.05 },
    ]);
    expect(r.skipped).toEqual([]);
  });
  it("gives the header reason on line 1 only; ON, TN and SN later are not tenors", () => {
    const r = parsePaste("1M\t0.04\nON\t0.039\nTN\t0.039\nSN\t0.039");
    expect(r.rows).toEqual([{ tenorMonths: 1, value: 0.04 }]);
    expect(r.skipped).toEqual([
      { line: 2, why: "line 2: ON is not a tenor (use 3M, 1Y or a number of months)" },
      { line: 3, why: "line 3: TN is not a tenor (use 3M, 1Y or a number of months)" },
      { line: 4, why: "line 4: SN is not a tenor (use 3M, 1Y or a number of months)" },
    ]);
  });
  it("refuses whitespace between digits and allows it only around the sign, the % sign and a thousands comma", () => {
    const r = parsePaste("1M\t4 3\n1 2\t0.04\n3M\t- 0.25 %\n6M\t1 ,200.5\n9M\t1, 200, 000\n1 Y\t0.04");
    expect(r.rows).toEqual([
      { tenorMonths: 3, value: -0.0025 },
      { tenorMonths: 6, value: 1200.5 },
      { tenorMonths: 9, value: 1200000 },
      { tenorMonths: 12, value: 0.04 },
    ]);
    expect(r.skipped).toEqual([
      { line: 1, why: "line 1: 4 3 is not a number" },
      { line: 2, why: "line 2: 1 2 is not a tenor (use 3M, 1Y or a number of months)" },
    ]);
  });
  it("reads a 200,000-digit cell in linear time", () => {
    const digits = "1".repeat(200000);
    const t0 = performance.now();
    const r = parsePaste(`1M\t${digits}e\n${digits}e\t0.04\n1M\t${digits}.${digits}x`);
    const g = blockFromState(state([row({ valueText: `${digits}e`, tenorText: `${digits}e`, convexityText: `${digits}e` })]));
    const elapsed = performance.now() - t0;
    expect(r.rows).toEqual([]);
    expect(r.skipped.map((s) => s.line)).toEqual([1, 2, 3]);
    expect(g.problems.map((p) => p.field)).toEqual(["tenor", "value", "convexity"]);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("defaultSetup", () => {
  it("is the new-form default with no rows", () => {
    expect(defaultSetup()).toEqual({
      id: "",
      label: "",
      baseCurve: "SOFR",
      interpolation: "log-linear-df",
      dayCount: "ACT/360",
      compounding: "annual",
      inputs: [],
    });
  });
  it("returns a fresh object each call", () => {
    expect(defaultSetup()).not.toBe(defaultSetup());
  });
});

describe("menu option lists", () => {
  it("cover exactly the engine unions", () => {
    expect(INTERPOLATION_OPTIONS.map((o) => o.value).sort()).toEqual(["cubic-zero", "linear-zero", "log-linear-df", "monotone-convex"]);
    expect(DAY_COUNT_OPTIONS.map((o) => o.value).sort()).toEqual(["ACT/360", "ACT/365"]);
    expect(COMPOUNDING_OPTIONS.map((o) => o.value).sort()).toEqual(["annual", "continuous", "semi-annual"]);
    expect(QUOTE_TYPE_OPTIONS.map((o) => o.value).sort()).toEqual(["discount-factor", "par-rate", "zero-rate"]);
    expect(INSTRUMENT_OPTIONS.map((o) => o.value).sort()).toEqual(["cash", "futures", "ois-swap"]);
    expect([INTERPOLATION_OPTIONS, DAY_COUNT_OPTIONS, COMPOUNDING_OPTIONS, QUOTE_TYPE_OPTIONS, INSTRUMENT_OPTIONS].map((l) => l.length)).toEqual([4, 2, 3, 3, 3]);
  });
  it("label each value in plain words, the new default first", () => {
    expect(INTERPOLATION_OPTIONS).toEqual([
      { value: "log-linear-df", label: "Log-linear on discount factor" },
      { value: "linear-zero", label: "Linear in zero rate (legacy)" },
      { value: "cubic-zero", label: "Cubic spline on zero rate" },
      { value: "monotone-convex", label: "Monotone convex" },
    ]);
    expect(DAY_COUNT_OPTIONS).toEqual([
      { value: "ACT/360", label: "Actual/360" },
      { value: "ACT/365", label: "Actual/365" },
    ]);
    expect(COMPOUNDING_OPTIONS).toEqual([
      { value: "annual", label: "Annual" },
      { value: "semi-annual", label: "Semi-annual" },
      { value: "continuous", label: "Continuous" },
    ]);
    expect(QUOTE_TYPE_OPTIONS).toEqual([
      { value: "par-rate", label: "Par rate" },
      { value: "zero-rate", label: "Zero rate" },
      { value: "discount-factor", label: "Discount factor" },
    ]);
    expect(INSTRUMENT_OPTIONS).toEqual([
      { value: "cash", label: "Cash" },
      { value: "ois-swap", label: "OIS swap" },
      { value: "futures", label: "Futures" },
    ]);
  });
});

describe("compoundingOptionsFor", () => {
  it("offers no continuous on a par-rate row", () => {
    expect(compoundingOptionsFor("par-rate").map((o) => o.value)).toEqual(["annual", "semi-annual"]);
    expect(compoundingOptionsFor("par-rate", "ois-swap").map((o) => o.label)).toEqual(["Annual", "Semi-annual"]);
  });
  it("offers all three on a zero-rate row", () => {
    expect(compoundingOptionsFor("zero-rate", "cash").map((o) => o.value)).toEqual(["annual", "semi-annual", "continuous"]);
  });
  it("offers none on a discount-factor row", () => {
    expect(compoundingOptionsFor("discount-factor")).toEqual([]);
  });
  it("offers none on a futures row whatever the quote type", () => {
    expect(compoundingOptionsFor("par-rate", "futures")).toEqual([]);
    expect(compoundingOptionsFor("zero-rate", "futures")).toEqual([]);
  });
});

const row = (patch: Partial<GridRow>): GridRow => ({
  instrument: "ois-swap",
  tenorText: "1Y",
  quoteType: "par-rate",
  valueText: "0.04",
  convexityText: "",
  ...patch,
});
const state = (rows: GridRow[]): CurveSetupState => ({
  id: "sofr-house",
  label: "House SOFR",
  baseCurve: "SOFR",
  interpolation: "log-linear-df",
  dayCount: "ACT/360",
  compounding: "annual",
  rows,
});

describe("blockFromState", () => {
  it("converts every text cell to numbers and keeps grid order", () => {
    const r = blockFromState(
      state([
        row({ instrument: "cash", tenorText: "3M", valueText: "4.3%" }),
        row({ instrument: "futures", tenorText: "6m", valueText: "95.8", convexityText: "-0.5" }),
        row({ tenorText: "0.25y", quoteType: "zero-rate", valueText: "0.041" }),
        row({ tenorText: "18", quoteType: "discount-factor", valueText: "0.95" }),
        row({ instrument: "futures", tenorText: "9M", valueText: "95.9" }),
      ]),
    );
    expect(r.problems).toEqual([]);
    expect(r.block).toEqual({
      id: "sofr-house",
      label: "House SOFR",
      baseCurve: "SOFR",
      interpolation: "log-linear-df",
      dayCount: "ACT/360",
      compounding: "annual",
      inputs: [
        { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.043 },
        { instrument: "futures", tenorMonths: 6, quoteType: "par-rate", value: 95.8, convexityBp: -0.5 },
        { instrument: "ois-swap", tenorMonths: 3, quoteType: "zero-rate", value: 0.041 },
        { instrument: "ois-swap", tenorMonths: 18, quoteType: "discount-factor", value: 0.95 },
        { instrument: "futures", tenorMonths: 9, quoteType: "par-rate", value: 95.9 },
      ],
    });
    // A blank convexity cell leaves the field out, never undefined.
    expect(Object.keys(r.block!.inputs[4]!)).not.toContain("convexityBp");
  });
  it("names a bad tenor by row and field, and returns no block", () => {
    const r = blockFromState(state([row({}), row({ tenorText: "0.3y" }), row({ tenorText: "" })]));
    expect(r.block).toBeNull();
    expect(r.problems).toEqual([
      { row: 2, field: "tenor", why: "0.3y is not a whole number of months" },
      { row: 3, field: "tenor", why: "enter a tenor" },
    ]);
  });
  it("names a bad value, an ambiguous value and a percent futures price", () => {
    const r = blockFromState(
      state([
        row({ valueText: "abc" }),
        row({ valueText: "4,1" }),
        row({ valueText: " " }),
        row({ instrument: "futures", valueText: "95.8%" }),
      ]),
    );
    expect(r.block).toBeNull();
    expect(r.problems).toEqual([
      { row: 1, field: "value", why: "abc is not a number" },
      { row: 2, field: "value", why: "4,1 is ambiguous (decimal comma or thousands)" },
      { row: 3, field: "value", why: "enter a value" },
      { row: 4, field: "value", why: "a futures row takes the price, for example 95.8, not a percent" },
    ]);
  });
  it("refuses whitespace between digits in a grid cell", () => {
    const r = blockFromState(state([row({ valueText: "4 3", tenorText: "1 2" })]));
    expect(r.block).toBeNull();
    expect(r.problems).toEqual([
      { row: 1, field: "tenor", why: "1 2 is not a tenor (use 3M, 1Y or a number of months)" },
      { row: 1, field: "value", why: "4 3 is not a number" },
    ]);
  });
  it("names a bad convexity text", () => {
    const r = blockFromState(
      state([
        row({ instrument: "futures", valueText: "95.8", convexityText: "two" }),
        row({ instrument: "futures", valueText: "95.8", convexityText: "1%" }),
      ]),
    );
    expect(r.block).toBeNull();
    expect(r.problems).toEqual([
      { row: 1, field: "convexity", why: "two is not a number" },
      { row: 2, field: "convexity", why: "convexity is in basis points, not a percent" },
    ]);
  });
  it("passes a numeric convexity on a non-futures row through for the server to refuse", () => {
    const r = blockFromState(state([row({ convexityText: "1" })]));
    expect(r.problems).toEqual([]);
    expect(r.block!.inputs[0]).toEqual({ instrument: "ois-swap", tenorMonths: 12, quoteType: "par-rate", value: 0.04, convexityBp: 1 });
  });
});

describe("rowsFromQuotes", () => {
  it("maps quotes to par-rate grid rows and drops a tenor that rounds to zero months", () => {
    const r = rowsFromQuotes([
      { term: "1D", tYears: 1 / 365, instrumentType: "CASH", rate: 0.03 },
      { term: "3M", tYears: 0.25, instrumentType: "CASH", rate: 0.032 },
      { term: "1Y", tYears: 1, instrumentType: "SWAP", rate: 0.034 },
      { term: "18M", tYears: 1.5, instrumentType: "SWAP", rate: 0.0351 },
    ]);
    expect(r.dropped).toEqual(["1D"]);
    expect(r.rows).toEqual([
      { instrument: "cash", tenorText: "3M", quoteType: "par-rate", valueText: "0.032", convexityText: "" },
      { instrument: "ois-swap", tenorText: "1Y", quoteType: "par-rate", valueText: "0.034", convexityText: "" },
      { instrument: "ois-swap", tenorText: "18M", quoteType: "par-rate", valueText: "0.0351", convexityText: "" },
    ]);
  });
  it("drops and names a quote whose years are not finite, never a NaNM row", () => {
    const r = rowsFromQuotes([
      { term: "BAD", tYears: Number.NaN, instrumentType: "SWAP", rate: 0.04 },
      { tYears: Number.POSITIVE_INFINITY, instrumentType: "SWAP", rate: 0.04 },
      { term: "1Y", tYears: 1, instrumentType: "SWAP", rate: 0.04 },
    ]);
    expect(r.dropped).toEqual(["BAD", "Infinity years"]);
    expect(r.rows.map((x) => x.tenorText)).toEqual(["1Y"]);
  });
  it("labels a dropped quote by its years when it carries no term", () => {
    expect(rowsFromQuotes([{ tYears: 0.01, instrumentType: "CASH", rate: 0.03 }]).dropped).toEqual(["0.01 years"]);
  });
  it("round-trips through blockFromState to the quoted rate exactly", () => {
    const { rows } = rowsFromQuotes([{ term: "2Y", tYears: 2, instrumentType: "SWAP", rate: 0.0361234567891 }]);
    expect(blockFromState(state(rows)).block!.inputs).toEqual([{ instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.0361234567891 }]);
  });
  it("round-trips a rate String() writes in exponent form", () => {
    const { rows } = rowsFromQuotes([{ term: "1M", tYears: 1 / 12, instrumentType: "CASH", rate: 1e-7 }]);
    expect(rows[0]!.valueText).toBe("1e-7");
    expect(blockFromState(state(rows)).block!.inputs[0]!.value).toBe(1e-7);
    expect(parsePaste("1M\t1.5e-1%").rows).toEqual([{ tenorMonths: 1, value: 0.0015 }]);
  });
});

describe("tenorTextOf", () => {
  it("writes whole years as Y and the rest as M", () => {
    expect([1, 3, 12, 18, 120].map(tenorTextOf)).toEqual(["1M", "3M", "1Y", "18M", "10Y"]);
  });
});

describe("notes and labels", () => {
  it("states the futures and convention notes exactly", () => {
    expect(FUTURES_NOTE).toBe("A futures row starts at the tenor you type and covers 3 months. Type the price, for example 95.8.");
    expect(CONVENTION_NOTE).toBe(
      "Day count changes annual par rows above one year (other than cash), semi-annual par rows of one year and more, and every futures row. It also changes an annual cash row, which accrues on 365/360 under ACT/360, unless the interpolation is linear in zero rate. Other rows ignore it.",
    );
  });
  it("renders an unknown server value verbatim and never throws", () => {
    expect(unknownValueLabel("hermite-zero")).toBe("hermite-zero");
    expect(labelFor(INTERPOLATION_OPTIONS, "hermite-zero")).toBe("hermite-zero");
    expect(labelFor(INTERPOLATION_OPTIONS, "linear-zero")).toBe("Linear in zero rate (legacy)");
    expect(labelFor(DAY_COUNT_OPTIONS, "30/360")).toBe("30/360");
    expect(labelFor(COMPOUNDING_OPTIONS, "")).toBe("");
  });
});

describe("no em-dash or section sign", () => {
  const strings: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(collect);
  };
  it("in any exported string, label, note or reason", () => {
    collect(Object.values(model).filter((v) => typeof v !== "function"));
    collect(defaultSetup());
    collect(compoundingOptionsFor("zero-rate"));
    collect(parsePaste("Tenor\tRate\n0.3y\t1\n1M\tx\n1M\t4,1\n1M\n0M\t1\n1D\t1\n1M,1,2"));
    collect(blockFromState(state([row({ tenorText: "" }), row({ valueText: "" }), row({ instrument: "futures", valueText: "1%", convexityText: "1%" })])));
    expect(strings.length).toBeGreaterThan(30);
    expect(strings.filter((s) => s.includes(EM_DASH) || s.includes(SECTION_SIGN))).toEqual([]);
  });
  it("in the model source", () => {
    const src = readFileSync(fileURLToPath(new URL("../market/curveSetupModel.ts", import.meta.url)), "utf8");
    expect(src.includes(EM_DASH)).toBe(false);
    expect(src.includes(SECTION_SIGN)).toBe(false);
  });
});

describe("native convention pairs (Task 11c)", () => {
  it("names the two pairs the platform maps to a kernel convention", () => {
    expect(NATIVE_PAIRS).toEqual([
      { dayCount: "ACT/360", compounding: "annual" },
      { dayCount: "ACT/365", compounding: "semi-annual" },
    ]);
  });
  it("isNativePair is true for those two pairs only", () => {
    expect(isNativePair("ACT/360", "annual")).toBe(true);
    expect(isNativePair("ACT/365", "semi-annual")).toBe(true);
    expect(isNativePair("ACT/360", "semi-annual")).toBe(false);
    expect(isNativePair("ACT/365", "annual")).toBe(false);
    expect(isNativePair("ACT/360", "continuous")).toBe(false);
    expect(isNativePair("ACT/365", "continuous")).toBe(false);
    expect(isNativePair("30/360", "annual")).toBe(false);
  });
  it("the note says which models read the 10-year forward on which basis (decision 24)", () => {
    expect(unmappedPairNote("ACT/360", "annual")).toBeUndefined();
    expect(unmappedPairNote("ACT/365", "semi-annual")).toBeUndefined();
    expect(unmappedPairNote("ACT/360", "semi-annual")).toBe(
      "ACT/360 with semi-annual compounding has no platform convention of its own: the curve is built under your settings, and the 10-year forward that mortgages, client rates and new business read is quoted on the semi-annual bond basis.",
    );
    expect(unmappedPairNote("ACT/365", "annual")).toBe(
      "ACT/365 with annual compounding has no platform convention of its own: the curve is built under your settings, and the 10-year forward that mortgages, client rates and new business read is quoted on the annual ACT/360 basis.",
    );
    expect(unmappedPairNote("ACT/360", "continuous")).toContain("quoted on the annual ACT/360 basis.");
    for (const [dc, comp] of [["ACT/360", "semi-annual"], ["ACT/365", "annual"], ["ACT/360", "continuous"], ["ACT/365", "continuous"]] as const) {
      const note = unmappedPairNote(dc, comp) ?? "";
      expect(note.includes(EM_DASH) || note.includes(SECTION_SIGN)).toBe(false);
    }
  });
});
