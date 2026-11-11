// apps/studio/src/format/leaf.ts
/**
 * A stored leaf as a table cell prints it (ALM Studio Polish 4 T4; moved here from assumptions/stackModel.ts by
 * Polish 5 T1, so the Stack diff and By kind print one stored value one way). A JSON number is a figure: its text is
 * groupedText, and exact keeps String(v), the stored value to the digit, for the cell's title. Any other leaf is
 * text: a string or a boolean as String(v), a stored null as "none". Formatting only: no value is rounded or computed.
 * A cell with no stored leaf at all is an AbsentView, not a leaf (Polish 5 Task 6 fix I1).
 */

/** A stored JSON leaf: what an overlay holds at the end of a path, and what the engine's diff reports as from or to. */
export type LeafValue = number | string | boolean | null;

export type LeafView = { kind: "figure"; text: string; exact: string } | { kind: "text"; text: string };

/**
 * A value cell that holds no stored leaf, and the word it prints: By kind's Not bound and Not stored, the Stack diff's
 * Not stored on a side whose binding stores no leaf at the delta's path (Polish 5 Task 6 fix I1, Polish 6 T1). One
 * shape for both tables.
 */
export type AbsentView<T extends string = string> = { kind: "absent"; text: T };

/**
 * The absence word for a path a set stores no leaf at: By kind's set that binds the group but stores nothing there,
 * and a Stack diff side whose binding stores nothing at the delta's path (Polish 6 T1). One constant, so the two
 * tables say one fact one way.
 */
export const NOT_STORED = "Not stored";

/**
 * A number with its integer part grouped in threes, built from its own String() form so no digit is rounded or
 * added: 10000000 reads 10,000,000 and -2500000.5 reads -2,500,000.5. A number below 1000 in size, or one whose
 * String() form has an exponent (1e+21, 5e-7), prints as String() does. Formatting only.
 */
export function groupedText(v: number): string {
  const s = String(v);
  if (!Number.isFinite(v) || Math.abs(v) < 1000 || /e/i.test(s)) return s;
  const sign = s.startsWith("-") ? "-" : "";
  const dot = s.indexOf(".");
  const int = s.slice(sign.length, dot === -1 ? s.length : dot);
  const frac = dot === -1 ? "" : s.slice(dot);
  return `${sign}${int.replace(/\B(?=(\d{3})+$)/g, ",")}${frac}`;
}

export function leafView(v: LeafValue): LeafView {
  return typeof v === "number" ? { kind: "figure", text: groupedText(v), exact: String(v) } : { kind: "text", text: v === null ? "none" : String(v) };
}
