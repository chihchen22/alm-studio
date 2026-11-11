/**
 * Historical rate dataset loader: monthly month-end observations,
 * Oct 2008 - Mar 2026. The SHIPPED default is
 * `public/rate_history_public.json`: U.S. Treasury constant-maturity par
 * yields from FRED read generically as the risk-free benchmark, plus a
 * constructed term-funding spread (see the file's provenance notes). It carries
 * NO policy series.
 *
 * Series: a short anchor (public: 1M bill CMT; legacy: overnight SOFR), the
 * benchmark term curve (17 tenors, 1M-360M), the term funding curve (17
 * tenors), and optionally Fed Target and EFFR on legacy files. Rates are
 * DECIMAL per annum, matching `CurveQuote.rate`. The shipped history's end
 * month MUST equal the shipped `market_public.json` calibration month: FTP and the NMD
 * regime calculations read the history at the snapshot month
 * (`historyCoversMonth`, gated by `shippedAlignment.test.ts`).
 *
 * Trailing-MA convention (tractor pillars): the window is INCLUSIVE of the
 * as-of month, `mean(values[i-k+1 .. i])`, matching
 * the Python verification script (`OVN[-k:].mean()`). This deliberately
 * differs from the NMD incentive-spread window in `instruments/nmd.ts`,
 * which averages the k months STRICTLY PRIOR to the current month.
 * Before the first complete window the MA is NaN, never a silently
 * truncated average; consumers drop or gap NaN entries.
 */

export interface RateHistoryProvenance {
  readonly sourceWorkbook: string;
  readonly sofrNote: string;
  readonly termFundingNote: string;
}

export interface RateHistory {
  /** ISO "YYYY-MM" month labels, index-aligned with every series. */
  readonly months: ReadonlyArray<string>;
  readonly tenorsMonths: ReadonlyArray<number>;
  /**
   * FOMC target and EFFR. EMPTY on the shipped Treasury-only public history,
   * which carries no policy series at all; `hasPolicyRates` gates every read.
   */
  readonly fedTarget: ReadonlyArray<number>;
  readonly effr: ReadonlyArray<number>;
  /** True only when both policy series are present and full length. */
  readonly hasPolicyRates: boolean;
  /**
   * Short-end anchor. On the public Treasury history this is the published
   * 1-month bill CMT point (raw key `short_rate`); on the retired constructed
   * file it is overnight SOFR (raw key `sofr_on`).
   */
  readonly sofrON: ReadonlyArray<number>;
  readonly provenance: RateHistoryProvenance;
  /** Index of an ISO "YYYY-MM" month, -1 if outside the dataset. */
  indexOfMonth(iso: string): number;
  /** SOFR term rate at a month, linear in tenor between nodes (clamped). */
  sofrTermRate(monthIdx: number, tenorMonths: number): number;
  termFundingTermRate(monthIdx: number, tenorMonths: number): number;
  /** Full monthly series for one tenor (interpolated if off-node). */
  sofrTermSeries(tenorMonths: number): number[];
  termFundingTermSeries(tenorMonths: number): number[];
  /**
   * Tractor pillar steady-state yield: trailing k-month MA of the k-month
   * SOFR tenor, inclusive of the as-of month. NaN before the first
   * complete window.
   */
  pillarYield(asOfIdx: number, kMonths: number): number;
}

/** First index with a complete inclusive k-month window. */
export function firstCompleteIndex(k: number): number {
  return k - 1;
}

/** Inclusive trailing MA at one index; NaN if the window is incomplete. */
export function trailingMA(values: ArrayLike<number>, asOfIdx: number, k: number): number {
  if (k <= 0 || asOfIdx < 0 || asOfIdx >= values.length) return NaN;
  if (asOfIdx < firstCompleteIndex(k)) return NaN;
  let sum = 0;
  for (let j = asOfIdx - k + 1; j <= asOfIdx; j++) sum += values[j];
  return sum / k;
}

/** Inclusive trailing MA over a whole series; NaN before the first complete window. */
export function trailingMASeries(values: ArrayLike<number>, k: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (k <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= k) sum -= values[i - k];
    if (i >= k - 1) out[i] = sum / k;
  }
  return out;
}

interface RawTermBlock {
  tenors_months: number[];
  rates: number[][];
}

interface RawRateHistory {
  name: string;
  start_month: string;
  end_month: string;
  months: number;
  units: string;
  provenance: {
    source_workbook: string;
    sofr_note: string;
    /** Generic key on constructed files; falls back to the retired fhlb_note. */
    term_funding_note?: string;
    fhlb_note?: string;
  };
  /** Policy series. ABSENT on the Treasury-only public history. */
  fed_target?: number[];
  effr?: number[];
  /** Short anchor: `short_rate` (public UST 1M CMT) or legacy `sofr_on`. */
  short_rate?: number[];
  sofr_on?: number[];
  sofr_term: RawTermBlock;
  /** Generic key on constructed files; falls back to the retired fhlb_term. */
  term_funding_term?: RawTermBlock;
  fhlb_term?: RawTermBlock;
}

function isoMonthsFrom(startIso: string, count: number): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(startIso);
  if (!m) throw new Error(`rateHistory: bad start_month "${startIso}"`);
  let year = Number(m[1]);
  let month = Number(m[2]);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

function checkSeries(name: string, values: number[], expectedLen: number): void {
  if (values.length !== expectedLen) {
    throw new Error(`rateHistory: ${name} has ${values.length} entries, expected ${expectedLen}`);
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      throw new Error(`rateHistory: ${name}[${i}] is not a finite number`);
    }
  }
}

function checkTermBlock(name: string, block: RawTermBlock, expectedLen: number): void {
  for (let i = 1; i < block.tenors_months.length; i++) {
    if (block.tenors_months[i] <= block.tenors_months[i - 1]) {
      throw new Error(`rateHistory: ${name} tenor axis not strictly increasing at index ${i}`);
    }
  }
  if (block.rates.length !== expectedLen) {
    throw new Error(`rateHistory: ${name} has ${block.rates.length} rows, expected ${expectedLen}`);
  }
  for (let i = 0; i < block.rates.length; i++) {
    checkSeries(`${name}.rates[${i}]`, block.rates[i], block.tenors_months.length);
  }
}

/** Linear interpolation in tenor months, clamped at the ends. */
function interpTenor(tenors: ReadonlyArray<number>, row: ReadonlyArray<number>, t: number): number {
  if (t <= tenors[0]) return row[0];
  const last = tenors.length - 1;
  if (t >= tenors[last]) return row[last];
  let i = 1;
  while (tenors[i] < t) i++;
  const w = (t - tenors[i - 1]) / (tenors[i] - tenors[i - 1]);
  return row[i - 1] + w * (row[i] - row[i - 1]);
}

export function parseRateHistory(raw: RawRateHistory): RateHistory {
  const n = raw.months;
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`rateHistory: bad month count ${raw.months}`);
  }
  const months = isoMonthsFrom(raw.start_month, n);
  if (months[n - 1] !== raw.end_month) {
    throw new Error(
      `rateHistory: end_month ${raw.end_month} disagrees with start_month + ${n} months (${months[n - 1]})`,
    );
  }
  const shortRate = raw.short_rate ?? raw.sofr_on;
  if (!shortRate) {
    throw new Error("rateHistory: missing short_rate (or legacy sofr_on) series");
  }
  checkSeries("short_rate", shortRate, n);
  const hasPolicyRates = raw.fed_target !== undefined && raw.effr !== undefined;
  if (hasPolicyRates) {
    checkSeries("fed_target", raw.fed_target as number[], n);
    checkSeries("effr", raw.effr as number[], n);
  }
  checkTermBlock("sofr_term", raw.sofr_term, n);
  const termFundingBlock = raw.term_funding_term ?? raw.fhlb_term;
  if (!termFundingBlock) {
    throw new Error("rateHistory: missing term_funding_term (or legacy fhlb_term) block");
  }
  checkTermBlock("term_funding_term", termFundingBlock, n);
  if (raw.sofr_term.tenors_months.join() !== termFundingBlock.tenors_months.join()) {
    throw new Error("rateHistory: benchmark and term-funding tenor axes differ");
  }

  const tenors = raw.sofr_term.tenors_months;
  const monthIndex = new Map<string, number>(months.map((m, i) => [m, i]));
  const nodeIndex = new Map<number, number>(tenors.map((t, i) => [t, i]));

  const termRate = (block: RawTermBlock, monthIdx: number, tenorMonths: number): number => {
    if (monthIdx < 0 || monthIdx >= n) {
      throw new Error(`rateHistory: month index ${monthIdx} out of range 0..${n - 1}`);
    }
    const node = nodeIndex.get(tenorMonths);
    const row = block.rates[monthIdx];
    return node !== undefined ? row[node] : interpTenor(tenors, row, tenorMonths);
  };

  const termSeries = (block: RawTermBlock, tenorMonths: number): number[] => {
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = termRate(block, i, tenorMonths);
    return out;
  };

  return {
    months,
    tenorsMonths: tenors,
    fedTarget: raw.fed_target ?? [],
    effr: raw.effr ?? [],
    hasPolicyRates,
    sofrON: shortRate,
    provenance: {
      sourceWorkbook: raw.provenance.source_workbook,
      sofrNote: raw.provenance.sofr_note,
      termFundingNote: raw.provenance.term_funding_note ?? raw.provenance.fhlb_note ?? "",
    },
    indexOfMonth: (iso) => monthIndex.get(iso) ?? -1,
    sofrTermRate: (m, t) => termRate(raw.sofr_term, m, t),
    termFundingTermRate: (m, t) => termRate(termFundingBlock, m, t),
    sofrTermSeries: (t) => termSeries(raw.sofr_term, t),
    termFundingTermSeries: (t) => termSeries(termFundingBlock, t),
    pillarYield: (asOfIdx, kMonths) =>
      trailingMA(termSeries(raw.sofr_term, kMonths), asOfIdx, kMonths),
  };
}

/**
 * True when the history includes the month of an ISO date ("YYYY-MM-DD" or
 * "YYYY-MM"). FTP and the NMD regime calculations require this for the
 * active snapshot's calibration date; the monthly history must reach the
 * snapshot month.
 */
export function historyCoversMonth(history: RateHistory, isoDate: string): boolean {
  return history.indexOfMonth(isoDate.slice(0, 7)) !== -1;
}

/** Load the rate history from a JSON URL (browser) or path (Node tests). */
export async function loadRateHistory(source: string | URL): Promise<RateHistory> {
  if (typeof window !== "undefined") {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`Failed to load rate history: ${res.status} ${res.statusText}`);
    }
    return parseRateHistory((await res.json()) as RawRateHistory);
  }
  // Node fallback for tests: dynamic import of fs.
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(source as string, "utf-8");
  return parseRateHistory(JSON.parse(text) as RawRateHistory);
}

export const RATE_HISTORY_FILENAME = "rate_history_public.json";

let cached: Promise<RateHistory> | null = null;

/**
 * Singleton loader for the bundled dataset (browser). First caller triggers
 * the fetch; later tabs (Replicating Portfolio) reuse the same promise.
 */
export function loadRateHistoryOnce(baseUrl: string): Promise<RateHistory> {
  if (!cached) {
    cached = loadRateHistory(`${baseUrl}${RATE_HISTORY_FILENAME}`).catch((err) => {
      cached = null; // allow retry after a failed fetch
      throw err;
    });
  }
  return cached;
}
