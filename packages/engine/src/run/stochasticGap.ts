/**
 * The stochastic gap: SEG repricing and EBP liquidity distributions across the Hull-White path set.
 *
 * Method (the spike method): for each path p, computeSegBlock (seg/computeSeg.ts,
 * unchanged) runs on env.paths[p] as its base path, so the block re-shocks around that path's own rates with the
 * kernel ShockedPath. The block's family series fold to the chart-of-accounts top level, are banded, and the
 * block, its per-position rows included, is dropped before the next path. Only the banded top-level numbers of
 * every path are kept: nPaths x bands x measures. The COA arm is internal to the fold and not stored per node.
 *
 * Bands: buildBands(120), the eight bands 0-1M to 5-10Y. The ninth standard band (10Y+) starts at the horizon and
 * cannot fill; what is still outstanding at month 120 is the explicit beyondHorizon line, never dropped.
 *
 *   repricing (SEG, signed net)  band [s, e):  out(s) - out(e)          beyond: out(120)
 *   liquidity (EBP, by side, balance)   band [s, e):  E(s) - E(e)              beyond: E(120)
 *     where E(m) is the EBP of month m + 1 (the block's ebp[m], the average outstanding balance of that month)
 *     for m < 120, and E(120) is the EBP of month 120 (ebp[119]), the last month the block carries.
 *
 * Both telescope: the repricing bands plus beyond sum to out(0), the signed net notional the block covers; the
 * liquidity run-off plus beyond sums to the month-1 EBP balance, by side. Cumulative figures are running sums of a
 * path's own band values, summarised afterwards, never a sum of band quantiles. EBP carries no interest.
 *
 * Refusals (rulings 1 to 3), all before any path is simulated: an option other than { enabled: true }, BGM, a run
 * grid too short for the block to read its paths, and more than 100,000 position-paths.
 *
 * Determinism: paths in index order, positions in book order, families in chart-of-accounts order, roots in node
 * order; plain ordered sums; no clock, no RNG.
 */
import type { Instrument, RatePath } from "@alm/kernel";
import type { ChartOfAccounts } from "../contracts/chartOfAccounts";
import type { BalanceSheetSide } from "../contracts/ids";
import type { PortfolioSpec, Position } from "../contracts/position";
import type { GapBand, SegResult } from "../contracts/results";
import {
  STOCHASTIC_GAP_HORIZON_MONTHS,
  STOCHASTIC_GAP_SIZE_CAP,
  type StochasticGapBlock,
  type StochasticGapOption,
  type StochasticLiquidityBand,
  type StochasticModel,
  type StochasticRepricingBand,
  type StochasticSideDistributions,
} from "../contracts/stochastic";
import { buildBands } from "../gap/bands";
import { computeSegBlock, SEG_DEFAULTS, type PositionSegRow } from "../seg/computeSeg";
import { summarise } from "./distribution";

const H = STOCHASTIC_GAP_HORIZON_MONTHS;

/** The eight filled bands at 120 months. */
export const STOCHASTIC_GAP_BANDS: readonly GapBand[] = buildBands(H);

/** The keys the option admits (ruling 1). */
const OPTION_KEYS: readonly string[] = ["enabled"];

/** Thousands separators, locale-free so a message is the same bytes on every machine. */
function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The base of every stochastic gap refusal; the server maps it to a typed 422. */
export class StochasticGapError extends Error {
  readonly layer = "stochastic.gap";
  constructor(message: string) {
    super(`stochastic.gap: ${message}`);
    this.name = "StochasticGapError";
  }
}

/** The option is not exactly { enabled: true }. */
export class StochasticGapOptionError extends StochasticGapError {
  constructor(message: string) {
    super(message);
    this.name = "StochasticGapOptionError";
  }
}

/** The run names BGM (ruling 2). */
export class StochasticGapModelError extends StochasticGapError {
  readonly model: StochasticModel;
  constructor(model: StochasticModel) {
    super(
      `the gap distributions are Hull-White only; model "${model}" is refused. A BGM path answers forwards on its ` +
        `saved tenor grid only, and the SEG block's instruments read tenors off that grid (BgmTenorError on the 3M, ` +
        `6M and 4Y forwards), so BGM gap needs a general tenor rule. Run the gap on "hull-white-1f", or drop gap.`,
    );
    this.name = "StochasticGapModelError";
    this.model = model;
  }
}

/** positions x nPaths exceeds the cap (ruling 3). */
export class StochasticGapSizeCapError extends StochasticGapError {
  readonly positions: number;
  readonly nPaths: number;
  readonly positionPaths: number;
  readonly cap: number;
  constructor(positions: number, nPaths: number) {
    const product = positions * nPaths;
    super(
      `${grouped(positions)} positions x ${grouped(nPaths)} paths = ${grouped(product)} position-paths exceeds the ` +
        `cap of ${grouped(STOCHASTIC_GAP_SIZE_CAP)} position-paths (about 2.8 ms per position per path at ${H} ` +
        `months estimated on the granular book, about 4.3 ms measured on a test book, so a run at the cap takes about ` +
        `5 to 7.5 minutes). The run is refused before any simulation, and the path ` +
        `count is never silently reduced; parallel workers are the planned fix. Run a smaller book or fewer paths.`,
    );
    this.name = "StochasticGapSizeCapError";
    this.positions = positions;
    this.nPaths = nPaths;
    this.positionPaths = product;
    this.cap = STOCHASTIC_GAP_SIZE_CAP;
  }
}

/** The run grid is too short for the 120-month block to read its paths. */
export class StochasticGapHorizonError extends StochasticGapError {
  readonly horizonMonths: number;
  constructor(horizonMonths: number) {
    super(
      `the run grid's horizonMonths ${horizonMonths} is too short: the ${H}-month SEG block reads each path through ` +
        `step ${H}, so the grid must carry at least ${H + 1} months; a shorter path would hold its last rate flat ` +
        `and the gap would read a rate the simulation never made.`,
    );
    this.name = "StochasticGapHorizonError";
    this.horizonMonths = horizonMonths;
  }
}

/** Validate the option's shape: a plain object whose only key is `enabled`, and that key true. */
export function validateGapOption(raw: unknown): StochasticGapOption {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new StochasticGapOptionError(`the option must be an object { enabled: true }, got ${JSON.stringify(raw)}`);
  }
  const unknown = Object.keys(raw).filter((k) => !OPTION_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new StochasticGapOptionError(
      `unknown key${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => JSON.stringify(k)).join(", ")}; the option ` +
        `admits { enabled: true } only (the horizon is fixed at ${H} months and is not a request field)`,
    );
  }
  if ((raw as { enabled?: unknown }).enabled !== true) {
    throw new StochasticGapOptionError(
      `enabled must be true, got ${JSON.stringify((raw as { enabled?: unknown }).enabled)}; omit gap for a run without it`,
    );
  }
  return { enabled: true };
}

/** Refuse more than STOCHASTIC_GAP_SIZE_CAP position-paths. */
export function checkGapSize(positions: number, nPaths: number): void {
  if (positions * nPaths > STOCHASTIC_GAP_SIZE_CAP) throw new StochasticGapSizeCapError(positions, nPaths);
}

/** Every refusal, in order, before any path is simulated. Returns the validated option. */
export function refuseGapBeforeSimulation(
  raw: unknown,
  model: StochasticModel,
  positions: number,
  nPaths: number,
  gridHorizonMonths: number,
): StochasticGapOption {
  const option = validateGapOption(raw);
  if (model !== "hull-white-1f") throw new StochasticGapModelError(model);
  if (gridHorizonMonths < H + 1) throw new StochasticGapHorizonError(gridHorizonMonths);
  checkGapSize(positions, nPaths);
  return option;
}

/** One path's top-level series: SEG outstanding t = 0..H (signed net), EBP months 1..H by side. */
interface TopRows {
  seg: number[];
  ebpA: number[];
  ebpL: number[];
}

/** One family's series as the fold reads it. */
type FamilyRows = TopRows;

function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

function emptyRows(): TopRows {
  return { seg: zeros(H + 1), ebpA: zeros(H), ebpL: zeros(H) };
}

function addInto(target: number[], source: readonly number[]): void {
  for (let i = 0; i < target.length; i++) target[i]! += source[i]!;
}

function addRows(target: TopRows, source: TopRows): void {
  addInto(target.seg, source.seg);
  addInto(target.ebpA, source.ebpA);
  addInto(target.ebpL, source.ebpL);
}

/**
 * Fold family series to the chart's top-level nodes, then sum the top level: the COA arm, internal to the fold.
 * Families arrive in the block's order (chart order); roots are summed in node order.
 */
function foldToTop(families: Iterable<[string, FamilyRows]>, coa: ChartOfAccounts): TopRows {
  const nodeById = new Map(coa.nodes.map((n) => [n.id, n]));
  const nodeOfFamily = new Map(coa.families.map((f) => [f.id, f.coaNodeId]));
  const roots = new Map<string, TopRows>();
  for (const n of coa.nodes) if (n.parentId === null) roots.set(n.id, emptyRows());
  for (const [familyId, rows] of families) {
    let node = nodeById.get(nodeOfFamily.get(familyId) ?? "");
    for (let depth = 0; node !== undefined && node.parentId !== null && depth <= coa.nodes.length; depth++) {
      node = nodeById.get(node.parentId);
    }
    const root = node !== undefined && node.parentId === null ? roots.get(node.id) : undefined;
    if (root === undefined) {
      throw new Error(`stochastic.gap: family "${familyId}" does not fold to a top-level node of the chart of accounts`);
    }
    addRows(root, rows);
  }
  const top = emptyRows();
  for (const r of roots.values()) addRows(top, r);
  return top;
}

/** Fold-and-drop: the block's own family series. */
function topFromBlock(result: SegResult, coa: ChartOfAccounts): TopRows {
  const fams: [string, FamilyRows][] = Object.entries(result.byFamily).map(([id, s]) => [
    id,
    { seg: s.segOutstanding, ebpA: s.ebpAssets, ebpL: s.ebpLiabilities },
  ]);
  return foldToTop(fams, coa);
}

/** Keep-all (test variant): rebuild the family series from the retained per-position rows, in book order. */
function topFromPositions(book: PortfolioSpec, perPosition: ReadonlyMap<string, PositionSegRow>): TopRows {
  const sideByFamily = new Map<string, BalanceSheetSide>(book.coa.families.map((f) => [f.id, f.side]));
  const fams = new Map<string, FamilyRows>();
  for (const p of book.positions) {
    const row = perPosition.get(p.id);
    if (row === undefined) continue;
    let fam = fams.get(p.familyId);
    if (fam === undefined) {
      fam = emptyRows();
      fams.set(p.familyId, fam);
    }
    addInto(fam.seg, row.segOutstanding);
    addInto(sideByFamily.get(p.familyId) === "asset" ? fam.ebpA : fam.ebpL, row.ebp);
  }
  const order = [...book.coa.families.map((f) => f.id), ...fams.keys()];
  const ordered: [string, FamilyRows][] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const f = fams.get(id);
    if (f === undefined || seen.has(id)) continue;
    seen.add(id);
    ordered.push([id, f]);
  }
  return foldToTop(ordered, book.coa);
}

/** One path's banded values (before net and cumulative, which the collector forms per path). */
export interface GapPathValues {
  seg: number[];
  segBeyond: number;
  runOffA: number[];
  runOffL: number[];
  beyondA: number;
  beyondL: number;
  month1A: number;
  month1L: number;
}

/** E(m): the EBP of month m + 1, and of month H at the horizon edge. */
function ebpAt(ebp: readonly number[], m: number): number {
  return ebp[Math.min(m, H - 1)]!;
}

/** Band one path's top-level rows. */
export function bandTopRows(top: TopRows, bands: readonly GapBand[] = STOCHASTIC_GAP_BANDS): GapPathValues {
  return {
    seg: bands.map((b) => top.seg[b.startMonth]! - top.seg[b.endMonth]!),
    segBeyond: top.seg[H]!,
    runOffA: bands.map((b) => ebpAt(top.ebpA, b.startMonth) - ebpAt(top.ebpA, b.endMonth)),
    runOffL: bands.map((b) => ebpAt(top.ebpL, b.startMonth) - ebpAt(top.ebpL, b.endMonth)),
    beyondA: top.ebpA[H - 1]!,
    beyondL: top.ebpL[H - 1]!,
    month1A: top.ebpA[0]!,
    month1L: top.ebpL[0]!,
  };
}

/** Band a SEG result's own book series (the deterministic reference the zero-vol anchor reads). */
export function bandSegResult(result: SegResult): GapPathValues {
  return bandTopRows({ seg: result.book.segOutstanding, ebpA: result.book.ebpAssets, ebpL: result.book.ebpLiabilities });
}

export interface StochasticGapInput {
  /** The overlaid base book the EVE and NII arms project. */
  book: PortfolioSpec;
  /** The simulated paths, index order; each must reach step H. */
  paths: readonly RatePath[];
  scenarioId: string;
  /** The engine factory with the run's options. */
  makeInstrument: (p: Position) => Instrument | null;
}

/** "fold-and-drop" is the run; "keep-all" retains every block and folds afterwards (test variant only). */
export type GapRetention = "fold-and-drop" | "keep-all";

/** Per-path collectors, one Float64Array of nPaths per (band, measure). */
class Collector {
  readonly n: number;
  private readonly nb: number;
  readonly seg: Float64Array[];
  readonly segCum: Float64Array[];
  readonly segBeyond: Float64Array;
  readonly run: Record<"a" | "l" | "n", Float64Array[]>;
  readonly cum: Record<"a" | "l" | "n", Float64Array[]>;
  readonly beyond: Record<"a" | "l" | "n", Float64Array>;
  readonly month1: Record<"a" | "l" | "n", Float64Array>;

  constructor(nPaths: number, nBands: number) {
    this.n = nPaths;
    this.nb = nBands;
    const arrs = () => Array.from({ length: nBands }, () => new Float64Array(nPaths));
    const side = () => ({ a: arrs(), l: arrs(), n: arrs() });
    const one = () => ({ a: new Float64Array(nPaths), l: new Float64Array(nPaths), n: new Float64Array(nPaths) });
    this.seg = arrs();
    this.segCum = arrs();
    this.segBeyond = new Float64Array(nPaths);
    this.run = side();
    this.cum = side();
    this.beyond = one();
    this.month1 = one();
  }

  put(p: number, v: GapPathValues): void {
    let cs = 0;
    let ca = 0;
    let cl = 0;
    let cn = 0;
    for (let b = 0; b < this.nb; b++) {
      const net = v.runOffA[b]! - v.runOffL[b]!;
      cs += v.seg[b]!;
      ca += v.runOffA[b]!;
      cl += v.runOffL[b]!;
      cn += net;
      this.seg[b]![p] = v.seg[b]!;
      this.segCum[b]![p] = cs;
      this.run.a[b]![p] = v.runOffA[b]!;
      this.run.l[b]![p] = v.runOffL[b]!;
      this.run.n[b]![p] = net;
      this.cum.a[b]![p] = ca;
      this.cum.l[b]![p] = cl;
      this.cum.n[b]![p] = cn;
    }
    this.segBeyond[p] = v.segBeyond;
    this.beyond.a[p] = v.beyondA;
    this.beyond.l[p] = v.beyondL;
    this.beyond.n[p] = v.beyondA - v.beyondL;
    this.month1.a[p] = v.month1A;
    this.month1.l[p] = v.month1L;
    this.month1.n[p] = v.month1A - v.month1L;
  }
}

function sides(r: Record<"a" | "l" | "n", Float64Array>): StochasticSideDistributions {
  return { assets: summarise(r.a), liabilities: summarise(r.l), net: summarise(r.n) };
}

function sidesAt(r: Record<"a" | "l" | "n", Float64Array[]>, b: number): StochasticSideDistributions {
  return { assets: summarise(r.a[b]!), liabilities: summarise(r.l[b]!), net: summarise(r.n[b]!) };
}

function sameUncovered(a: SegResult["uncovered"], b: SegResult["uncovered"]): boolean {
  return a.length === b.length && a.every((u, i) => u.positionId === b[i]!.positionId && u.reason === b[i]!.reason);
}

/**
 * Run the SEG block on every path, fold, band and drop, and summarise. The option and size refusals belong to
 * refuseGapBeforeSimulation, which the entry calls before the simulation this reads.
 */
export function computeStochasticGap(input: StochasticGapInput, retention: GapRetention = "fold-and-drop"): StochasticGapBlock {
  const { book, paths } = input;
  const bands = STOCHASTIC_GAP_BANDS;
  const nPaths = paths.length;
  const collect = new Collector(nPaths, bands.length);
  const kept: { result: SegResult; perPosition: Map<string, PositionSegRow> }[] = [];
  let uncovered: SegResult["uncovered"] | undefined;

  for (let p = 0; p < nPaths; p++) {
    const block = computeSegBlock({
      book,
      basePath: paths[p]!,
      scenarioId: input.scenarioId,
      ...SEG_DEFAULTS,
      horizonMonths: H,
      makeInstrument: input.makeInstrument,
    });
    if (uncovered === undefined) uncovered = block.result.uncovered;
    else if (!sameUncovered(uncovered, block.result.uncovered)) {
      throw new Error(`stochastic.gap: path ${p} covers a different position set from path 0`);
    }
    if (retention === "keep-all") kept.push(block);
    else collect.put(p, bandTopRows(topFromBlock(block.result, book.coa), bands));
  }
  if (retention === "keep-all") {
    for (let p = 0; p < kept.length; p++) collect.put(p, bandTopRows(topFromPositions(book, kept[p]!.perPosition), bands));
  }

  const repricing: StochasticRepricingBand[] = bands.map((b, i) => ({
    label: b.label,
    startMonth: b.startMonth,
    endMonth: b.endMonth,
    net: summarise(collect.seg[i]!),
    cumulative: summarise(collect.segCum[i]!),
  }));
  const liquidity: StochasticLiquidityBand[] = bands.map((b, i) => ({
    label: b.label,
    startMonth: b.startMonth,
    endMonth: b.endMonth,
    runOff: sidesAt(collect.run, i),
    cumulative: sidesAt(collect.cum, i),
  }));
  const unc = uncovered ?? [];
  return {
    horizonMonths: H,
    convention: "constant-balance-sheet",
    shockBp: SEG_DEFAULTS.shockBp,
    repricing: { bands: repricing, beyondHorizon: { net: summarise(collect.segBeyond) } },
    liquidity: { bands: liquidity, beyondHorizon: sides(collect.beyond), month1Balance: sides(collect.month1) },
    uncovered: unc.map((u) => ({ positionId: u.positionId, reason: u.reason })),
    uncoveredCount: unc.length,
  };
}
