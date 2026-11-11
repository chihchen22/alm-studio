/**
 * Balance Sheet > Positions: import into the workspace (spec v3.1 Section 3.6 step 4). Pure functions over the head.
 * The as-of the CSV import requires is the workspace's cut-off date: read-only on a Production workspace, editable
 * with the cut-off preselected on every other type. The file is stored by the import route; the block write that
 * follows names it, and the server applies the clash rule there.
 */
import { ApiError, type SetBlockBody, type WorkspaceManifest } from "@alm/reader";
import { pageErrText, reasonOf } from "../errText";

export interface ImportFormModel {
  asOf: string;
  asOfReadOnly: boolean;
  /** The chart the workspace already names; null when it names none, and the form asks for one. */
  coaId: string | null;
  /** A proposed book id: the workspace id and "positions". */
  portfolioId: string;
}

export function importFormModel(head: WorkspaceManifest): ImportFormModel {
  return {
    asOf: head.cutoffDate,
    asOfReadOnly: head.type === "production",
    coaId: head.blocks.positions.coa?.id ?? null,
    portfolioId: `${head.id}-positions`,
  };
}

/** The positions block write that follows the file import, at the head revision the page read. */
export function importSetBody(head: WorkspaceManifest, bookId: string, by: string): SetBlockBody {
  return { expectedRevision: head.revision, by, block: "positions", op: "set", ref: { collection: "portfolios", id: bookId } };
}

/** The file format a name suggests: .json is a PortfolioSpec, anything else is read as CSV. */
export function formatOfFile(name: string): "csv" | "json" {
  return name.toLowerCase().endsWith(".json") ? "json" : "csv";
}

/** How many row errors the form lists before it says how many more there are. */
export const MAX_LISTED = 10;

/** What the form prints after an import: a headline, the listed row errors, and how many were left out. */
export interface ImportNote {
  text: string;
  items: string[];
  more: number;
}

/** One stored chart of accounts as the form's pick shows it. */
export interface CoaOption {
  id: string;
  label: string;
}

/** A note with a headline only: a success, or a failure that carries no per-row detail. */
export function importNote(text: string): ImportNote {
  return { text, items: [], more: 0 };
}

/** One row error as a line: `row N, <positionId>, <column>: <message>`, leaving out the parts the server did not send. */
function itemLine(x: unknown): string {
  if (typeof x === "string") return x;
  if (typeof x === "object" && x !== null && typeof (x as { message?: unknown }).message === "string") {
    const it = x as { row?: unknown; column?: unknown; positionId?: unknown; message: string };
    const where: string[] = [];
    if (typeof it.row === "number") where.push(`row ${it.row}`);
    if (typeof it.positionId === "string" && it.positionId !== "") where.push(it.positionId);
    if (typeof it.column === "string" && it.column !== "") where.push(it.column);
    return where.length === 0 ? it.message : `${where.join(", ")}: ${it.message}`;
  }
  return JSON.stringify(x);
}

/**
 * A failed import as a note. A refusal with a list of rows heads with the server's reason alone (the list under it
 * is what the reader needs); each per-row error becomes one line, at most MAX_LISTED of them, then a count of the rest.
 * A server failure (500 or above) or a conflict (409) with no list keeps its status in the headline, as a page's own
 * error line does, so the person can say which failure it was.
 */
export function refusalNote(e: unknown): ImportNote {
  const all = e instanceof ApiError && Array.isArray(e.detail) ? e.detail.map(itemLine) : [];
  const keepStatus = e instanceof ApiError && !Array.isArray(e.detail) && (e.status >= 500 || e.status === 409);
  return { text: keepStatus ? pageErrText(e) : reasonOf(e), items: all.slice(0, MAX_LISTED), more: Math.max(0, all.length - MAX_LISTED) };
}

/**
 * The chart the CSV import names: what was picked or typed, else the workspace's own chart when the stored list holds
 * it, else the first stored chart. With no stored list it is the workspace's chart as it stands, or empty.
 */
export function coaChoice(typed: string | undefined, current: string | null, coas: readonly CoaOption[]): string {
  if (typed !== undefined) return typed;
  if (coas.length === 0) return current ?? "";
  if (current !== null && coas.some((c) => c.id === current)) return current;
  return coas[0]!.id;
}

/**
 * Why the import button is off, in words; null when it can be pressed, or while an import is already running. The
 * stored charts are read first, because the CSV import names one: until they are read the button says so.
 */
export function importBlock(s: { file: string | null; by: string; busy: boolean; coasLoading?: boolean }): string | null {
  if (s.busy) return null;
  if (s.coasLoading === true) return "Reading the charts of accounts.";
  const noFile = s.file === null;
  const noName = s.by.trim() === "";
  if (noFile && noName) return "Choose a file and enter a name.";
  if (noFile) return "Choose a file.";
  if (noName) return "Enter a name.";
  return null;
}
