/**
 * Acceptance check: python-replica-tie-out.
 *
 * Anchor: an INDEPENDENT SECOND IMPLEMENTATION. `replica/` is a small Python and numpy package, written from the
 * docs, the ADRs and the method comments, sharing no code and no constant with the engine. It reads the same input
 * files and writes one committed targets file per book. This check runs the engine on the same inputs and compares
 * every cell at 1e-9 relative, with an absolute floor of 1e-6 dollars on a dollar cell and 1e-12 on a rate cell.
 *
 * Two books, each the deterministic static run-off with the SOFR history as the deposit warmup and no new volume:
 *  - Quillfield Bank (examples/mid-size-bank-v1.json, its finished analysis's assumption set), base and the parallel
 *    plus and minus 100 and 200 bp shocks;
 *  - the coverage book (replica/inputs/coverage-v1.json), the behavior paths Quillfield does not reach, base, +100 and
 *    -100, -200 and -300 bp.
 *
 * Measures, one line each per book: the projection of every position (one engine book per position), NII, run-off EVE
 * on the risk-free and on the all-in basis, the repricing and the liquidity gap (nine bands and every month), FTP.
 *
 * What is compared is listed from the ENGINE side (fix round M1): every scenario this check names, every family,
 * position, row and numeric key the engine reports at the levels below must have a finite target cell, or sit on the
 * NOT_TARGETED list here, with its reason. The scenario ids and that list are written in this file and never read from
 * the targets. A target cell that is missing or not finite fails, and so does a target family or position the engine
 * does not report.
 *
 * `npm run accept` never runs Python. `npm run replica:check` re-runs the replica and fails when its output drifts
 * from the committed targets; this check fails when an input file drifts from the hash its targets record.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createEngine,
  resolveDefaultContext,
  type AssumptionSet,
  type PortfolioSpec,
  type RunRequest,
  type RunResult,
  type Scenario,
} from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";
import { ACCEPT_TS } from "./handBooks";
import type { CapabilityCheck, CheckLine } from "./types";

const HORIZON = 360;
const REL = 1e-9;
const FLOOR_DOLLARS = 1e-6;
const FLOOR_RATES = 1e-12;

/** One book the replica ties out. Every field is stated here; none is read from the targets. */
export interface ReplicaSubject {
  id: string;
  targetsPath: string;
  bankPath: string;
  bindingsPath: string;
  /** Where the bindings sit inside the bindings file. */
  bindingsKeys: readonly string[];
  setId: string;
  /** The scenarios, id and parallel shock in bp, in run order; the first is the base. */
  scenarios: ReadonlyArray<readonly [string, number]>;
}

export const QUILLFIELD: ReplicaSubject = {
  id: "quillfield-v1",
  targetsPath: "replica/targets/quillfield-v1.json",
  bankPath: "examples/mid-size-bank-v1.json",
  bindingsPath: "examples/mid-size-bank-v1.analysis.json",
  bindingsKeys: ["behavior", "bindings"],
  setId: "quillfield-illustrative-v1",
  scenarios: [["S0", 0], ["S100", 100], ["S-100", -100], ["S200", 200], ["S-200", -200]],
};

export const COVERAGE: ReplicaSubject = {
  id: "coverage-v1",
  targetsPath: "replica/targets/coverage-v1.json",
  bankPath: "replica/inputs/coverage-v1.json",
  bindingsPath: "replica/inputs/coverage-v1.assumptions.json",
  bindingsKeys: ["bindings"],
  setId: "coverage-illustrative-v1",
  scenarios: [["S0", 0], ["S100", 100], ["S-100", -100], ["S-200", -200], ["S-300", -300]],
};

export const SUBJECTS: readonly ReplicaSubject[] = [QUILLFIELD, COVERAGE];

/** The input files every targets file must record, by key. */
const INPUT_KEYS = ["bank", "bindings", "market", "sofr", "cdParams"] as const;

/**
 * Engine output the check reads and does not compare, with the reason. Everything else at the levels walked must
 * have a target. Since the fix round's engine change (FTP reads the run's warmup) no FTP cell is left out (D1 fixed).
 */
export const NOT_TARGETED: Readonly<Record<string, string>> = {
  "eve.durationSanityPassed": "durations are out of scope (see the limitations page)",
  "eve.effectiveDurationEquity": "durations are out of scope",
  "eve.byFamily.effectiveDuration": "durations are out of scope",
  "gap.byCoaNode": "node rows roll the family series up the chart; the book rows they sum to are compared",
  "gap.kind": "a label",
  "ftp.irBasis": "a label, checked against its expected text",
  "ftp.allInBasis": "a label, checked against its expected text",
  "ftp.shockedScenarios": "a typed refusal, not a number",
  "ftp.byFamily.side": "a label, checked against the target's",
  "ftp.nimBridge.horizonMonths": "a constant, checked to be 12",
};
const FTP_LABELS = { scenario: "S0", irBasis: "risk-free", allInBasis: "risk-free-plus-tlp" } as const;

type Num = number;
interface BandRow { label: string; assets: Num; liabilities: Num; gap: Num; cumulativeGap: Num }
export interface Targets {
  schemaVersion: string;
  inputs: Record<string, { path: string; sha256: string }>;
  scenarios: Array<{ id: string; shockBp: number }>;
  positions: Record<string, Record<string, Record<string, Num[]>>>;
  nii: Record<string, Record<string, unknown> & {
    netMonthly: Num[];
    byFamily: Record<string, { "12": Record<string, Num>; "24": Record<string, Num>; netMonthly: Num[] }>;
  }>;
  eve: Record<string, Record<string, Record<string, unknown> & { byFamily: Record<string, Num> }>>;
  gap: Record<"repricing" | "liquidity", Record<string, { bands: BandRow[]; monthly: BandRow[] }>>;
  ftp: {
    byFamily: Record<string, Record<string, unknown> & { monthly: Record<string, Num[]> }>;
    book: Record<string, Num>;
    nimBridge: Record<string, Num>;
    excluded?: unknown;
  };
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** One measure's tally: cells compared, non-zero target cells, the largest differences, the first failures. */
class Tally {
  cells = 0;
  nonZero = 0;
  maxRel = 0;
  maxAbs = 0;
  fails: string[] = [];

  fail(where: string, why: string): void {
    this.cells += 1;
    this.fails.push(`${where}: ${why}`);
  }

  cell(where: string, engine: unknown, target: unknown, floor = FLOOR_DOLLARS): void {
    if (!isNum(target)) return this.fail(where, `target ${target === undefined ? "missing" : String(target)}`);
    if (!isNum(engine)) return this.fail(where, `engine ${String(engine)}, target ${target}`);
    this.cells += 1;
    if (target !== 0) this.nonZero += 1;
    const abs = Math.abs(engine - target);
    const rel = abs <= floor ? 0 : abs / Math.max(Math.abs(target), Number.MIN_VALUE);
    if (abs > this.maxAbs) this.maxAbs = abs;
    if (rel > this.maxRel) this.maxRel = rel;
    if (abs > floor && rel > REL) this.fails.push(`${where}: engine ${engine}, target ${target} (rel ${rel.toExponential(2)})`);
  }

  /** A target series is trimmed of trailing zeros; past its end the engine must read 0. */
  series(where: string, engine: unknown, target: unknown, floor = FLOOR_DOLLARS): void {
    if (!Array.isArray(target) || target.length > HORIZON) return this.fail(where, "target series missing or longer than the grid");
    if (!Array.isArray(engine) || engine.length !== HORIZON) return this.fail(where, `engine series has length ${Array.isArray(engine) ? engine.length : "none"}`);
    for (let k = 0; k < HORIZON; k++) this.cell(`${where}[${k}]`, engine[k], k < target.length ? target[k] : 0, floor);
  }

  /** Every key the engine reports must be handled; a key not in `handled` and not declared fails. */
  keys(where: string, engineRow: object, handled: readonly string[], declaredPrefix: string): void {
    for (const k of Object.keys(engineRow)) {
      if (handled.includes(k) || `${declaredPrefix}.${k}` in NOT_TARGETED) continue;
      this.fail(`${where}.${k}`, "the engine reports it, it has no target and it is not on NOT_TARGETED");
    }
  }

  /** Families (or positions) on the target side the engine does not report. */
  extra(where: string, targetIds: readonly string[], engineIds: readonly string[]): void {
    for (const id of targetIds) if (!engineIds.includes(id)) this.fail(`${where}/${id}`, "a target the engine does not report");
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
        ` (anchor: the independent Python replica's targets, ${targetsPath}, at 1e-9 relative, floors 1e-6 dollars and 1e-12 on rates)`,
    };
  }
}

function readJson<T>(repoRoot: string, rel: string): T {
  return JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as T;
}

interface Sofr { label: string; source: string; firstMonth: string; valuesPct: number[] }

/** The engine side of one book: both bases, and one run per position for the per-position series. */
export interface EngineRuns {
  bank: PortfolioSpec;
  rf: RunResult;
  ai: RunResult;
  positions: Map<string, RunResult>;
  observed: string[];
}

function scenariosOf(subject: ReplicaSubject, setId: string): Scenario[] {
  return subject.scenarios.map(([id, bp]) => ({
    id,
    label: id,
    rateSpec: bp === 0 ? { kind: "base" } : { kind: "parallel", shockBp: bp },
    assumptionSetId: setId,
    newBusiness: { mode: "static", rules: [] },
  }));
}

function runOne(book: PortfolioSpec, set: AssumptionSet, scenarios: Scenario[], market: MarketSnapshot, sofr: Sofr, basis: "risk-free" | "all-in", runId: string): RunResult {
  const engine = createEngine({
    ...resolveDefaultContext(),
    nmdWarmup: { kind: "history", series: { label: `${sofr.label} (${sofr.source})`, firstMonth: sofr.firstMonth, valuesPct: [...sofr.valuesPct] } },
    discountBasis: basis,
    // The tie-out reads the public default, the corrected convention.
    modelConvention: "corrected-v1",
    gapBuckets: { kind: "monthly" },
    liquidityBuckets: { kind: "monthly" },
  } as Parameters<typeof createEngine>[0]);
  engine.loadPortfolio(book);
  const request: RunRequest = {
    runId,
    portfolioId: book.id,
    marketSnapshot: market,
    scenarios,
    assumptionSets: [set],
    grid: { horizonMonths: HORIZON, asOf: book.asOf },
    seed: "accept",
    timestamps: { ...ACCEPT_TS },
  };
  return engine.run(request);
}

export function runEngine(repoRoot: string, market: MarketSnapshot, subject: ReplicaSubject): EngineRuns {
  const bank = readJson<PortfolioSpec>(repoRoot, subject.bankPath);
  let bindings: unknown = readJson<unknown>(repoRoot, subject.bindingsPath);
  for (const k of subject.bindingsKeys) bindings = (bindings as Record<string, unknown>)[k];
  const sofr = readJson<Sofr>(repoRoot, "examples/sofr-monthly-v1.json");
  const set: AssumptionSet = { schemaVersion: "1.0.0", id: subject.setId, label: subject.id, bindings: bindings as AssumptionSet["bindings"] };
  const scenarios = scenariosOf(subject, set.id);
  const rf = runOne(bank, set, scenarios, market, sofr, "risk-free", `accept-replica-${subject.id}-rf`);
  const ai = runOne(bank, set, scenarios, market, sofr, "all-in", `accept-replica-${subject.id}-ai`);
  const positions = new Map<string, RunResult>();
  for (const p of bank.positions) {
    positions.set(p.id, runOne({ ...bank, id: `accept-replica-${p.id}`, positions: [p] }, set, scenarios, market, sofr, "risk-free", `accept-replica-pos-${p.id}`));
  }
  const observed = [rf, ai, ...positions.values()].flatMap((r) => r.notImplemented.map((x) => x.layer));
  return { bank, rf, ai, positions, observed };
}

/** The comparison alone, over targets already read and engine runs already made (the tests call it with edited targets). */
export function compareSubject(subject: ReplicaSubject, t: Targets, runs: EngineRuns): CheckLine[] {
  const lines: CheckLine[] = [];
  const sids = subject.scenarios.map(([id]) => id);
  const tag = (id: string) => (subject === QUILLFIELD ? id : `${subject.id}.${id}`);

  // 0. The scenarios and inputs the targets state must be the ones this check names.
  {
    const want = subject.scenarios.map(([id, bp]) => `${id}:${bp}`).join(",");
    const got = Array.isArray(t.scenarios) ? t.scenarios.map((s) => `${s.id}:${s.shockBp}`).join(",") : "none";
    const inputs = Object.keys(t.inputs ?? {}).sort().join(",");
    const ok = want === got && inputs === [...INPUT_KEYS].sort().join(",") && t.ftp?.excluded === undefined;
    lines.push({
      id: tag("scenarios"),
      status: ok ? "pass" : "fail",
      detail: ok
        ? `targets state the scenarios this check names (${want}), the five input files, and no exclusion list (anchor: the check's own constants)`
        : `targets state scenarios ${got} (expected ${want}), inputs ${inputs}${t.ftp?.excluded !== undefined ? ", and an exclusion list, which this check does not honour" : ""}`,
    });
  }

  const engineScenario = <T extends { scenarioId: string }>(rows: readonly T[], sid: string): T | undefined => rows.find((r) => r.scenarioId === sid);

  // 1. The projection of every position.
  {
    const tally = new Tally();
    for (const sid of sids) {
      const tp = t.positions?.[sid];
      if (tp === undefined) {
        tally.fail(`positions/${sid}`, "target scenario missing");
        continue;
      }
      tally.extra(`positions/${sid}`, Object.keys(tp), runs.bank.positions.map((p) => p.id));
      for (const p of runs.bank.positions) {
        const r = runs.positions.get(p.id)!;
        const fam = engineScenario(r.cashflows.byScenario, sid)?.byFamily.find((f) => f.familyId === p.familyId);
        if (fam === undefined) {
          tally.fail(`${sid}/${p.id}`, "engine series missing");
          continue;
        }
        const target = tp[p.id];
        for (const k of ["balance", "principal", "interest"] as const) tally.series(`${sid}/${p.id}.${k}`, fam.series[k], target?.[k]);
      }
    }
    lines.push(tally.line(tag("positions"), `run-off projection of ${runs.bank.positions.length} positions x ${sids.length} scenarios, balance, principal and interest by month`, subject.targetsPath));
  }

  // 2. NII on the run-off basis.
  {
    const tally = new Tally();
    for (const sid of sids) {
      const e = engineScenario(runs.rf.nii.byScenario, sid);
      const g = t.nii?.[sid];
      if (e === undefined) {
        tally.fail(`nii/${sid}`, "engine scenario missing");
        continue;
      }
      if (g === undefined) {
        tally.fail(`nii/${sid}`, "target scenario missing");
        continue;
      }
      tally.keys(`nii/${sid}`, e, ["scenarioId", "byFamily", "totalNet12", "totalNet24", "totalNetByHorizon", "netMonthly", "derivativesNet12", "derivativesNet24", "derivativesNetByHorizon"], "nii");
      const er = e as unknown as Record<string, unknown>;
      const byH = (k: string, h: number) => (er[k] as Record<string, number> | undefined)?.[h];
      for (const key of ["totalNet12", "totalNet24"] as const) tally.cell(`${sid}.${key}`, e[key], g[key]);
      for (const h of [12, 24]) tally.cell(`${sid}.totalNetByHorizon.${h}`, byH("totalNetByHorizon", h), g[`totalNet${h}`]);
      // A book with no derivative family carries no derivatives line, on either side.
      for (const key of ["derivativesNet12", "derivativesNet24"] as const) if (key in er || key in g) tally.cell(`${sid}.${key}`, er[key], g[key]);
      for (const h of [12, 24]) {
        if ("derivativesNetByHorizon" in er || `derivativesNet${h}` in g) tally.cell(`${sid}.derivativesNetByHorizon.${h}`, byH("derivativesNetByHorizon", h), g[`derivativesNet${h}`]);
      }
      tally.series(`${sid}.netMonthly`, e.netMonthly, g.netMonthly);
      tally.extra(`nii/${sid}`, Object.keys(g.byFamily ?? {}), e.byFamily.map((f) => f.familyId));
      for (const ef of e.byFamily) {
        const gf = g.byFamily?.[ef.familyId];
        const w = `${sid}/${ef.familyId}`;
        tally.keys(w, ef, ["familyId", "interestIncome12", "interestExpense12", "net12", "interestIncome24", "interestExpense24", "net24", "byHorizon", "netMonthly"], "nii.byFamily");
        for (const h of ["12", "24"] as const) {
          for (const key of ["interestIncome", "interestExpense", "net"] as const) {
            tally.cell(`${w}.byHorizon.${h}.${key}`, ef.byHorizon?.[h]?.[key], gf?.[h]?.[key]);
            tally.cell(`${w}.${key}${h}`, (ef as unknown as Record<string, number>)[`${key}${h}`], gf?.[h]?.[key]);
          }
        }
        tally.series(`${w}.netMonthly`, ef.netMonthly, gf?.netMonthly);
      }
    }
    lines.push(tally.line(tag("nii"), "run-off NII by month, by family and in total, 12 and 24 months, every scenario", subject.targetsPath));
  }

  // 3. Run-off EVE on both bases.
  for (const [basis, run] of [["risk-free", runs.rf], ["all-in", runs.ai]] as const) {
    const tally = new Tally();
    if (run.eve.discountBasis !== basis) tally.fail(`eve/${basis}`, `the engine ran on ${String(run.eve.discountBasis)}`);
    for (const sid of sids) {
      const e = engineScenario(run.eve.byScenario, sid);
      const g = t.eve?.[basis]?.[sid];
      if (e === undefined) {
        tally.fail(`eve/${basis}/${sid}`, "engine scenario missing");
        continue;
      }
      if (g === undefined) {
        tally.fail(`eve/${basis}/${sid}`, "target scenario missing");
        continue;
      }
      const row = e as unknown as Record<string, unknown>;
      tally.keys(`${sid}`, e, ["scenarioId", "byFamily", "pvAssets", "pvLiabilities", "pvDerivatives", "eve", "deltaEveVsBase", "deltaEvePct"], "eve");
      for (const key of ["pvAssets", "pvLiabilities", "pvDerivatives", "eve", "deltaEveVsBase"] as const) {
        if (key in row || key in g) tally.cell(`${sid}.${key}`, row[key], g[key]);
      }
      tally.cell(`${sid}.deltaEvePct`, e.deltaEvePct, g.deltaEvePct, FLOOR_RATES);
      tally.extra(`eve/${basis}/${sid}`, Object.keys(g.byFamily ?? {}), e.byFamily.map((f) => f.familyId));
      for (const ef of e.byFamily) {
        tally.keys(`${sid}/${ef.familyId}`, ef, ["familyId", "pv"], "eve.byFamily");
        tally.cell(`${sid}/${ef.familyId}.pv`, ef.pv, g.byFamily?.[ef.familyId]);
      }
    }
    lines.push(tally.line(tag(`eve-${basis}`), `run-off EVE on the ${basis} basis, by family and in total, every scenario`, subject.targetsPath));
  }

  // 4. The two gap ladders: the nine standard bands and every month.
  for (const kind of ["repricing", "liquidity"] as const) {
    const tally = new Tally();
    for (const sid of sids) {
      const e = engineScenario(runs.rf.gap[kind], sid);
      const g = t.gap?.[kind]?.[sid];
      if (e === undefined || e.userBuckets === undefined) {
        tally.fail(`gap/${kind}/${sid}`, "engine ladder missing");
        continue;
      }
      if (g === undefined) {
        tally.fail(`gap/${kind}/${sid}`, "target ladder missing");
        continue;
      }
      tally.keys(`${kind}/${sid}`, e, ["scenarioId", "rows", "userBuckets"], "gap");
      for (const [rows, grows, nm] of [[e.rows, g.bands, "band"], [e.userBuckets.rows, g.monthly, "month"]] as const) {
        if (!Array.isArray(grows) || grows.length !== rows.length) {
          tally.fail(`${sid}.${nm}`, `engine ${rows.length} rows, target ${Array.isArray(grows) ? grows.length : "none"}`);
          continue;
        }
        rows.forEach((er, i) => {
          const gr = grows[i]!;
          if (er.band.label !== gr.label) return tally.fail(`${sid}.${nm}[${i}]`, `engine row ${er.band.label}, target row ${gr.label}`);
          tally.keys(`${sid}.${er.band.label}`, er, ["band", "assets", "liabilities", "gap", "cumulativeGap"], "gap.row");
          for (const key of ["assets", "liabilities", "gap", "cumulativeGap"] as const) tally.cell(`${sid}.${er.band.label}.${key}`, er[key], gr[key]);
        });
      }
    }
    lines.push(tally.line(tag(`gap-${kind}`), `${kind} gap ladder, nine bands and 360 months, assets, liabilities, gap and cumulative gap, every scenario`, subject.targetsPath));
  }

  // 5. FTP of the existing positions, base scenario.
  {
    const tally = new Tally();
    const e = runs.rf.ftp;
    if (e === undefined) tally.fail("ftp", "the engine wrote no ftp block");
    else {
      if (e.scenarioId !== FTP_LABELS.scenario || e.irBasis !== FTP_LABELS.irBasis || e.allInBasis !== FTP_LABELS.allInBasis) {
        tally.fail("ftp", `labels ${e.scenarioId} / ${e.irBasis} / ${e.allInBasis}`);
      }
      tally.keys("ftp", e, ["scenarioId", "byFamily", "book", "nimBridge"], "ftp");
      const RATE_KEYS = ["couponRate", "irFtpRate", "lpFtpRate", "allInFtpRate", "ftpMarginRate"];
      const NUM_KEYS = ["positionCount", "notional", "couponInterest12", "ftpAccrual12", "margin12", ...RATE_KEYS];
      tally.extra("ftp", Object.keys(t.ftp?.byFamily ?? {}), e.byFamily.map((f) => f.familyId));
      for (const ef of e.byFamily) {
        const row = ef as unknown as Record<string, unknown>;
        const g = t.ftp?.byFamily?.[ef.familyId];
        const w = `ftp/${ef.familyId}`;
        if (g === undefined) {
          tally.fail(w, "target family missing");
          continue;
        }
        if (g.side !== ef.side) tally.fail(`${w}.side`, `engine ${ef.side}, target ${String(g.side)}`);
        tally.keys(w, ef, ["familyId", "monthly", ...NUM_KEYS], "ftp.byFamily");
        for (const key of NUM_KEYS) {
          if (key in row || key in g) tally.cell(`${w}.${key}`, row[key], g[key], RATE_KEYS.includes(key) ? FLOOR_RATES : FLOOR_DOLLARS);
        }
        const em = (row.monthly ?? {}) as Record<string, unknown>;
        for (const key of Object.keys(em)) tally.series(`${w}.monthly.${key}`, em[key], g.monthly?.[key]);
        for (const key of Object.keys(g.monthly ?? {})) if (!(key in em)) tally.fail(`${w}.monthly.${key}`, "a target the engine does not report");
      }
      for (const blk of ["book", "nimBridge"] as const) {
        const eb = e[blk] as unknown as Record<string, unknown>;
        for (const key of Object.keys(eb)) {
          if (`ftp.${blk}.${key}` in NOT_TARGETED) continue;
          tally.cell(`${blk}.${key}`, eb[key], t.ftp?.[blk]?.[key], key === "bookNimRate" ? FLOOR_RATES : FLOOR_DOLLARS);
        }
      }
      if (e.nimBridge.horizonMonths !== 12) tally.fail("nimBridge.horizonMonths", String(e.nimBridge.horizonMonths));
    }
    lines.push(tally.line(tag("ftp"), "FTP of the existing positions on the base scenario: every family row with its monthly series, the book and the NIM bridge", subject.targetsPath));
  }
  return lines;
}

/** The input hashes the targets record against the files on disk. */
function inputLine(repoRoot: string, subject: ReplicaSubject, t: Targets): CheckLine {
  const entries = Object.entries(t.inputs ?? {});
  const stale = entries.filter(([, v]) => createHash("sha256").update(readFileSync(join(repoRoot, v.path))).digest("hex") !== v.sha256);
  const id = subject === QUILLFIELD ? "inputs" : `${subject.id}.inputs`;
  return {
    id,
    status: stale.length === 0 && entries.length === INPUT_KEYS.length ? "pass" : "fail",
    detail: stale.length === 0
      ? `${entries.length} input files of ${subject.targetsPath} hash to the SHA-256 the targets record (anchor: the targets were written from these exact bytes)`
      : `input files changed since the targets were written: ${stale.map(([, v]) => v.path).join(", ")}; re-run the replica (npm run replica:check) and commit its targets`,
  };
}

export const replicaTieOutCheck: CapabilityCheck = {
  capabilityId: "python-replica-tie-out",
  title: "Quillfield Bank and the coverage book tied out against an independent Python replica, every cell at 1e-9",
  run({ repoRoot, market }) {
    const lines: CheckLine[] = [];
    const observed: string[] = [];
    for (const subject of SUBJECTS) {
      const t = readJson<Targets>(repoRoot, subject.targetsPath);
      lines.push(inputLine(repoRoot, subject, t));
      const runs = runEngine(repoRoot, market, subject);
      observed.push(...runs.observed);
      lines.push(...compareSubject(subject, t, runs));
    }
    return { lines, observedNotImplemented: observed };
  },
};
