/**
 * deriveMarketSnapshot: a pure, explicit derivation of one market snapshot from
 * another. Six kinds of op, applied in order and composable: a funding spread
 * shock on the term liquidity premium (TLP) nodes, a
 * rate index op on the additive `rateIndices` block, a
 * short-rate volatility op on the `capQuotes` block, a
 * macro series op on the additive macro factors block, the curve
 * setup op on the additive `curveSetup` block, and the
 * derived curve op on the additive `derivedCurves` block.
 *
 * TLP ops. An op adds basis points to, or scales, every node except the one at
 * t = 0, or one node named by its tenor in years. The node at t = 0 stays pinned
 * at 0 and no op reaches it. add and scale results are rounded to 12 significant
 * digits, which removes float noise without losing real precision. Ops apply on
 * a deep clone. No op adds or removes a node, and every node other than t = 0
 * must end finite and greater than 0, the rule the workbook import applies
 * (packages/kernel/src/math/rates/importWorkbook.ts:148, "Non-positive Term LP").
 *
 * The run reads the TLP from tlpNodes only: tlpFromSnapshot builds the curve
 * from them (packages/engine/src/run/stages/curve.ts:13), and the TLP overlay
 * stage is wired at packages/engine/src/run/executor.ts:170. Nothing reads
 * termFundingCurveQuotes, and how those quotes relate to the TLP depends on how
 * the base was built, which a parsed snapshot does not record. A derivation
 * that moves the TLP therefore stores no term-funding quotes (an empty list)
 * rather than quotes that disagree with its TLP; the count dropped is
 * reported. A derivation with no TLP op leaves the TLP and the curve alone and
 * keeps the quotes as a deep copy of the base's.
 *
 * Rate index ops. set-index adds an index of any of the three kinds (a
 * compounded window, a constant-maturity swap or a formula on a parent, Piece
 * B) or replaces the one with the same id, whatever its kind; the
 * basis and a formula's startBp, floorBp and capBp are basis points, stored as
 * decimals. add-index-basis moves the basis of an index the market carries at
 * that point in the op order, a formula's spread included. Stage 1 checks the
 * fields of each set-index op by its kind; the normalized op names kind only
 * for the two B3a kinds and leaves out a lag of 0, so a compounded-window op,
 * with or without an explicit kind, hashes as before B3a. Ranges, parents,
 * loops and chain depth are validateRateIndices's, on the derived block.
 * set-index-history points an index the market carries at that point in the
 * op order at a stored index history by its id, or clears it with null; a
 * set-index that names no historyId keeps the one the index carries. The block is written sorted by id, each index in the key order of
 * rateIndex/record.ts (a compounded window as before B3a), so the derived
 * bytes are canonical; validateRateIndices checks the base block before the
 * ops apply and the derived block after. The rateIndices key is set only
 * when an index op ran. Every other block is copied as is.
 *
 * Macro series ops. set-macro-series adds a monthly macro series or
 * replaces the one with the same id; remove-macro-series removes a series the
 * market carries at that point in the op order. The block is written sorted by
 * id, each series in key order id, label, kind, role, unit, firstMonth, values,
 * source; validateMacroFactors checks the base block before the ops apply and
 * the derived block after, so one text set serves derive, seed and Studio. The
 * macroFactors key is set only when a macro op ran; with none, the block is
 * carried unchanged by the deep clone of the base.
 *
 * Curve setup op. set-curve-setup writes the curveSetup
 * block, which buildBaseCurve reads in place of the platform default curve
 * (and of the curveDefault: 1 kernel bootstrap, which the block wins over). The
 * setup is checked by validateCurveSetup, the one authority on its shape, and
 * stored as the validator returns it (a fresh copy, rows sorted by tenor), so
 * the normalized op, the derived id and the derived bytes do not depend on
 * the row order sent. A derivation takes one set-curve-setup op; a base block,
 * when it has one, must be readable before the op replaces it. The curveSetup
 * key is set only when the op ran; with none, the block (or its absence) is
 * carried unchanged by the deep clone of the base.
 *
 * Derived curve op. set-derived-curve adds a derived curve
 * to the additive derivedCurves block, or replaces the one with the same id;
 * the block is written sorted by id, each curve as validateDerivedCurve
 * returns it. A base block, when it has one, must be readable
 * (validateDerivedCurves). The derivedCurves key is set only when the op ran;
 * with none, the block (or its absence) is carried unchanged by the deep
 * clone of the base. A compounded-window or constant-maturity-swap set-index
 * takes an optional spreadCurve, a derived curve id, written on the index only
 * when sent; whether the market carries that curve is checked by the run, not
 * here. A formula set-index names none: it reads its parent's full rate.
 *
 * Short-rate volatility ops. scale-short-rate-vol multiplies, and
 * add-short-rate-vol adds basis points of normal vol to, every quote of an
 * expiry row (the at-the-money quote and every strike in it), at every expiry
 * or at one expiry that carries an at-the-money quote. The volatilities are the
 * public pack's constructed illustrative short-rate analog, not market quotes.
 * The run reads capQuotes only through the stochastic calibration (kernel
 * calibrateHW fits the Hull-White a and sigma to the at-the-money column, via
 * buildStochasticEnvironment) and the route's at-the-money check; no
 * deterministic result reads a volatility. The long-yield swaption grid has no
 * run reader and is copied unchanged. A derived value must be finite, greater
 * than 0 and below 0.05, the ceiling of the fitted sigma. Only capQuotes and
 * derivedFrom change in a vol-only derivation.
 *
 * The result is an ordinary market snapshot carrying an additive `derivedFrom`
 * record, appended as the last key. Every refusal is collected and thrown in
 * one MarketDerivationError, in stages: the op count and a readable base first
 * (thrown alone; the TLP node checks run only when some op is neither an index
 * op nor a volatility op, and the volatility checks only when some op is one),
 * then the shape and address of every op (thrown before anything applies), then
 * the derived values.
 *
 * Additive: the kernel is untouched, the run path is untouched, and no run path
 * imports this module.
 */
import type { MarketSnapshot } from "@alm/kernel";
import type { DerivationProblem } from "../contracts/derivation";
import type {
  DerivedMarketSnapshot,
  MarketDerivedFrom,
  MarketDeriveOp,
  MarketShockOp,
  MarketShockOpKind,
  ShortRateVolChange,
  ShortRateVolOp,
  TlpNodeChange,
} from "../contracts/marketDerivation";
import type {
  MarketWithIndices,
  RateIndex,
  RateIndexBasisOp,
  RateIndexChange,
  RateIndexHistoryOp,
  RateIndexKind,
  RateIndexSetOp,
  RateIndexTenor,
  SwapTenorYears,
} from "../contracts/rateIndex";
import type { MacroSeries, MacroSeriesChange, MacroSeriesRemoveOp, MacroSeriesSetOp, MarketWithMacro } from "../contracts/macroFactors";
import type { CurveSetupBlock, CurveSetupSetOp, MarketWithCurveSetup } from "../contracts/curveSetup";
import type { DerivedCurveBlock, DerivedCurveSetOp, MarketWithDerivedCurves } from "../contracts/derivedCurve";
import { validateCurveSetup } from "../curveBuilder/validate";
import { validateDerivedCurve, validateDerivedCurves } from "../derivedCurve/validate";
import { isIndexHistoryId } from "../indexHistory/history";
import { asOfMonthOf, validateMacroFactors } from "../macro/macroFactors";
import { FORMULA_SPREAD_CURVE_SENTENCE, RATE_INDEX_KINDS, validateRateIndices } from "../rateIndex/rateIndices";
import { indexFromSetOp, indexRecord, round12 } from "../rateIndex/record";
import { canonicalize, contentHash } from "../runtime/contentHash";
import { DEMONSTRATION_SUFFIX } from "../scenario/deriveAssumptionSet";
import { isShortRateVolOp, SHORT_RATE_VOL_CEILING, SHORT_RATE_VOL_SCALE_MAX, SHORT_RATE_VOL_SCALE_MIN } from "./shortRateVolOps";

export const MARKET_DERIVED_ID_PREFIX = "derived-mk-";
/** The most ops one market derivation takes (decision 44, v3 decision 19); assumption sets and balance plans keep MAX_DERIVATION_OPS (32). */
export const MAX_MARKET_DERIVATION_OPS = 64;

/** Tenors within this many years are the same node. */
const T_EPS = 1e-9;
const OP_KEYS: ReadonlySet<string> = new Set(["target", "op", "value"]);
const TARGET_KEYS: ReadonlySet<string> = new Set(["tYears"]);
const OP_KINDS: ReadonlySet<string> = new Set(["add", "scale"]);
const SET_INDEX_KEYS_BY_KIND: Readonly<Record<RateIndexKind, ReadonlySet<string>>> = {
  "compounded-window": new Set(["op", "id", "label", "kind", "tenorMonths", "basisBp", "spreadCurve", "historyId"]),
  "constant-maturity-swap": new Set(["op", "id", "label", "kind", "tenorYears", "basisBp", "spreadCurve", "historyId"]),
  formula: new Set(["op", "id", "label", "kind", "parent", "coefficient", "beta", "startBp", "lagMonths", "floorBp", "capBp", "basisBp", "historyId"]),
};
const SET_INDEX_CARRIES: Readonly<Record<RateIndexKind, string>> = {
  "compounded-window": "a set-index op carries op, id, label, tenorMonths, basisBp and optionally spreadCurve and historyId",
  "constant-maturity-swap": "a constant-maturity-swap set-index op carries op, id, label, kind, tenorYears, basisBp and optionally spreadCurve and historyId",
  formula: "a formula set-index op carries op, id, label, kind, parent, coefficient or beta, startBp, lagMonths, floorBp, capBp, basisBp and an optional historyId",
};
const BASIS_OP_KEYS: ReadonlySet<string> = new Set(["op", "indexId", "value"]);
const VOL_OP_KEYS: ReadonlySet<string> = new Set(["target", "op", "value"]);
const VOL_TARGET_KEYS: ReadonlySet<string> = new Set(["expiryYears"]);
const SET_MACRO_KEYS: ReadonlySet<string> = new Set(["op", "id", "label", "kind", "role", "unit", "firstMonth", "values", "source"]);
const REMOVE_MACRO_KEYS: ReadonlySet<string> = new Set(["op", "seriesId"]);
const SET_CURVE_SETUP_KEYS: ReadonlySet<string> = new Set(["op", "setup"]);
const SET_DERIVED_CURVE_KEYS: ReadonlySet<string> = new Set(["op", "curve"]);
const SET_INDEX_HISTORY_KEYS: ReadonlySet<string> = new Set(["op", "indexId", "historyId"]);
const HISTORY_ID_SENTENCE = "historyId must be an index history id (ih- and 16 lowercase hex characters)";

export interface MarketDeriveOptions {
  /** The id the base market is stored under; named in refusal texts and the default id and label. */
  baseId: string;
  /** The derived market's id; default is derivedMarketId(base id, base hash, ops). */
  id?: string;
  /** The derived market's label; always carries "demonstration values" or "illustrative". */
  label?: string;
}

export interface MarketDeriveResult {
  id: string;
  label: string;
  /** The derived market, carrying derivedFrom last. */
  snapshot: DerivedMarketSnapshot;
  /** One row per TLP node touched, in first-touch order. */
  changes: TlpNodeChange[];
  /** One row per rate index touched, in first-touch order; [] when no index op ran. */
  indexChanges: RateIndexChange[];
  /** How many term-funding quotes the base carried and the derived market does not (0 when no TLP op ran). */
  termFundingQuotesDropped: number;
  /** One row per short-rate volatility expiry row touched, in first-touch order; [] when no volatility op ran. */
  volChanges: ShortRateVolChange[];
  /** One row per macro series touched, in first-touch order; [] when no macro op ran. */
  macroChanges: MacroSeriesChange[];
}

/** Thrown when a derivation is refused; every problem found is listed. */
export class MarketDerivationError extends Error {
  readonly problems: DerivationProblem[];
  constructor(problems: DerivationProblem[]) {
    super(`derived market refused: ${problems.length} problem(s); every problem is listed: ${problems.map((p) => p.message).join("; ")}`);
    this.name = "MarketDerivationError";
    this.problems = problems;
  }
}

/** The default derived id: "derived-mk-" plus 12 hex of the hash of base id, base hash and normalized ops. */
export function derivedMarketId(baseId: string, baseContentHash: string, ops: readonly MarketDeriveOp[]): string {
  return MARKET_DERIVED_ID_PREFIX + contentHash({ baseId, baseContentHash, ops }).slice(0, 12);
}

const noNegZero = (v: number): number => (v === 0 ? 0 : v);

const q = (s: unknown): string => JSON.stringify(typeof s === "string" ? s : String(s));

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

const isPinned = (tYears: number): boolean => Math.abs(tYears) <= T_EPS;

const isIndexOpRaw = (raw: unknown): boolean => isPlainObject(raw) && (raw.op === "set-index" || raw.op === "add-index-basis" || raw.op === "set-index-history");
const sortById = (block: readonly RateIndex[]): RateIndex[] => [...block].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
/** A copy in the stored key order of rateIndex/record.ts; a compounded window is written as before B3a. */
const fresh = (r: RateIndex): RateIndex => indexRecord(r);

/** The normalized op derivedFrom stores: kind only for the two B3a kinds, a lag of 0 left out, -0 read as 0. A compounded window keeps the pre-B3a key order. */
function setIndexOpOf(raw: Record<string, unknown>, kind: RateIndexKind): RateIndexSetOp {
  const id = raw.id as string;
  const label = (raw.label as string).trim();
  const basisBp = noNegZero(raw.basisBp as number);
  const curve = raw.spreadCurve !== undefined ? { spreadCurve: raw.spreadCurve as string } : {};
  // Written only when sent, last.
  const history = raw.historyId !== undefined ? { historyId: raw.historyId as string } : {};
  if (kind === "compounded-window") return { op: "set-index", id, label, tenorMonths: raw.tenorMonths as RateIndexTenor, basisBp, ...curve, ...history };
  if (kind === "constant-maturity-swap") return { op: "set-index", id, label, kind, tenorYears: raw.tenorYears as SwapTenorYears, basisBp, ...curve, ...history };
  const { coefficient: c, beta: b, startBp: s, lagMonths: l, floorBp: f, capBp: cp } = raw;
  return {
    op: "set-index",
    id,
    label,
    kind: "formula",
    parent: raw.parent as string,
    ...(c !== undefined ? { coefficient: noNegZero(c as number) } : {}),
    ...(b !== undefined ? { beta: noNegZero(b as number) } : {}),
    ...(s !== undefined ? { startBp: noNegZero(s as number) } : {}),
    ...(l !== undefined && l !== 0 ? { lagMonths: l as number } : {}),
    ...(f !== undefined ? { floorBp: noNegZero(f as number) } : {}),
    ...(cp !== undefined ? { capBp: noNegZero(cp as number) } : {}),
    basisBp,
    ...history,
  };
}

const isMacroOpRaw = (raw: unknown): boolean => isPlainObject(raw) && (raw.op === "set-macro-series" || raw.op === "remove-macro-series");
const sortMacroById = (block: readonly MacroSeries[]): MacroSeries[] => [...block].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const isCurveSetupOpRaw = (raw: unknown): boolean => isPlainObject(raw) && raw.op === "set-curve-setup";
const isDerivedCurveOpRaw = (raw: unknown): boolean => isPlainObject(raw) && raw.op === "set-derived-curve";
const sortCurvesById = (block: readonly DerivedCurveBlock[]): DerivedCurveBlock[] => [...block].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** A copy in the canonical key order id, label, kind, role, unit, firstMonth, values, source. */
const freshMacro = (m: MacroSeries): MacroSeries => ({
  id: m.id,
  label: m.label,
  kind: m.kind,
  role: m.role,
  unit: m.unit,
  firstMonth: m.firstMonth,
  values: structuredClone(m.values),
  source: structuredClone(m.source),
});

type ParsedOp =
  | {
      kind: "tlp";
      /** The normalized op, as stored in derivedFrom. */
      op: MarketShockOp;
      /** The node index a targeted op names; -1 for an every-node op. */
      nodeIndex: number;
    }
  | { kind: "index"; op: RateIndexSetOp | RateIndexBasisOp | RateIndexHistoryOp }
  | { kind: "macro"; op: MacroSeriesSetOp | MacroSeriesRemoveOp }
  | { kind: "curve"; op: CurveSetupSetOp }
  | { kind: "derived"; op: DerivedCurveSetOp }
  | {
      kind: "vol";
      /** The normalized op, as stored in derivedFrom. */
      op: ShortRateVolOp;
      /** The expiry row a targeted op names; -1 for an every-expiry op. */
      rowIndex: number;
    };

interface CapQuoteLike {
  expiryYears: number;
  strike: number | null;
  normalVol: number;
  isAtm: boolean;
}

const isReadableCapQuote = (v: unknown): v is CapQuoteLike =>
  isPlainObject(v) &&
  typeof v.expiryYears === "number" &&
  Number.isFinite(v.expiryYears) &&
  v.expiryYears > 0 &&
  typeof v.normalVol === "number" &&
  Number.isFinite(v.normalVol) &&
  typeof v.isAtm === "boolean" &&
  (v.strike === null || (typeof v.strike === "number" && Number.isFinite(v.strike)));

export function deriveMarketSnapshot(base: MarketSnapshot, ops: readonly unknown[], options: MarketDeriveOptions): MarketDeriveResult {
  const baseId = options.baseId;

  // Stage 0: the op count, then a base the derivation can read. Thrown alone.
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new MarketDerivationError([{ at: "ops", message: "a derivation needs at least one op" }]);
  }
  if (ops.length > MAX_MARKET_DERIVATION_OPS) {
    throw new MarketDerivationError([{ at: "ops", message: `at most ${MAX_MARKET_DERIVATION_OPS} ops; got ${ops.length}` }]);
  }
  // The TLP node checks run only when some op is not an index op: an index-only
  // derivation does not read the nodes, so a base with none can still take one.
  // The same holds for a volatility op: the cap quotes are read only when some op is one.
  const needsNodes = ops.some((raw) => !isIndexOpRaw(raw) && !isShortRateVolOp(raw) && !isMacroOpRaw(raw) && !isCurveSetupOpRaw(raw) && !isDerivedCurveOpRaw(raw));
  const needsVols = ops.some((raw) => isShortRateVolOp(raw));
  const readable =
    isPlainObject(base) &&
    (!needsNodes ||
      (Array.isArray(base.tlpNodes) &&
        base.tlpNodes.every((n) => isPlainObject(n) && typeof n.tYears === "number" && Number.isFinite(n.tYears) && n.tYears >= 0 && typeof n.spread === "number" && Number.isFinite(n.spread)))) &&
    (!needsVols || (Array.isArray(base.capQuotes) && base.capQuotes.every(isReadableCapQuote)));
  if (!readable) {
    throw new MarketDerivationError([{ at: "base", message: `market ${q(baseId)} is not a market snapshot the derivation can read` }]);
  }
  const nodes = needsNodes ? base.tlpNodes : [];
  let tenorList = "";
  if (needsNodes) {
    if (nodes.length === 0) {
      throw new MarketDerivationError([
        { at: "base", message: `market ${q(baseId)} carries no TLP nodes; a run on it uses the kernel default TLP curve, which a derivation does not shock` },
      ]);
    }
    const zeros = nodes.filter((n) => isPinned(n.tYears));
    if (zeros.length === 0 || zeros.some((n) => n.spread !== 0)) {
      throw new MarketDerivationError([
        {
          at: "base",
          message: `market ${q(baseId)} has no TLP node at t = 0 pinned at 0; the derivation keeps that node pinned and cannot start from a base without it`,
        },
      ]);
    }
    const sorted = nodes.map((n) => n.tYears).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]! - sorted[i - 1]! <= T_EPS) {
        throw new MarketDerivationError([
          { at: "base", message: `market ${q(baseId)} carries two TLP nodes at ${sorted[i - 1]} years; a derivation cannot say which one to change` },
        ]);
      }
    }
    tenorList = nodes.map((n) => String(n.tYears)).join(", ");
  }
  // The cap quotes: the expiry rows (quotes within T_EPS of one expiry) and the at-the-money expiries.
  const capQuotes: CapQuoteLike[] = needsVols ? (base.capQuotes as unknown as CapQuoteLike[]) : [];
  const rows: Array<{ expiryYears: number; indices: number[] }> = [];
  let atmList = "";
  if (needsVols) {
    capQuotes.forEach((cq, i) => {
      const row = rows.find((r) => Math.abs(r.expiryYears - cq.expiryYears) <= T_EPS);
      if (row === undefined) rows.push({ expiryYears: cq.expiryYears, indices: [i] });
      else row.indices.push(i);
    });
    const atmT = capQuotes.filter((cq) => cq.isAtm).map((cq) => cq.expiryYears);
    if (atmT.length === 0) {
      throw new MarketDerivationError([
        {
          at: "base",
          message: `market ${q(baseId)} carries no at-the-money short-rate volatility; a stochastic run on it refuses, and a volatility shock would change nothing a run reads`,
        },
      ]);
    }
    const sortedAtm = [...atmT].sort((a, b) => a - b);
    for (let i = 1; i < sortedAtm.length; i++) {
      if (sortedAtm[i]! - sortedAtm[i - 1]! <= T_EPS) {
        throw new MarketDerivationError([
          {
            at: "base",
            message: `market ${q(baseId)} carries two at-the-money short-rate volatilities at ${sortedAtm[i - 1]} years; a derivation cannot say which one feeds the calibration`,
          },
        ]);
      }
    }
    atmList = atmT.map((t) => String(t)).join(", ");
  }
  // The base block, when it has one, must be readable before an op reads it.
  const baseBlockRaw = (base as MarketWithIndices).rateIndices;
  let baseBlock: RateIndex[] = [];
  if (baseBlockRaw !== undefined) {
    const bad = validateRateIndices(baseBlockRaw);
    if (bad.length > 0) {
      throw new MarketDerivationError([
        { at: "base", message: `market ${q(baseId)} carries a rateIndices block the derivation cannot read: ${bad.map((p) => p.message).join("; ")}` },
      ]);
    }
    baseBlock = baseBlockRaw as RateIndex[];
  }
  // When a macro op runs, the base macro block, when it has one, must be readable first.
  const needsMacro = ops.some((raw) => isMacroOpRaw(raw));
  // A macro op checks its series against the base's as-of month, so a base with no readable calibrationDate is refused alone.
  let asOf = "";
  if (needsMacro) {
    const month = asOfMonthOf(base);
    if (month === null) {
      throw new MarketDerivationError([
        { at: "base", message: `market ${q(baseId)} carries no readable calibrationDate, so a macro op has no as-of month to check its series against` },
      ]);
    }
    asOf = month;
  }
  const baseMacroRaw = (base as MarketWithMacro).macroFactors;
  let baseMacro: MacroSeries[] = [];
  if (needsMacro && baseMacroRaw !== undefined) {
    const bad = validateMacroFactors(baseMacroRaw, asOf);
    if (bad.length > 0) {
      throw new MarketDerivationError([
        { at: "base", message: `market ${q(baseId)} carries a macroFactors block the derivation cannot read: ${bad.map((p) => p.message).join("; ")}` },
      ]);
    }
    baseMacro = baseMacroRaw as MacroSeries[];
  }
  // When a curve setup op runs, the base curveSetup block, when it has one, must be readable first.
  const needsSetup = ops.some((raw) => isCurveSetupOpRaw(raw));
  const baseSetupRaw = (base as MarketWithCurveSetup).curveSetup;
  let baseSetup: CurveSetupBlock | undefined;
  if (needsSetup && baseSetupRaw !== undefined) {
    const checked = validateCurveSetup(baseSetupRaw);
    if (!checked.ok) {
      throw new MarketDerivationError([
        { at: "base", message: `market ${q(baseId)} carries a curveSetup block the derivation cannot read: ${checked.refusals.join("; ")}` },
      ]);
    }
    baseSetup = checked.block;
  }
  // The base derivedCurves block, when it has one, must be readable; with no op touching it, it is carried unchanged.
  const baseCurvesRaw = (base as MarketWithDerivedCurves).derivedCurves;
  let baseCurves: DerivedCurveBlock[] = [];
  if (baseCurvesRaw !== undefined) {
    const bad = validateDerivedCurves(baseCurvesRaw);
    if (bad.length > 0) {
      throw new MarketDerivationError([
        { at: "base", message: `market ${q(baseId)} carries a derivedCurves block the derivation cannot read: ${bad.join("; ")}` },
      ]);
    }
    baseCurves = baseCurvesRaw as DerivedCurveBlock[];
  }

  // Stage 1: shape and address of every op, all collected, thrown before apply.
  const problems: DerivationProblem[] = [];
  const add = (at: string, message: string): void => void problems.push({ at, message });
  const parsed: ParsedOp[] = [];
  // The index ids the market carries at each point in the op order.
  const known = new Set<string>(baseBlock.map((r) => r.id));
  // The macro series ids the market carries at each point in the op order.
  const knownMacro = new Set<string>(baseMacro.map((m) => m.id));
  // The index of the first set-curve-setup op; -1 until one is seen.
  let firstSetupAt = -1;
  ops.forEach((raw, i) => {
    const at = `ops[${i}]`;
    if (!isPlainObject(raw)) {
      add(at, `${at}: an op must be an object carrying op and value, and optionally target`);
      return;
    }
    if (raw.op === "set-curve-setup") {
      // Shape errors inside the setup are the validator's, so one text set serves derive, the store and Studio.
      let ok = true;
      for (const k of Object.keys(raw)) {
        if (!SET_CURVE_SETUP_KEYS.has(k)) {
          add(at, `${at}: unknown field ${q(k)}; a set-curve-setup op carries op and setup`);
          ok = false;
        }
      }
      if (firstSetupAt >= 0) {
        add(at, `${at}: a derivation takes one set-curve-setup op; ops[${firstSetupAt}] already sets the curve setup`);
        ok = false;
      } else {
        firstSetupAt = i;
      }
      const checked = validateCurveSetup(raw.setup);
      if (!checked.ok) {
        for (const refusal of checked.refusals) add(at, `${at}: ${refusal}`);
        ok = false;
      }
      if (!ok || !checked.ok) return;
      // The validator builds a fresh block, so the caller's object is never shared.
      parsed.push({ kind: "curve", op: { op: "set-curve-setup", setup: checked.block } });
      return;
    }
    if (raw.op === "set-derived-curve") {
      // Shape errors inside the curve are the validator's, so one text set serves derive, the store and Studio.
      let ok = true;
      for (const k of Object.keys(raw)) {
        if (!SET_DERIVED_CURVE_KEYS.has(k)) {
          add(at, `${at}: unknown field ${q(k)}; a set-derived-curve op carries op and curve`);
          ok = false;
        }
      }
      const checked = validateDerivedCurve(raw.curve);
      if (!checked.ok) {
        for (const refusal of checked.refusals) add(at, `${at}: ${refusal}`);
        ok = false;
      }
      if (!ok || !checked.ok) return;
      // The validator builds a fresh block, so the caller's object is never shared.
      parsed.push({ kind: "derived", op: { op: "set-derived-curve", curve: checked.block } });
      return;
    }
    if (raw.op === "set-macro-series") {
      // Shape errors inside the series are left to the Stage 2 validator, so one text set serves derive, seed and Studio.
      let ok = true;
      for (const k of Object.keys(raw)) {
        if (!SET_MACRO_KEYS.has(k)) {
          add(at, `${at}: unknown field ${q(k)}; a set-macro-series op carries op, id, label, kind, role, unit, firstMonth, values and source`);
          ok = false;
        }
      }
      if (typeof raw.id !== "string") {
        add(at, `${at}: id must be a string`);
        ok = false;
      }
      if (!ok) return;
      knownMacro.add(raw.id as string);
      parsed.push({
        kind: "macro",
        op: {
          op: "set-macro-series",
          id: raw.id as string,
          label: raw.label as string,
          kind: raw.kind as MacroSeries["kind"],
          role: raw.role as MacroSeries["role"],
          unit: raw.unit as string,
          firstMonth: raw.firstMonth as string,
          values: structuredClone(raw.values) as MacroSeries["values"],
          source: structuredClone(raw.source) as MacroSeries["source"],
        },
      });
      return;
    }
    if (raw.op === "remove-macro-series") {
      let ok = true;
      for (const k of Object.keys(raw)) {
        if (!REMOVE_MACRO_KEYS.has(k)) {
          add(at, `${at}: unknown field ${q(k)}; a remove-macro-series op carries op and seriesId`);
          ok = false;
        }
      }
      if (typeof raw.seriesId !== "string") {
        add(at, `${at}: seriesId must be a string`);
        ok = false;
      }
      if (ok && !knownMacro.has(raw.seriesId as string)) {
        const carried = [...knownMacro].sort().join(", ");
        add(
          at,
          `${at}: remove-macro-series names series ${q(raw.seriesId)}, which market ${q(baseId)} does not carry at that point in the op list (it carries ${carried === "" ? "none" : carried})`,
        );
        ok = false;
      }
      if (!ok) return;
      knownMacro.delete(raw.seriesId as string);
      parsed.push({ kind: "macro", op: { op: "remove-macro-series", seriesId: raw.seriesId as string } });
      return;
    }
    if (raw.op === "set-index-history") {
      // Piece B, step B3b (ruling R3): the index carries the history id only; the store check is the server's.
      let ok = true;
      for (const k of Object.keys(raw)) {
        if (!SET_INDEX_HISTORY_KEYS.has(k)) {
          add(at, `${at}: unknown field ${q(k)}; a set-index-history op carries op, indexId and historyId`);
          ok = false;
        }
      }
      if (typeof raw.indexId !== "string") {
        add(at, `${at}: indexId must be a string`);
        ok = false;
      }
      if (raw.historyId !== null && !isIndexHistoryId(raw.historyId)) {
        add(at, `${at}: ${HISTORY_ID_SENTENCE} or null to clear the index's history; got ${q(raw.historyId)}`);
        ok = false;
      }
      if (ok && !known.has(raw.indexId as string)) {
        const carried = [...known].sort().join(", ");
        add(
          at,
          `${at}: set-index-history names rate index ${q(raw.indexId)}, which market ${q(baseId)} does not carry at that point in the op list (it carries ${carried === "" ? "none" : carried})`,
        );
        ok = false;
      }
      if (!ok) return;
      parsed.push({ kind: "index", op: { op: "set-index-history", indexId: raw.indexId as string, historyId: raw.historyId as string | null } });
      return;
    }
    if (raw.op === "set-index") {
      let ok = true;
      const kindRaw = raw.kind === undefined ? "compounded-window" : raw.kind;
      const kind = typeof kindRaw === "string" && (RATE_INDEX_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as RateIndexKind) : undefined;
      if (kind === undefined) {
        add(at, `${at}: kind must be compounded-window, constant-maturity-swap or formula; got ${q(raw.kind)}`);
        ok = false;
      } else {
        for (const k of Object.keys(raw)) {
          if (kind === "formula" && k === "spreadCurve") {
            add(at, `${at}: ${FORMULA_SPREAD_CURVE_SENTENCE}`);
            ok = false;
          } else if (!SET_INDEX_KEYS_BY_KIND[kind].has(k)) {
            add(at, `${at}: unknown field ${q(k)}; ${SET_INDEX_CARRIES[kind]}`);
            ok = false;
          }
        }
      }
      if (typeof raw.id !== "string") {
        add(at, `${at}: id must be a string`);
        ok = false;
      }
      if (typeof raw.label !== "string") {
        add(at, `${at}: label must be a string`);
        ok = false;
      }
      if (kind === "compounded-window" && typeof raw.tenorMonths !== "number") {
        add(at, `${at}: tenorMonths must be a number`);
        ok = false;
      }
      if (kind === "constant-maturity-swap" && typeof raw.tenorYears !== "number") {
        add(at, `${at}: tenorYears must be a number`);
        ok = false;
      }
      if (kind === "formula") {
        if (typeof raw.parent !== "string") {
          add(at, `${at}: parent must be a string`);
          ok = false;
        }
        for (const k of ["coefficient", "beta"] as const) {
          const v = raw[k];
          if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
            add(at, `${at}: ${k} must be a finite number`);
            ok = false;
          }
        }
        for (const k of ["startBp", "floorBp", "capBp"] as const) {
          const v = raw[k];
          if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
            add(at, `${at}: ${k} must be a finite number of basis points`);
            ok = false;
          }
        }
        if (raw.lagMonths !== undefined && typeof raw.lagMonths !== "number") {
          add(at, `${at}: lagMonths must be a number`);
          ok = false;
        }
      }
      if (typeof raw.basisBp !== "number" || !Number.isFinite(raw.basisBp)) {
        add(at, `${at}: basisBp must be a finite number of basis points`);
        ok = false;
      }
      // An optional derived curve id; its pattern is the Stage 2 validator's.
      if (kind !== "formula" && raw.spreadCurve !== undefined && typeof raw.spreadCurve !== "string") {
        add(at, `${at}: spreadCurve must be a string`);
        ok = false;
      }
      // An optional index history id; whether the store holds it is the server's check.
      if (raw.historyId !== undefined && !isIndexHistoryId(raw.historyId)) {
        add(at, `${at}: ${HISTORY_ID_SENTENCE}; got ${q(raw.historyId)}`);
        ok = false;
      }
      if (!ok || kind === undefined) return;
      known.add(raw.id as string);
      parsed.push({ kind: "index", op: setIndexOpOf(raw, kind) });
      return;
    }
    if (raw.op === "add-index-basis") {
      let ok = true;
      for (const k of Object.keys(raw)) {
        if (!BASIS_OP_KEYS.has(k)) {
          add(at, `${at}: unknown field ${q(k)}; an add-index-basis op carries op, indexId and value`);
          ok = false;
        }
      }
      if (typeof raw.indexId !== "string") {
        add(at, `${at}: indexId must be a string`);
        ok = false;
      }
      if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) {
        add(at, `${at}: value must be a finite number of basis points`);
        ok = false;
      }
      if (ok && !known.has(raw.indexId as string)) {
        const carried = [...known].sort().join(", ");
        add(
          at,
          `${at}: add-index-basis names rate index ${q(raw.indexId)}, which market ${q(baseId)} does not carry at that point in the op list (it carries ${carried === "" ? "none" : carried})`,
        );
        ok = false;
      }
      if (!ok) return;
      parsed.push({ kind: "index", op: { op: "add-index-basis", indexId: raw.indexId as string, value: noNegZero(raw.value as number) } });
      return;
    }
    if (isShortRateVolOp(raw)) {
      let ok = true;
      for (const k of Object.keys(raw)) {
        if (!VOL_OP_KEYS.has(k)) {
          add(at, `${at}: unknown field ${q(k)}; a short-rate volatility op carries op, value and optionally target`);
          ok = false;
        }
      }
      const targetRaw = raw.target;
      let rowIndex = -1;
      let expiryYears: number | undefined;
      if (targetRaw !== undefined) {
        const naming = `${at}: target.expiryYears must be a finite number naming an expiry that carries an at-the-money short-rate volatility`;
        if (!isPlainObject(targetRaw)) {
          add(at, naming);
          ok = false;
        } else {
          for (const k of Object.keys(targetRaw)) {
            if (!VOL_TARGET_KEYS.has(k)) {
              add(at, `${at}: unknown target field ${q(k)}; a short-rate volatility target carries expiryYears`);
              ok = false;
            }
          }
          const t = targetRaw.expiryYears;
          if (typeof t !== "number" || !Number.isFinite(t)) {
            add(at, naming);
            ok = false;
          } else {
            const atmQuote = capQuotes.find((cq) => cq.isAtm && Math.abs(cq.expiryYears - t) <= T_EPS);
            if (atmQuote === undefined) {
              add(
                at,
                `${at}: market ${q(baseId)} has no at-the-money short-rate volatility at ${t} years; its at-the-money expiries are ${atmList} years, and a volatility shock cannot add an expiry`,
              );
              ok = false;
            } else {
              rowIndex = rows.findIndex((r) => Math.abs(r.expiryYears - atmQuote.expiryYears) <= T_EPS);
              expiryYears = t;
            }
          }
        }
      }
      const value = raw.value;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        add(at, raw.op === "add-short-rate-vol" ? `${at}: value must be a finite number of basis points` : `${at}: value must be a finite number`);
        ok = false;
      } else if (raw.op === "scale-short-rate-vol" && !(value >= SHORT_RATE_VOL_SCALE_MIN && value <= SHORT_RATE_VOL_SCALE_MAX)) {
        add(at, `${at}: a short-rate volatility scale factor must be from ${SHORT_RATE_VOL_SCALE_MIN} to ${SHORT_RATE_VOL_SCALE_MAX}; got ${value}`);
        ok = false;
      }
      if (!ok) return;
      const kind = raw.op as ShortRateVolOp["op"];
      parsed.push({
        kind: "vol",
        op: expiryYears === undefined ? { op: kind, value: noNegZero(value as number) } : { target: { expiryYears }, op: kind, value: noNegZero(value as number) },
        rowIndex,
      });
      return;
    }
    let ok = true;
    for (const k of Object.keys(raw)) {
      if (!OP_KEYS.has(k)) {
        add(
          at,
          `${at}: unknown field ${q(k)}; an op carries target, op and value and changes the TLP nodes only; a rate index op is set-index or add-index-basis; a short-rate volatility op is scale-short-rate-vol or add-short-rate-vol`,
        );
        ok = false;
      }
    }
    const targetRaw = raw.target;
    let nodeIndex = -1;
    let tYears: number | undefined;
    if (targetRaw !== undefined) {
      if (!isPlainObject(targetRaw)) {
        add(at, `${at}: target.tYears must be a finite number naming a TLP node`);
        ok = false;
      } else {
        for (const k of Object.keys(targetRaw)) {
          if (!TARGET_KEYS.has(k)) {
            add(at, `${at}: unknown target field ${q(k)}; a target carries tYears`);
            ok = false;
          }
        }
        const t = targetRaw.tYears;
        if (typeof t !== "number" || !Number.isFinite(t)) {
          add(at, `${at}: target.tYears must be a finite number naming a TLP node`);
          ok = false;
        } else if (isPinned(t)) {
          add(at, `${at}: the TLP node at t = 0 is pinned at 0; a funding spread shock cannot move it`);
          ok = false;
        } else {
          nodeIndex = nodes.findIndex((n) => Math.abs(n.tYears - t) <= T_EPS);
          if (nodeIndex < 0) {
            add(at, `${at}: market ${q(baseId)} has no TLP node at ${t} years; its nodes are at ${tenorList} years, and a funding spread shock cannot add a node`);
            ok = false;
          } else {
            tYears = t;
          }
        }
      }
    }
    const kind = raw.op;
    if (typeof kind !== "string" || !OP_KINDS.has(kind)) {
      add(at, `${at}: op must be add, scale, set-index, add-index-basis, scale-short-rate-vol or add-short-rate-vol; got ${q(kind)}`);
      ok = false;
    }
    const value = raw.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      add(at, `${at}: value must be a finite number`);
      ok = false;
    } else if (kind === "scale" && !(value > 0)) {
      add(at, `${at}: a scale factor must be greater than 0; got ${value}`);
      ok = false;
    }
    if (!ok) return;
    parsed.push({
      kind: "tlp",
      op: tYears === undefined
        ? { op: kind as MarketShockOpKind, value: noNegZero(value as number) }
        : { target: { tYears }, op: kind as MarketShockOpKind, value: noNegZero(value as number) },
      nodeIndex,
    });
  });
  if (problems.length > 0) throw new MarketDerivationError(problems);

  const hasTlp = parsed.some((p) => p.kind === "tlp");
  const hasIndex = parsed.some((p) => p.kind === "index");
  const hasVol = parsed.some((p) => p.kind === "vol");
  const hasMacro = parsed.some((p) => p.kind === "macro");
  const setupParsed = parsed.find((p): p is Extract<ParsedOp, { kind: "curve" }> => p.kind === "curve");
  const hasSetup = setupParsed !== undefined;
  // The stored block: its own deep copy, separate from the op recorded in derivedFrom.
  const derivedSetup: CurveSetupBlock | undefined = hasSetup ? structuredClone(setupParsed.op.setup) : undefined;
  // Each set-derived-curve op adds its curve or replaces the one with the same id, in order; the block is written sorted by id.
  const hasDerived = parsed.some((p) => p.kind === "derived");
  const curveWork = new Map<string, DerivedCurveBlock>(baseCurves.map((c) => [c.id, c]));
  for (const p of parsed) if (p.kind === "derived") curveWork.set(p.op.curve.id, p.op.curve);
  // The stored block: its own deep copy, separate from the ops recorded in derivedFrom.
  const derivedCurves: DerivedCurveBlock[] = hasDerived ? structuredClone(sortCurvesById([...curveWork.values()])) : [];

  // Apply the TLP ops: on a deep clone, in order, composing. One change row per node, first touch first.
  const derivedNodes = structuredClone(nodes) as Array<{ tYears: number; spread: number }>;
  const changeAt = new Map<number, TlpNodeChange>();
  const changes: TlpNodeChange[] = [];
  parsed.forEach((p, i) => {
    if (p.kind !== "tlp") return;
    const { op, nodeIndex } = p;
    derivedNodes.forEach((node, ni) => {
      if (isPinned(node.tYears)) return;
      if (nodeIndex >= 0 && ni !== nodeIndex) return;
      let row = changeAt.get(ni);
      if (row === undefined) {
        row = { nodeIndex: ni, tYears: node.tYears, from: node.spread, to: node.spread, changeBp: 0, ops: [] };
        changeAt.set(ni, row);
        changes.push(row);
      }
      row.ops.push(i);
      node.spread = noNegZero(op.op === "add" ? round12(node.spread + op.value / 10000) : round12(node.spread * op.value));
      row.to = node.spread;
    });
  });
  for (const row of changes) row.changeBp = round12((row.to - row.from) * 10000);

  // Apply the index ops, in order, composing. One change row per index, first touch first.
  const work = new Map<string, RateIndex>(baseBlock.map((r) => [r.id, fresh(r)]));
  const baseById = new Map<string, RateIndex>(baseBlock.map((r) => [r.id, r]));
  const touched = new Map<string, { from: RateIndex | null; created: number | null; ops: number[] }>();
  parsed.forEach((p, i) => {
    if (p.kind !== "index") return;
    const o = p.op;
    const id = o.op === "set-index" ? o.id : o.indexId;
    let t = touched.get(id);
    if (t === undefined) {
      const b = baseById.get(id);
      t = { from: b === undefined ? null : fresh(b), created: null, ops: [] };
      touched.set(id, t);
    }
    t.ops.push(i);
    if (o.op === "set-index") {
      // The op replaces the index wholesale, except a history id it does not name, which it keeps:
      // a set-index without spreadCurve clears an earlier one.
      const entry = indexFromSetOp(o, work.get(id)?.historyId);
      work.set(id, entry);
      if (t.from === null && t.created === null) t.created = entry.basis;
    } else if (o.op === "add-index-basis") {
      const cur = work.get(id)!;
      cur.basis = round12(cur.basis + o.value / 10000);
    } else {
      // Point the index at a history, or clear it; nothing else on the record moves.
      const cur = work.get(id)!;
      work.set(id, indexRecord({ ...cur, historyId: o.historyId ?? undefined } as RateIndex));
    }
  });
  const derivedBlock = sortById([...work.values()]).map(fresh);
  const indexChanges: RateIndexChange[] = [];
  for (const [id, t] of touched) {
    const to = derivedBlock.find((r) => r.id === id)!;
    const reference = t.from !== null ? t.from.basis : t.created !== null && t.created !== to.basis ? t.created : null;
    indexChanges.push({ id, from: t.from, to: fresh(to), basisChangeBp: reference === null ? null : round12((to.basis - reference) * 10000), ops: t.ops });
  }

  // Apply the volatility ops: on a deep clone of the cap quotes, in order, composing. One change row per expiry row, first touch first.
  const derivedCaps = hasVol ? (structuredClone(capQuotes) as CapQuoteLike[]) : [];
  const volRowAt = new Map<number, { change: ShortRateVolChange; atmIndex: number }>();
  const volChanges: ShortRateVolChange[] = [];
  parsed.forEach((p, i) => {
    if (p.kind !== "vol") return;
    const { op, rowIndex } = p;
    rows.forEach((row, ri) => {
      if (rowIndex >= 0 && ri !== rowIndex) return;
      let entry = volRowAt.get(ri);
      if (entry === undefined) {
        const atmIndex = row.indices.find((qi) => capQuotes[qi]!.isAtm) ?? -1;
        const atmFrom = atmIndex >= 0 ? capQuotes[atmIndex]!.normalVol : null;
        entry = { change: { expiryYears: row.expiryYears, quotes: row.indices.length, quotesChanged: 0, atmFrom, atmTo: atmFrom, atmChangeBp: null, ops: [] }, atmIndex };
        volRowAt.set(ri, entry);
        volChanges.push(entry.change);
      }
      entry.change.ops.push(i);
      for (const qi of row.indices) {
        const cq = derivedCaps[qi]!;
        cq.normalVol = noNegZero(op.op === "scale-short-rate-vol" ? round12(cq.normalVol * op.value) : round12(cq.normalVol + op.value / 10000));
      }
    });
  });
  for (const [ri, entry] of volRowAt) {
    const row = rows[ri]!;
    entry.change.quotesChanged = row.indices.filter((qi) => derivedCaps[qi]!.normalVol !== capQuotes[qi]!.normalVol).length;
    if (entry.atmIndex >= 0) {
      entry.change.atmTo = derivedCaps[entry.atmIndex]!.normalVol;
      entry.change.atmChangeBp = round12((entry.change.atmTo - entry.change.atmFrom!) * 10000);
    }
  }

  // Apply the macro ops, in order, on a map seeded from the base block. One change row per series, first touch first.
  const macroWork = new Map<string, MacroSeries>(baseMacro.map((m) => [m.id, freshMacro(m)]));
  const baseMacroIds = new Set<string>(baseMacro.map((m) => m.id));
  const macroTouched = new Map<string, number[]>();
  parsed.forEach((p, i) => {
    if (p.kind !== "macro") return;
    const o = p.op;
    const id = o.op === "set-macro-series" ? o.id : o.seriesId;
    let t = macroTouched.get(id);
    if (t === undefined) {
      t = [];
      macroTouched.set(id, t);
    }
    t.push(i);
    if (o.op === "set-macro-series") {
      macroWork.set(id, freshMacro({ id: o.id, label: o.label, kind: o.kind, role: o.role, unit: o.unit, firstMonth: o.firstMonth, values: o.values, source: o.source }));
    } else {
      macroWork.delete(id);
    }
  });
  const derivedMacro = sortMacroById([...macroWork.values()]);
  const macroChanges: MacroSeriesChange[] = [];
  for (const [id, opsAt] of macroTouched) {
    const change: MacroSeriesChange["change"] = !macroWork.has(id) ? "removed" : baseMacroIds.has(id) ? "replaced" : "added";
    macroChanges.push({ id, change, ops: opsAt });
  }

  // Stage 2: the derived values. All collected.
  if (hasTlp) {
    derivedNodes.forEach((node, ni) => {
      if (isPinned(node.tYears)) return;
      if (!Number.isFinite(node.spread) || !(node.spread > 0)) {
        add(
          `tlpNodes[${ni}].spread`,
          `TLP node at ${node.tYears} years: the derived spread is ${String(node.spread)}; a TLP node other than t = 0 must be finite and greater than 0, the rule the workbook import applies`,
        );
      }
    });
  }
  if (hasIndex) problems.push(...validateRateIndices(derivedBlock));
  if (hasMacro) problems.push(...validateMacroFactors(derivedMacro, asOf));
  if (hasDerived) for (const message of validateDerivedCurves(derivedCurves)) add("derivedCurves", `derivedCurves: ${message}`);
  if (hasVol) {
    // One problem per expiry row in which any derived quote leaves the open range 0 to the ceiling.
    for (const [ri] of volRowAt) {
      const row = rows[ri]!;
      const bad = row.indices.filter((qi) => {
        const v = derivedCaps[qi]!.normalVol;
        return !Number.isFinite(v) || !(v > 0) || !(v < SHORT_RATE_VOL_CEILING);
      });
      if (bad.length === 0) continue;
      let lo = derivedCaps[bad[0]!]!.normalVol;
      let hi = lo;
      for (const qi of bad) {
        const v = derivedCaps[qi]!.normalVol;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      add(
        `capQuotes[${bad[0]}].normalVol`,
        `short-rate volatilities at the ${row.expiryYears}-year expiry: ${bad.length} of ${row.indices.length} derived values fall outside the open range 0 to ${SHORT_RATE_VOL_CEILING} (lowest ${lo}, highest ${hi}); a short-rate volatility must be finite, greater than 0 and below ${SHORT_RATE_VOL_CEILING} (500 bp), the ceiling of the Hull-White sigma the calibration fits`,
      );
    }
  }
  const tlpMoved = changes.some((c) => c.from !== c.to);
  const hasHistoryOp = parsed.some((p) => p.kind === "index" && p.op.op === "set-index-history");
  if (hasHistoryOp) {
    // A derivation with a set-index-history op; the texts below are kept byte for byte for derivations without one.
    const indexMoved = canonicalize(sortById(baseBlock).map(fresh)) !== canonicalize(derivedBlock);
    const volMoved = volChanges.some((c) => c.quotesChanged > 0);
    const macroMoved = hasMacro && canonicalize(sortMacroById(baseMacro).map(freshMacro)) !== canonicalize(derivedMacro);
    const setupMoved = hasSetup && (baseSetup === undefined || canonicalize(baseSetup) !== canonicalize(derivedSetup));
    const curvesMoved = hasDerived && canonicalize(sortCurvesById(baseCurves)) !== canonicalize(derivedCurves);
    if (!tlpMoved && !indexMoved && !volMoved && !macroMoved && !setupMoved && !curvesMoved && problems.length === 0) {
      add(
        "ops",
        `the ops change no TLP node, no rate index or index history, no short-rate volatility, no macro series, no curve setup and no derived curve; the derived market would carry what market ${q(baseId)} carries`,
      );
    }
  } else if (hasDerived) {
    // A derivation with a derived curve op; the texts below are kept byte for byte for derivations without one.
    const indexMoved = hasIndex && canonicalize(sortById(baseBlock).map(fresh)) !== canonicalize(derivedBlock);
    const volMoved = volChanges.some((c) => c.quotesChanged > 0);
    const macroMoved = hasMacro && canonicalize(sortMacroById(baseMacro).map(freshMacro)) !== canonicalize(derivedMacro);
    const setupMoved = hasSetup && (baseSetup === undefined || canonicalize(baseSetup) !== canonicalize(derivedSetup));
    const curvesMoved = canonicalize(sortCurvesById(baseCurves)) !== canonicalize(derivedCurves);
    if (!tlpMoved && !indexMoved && !volMoved && !macroMoved && !setupMoved && !curvesMoved && problems.length === 0) {
      add(
        "ops",
        `the ops change no TLP node, no rate index, no short-rate volatility, no macro series, no curve setup and no derived curve; the derived market would carry what market ${q(baseId)} carries`,
      );
    }
  } else if (hasSetup) {
    // A derivation with a curve setup op; the texts below are kept byte for byte for derivations without one.
    const indexMoved = hasIndex && canonicalize(sortById(baseBlock).map(fresh)) !== canonicalize(derivedBlock);
    const volMoved = volChanges.some((c) => c.quotesChanged > 0);
    const macroMoved = hasMacro && canonicalize(sortMacroById(baseMacro).map(freshMacro)) !== canonicalize(derivedMacro);
    const setupMoved = baseSetup === undefined || canonicalize(baseSetup) !== canonicalize(derivedSetup);
    if (!tlpMoved && !indexMoved && !volMoved && !macroMoved && !setupMoved && problems.length === 0) {
      add(
        "ops",
        `the ops change no TLP node, no rate index, no short-rate volatility, no macro series and no curve setup; the derived market would carry what market ${q(baseId)} carries`,
      );
    }
  } else if (hasMacro) {
    // A derivation with a macro op; the three texts below are kept byte for byte for derivations without one.
    const indexMoved = hasIndex && canonicalize(sortById(baseBlock).map(fresh)) !== canonicalize(derivedBlock);
    const volMoved = volChanges.some((c) => c.quotesChanged > 0);
    const macroMoved = canonicalize(sortMacroById(baseMacro).map(freshMacro)) !== canonicalize(derivedMacro);
    if (!tlpMoved && !indexMoved && !volMoved && !macroMoved && problems.length === 0) {
      add(
        "ops",
        `the ops change no TLP node, no rate index, no short-rate volatility and no macro series; the derived market would carry what market ${q(baseId)} carries`,
      );
    }
  } else if (hasVol) {
    const indexMoved = hasIndex && canonicalize(sortById(baseBlock).map(fresh)) !== canonicalize(derivedBlock);
    const volMoved = volChanges.some((c) => c.quotesChanged > 0);
    if (!tlpMoved && !indexMoved && !volMoved && problems.length === 0) {
      add("ops", `the ops change no TLP node, no rate index and no short-rate volatility; the derived market would carry what market ${q(baseId)} carries`);
    }
  } else if (hasIndex) {
    if (!tlpMoved && problems.length === 0 && canonicalize(sortById(baseBlock).map(fresh)) === canonicalize(derivedBlock)) {
      add("ops", `the ops change no TLP node and no rate index; the derived market would carry what market ${q(baseId)} carries`);
    }
  } else if (!tlpMoved) {
    add("ops", `the ops change no TLP node; the derived market would carry what market ${q(baseId)} carries`);
  }
  if (problems.length > 0) throw new MarketDerivationError(problems);

  const normalized: MarketDeriveOp[] = parsed.map((p) => p.op);
  const baseHash = contentHash(base);
  const id = options.id ?? derivedMarketId(baseId, baseHash, normalized);
  const given = typeof options.label === "string" ? options.label.trim() : "";
  // The label parts in a fixed order, the first capitalized: "Funding spread shock, rate indices and short-rate volatility shock".
  const parts = [
    hasTlp ? "funding spread shock" : "",
    hasIndex ? "rate indices" : "",
    hasVol ? "short-rate volatility shock" : "",
    hasMacro ? "macro factors" : "",
    hasSetup ? "curve setup" : "",
    hasDerived ? "derived curves" : "",
  ].filter((x) => x !== "");
  const joined = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  const defaultLabel = `${joined.charAt(0).toUpperCase()}${joined.slice(1)} on ${baseId}${DEMONSTRATION_SUFFIX}`;
  const label = given === "" ? defaultLabel : /demonstration|illustrative/i.test(given) ? given : given + DEMONSTRATION_SUFFIX;
  const derivedFrom: MarketDerivedFrom = { baseId, baseContentHash: baseHash, ops: structuredClone(normalized) };
  const snapshot: DerivedMarketSnapshot = {
    ...(structuredClone(base) as MarketWithIndices),
    ...(hasTlp ? { termFundingCurveQuotes: [], tlpNodes: derivedNodes } : {}),
    ...(hasIndex ? { rateIndices: derivedBlock } : {}),
    ...(hasVol ? { capQuotes: derivedCaps as unknown as MarketSnapshot["capQuotes"] } : {}),
    ...(hasMacro ? { macroFactors: derivedMacro } : {}),
    ...(hasSetup ? { curveSetup: derivedSetup } : {}),
    // Written only when a set-derived-curve op ran; otherwise the base's block, or its absence, rides the clone.
    ...(hasDerived ? { derivedCurves } : {}),
    derivedFrom,
  };
  return {
    id,
    label,
    snapshot,
    changes,
    indexChanges,
    termFundingQuotesDropped: hasTlp && Array.isArray(base.termFundingCurveQuotes) ? base.termFundingCurveQuotes.length : 0,
    volChanges,
    macroChanges,
  };
}
