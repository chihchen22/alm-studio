/**
 * The LCR, two ways: two custom metrics over one capped HQLA buffer.
 *
 *   LCR = HQLA / (Out - min(In, 0.75 Out))
 *
 * `lcr-scenario` takes Out from each scenario's projected month-1 liability
 * principal plus interest: it applies NO stress of its own (the piece 5c
 * ruling), so under a business-as-usual set it reads business-as-usual flows.
 *
 * `lcr-regulatory` takes Out from the US LCR run-off rates (12 CFR part 249)
 * on each liability family's `lcr-category`: rate times the as-of balance for
 * an `nmd` or `nmd-b` family, rate times the month-1 principal (the part that
 * matures inside 30 days) for any other. Principal only. The rates are public
 * DEMONSTRATION values, not calibrated; the peak-day add-on, US tailoring and
 * the secured-funding unwind inside the caps are not modeled.
 *
 * Both take In as half the month-1 principal plus interest of every
 * non-buffer asset family, the survival-horizon convention, and read "30 days"
 * as calendar month 1, bucket 0.
 *
 * COMMITMENTS enter the OUTFLOW arm of both, and the INFLOW arm of
 * neither. The two arms read different sources on purpose. `lcr-scenario` reads
 * the FLOWS, -min(principal[0], 0) over commitment families, so only a drawdown
 * contributes. `lcr-regulatory` reads the BOOK, rate times `terms.notional`
 * over the family's positions, because an unbound commitment emits no cashflows
 * at all and because 249.32(e) rates the undrawn amount whether or not a draw
 * is projected; its commitment outflow is therefore scenario-invariant.
 *
 * ABSENCE, never zero. No buffer family, a refused buffer, or (regulatory only)
 * a liability family whose positions do not all carry the same known category,
 * or a COMMITMENT family whose positions do not all carry the same known
 * `commitment-category`: no keys. Horizon 0: `hqla` alone. Outflow not
 * positive: every key but `lcr`. No commitment family: no `commitment-draws`
 * key at all, neither in the row nor in the declared envelope.
 */
import { COMMITMENT_INSTRUMENT_TYPE } from "../commitment/offBalanceSheet";
import type { CustomMetricKey, CustomMetricResult } from "../contracts/customMetric";
import type { PortfolioSpec } from "../contracts/position";
import type { FamilyCashflows } from "../contracts/results";
import type { CustomMetricInput } from "../plugins/services";
import {
  bufferLevels,
  cappedHqla,
  classifyBufferFamilies,
  hasBufferFamily,
  type BufferClass,
} from "./hqlaBuffer";

/** The position tag that carries a liability family's LCR category. */
export const LCR_CATEGORY_DIMENSION = "lcr-category";

/** US LCR run-off rates per category. DEMONSTRATION values; a change is a new test expectation. */
export const US_LCR_RUNOFF_DEMO: Readonly<Record<string, number>> = {
  "retail-stable": 0.03,
  "retail-other": 0.1,
  operational: 0.25,
  "secured-gse": 0.25,
  "wholesale-nonfinancial": 0.4,
  "wholesale-financial": 1,
};

/** The position tag that carries a commitment family's facility category. */
export const COMMITMENT_CATEGORY_DIMENSION = "commitment-category";

/**
 * US LCR run-off rates for UNDRAWN COMMITTED FACILITIES, 12 CFR 249.32(e)(1).
 * DEMONSTRATION values in the same sense as US_LCR_RUNOFF_DEMO: public, stated,
 * not calibrated to any book. A change is a code change and a new expectation.
 *
 * The split is by counterparty AND by facility type, because the paragraph
 * itself splits that way and the credit-versus-liquidity difference is the
 * largest one it assigns.
 *
 *   facility-retail          0.05  (ii)   credit and liquidity, retail customer or counterparty
 *   credit-nonfinancial      0.10  (iii)  credit facility, wholesale non-financial-sector counterparty
 *   liquidity-nonfinancial   0.30  (iv)   liquidity facility, same counterparty
 *   facility-depository      0.50  (v)    credit and liquidity, depository institution,
 *                                         depository institution holding company, or foreign bank
 *   credit-financial         0.40  (vi)   credit facility, financial sector entity
 *   liquidity-financial      1.00  (vii)  liquidity facility, same counterparty
 *
 * Not represented, and registered as gaps: the 0 percent affiliated-depository
 * case (i), and the SPE and other-wholesale 100 percent cases (viii) and (ix),
 * whose value duplicates liquidity-financial.
 *
 * The undrawn amount these rates apply to is not modeled either, and the two
 * subparagraphs that define it do different jobs. (e)(2) defines the undrawn
 * amount and APPLIES a collateral deduction to it: the unused capacity drawable
 * within 30 days, LESS the liquid assets securing the facility. (e)(3) SIZES
 * that deduction: the fair value of the level 1 liquid assets securing the
 * facility plus 85 percent of the fair value of the level 2A liquid assets. The
 * engine rates the whole undrawn notional with no deduction, so a collateralized
 * facility is overstated here.
 */
export const US_LCR_COMMITMENT_DEMO: Readonly<Record<string, number>> = {
  "facility-retail": 0.05,
  "credit-nonfinancial": 0.1,
  "liquidity-nonfinancial": 0.3,
  "facility-depository": 0.5,
  "credit-financial": 0.4,
  "liquidity-financial": 1,
};

const INFLOW_FACTOR = 0.5;
const INFLOW_CAP = 0.75;
const NMD_TYPES: ReadonlySet<string> = new Set(["nmd", "nmd-b"]);

/**
 * The family instrument type that carries an undrawn committed line.
 * Re-exported from the containment module rather than restated, so the arms
 * here that must SEE a commitment and the asset aggregates that must EXCLUDE it
 * read one definition.
 */
const COMMITMENT_TYPE = COMMITMENT_INSTRUMENT_TYPE;

/** The commitment key, named once so the envelope filter and nothing else can drift from it. */
const COMMITMENT_KEY = "commitment-draws";

export const LCR_KEYS: CustomMetricKey[] = [
  { id: "hqla", label: "HQLA after haircuts and caps, as-of balance", unit: "currency" },
  { id: "outflows-30d", label: "Outflows in the first month", unit: "currency" },
  { id: "inflows-30d", label: "Inflows counted, after the 75 percent cap", unit: "currency" },
  { id: "net-outflows", label: "Outflows less counted inflows", unit: "currency" },
  { id: COMMITMENT_KEY, label: "Committed-line draws counted as outflow", unit: "currency" },
  { id: "lcr", label: "HQLA over net outflows", unit: "fraction" },
];

/**
 * The two numbers an outflow arm produces: the total that enters the ratio, and
 * the commitment part of it, which is UNDEFINED rather than 0 when the arm has
 * no commitment to observe. Internal: the metric contract's surface is the
 * values map, not this shape, so it is deliberately not exported.
 */
interface OutflowParts {
  total: number;
  /** Absent, never 0, when there is no commitment draw to observe. */
  commitmentDraws: number | undefined;
}

type OutflowFn = (families: readonly FamilyCashflows[], book: PortfolioSpec) => OutflowParts;

export function computeLcrScenario(input: CustomMetricInput): CustomMetricResult {
  return compute(input, "lcr-scenario", "LCR on scenario flows (under each scenario's own assumptions)", () => scenarioOutflows);
}

export function computeLcrRegulatory(input: CustomMetricInput): CustomMetricResult {
  return compute(
    input,
    "lcr-regulatory",
    "LCR, US rule run-off rates (demonstration rates; no peak-day add-on)",
    (book) => {
      const rates = liabilityRates(book);
      const commitRates = commitmentRates(book);
      // Either map refusing is the same refusal: a category the table does not
      // name is not a zero, it is a number this metric cannot read.
      if (rates === undefined || commitRates === undefined) return undefined;
      // Hoisted out of the per-scenario call ON PURPOSE. This arm reads the
      // BOOK and nothing else, so computing it once makes the pinned
      // scenario-invariance structural, the same number handed to every
      // scenario, rather than a consequence a later edit could quietly break.
      // It also keeps a loop over the position count off the per-scenario path.
      const commitment = commitmentOutflow(book, commitRates);
      return (families) => regulatoryOutflows(families, book, rates, commitment);
    },
  );
}

function compute(
  input: CustomMetricInput,
  metricId: string,
  label: string,
  outflowFor: (book: PortfolioSpec) => OutflowFn | undefined,
): CustomMetricResult {
  const classes = classifyBufferFamilies(input.book);
  const outflows = outflowFor(input.book);
  const ok = classes !== undefined && hasBufferFamily(classes) && outflows !== undefined;
  return {
    metricId,
    label,
    keys: declaredKeys(input.book),
    byScenario: input.scenarios.map(({ scenarioId, cashflows }) => ({
      scenarioId,
      values: ok ? values(cashflows.byFamily, classes!, input.book, input.horizonMonths, outflows!) : {},
    })),
  };
}

function values(
  families: readonly FamilyCashflows[],
  classes: ReadonlyMap<string, BufferClass>,
  book: PortfolioSpec,
  horizon: number,
  outflows: OutflowFn,
): Record<string, number> {
  const hqla = cappedHqla(bufferLevels(families, classes));
  if (horizon < 1) return { hqla };
  const out = outflows(families, book);
  const inCounted = Math.min(inflows(families, classes, book), INFLOW_CAP * out.total);
  const net = out.total - inCounted;
  const v: Record<string, number> = {
    hqla,
    "outflows-30d": out.total,
    "inflows-30d": inCounted,
    "net-outflows": net,
  };
  // Absence, never zero: a book with no commitment carries no commitment line.
  if (out.commitmentDraws !== undefined) v[COMMITMENT_KEY] = out.commitmentDraws;
  if (out.total > 0) v.lcr = hqla / net;
  return v;
}

function familyDefs(book: PortfolioSpec): Map<string, { side: string; instrumentType: string }> {
  return new Map(book.coa.families.map((f) => [f.id, { side: f.side, instrumentType: f.instrumentType }]));
}

/** Family ids whose instrument type is the commitment arm. */
function commitmentFamilies(book: PortfolioSpec): Set<string> {
  return new Set(
    book.coa.families.filter((f) => f.instrumentType === COMMITMENT_TYPE).map((f) => f.id),
  );
}

/**
 * The declared envelope: all six keys for a book with a commitment family, the
 * five pre-commitment keys otherwise.
 *
 * DYNAMIC BECAUSE IT IS FORCED, not because dynamic is better. This repo's own
 * pattern is the opposite: a declared key no scenario observes is rendered as
 * UNOBSERVABLE, and `lcr` itself is declared unconditionally and omitted when
 * outflows are not positive. Three constraints leave no static envelope:
 * `lcr.test.ts:102` pins `keys` to exactly the five pre-commitment ids for a
 * commitment-free book and may not be edited; the suite requires
 * `commitment-draws` on the exported `LCR_KEYS`; and C4 of
 * `validateCustomMetricResult` forbids a row carrying a key `keys` does not
 * declare, so the key cannot simply be emitted undeclared. Pinned by the
 * envelope tests in `lcrCommitments.test.ts`.
 */
function declaredKeys(book: PortfolioSpec): CustomMetricKey[] {
  if (commitmentFamilies(book).size > 0) return LCR_KEYS;
  return LCR_KEYS.filter((k) => k.id !== COMMITMENT_KEY);
}

/** Half of month-1 principal plus interest of every non-buffer asset family. */
function inflows(
  families: readonly FamilyCashflows[],
  classes: ReadonlyMap<string, BufferClass>,
  book: PortfolioSpec,
): number {
  const defs = familyDefs(book);
  const commits = commitmentFamilies(book);
  let total = 0;
  for (const fam of families) {
    // A commitment family is asset-side, so it would otherwise land here. A draw
    // is a NEGATIVE principalPaid, so it would reduce inflows and the ratio
    // would come out roughly right by accident while the draw never appeared as
    // an outflow. It belongs in the outflow arm. Independently: voluntary
    // repayment of drawn lines collapses in exactly the state being stressed,
    // so netting anything commitment-side against stressed outflow understates
    // the need.
    if (commits.has(fam.familyId)) continue;
    const def = defs.get(fam.familyId);
    const cls = classes.get(fam.familyId);
    if (def === undefined || cls === undefined || cls.kind === "buffer" || def.side !== "asset") continue;
    total += INFLOW_FACTOR * ((fam.series.principal[0] ?? 0) + (fam.series.interest[0] ?? 0));
  }
  return total;
}

/**
 * Month-1 principal plus interest of every liability family, as projected, plus
 * month-1 committed-line draws read off the same FLOWS.
 */
function scenarioOutflows(families: readonly FamilyCashflows[], book: PortfolioSpec): OutflowParts {
  const defs = familyDefs(book);
  const commits = commitmentFamilies(book);
  let total = 0;
  let draws = 0;
  let anyCommitment = false;
  for (const fam of families) {
    if (commits.has(fam.familyId)) {
      anyCommitment = true;
      // Only the drawdown part: a stray positive must never subtract.
      draws += -Math.min(fam.series.principal[0] ?? 0, 0);
      continue;
    }
    if (defs.get(fam.familyId)?.side !== "liability") continue;
    total += (fam.series.principal[0] ?? 0) + (fam.series.interest[0] ?? 0);
  }
  return { total: total + draws, commitmentDraws: anyCommitment ? draws : undefined };
}

/**
 * Rate per liability family, or undefined when any liability family with
 * positions does not carry one known category on every position.
 */
function liabilityRates(book: PortfolioSpec): Map<string, number> | undefined {
  const seen = new Map<string, Set<string>>();
  for (const pos of book.positions) {
    const s = seen.get(pos.familyId) ?? new Set<string>();
    const raw = pos.dimensions?.[LCR_CATEGORY_DIMENSION];
    // Untagged, and a list value, are both "not one known category".
    s.add(typeof raw === "string" ? raw : "(untagged)");
    seen.set(pos.familyId, s);
  }
  const rates = new Map<string, number>();
  for (const def of book.coa.families) {
    if (def.side !== "liability") continue;
    const cats = seen.get(def.id);
    if (cats === undefined) continue; // a family with no positions has no flows to rate
    const only = cats.size === 1 ? [...cats][0]! : undefined;
    // Own keys only: a category such as "constructor" must not reach the prototype.
    if (only === undefined || !Object.hasOwn(US_LCR_RUNOFF_DEMO, only)) return undefined;
    rates.set(def.id, US_LCR_RUNOFF_DEMO[only]!);
  }
  return rates;
}

/**
 * Rate per COMMITMENT family, or undefined when any commitment family with
 * positions does not carry one known category on every position. Shaped exactly
 * like `liabilityRates`, and refusing for exactly the same reason.
 *
 * A book with NO commitment family yields an EMPTY map, which is defined and
 * refuses nothing: the metric proceeds and simply emits no commitment key. Only
 * a commitment family the table cannot rate returns undefined.
 */
function commitmentRates(book: PortfolioSpec): Map<string, number> | undefined {
  const seen = new Map<string, Set<string>>();
  for (const pos of book.positions) {
    const s = seen.get(pos.familyId) ?? new Set<string>();
    const raw = pos.dimensions?.[COMMITMENT_CATEGORY_DIMENSION];
    // Untagged, and a list value, are both "not one known category".
    s.add(typeof raw === "string" ? raw : "(untagged)");
    seen.set(pos.familyId, s);
  }
  const rates = new Map<string, number>();
  for (const def of book.coa.families) {
    if (def.instrumentType !== COMMITMENT_TYPE) continue;
    const cats = seen.get(def.id);
    if (cats === undefined) continue; // a family with no positions has no capacity to rate
    const only = cats.size === 1 ? [...cats][0]! : undefined;
    // Own keys only: a category such as "constructor" must not reach the prototype.
    if (only === undefined || !Object.hasOwn(US_LCR_COMMITMENT_DEMO, only)) return undefined;
    rates.set(def.id, US_LCR_COMMITMENT_DEMO[only]!);
  }
  return rates;
}

/**
 * Rate times UNDRAWN, read off the BOOK rather than the flows, and undefined
 * when no position carries a commitment rate.
 *
 * The book, not `balance[0]`, for two reasons. A commitment with no draw
 * overlay emits no cashflows at all, so a flow lookup would silently rate it at
 * zero, which is the failure mode this whole arm exists to avoid. And it is the
 * rule's own reading: 249.32(e) rates the undrawn amount whether or not the
 * bank's model projects a draw. Hence the number is scenario-invariant.
 */
function commitmentOutflow(
  book: PortfolioSpec,
  commitRates: ReadonlyMap<string, number>,
): number | undefined {
  let draws = 0;
  let anyCommitment = false;
  for (const pos of book.positions) {
    const rate = commitRates.get(pos.familyId);
    if (rate === undefined) continue;
    anyCommitment = true;
    draws += rate * pos.terms.notional;
  }
  return anyCommitment ? draws : undefined;
}

function regulatoryOutflows(
  families: readonly FamilyCashflows[],
  book: PortfolioSpec,
  rates: ReadonlyMap<string, number>,
  commitmentDraws: number | undefined,
): OutflowParts {
  const defs = familyDefs(book);
  let total = 0;
  for (const fam of families) {
    const def = defs.get(fam.familyId);
    const rate = rates.get(fam.familyId);
    if (def === undefined || rate === undefined) continue;
    const base = NMD_TYPES.has(def.instrumentType) ? (fam.series.balance[0] ?? 0) : (fam.series.principal[0] ?? 0);
    total += rate * base;
  }
  return { total: total + (commitmentDraws ?? 0), commitmentDraws };
}
