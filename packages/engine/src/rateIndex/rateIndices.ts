/**
 * The rateIndices block: its limits, its validator and its table (ALM Studio
 * Piece 7a).
 *
 * The block is an additive, engine-only list on the market. validateRateIndices
 * is the one authority on its shape; the derivation applies it to the base and
 * to the derived block, and the run entry applies it before resolving a name.
 * Every problem is collected, none thrown. Rates are decimals, so the basis
 * bound is 0.1 (1000 bp either way): it catches a unit slip such as 300 typed
 * for 300 bp while admitting a 300 bp prime-style basis.
 *
 * Three kinds. A record without `kind` is a compounded window, and
 * its checks and sentences are those written before B3a. A constant-maturity
 * swap carries tenorYears from SWAP_TENORS_YEARS. A formula names a parent
 * index of the same block and carries exactly one of coefficient (a level,
 * nonzero, at most MAX_ABS_COEFFICIENT either way) or beta (a change, 0 to
 * MAX_BETA); a beta formula needs start, its fixing at the cut-off. start,
 * floor and cap are decimal rates from MIN_RATE_LEVEL to MAX_RATE_LEVEL,
 * lagMonths is 1 to MAX_LAG_MONTHS whole months, floor is not above cap, and a
 * beta formula's start lies between them. A formula names no spreadCurve. The
 * allowed keys of each kind are RATE_INDEX_KEYS of rateIndex/record.ts, the one
 * builder of a stored record. Chains (v3 Section 5 rule 2): a parent must be an
 * index the block carries and not the formula itself; a loop of parents is
 * refused once, named from its smallest id; a chain is at most MAX_CHAIN_DEPTH
 * formula levels, and the first index one level past it is refused, naming
 * the chain.
 *
 * Any kind may carry historyId, an index history id (ih- and 16 lowercase hex); whether the
 * store holds that history is the server's check, not the block's.
 */
import type { DerivationProblem } from "../contracts/derivation";
// From the contracts module only, never from derivedCurve/validate.ts (R1): the contracts module has no runtime imports, so no cycle can form.
import { DERIVED_CURVE_ID_PATTERN, MAX_DERIVED_CURVES } from "../contracts/derivedCurve";
import type { RateIndex, RateIndexKind, RateIndexTable } from "../contracts/rateIndex";
// record.ts has type imports only, so this import forms no cycle.
import { RATE_INDEX_KEYS } from "./record";
// history.ts imports record.ts and macroFactors.ts only, so this import forms no cycle.
import { isIndexHistoryId } from "../indexHistory/history";

/** Lowercase letters, digits and single hyphens, starting with a letter. */
export const RATE_INDEX_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const RATE_INDEX_ID_MAX_LENGTH = 40;
export const RATE_INDEX_LABEL_MAX_LENGTH = 120;
export const RATE_INDEX_TENORS: readonly number[] = [1, 3, 6, 12];
/** The most indices a market carries. The derived curves they name are capped apart, at MAX_DERIVED_CURVES (decision 44). */
export const MAX_RATE_INDICES = 50;
/** The largest basis magnitude, as a decimal. */
export const MAX_ABS_BASIS = 0.1;
/** The three kinds; a record without kind is a compounded window. */
export const RATE_INDEX_KINDS: readonly RateIndexKind[] = ["compounded-window", "constant-maturity-swap", "formula"];
/** Swap tenors in years (decision 36). */
export const SWAP_TENORS_YEARS: readonly number[] = [1, 2, 3, 5, 7, 10, 20, 30];
/** Formula bounds that catch a unit slip, as MAX_ABS_BASIS does: 80 typed for 0.8, or 4.5 typed for a 4.5 percent rate. */
export const MAX_ABS_COEFFICIENT = 3;
export const MAX_BETA = 2;
export const MIN_RATE_LEVEL = -0.05;
export const MAX_RATE_LEVEL = 0.25;
export const MAX_LAG_MONTHS = 12;
/** Formula levels on one chain (v3 decision 21). */
export const MAX_CHAIN_DEPTH = 5;
export const FORMULA_SPREAD_CURVE_SENTENCE = "a formula index reads its parent's full rate and names no derived curve; name the curve on the parent";

/**
 * What each kind carries, closing the unknown-field sentence. The compounded-window text keeps its pre-B3a words
 * ("a rate index carries ...", pinned byte for byte) and is said only of a compounded window: a record without
 * kind, or one naming compounded-window, which the stored record leaves out.
 */
const CARRIES: Readonly<Record<RateIndexKind, string>> = {
  "compounded-window": "a rate index carries id, label, tenorMonths, basis and optionally spreadCurve and historyId",
  "constant-maturity-swap": "a constant-maturity-swap index carries id, label, kind, tenorYears, basis and optionally spreadCurve and historyId",
  formula: "a formula index carries id, label, kind, parent, coefficient or beta, start (beta only), basis and optionally lagMonths, floor, cap and historyId",
};
const LEVEL_TEXT = `expected a finite decimal rate from ${MIN_RATE_LEVEL} to ${MAX_RATE_LEVEL} (-500 bp to 2500 bp)`;
const isLevel = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= MIN_RATE_LEVEL && v <= MAX_RATE_LEVEL;

const show = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v) : String(v));

/** Whether an id is a valid rate index id (pattern and length). */
export function isRateIndexId(v: unknown): v is string {
  return typeof v === "string" && v.length <= RATE_INDEX_ID_MAX_LENGTH && RATE_INDEX_ID_PATTERN.test(v);
}

/**
 * Check a rateIndices block. `at` names it in every message ("rateIndices" by
 * default). Returns every problem; an empty list means the block is readable.
 */
export function validateRateIndices(block: unknown, at = "rateIndices"): DerivationProblem[] {
  const out: DerivationProblem[] = [];
  const add = (path: string, message: string): void => void out.push({ at: path, message: `${path}: ${message}` });
  if (!Array.isArray(block)) {
    add(at, "expected a list of rate indices");
    return out;
  }
  if (block.length > MAX_RATE_INDICES) add(at, `at most ${MAX_RATE_INDICES} indices; got ${block.length}`);
  const seen = new Set<string>();
  const dups: string[] = [];
  const curves = new Set<string>();
  /** Readable ids, first occurrence, with a known kind: the parents a formula may name. */
  const carried = new Set<string>();
  /** Formulas with a readable parent id that is not their own. */
  const formulas: { i: number; id: string; parent: string }[] = [];
  block.forEach((entry: unknown, i) => {
    const path = `${at}[${i}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      add(path, "expected a rate index with id, label, tenorMonths and basis");
      return;
    }
    const e = entry as Record<string, unknown>;
    const kindRaw = e.kind === undefined ? "compounded-window" : e.kind;
    const kind = typeof kindRaw === "string" && (RATE_INDEX_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as RateIndexKind) : undefined;
    if (kind === undefined) {
      add(`${path}.kind`, `expected compounded-window, constant-maturity-swap or formula; got ${show(e.kind)}`);
    } else {
      for (const k of Object.keys(e)) {
        if (kind === "formula" && k === "spreadCurve") add(`${path}.spreadCurve`, FORMULA_SPREAD_CURVE_SENTENCE);
        else if (!RATE_INDEX_KEYS[kind].includes(k)) add(path, `unknown field ${JSON.stringify(k)}; ${CARRIES[kind]}`);
      }
    }
    if (!isRateIndexId(e.id)) {
      add(
        `${path}.id`,
        `expected a lowercase id of letters, digits and single hyphens, starting with a letter, at most ${RATE_INDEX_ID_MAX_LENGTH} characters; got ${show(e.id)}`,
      );
    } else if (seen.has(e.id)) {
      if (!dups.includes(e.id)) dups.push(e.id);
    } else {
      seen.add(e.id);
      if (kind !== undefined) carried.add(e.id);
    }
    const label = typeof e.label === "string" ? e.label.trim() : "";
    if (label.length === 0 || label.length > RATE_INDEX_LABEL_MAX_LENGTH) {
      add(`${path}.label`, `expected a non-empty label of at most ${RATE_INDEX_LABEL_MAX_LENGTH} characters`);
    }
    if (kind === "compounded-window" && (typeof e.tenorMonths !== "number" || !RATE_INDEX_TENORS.includes(e.tenorMonths))) {
      add(`${path}.tenorMonths`, `expected 1, 3, 6 or 12 months; got ${show(e.tenorMonths)}`);
    }
    if (kind === "constant-maturity-swap" && (typeof e.tenorYears !== "number" || !SWAP_TENORS_YEARS.includes(e.tenorYears))) {
      add(`${path}.tenorYears`, `expected 1, 2, 3, 5, 7, 10, 20 or 30 years; got ${show(e.tenorYears)}`);
    }
    if (kind === "formula") {
      checkFormula(e, path, add);
      if (isRateIndexId(e.id) && isRateIndexId(e.parent) && e.parent !== e.id) formulas.push({ i, id: e.id, parent: e.parent });
    }
    if (typeof e.basis !== "number" || !Number.isFinite(e.basis) || Math.abs(e.basis) > MAX_ABS_BASIS) {
      add(`${path}.basis`, `expected a finite decimal between -${MAX_ABS_BASIS} and ${MAX_ABS_BASIS} (1000 bp either way); got ${show(e.basis)}`);
    }
    if (e.historyId !== undefined && !isIndexHistoryId(e.historyId)) add(`${path}.historyId`, `expected an index history id, ih- and 16 lowercase hex characters; got ${show(e.historyId)}`);
    if (kind !== "formula") {
      // An optional derived curve id. Whether the market carries that curve is the run's check, not the block's.
      if (e.spreadCurve !== undefined && (typeof e.spreadCurve !== "string" || !DERIVED_CURVE_ID_PATTERN.test(e.spreadCurve))) {
        add(`${path}.spreadCurve`, `expected a derived curve id of 1 to 70 characters from A-Z a-z 0-9 . _ -; got ${show(e.spreadCurve)}`);
      }
      if (typeof e.spreadCurve === "string") curves.add(e.spreadCurve);
    }
  });
  for (const id of dups) add(at, `index id ${JSON.stringify(id)} appears more than once`);
  if (curves.size > MAX_DERIVED_CURVES) add(at, `the indices name ${curves.size} derived curves; a market carries at most ${MAX_DERIVED_CURVES}`);
  const parentOf = new Map<string, string>();
  for (const f of formulas) {
    if (!carried.has(f.parent)) add(`${at}[${f.i}].parent`, `names rate index ${JSON.stringify(f.parent)}, which this market does not carry`);
    else if (!parentOf.has(f.id)) parentOf.set(f.id, f.parent);
  }
  checkChains(parentOf, at, add);
  return out;
}

/** The fields of one formula entry (decisions 37 to 40). */
function checkFormula(e: Record<string, unknown>, path: string, add: (path: string, message: string) => void): void {
  if (!isRateIndexId(e.parent)) add(`${path}.parent`, `expected the id of another rate index on this market; got ${show(e.parent)}`);
  else if (e.parent === e.id) add(`${path}.parent`, "an index cannot be its own parent");
  const hasC = e.coefficient !== undefined;
  const hasB = e.beta !== undefined;
  const start = e.start;
  if (hasC && hasB) {
    add(path, "a formula index carries coefficient (level) or beta (change), not both");
  } else if (!hasC && !hasB) {
    add(path, "a formula index needs coefficient (level) or beta (change)");
  } else if (hasC) {
    const c = e.coefficient;
    if (typeof c !== "number" || !Number.isFinite(c) || c === 0 || Math.abs(c) > MAX_ABS_COEFFICIENT) {
      add(`${path}.coefficient`, `expected a finite multiplier of the parent's level from -${MAX_ABS_COEFFICIENT} to ${MAX_ABS_COEFFICIENT}, not 0; got ${show(c)}`);
    }
    if (start !== undefined) add(`${path}.start`, "a start value applies to a beta index only");
  } else {
    const b = e.beta;
    if (typeof b !== "number" || !Number.isFinite(b) || b < 0 || b > MAX_BETA) add(`${path}.beta`, `expected a finite share of the parent's change from 0 to ${MAX_BETA}; got ${show(b)}`);
    if (start === undefined) add(`${path}.start`, "missing start value; a beta index starts from its fixing at the cut-off");
    else if (!isLevel(start)) add(`${path}.start`, `${LEVEL_TEXT}; got ${show(start)}`);
  }
  const lag = e.lagMonths;
  if (lag !== undefined && !(typeof lag === "number" && Number.isInteger(lag) && lag >= 1 && lag <= MAX_LAG_MONTHS)) {
    add(`${path}.lagMonths`, `expected a whole number of months from 1 to ${MAX_LAG_MONTHS} (leave it out for no lag); got ${show(lag)}`);
  }
  if (e.floor !== undefined && !isLevel(e.floor)) add(`${path}.floor`, `${LEVEL_TEXT}; got ${show(e.floor)}`);
  if (e.cap !== undefined && !isLevel(e.cap)) add(`${path}.cap`, `${LEVEL_TEXT}; got ${show(e.cap)}`);
  const floor = isLevel(e.floor) ? e.floor : undefined;
  const cap = isLevel(e.cap) ? e.cap : undefined;
  if (floor !== undefined && cap !== undefined && floor > cap) {
    add(path, `floor ${floor} is above cap ${cap}`);
  } else if (hasB && !hasC && isLevel(start)) {
    if (floor !== undefined && start < floor) add(`${path}.start`, `start value ${start} is below the floor ${floor}`);
    if (cap !== undefined && start > cap) add(`${path}.start`, `start value ${start} is above the cap ${cap}`);
  }
}

/** Loops and depth over the parent links of formulas whose parent the block carries (v3 Section 5 rule 2, decision 21). */
function checkChains(parentOf: ReadonlyMap<string, string>, at: string, add: (path: string, message: string) => void): void {
  const state = new Map<string, "on" | "done">();
  const onLoop = new Set<string>();
  for (const start of parentOf.keys()) {
    if (state.has(start)) continue;
    const trail: string[] = [];
    let cur: string | undefined = start;
    while (cur !== undefined && parentOf.has(cur) && !state.has(cur)) {
      state.set(cur, "on");
      trail.push(cur);
      cur = parentOf.get(cur);
    }
    if (cur !== undefined && state.get(cur) === "on") {
      const loop = trail.slice(trail.indexOf(cur));
      const first = loop.reduce((a, b) => (b < a ? b : a));
      const from = loop.indexOf(first);
      const named = [...loop.slice(from), ...loop.slice(0, from), first];
      add(at, `rate indices form a loop: ${named.join(" -> ")}; a formula's parent chain must end at a compounded-window or constant-maturity-swap index`);
      for (const id of loop) onLoop.add(id);
    }
    for (const id of trail) state.set(id, "done");
  }
  for (const id of parentOf.keys()) {
    const chain = [id];
    let cur = id;
    let looped = onLoop.has(id);
    while (!looped && parentOf.has(cur)) {
      cur = parentOf.get(cur)!;
      chain.push(cur);
      looped = onLoop.has(cur);
    }
    if (looped) continue;
    const depth = chain.length - 1;
    if (depth === MAX_CHAIN_DEPTH + 1) {
      add(at, `rate index ${JSON.stringify(id)} is ${depth} formula levels deep (${chain.join(" -> ")}); a chain is at most ${MAX_CHAIN_DEPTH} levels`);
    }
  }
}

/** The indices of a validated block, keyed by id. An absent block is an empty table. */
export function rateIndexTable(block: readonly RateIndex[] | undefined): RateIndexTable {
  const m = new Map<string, RateIndex>();
  for (const r of block ?? []) m.set(r.id, r);
  return m;
}
