/**
 * The derived curve validator.
 *
 * validateDerivedCurve is the one authority on the shape of a derived curve
 * block. It takes an untyped value, collects every refusal (none thrown), and
 * builds the typed block only when there are none. Unknown fields, id, label,
 * base, source and the optional estimatedOnDefault stamp (1 or 2) are
 * judged first, then the spread grid; a grid with the
 * wrong row count is refused once and its rows are not judged one by one.
 * Rows are named 1-based in the order the caller sent them. Studio shows the
 * refusal sentences verbatim.
 *
 * validateDerivedCurves judges a market's derivedCurves list: a list, each
 * curve valid, ids unique, at most MAX_DERIVED_CURVES (12) curves. The cap is
 * its own constant, apart from the index cap (decision 44).
 */
import { DERIVED_CURVE_ID_PATTERN, MAX_DERIVED_CURVES, PLATFORM_DEFAULT_CURVE, type DerivedCurveBlock, type DerivedCurveSpread } from "../contracts/derivedCurve";

/** The most spread rows a derived curve carries. */
export const MAX_SPREAD_ROWS = 60;
/** The largest spread magnitude, in basis points. */
export const MAX_ABS_SPREAD_BP = 1000;
/** The longest spread tenor, in months. */
export const MAX_SPREAD_TENOR_MONTHS = 360;
/**
 * The longest derived curve label. The server holds the twin as NAME_MAX in
 * apps/server/src/workspaces/rules.ts (the engine does not import the server).
 */
export const DERIVED_CURVE_LABEL_MAX = 80;

const BLOCK_KEYS = ["id", "label", "base", "spreads", "source", "estimatedOnDefault"] as const;
const ROW_KEYS = ["tenorMonths", "spreadBp"] as const;
const SOURCE_KEYS = ["from", "minus"] as const;

export type DerivedCurveValidation = { ok: true; block: DerivedCurveBlock } | { ok: false; refusals: string[] };

/** Describe a value for a refusal without ever throwing. */
const show = (v: unknown): string => {
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "a list";
  if (v !== null && (typeof v === "object" || typeof v === "function")) return "an object";
  try {
    return String(v);
  } catch {
    return "an unreadable value";
  }
};
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
/** A curve setup id or platform-default: both follow the derived curve id pattern (R6). */
const isCurveId = (v: unknown): v is string => typeof v === "string" && DERIVED_CURVE_ID_PATTERN.test(v);

/** Check one derived curve. Returns the typed block, or every refusal in words. */
export function validateDerivedCurve(raw: unknown): DerivedCurveValidation {
  const refusals: string[] = [];
  const add = (message: string): void => void refusals.push(message);

  if (!isRecord(raw)) {
    add("a derived curve must be an object with id, label, base, spreads, an optional source and an optional estimatedOnDefault");
    return { ok: false, refusals };
  }

  for (const k of Object.keys(raw)) {
    if (!(BLOCK_KEYS as readonly string[]).includes(k)) {
      add(`unknown field ${JSON.stringify(k)}; a derived curve carries id, label, base, spreads, an optional source and an optional estimatedOnDefault`);
    }
  }
  if (typeof raw.id !== "string" || !DERIVED_CURVE_ID_PATTERN.test(raw.id)) {
    add(`the derived curve's "id" must be 1 to 70 characters from A-Z a-z 0-9 . _ -`);
  }
  // The label is judged and stored trimmed (M3).
  const label = typeof raw.label === "string" ? raw.label.trim() : undefined;
  if (label === undefined || label.length === 0 || label.length > DERIVED_CURVE_LABEL_MAX) {
    add(`the derived curve's "label" must be 1 to ${DERIVED_CURVE_LABEL_MAX} characters`);
  }
  if (!isCurveId(raw.base)) {
    add(`the derived curve's "base" must name a curve setup id or platform-default`);
  }

  // An absent source (or one written as undefined) is left out of the block.
  let source: { from: string; minus: string } | undefined;
  if (raw.source !== undefined) {
    const s = raw.source;
    if (!isRecord(s)) {
      add(`the derived curve's "source" must be an object with from and minus; got ${show(s)}`);
    } else {
      for (const k of Object.keys(s)) {
        if (!(SOURCE_KEYS as readonly string[]).includes(k)) {
          add(`unknown field ${JSON.stringify(k)} in the derived curve's source; a source carries from and minus`);
        }
      }
      for (const k of SOURCE_KEYS) {
        if (!isCurveId(s[k])) add(`the derived curve's source "${k}" must name a curve setup id or platform-default`);
      }
      if (isCurveId(s.from) && isCurveId(s.minus)) source = { from: s.from, minus: s.minus };
    }
  }

  // Optional, so a block stored before the field existed reads unchanged. An
  // absent stamp (or one written as undefined) is left out of the block.
  let estimatedOnDefault: 1 | 2 | undefined;
  if (raw.estimatedOnDefault !== undefined) {
    const v = raw.estimatedOnDefault;
    if (v === 1 || v === 2) {
      // Only a curve estimated on the platform default carries a stamp (the field is new, so no stored block is tightened).
      const onDefault = source !== undefined && (source.from === PLATFORM_DEFAULT_CURVE || source.minus === PLATFORM_DEFAULT_CURVE);
      if (onDefault) estimatedOnDefault = v;
      else if (raw.source === undefined || source !== undefined) {
        // A source refused above is named there; the stamp is judged against a readable source or none.
        add(`the derived curve's "estimatedOnDefault" belongs only to a curve whose source names platform-default; a typed grid or a source of two curve setups carries none`);
      }
    } else add(`the derived curve's "estimatedOnDefault" must be 1 or 2, the platform default curve version its spreads were estimated on; got ${show(v)}`);
  }

  const rows = raw.spreads;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_SPREAD_ROWS) {
    add(`a derived curve needs 1 to ${MAX_SPREAD_ROWS} spread rows`);
    return { ok: false, refusals };
  }

  const spreads: DerivedCurveSpread[] = [];
  /** The last row that stood in order: its 1-based number and tenor. */
  let prior: { n: number; tenor: number } | undefined;
  // An index loop, so a hole in a sparse list is judged as a row.
  for (let i = 0; i < rows.length; i++) {
    const n = i + 1;
    const row: unknown = rows[i];
    if (!isRecord(row)) {
      add(`row ${n} is not a row; expected tenorMonths and spreadBp`);
      continue;
    }
    for (const k of Object.keys(row)) {
      if (!(ROW_KEYS as readonly string[]).includes(k)) {
        add(`row ${n} unknown field ${JSON.stringify(k)}; a spread row carries tenorMonths and spreadBp`);
      }
    }
    const t = row.tenorMonths;
    const tenorOk = typeof t === "number" && Number.isInteger(t) && t >= 1 && t <= MAX_SPREAD_TENOR_MONTHS;
    if (!tenorOk) {
      add(`row ${n} tenor must be a whole number of months from 1 to ${MAX_SPREAD_TENOR_MONTHS}; got ${show(t)}`);
    } else if (prior !== undefined && t <= prior.tenor) {
      add(`row ${n} tenor ${t} months must be above row ${prior.n} (${prior.tenor} months)`);
    } else {
      prior = { n, tenor: t };
    }
    const s = row.spreadBp;
    const spreadOk = typeof s === "number" && Number.isFinite(s) && Math.abs(s) <= MAX_ABS_SPREAD_BP;
    if (!spreadOk) {
      add(`row ${n} spread must be a finite number of basis points from -${MAX_ABS_SPREAD_BP} to ${MAX_ABS_SPREAD_BP}; got ${show(s)}`);
    }
    if (tenorOk && spreadOk) spreads.push({ tenorMonths: t, spreadBp: s });
  }

  if (refusals.length > 0) return { ok: false, refusals };
  const block: DerivedCurveBlock = {
    id: raw.id as string,
    label: label as string,
    base: raw.base as string,
    spreads,
    ...(source === undefined ? {} : { source }),
    ...(estimatedOnDefault === undefined ? {} : { estimatedOnDefault }),
  };
  return { ok: true, block };
}

/**
 * Check a market's derivedCurves list. Returns every refusal in words; an
 * empty list means the block is readable. A per-curve refusal names the curve
 * by its id when the id is readable, else by its 1-based position.
 */
export function validateDerivedCurves(raw: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(raw)) return ["derivedCurves must be a list of derived curves"];
  if (raw.length > MAX_DERIVED_CURVES) {
    out.push(`a market carries at most ${MAX_DERIVED_CURVES} derived curves; got ${raw.length}`);
    return out;
  }
  const seen = new Set<string>();
  const dups: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    const id = isRecord(entry) && typeof entry.id === "string" && DERIVED_CURVE_ID_PATTERN.test(entry.id) ? entry.id : undefined;
    const name = id === undefined ? `derived curve ${i + 1}` : `derived curve ${JSON.stringify(id)}`;
    const r = validateDerivedCurve(entry);
    if (!r.ok) for (const sentence of r.refusals) out.push(`${name}: ${sentence}`);
    if (id !== undefined) {
      if (seen.has(id)) {
        if (!dups.includes(id)) dups.push(id);
      } else {
        seen.add(id);
      }
    }
  }
  for (const id of dups) out.push(`derived curve id ${JSON.stringify(id)} appears more than once`);
  return out;
}
