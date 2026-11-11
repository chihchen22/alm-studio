/**
 * The feature demos tied out against the independent Python replica (the rule extended).
 *
 * Each demo's targets file (replica/targets/demo-<id>-v1.json) holds the demo's measures in the engine's own result
 * shapes. A check walks the ENGINE result and, for every number, label and row it finds, requires the matching target
 * cell: a number at 1e-9 relative with a floor of 1e-6 dollars, 1e-12 on a rate, a year or a fractional month, and an
 * exact match on a whole-month, count or bp field; a label equal. A target cell that is missing or not finite fails, a
 * numeric list whose length is not the engine's fails (no padding), and so does a target row, key or family the engine
 * does not report. What is not compared is written here, with the reason, never read from the targets:
 *  - labels and constants of the run (a basis name, the convention name, a run id), durations (out of scope), the chart
 *    roll-up rows (the book rows they sum to are compared), and a refusal's prose (`uncovered[].reason`);
 *  - the month of a SEG peak whose value is within the SEG floor, an argmax over rounding (D7); its value is compared.
 *    Since slice K1 (corrected-v1) the SEG block is compared in full: the replacement deposit vintages read
 *    the run's history on both sides, so D6 is closed.
 * The scenario ids and input file paths each demo reads are written here too.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckLine } from "./types";

const REL = 1e-9;
const FLOOR_DOLLARS = 1e-6;
const FLOOR_RATES = 1e-12;

export const PARALLEL_IDS = ["S0", "S100", "S-100", "S200", "S-200"] as const;
export const SIX_SHOCK_IDS = ["S0", "SRP-PUP", "SRP-PDN", "SRP-SUP", "SRP-SDN", "SRP-STEEP", "SRP-FLAT"] as const;

/** Each demo's scenarios, as its seeded setup composes them. */
export const DEMO_SCENARIOS: Readonly<Record<string, readonly string[]>> = {
  seg: PARALLEL_IDS,
  regulatory: PARALLEL_IDS,
  "spread-consistent": PARALLEL_IDS,
  "six-shocks": SIX_SHOCK_IDS,
  instruments: PARALLEL_IDS,
  "constant-prepay": PARALLEL_IDS,
  "fixed-ladder": PARALLEL_IDS,
};

/** The six input files every demo's targets must name, at these paths (the hashes are checked against the files). */
export const DEMO_INPUT_PATHS: Readonly<Record<string, string>> = {
  bank: "examples/mid-size-bank-v1.json",
  demos: "replica/inputs/feature-demos-v1.json",
  regulatory: "replica/inputs/regulatory-convention-v1.json",
  market: "packages/kernel/public/market_public.json",
  sofr: "examples/sofr-monthly-v1.json",
  cdParams: "replica/inputs/cd-illustrative-v3.json",
};

/** Paths, with list keys written as [], that the check reads and does not compare, with the reason. */
export const DEMO_NOT_TARGETED: ReadonlyArray<[RegExp, string]> = [
  [/^eve\.(discountBasis|durationMode)$/, "a label of the run"],
  [/^eve\.byScenario\[\]\.(durationSanityPassed|effectiveDurationEquity)$/, "durations are out of scope"],
  [/^eve\.byScenario\[\]\.byFamily\[\]\.effectiveDuration$/, "durations are out of scope"],
  [/^cashflows\.grid/, "the grid the setup names"],
  [/^cashflows\.byScenario\[\]\.byCoaNode/, "chart roll-up rows; the family rows they sum are compared"],
  [/^gap\.(repricing|liquidity)\[\]\.(kind|byCoaNode)/, "a label, and chart roll-up rows; the book rows are compared"],
  [/^ftp\.(irBasis|allInBasis|shockedScenarios)/, "a basis label, and the typed refusal of shocked series"],
  [/^seg\.convention$/, "the convention's name"],
  [/^seg\.uncovered\[\]\.reason$/, "a refusal's prose; the positions it names are compared"],
  [/^gap\.fixedRate\.uncovered\[\]\.reason$/, "a refusal's prose; the positions it names are compared"],
  [/^\.?liquidityStress\.bufferDerivation\.notCounted\[\]\.reason$/, "a reason's prose; the positions it names and their faces are compared"],
  [/^instruments\.(schemaVersion|runId)$/, "the file's version and the run id"],
];

/** Rates, years and fractional months, the deposit credits' rates, weights, betas, premiums and lives, and the liquidity
 * slice's renewal shares, haircuts, utilizations, factors, ratios, days and basis points: a 1e-12 floor. */
const RATE_KEY = /(couponRate|irFtpRate|lpFtpRate|allInFtpRate|ftpMarginRate|deltaEvePct|bookNimRate|nimPct|OutflowMonthly|wholesaleRenewal|drawRate|walYears|walMonths|survivalMonths|rateCredit|liquidityCredit|totalCredit|\.rate|\.weight|\.beta|[pP]remium|paidRate|lifeMonths|\.months|cdRenewal|haircut|Utilization|lcrFactor|thirtyDayShare|ShareOfFace|internalOverLcr|ShareOfUndrawn|DrawRate|survivalDays|\.days|ChargeBp|fundingSpreadBp)$/;
/** Whole months, counts and basis points: compared exactly. */
const EXACT_KEY = /(\.month|startMonth|endMonth|peakMonth|firstRepricingMonth|horizonMonths|horizonsMonths|niiHorizonMonths|positionCount|shockBp|niiShockBp|discountSpreadBp|runoffMonths)$/;
const SEG_SERIES = /^seg\.(book|byFamily\.[^.]+)\.(segOutstanding|segPeriodic|segPeak\.value)|^seg\.segBank/;

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const keyOf = (o: Record<string, unknown>): string | undefined => {
  for (const k of ["positionId", "scenarioId", "familyId", "id"]) if (typeof o[k] === "string") return o[k] as string;
  const band = o.band as { label?: string } | string | undefined;
  if (typeof band === "string") return band;
  if (band !== undefined && typeof band.label === "string") return band.label;
  return undefined;
};

/** One line's tally: cells, non-zero target cells, largest differences, first failures. */
export class DemoTally {
  cells = 0;
  nonZero = 0;
  maxRel = 0;
  maxAbs = 0;
  fails: string[] = [];
  constructor(private readonly segFloor: number) {}

  fail(where: string, why: string): void {
    this.cells += 1;
    this.fails.push(`${where}: ${why}`);
  }

  private floorOf(norm: string): number {
    if (EXACT_KEY.test(norm)) return 0;
    if (SEG_SERIES.test(norm)) return this.segFloor;
    return RATE_KEY.test(norm) ? FLOOR_RATES : FLOOR_DOLLARS;
  }

  num(where: string, norm: string, engine: number, target: unknown): void {
    if (!isNum(target)) return this.fail(where, `target ${target === undefined ? "missing" : String(target)}`);
    if (!Number.isFinite(engine)) return this.fail(where, `engine ${engine}`);
    const floor = this.floorOf(norm);
    this.cells += 1;
    if (target !== 0) this.nonZero += 1;
    const abs = Math.abs(engine - target);
    const rel = abs <= floor ? 0 : abs / Math.max(Math.abs(target), Number.MIN_VALUE);
    if (abs > this.maxAbs) this.maxAbs = abs;
    if (rel > this.maxRel) this.maxRel = rel;
    if (floor === 0 ? abs !== 0 : abs > floor && rel > REL) this.fails.push(`${where}: engine ${engine}, target ${target} (rel ${rel.toExponential(2)})`);
  }

  /** Walk the engine value; `pick` decides which normalized paths this line holds. */
  walk(where: string, norm: string, engine: unknown, target: unknown, pick: (norm: string) => boolean): void {
    if (DEMO_NOT_TARGETED.some(([re]) => re.test(norm))) return;
    if (typeof engine === "number") {
      if (pick(norm)) this.num(where, norm, engine, target);
      return;
    }
    if (engine === null || typeof engine === "string" || typeof engine === "boolean") {
      if (!pick(norm)) return;
      this.cells += 1;
      if (target !== engine) this.fails.push(`${where}: engine ${JSON.stringify(engine)}, target ${JSON.stringify(target)}`);
      return;
    }
    if (Array.isArray(engine)) {
      if (!Array.isArray(target)) {
        if (pick(norm) || engine.length > 0) this.fail(where, "target list missing");
        return;
      }
      if (engine.every((x) => typeof x === "number")) {
        if (!pick(norm)) return;
        if (target.length !== engine.length) return this.fail(where, `target has ${target.length} entries, the engine ${engine.length}`);
        engine.forEach((x, k) => this.num(`${where}[${k}]`, norm, x as number, target[k]));
        return;
      }
      const tKeys = target.map((t) => (t !== null && typeof t === "object" ? keyOf(t as Record<string, unknown>) : undefined));
      engine.forEach((e, i) => {
        const k = e !== null && typeof e === "object" ? keyOf(e as Record<string, unknown>) : undefined;
        const j = k === undefined ? i : tKeys.indexOf(k);
        if (j < 0) return this.fail(`${where}[${k}]`, "target row missing");
        this.walk(`${where}[${k ?? i}]`, `${norm}[]`, e, target[j], pick);
      });
      const eKeys = engine.map((e) => (e !== null && typeof e === "object" ? keyOf(e as Record<string, unknown>) : undefined));
      tKeys.forEach((k, j) => {
        if (k !== undefined && !eKeys.includes(k)) this.fail(`${where}[${k}]`, "a target row the engine does not report");
        if (k === undefined && j >= engine.length) this.fail(`${where}[${j}]`, "a target row the engine does not report");
      });
      return;
    }
    if (typeof engine === "object") {
      const t = (target !== null && typeof target === "object" ? target : undefined) as Record<string, unknown> | undefined;
      if (t === undefined) return this.fail(where, "target object missing");
      const e = engine as Record<string, unknown>;
      for (const [k, v] of Object.entries(e)) this.walk(`${where}.${k}`, `${norm}.${k}`, v, t[k], pick);
      for (const k of Object.keys(t)) if (!(k in e) && !DEMO_NOT_TARGETED.some(([re]) => re.test(`${norm}.${k}`))) this.fail(`${where}.${k}`, "a target the engine does not report");
    }
  }

  line(id: string, what: string, targetsPath: string): CheckLine {
    const ok = this.fails.length === 0 && this.cells > 0;
    return {
      id,
      status: ok ? "pass" : "fail",
      detail:
        `${what}: ${this.cells.toLocaleString("en-US")} cells (${this.nonZero.toLocaleString("en-US")} non-zero), max relative ` +
        `${this.maxRel.toExponential(2)}, max absolute ${this.maxAbs.toExponential(2)}` +
        (ok ? "" : `; ${this.fails.length} failing, first: ${this.fails.slice(0, 3).join(" | ")}`) +
        ` (anchor: the independent Python replica's targets, ${targetsPath}, at 1e-9 relative, floors 1e-6 dollars and 1e-12 on rates, years and fractional months, whole months exact)`,
    };
  }
}

export interface DemoTargets {
  schemaVersion: string;
  demo: string;
  setupId: string;
  inputs: Record<string, { path: string; sha256: string }>;
  scenarios: Array<{ id: string; rateSpec: unknown }>;
  [measure: string]: unknown;
}

export const demoTargetsPath = (demo: string): string => `replica/targets/demo-${demo}-v1.json`;

export function readDemoTargets(repoRoot: string, demo: string): DemoTargets {
  return JSON.parse(readFileSync(join(repoRoot, demoTargetsPath(demo)), "utf8")) as DemoTargets;
}

/** The targets' own checks: the demo, the setup id, the scenario ids this file names, the input hashes. */
export function demoInputsLine(repoRoot: string, demo: string, setupId: string, t: DemoTargets, engineScenarios: readonly string[]): CheckLine {
  const want = DEMO_SCENARIOS[demo]!;
  const got = (t.scenarios ?? []).map((s) => s.id);
  const inputs = t.inputs ?? {};
  const misplaced = Object.entries(DEMO_INPUT_PATHS).filter(([k, path]) => inputs[k]?.path !== path).map(([k]) => k);
  const extra = Object.keys(inputs).filter((k) => !(k in DEMO_INPUT_PATHS));
  const stale = Object.entries(DEMO_INPUT_PATHS).filter(([k, path]) => createHash("sha256").update(readFileSync(join(repoRoot, path))).digest("hex") !== inputs[k]?.sha256);
  const ok = t.demo === demo && t.setupId === setupId && JSON.stringify(got) === JSON.stringify(want) && JSON.stringify([...engineScenarios]) === JSON.stringify(want)
    && misplaced.length === 0 && extra.length === 0 && stale.length === 0;
  return {
    id: `demo.${demo}.inputs`,
    status: ok ? "pass" : "fail",
    detail: ok
      ? `${demoTargetsPath(demo)} is the ${demo} demo on setup ${setupId}, scenarios ${want.join(", ")} (the engine ran the same), and it names the 6 input files at the check's own paths, each hashing as recorded (anchor: the check's own scenario list and input paths, and the files on disk)`
      : `targets demo ${t.demo}, setup ${t.setupId} (want ${setupId}), scenarios ${got.join(",")} (want ${want.join(",")}; the engine ran ${engineScenarios.join(",")}), inputs not at the check's paths ${misplaced.join(", ") || "none"}, unexpected inputs ${extra.join(", ") || "none"}, stale inputs ${stale.map(([k]) => k).join(", ") || "none"}`,
  };
}

/** The SEG block as compared: a peak whose value is within the SEG floor is an argmax over rounding and its month is
 * dropped (D7), the same way on both sides; every other cell is compared. */
export function segForComparison(seg: Record<string, unknown>, floor: number): Record<string, unknown> {
  const s = structuredClone(seg) as Record<string, any>;
  for (const f of Object.values((s.byFamily ?? {}) as Record<string, any>)) {
    if (f.segPeak !== undefined && Math.abs(f.segPeak.value) <= floor) delete f.segPeak.month;
  }
  return s;
}

/** The SEG floor: the dollar floor carried through the SEG divisor, 12 / (2 x shock): a 1e-6 dollar interest difference. */
export const segFloorOf = (shockBp: number): number => (FLOOR_DOLLARS * 12) / ((2 * shockBp) / 1e4);
