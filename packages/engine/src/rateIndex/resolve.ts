/**
 * Resolving the rate indices a run reads.
 *
 * A floating-loan position may name a rate index by `terms.rateIndexId`. The
 * run resolves every name against the market's `rateIndices` block ONCE, at the
 * run entry, and threads the resulting table through the stages. A name the
 * market does not carry is refused before any number is computed: a floater
 * never falls back to the one-month benchmark, because that would be a silent
 * wrong number for a position that said otherwise.
 *
 * An unindexed run never reads the block. checkRateIndexRefs and
 * resolveRunRateIndices return without touching `market.rateIndices` when no
 * position carries the key, so a market with a malformed block still runs a
 * book that names nothing.
 *
 * Two errors live here. RateIndexRefusedError is the run-entry refusal (compile,
 * run, stochastic, drill). RateIndexUnresolvedError is the factory's guard: any
 * call site that was not threaded fails loudly instead of computing a base-rate
 * number.
 *
 * Derived curves (steps B2 and B3a). The run reads a closure of
 * indices: each index a position names, then its parent chain (a formula reads
 * its parent, which may itself be a formula), each once. Any index in that
 * closure may name a derived curve by `spreadCurve`, a formula's parent
 * included. The spread is folded here, once: the table entry the run threads
 * carries `basis + spreadAt(curve, tenor)` and no `spreadCurve` (the tenor is
 * the window's months, or 12 x the swap tenor in years for a constant-maturity
 * swap; rateIndex/record.ts builds the entry; a formula names no curve and is
 * not folded), so a shard worker, a stochastic path or a key-rate leg that
 * reads the entry cannot fold it a second time, and IndexSeries refuses an
 * entry it evaluates that still names a curve. An index outside the closure
 * stays in the table with its spreadCurve and its unfolded basis, as in B2: no
 * run reads it. A curve the market lacks, a curve built on a base other than
 * the run's curve, a market whose curve setup carries the reserved id
 * platform-default, or a derivedCurves block the validator refuses, refuses the
 * run, naming the index in the closure that reads the curve; the index never
 * falls back to the base curve without its spread. When no index in the
 * closure names a curve, the derivedCurves block is not read and the table is
 * the one built before step B2.
 *
 * Formulas (steps B3a and B3b). Each formula in the closure carries
 * `parentAtCutoff` in the table the run threads: its parent's value at step 0
 * on the run's UNSHOCKED base curve, fixed here once, parents first. A lagged
 * formula whose parent carries an index history also carries
 * `parentBeforeCutoff`: the parent's history months before the cut-off (month
 * -1 first), the history's first value before its first month when that month
 * is before the cut-off, and the anchor after its last month or before a first
 * month at or after the cut-off, so no month reads a later fixing (spec v6
 * decision 52, ruling D3). The months before the
 * cut-off read them, so a scenario shock, a duration bump or a key-rate leg
 * reaches a beta or lagged index as a change (ruling 2026-10-13, which amends decision 40), and the history is the same on
 * every leg and path. A run that needs a history it was not given, or one that
 * does not hash to its id, is refused: a lag never reads a flat fill in place
 * of a history the market names. A formula outside the closure is left as
 * stored. A book whose closure holds no formula never builds the base curve
 * here, and its table is the one built before step B3a.
 */
import { DeterministicRatePath, type MarketSnapshot } from "@alm/kernel";
import type { MarketWithCurveSetup } from "../contracts/curveSetup";
import type { IndexHistoryEntry, IndexHistoryReading } from "../contracts/indexHistory";
import { PLATFORM_DEFAULT_CURVE, type DerivedCurveBlock, type MarketWithDerivedCurves } from "../contracts/derivedCurve";
import type {
  AnchoredFormulaIndex,
  CompoundedWindowIndex,
  ConstantMaturitySwapIndex,
  FormulaIndex,
  MarketWithIndices,
  RateIndex,
  RateIndexTable,
} from "../contracts/rateIndex";
import type { PortfolioSpec, Position, PositionTerms } from "../contracts/position";
import { runCurveIdOf } from "../derivedCurve/runCurve";
import { spreadAt } from "../derivedCurve/spreadAt";
import { validateDerivedCurves } from "../derivedCurve/validate";
import { historyLastMonth, historyValueAt, monthIndex, validateIndexHistory } from "../indexHistory/history";
import { indexHistoryIdOf } from "../indexHistory/id";
import { asOfMonthOf, monthAdd } from "../macro/macroFactors";
// rateEnvironment.ts imports nothing from rateIndex/, so this import forms no cycle.
import { buildBaseCurve } from "../scenario/rateEnvironment";
import { IndexSeries } from "./indexSeries";
import { rateIndexTable, validateRateIndices } from "./rateIndices";
import { foldedIndex, spreadTenorMonthsOf } from "./record";

/** The run entry refused: a position names an index the run cannot resolve. */
export class RateIndexRefusedError extends Error {
  /** The first offending position and the index it named, for the run log. */
  readonly positionId: string;
  readonly rateIndexId: string;
  constructor(message: string, positionId: string, rateIndexId: string) {
    super(message);
    this.name = "RateIndexRefusedError";
    this.positionId = positionId;
    this.rateIndexId = rateIndexId;
  }
}

/** The factory was asked for a floater whose index it was not given. */
export class RateIndexUnresolvedError extends Error {
  readonly terms: string;
  readonly rateIndexId: string;
  constructor(termsId: string, rateIndexId: string) {
    super(
      `makeInstrument: floating-loan "${termsId}" names rate index "${rateIndexId}", which this call was not given; ` +
        "a floater never falls back to the one-month benchmark",
    );
    this.name = "RateIndexUnresolvedError";
    this.terms = termsId;
    this.rateIndexId = rateIndexId;
  }
}

/** What a check found. `message` is set exactly when `problems` is non-empty. */
export interface RateIndexRefCheck {
  /** The table to thread, or undefined when no position names an index. */
  table: RateIndexTable | undefined;
  /** One text per problem, in position order (a malformed block is one text). */
  problems: string[];
  /** The full refusal text, absent when there is no problem. */
  message?: string;
  /** The first offending position and the id it carries, for the log. */
  first?: { positionId: string; rateIndexId: string };
}

const MAX_LISTED = 5;

const hasKey = (terms: PositionTerms): boolean =>
  Object.prototype.hasOwnProperty.call(terms, "rateIndexId") &&
  (terms as { rateIndexId?: unknown }).rateIndexId !== undefined;

/**
 * Check every position's rateIndexId against the market. Returns the table to
 * thread (undefined for an unindexed book, without reading the block) and every
 * problem. `marketName` is the market's id when the caller knows it; without it
 * the texts say "the run's market". In the table, every index of the read
 * closure is folded and every formula of it carries parentAtCutoff; a lagged
 * formula whose parent carries a history also carries parentBeforeCutoff, read
 * from `histories` (the documents the run was given, by id).
 */
export function checkRateIndexRefs(
  portfolio: PortfolioSpec,
  market: MarketSnapshot,
  marketName?: string,
  histories: readonly IndexHistoryEntry[] = [],
): RateIndexRefCheck {
  const { check, closure, via } = inspectRateIndexRefs(portfolio, market, marketName);
  if (check.table === undefined || check.message !== undefined) return check;
  const anchored = anchorFormulas(check.table, closure, market, marketName, histories);
  if ("problems" in anchored) {
    const texts = anchored.problems.map((p) => p.text);
    const listed = texts.slice(0, MAX_LISTED).join("; ");
    const rest = texts.length > MAX_LISTED ? `; and ${texts.length - MAX_LISTED} more` : "";
    const firstId = anchored.problems[0]!.indexId;
    return {
      table: undefined,
      problems: texts,
      message: `run refused: ${texts.length} rate index history problem(s), and a lag never reads a flat fill in place of a history the market names: ${listed}${rest}`,
      first: { positionId: via.get(firstId) ?? "", rateIndexId: firstId },
    };
  }
  return anchored.table === check.table ? check : { ...check, table: anchored.table };
}

/**
 * Fix each formula's parentAtCutoff: its parent's value at step 0 on the run's unshocked base curve, parents first.
 * The months before the cut-off read it, so a scenario shock, a duration bump or a key-rate leg reaches a beta or
 * lagged index as a change at month 0 or at month lag (ruling 2026-10-13, which amends
 * decision 40). A lagged formula whose parent carries a history also gets parentBeforeCutoff, its months -1 to -lag
 * from the given history. Builds the base curve only when the closure holds a formula; a curve
 * that cannot be built throws the builder's own sentence, as the run would.
 */
function anchorFormulas(
  table: RateIndexTable,
  closure: readonly string[],
  market: MarketSnapshot,
  marketName: string | undefined,
  histories: readonly IndexHistoryEntry[],
): { table: RateIndexTable } | { problems: { text: string; indexId: string }[] } {
  const formulas = closure.filter((id) => table.get(id)!.kind === "formula");
  if (formulas.length === 0) return { table };
  const depth = (id: string): number => {
    const e = table.get(id)!;
    return e.kind === "formula" ? 1 + depth(e.parent) : 0;
  };
  formulas.sort((a, b) => depth(a) - depth(b) || byText(a, b));
  const path = new DeterministicRatePath(buildBaseCurve(market), 12);
  const anchored = new Map<string, RateIndex>(table);
  const problems: { text: string; indexId: string }[] = [];
  for (const id of formulas) {
    const f = anchored.get(id) as FormulaIndex;
    // A fresh series per formula: the parent's entry, with its own parentBeforeCutoff set, is read as it stands now.
    const entry: AnchoredFormulaIndex = { ...f, parentAtCutoff: new IndexSeries(anchored, path).valueAt(f.parent, 0) };
    anchored.set(id, entry);
    const hid = anchored.get(f.parent)!.historyId;
    if (hid === undefined || (f.lagMonths ?? 0) < 1) continue;
    const shown = marketName !== undefined ? `market ${JSON.stringify(marketName)}` : "the run's market";
    const head = `rate index ${JSON.stringify(f.id)} lags on ${JSON.stringify(f.parent)}, which reads index history ${JSON.stringify(hid)}`;
    const given = histories.find((h) => h.id === hid);
    const asOf = asOfMonthOf(market as { calibrationDate?: unknown });
    if (given === undefined) {
      problems.push({ text: `${head}, and the run was not given that history`, indexId: f.id });
      continue;
    }
    if (asOf === null) {
      problems.push({ text: `${head}, but ${shown} carries no readable calibrationDate to date the months before the cut-off`, indexId: f.id });
      continue;
    }
    const bad = validateIndexHistory(given.history);
    if (bad.length > 0) {
      problems.push({ text: `index history ${JSON.stringify(hid)} given to the run is not readable: ${bad.join("; ")}`, indexId: f.id });
      continue;
    }
    const actual = indexHistoryIdOf(given.history);
    if (actual !== hid) {
      problems.push({
        text: `index history ${JSON.stringify(hid)} given to the run does not hash to its id (its content hashes to ${JSON.stringify(actual)})`,
        indexId: f.id,
      });
      continue;
    }
    // Ruling D3: a month before the history's first month reads its first value, but only when that value is dated
    // before the as-of month (no look-ahead: a history that starts at or after the cut-off fills nothing before it); a
    // month after its last month, or before a first month at or after the cut-off, reads the anchor (the decision 45
    // and 49 flat fill); a month inside reads the history.
    const firstIdx = monthIndex(given.history.firstMonth);
    const beforeFill = firstIdx < monthIndex(asOf) ? given.history.values[0]! : entry.parentAtCutoff;
    const pre = Array.from({ length: f.lagMonths! }, (_, k) => {
      const month = monthAdd(asOf, -(k + 1));
      return historyValueAt(given.history, month) ?? (monthIndex(month) < firstIdx ? beforeFill : entry.parentAtCutoff);
    });
    const withHistory: AnchoredFormulaIndex = { ...entry, parentBeforeCutoff: pre };
    anchored.set(f.id, withHistory);
  }
  return problems.length > 0 ? { problems } : { table: anchored };
}

/** The stored records of every index the run reads (each position's index, then its parents), or [] when none is read or the run is refused. */
export function indicesRead(portfolio: PortfolioSpec, market: MarketSnapshot): RateIndex[] {
  const { check, closure } = inspectRateIndexRefs(portfolio, market, undefined);
  if (check.message !== undefined || closure.length === 0) return [];
  const stored = rateIndexTable((market as MarketWithIndices).rateIndices);
  return closure.map((id) => stored.get(id)!);
}

/** One derived curve the run applies to one index a position reads. */
export interface DerivedCurveRead {
  indexId: string;
  curveId: string;
  /** The curve's label, for the compile note and readiness. */
  label: string;
}

/**
 * The derived curves the run applies: one entry per index of the read closure
 * (each position's index and its parents) whose spreadCurve names a curve,
 * sorted by curve id then index id. Empty when the run reads none, and when the
 * run is refused (a refused run applies nothing).
 */
export function derivedCurvesRead(portfolio: PortfolioSpec, market: MarketSnapshot): DerivedCurveRead[] {
  const { check, read } = inspectRateIndexRefs(portfolio, market, undefined);
  return check.message === undefined ? read : [];
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The index history ids a run reads: on the parent of each lagged formula of the read closure; sorted, distinct.
 * [] when none is read, or when the check refuses the run on anything other than a missing history.
 */
export function indexHistoryIdsRead(portfolio: PortfolioSpec, market: MarketSnapshot): string[] {
  const { check, closure } = inspectRateIndexRefs(portfolio, market, undefined);
  if (check.message !== undefined || check.table === undefined) return [];
  const ids = new Set<string>();
  for (const id of closure) {
    const e = check.table.get(id)!;
    if (e.kind !== "formula" || (e.lagMonths ?? 0) < 1) continue;
    const h = check.table.get(e.parent)?.historyId;
    if (h !== undefined) ids.add(h);
  }
  return [...ids].sort(byText);
}

/**
 * What the run reads from each history (decisions 49 and 52), for readiness and the results note: one entry per
 * history read, sorted by the index that carries it. [] when none is read or the run is refused.
 */
export function indexHistoryReadings(
  portfolio: PortfolioSpec,
  market: MarketSnapshot,
  histories: readonly IndexHistoryEntry[],
): IndexHistoryReading[] {
  const check = checkRateIndexRefs(portfolio, market, undefined, histories);
  const asOf = asOfMonthOf(market as { calibrationDate?: unknown });
  if (check.message !== undefined || check.table === undefined || asOf === null) return [];
  const byParent = new Map<string, { readers: string[]; maxLag: number; curveMonth0: number }>();
  for (const e of check.table.values()) {
    if (e.kind !== "formula" || (e as Partial<AnchoredFormulaIndex>).parentBeforeCutoff === undefined) continue;
    const a = e as AnchoredFormulaIndex;
    const g = byParent.get(a.parent) ?? { readers: [], maxLag: 0, curveMonth0: a.parentAtCutoff };
    g.readers.push(a.id);
    g.maxLag = Math.max(g.maxLag, a.lagMonths!);
    byParent.set(a.parent, g);
  }
  const out: IndexHistoryReading[] = [];
  for (const [indexId, g] of byParent) {
    const historyId = check.table.get(indexId)!.historyId!;
    const h = histories.find((x) => x.id === historyId)!.history;
    const last = historyLastMonth(h);
    let flatAfter = 0;
    let flatBefore = 0;
    // A month before a first month at or after the cut-off reads the anchor, so it counts as flat (no look-ahead).
    const startsBeforeCutoff = monthIndex(h.firstMonth) < monthIndex(asOf);
    for (let k = 1; k <= g.maxLag; k++) {
      const m = monthIndex(monthAdd(asOf, -k));
      if (m > monthIndex(last)) flatAfter++;
      else if (m < monthIndex(h.firstMonth)) {
        if (startsBeforeCutoff) flatBefore++;
        else flatAfter++;
      }
    }
    out.push({
      indexId,
      historyId,
      readBy: [...g.readers].sort(byText),
      firstMonth: h.firstMonth,
      lastMonth: last,
      asOfMonth: asOf,
      flatAfter,
      flatBefore,
      asOfValue: historyValueAt(h, asOf) ?? null,
      curveMonth0: g.curveMonth0,
    });
  }
  return out.sort((a, b) => byText(a.indexId, b.indexId));
}

interface DerivedFold {
  /** The table to thread: the input Map itself when no index read names a curve. */
  table: RateIndexTable;
  /** Per-index refusals, in the order positions first read each index. */
  problems: { text: string; positionId: string; rateIndexId: string }[];
  /** A derivedCurves block the validator refuses, as one text. */
  blockProblem?: { text: string; positionId: string; rateIndexId: string };
  read: DerivedCurveRead[];
  /** The read closure: each position's index, then its parent chain, each once, in first-reached order. */
  closure: string[];
  /** The first position that reaches each index of the closure. */
  via: Map<string, string>;
}

/** Every index the run reads: each position's index, then its parent chain, each once; and the first position that reaches each. */
function closureOf(carriers: readonly Position[], table: RateIndexTable): { ids: string[]; via: Map<string, string> } {
  const ids: string[] = [];
  const via = new Map<string, string>();
  for (const pos of carriers) {
    let id: string | undefined = (pos.terms as { rateIndexId?: string }).rateIndexId!;
    while (id !== undefined && !via.has(id)) {
      via.set(id, pos.id);
      ids.push(id);
      const e = table.get(id);
      id = e !== undefined && e.kind === "formula" ? e.parent : undefined;
    }
  }
  return { ids, via };
}

/**
 * Fold the derived curve spreads into the indices of the read closure.
 * `carriers` are floating-loan positions whose index the table carries.
 */
function foldDerivedCurves(carriers: readonly Position[], table: RateIndexTable, market: MarketSnapshot, shown: string): DerivedFold {
  // Each index of the closure once, at the first position that reaches it.
  const { ids: closure, via } = closureOf(carriers, table);
  const refs: { indexId: string; positionId: string; index: CompoundedWindowIndex | ConstantMaturitySwapIndex }[] = [];
  for (const indexId of closure) {
    const index = table.get(indexId)!;
    if (index.kind !== "formula" && index.spreadCurve !== undefined) refs.push({ indexId, positionId: via.get(indexId)!, index });
  }
  if (refs.length === 0) return { table, problems: [], read: [], closure, via };

  const raw = (market as MarketWithDerivedCurves).derivedCurves as unknown;
  const curves = new Map<string, DerivedCurveBlock>();
  if (raw !== undefined) {
    const bad = validateDerivedCurves(raw);
    if (bad.length > 0) {
      return {
        table,
        problems: [],
        blockProblem: {
          text: `${shown} carries a derivedCurves block the run cannot read: ${bad.join("; ")}`,
          positionId: refs[0]!.positionId,
          rateIndexId: refs[0]!.indexId,
        },
        read: [],
        closure,
        via,
      };
    }
    for (const c of raw as readonly DerivedCurveBlock[]) curves.set(c.id, c);
  }

  const runCurve = runCurveIdOf(market);
  // A curve setup carrying the reserved id cannot be told apart from the platform's own curve (I1).
  const reservedSetup = (market as MarketWithCurveSetup).curveSetup?.id === PLATFORM_DEFAULT_CURVE;
  const problems: DerivedFold["problems"] = [];
  const read: DerivedCurveRead[] = [];
  const folded = new Map(table);
  for (const { indexId, positionId, index } of refs) {
    const curveId = index.spreadCurve!;
    const curve = curves.get(curveId);
    const head = `rate index ${JSON.stringify(indexId)} reads derived curve ${JSON.stringify(curveId)}`;
    if (reservedSetup) {
      problems.push({
        text:
          `${head}, but ${shown} carries a curve setup named ${JSON.stringify(PLATFORM_DEFAULT_CURVE)}, ` +
          "an id reserved for the platform's own curve; rename the curve setup",
        positionId,
        rateIndexId: indexId,
      });
      continue;
    }
    if (curve === undefined) {
      problems.push({ text: `${head}, which ${shown} does not carry`, positionId, rateIndexId: indexId });
      continue;
    }
    if (curve.base !== runCurve) {
      problems.push({
        text: `${head}, built on ${JSON.stringify(curve.base)}, but the run's curve is ${JSON.stringify(runCurve)}`,
        positionId,
        rateIndexId: indexId,
      });
      continue;
    }
    // A fresh entry without spreadCurve: the folded basis is final, and nothing downstream folds again.
    folded.set(indexId, foldedIndex(index, index.basis + spreadAt(curve, spreadTenorMonthsOf(index))));
    read.push({ indexId, curveId, label: curve.label });
  }
  read.sort((a, b) => byText(a.curveId, b.curveId) || byText(a.indexId, b.indexId));
  return { table: folded, problems, read, closure, via };
}

/**
 * The check, the curves read, the read closure and the first position that reaches each index of it; `closure` is []
 * and `via` is empty for an unindexed book and on every refusal.
 */
function inspectRateIndexRefs(
  portfolio: PortfolioSpec,
  market: MarketSnapshot,
  marketName: string | undefined,
): { check: RateIndexRefCheck; read: DerivedCurveRead[]; closure: string[]; via: Map<string, string> } {
  const check = (c: RateIndexRefCheck, read: DerivedCurveRead[] = [], closure: string[] = [], via = new Map<string, string>()) => ({
    check: c,
    read,
    closure,
    via,
  });
  const carriers = portfolio.positions.filter((p) => hasKey(p.terms));
  if (carriers.length === 0) return check({ table: undefined, problems: [] });

  const shown = marketName !== undefined ? `market ${JSON.stringify(marketName)}` : "the run's market";
  const block = (market as { rateIndices?: unknown }).rateIndices;
  let table: RateIndexTable | undefined;
  let blockProblem: string | undefined;
  const readTable = (): RateIndexTable => {
    if (table !== undefined) return table;
    if (block === undefined) {
      table = rateIndexTable(undefined);
      return table;
    }
    const bad = validateRateIndices(block);
    if (bad.length > 0) {
      blockProblem = `${shown} carries a rateIndices block the run cannot read: ${bad.map((b) => b.message).join("; ")}`;
      table = rateIndexTable(undefined);
      return table;
    }
    table = rateIndexTable(block as RateIndex[]);
    return table;
  };

  const problems: string[] = [];
  let first: { positionId: string; rateIndexId: string } | undefined;
  const note = (positionId: string, id: unknown, text: string): void => {
    problems.push(text);
    first ??= { positionId, rateIndexId: typeof id === "string" ? id : JSON.stringify(id) };
  };
  for (const pos of carriers) {
    const terms = pos.terms as PositionTerms & { rateIndexId?: unknown };
    const id = terms.rateIndexId;
    const pid = JSON.stringify(pos.id);
    if (terms.type !== "floating-loan") {
      note(
        pos.id,
        id,
        `position ${pid} is a ${terms.type} and names rate index ${JSON.stringify(id)}; only floating-loan positions reset on a rate index`,
      );
      continue;
    }
    if (typeof id !== "string") {
      note(pos.id, id, `position ${pid} carries rateIndexId ${JSON.stringify(id)}; expected an index id string`);
      continue;
    }
    const t = readTable();
    if (blockProblem !== undefined) break;
    if (!t.has(id)) {
      const carried = [...t.keys()];
      note(
        pos.id,
        id,
        `position ${pid} names rate index ${JSON.stringify(id)}, which ${shown} does not carry (it carries ${
          carried.length === 0 ? "none" : carried.join(", ")
        })`,
      );
    }
  }

  if (blockProblem !== undefined) {
    const firstFloater = carriers.find((p) => p.terms.type === "floating-loan");
    const fid = (firstFloater?.terms as { rateIndexId?: unknown } | undefined)?.rateIndexId;
    return check({
      table: undefined,
      problems: [blockProblem],
      message: blockProblem,
      first: { positionId: firstFloater?.id ?? carriers[0]!.id, rateIndexId: typeof fid === "string" ? fid : "" },
    });
  }
  if (problems.length === 0) {
    // Every carrier is a floating loan whose index the table carries.
    const fold = foldDerivedCurves(carriers, readTable(), market, shown);
    if (fold.blockProblem !== undefined) {
      const { text, positionId, rateIndexId } = fold.blockProblem;
      return check({ table: undefined, problems: [text], message: text, first: { positionId, rateIndexId } });
    }
    if (fold.problems.length === 0) return check({ table: fold.table, problems }, fold.read, fold.closure, fold.via);
    const texts = fold.problems.map((p) => p.text);
    const listed = texts.slice(0, MAX_LISTED).join("; ");
    const rest = texts.length > MAX_LISTED ? `; and ${texts.length - MAX_LISTED} more` : "";
    return check({
      table: undefined,
      problems: texts,
      message:
        `run refused: ${texts.length} rate index(es) read a derived curve the run cannot apply, ` +
        `and an index never falls back to the base curve without its spread: ${listed}${rest}`,
      first: { positionId: fold.problems[0]!.positionId, rateIndexId: fold.problems[0]!.rateIndexId },
    });
  }

  const listed = problems.slice(0, MAX_LISTED).join("; ");
  const rest = problems.length > MAX_LISTED ? `; and ${problems.length - MAX_LISTED} more` : "";
  return check({
    table: undefined,
    problems,
    message:
      `run refused: ${problems.length} position(s) name a rate index the run cannot resolve, ` +
      `and a floater never falls back to the one-month benchmark: ${listed}${rest}`,
    first,
  });
}

/**
 * The table a run threads, resolved once at the run entry. Returns undefined
 * without reading the block when no position carries the key; otherwise
 * validates the block and every name, and throws RateIndexRefusedError.
 */
export function resolveRunRateIndices(
  portfolio: PortfolioSpec,
  market: MarketSnapshot,
  marketName?: string,
  histories: readonly IndexHistoryEntry[] = [],
): RateIndexTable | undefined {
  const check = checkRateIndexRefs(portfolio, market, marketName, histories);
  if (check.message !== undefined) {
    throw new RateIndexRefusedError(check.message, check.first!.positionId, check.first!.rateIndexId);
  }
  return check.table;
}

/** The terms without the engine-only rateIndexId, for a dry instantiation by the kernel. */
export function withoutRateIndex<T extends PositionTerms>(terms: T): T {
  if (!Object.prototype.hasOwnProperty.call(terms, "rateIndexId")) return terms;
  const { rateIndexId: _drop, ...rest } = terms as T & { rateIndexId?: unknown };
  void _drop;
  return rest as unknown as T;
}
