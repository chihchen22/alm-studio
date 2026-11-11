/**
 * Index history intake. A CSV or .xlsx file of two
 * columns, date and value, becomes one IndexHistory document: monthly month-end fixings as decimals. The unit is
 * declared by the caller and never guessed. The .xlsx arm reads the first sheet with the xlsx package (SheetJS 0.20.3
 * from cdn.sheetjs.com, a direct dependency of apps/server; R4); an Excel date cell is a serial number, converted by
 * XLSX.SSF.parse_date_code, so no time zone enters. The CSV arm is a small RFC 4180 reader (R5); positionsCsv.ts is
 * not shared. Synthetic files only in tests (decision 56).
 *
 * Rules, in order. File level, first failure alone: the unit, the extension, the size, the label (trimmed before the
 * document is built, so surrounding spaces never change the id). Row level, every refusal collected: blank rows are
 * skipped; the first row is a header when its first cell is a non-empty string that is not a date; a third non-empty
 * cell refuses the row; a date is YYYY-MM-DD (a real calendar day), YYYY-MM, or an Excel serial in an .xlsx, from
 * 1900 to 2200 (a year outside that is a misread column, an Excel serial read as a number included); a value is a
 * plain number, and an empty cell or a lone "." is a dated row with no value; day rows and month rows do not mix; two
 * rows on one date refuse; the unit converts each value and bounds it. Series level, only when no row refused: each
 * month takes its latest dated value (the last fixing on or before the month end, decision 47), a month inside the
 * series with no value refuses (decision 55), and the series holds at most 1,200 months.
 *
 * A daily file (source.frequency daily: some month holds more than one dated row) whose last dated day (a "." row
 * counts) falls before the last weekday of the series' last month stores
 * that day's fixing as the month's value. The parse says so in partialLastMonth, beside the document and never in it,
 * so the stored record and its id are unchanged (B3b follow-up item 6). Weekdays only: no holiday calendar is read.
 */
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { MAX_INDEX_HISTORY_MONTHS, monthIndex, validateIndexHistory, type IndexHistory, type IndexHistoryUnit } from "@alm/engine";
// The engine barrel does not export the macro module; the server imports engine internals by path (as derivedMarkets.ts does with "@alm/engine/src/market").
import { monthAdd } from "@alm/engine/src/macro/macroFactors";

export const MAX_INDEX_HISTORY_FILE_BYTES = 4 * 1024 * 1024;
export interface RawRow {
  row: number;
  cells: unknown[];
  /** .xlsx only: the Excel serial the date cell held, when it was read as a date (cells[0] then holds the day). */
  dateSerial?: number;
  /** .xlsx only: the value cell's shown text, when its number format is a percentage (the cell stores 0.0431 for 4.31%). */
  percentShown?: string;
}
/** The most cells the first sheet's real range may span (its cells' own bounds, not the range it declares). */
export const MAX_INDEX_HISTORY_SHEET_CELLS = 2_000_000;

/** The first sheet's real cells span more than MAX_INDEX_HISTORY_SHEET_CELLS. */
export class SheetTooLargeError extends Error {
  constructor(readonly range: string, readonly cells: number) {
    super(`the first sheet's cells span ${range}, ${cells} cells; an index history sheet holds at most 2,000,000 cells`);
    this.name = "SheetTooLargeError";
  }
}
/** The series' last month, when a daily file's last dated day is before that month's last weekday. */
export interface PartialLastMonth {
  month: string;
  lastDay: string;
}
export type IndexHistoryParse = { ok: true; history: IndexHistory; partialLastMonth?: PartialLastMonth } | { ok: false; refusals: string[] };

/** The last Monday to Friday of a month YYYY-MM, as YYYY-MM-DD (UTC calendar arithmetic, no time zone). */
function lastWeekdayOf(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  let day = new Date(Date.UTC(y, m, 0)).getUTCDate();
  while ([0, 6].includes(new Date(Date.UTC(y, m - 1, day)).getUTCDay())) day--;
  return `${month}-${String(day).padStart(2, "0")}`;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
/** The years a dated row may carry: outside them the column was misread. */
const FIRST_YEAR = 1900;
const LAST_YEAR = 2200;
/** Empty months, and refused rows, named one by one before the rest are counted. */
const MAX_EMPTY_MONTHS_NAMED = 12;
const MAX_ROW_REFUSALS_NAMED = 12;
/** An Excel date cell before this day is a number column read as dates (4.31 reads 1900-01-04, or 1904-01-05). */
const EXCEL_DATE_FLOOR = "1913-01-01";
/** A cell shown in a refusal is cut to this many characters (an unterminated quote can swallow the whole file). */
const CELL_SHOWN_MAX = 40;
const LABEL_MAX = 120;
const show = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v) : String(v));
const showCell = (v: unknown): string => {
  const text = typeof v === "string" ? v : String(v);
  const cut = text.length > CELL_SHOWN_MAX ? `${text.slice(0, CELL_SHOWN_MAX)}...` : text;
  return typeof v === "string" ? JSON.stringify(cut) : cut;
};
const blank = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const round12 = (v: number): number => { const r = Number(v.toPrecision(12)); return r === 0 ? 0 : r; };

/** RFC 4180: commas, double-quoted fields with "" escapes, CRLF or LF, a leading byte-order mark dropped. Rows are 1-based. */
export function readCsvRows(text: string): RawRow[] {
  const s = text.replace(/^\uFEFF/, "");
  const rows: RawRow[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let row = 1;
  const endRow = (): void => {
    cells.push(cell);
    rows.push({ row, cells });
    cells = [];
    cell = "";
    row++;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === "") { quoted = true; i++; continue; }
    if (c === ",") { cells.push(cell); cell = ""; i++; continue; }
    if (c === "\r" && s[i + 1] === "\n") { endRow(); i += 2; continue; }
    if (c === "\n" || c === "\r") { endRow(); i++; continue; }
    cell += c;
    i++;
  }
  // Trailing-newline rule: a last line with no newline after it is a row; the empty text after a final newline is not.
  // Every line, blank ones included, takes a row number, so a refusal names the line a spreadsheet shows.
  if (cell !== "" || cells.length > 0 || quoted) endRow();
  return rows;
}

/**
 * The first sheet as rows of raw cells: numbers stay numbers, strings stay strings, and a number in the first column
 * is read as an Excel date (its day in cells[0], its serial in dateSerial). Rows are the sheet's 1-based rows. The
 * sheet's declared range (!ref) can run far past its cells (A1:XFD1048576 is 17 billion cells), so the range is rebuilt
 * from the cells themselves and refused above MAX_INDEX_HISTORY_SHEET_CELLS (SheetTooLargeError).
 */
export function readXlsxRows(bytes: Buffer): RawRow[] {
  const wb = XLSX.read(bytes, { type: "buffer", cellNF: true });
  const sheet = wb.Sheets[wb.SheetNames[0] ?? ""];
  if (sheet === undefined) return [];
  const date1904 = wb.Workbook?.WBProps?.date1904 === true;
  let r0 = Infinity;
  let c0 = Infinity;
  let r1 = -1;
  let c1 = -1;
  for (const key of Object.keys(sheet)) {
    if (key.startsWith("!")) continue;
    const { r, c } = XLSX.utils.decode_cell(key);
    r0 = Math.min(r0, r);
    c0 = Math.min(c0, c);
    r1 = Math.max(r1, r);
    c1 = Math.max(c1, c);
  }
  if (r1 < 0) return [];
  const ref = XLSX.utils.encode_range({ s: { r: r0, c: c0 }, e: { r: r1, c: c1 } });
  const span = (r1 - r0 + 1) * (c1 - c0 + 1);
  if (span > MAX_INDEX_HISTORY_SHEET_CELLS) throw new SheetTooLargeError(ref, span);
  sheet["!ref"] = ref;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true }) as unknown[][];
  return rows.map((row, i) => {
    // A present number, text or boolean cell keeps its stored value: SheetJS 0.20 turns a date-formatted cell (a
    // serial, or text such as "2026-01" or ".") into a Date in sheet_to_json even with raw on; 0.18 returned the
    // stored value, which is what this reader reads. Error and blank cells keep sheet_to_json's reading.
    const cells = row.map((v, j) => {
      const cell = sheet[XLSX.utils.encode_cell({ r: r0 + i, c: c0 + j })] as XLSX.CellObject | undefined;
      return cell !== undefined && (cell.t === "n" || cell.t === "s" || cell.t === "b") ? cell.v : v;
    });
    const out: RawRow = { row: r0 + i + 1, cells: [...cells] };
    const first = cells[0];
    const day = typeof first === "number" ? excelDay(first, date1904) : null;
    if (day !== null) {
      out.cells[0] = day;
      out.dateSerial = first as number;
    }
    const value = sheet[XLSX.utils.encode_cell({ r: r0 + i, c: c0 + 1 })] as XLSX.CellObject | undefined;
    if (value?.t === "n" && typeof value.z === "string" && value.z.includes("%")) {
      out.percentShown = typeof value.w === "string" ? value.w : `${round12((value.v as number) * 100)}%`;
    }
    return out;
  });
}

/** An Excel serial date as YYYY-MM-DD, or null when it is not one (below 1). */
function excelDay(serial: number, date1904: boolean): string | null {
  if (!(serial >= 1)) return null;
  const d = XLSX.SSF.parse_date_code(Math.floor(serial), { date1904 });
  return `${String(d.y).padStart(4, "0")}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
}

/** A real calendar day: the UTC round trip gives back the same year, month and day. */
function isCalendarDay(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(2000, 0, 1));
  t.setUTCFullYear(y, m - 1, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

type DateCell = { kind: "day" | "month"; key: string; month: string } | { refusal: string };

function readDate(row: number, cell: unknown, serial: number | undefined): DateCell {
  if (blank(cell)) return { refusal: `row ${row}: date cell is empty` };
  const notDate = { refusal: `row ${row}: date ${showCell(cell)} is not YYYY-MM-DD, YYYY-MM or an Excel date` };
  if (typeof cell !== "string") return notDate;
  // An Excel date cell before 1913 is a number column read as dates; a typed date keeps the 1900 to 2200 rule.
  if (serial !== undefined && cell < EXCEL_DATE_FLOOR) {
    return { refusal: `row ${row}: date cell ${serial} reads as ${cell} as an Excel date, before 1913; check that the first column holds dates` };
  }
  const text = cell.trim();
  const day = DAY.exec(text);
  const month = day === null ? MONTH.exec(text) : null;
  const match = day ?? month;
  if (match === null) return notDate;
  const y = Number(match[1]);
  if (y < FIRST_YEAR || y > LAST_YEAR) return { refusal: `row ${row}: date ${showCell(text)} is outside the years ${FIRST_YEAR} to ${LAST_YEAR}; check the date column` };
  if (day !== null) {
    if (!isCalendarDay(y, Number(day[2]), Number(day[3]))) return notDate;
    return { kind: "day", key: text, month: text.slice(0, 7) };
  }
  return { kind: "month", key: text, month: text };
}

/** The value of a dated row: a number, null for a row with no value, or the refusal. */
function readValue(row: number, cell: unknown): { value: number | null } | { refusal: string } {
  if (blank(cell)) return { value: null };
  if (typeof cell === "number") return Number.isFinite(cell) ? { value: cell } : { refusal: `row ${row}: value ${showCell(cell)} is not a number` };
  if (typeof cell === "string") {
    const text = cell.trim();
    if (text === ".") return { value: null };
    if (NUMBER.test(text)) return { value: Number(text) };
  }
  return { refusal: `row ${row}: value ${showCell(cell)} is not a number` };
}

function convert(row: number, v: number, unit: IndexHistoryUnit): { value: number } | { refusal: string } {
  if (unit === "percent") {
    if (v < -100 || v > 100) return { refusal: `row ${row}: value ${v} percent is outside -100 to 100 percent` };
    return { value: round12(v / 100) };
  }
  if (v > 1) return { refusal: `row ${row}: value ${v} is above 1.0, which a decimal rate cannot be; if the file is in percent, import it with the unit percent` };
  if (v < -1) return { refusal: `row ${row}: value ${v} is below -1.0, which a decimal rate cannot be` };
  return { value: v === 0 ? 0 : v };
}

/** One import file to one IndexHistory document, or the sentences that refuse it. */
export function parseIndexHistoryFile(bytes: Buffer, fileName: string, opts: { unit: unknown; label?: string | null }): IndexHistoryParse {
  const refuse = (refusals: string[]): IndexHistoryParse => ({ ok: false, refusals });
  // File level: the first failure alone, before any row is read (N6).
  if (opts.unit !== "percent" && opts.unit !== "decimal") return refuse(["unit must be percent or decimal; the import never guesses the unit of a file"]);
  const unit: IndexHistoryUnit = opts.unit;
  const ext = /\.(csv|xlsx)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext !== "csv" && ext !== "xlsx") return refuse([`file ${show(fileName)} is neither .csv nor .xlsx`]);
  const format = ext;
  if (bytes.length > MAX_INDEX_HISTORY_FILE_BYTES) return refuse([`file ${show(fileName)} is ${bytes.length} bytes; an index history file is at most ${MAX_INDEX_HISTORY_FILE_BYTES} bytes`]);
  const label = (opts.label ?? fileName.slice(0, fileName.length - ext.length - 1)).trim();
  if (label.length === 0 || label.length > LABEL_MAX) return refuse([`label must be 1 to ${LABEL_MAX} characters`]);

  let raw: RawRow[];
  if (format === "csv") raw = readCsvRows(bytes.toString("utf8"));
  else {
    try {
      raw = readXlsxRows(bytes);
    } catch (err) {
      if (err instanceof SheetTooLargeError) return refuse([`file ${show(fileName)}: ${err.message}`]);
      return refuse([`file ${show(fileName)} is not a readable .xlsx workbook: ${err instanceof Error ? err.message : String(err)}`]);
    }
  }
  const rows = raw.filter((r) => !r.cells.every(blank));
  // The first non-blank row is a header only when its date cell is not a date and its value cell is not a number:
  // "2026/01/30,4.30" is a refused row, not a header.
  const head = rows[0];
  if (head !== undefined) {
    const [d, v] = head.cells;
    const dateLike = head.dateSerial !== undefined || (typeof d === "string" && (DAY.test(d.trim()) || MONTH.test(d.trim())));
    const valueLike = typeof v === "number" || (typeof v === "string" && NUMBER.test(v.trim()));
    if (!dateLike && !valueLike) rows.shift();
  }

  // Row level: every refusal collected.
  const refusals: string[] = [];
  let first: { row: number; kind: "day" | "month" } | null = null;
  const seen = new Map<string, number>();
  /**
   * Per month: the latest dated row's value (null when none of its rows has one), how many dated rows it holds, and its
   * latest dated row, with or without a value.
   */
  const months = new Map<string, { key: string; value: number | null; rows: number; lastDated: string }>();
  let dated = 0;
  for (const { row, cells, dateSerial, percentShown } of rows) {
    let width = cells.length;
    while (width > 0 && blank(cells[width - 1])) width--;
    if (width > 2) { refusals.push(`row ${row}: expected two columns, date and value; got ${width}`); continue; }
    const date = readDate(row, cells[0], dateSerial);
    if ("refusal" in date) { refusals.push(date.refusal); continue; }
    if (first === null) first = { row, kind: date.kind };
    else if (date.kind !== first.kind) {
      const other = first.kind === "day" ? "a day" : "a month";
      refusals.push(`row ${row}: date ${show(date.key)} is ${date.kind === "day" ? "a day" : "a month"} but row ${first.row} is ${other}; a file holds daily rows or monthly rows, not both`);
      continue;
    }
    const earlier = seen.get(date.key);
    if (earlier !== undefined) { refusals.push(`rows ${earlier} and ${row} both carry ${date.key}`); continue; }
    seen.set(date.key, row);
    const read = readValue(row, cells[1]);
    if ("refusal" in read) { refusals.push(read.refusal); continue; }
    if (read.value !== null && unit === "percent" && percentShown !== undefined) {
      refusals.push(`row ${row}: the value cell is formatted as a percentage, so the workbook stores ${read.value} for ${percentShown}; import it with the unit decimal`);
      continue;
    }
    let value: number | null = null;
    if (read.value !== null) {
      const converted = convert(row, read.value, unit);
      if ("refusal" in converted) { refusals.push(converted.refusal); continue; }
      value = converted.value;
    }
    dated++;
    const m = months.get(date.month) ?? { key: "", value: null, rows: 0, lastDated: "" };
    m.rows++;
    if (date.key > m.lastDated) m.lastDated = date.key;
    // The latest dated row with a value wins; rows need not arrive in date order.
    if (value !== null && date.key > m.key) { m.key = date.key; m.value = value; }
    months.set(date.month, m);
  }
  if (refusals.length > MAX_ROW_REFUSALS_NAMED) {
    return refuse([...refusals.slice(0, MAX_ROW_REFUSALS_NAMED), `and ${refusals.length - MAX_ROW_REFUSALS_NAMED} more rows refused`]);
  }
  if (refusals.length > 0) return refuse(refusals);
  if (dated === 0) return refuse(["the file holds no dated rows; expected two columns, date and value"]);

  // Series level.
  const filled = [...months].filter(([, m]) => m.value !== null).map(([month]) => month).sort();
  if (filled.length === 0) return refuse(['the file holds no values; every dated row is empty or "."']);
  const firstMonth = filled[0]!;
  const span = monthIndex(filled.at(-1)!) - monthIndex(firstMonth) + 1;
  const values: number[] = [];
  const empty: string[] = [];
  for (let k = 0; k < span; k++) {
    const month = monthAdd(firstMonth, k);
    const v = months.get(month)?.value ?? null;
    if (v === null) empty.push(month);
    else values.push(v);
  }
  if (empty.length > 0) {
    const named = empty.slice(0, MAX_EMPTY_MONTHS_NAMED).map((m) => `the series has no value in ${m}; a month inside the series must hold at least one value`);
    if (empty.length > MAX_EMPTY_MONTHS_NAMED) named.push(`and ${empty.length - MAX_EMPTY_MONTHS_NAMED} more months have no value`);
    return refuse(named);
  }
  if (span > MAX_INDEX_HISTORY_MONTHS) return refuse([`the series covers ${span} months after conversion; an index history holds at most 1,200`]);

  const frequency = [...months.values()].every((m) => m.rows === 1) ? "monthly" : "daily";
  const history: IndexHistory = {
    label,
    firstMonth,
    values,
    source: { fileName, fileSha256: createHash("sha256").update(bytes).digest("hex"), format, frequency, rows: dated, unit },
  };
  // A guard: a document built by the rules above always passes; the validator stays the one authority.
  const problems = validateIndexHistory(history);
  if (problems.length > 0) return refuse(problems);
  const lastMonth = filled.at(-1)!;
  const lastDay = months.get(lastMonth)!.lastDated;
  if (frequency === "daily" && lastDay < lastWeekdayOf(lastMonth)) return { ok: true, history, partialLastMonth: { month: lastMonth, lastDay } };
  return { ok: true, history };
}
