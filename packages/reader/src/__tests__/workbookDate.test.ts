// packages/reader/src/__tests__/workbookDate.test.ts
// Studio Part 2 P3: the date a market workbook is stamped with, read from its filename. The kernel's rule is
// restated by hand: a _YYYYMMDD suffix directly before the extension. The server route's own detection is looser
// (the date anywhere in the name), so a second helper names that case.
import { describe, expect, it } from "vitest";
import { stampDateFromName, workbookDateFromName, workbookStamp } from "../workbookDate";

describe("workbookDateFromName", () => {
  it("reads a _YYYYMMDD suffix before the extension", () => {
    expect(workbookDateFromName("market_20260331.xlsx")).toBe("2026-03-31");
  });
  it("is null for a name with no date", () => {
    expect(workbookDateFromName("market.xlsx")).toBeNull();
  });
  it("is null when the date is not directly before the extension", () => {
    expect(workbookDateFromName("x_20260331_v2.xlsx")).toBeNull();
  });
  it("reads an uppercase extension", () => {
    expect(workbookDateFromName("MARKET_20260331.XLSX")).toBe("2026-03-31");
  });
  it("is null for a month or a day that is not on a calendar page", () => {
    expect(workbookDateFromName("m_20261301.xlsx")).toBeNull();
    expect(workbookDateFromName("m_20260001.xlsx")).toBeNull();
    expect(workbookDateFromName("m_20260132.xlsx")).toBeNull();
    expect(workbookDateFromName("m_20260100.xlsx")).toBeNull();
  });
});

describe("stampDateFromName", () => {
  it("is the kernel date when the suffix is there", () => {
    expect(stampDateFromName("market_20260331.xlsx")).toBe("2026-03-31");
  });
  it("finds the date anywhere in the name, as the route does", () => {
    expect(stampDateFromName("x_20260331_v2.xlsx")).toBe("2026-03-31");
  });
  it("is null when the name carries no date at all", () => {
    expect(stampDateFromName("market.xlsx")).toBeNull();
    expect(stampDateFromName("market_2026.xlsx")).toBeNull();
  });
});

describe("workbookStamp", () => {
  it("a good suffix is a date", () => {
    expect(workbookStamp("market_20260331.xlsx")).toEqual({ kind: "date", date: "2026-03-31" });
  });
  it("a date elsewhere in the name is the route's, so it is still a date", () => {
    expect(workbookStamp("x_20260331_v2.xlsx")).toEqual({ kind: "date", date: "2026-03-31" });
  });
  it("no date at all is none", () => {
    expect(workbookStamp("x.xlsx")).toEqual({ kind: "none" });
  });
  it("a suffix the kernel would stamp but the calendar refuses is a bad date, named as it would be stamped", () => {
    expect(workbookStamp("x_20261331.xlsx")).toEqual({ kind: "bad", raw: "2026-13-31" });
    expect(workbookStamp("x_20260100.xlsx")).toEqual({ kind: "bad", raw: "2026-01-00" });
  });
  it("the suffix wins over an earlier good date: the kernel stamps the last one", () => {
    expect(workbookStamp("a_20260331_b_20261301.xlsx")).toEqual({ kind: "bad", raw: "2026-13-01" });
  });
  it("Feb 30 passes the month and day rule on both sides and stays a date", () => {
    expect(workbookStamp("x_20260230.xlsx")).toEqual({ kind: "date", date: "2026-02-30" });
  });
  it("a bad date that is not the suffix is none, so the as-of text decides", () => {
    expect(workbookStamp("x_20261331_v2.xlsx")).toEqual({ kind: "none" });
  });
  it("the existing helpers keep their answers", () => {
    expect(workbookDateFromName("x_20261331.xlsx")).toBeNull();
    expect(stampDateFromName("x_20261331.xlsx")).toBeNull();
  });
});
