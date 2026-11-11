/**
 * Acceptance check of Studio slice S3d-1 on Quillfield Bank version 1.3: liquidity-survival-path. It runs the
 * seeded survival-path setup in this process exactly as its launch does (./survivalPathRuns.ts;
 * apps/server/src/__tests__/s3d1SurvivalPath.test.ts holds that equality), and every existing Quillfield demo on
 * versions 1.2 and 1.3 of the bank.
 *
 * Two kinds of line:
 *  - an IDENTITY line asserts an independent anchor: a rule restated here from the record on the bank file's
 *    own values and the public HQLA haircuts, the run's own cash flow block, a recursion restated in this file, or a
 *    scope rule.
 *  - a REPLICA line (`s3d.<stem>`, the stems of the six provisional pins) ties a part of the run's liquidity stress
 *    block out against the independent Python replica's targets (replica/targets/demo-survival-path-v1.json), every
 *    cell the engine reports, enumerated from the engine side, at 1e-9 relative with the floors of
 *    ./replicaDemoTieOut.ts. Studio slice S3d-2 swapped them in for the pins; `s3d.coverage` holds that the parts cover
 *    the whole block, `s3d.inputs` the targets' demo, setup, scenarios and input files, `s3d.inputs.seed` the replica's
 *    copy of the seeded setup.
 *
 * Nothing from outside this repository is read here: the values are Quillfield Bank's, round illustrative public values.
 */
import type { PortfolioSpec, RunResult, SurvivalPathResult } from "@alm/engine";
import { featureDemos, type FeatureDemoId } from "../../../../apps/server/src/examples/featureDemos";
import { bankLiquidity } from "../../../../apps/server/src/examples/survivalPathDemo";
import { exampleBook, runDepositFormDemo } from "./depositFormRuns";
import { runFeatureDemo } from "./featureDemoRuns";
import { runSurvivalPathDemo } from "./survivalPathRuns";
import { survivalPathDemos } from "../../../../apps/server/src/examples/survivalPathDemo";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DemoTally } from "./replicaDemoTieOut";
import type { CapabilityCheck, CheckLine } from "./types";

const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(b), 1);
const M = (x: number): string => `${(x / 1e6).toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 })}M`;

function line(id: string, ok: boolean, detail: string): CheckLine {
  return { id, status: ok ? "pass" : "fail", detail };
}

/** The public LCR haircuts by HQLA level (12 CFR 249.21), restated here, not read from the engine. */
const HAIRCUT: Record<string, number> = { l1: 0, l2a: 0.15, l2b: 0.5 };

/** Version 1.2 of the bank, restated from version 1.3: the same file without the liquidity fields 1.3 added. */
export function bankV12(v13: PortfolioSpec): PortfolioSpec {
  const raw = structuredClone(v13) as PortfolioSpec & { liquidity?: unknown };
  delete raw.liquidity;
  raw.label = raw.label.replace("version 1.3", "version 1.2");
  if (raw.taxonomy !== undefined) {
    raw.taxonomy = {
      ...raw.taxonomy,
      label: "Liquidity roles the stress ladder reads",
      dimensions: raw.taxonomy.dimensions
        .filter((d) => d.id !== "hqla-level")
        .map((d) => (d.id === "liquidityRole" ? { ...d, values: d.values!.filter((v) => v !== "term-deposit") } : d)),
    };
  }
  raw.positions = raw.positions.map((p) => {
    const q = { ...p } as typeof p & { commitmentDials?: unknown };
    delete q.commitmentDials;
    if (q.dimensions?.liquidityRole === "term-deposit") delete q.dimensions;
    else if (q.dimensions?.["hqla-level"] !== undefined) {
      const { "hqla-level": _l, ...rest } = q.dimensions;
      void _l;
      q.dimensions = rest;
    }
    return q;
  });
  return raw;
}

/** The survival path restated in this file from its legs and its row's rates, for the recursion line. */
function restatedPath(sp: SurvivalPathResult): { cumulative: number[]; crossing: (buffer: number) => number | null } {
  const { legs, params } = sp;
  const inflow = sp.scenarioId === "bau" ? legs.inflow : legs.inflowStress;
  let hys = legs.pools.hys;
  let nib = legs.pools.nib;
  let cum = 0;
  const cumulative: number[] = [];
  for (let m = 1; m <= sp.horizonMonths; m++) {
    const h = hys * params.hysOutflowMonthly;
    const n = nib * params.nibOutflowMonthly;
    hys -= h;
    nib -= n;
    const w = legs.wholesaleMaturities[m - 1]! * (1 - params.wholesaleRenewal);
    // S3d fix round (L4): the renewal share rolls maturities only; early withdrawals leave in full.
    const cd = params.cdRenewal === undefined ? 0 : legs.cdMaturities[m - 1]! * (1 - params.cdRenewal) + (legs.cdEarlyWithdrawals?.[m - 1] ?? 0);
    const draw = m <= 12 ? (legs.undrawnFace * params.drawRate) / 12 : 0;
    cum += inflow[m - 1]! - h - n - w - cd - draw;
    cumulative.push(cum);
  }
  const crossing = (buffer: number): number | null => {
    let prev = buffer;
    for (let i = 0; i < cumulative.length; i++) {
      const now = buffer + cumulative[i]!;
      if (now < 0) return i + prev / (prev - now);
      prev = now;
    }
    return null;
  };
  return { cumulative, crossing };
}

/** Every block of a run but its provenance (which carries the inputs hash), as bytes. */
const blocksOf = (r: RunResult): string => {
  const { provenance: _p, ...rest } = r;
  void _p;
  return JSON.stringify(rest);
};

export const survivalPathCheck: CapabilityCheck = {
  capabilityId: "liquidity-survival-path",
  title: "The survival path, the commitment dials, the term-deposit role and the buffer from the HQLA tags, on Quillfield Bank version 1.3 (feature demo)",
  run(ctx) {
    const lines: CheckLine[] = [];
    const bank = exampleBook(ctx.repoRoot, "mid-size-bank-v1");
    const values = bankLiquidity(ctx.repoRoot);
    const r = runSurvivalPathDemo(ctx.repoRoot, ctx.market).result;
    const ls = r.liquidityStress!;
    const sp = ls.survivalPath!;
    const severe = ls.scenarios.find((s) => s.id === "severe")!;

    // Identity: the buffer is each hqla-stock position's face less its level's public haircut, read off the bank file.
    let want = 0;
    const parts: string[] = [];
    for (const p of bank.positions) {
      if (p.dimensions?.liquidityRole !== "hqla-stock") continue;
      const level = p.dimensions["hqla-level"] as string;
      want += p.terms.notional * (1 - HAIRCUT[level]!);
      parts.push(`${p.id} ${level}`);
    }
    lines.push(line("s3d.buffer.hqla-tags", ls.buffer === want && ls.bufferDerivation?.total === want && ls.bufferDerivation.notCounted.length === 0,
      `the run reads its buffer from the bank's five hqla-stock positions at face less the public haircut (level 1 none, 2A 15 percent): ${M(ls.buffer)} against ${M(want)} restated (${parts.join(", ")}) (anchor: 12 CFR 249.21)`));

    // Identity: maturities plus early withdrawals are what the run's own projection of the CD family pays, base scenario,
    // months 1..H; maturities fall only in the cohorts' contractual maturity months, read off the bank file; the renewal
    // share rolls the maturities only (S3d fix round, L4).
    const cdFamily = r.cashflows.byScenario[0]!.byFamily.find((f) => f.familyId === "mb-cds")!;
    const projected = Array.from({ length: sp.legs.horizonMonths }, (_, i) => cdFamily.series.principal[i] ?? 0);
    const early = sp.legs.cdEarlyWithdrawals ?? [];
    const cdWorst = Math.max(...projected.map((v, i) => Math.abs(v - sp.legs.cdMaturities[i]! - (early[i] ?? 0))));
    const cdTerms = bank.positions.find((p) => p.id === "mb-cds-1")!.terms as unknown as { cohorts: Array<{ monthsToMaturity: number }> };
    const months = new Set(cdTerms.cohorts.map((c) => c.monthsToMaturity));
    const maturityMonthsOk = sp.legs.cdMaturities.every((v, i) => (months.has(i + 1) ? v > 0 : v === 0));
    const renewal = values.cdRenewal.severe;
    const outWorst = Math.max(...severe.cdOut!.map((v, i) => rel(v, ls.cdMaturities![i]! * (1 - renewal) + ls.cdEarlyWithdrawals![i]!)));
    const firstYear = (xs: readonly number[]) => xs.slice(0, 12).reduce((a, b) => a + b, 0);
    lines.push(line("s3d.cd.payout", cdWorst <= 1e-6 && outWorst <= 1e-12 && maturityMonthsOk,
      `the certificates of deposit leave as the run's own projection pays them out (base scenario, ${sp.legs.horizonMonths} months, worst |diff| ${cdWorst.toExponential(2)} dollars): ${M(firstYear(sp.legs.cdMaturities))} maturing in the first year, in the cohorts' maturity months only (${maturityMonthsOk}), less the bank's severe renewal share ${renewal}, and ${M(firstYear(early))} withdrawn early, in full (worst relative ${outWorst.toExponential(2)}) (anchor: the run's cashflows block and the bank file's cohorts)`));

    // Identity (ruling 2026-11-05): the lines' $1,000M is undrawn now; the commitment face is it over (1 - Ubar);
    // the severe draw is the requirement (U99 - Ubar) x face, a twelfth of it in each of months 1..12 and nothing after.
    const face = values.line.undrawn / (1 - values.line.expectedUtilization);
    const requirement = (values.line.tailUtilization - values.line.expectedUtilization) * face;
    const draw = requirement / 12;
    const drawsOk = severe.draws.every((d) => rel(d, draw) <= 1e-12) && sp.rows.every((x) => (x.month <= 12 ? rel(x.draws, draw) <= 1e-12 : x.draws === 0));
    const resultOk = rel(ls.commitmentDials!.result.face, face) <= 1e-12 && rel(ls.commitmentDials!.result.bufferRequirement, requirement) <= 1e-12 && ls.commitmentDials!.dials.undrawn === values.line.undrawn;
    lines.push(line("s3d.draws.dials", drawsOk && resultOk && ls.commitmentDials?.statedSevereDrawRate === 0.25,
      `the undrawn lines' ${M(values.line.undrawn)} is a commitment face of ${M(face)} at Ubar ${values.line.expectedUtilization}; the severe draw is the requirement (U99 ${values.line.tailUtilization} - Ubar ${values.line.expectedUtilization}) x face = ${M(requirement)}, ${M(draw)} a month in months 1..12 and nothing after, in place of the table's 25 percent (anchor: the bank file's line)`));

    // Identity: the path's first 12 months are the ladder's severe row, and the whole path is the recursion restated here.
    const restated = restatedPath(sp);
    const ladderSame = sp.rows.slice(0, 12).every((x, i) => x.cumulative === severe.cumulative[i]);
    const pathWorst = Math.max(...sp.rows.map((x, i) => rel(x.cumulative, restated.cumulative[i]!)));
    lines.push(line("s3d.path.recursion", ladderSame && pathWorst <= 1e-9,
      `months 1..12 of the survival path are the ladder's severe row bit for bit (${ladderSame}), and all ${sp.horizonMonths} months equal the recursion restated in this check (worst relative ${pathWorst.toExponential(2)})`));

    // Identity: survival in months is the first crossing restated here; in days, months x 365 / 12; the facility after its haircut.
    const cross = restated.crossing(ls.buffer);
    const counted = values.facility.capacity * (1 - values.facility.haircut);
    const crossF = restated.crossing(ls.buffer + counted);
    const survOk =
      cross !== null && crossF !== null && rel(sp.ladderBuffer.survivalMonths!, cross) <= 1e-9 && rel(sp.withFacility!.survivalMonths!, crossF) <= 1e-9 &&
      rel(sp.ladderBuffer.survivalDays!, cross * 365 / 12) <= 1e-12 && sp.facility!.counted === counted && sp.withFacility!.buffer === ls.buffer + counted;
    lines.push(line("s3d.path.survival", survOk,
      `survival against the buffer ${sp.ladderBuffer.survivalMonths?.toFixed(6)} months (${sp.ladderBuffer.survivalDays?.toFixed(3)} days), with the FHLB line counted at ${M(counted)} (${M(values.facility.capacity)} less ${values.facility.haircut * 100} percent) ${sp.withFacility?.survivalMonths?.toFixed(6)} months (${sp.withFacility?.survivalDays?.toFixed(3)} days), each the crossing restated here and days = months x 365 / 12; the line never enters the ladder's buffer (${M(ls.buffer)})`));

    // Identity: the LCR reference beside it is factor x the amount undrawn now: 10 percent of the lines' $1,000M.
    const lcr = 0.1 * values.line.undrawn;
    lines.push(line("s3d.dials.lcr-reference", rel(ls.commitmentDials!.result.lcrReferenceOutflow, lcr) <= 1e-12 && ls.commitmentDials!.dials.lcrFactor === 0.1,
      `the LCR reference outflow is 10 percent (12 CFR 249.32(e)(1)(iii), a credit line to a non-financial company) of the ${M(values.line.undrawn)} undrawn now: ${M(ls.commitmentDials!.result.lcrReferenceOutflow)} (anchor: the regulation's factor on the undrawn amount)`));

    // Scope: version 1.3 moves no block of any existing Quillfield demo; only the provenance (the inputs hash) moves.
    const v12 = bankV12(bank);
    const ids: FeatureDemoId[] = featureDemos(ctx.repoRoot).map((d) => d.id);
    const moved: string[] = [];
    let compared = 0;
    for (const id of ids) {
      const a = runFeatureDemo(ctx.repoRoot, ctx.market, id, { book: v12 }).result;
      const b = runFeatureDemo(ctx.repoRoot, ctx.market, id).result;
      compared++;
      if (blocksOf(a) !== blocksOf(b)) moved.push(id);
    }
    const ta = runDepositFormDemo(ctx.repoRoot, ctx.market, "funding-tenor", { book: v12 }).result;
    const tb = runDepositFormDemo(ctx.repoRoot, ctx.market, "funding-tenor").result;
    compared++;
    if (blocksOf(ta) !== blocksOf(tb)) moved.push("funding-tenor");
    lines.push(line("quillfield.liquidity.scope", moved.length === 0,
      `version 1.2 against version 1.3 on every existing Quillfield demo (${compared}: ${[...ids, "funding-tenor"].join(", ")}): every block bit for bit, the constant-prepay demo's stress ladder included (it states its buffer and no CD renewal), only the provenance's inputs hash moves${moved.length === 0 ? "" : `; moved: ${moved.join(", ")}`} (anchor: an absent role or renewal changes nothing)`));

    // The replica lines, under the pin stems: each holds one part of the liquidity stress block.
    const t = readSurvivalTargets(ctx.repoRoot);
    lines.push(survivalInputsLine(ctx.repoRoot, t, r));
    lines.push(survivalSeedLine(ctx.repoRoot));
    const engine = { liquidityStress: ls };
    const target = { liquidityStress: t.liquidityStress };
    for (const [id, what, pick] of SURVIVAL_PARTS) lines.push(survivalTie(id, what, engine, target, pick));
    const rest = new DemoTally(0);
    rest.walk("liquidityStress", "liquidityStress", ls, t.liquidityStress, (n) => !SURVIVAL_PARTS.some(([, , pick]) => pick(n)));
    lines.push(line("s3d.coverage", rest.cells === 0,
      `the ${SURVIVAL_PARTS.length} replica lines hold every cell of the liquidity stress block: ${rest.cells} cells left to no line (anchor: the parts' own path rules, read from the engine side)`));
    return { lines, observedNotImplemented: [...new Set(r.notImplemented.map((n) => n.layer))] };
  },
};

export const SURVIVAL_TARGETS_PATH = "replica/targets/demo-survival-path-v1.json";

/** The input files the targets must name, at these paths (the hashes are checked against the files). */
export const SURVIVAL_INPUT_PATHS: Readonly<Record<string, string>> = {
  bank: "examples/mid-size-bank-v1.json",
  survival: "replica/inputs/survival-path-v1.json",
  demos: "replica/inputs/feature-demos-v1.json",
  market: "packages/kernel/public/market_public.json",
  sofr: "examples/sofr-monthly-v1.json",
  cdParams: "replica/inputs/cd-illustrative-v3.json",
};

const SURVIVAL_SCENARIOS = ["S0", "S100", "S-100", "S200", "S-200"];

interface SurvivalTargets {
  demo: string;
  setupId: string;
  inputs: Record<string, { path: string; sha256: string }>;
  scenarios: Array<{ id: string }>;
  liquidityStress: unknown;
}

export function readSurvivalTargets(repoRoot: string): SurvivalTargets {
  return JSON.parse(readFileSync(join(repoRoot, SURVIVAL_TARGETS_PATH), "utf8")) as SurvivalTargets;
}

/** The parts of the block each replica line holds, by normalized path, with the line's stem. */
export const SURVIVAL_PARTS: ReadonlyArray<[string, string, (n: string) => boolean]> = [
  ["s3d.buffer", "the buffer and its derivation from the HQLA tags, the pools, the undrawn face and the wholesale and term-deposit maturities and early withdrawals",
    (n) => /^liquidityStress\.(horizonMonths|buffer|undrawnFace|pools|wholesaleMaturities|cdMaturities|cdEarlyWithdrawals|bufferDerivation)\b/.test(n)],
  ["s3d.severe-survival", "the three ladder rows over 12 months: their rates, inflows, outflows, CD outflows, draws, net, cumulative and survival",
    (n) => /^liquidityStress\.scenarios\[\]\./.test(n) && !/\.peak(Shortfall|Month)$/.test(n)],
  ["s3d.severe-peak", "the three ladder rows' peak shortfall and its month", (n) => /^liquidityStress\.scenarios\[\]\.peak(Shortfall|Month)$/.test(n)],
  ["s3d.path-survival", "the survival path on the severe row to its horizon: its rates, legs, every month's row and the reading against the ladder's buffer",
    (n) => /^liquidityStress\.survivalPath\./.test(n) && !/^liquidityStress\.survivalPath\.(facility|withFacility|peakShortfall|peakMonth)\b/.test(n)],
  ["s3d.path-survival-facility", "the borrowing line after its haircut and the reading against the buffer plus the line",
    (n) => /^liquidityStress\.survivalPath\.(facility|withFacility)\b/.test(n)],
  ["s3d.path-peak", "the survival path's peak shortfall and its month", (n) => /^liquidityStress\.survivalPath\.peak(Shortfall|Month)$/.test(n)],
  ["s3d.dials", "the commitment dials, their results (requirement, contingent charge, LCR reference, the internal 30-day draw) and the stated and linked severe draw rates",
    (n) => /^liquidityStress\.commitmentDials\b/.test(n)],
];

function survivalTie(id: string, what: string, engine: unknown, target: unknown, pick: (n: string) => boolean): CheckLine {
  const tally = new DemoTally(0);
  tally.walk("", "", engine, target, (n) => pick(n.replace(/^\./, "")));
  return tally.line(id, what, SURVIVAL_TARGETS_PATH);
}

/** The targets name the demo, the seeded setup, the scenarios this check expects and the input files as they are. */
function survivalInputsLine(repoRoot: string, t: SurvivalTargets, r: RunResult): CheckLine {
  const demo = survivalPathDemos(repoRoot)[0]!;
  const inputs = t.inputs ?? {};
  const misplaced = Object.entries(SURVIVAL_INPUT_PATHS).filter(([k, path]) => inputs[k]?.path !== path).map(([k]) => k);
  const extra = Object.keys(inputs).filter((k) => !(k in SURVIVAL_INPUT_PATHS));
  const stale = Object.entries(SURVIVAL_INPUT_PATHS).filter(([k, path]) => createHash("sha256").update(readFileSync(join(repoRoot, path))).digest("hex") !== inputs[k]?.sha256).map(([k]) => k);
  const got = (t.scenarios ?? []).map((s) => s.id);
  const ran = r.cashflows.byScenario.map((s) => s.scenarioId);
  const ok = t.demo === demo.id && t.setupId === demo.setup.id && JSON.stringify(got) === JSON.stringify(SURVIVAL_SCENARIOS) && JSON.stringify(ran) === JSON.stringify(SURVIVAL_SCENARIOS)
    && misplaced.length === 0 && extra.length === 0 && stale.length === 0;
  return line("s3d.inputs", ok, ok
    ? `${SURVIVAL_TARGETS_PATH} is the ${demo.id} demo on setup ${demo.setup.id}, scenarios ${SURVIVAL_SCENARIOS.join(", ")} (the engine ran the same), and its ${Object.keys(SURVIVAL_INPUT_PATHS).length} input files sit at the check's own paths and hash as recorded (anchor: the check's own lists and the files on disk)`
    : `targets demo ${t.demo}, setup ${t.setupId} (want ${demo.setup.id}), scenarios ${got.join(",")} (the engine ran ${ran.join(",")}), inputs not at the check's paths ${misplaced.join(", ") || "none"}, unexpected ${extra.join(", ") || "none"}, stale ${stale.join(", ") || "none"}`);
}

/** The replica's input file of the seeded setup equals the seed, so the replica reads what the launch runs. */
function survivalSeedLine(repoRoot: string): CheckLine {
  const file = JSON.parse(readFileSync(join(repoRoot, "replica", "inputs", "survival-path-v1.json"), "utf8")) as { demos: unknown };
  const seed = survivalPathDemos(repoRoot).map((d) => ({ id: d.id, bookId: d.bookId, setIds: d.setIds, setup: d.setup }));
  const same = JSON.stringify(file.demos) === JSON.stringify(seed);
  return line("s3d.inputs.seed", same, `replica/inputs/survival-path-v1.json holds the seeded survival-path setup exactly as the seed builds it (${same}) (anchor: apps/server/src/examples/survivalPathDemo.ts)`);
}
