/**
 * Seeded synthetic balance-sheet generator.
 *
 * One master seed drives the whole book through the kernel's PCG32. Each product
 * family draws from its own derived sub-stream, keyed by a fixed `streamId`, so
 * families generate independently and adding or reordering a family does not
 * perturb another family's draws. Within a family, position `i` is generated in
 * order and its id is deterministic (`familyId-i`), so the book is a pure
 * function of the master seed: no Date.now, no Math.random, no map-iteration
 * order in any path.
 *
 * The generator emits typed @alm/engine objects only (a PortfolioSpec and its
 * ChartOfAccounts). Behavioral parameter blocks the frozen kernel terms require
 * (cprParams, nmdParams, sCurve) are filled from the kernel defaults and shared
 * by reference across a family's positions: a position embeds no *authored*
 * behavior; the run's assumption set is the swappable behavioral layer that the
 * engine resolves by familyId. Only economic terms (notional,
 * maturity, coupon, seasoning) are drawn per position.
 */
import type {
  CdCohortSpec,
  CdTerms,
  EngineInstrumentType,
  PortfolioSpec,
  Position,
  ProductFamilyId,
  BalanceSheetSide,
} from "@alm/engine";
import type {
  AmortType,
  FixedLoanTerms,
  FloatingLoanTerms,
  MortgageTerms,
  NMDBetaTerms,
  NMDTerms,
} from "@alm/kernel";
import {
  PCG32,
  CD_DEFAULT_PARAMS,
  MBS_DEFAULTS,
  NMD_DEFAULTS,
  BETA_S_CURVE_DEFAULTS,
  IB_BUCKETS,
} from "@alm/kernel";
import { validateCdTerms } from "@alm/engine/src/cd/terms";
import { buildChartOfAccounts, EQUITY_NODE_ID } from "./coa";

/** Inclusive integer / continuous range drawn uniformly. */
type Range = readonly [number, number];

/** Per-family generation recipe: catalogue identity plus economic draw bands. */
export interface FamilyGenSpec {
  id: ProductFamilyId;
  side: BalanceSheetSide;
  instrumentType: EngineInstrumentType;
  coaNodeId: string;
  /** PCG32 stream partition. Fixed per family, never reused. */
  streamId: number;
  /** Share of the total position count. Shares across families sum to 1. */
  weight: number;
  /** Notional draw band, dollars. */
  notional: Range;
  /** Remaining-maturity draw band, months. */
  maturityMonths: Range;
  /** Coupon / note-rate / margin draw band, decimal annualised. */
  rate: Range;
  /**
   * Seasoning magnitude draw band, months. Feeds the mortgage's native
   * behavioral age (ageMonths, originalTermMonths); every emitted term set is
   * anchored at the as-of date (remaining representation), so
   * `originationOffsetMonths` is stamped 0 for all types. Before
   * wave 2 the generator stamped the negative of this draw as metadata the
   * engine ignored; under the D3a ruling a nonzero offset now means an
   * origination-anchored stream the engine re-anchors, which these terms are
   * not, so stamping it would misdescribe the book.
   */
  seasoningMonths: Range;
  amortType: AmortType;
  /**
   * Optional dollar total for the family. After the draw loop the family's drawn
   * notionals are rescaled by one common factor to sum to exactly this many whole dollars, before liability
   * conservation; conservation then leaves a family that carries a target alone. The draw itself is unchanged,
   * so the PCG32 streams and every other family are untouched; absent, nothing here runs and the output is
   * byte-identical to the generator without this field. Not supported for the cd cohort-book family.
   */
  targetDollars?: number;
}

/** Immutable master configuration the fixture reproduces from. */
export interface GeneratorConfig {
  portfolioId: string;
  portfolioLabel: string;
  asOf: string;
  masterSeed: number;
  /**
   * Total number of DRAWS across families (largest-remainder allocation by
   * weight). Since W3-A2b the emitted position count is smaller: a "cd"
   * family's draws fold into one cohort-book position (its share of draws
   * becomes cohorts, not positions).
   */
  targetPositions: number;
  /** Equity / assets target; liabilities are scaled to hit it (conservation). */
  capitalRatio: number;
  families: readonly FamilyGenSpec[];
}

/**
 * The eleven-family catalogue. Bands are advisory synthetic ranges: no bank
 * data, no client resemblance beyond generic product families.
 */
export const FAMILY_GEN_SPECS: readonly FamilyGenSpec[] = [
  { id: "cash", side: "asset", instrumentType: "fixed-loan", coaNodeId: "coa-cash", streamId: 0, weight: 0.01, notional: [5_000_000, 50_000_000], maturityMonths: [1, 3], rate: [0.03, 0.05], seasoningMonths: [0, 0], amortType: "bullet" },
  { id: "investments", side: "asset", instrumentType: "fixed-loan", coaNodeId: "coa-investments", streamId: 1, weight: 0.04, notional: [1_000_000, 25_000_000], maturityMonths: [12, 120], rate: [0.03, 0.06], seasoningMonths: [0, 60], amortType: "bullet" },
  { id: "fixed-loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "coa-fixed-loans", streamId: 2, weight: 0.15, notional: [50_000, 2_000_000], maturityMonths: [12, 120], rate: [0.05, 0.09], seasoningMonths: [0, 60], amortType: "level-pay" },
  { id: "floating-loans", side: "asset", instrumentType: "floating-loan", coaNodeId: "coa-floating-loans", streamId: 3, weight: 0.12, notional: [100_000, 5_000_000], maturityMonths: [12, 120], rate: [0.01, 0.03], seasoningMonths: [0, 60], amortType: "level-pay" },
  { id: "mortgages", side: "asset", instrumentType: "mortgage", coaNodeId: "coa-mortgages", streamId: 4, weight: 0.30, notional: [100_000, 800_000], maturityMonths: [240, 360], rate: [0.04, 0.075], seasoningMonths: [0, 120], amortType: "level-pay" },
  { id: "mbs", side: "asset", instrumentType: "mortgage", coaNodeId: "coa-mbs", streamId: 5, weight: 0.03, notional: [5_000_000, 50_000_000], maturityMonths: [300, 360], rate: [0.04, 0.07], seasoningMonths: [0, 60], amortType: "level-pay" },
  { id: "dda", side: "liability", instrumentType: "nmd", coaNodeId: "coa-dda", streamId: 6, weight: 0.15, notional: [5_000, 250_000], maturityMonths: [360, 360], rate: [0, 0], seasoningMonths: [0, 60], amortType: "level-pay" },
  { id: "mma", side: "liability", instrumentType: "nmd-b", coaNodeId: "coa-mma", streamId: 7, weight: 0.12, notional: [10_000, 500_000], maturityMonths: [360, 360], rate: [0, 0], seasoningMonths: [0, 60], amortType: "level-pay" },
  { id: "cds", side: "liability", instrumentType: "cd", coaNodeId: "coa-cds", streamId: 8, weight: 0.06, notional: [10_000, 250_000], maturityMonths: [3, 60], rate: [0.03, 0.055], seasoningMonths: [0, 24], amortType: "bullet" },
  { id: "fhlb", side: "liability", instrumentType: "fixed-loan", coaNodeId: "coa-fhlb", streamId: 9, weight: 0.01, notional: [5_000_000, 100_000_000], maturityMonths: [3, 60], rate: [0.035, 0.055], seasoningMonths: [0, 12], amortType: "bullet" },
  { id: "borrowings", side: "liability", instrumentType: "fixed-loan", coaNodeId: "coa-borrowings", streamId: 10, weight: 0.01, notional: [5_000_000, 50_000_000], maturityMonths: [12, 120], rate: [0.04, 0.07], seasoningMonths: [0, 24], amortType: "bullet" },
];

export const DEFAULT_GENERATOR_CONFIG: GeneratorConfig = {
  portfolioId: "synthetic-book-v1",
  portfolioLabel: "Synthetic ALM Balance Sheet (100k positions)",
  asOf: "2026-03-31",
  masterSeed: 20260716,
  targetPositions: 100_000,
  capitalRatio: 0.1,
  families: FAMILY_GEN_SPECS,
};

// Behavioral blocks shared by reference across a family's positions. One object
// each: the 100k book holds ~one behavioral block per family, not 100k copies.
const MMA_NMD_PARAMS = { ...NMD_DEFAULTS, buckets: IB_BUCKETS };

/** Uniform draw in [lo, hi). */
function uniform(rng: PCG32, [lo, hi]: Range): number {
  return lo + (hi - lo) * rng.nextUniform();
}

/** Uniform integer draw in [lo, hi] inclusive. */
function uniformInt(rng: PCG32, [lo, hi]: Range): number {
  if (hi <= lo) return lo;
  return lo + Math.floor(rng.nextUniform() * (hi - lo + 1));
}

/** Whole-dollar notional (keeps the balance sheet integer-exact at t=0). */
function drawNotional(rng: PCG32, band: Range): number {
  return Math.max(1, Math.round(uniform(rng, band)));
}

/** Rate rounded to 4 decimals (1bp grain) for a stable, clean hash. */
function drawRate(rng: PCG32, band: Range): number {
  return Math.round(uniform(rng, band) * 1e4) / 1e4;
}

/**
 * Allocate integer per-family counts summing exactly to `total`, from weights.
 * Largest-remainder method with a deterministic index tie-break: no float
 * iteration-order dependence.
 */
export function allocateCounts(weights: readonly number[], total: number): number[] {
  const raw = weights.map((w) => w * total);
  const counts = raw.map(Math.floor);
  const used = counts.reduce((a, b) => a + b, 0);
  const remainder = total - used;
  const order = raw
    .map((r, i) => ({ frac: r - Math.floor(r), i }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < remainder; k++) counts[order[k].i] += 1;
  return counts;
}

/**
 * Rescale one family's positions so their notionals sum to exactly `target` whole dollars. One common factor
 * keeps the drawn size ratios; the floors are topped up by largest remainder (index tie-break) so the integer
 * total is exact rather than within rounding. A mortgage's original balance follows its notional.
 */
function rescaleFamilyToTarget(fam: FamilyGenSpec, members: Position[], target: number): void {
  if (!(target > 0) || !Number.isFinite(target)) {
    throw new Error(`Family ${fam.id} has targetDollars ${String(target)}; a dollar target must be a positive number.`);
  }
  if (members.length === 0) {
    throw new Error(`Family ${fam.id} has targetDollars ${target} but no drawn positions to rescale.`);
  }
  const targetWhole = Math.round(target);
  const drawn = members.reduce((a, p) => a + p.terms.notional, 0);
  const raw = members.map((p) => (p.terms.notional * targetWhole) / drawn);
  const floors = raw.map(Math.floor);
  const left = targetWhole - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ frac: r - Math.floor(r), i }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < left; k++) floors[order[k].i] += 1;
  for (let i = 0; i < members.length; i++) {
    const p = members[i];
    p.terms.notional = floors[i];
    if (p.terms.type === "mortgage") p.terms.originalBalance = floors[i];
  }
}

// --- CD cohort-book fold -----------------------------------

/**
 * Kernel CD term buckets (cdBook TERM_BUCKET_MAP members), ascending. A drawn
 * CD's ORIGINAL term is snapped UP to the smallest member that covers the
 * drawn remaining maturity plus seasoning (capped at 60m, the longest bucket).
 */
const CD_TERM_BUCKETS: readonly number[] = [1, 2, 3, 6, 9, 12, 18, 24, 36, 48, 60];

/** Stylized-unit scale of the kernel CD walk: walk dollars = balance * this. */
const CD_WALK_SCALE = CD_DEFAULT_PARAMS.walkScale;

/** Smallest kernel term bucket >= x (x is capped to the 60m top bucket first). */
function cdTermBucketAtLeast(x: number): number {
  const capped = Math.min(x, CD_TERM_BUCKETS[CD_TERM_BUCKETS.length - 1]);
  for (const b of CD_TERM_BUCKETS) {
    if (b >= capped) return b;
  }
  return CD_TERM_BUCKETS[CD_TERM_BUCKETS.length - 1];
}

/**
 * Fold a CD family's `n` draws into ONE cohort-book position.
 *
 * Why one position, not one per draw: the kernel competing-risk walk's
 * severity part-1 log-balance covariate is standardized LIVE each month
 * against the cross-section of live cohorts, so the family book must be
 * walked JOINTLY — 6,000 isolated single-cohort walks would be a different
 * (degenerate) model (packages/engine/src/cd/terms.ts header; W2-A2 report).
 *
 * Determinism and draw continuity: the PCG32 stream consumption per draw is
 * EXACTLY the pre-flip buildTerms order (notional, rate, maturity, seasoning),
 * so this family's stream — and, because family streams are independent,
 * every other family's book — is unchanged by the fold. The
 * pre-scale position notional is the exact sum of the drawn notionals, so the
 * liability-scaling factor and hence every other liability position is also
 * unchanged.
 *
 * Cohort construction: draws group by (original term bucket, months to
 * maturity); the original term is remaining maturity plus the seasoning draw,
 * snapped up to a kernel term bucket (capped 60m). Group balance is the dollar
 * sum divided by the kernel walk scale, so WALK dollars equal actual cohort
 * dollar sizes — the calibrated log-balance hazard covariate reads real cohort
 * magnitudes. Group contract rate is the balance-weighted
 * mean, which reproduces the group's aggregate coupon exactly.
 */
function buildCdFamilyPosition(fam: FamilyGenSpec, rng: PCG32, n: number): Position | null {
  if (n === 0) return null;
  interface CdGroup {
    termMonths: number;
    monthsToMaturity: number;
    dollars: number;
    rateDollars: number;
  }
  const groups = new Map<string, CdGroup>();
  let totalDollars = 0;
  for (let i = 0; i < n; i++) {
    // Same draw order as buildTerms: notional, rate, maturity, seasoning.
    const notional = drawNotional(rng, fam.notional);
    const rate = drawRate(rng, fam.rate);
    const maturityMonths = uniformInt(rng, fam.maturityMonths);
    const seasoning = uniformInt(rng, fam.seasoningMonths);
    const termMonths = cdTermBucketAtLeast(maturityMonths + seasoning);
    totalDollars += notional;
    const key = `${termMonths}|${maturityMonths}`;
    const g = groups.get(key);
    if (g) {
      g.dollars += notional;
      g.rateDollars += notional * rate;
    } else {
      groups.set(key, {
        termMonths,
        monthsToMaturity: maturityMonths,
        dollars: notional,
        rateDollars: notional * rate,
      });
    }
  }
  // Deterministic cohort order: ascending (monthsToMaturity, termMonths). The
  // sort key is unique per group by construction, so the order is total.
  const cohorts: CdCohortSpec[] = [...groups.values()]
    .sort((a, b) => a.monthsToMaturity - b.monthsToMaturity || a.termMonths - b.termMonths)
    .map((g) => ({
      termMonths: g.termMonths,
      monthsToMaturity: g.monthsToMaturity,
      balance: g.dollars / CD_WALK_SCALE,
      contractRate: g.rateDollars / g.dollars,
    }));
  let maturityMonths = 0;
  for (const c of cohorts) maturityMonths = Math.max(maturityMonths, c.monthsToMaturity);
  const id = `${fam.id}-0`;
  const terms: CdTerms = {
    id,
    type: "cd",
    label: "CD cohort book",
    notional: totalDollars,
    maturityMonths,
    originationOffsetMonths: 0,
    amortType: "bullet",
    side: "liability",
    cohorts,
  };
  validateCdTerms(terms);
  return { id, familyId: fam.id, coaNodeId: fam.coaNodeId, terms };
}

/** Build the kernel terms for one drawn position. */
function buildTerms(
  fam: FamilyGenSpec,
  id: string,
  rng: PCG32,
): Position["terms"] {
  const notional = drawNotional(rng, fam.notional);
  const rate = drawRate(rng, fam.rate);
  const maturityMonths = uniformInt(rng, fam.maturityMonths);
  // The seasoning draw is kept for EVERY family so the PCG32 stream (and thus
  // every other drawn value in the committed book) is unchanged by the W2-A3
  // re-stamp; only the mortgage consumes it (ageMonths / originalTermMonths).
  const seasoning = uniformInt(rng, fam.seasoningMonths);
  // All emitted terms are anchored at the as-of date (remaining
  // representation), so the origination offset is 0 by definition; see the
  // FamilyGenSpec.seasoningMonths note and packages/engine/src/portfolio/seasoning.ts.
  const originationOffsetMonths = 0;

  switch (fam.instrumentType) {
    case "fixed-loan": {
      const terms: FixedLoanTerms = {
        id,
        type: "fixed-loan",
        notional,
        maturityMonths,
        originationOffsetMonths,
        amortType: fam.amortType,
        side: fam.side === "asset" ? "asset" : "liability",
        coupon: rate,
      };
      return terms;
    }
    case "floating-loan": {
      const terms: FloatingLoanTerms = {
        id,
        type: "floating-loan",
        notional,
        maturityMonths,
        originationOffsetMonths,
        amortType: fam.amortType,
        side: fam.side === "asset" ? "asset" : "liability",
        indexTenorMonths: 1,
        margin: rate,
        resetFrequencyMonths: 1,
      };
      return terms;
    }
    case "mortgage": {
      // Seasoned pool: age = seasoning, remaining maturity as drawn, original
      // term = age + remaining. cprParams shared from the kernel default.
      const terms: MortgageTerms = {
        id,
        type: "mortgage",
        notional,
        maturityMonths,
        originationOffsetMonths,
        amortType: fam.amortType,
        side: "asset",
        noteRate: rate,
        originalTermMonths: maturityMonths + seasoning,
        originalBalance: notional,
        ageMonths: seasoning,
        cprParams: MBS_DEFAULTS,
      };
      return terms;
    }
    case "nmd": {
      const terms: NMDTerms = {
        id,
        type: "nmd",
        notional,
        maturityMonths,
        originationOffsetMonths,
        amortType: fam.amortType,
        side: "liability",
        depositRate: 0,
        beta: 0,
        nmdParams: NMD_DEFAULTS,
      };
      return terms;
    }
    case "nmd-b": {
      const terms: NMDBetaTerms = {
        id,
        type: "nmd-b",
        notional,
        maturityMonths,
        originationOffsetMonths,
        amortType: fam.amortType,
        side: "liability",
        sCurve: BETA_S_CURVE_DEFAULTS,
        nmdParams: MMA_NMD_PARAMS,
      };
      return terms;
    }
    case "cd":
      // CD families fold their draws into one cohort-book position at the
      // family level (buildCdFamilyPosition); a per-draw cd terms object would
      // be the degenerate single-cohort model. generatePortfolio never routes
      // a cd family here.
      throw new Error(
        `buildTerms: cd terms are built per family by buildCdFamilyPosition, not per draw`,
      );
    case "commitment":
      // Piece 7 widened the engine union; the synthetic generator has no
      // commitment family and no authored draw path to draw one from. Refusing
      // is the anti-fabrication rule: inventing a draw path here would put
      // invented behavioral numbers into every generated book.
      throw new Error(
        `buildTerms: commitment terms are not generated synthetically; a committed line needs an ` +
          `authored draw path (packages/engine/src/commitment/terms.ts)`,
      );
    case "swap":
      // Piece 8 widened the engine union; the synthetic generator has no
      // derivative family. Refusing is the anti-fabrication rule: a swap is a
      // hedge the bank authors, never a draw from a synthetic catalogue.
      throw new Error(
        `buildTerms: swap terms are not generated synthetically; a swap is an authored hedge ` +
          `(packages/engine/src/swap/terms.ts)`,
      );
    case "non-rate-sensitive":
      // S3a-1 follow-up: a book balance is authored, never drawn from the synthetic catalogue.
      throw new Error("buildTerms: non-rate-sensitive balances are not generated synthetically (packages/engine/src/nonRate)");
    default: {
      // Exhaustive over the widened engine union.
      const never: never = fam.instrumentType;
      throw new Error(`unsupported instrument type ${String(never)}`);
    }
  }
}

/**
 * Generate the full synthetic PortfolioSpec from a config. Pure function of the
 * config (hence of the master seed). Liabilities are scaled once, after drawing,
 * so total liabilities equal assets times (1 - capitalRatio): the equity plug is
 * assets minus liabilities, positive by construction (conservation at t=0).
 */
export function generatePortfolio(config: GeneratorConfig): PortfolioSpec {
  const families = config.families;
  const counts = allocateCounts(families.map((f) => f.weight), config.targetPositions);

  for (const fam of families) {
    if (fam.targetDollars !== undefined && fam.instrumentType === "cd") {
      throw new Error(
        `Family ${fam.id} is a cd cohort book and cannot carry targetDollars; its cohort balances are walk units, not dollars.`,
      );
    }
  }

  const positions: Position[] = [];
  for (let f = 0; f < families.length; f++) {
    const fam = families[f];
    const rng = new PCG32(config.masterSeed, fam.streamId);
    const n = counts[f];
    if (fam.instrumentType === "cd") {
      // The family's n draws fold into one cohort-book position; the
      // stream consumption per draw is identical to the per-position path, so
      // no other family's draws move.
      const pos = buildCdFamilyPosition(fam, rng, n);
      if (pos) positions.push(pos);
      continue;
    }
    for (let i = 0; i < n; i++) {
      const id = `${fam.id}-${i}`;
      positions.push({
        id,
        familyId: fam.id,
        coaNodeId: fam.coaNodeId,
        terms: buildTerms(fam, id, rng),
      });
    }
  }

  // Dollar targets: rescale a targeted family after the draw loop and before conservation.
  for (const fam of families) {
    if (fam.targetDollars === undefined) continue;
    rescaleFamilyToTarget(
      fam,
      positions.filter((p) => p.familyId === fam.id),
      fam.targetDollars,
    );
  }
  const targeted = new Set<ProductFamilyId>(
    families.filter((f) => f.targetDollars !== undefined).map((f) => f.id),
  );

  // Conservation: scale liability notionals so equity/assets = capitalRatio. A family that carries a dollar
  // target keeps it: its dollars come off the liability total and only the untargeted liabilities scale.
  const sideOf = new Map<ProductFamilyId, BalanceSheetSide>(families.map((f) => [f.id, f.side]));
  let assetTotal = 0;
  let liabRaw = 0;
  let liabFixed = 0;
  for (const p of positions) {
    if (sideOf.get(p.familyId) === "asset") assetTotal += p.terms.notional;
    else if (targeted.has(p.familyId)) liabFixed += p.terms.notional;
    else liabRaw += p.terms.notional;
  }
  // Every liability family carries a dollar target: nothing is left to scale, so the book must add up by itself.
  const liabFamilies = families.filter((f) => f.side !== "asset");
  if (liabFamilies.length > 0 && liabFamilies.every((f) => f.targetDollars !== undefined) && assetTotal > 0) {
    const equityRatio = (assetTotal - liabFixed) / assetTotal;
    if (Math.abs(equityRatio - config.capitalRatio) > 1e-9) {
      throw new Error(
        `Every liability family carries targetDollars, so no liability can scale to the capitalRatio: assets are ${assetTotal} and the targeted liabilities ${liabFixed}, an equity ratio of ${equityRatio}, not the capitalRatio ${config.capitalRatio}. Change the targets or the capitalRatio so the book adds up.`,
      );
    }
  }
  const targetLiab = Math.round(assetTotal * (1 - config.capitalRatio)) - liabFixed;
  if (liabRaw > 0 && targetLiab <= 0) {
    throw new Error(
      `The liability families with dollar targets already total ${liabFixed}, which leaves nothing for the untargeted liabilities at capital ratio ${config.capitalRatio}.`,
    );
  }
  const scale = liabRaw > 0 ? targetLiab / liabRaw : 1;
  for (const p of positions) {
    if (sideOf.get(p.familyId) !== "asset" && !targeted.has(p.familyId)) {
      const scaledNotional = Math.max(1, Math.round(p.terms.notional * scale));
      if (p.terms.type === "cd") {
        // Cohort balances (stylized walk units) scale with the family notional
        // so walk dollars keep tracking the scaled cohort dollar sizes — the
        // hazard's calibrated log-balance covariate reads walk dollars (W2-A2
        // NOTE 2). Fresh terms object: cohorts is a readonly array.
        p.terms = {
          ...p.terms,
          notional: scaledNotional,
          cohorts: p.terms.cohorts.map((c) => ({ ...c, balance: c.balance * scale })),
        };
        continue;
      }
      p.terms.notional = scaledNotional;
      if (p.terms.type === "mortgage") p.terms.originalBalance = p.terms.notional;
    }
  }

  return {
    id: config.portfolioId,
    label: config.portfolioLabel,
    asOf: config.asOf,
    coa: buildChartOfAccounts(),
    positions,
  };
}

export interface BalanceSheetTotals {
  assets: number;
  liabilities: number;
  equity: number;
  equityNodeId: string;
}

/**
 * Sum notionals by side at t=0. Equity is the derived plug (assets minus
 * liabilities): the balance sheet balances by construction, and the node it
 * attaches to is the single equity node in the chart of accounts.
 */
export function computeBalanceSheetTotals(spec: PortfolioSpec): BalanceSheetTotals {
  const sideOf = new Map(spec.coa.families.map((f) => [f.id, f.side]));
  let assets = 0;
  let liabilities = 0;
  for (const p of spec.positions) {
    if (sideOf.get(p.familyId) === "asset") assets += p.terms.notional;
    else liabilities += p.terms.notional;
  }
  return { assets, liabilities, equity: assets - liabilities, equityNodeId: EQUITY_NODE_ID };
}
