// packages/reader/src/workbookDate.ts
/**
 * The date a market workbook is stamped with, read from its filename (Studio Part 2 P3). Pure; no kernel import, since
 * the kernel pulls in the spreadsheet library.
 *
 * Two rules exist on the server side and they differ. The kernel stamps a `_YYYYMMDD` suffix directly before the
 * extension. The import route is looser: it finds `_YYYYMMDD` anywhere in the name and hands that to the kernel as its
 * fallback date, so a name such as `x_20260331_v2.xlsx` is still stamped 2026-03-31 unless an as-of date is sent,
 * which would replace it.
 */

/** The kernel's rule (importWorkbook.ts): the suffix directly before the extension, case-insensitive. */
const KERNEL_SUFFIX = /_(\d{4})(\d{2})(\d{2})\.[a-z]+$/i;
/** The route's rule: the same digits anywhere in the name. */
const ANYWHERE = /_(\d{4})(\d{2})(\d{2})/;

function iso(m: RegExpExecArray | null): string | null {
  if (m === null) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** The date the kernel stamps from the filename (YYYY-MM-DD), or null when the name has no such suffix. */
export function workbookDateFromName(name: string): string | null {
  return iso(KERNEL_SUFFIX.exec(name));
}

/** What a filename says about the date a snapshot will carry. */
export type WorkbookStamp =
  | { kind: "date"; date: string }
  | { kind: "none" }
  /** The kernel would stamp a suffix the calendar refuses (a month of 13); `raw` is that date as it would be written. */
  | { kind: "bad"; raw: string };

/**
 * What the server will do with the filename. The kernel's suffix wins whenever it matches, with no calendar check, so
 * it is read first: a good one is a date, a bad one is a problem that no as-of text can override. Only when the suffix
 * is absent does the route's own detection anywhere in the name apply; a bad date there is "none", since the route
 * then takes the as-of text.
 */
export function workbookStamp(name: string): WorkbookStamp {
  const suffix = KERNEL_SUFFIX.exec(name);
  if (suffix !== null) {
    const date = iso(suffix);
    return date !== null ? { kind: "date", date } : { kind: "bad", raw: `${suffix[1]}-${suffix[2]}-${suffix[3]}` };
  }
  const date = iso(ANYWHERE.exec(name));
  return date !== null ? { kind: "date", date } : { kind: "none" };
}

/**
 * The date the import route would stamp from the filename alone: the kernel's suffix first, then the route's own
 * detection anywhere in the name. Null means no usable date was found (none, or an impossible one; see
 * `workbookStamp` to tell them apart).
 */
export function stampDateFromName(name: string): string | null {
  const stamp = workbookStamp(name);
  return stamp.kind === "date" ? stamp.date : null;
}
