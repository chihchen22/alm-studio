import { describe, expect, it } from "vitest";
import { checkRows, familyRows, toBalancePlan, usd, withKind, type TargetRow } from "../balance/targetsModel";

const GROUPS = [
  { key: "fixed-loans", totalNotional: 650_000_000 },
  { key: "cash", totalNotional: 150_000_000 },
  { key: "fhlb", totalNotional: null },
  { key: null, totalNotional: 5 },
];

describe("familyRows", () => {
  it("lists the book's families by id ascending, all Run off, with the served opening balance", () => {
    const rows = familyRows(GROUPS, null);
    expect(rows.map((r) => [r.familyId, r.opening, r.inBook, r.kind])).toEqual([
      ["cash", 150_000_000, true, "runoff"],
      ["fhlb", null, true, "runoff"],
      ["fixed-loans", 650_000_000, true, "runoff"],
    ]);
  });
  it("reads a stored plan: one knot at month 1 on the opening is Hold flat, one other knot is Reach, more knots are Stored", () => {
    const plan = {
      schemaVersion: "1.0.0" as const, id: "bp-1", label: "x", asOf: "2026-03-31", unlistedFamilies: "runoff" as const,
      targets: [
        { familyId: "cash", path: [{ month: 1, balance: 150_000_000 }], newBusinessPricing: { spreadOverIndexBp: 100, termMonths: 12 } },
        { familyId: "fixed-loans", path: [{ month: 24, balance: 700_000_000 }], newBusinessPricing: { spreadOverIndexBp: 150, termMonths: 60 } },
        { familyId: "fhlb", path: [{ month: 12, balance: 1 }, { month: 24, balance: 2 }], newBusinessPricing: { spreadOverIndexBp: 20, termMonths: 6 } },
        { familyId: "mortgage", path: [{ month: 12, balance: 9 }], newBusinessPricing: { spreadOverIndexBp: 5, termMonths: 360 } },
      ],
    };
    const byId = new Map(familyRows(GROUPS, plan).map((r) => [r.familyId, r]));
    expect(byId.get("cash")).toMatchObject({ kind: "flat", spreadBp: "100", termMonths: "12" });
    expect(byId.get("fixed-loans")).toMatchObject({ kind: "reach", balance: "700000000", month: "24", spreadBp: "150", termMonths: "60" });
    expect(byId.get("fhlb")).toMatchObject({ kind: "stored", storedPath: [{ month: 12, balance: 1 }, { month: 24, balance: 2 }] });
    expect(byId.get("mortgage")).toMatchObject({ inBook: false, opening: null, kind: "reach" });
  });
});

const row = (over: Partial<TargetRow>): TargetRow => ({ familyId: "cash", opening: 150_000_000, inBook: true, kind: "runoff", balance: "", month: "", spreadBp: "", termMonths: "", storedPath: null, ...over });

describe("checkRows", () => {
  it("wants at least one family that is not Run off", () => {
    expect(checkRows([row({})])).toEqual(["Every family runs off: set at least one target before saving."]);
  });
  it("names each shape problem with its family", () => {
    const msgs = checkRows([
      row({ familyId: "a", kind: "reach", balance: "0", month: "1.5", spreadBp: "x", termMonths: "0" }),
      row({ familyId: "b", kind: "flat", opening: null, spreadBp: "10", termMonths: "12" }),
      row({ familyId: "c", kind: "flat", inBook: false, opening: null, spreadBp: "10", termMonths: "12" }),
    ]);
    expect(msgs).toEqual([
      "a: the balance must be a number above zero.",
      "a: the month must be a whole number of 1 or more.",
      "a: the spread must be a number of basis points.",
      "a: the term must be a whole number of months, 1 or more.",
      "b: Hold flat needs the served opening balance, and none is served.",
      "c: the family is not in this book; set it to Run off.",
    ]);
  });
  it("refuses a Stored kind with no loaded path, and still checks its pricing", () => {
    expect(checkRows([row({ familyId: "d", kind: "stored", storedPath: null, spreadBp: "10", termMonths: "12" })])).toEqual([
      "d: no stored path is loaded for this family; pick another target.",
    ]);
    expect(checkRows([row({ familyId: "d", kind: "stored", storedPath: null, spreadBp: "", termMonths: "12" })])).toEqual([
      "d: no stored path is loaded for this family; pick another target.",
      "d: the spread must be a number of basis points.",
    ]);
  });
  it("passes a clean form", () => {
    expect(checkRows([row({ kind: "reach", balance: "1", month: "12", spreadBp: "-5", termMonths: "60" })])).toEqual([]);
  });
});

describe("toBalancePlan", () => {
  it("writes one knot per target, omits Run off, keeps a stored path verbatim, and adds nothing", () => {
    const plan = toBalancePlan({ id: "bp-x", label: "Test", asOf: "2026-03-31" }, [
      row({ familyId: "cash", kind: "flat", spreadBp: "100", termMonths: "12" }),
      row({ familyId: "fhlb", kind: "runoff" }),
      row({ familyId: "fixed-loans", opening: 650_000_000, kind: "reach", balance: "1", month: "12", spreadBp: "150", termMonths: "60" }),
      row({ familyId: "mbs", kind: "stored", storedPath: [{ month: 12, balance: 1 }, { month: 24, balance: 2 }], spreadBp: "20", termMonths: "6" }),
    ]);
    expect(plan).toEqual({
      schemaVersion: "1.0.0", id: "bp-x", label: "Test", asOf: "2026-03-31", unlistedFamilies: "runoff",
      targets: [
        { familyId: "cash", path: [{ month: 1, balance: 150_000_000 }], newBusinessPricing: { spreadOverIndexBp: 100, termMonths: 12 } },
        { familyId: "fixed-loans", path: [{ month: 12, balance: 1 }], newBusinessPricing: { spreadOverIndexBp: 150, termMonths: 60 } },
        { familyId: "mbs", path: [{ month: 12, balance: 1 }, { month: 24, balance: 2 }], newBusinessPricing: { spreadOverIndexBp: 20, termMonths: 6 } },
      ],
    });
  });
  it("withKind keeps the typed pricing and clears nothing else", () => {
    expect(withKind(row({ spreadBp: "7", termMonths: "9" }), "flat")).toMatchObject({ kind: "flat", spreadBp: "7", termMonths: "9" });
  });
});

describe("usd", () => {
  it("groups with commas, keeps every digit and prints a true minus", () => {
    expect(usd(150_000_000)).toBe("150,000,000");
    expect(usd(1234.5)).toBe("1,234.5");
    expect(usd(-2)).toBe("−2");
  });
  it("prints a value whose printed magnitude is 0 as 0, with no sign", () => {
    expect(usd(-1e-300)).toBe("0");
  });
});
