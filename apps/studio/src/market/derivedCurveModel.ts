// apps/studio/src/market/derivedCurveModel.ts
/**
 * Market > Derived curves: the pure model behind the screen. The editor holds the grid as
 * typed text; curveFromState turns it into the engine's DerivedCurveBlock, and the server judges the block (its
 * validator's sentences are printed as they stand). This file restates only what the screen needs to keep Save and
 * Fill off: a cell that does not read as a number, and the slot rule for the curve id.
 */
import type { DerivedCurveBlock } from "@alm/engine";
import type { DerivedCurveEstimate, DerivedCurveListRow } from "@alm/reader";

export const spreadSentence = "The spread is added to index resets only. Mortgages, client rates, new business and discounting read the base curve.";

/** The engine's PLATFORM_DEFAULT_CURVE, restated: the Studio imports only types from @alm/engine, never its runtime. */
export const PLATFORM_DEFAULT_CURVE = "platform-default";

export const PLATFORM_DEFAULT_TEXT = "Platform default curve";

/** A new derived curve: no spread on the platform default curve at 1, 3, 6 and 12 months. */
export function defaultDerivedCurve(): DerivedCurveBlock {
  return {
    id: "derived-1",
    label: "New derived curve",
    base: PLATFORM_DEFAULT_CURVE,
    spreads: [1, 3, 6, 12].map((tenorMonths) => ({ tenorMonths, spreadBp: 0 })),
  };
}

// ---------------------------------------------------------------------------
// Editor state

export interface SpreadRow {
  key: number;
  tenorText: string;
  spreadText: string;
}

export interface DerivedCurveSource {
  from: string;
  minus: string;
}

export interface DerivedCurveState {
  id: string;
  label: string;
  base: string;
  rows: SpreadRow[];
  /** The key the next added row takes. */
  nextKey: number;
  /** Moves on every grid change (a cell, an added or removed row, a fill), never on the id, label or base. */
  version: number;
  /** Set by the last fill and cleared by any grid change after it; the block carries it only while set. */
  source: DerivedCurveSource | null;
}

export type DerivedCurveFields = Partial<Pick<DerivedCurveState, "id" | "label" | "base">>;

/** A stored curve in the editor, rows keyed from 0; its source kept, since no cell has been edited since. */
export function stateFromCurve(c: DerivedCurveBlock): DerivedCurveState {
  return {
    id: c.id,
    label: c.label,
    base: c.base,
    rows: c.spreads.map((s, key) => ({ key, tenorText: String(s.tenorMonths), spreadText: String(s.spreadBp) })),
    nextKey: c.spreads.length,
    version: 0,
    source: c.source === undefined ? null : { from: c.source.from, minus: c.source.minus },
  };
}

export function defaultState(): DerivedCurveState {
  return stateFromCurve(defaultDerivedCurve());
}

/** A blank cell reads as no number, never as 0. */
const num = (t: string): number => (t.trim() === "" ? Number.NaN : Number(t.trim()));

/** The block the editor describes. Pure; `source` is left out unless the last fill set it and no cell changed since. */
export function curveFromState(s: DerivedCurveState): DerivedCurveBlock {
  const spreads = s.rows.map((r) => ({ tenorMonths: num(r.tenorText), spreadBp: num(r.spreadText) }));
  return s.source === null
    ? { id: s.id, label: s.label, base: s.base, spreads }
    : { id: s.id, label: s.label, base: s.base, spreads, source: { from: s.source.from, minus: s.source.minus } };
}

/** The id, label or base changed: not a grid change, so the version and the source stay. */
export function setFields(s: DerivedCurveState, patch: DerivedCurveFields): DerivedCurveState {
  return { ...s, ...patch };
}

const gridChange = (s: DerivedCurveState, rows: SpreadRow[], nextKey = s.nextKey): DerivedCurveState =>
  ({ ...s, rows, nextKey, version: s.version + 1, source: null });

export function setCell(s: DerivedCurveState, key: number, patch: Partial<Omit<SpreadRow, "key">>): DerivedCurveState {
  return gridChange(s, s.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
}

/** One blank row at the end. */
export function addRow(s: DerivedCurveState): DerivedCurveState {
  return gridChange(s, [...s.rows, { key: s.nextKey, tenorText: "", spreadText: "" }], s.nextKey + 1);
}

export function removeRow(s: DerivedCurveState, key: number): DerivedCurveState {
  return gridChange(s, s.rows.filter((r) => r.key !== key));
}

// ---------------------------------------------------------------------------
// Readings

const TENOR_TEXT = /^\d+$/;

/** Each cell that does not read, as the screen prints it: a tenor must be whole months, a spread a finite number. */
export function cellProblems(s: DerivedCurveState): string[] {
  return s.rows.flatMap((r, i) => [
    ...(TENOR_TEXT.test(r.tenorText.trim()) ? [] : [`Row ${i + 1}, tenor: type a whole number of months.`]),
    ...(Number.isFinite(num(r.spreadText)) ? [] : [`Row ${i + 1}, spread: type a number of basis points.`]),
  ]);
}

/** The grid's tenors, for a fill; null when there is no row or a tenor does not read. */
export function gridTenors(s: DerivedCurveState): number[] | null {
  if (s.rows.length === 0 || s.rows.some((r) => !TENOR_TEXT.test(r.tenorText.trim()))) return null;
  return s.rows.map((r) => Number(r.tenorText.trim()));
}

const CURVE_ID_PATTERN = /^[A-Za-z0-9._-]{1,70}$/;

/** Why the id cannot name a slot (the server's lineage rule, restated); null when it can. */
export function curveIdProblem(id: string): string | null {
  return CURVE_ID_PATTERN.test(id) ? null : "Name the curve: 1 to 70 letters, digits, dots, underscores or hyphens.";
}

export interface CurveOption {
  value: string;
  text: string;
}

/**
 * The base and fill menus: the platform default first, then each curve setup by label (its own id when blank), valued by
 * its own id. The active setup's text ends in " (active)", since a run reads that curve.
 */
export function baseOptions(setups: { id: string; label: string; active?: boolean }[]): CurveOption[] {
  return [
    { value: PLATFORM_DEFAULT_CURVE, text: PLATFORM_DEFAULT_TEXT },
    ...setups.map((s) => {
      const name = s.label.trim() === "" ? s.id : s.label;
      return { value: s.id, text: s.active === true ? `${name} (active)` : name };
    }),
  ];
}

/** The active curve setup's own id (setupId) from the list rows; null when none is active. */
export function activeSetupIdOf(rows: readonly { setupId: string; active: boolean }[]): string | null {
  return rows.find((r) => r.active)?.setupId ?? null;
}

/** A new derived curve on the run's curve: the active setup when one is active, else as defaultDerivedCurve(). */
export function defaultDerivedCurveFor(activeSetupId: string | null): DerivedCurveBlock {
  const d = defaultDerivedCurve();
  return activeSetupId === null ? d : { ...d, base: activeSetupId };
}

/** The editor for a new curve on the run's curve (defaultDerivedCurveFor). */
export function defaultStateFor(activeSetupId: string | null): DerivedCurveState {
  return stateFromCurve(defaultDerivedCurveFor(activeSetupId));
}

/** Why a fill cannot run on these two menus; null when it can. A curve minus itself fills zeros. */
export function fillProblem(from: string, minus: string): string | null {
  return from === minus ? "Pick two different curves: a curve minus itself is zero at every tenor." : null;
}

/**
 * Where a saved curve's spreads were estimated, as the list row reads it: the server's
 * effective estimatedOnDefault, never a value the editor holds or sends. Null for a curve that carries none (a typed
 * grid, or a fill from two setups).
 */
export function estimatedOnText(row: DerivedCurveListRow): string | null {
  return row.estimatedOnDefault === undefined ? null : `Spreads estimated on platform default v${row.estimatedOnDefault}`;
}

/**
 * A saved curve's list row as the block the editor opens (Edit). estimatedOnDefault is left out: the server owns it and
 * ignores a posted one, so an Edit then Save never sends it (B4 Task 7 fix round).
 */
export function curveOfListRow(row: DerivedCurveListRow): DerivedCurveBlock {
  return { id: row.curveId, label: row.label, base: row.base, spreads: row.spreads, ...(row.source === undefined ? {} : { source: row.source }) };
}

/** A menu value as the screen names it: its option text, or the value verbatim when no option holds it. */
export function optionText(options: readonly CurveOption[], value: string): string {
  return options.find((o) => o.value === value)?.text ?? value;
}

// ---------------------------------------------------------------------------
// The fill

export const FILL_RACE_SENTENCE = "The spreads grid changed while the spreads were estimated; nothing was replaced.";

/**
 * An estimate landing on the editor. `started` is the editor's version when the call began (ruling R10, as Curve
 * setups' snapshot fill): a grid changed since (a cell, an added or removed row, a load) is left alone and the screen
 * says so; the id, label and base do not move the version, so typing them while the estimate runs never cancels it. A
 * refused estimate leaves the grid and its refusals are printed one per line. An estimate whose tenors are not the
 * grid's (it cannot be, unless the grid moved) replaces nothing. `options` names the two menus in the result line as
 * the menus show them.
 */
export function fillOutcome(
  s: DerivedCurveState, started: number, reply: DerivedCurveEstimate, sent: DerivedCurveSource, options: readonly CurveOption[],
): { state: DerivedCurveState; lines: string[] } {
  if (s.version !== started) return { state: s, lines: [FILL_RACE_SENTENCE] };
  if (!reply.ok) return { state: s, lines: reply.refusals.length > 0 ? reply.refusals : ["The server refused the estimate and gave no reason."] };
  const tenors = gridTenors(s);
  if (tenors === null || tenors.length !== reply.spreads.length || reply.spreads.some((x, i) => x.tenorMonths !== tenors[i])) {
    return { state: s, lines: [FILL_RACE_SENTENCE] };
  }
  const rows = s.rows.map((r, i) => ({ ...r, spreadText: String(reply.spreads[i]!.spreadBp) }));
  const n = rows.length;
  return {
    state: { ...s, rows, version: s.version + 1, source: { from: sent.from, minus: sent.minus } },
    lines: [`Filled ${n} ${n === 1 ? "row" : "rows"}: ${optionText(options, sent.from)} minus ${optionText(options, sent.minus)}.`],
  };
}
