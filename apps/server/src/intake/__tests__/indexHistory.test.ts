// apps/server/src/intake/__tests__/indexHistory.test.ts
// The index history import parser.
// Every sentence and number below is restated by hand from the spec; synthetic files only (decision 56).
import * as XLSX from "xlsx";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { indexHistoryIdOf, validateIndexHistory } from "@alm/engine";
import { parseIndexHistoryFile, readCsvRows } from "../indexHistory";

const csv = (s: string) => Buffer.from(s, "utf8");
const ok = (r: ReturnType<typeof parseIndexHistoryFile>) => {
  if (!r.ok) throw new Error(r.refusals.join("; "));
  return r.history;
};
const refusals = (r: ReturnType<typeof parseIndexHistoryFile>) => (r.ok ? [] : r.refusals);

/** Synthetic daily SOFR-style fixings in percent: 31 Jan and 28 Feb 2026 are Saturdays; 16 Feb is a holiday row. */
const DAILY = [
  "date,rate", "2026-01-29,4.30", "2026-01-30,4.31", "2026-02-02,4.32", "2026-02-16,.", "2026-02-26,4.33", "2026-02-27,4.34", "2026-03-02,4.35", "2026-03-31,4.36", "",
].join("\r\n");

/**
 * A one-sheet workbook of the given rows, the first column formatted as dates (a cell that is present). `valueFormat`
 * sets the number format of every value cell; `date1904` writes the workbook in the 1904 date system.
 */
function workbook(aoa: unknown[][], opts: { valueFormat?: string; date1904?: boolean } = {}): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let r = 2; r <= aoa.length; r++) {
    const a = ws[`A${r}`];
    if (a !== undefined) a.z = "yyyy-mm-dd";
    const b = ws[`B${r}`];
    if (b !== undefined && opts.valueFormat !== undefined) b.z = opts.valueFormat;
  }
  const wb = XLSX.utils.book_new();
  // Not "History": Excel reserves that sheet name and SheetJS 0.20 refuses to write it. The parser reads the first sheet.
  XLSX.utils.book_append_sheet(wb, ws, "Rates");
  if (opts.date1904 === true) wb.Workbook = { WBProps: { date1904: true } };
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** The zip reader and writer the xlsx package bundles (on the default export under ESM interop). */
const CFB = ((XLSX as unknown as { CFB?: typeof XLSX.CFB }).CFB ?? (XLSX as unknown as { default: { CFB: typeof XLSX.CFB } }).default.CFB);

/** Rewrite the first sheet's XML of an .xlsx: how a workbook with a declared range far past its cells is made without writing every cell. */
function patchSheetXml(bytes: Buffer, edit: (xml: string) => string): Buffer {
  const cfb = CFB.read(bytes, { type: "buffer" });
  const entry = CFB.find(cfb, "/xl/worksheets/sheet1.xml")!;
  const xml = edit(Buffer.from(entry.content as Uint8Array).toString("utf8"));
  entry.content = Buffer.from(xml, "utf8");
  entry.size = entry.content.length;
  return Buffer.from(CFB.write(cfb, { type: "buffer", fileType: "zip" }) as Uint8Array);
}

describe("the index history import parser (spec v6 decisions 47, 50, 51, 55)", () => {
  it("Review Focus 3: a daily file with holidays and weekend month ends keeps each month's last fixing, in decimal", () => {
    const h = ok(parseIndexHistoryFile(csv(DAILY), "sofr-daily.csv", { unit: "percent" }));
    expect(h).toEqual({
      label: "sofr-daily",
      firstMonth: "2026-01",
      values: [0.0431, 0.0434, 0.0436],
      source: { fileName: "sofr-daily.csv", fileSha256: createHash("sha256").update(csv(DAILY)).digest("hex"), format: "csv", frequency: "daily", rows: 8, unit: "percent" },
    });
    expect(validateIndexHistory(h)).toEqual([]);
  });
  it("a file of one row per month is monthly as it is; a label is taken when sent", () => {
    const h = ok(parseIndexHistoryFile(csv("2026-01,4.31\n2026-02,4.34\n2026-03,4.36\n"), "m.csv", { unit: "percent", label: "One-month (synthetic)" }));
    expect([h.label, h.firstMonth, h.values, h.source.frequency, h.source.rows]).toEqual(["One-month (synthetic)", "2026-01", [0.0431, 0.0434, 0.0436], "monthly", 3]);
  });
  it("trims the label before the document is built, so surrounding spaces give the same document and the same ih- id", () => {
    const file = csv("2026-01,4.31\n2026-02,4.34\n");
    const plain = ok(parseIndexHistoryFile(file, "m.csv", { unit: "percent", label: "One-month (synthetic)" }));
    const padded = ok(parseIndexHistoryFile(file, "m.csv", { unit: "percent", label: "  One-month (synthetic) \t" }));
    expect(padded.label).toBe("One-month (synthetic)");
    expect(padded).toEqual(plain);
    expect(indexHistoryIdOf(padded)).toBe(indexHistoryIdOf(plain));
    expect(refusals(parseIndexHistoryFile(file, "m.csv", { unit: "percent", label: "   " }))).toEqual(["label must be 1 to 120 characters"]);
  });
  it("Review Focus 4: a percent file declared decimal is refused naming the row; a near-zero 2021 percent file declared percent is accepted", () => {
    expect(refusals(parseIndexHistoryFile(csv(DAILY), "sofr-daily.csv", { unit: "decimal" }))[0]).toBe(
      "row 2: value 4.3 is above 1.0, which a decimal rate cannot be; if the file is in percent, import it with the unit percent",
    );
    const h = ok(parseIndexHistoryFile(csv("date,sofr\n2021-01-29,0.09\n2021-02-26,0.04\n2021-03-31,0.01\n"), "sofr-2021.csv", { unit: "percent" }));
    expect(h.values).toEqual([0.0009, 0.0004, 0.0001]);
  });
  it("requires a declared unit", () => {
    expect(refusals(parseIndexHistoryFile(csv(DAILY), "x.csv", { unit: null }))).toEqual(["unit must be percent or decimal; the import never guesses the unit of a file"]);
  });
  it("refuses an empty month inside the series, naming it; a missing day inside a month is fine", () => {
    expect(refusals(parseIndexHistoryFile(csv("2025-11-28,4.30\n2026-01-30,4.31\n"), "gap.csv", { unit: "percent" }))).toEqual([
      "the series has no value in 2025-12; a month inside the series must hold at least one value",
    ]);
  });
  it("refuses bad dates, bad values, mixed rows, repeated dates and a third column, each naming the row", () => {
    expect(refusals(parseIndexHistoryFile(csv("date,v\n1/30/2026,4.3\n"), "x.csv", { unit: "percent" }))).toEqual(['row 2: date "1/30/2026" is not YYYY-MM-DD, YYYY-MM or an Excel date']);
    expect(refusals(parseIndexHistoryFile(csv("2026-02-30,4.3\n"), "x.csv", { unit: "percent" }))).toEqual(['row 1: date "2026-02-30" is not YYYY-MM-DD, YYYY-MM or an Excel date']);
    expect(refusals(parseIndexHistoryFile(csv("2026-01-30,4.3%\n"), "x.csv", { unit: "percent" }))).toEqual(['row 1: value "4.3%" is not a number']);
    expect(refusals(parseIndexHistoryFile(csv("2026-01-30,4.3\n2026-02,4.4\n"), "x.csv", { unit: "percent" }))).toEqual([
      'row 2: date "2026-02" is a month but row 1 is a day; a file holds daily rows or monthly rows, not both',
    ]);
    expect(refusals(parseIndexHistoryFile(csv("2026-01-30,4.3\n2026-01-30,4.4\n"), "x.csv", { unit: "percent" }))).toEqual(["rows 1 and 2 both carry 2026-01-30"]);
    expect(refusals(parseIndexHistoryFile(csv("2026-01-30,4.3,x\n"), "x.csv", { unit: "percent" }))).toEqual(["row 1: expected two columns, date and value; got 3"]);
    expect(refusals(parseIndexHistoryFile(csv("date,v\n"), "x.csv", { unit: "percent" }))).toEqual(["the file holds no dated rows; expected two columns, date and value"]);
  });
  it("refuses a date before 1900 or after 2200, naming the row: year 0000 and a mis-read Excel serial", () => {
    expect(refusals(parseIndexHistoryFile(csv("0000-01,4.3\n"), "x.csv", { unit: "percent" }))).toEqual(['row 1: date "0000-01" is outside the years 1900 to 2200; check the date column']);
    expect(refusals(parseIndexHistoryFile(csv("2026-01-30,4.3\n2201-01-31,4.4\n"), "x.csv", { unit: "percent" }))).toEqual(['row 2: date "2201-01-31" is outside the years 1900 to 2200; check the date column']);
    // Serial 200000 is 2447-07-30 (counted by hand from 1899-12-30): a value column read as dates lands far from today.
    expect(refusals(parseIndexHistoryFile(workbook([["date", "value"], [46052, 4.31], [200000, 4.34]]), "x.xlsx", { unit: "percent" }))).toEqual([
      'row 3: date "2447-07-30" is outside the years 1900 to 2200; check the date column',
    ]);
  });
  it("caps the series at 1,200 months after conversion", () => {
    const rows = Array.from({ length: 1201 }, (_, k) => `${String(1900 + Math.floor(k / 12)).padStart(4, "0")}-${String((k % 12) + 1).padStart(2, "0")},1`);
    expect(refusals(parseIndexHistoryFile(csv(rows.join("\n")), "long.csv", { unit: "percent" }))).toEqual(["the series covers 1201 months after conversion; an index history holds at most 1,200"]);
  });
  it("reads quoted CSV fields and a byte-order mark", () => {
    expect(readCsvRows('\uFEFF"date","value"\n"2026-01-30","4.31"\n').map((r) => r.cells)).toEqual([["date", "value"], ["2026-01-30", "4.31"]]);
  });
  it("R4: an Excel date cell (serial 46052 is 2026-01-30) is read as its calendar day", () => {
    const bytes = workbook([["date", "value"], [46052, 4.31], [46080, 4.34], [46112, 4.36]]);
    const h = ok(parseIndexHistoryFile(bytes, "sofr.xlsx", { unit: "percent" }));
    expect([h.firstMonth, h.values, h.source.format, h.source.frequency]).toEqual(["2026-01", [0.0431, 0.0434, 0.0436], "xlsx", "monthly"]);
  });

  it("text YYYY-MM dates in a date-formatted column read as text, as SheetJS 0.18 returned them", () => {
    const h = ok(parseIndexHistoryFile(workbook([["Month", "Rate"], ["2026-01", 4.3], ["2026-02", 4.4]]), "text-dates.xlsx", { unit: "percent" }));
    expect([h.firstMonth, h.values, h.source.frequency]).toEqual(["2026-01", [0.043, 0.044], "monthly"]);
  });

  it('a "." in a date-formatted value cell is a dated row with no value, as in a CSV', () => {
    const bytes = workbook([["date", "value"], [46052, 4.31], [46053, "."], [46080, 4.34]], { valueFormat: "m/d/yy" });
    const h = ok(parseIndexHistoryFile(bytes, "dot.xlsx", { unit: "percent" }));
    const fromCsv = ok(parseIndexHistoryFile(csv("2026-01-30,4.31\n2026-01-31,.\n2026-02-27,4.34\n"), "dot.csv", { unit: "percent" }));
    expect([h.firstMonth, h.values, h.source.rows]).toEqual([fromCsv.firstMonth, fromCsv.values, fromCsv.source.rows]);
    expect(h.values).toEqual([0.0431, 0.0434]);
  });

  it("the 1904 date system: serial 44590 reads 2026-01-30", () => {
    const h = ok(parseIndexHistoryFile(workbook([["date", "value"], [44590, 4.31]], { date1904: true }), "w1904.xlsx", { unit: "percent" }));
    expect([h.firstMonth, h.values]).toEqual(["2026-01", [0.0431]]);
  });

  it("a declared sheet range far past the cells (A1:XFD1048576) reads only the real cells", () => {
    const bytes = patchSheetXml(workbook([["date", "value"], [46052, 4.31], [46080, 4.34]]), (xml) => xml.replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:XFD1048576"/>'));
    const h = ok(parseIndexHistoryFile(bytes, "wide.xlsx", { unit: "percent" }));
    expect([h.firstMonth, h.values, h.source.rows]).toEqual(["2026-01", [0.0431, 0.0434], 2]);
  });

  it("refuses a sheet whose real cells span more than 2,000,000 cells, naming the file", () => {
    const bytes = patchSheetXml(workbook([["date", "value"], [46052, 4.31]]), (xml) =>
      xml.replace("</sheetData>", '<row r="1000001"><c r="B1000001"><v>1</v></c></row></sheetData>'),
    );
    expect(refusals(parseIndexHistoryFile(bytes, "tall.xlsx", { unit: "percent" }))).toEqual([
      'file "tall.xlsx": the first sheet\'s cells span A1:B1000001, 2000002 cells; an index history sheet holds at most 2,000,000 cells',
    ]);
  });

  it("a value cell formatted as a percentage refuses the unit percent, naming the stored and shown values; the unit decimal imports it", () => {
    const bytes = workbook([["date", "value"], [46052, 0.0431], [46080, 0.0434]], { valueFormat: "0.00%" });
    expect(refusals(parseIndexHistoryFile(bytes, "pct.xlsx", { unit: "percent" }))).toEqual([
      "row 2: the value cell is formatted as a percentage, so the workbook stores 0.0431 for 4.31%; import it with the unit decimal",
      "row 3: the value cell is formatted as a percentage, so the workbook stores 0.0434 for 4.34%; import it with the unit decimal",
    ]);
    expect(ok(parseIndexHistoryFile(bytes, "pct.xlsx", { unit: "decimal" })).values).toEqual([0.0431, 0.0434]);
  });

  it("an Excel date cell before 1913 refuses in both date systems; a typed date keeps 1900 to 2200", () => {
    expect(refusals(parseIndexHistoryFile(workbook([["date", "value"], [4.31, 4.3]]), "x.xlsx", { unit: "percent" }))).toEqual([
      "row 2: date cell 4.31 reads as 1900-01-04 as an Excel date, before 1913; check that the first column holds dates",
    ]);
    expect(refusals(parseIndexHistoryFile(workbook([["date", "value"], [4.31, 4.3]], { date1904: true }), "x.xlsx", { unit: "percent" }))).toEqual([
      "row 2: date cell 4.31 reads as 1904-01-05 as an Excel date, before 1913; check that the first column holds dates",
    ]);
    // Serial 4750 is 1913-01-01 and 4749 is 1912-12-31 (counted by hand from 1899-12-30).
    expect(ok(parseIndexHistoryFile(workbook([["date", "value"], [4750, 4.3]]), "x.xlsx", { unit: "percent" })).firstMonth).toBe("1913-01");
    expect(refusals(parseIndexHistoryFile(workbook([["date", "value"], [4749, 4.3]]), "x.xlsx", { unit: "percent" }))).toEqual([
      "row 2: date cell 4749 reads as 1912-12-31 as an Excel date, before 1913; check that the first column holds dates",
    ]);
    expect(ok(parseIndexHistoryFile(csv("1905-01,4.3\n"), "x.csv", { unit: "percent" })).firstMonth).toBe("1905-01");
  });

  it("an empty date cell in an .xlsx reads as empty", () => {
    expect(refusals(parseIndexHistoryFile(workbook([["date", "value"], [46052, 4.31], [null, 4.34]]), "x.xlsx", { unit: "percent" }))).toEqual(["row 3: date cell is empty"]);
  });

  it("truncates a shown cell to 40 characters, as an unterminated quote swallowing the file shows", () => {
    const text = '2026-01-30,"4.31\n2026-02-27,4.34\n2026-03-31,4.36\n2026-04-30,4.37\n2026-05-29,4.38\n';
    expect(refusals(parseIndexHistoryFile(csv(text), "x.csv", { unit: "percent" }))).toEqual(['row 1: value "4.31\\n2026-02-27,4.34\\n2026-03-31,4.36\\n202..." is not a number']);
  });

  it("lists at most 12 row refusals, then counts the rest", () => {
    const text = Array.from({ length: 15 }, () => "bad,1").join("\n");
    const got = refusals(parseIndexHistoryFile(csv(text), "x.csv", { unit: "percent" }));
    expect(got).toEqual([...Array.from({ length: 12 }, (_, i) => `row ${i + 1}: date "bad" is not YYYY-MM-DD, YYYY-MM or an Excel date`), "and 3 more rows refused"]);
  });

  it("a first row is a header only when its date is not a date and its value is not a number", () => {
    expect(refusals(parseIndexHistoryFile(csv("2026/01/30,4.30\n2026-02-27,4.34\n"), "x.csv", { unit: "percent" }))).toEqual([
      'row 1: date "2026/01/30" is not YYYY-MM-DD, YYYY-MM or an Excel date',
    ]);
  });

  it("a number in column A of a CSV is not a date", () => {
    expect(refusals(parseIndexHistoryFile(csv("46052,4.31\n"), "x.csv", { unit: "percent" }))).toEqual(['row 1: date "46052" is not YYYY-MM-DD, YYYY-MM or an Excel date']);
  });

  // B3b follow-up item 6: a daily file whose last dated day falls before its last month's last weekday stores that day's
  // fixing as the month's value. The parse says so beside the document; the document, and so its id, is unchanged.
  it("a daily file that ends before its last month's last weekday flags that month, outside the stored document", () => {
    const bytes = csv("date,rate\n2026-02-27,4.34\n2026-03-02,4.35\n2026-03-13,4.40\n");
    const r = parseIndexHistoryFile(bytes, "mid.csv", { unit: "percent" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.partialLastMonth).toEqual({ month: "2026-03", lastDay: "2026-03-13" });
    const doc = {
      label: "mid", firstMonth: "2026-02", values: [0.0434, 0.044],
      source: { fileName: "mid.csv", fileSha256: createHash("sha256").update(bytes).digest("hex"), format: "csv", frequency: "daily", rows: 3, unit: "percent" },
    };
    expect(r.history).toEqual(doc);
    expect(indexHistoryIdOf(r.history)).toBe(indexHistoryIdOf(doc as Parameters<typeof indexHistoryIdOf>[0]));
  });
  it("no flag when the last day is the month's last weekday or later, a dated holiday row included, or for a monthly file", () => {
    const flag = (text: string) => {
      const r = parseIndexHistoryFile(csv(text), "x.csv", { unit: "percent" });
      if (!r.ok) throw new Error(r.refusals.join("; "));
      return r.partialLastMonth;
    };
    // 2026-03-31 is a Tuesday; 2026-02-28 is a Saturday, so Friday 2026-02-27 is February's last weekday.
    expect(flag(DAILY)).toBeUndefined();
    expect(flag("2026-02-02,4.32\n2026-02-27,4.34\n")).toBeUndefined();
    // A "." row on the last weekday is a dated row with no value: the file reaches the month end; 03-30 holds the value.
    expect(flag("2026-03-30,4.35\n2026-03-31,.\n")).toBeUndefined();
    // Friday 2026-03-27 is before Tuesday 2026-03-31 (two rows in the month, so the file is daily).
    expect(flag("2026-03-26,4.34\n2026-03-27,4.35\n")).toEqual({ month: "2026-03", lastDay: "2026-03-27" });
    expect(flag("2026-01,4.31\n2026-02,4.34\n")).toBeUndefined();
  });
  it("a Friday month end and a Sunday month end (fix round 1, MINOR 1)", () => {
    const flag = (text: string) => {
      const r = parseIndexHistoryFile(csv(text), "x.csv", { unit: "percent" });
      if (!r.ok) throw new Error(r.refusals.join("; "));
      return r.partialLastMonth;
    };
    // 2026-07-31 is a Friday, so it is July's last weekday.
    expect(flag("2026-07-29,4.30\n2026-07-30,4.31\n2026-07-31,4.32\n")).toBeUndefined();
    expect(flag("2026-07-29,4.30\n2026-07-30,4.31\n")).toEqual({ month: "2026-07", lastDay: "2026-07-30" });
    // 2026-05-31 is a Sunday, so Friday 2026-05-29 is May's last weekday.
    expect(flag("2026-05-28,4.30\n2026-05-29,4.31\n")).toBeUndefined();
    expect(flag("2026-05-27,4.30\n2026-05-28,4.31\n")).toEqual({ month: "2026-05", lastDay: "2026-05-28" });
  });
  it("only a daily file is flagged: day-dated rows one per month, as a monthly series dated on its first day, are not (fix round 1, MINOR 3)", () => {
    const r = parseIndexHistoryFile(csv("2026-01-01,4.31\n2026-02-01,4.34\n2026-03-01,4.36\n"), "x.csv", { unit: "percent" });
    if (!r.ok) throw new Error(r.refusals.join("; "));
    expect(r.history.source.frequency).toBe("monthly");
    expect(r.partialLastMonth).toBeUndefined();
    // A daily file whose last month holds one row is still daily, and still flagged.
    const d = parseIndexHistoryFile(csv("2026-02-26,4.33\n2026-02-27,4.34\n2026-03-02,4.35\n"), "x.csv", { unit: "percent" });
    if (!d.ok) throw new Error(d.refusals.join("; "));
    expect([d.history.source.frequency, d.partialLastMonth]).toEqual(["daily", { month: "2026-03", lastDay: "2026-03-02" }]);
  });

  it("a blank row mid-file is skipped and keeps its line number", () => {
    const h = ok(parseIndexHistoryFile(csv("2026-01,4.31\n\n2026-02,4.34\n"), "x.csv", { unit: "percent" }));
    expect([h.values, h.source.rows]).toEqual([[0.0431, 0.0434], 2]);
    expect(refusals(parseIndexHistoryFile(csv("2026-01,4.31\n\n2026-02,x\n"), "x.csv", { unit: "percent" }))).toEqual(['row 3: value "x" is not a number']);
  });

  it("an empty value cell is a dated row with no value; the month keeps its latest value", () => {
    const h = ok(parseIndexHistoryFile(csv("2026-01-29,4.30\n2026-01-30,\n2026-02-27,4.34\n"), "x.csv", { unit: "percent" }));
    expect([h.values, h.source.rows, h.source.frequency]).toEqual([[0.043, 0.0434], 3, "daily"]);
  });

  it("daily rows out of date order keep each month's latest dated value", () => {
    const h = ok(parseIndexHistoryFile(csv("2026-02-27,4.34\n2026-01-30,4.31\n2026-01-29,4.30\n2026-02-02,4.32\n"), "x.csv", { unit: "percent" }));
    expect([h.firstMonth, h.values, h.source.frequency]).toEqual(["2026-01", [0.0431, 0.0434], "daily"]);
  });

  it("bounds each value by its unit: percent within plus or minus 100, decimal not below -1", () => {
    expect(refusals(parseIndexHistoryFile(csv("2026-01,100.5\n"), "x.csv", { unit: "percent" }))).toEqual(["row 1: value 100.5 percent is outside -100 to 100 percent"]);
    expect(refusals(parseIndexHistoryFile(csv("2026-01,-1.5\n"), "x.csv", { unit: "decimal" }))).toEqual(["row 1: value -1.5 is below -1.0, which a decimal rate cannot be"]);
  });

  it("refuses a file with no values, and an .xlsx the workbook reader cannot open", () => {
    expect(refusals(parseIndexHistoryFile(csv("2026-01-30,.\n2026-02-27,\n"), "x.csv", { unit: "percent" }))).toEqual(['the file holds no values; every dated row is empty or "."']);
    expect(refusals(parseIndexHistoryFile(Buffer.from("PK\x03\x04garbage garbage", "latin1"), "bad.xlsx", { unit: "percent" }))).toEqual([
      'file "bad.xlsx" is not a readable .xlsx workbook: Unsupported ZIP encryption',
    ]);
  });
});
