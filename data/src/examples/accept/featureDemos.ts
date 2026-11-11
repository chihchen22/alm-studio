/**
 * Acceptance checks on the example bank's feature demos: seg-ear,
 * per-position-drilldown and quillfield-feature-demos. Each runs the seeded demo setup on Quillfield Bank version 1.1 in
 * this process, exactly as its launch does (./featureDemoRuns.ts; apps/server/src/__tests__/s3b1FeatureDemos.test.ts
 * holds that equality).
 *
 * Two kinds of line:
 *  - an IDENTITY line asserts an independent anchor: a mathematical identity, a degeneracy limit, a conservation, or the
 *    setup's own settings echoed by the run.
 *  - a REPLICA line, id `demo.<feature>.<measure>`, ties the measure out against the independent Python replica's
 *    targets (replica/targets/demo-<feature>-v1.json): every cell the engine reports at 1e-9 relative, floors 1e-6
 *    dollars and 1e-12 on rates, enumerated from the engine side (./replicaDemoTieOut.ts). Studio slice S3b-2 swapped
 *    these in for the provisional pins, keeping each pin's id stem; a `demo.<feature>.inputs` line checks the
 *    targets name the demo, its setup and the scenarios this check expects, on the input files as they are.
 *
 * Nothing from outside this repository is read here: the values are Quillfield Bank's, an illustrative public bank.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PortfolioSpec, RunResult } from "@alm/engine";
import { featureDemos, featureDemoSets } from "../../../../apps/server/src/examples/featureDemos";
import { demoBank, runFeatureDemo } from "./featureDemoRuns";
import { DemoTally, demoInputsLine, demoTargetsPath, readDemoTargets, segFloorOf, segForComparison, type DemoTargets } from "./replicaDemoTieOut";
import type { CapabilityCheck, CheckLine } from "./types";

const REL = 1e-9;
const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(b), 1);
const M = (x: number): string => `${(x / 1e6).toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 })}M`;

function line(id: string, ok: boolean, detail: string): CheckLine {
  return { id, status: ok ? "pass" : "fail", detail };
}

const eveAt = (r: RunResult, s: string): number => r.eve.byScenario.find((x) => x.scenarioId === s)!.eve;
const famPv = (r: RunResult, s: string): Map<string, number> => new Map(r.eve.byScenario.find((x) => x.scenarioId === s)!.byFamily.map((f) => [f.familyId, f.pv]));

// ---------------------------------------------------------------------------
// The replica lines
// ---------------------------------------------------------------------------

/** One replica line: walk the engine value under `root` against the target, the paths `pick` holds. */
function tie(id: string, what: string, demo: string, root: string, engine: unknown, target: unknown, pick: (norm: string) => boolean = () => true, segFloor = 0): CheckLine {
  const tally = new DemoTally(segFloor);
  tally.walk(root, root, engine, target, pick);
  return tally.line(id, what, demoTargetsPath(demo));
}

/** A demo's inputs line and one replica line per result block, each named by its stem. */
function blocks(repoRoot: string, demo: string, setupId: string, result: RunResult, list: ReadonlyArray<[string, keyof RunResult, string]>): CheckLine[] {
  const t: DemoTargets = readDemoTargets(repoRoot, demo);
  const out = [demoInputsLine(repoRoot, demo, setupId, t, result.eve.byScenario.map((s) => s.scenarioId))];
  for (const [measure, key, what] of list) out.push(tie(`demo.${demo}.${measure}`, what, demo, key as string, result[key], t[key as string]));
  return out;
}

// ---------------------------------------------------------------------------
// seg-ear
// ---------------------------------------------------------------------------

export const segEarCheck: CapabilityCheck = {
  capabilityId: "seg-ear",
  title: "SEG / earnings-at-risk on the example bank (feature demo)",
  run(ctx) {
    const lines: CheckLine[] = [];
    const { demo, result } = runFeatureDemo(ctx.repoRoot, ctx.market, "seg");
    const seg = result.seg;
    if (seg === undefined) return { lines: [line("demo.seg.block", false, "the SEG demo's run carries no seg block")], observedNotImplemented: result.notImplemented.map((t) => t.layer) };
    const want = demo.setup.seg!;
    lines.push(line("demo.seg.knobs", seg.shockBp === want.shockBp && seg.horizonMonths === want.horizonMonths && seg.niiShockBp === want.niiShockBp && seg.segBank.length === want.horizonMonths,
      `the run reads the setup's knobs: shock ${seg.shockBp} bp (setup ${want.shockBp}), horizon ${seg.horizonMonths} months with ${seg.segBank.length} bank SEG months (setup ${want.horizonMonths}), NII shock ${seg.niiShockBp} bp (setup ${want.niiShockBp}) (anchor: the seeded setup document)`));
    // Identity: with the cohort-0 overlay off, the bank SEG of every family but the overlaid one is unchanged, and the
    // overlaid family's moves (the overlay reaches cohort 0 of that family only).
    const off = runFeatureDemo(ctx.repoRoot, ctx.market, "seg", { edit: (s) => { const { cprOverlay: _o, ...knobs } = s.seg!; return { ...s, seg: knobs }; } }).result.seg!;
    const fams = Object.keys(seg.byFamily);
    const others = fams.filter((f) => f !== "mb-resi-mortgages");
    const othersSame = others.every((f) => JSON.stringify(seg.byFamily[f]!.segOutstanding) === JSON.stringify(off.byFamily[f]!.segOutstanding));
    const resiMoves = JSON.stringify(seg.byFamily["mb-resi-mortgages"]!.segOutstanding) !== JSON.stringify(off.byFamily["mb-resi-mortgages"]!.segOutstanding);
    lines.push(line("demo.seg.overlay-scope", othersSame && resiMoves,
      `the cohort-0 overlay on mb-resi-mortgages moves that family's SEG (${resiMoves}) and leaves the other ${others.length} families' SEG bit for bit (${othersSame}) (anchor: the overlay reaches cohort 0 of its own family only)`));
    // The replica lines: the whole block. Since slice K1 (corrected-v1) the replacement deposit vintages read the run's
    // history on both sides, so nothing is compared out (D6 closed).
    const t = readDemoTargets(ctx.repoRoot, "seg");
    lines.push(demoInputsLine(ctx.repoRoot, "seg", demo.setup.id, t, result.eve.byScenario.map((s) => s.scenarioId)));
    const floor = segFloorOf(seg.shockBp);
    const e = segForComparison(seg as unknown as Record<string, unknown>, floor);
    const g = segForComparison(t.seg as Record<string, unknown>, floor);
    const nii = (k: string) => (n: string) => n.endsWith(`.nii.${k}12`) || n.endsWith(`.nii.${k}Monthly`);
    const rest = (n: string) => !/\.nii\.(base|up|down)(12|Monthly)$/.test(n);
    lines.push(tie("demo.seg.nii-base12", "seg.book.nii and seg.byFamily[].nii, base12 and the 12 base months, every family", "seg", "seg", e, g, nii("base"), floor));
    lines.push(tie("demo.seg.nii-up12", "the same at the up shock, every family", "seg", "seg", e, g, nii("up"), floor));
    lines.push(tie("demo.seg.nii-down12", "the same at the down shock, every family", "seg", "seg", e, g, nii("down"), floor));
    lines.push(tie("demo.seg.seg-bank",
      `the rest of the block: seg.segBank, the book's and every family's segOutstanding, segPeriodic, EBP and peak, the knobs, nimPct, totalAssetNotional and the uncovered positions, every family in full. SEG cells read a floor of ${floor.toExponential(2)} dollars, the 1e-6 dollar floor carried through the SEG divisor 12 / (2 x ${seg.shockBp} bp); a near-zero peak's month is not compared (D7)`,
      "seg", "seg", e, g, rest, floor));
    return { lines, observedNotImplemented: result.notImplemented.map((t) => t.layer) };
  },
};

// ---------------------------------------------------------------------------
// per-position-drilldown
// ---------------------------------------------------------------------------

export const perPositionCheck: CapabilityCheck = {
  capabilityId: "per-position-drilldown",
  title: "Per-position results on the example bank (feature demo)",
  run(ctx) {
    const lines: CheckLine[] = [];
    const bank = demoBank(ctx.repoRoot);
    const { demo, result, instruments } = runFeatureDemo(ctx.repoRoot, ctx.market, "instruments");
    const file = instruments!;
    const scenarios = result.eve.byScenario.map((s) => s.scenarioId);
    const shapeOk = file.positions.length === bank.positions.length && file.positions.every((p) => p.byScenario.length === scenarios.length);
    lines.push(line("demo.instruments.rows", shapeOk,
      `${file.positions.length} rows (the bank's ${bank.positions.length} positions), each with ${scenarios.length} scenarios (anchor: the book and the setup's scenario list; the four top chart nodes reach every leaf)`));
    // Identity: the rows' values summed by family are the run's own family values, every scenario, at 1e-9 relative,
    // every family included. A balance held at book is valued at par on both sides (Spec P1, ruling 2026-11-04).
    let worst = 0;
    let families = 0;
    for (const s of scenarios) {
      const fam = famPv(result, s);
      const sums = new Map<string, number>();
      for (const p of file.positions) sums.set(p.familyId, (sums.get(p.familyId) ?? 0) + p.byScenario.find((x) => x.scenarioId === s)!.pv);
      families = 0;
      for (const [f, v] of sums) {
        families += 1;
        worst = Math.max(worst, rel(v, fam.get(f) ?? Number.NaN));
      }
    }
    lines.push(line("demo.instruments.family-sum", families > 0 && worst <= REL && families === sumsFamilies(bank),
      `the positions' values summed by family equal eve.byScenario[].byFamily[].pv for all ${families} families in all ${scenarios.length} scenarios, the family held at book included (valued at par on both sides): largest relative difference ${worst.toExponential(2)} (anchor: present value is linear in the cash flows, so a family's value is the sum of its positions; a balance held at book is its par)`));
    // Identity: the rows carry the bank's own discount spreads, so a reader of the file sees what spread-consistent reads.
    const stated = bank.positions.filter((b) => typeof b.discountSpreadBp === "number");
    const carried = file.positions.filter((p) => typeof p.discountSpreadBp === "number");
    const spreadsOk = stated.length > 0 && carried.length === stated.length && file.positions.every((p) => {
      const b = bank.positions.find((x) => x.id === p.positionId);
      return b !== undefined && p.discountSpreadBp === b.discountSpreadBp;
    });
    lines.push(line("demo.instruments.spreads", spreadsOk,
      `${carried.length} rows carry a discount spread, each its position's, and the bank file states ${stated.length}; every other row carries none, as its position states none (anchor: examples/mid-size-bank-v1.json version 1.1)`));
    // The replica line: every row of the file.
    const t = readDemoTargets(ctx.repoRoot, "instruments");
    lines.push(demoInputsLine(ctx.repoRoot, "instruments", demo.setup.id, t, scenarios));
    lines.push(tie("demo.instruments.pv-total",
      "every row of instruments.json: pv, nii12, balance12 and principal12 in every scenario, walMonths, firstRepricingMonth, discountSpreadBp and the placement fields. A balance held at book is valued at par, its opening balance, in every scenario, as EVE values it (Spec P1)",
      "instruments", "instruments", file, t.instruments));
    return { lines, observedNotImplemented: result.notImplemented.map((t) => t.layer) };
  },
};

// ---------------------------------------------------------------------------
// quillfield-feature-demos: the other five demos
// ---------------------------------------------------------------------------

/** The number of families that hold at least one position. */
function sumsFamilies(bank: PortfolioSpec): number {
  return new Set(bank.positions.map((p) => p.familyId)).size;
}

/** The bank with every discount spread removed: the spread-consistent basis's degeneracy limit. */
function withoutSpreads(bank: PortfolioSpec): PortfolioSpec {
  return { ...bank, positions: bank.positions.map(({ discountSpreadBp: _d, ...p }) => p) };
}

/** The replica's input file of the seeded demo setups equals the seed, so the replica reads what the launch runs. */
function seedLine(repoRoot: string): CheckLine {
  const file = JSON.parse(readFileSync(join(repoRoot, "replica", "inputs", "feature-demos-v1.json"), "utf8")) as { sets: unknown; demos: Array<{ id: string; setIds: string[]; setup: unknown }> };
  const seed = { sets: featureDemoSets(repoRoot), demos: featureDemos(repoRoot).map((d) => ({ id: d.id, setIds: d.setIds, setup: d.setup })) };
  const same = JSON.stringify({ sets: file.sets, demos: file.demos }) === JSON.stringify(seed);
  return line("demo.inputs.seed", same,
    `replica/inputs/feature-demos-v1.json holds the seven seeded setups and both sets exactly as the seed builds them (${same}) (anchor: apps/server/src/examples/featureDemos.ts, the documents the seed stores)`);
}

type Knots = { kind?: string; shocks?: Array<{ tenorYears: number; shockBp: number }> };

/**
 * The six shock vectors: the replica computes each from the standard's published formula (replica/alm_replica/srp.py,
 * method note M11) and runs its own; here they are held against the vectors the seeded setup carries, knot by knot, the
 * tenors equal and the shocks within 1e-12 bp.
 */
function sixShockVectorsLine(repoRoot: string): CheckLine {
  const ids = ["SRP-PUP", "SRP-PDN", "SRP-SUP", "SRP-SDN", "SRP-STEEP", "SRP-FLAT"];
  const setup = featureDemos(repoRoot).find((d) => d.id === "six-shocks")!.setup as unknown as { scenarios: { items: Array<{ id?: string; rateSpec?: Knots }> } };
  const t = readDemoTargets(repoRoot, "six-shocks");
  let worst = 0;
  let knots = 0;
  const bad: string[] = [];
  for (const id of ids) {
    const own = (t.scenarios.find((s) => s.id === id)?.rateSpec ?? {}) as Knots;
    const seeded = setup.scenarios.items.find((i) => i.id === id)?.rateSpec ?? {};
    const a = own.shocks ?? [];
    const b = seeded.shocks ?? [];
    if (own.kind !== "custom" || seeded.kind !== "custom" || a.length !== 11 || b.length !== 11) {
      bad.push(`${id}: ${a.length} replica knots, ${b.length} seeded`);
      continue;
    }
    a.forEach((x, k) => {
      knots += 1;
      const d = Math.abs(x.shockBp - b[k]!.shockBp);
      worst = Math.max(worst, d);
      if (x.tenorYears !== b[k]!.tenorYears || !(d <= 1e-12)) bad.push(`${id} knot ${k}: tenor ${x.tenorYears}/${b[k]!.tenorYears}, ${x.shockBp}/${b[k]!.shockBp} bp`);
    });
  }
  return line("demo.six-shocks.vectors", bad.length === 0 && knots === 66,
    `the replica's own six vectors, from the standard's formula (S(t) = exp(-t/4); parallel 200, short 300, long 225 bp; steepener -0.65 short + 0.9 long, flattener +0.8 short - 0.6 long), equal the seeded setup's at all ${knots} knots: tenors equal, largest shock difference ${worst.toExponential(2)} bp${bad.length ? `; ${bad.length} failing, first: ${bad.slice(0, 3).join(" | ")}` : ""} (anchor: the published formula, method note M11, against apps/server/src/examples/featureDemos.ts)`);
}

export const featureDemosCheck: CapabilityCheck = {
  capabilityId: "quillfield-feature-demos",
  title: "The example bank's feature demos: regulatory deposit convention, spread-consistent discounting, six standardized shocks, constant prepayment with the stress inflow line, the fixed-rate ladder",
  run(ctx) {
    const lines: CheckLine[] = [seedLine(ctx.repoRoot)];
    const observed = new Set<string>();
    const note = (r: RunResult) => { for (const t of r.notImplemented) observed.add(t.layer); return r; };
    const bank = demoBank(ctx.repoRoot);
    const setupOf = (id: Parameters<typeof runFeatureDemo>[2]) => featureDemos(ctx.repoRoot).find((d) => d.id === id)!.setup.id;

    // 1. The regulatory deposit convention.
    const reg = note(runFeatureDemo(ctx.repoRoot, ctx.market, "regulatory").result);
    const deposits = bank.positions.filter((p) => p.terms.type === "nmd" || p.terms.type === "nmd-b").map((p) => p.id);
    const children = Object.entries(reg.parentOf ?? {});
    const perParent = deposits.map((d) => children.filter(([, parent]) => parent === d).length);
    lines.push(line("demo.regulatory.slotting", deposits.length > 0 && perParent.every((n) => n === 11) && children.length === 11 * deposits.length,
      `each of the ${deposits.length} non-maturity deposits is split into ${perParent.join(", ")} children (ten core rungs and one non-core slice each; the cd book stays whole) (anchor: the convention's prescribed ladder)`));
    lines.push(...blocks(ctx.repoRoot, "regulatory", setupOf("regulatory"), reg, [
      ["eve", "eve", "run-off EVE on the regulatory convention, by family and in total, every scenario"],
      ["parent-of", "parentOf", "the child-to-parent map: 44 children, ten core rungs and one non-core slice for each deposit"],
      ["nii", "nii", "run-off NII by month, family and horizon (12, 24 and 60 months), every scenario"],
      ["cashflows", "cashflows", "the projection by family, balance, principal and interest by month, every scenario"],
      ["gap", "gap", "both gap ladders, nine bands and 360 months (the core rungs held out of the repricing ladder)"],
      ["ftp", "ftp", "FTP of every family with the children priced, the book and the NIM bridge"],
    ]));

    // 2. Spread-consistent discounting.
    const sc = note(runFeatureDemo(ctx.repoRoot, ctx.market, "spread-consistent").result);
    const allIn = note(runFeatureDemo(ctx.repoRoot, ctx.market, "spread-consistent", { edit: (s) => ({ ...s, eve: { ...s.eve, discountBasis: "all-in" } }) }).result);
    const zero = note(runFeatureDemo(ctx.repoRoot, ctx.market, "spread-consistent", { book: withoutSpreads(bank) }).result);
    const spreadFams = new Set(bank.positions.filter((p) => (p.discountSpreadBp ?? 0) !== 0).map((p) => p.familyId));
    let lowerOk = true;
    let sameOk = true;
    for (const s of sc.eve.byScenario.map((x) => x.scenarioId)) {
      const a = famPv(sc, s);
      const b = famPv(allIn, s);
      for (const [f, v] of a) {
        if (spreadFams.has(f)) lowerOk &&= v < b.get(f)!;
        else sameOk &&= v === b.get(f);
      }
    }
    lines.push(line("demo.spread-consistent.against-all-in", spreadFams.size > 0 && lowerOk && sameOk,
      `every family carrying a spread (${spreadFams.size}) is worth less than on all-in in every scenario (${lowerOk}), and every other family (deposits, securities, borrowings) is worth exactly its all-in value (${sameOk}) (anchor: the factor is the all-in one times exp(-s t), s 0 for deposits)`));
    const zeroSame = JSON.stringify(zero.eve.byScenario.map((x) => x.byFamily)) === JSON.stringify(allIn.eve.byScenario.map((x) => x.byFamily));
    lines.push(line("demo.spread-consistent.zero-spread", zeroSame,
      `with every spread removed the spread-consistent run equals the all-in run, family by family, every scenario, bit for bit (${zeroSame}) (anchor: the degeneracy limit, a position with spread 0 discounts exactly as on all-in)`));
    lines.push(...blocks(ctx.repoRoot, "spread-consistent", setupOf("spread-consistent"), sc, [
      ["eve", "eve", "EVE on the spread-consistent basis, by family (the nine spread families included) and in total, every scenario"],
    ]));

    // 3. The six standardized shocks, against the parallel grid of the fixed-ladder demo (risk-free, same base).
    const six = note(runFeatureDemo(ctx.repoRoot, ctx.market, "six-shocks").result);
    const fixed = note(runFeatureDemo(ctx.repoRoot, ctx.market, "fixed-ladder").result);
    const pu = rel(eveAt(six, "SRP-PUP"), eveAt(fixed, "S200"));
    const pd = rel(eveAt(six, "SRP-PDN"), eveAt(fixed, "S-200"));
    const base = eveAt(six, "S0") === eveAt(fixed, "S0");
    lines.push(line("demo.six-shocks.parallel-equivalence", pu <= 1e-12 && pd <= 1e-12 && base,
      `parallel up and down equal the parallel grid's +200 and -200 bp values (relative ${pu.toExponential(2)} and ${pd.toExponential(2)}, a knot vector against a parallel spec) and the base is the same value bit for bit (${base}) (anchor: the standard's parallel shocks are +-200 bp at every tenor)`));
    lines.push(sixShockVectorsLine(ctx.repoRoot));
    lines.push(...blocks(ctx.repoRoot, "six-shocks", setupOf("six-shocks"), six, [
      ["eve", "eve", "run-off EVE under the base and the six standardized shocks, by family and in total"],
      ["nii", "nii", "run-off NII by month, family and horizon, every scenario"],
      ["cashflows", "cashflows", "the projection by family under each shock"],
      ["gap", "gap", "both gap ladders under each shock, nine bands and 360 months"],
    ]));

    // 4. Constant prepayment and the stress inflow line.
    const cpRun = note(runFeatureDemo(ctx.repoRoot, ctx.market, "constant-prepay").result);
    const cp = cpRun.liquidityStress!;
    const sc12 = (id: string) => cp.scenarios.find((s) => s.id === id)!.inflow.slice(0, 12).reduce((a, b) => a + b, 0);
    const mod = cp.scenarios.find((s) => s.id === "moderate")!.inflow;
    const sev = cp.scenarios.find((s) => s.id === "severe")!.inflow;
    const stressSame = JSON.stringify(mod) === JSON.stringify(sev);
    lines.push(line("demo.constant-prepay.stress-line", stressSame && sc12("moderate") < sc12("bau"),
      `the moderate and severe rows read one inflow line, bit for bit (${stressSame}), and it is below business as usual over the first 12 months (${M(sc12("moderate"))} against ${M(sc12("bau"))}) because the stress speeds are half the business-as-usual ones (anchor: the stress rows read stressAnnualCpr, bau reads annualCpr)`));
    lines.push(...blocks(ctx.repoRoot, "constant-prepay", setupOf("constant-prepay"), cpRun, [
      ["inflow", "liquidityStress", "the liquidity stress ladder: pools, maturities and every row's inflow, outflows, draws, net, cumulative, survival and peak"],
      ["cashflows", "cashflows", "the projection by family, the two constant-CPR families included, every scenario"],
      ["eve", "eve", "run-off EVE with the constant-CPR set, by family and in total"],
      ["nii", "nii", "run-off NII with the constant-CPR set, by month, family and horizon"],
    ]));

    // 5. The fixed-rate gap ladder.
    const ladder = fixed.gap.fixedRate!;
    const lockedAssets = bank.positions.filter((p) => (p.terms.type === "fixed-loan" || p.terms.type === "mortgage") && bank.coa.families.find((f) => f.id === p.familyId)!.side === "asset").reduce((a, p) => a + (p.terms as { notional: number }).notional, 0);
    const lockedLiabs = bank.positions.filter((p) => (p.terms.type === "fixed-loan" || p.terms.type === "cd") && bank.coa.families.find((f) => f.id === p.familyId)!.side === "liability").reduce((a, p) => a + (p.terms as { notional: number }).notional, 0);
    const sumA = ladder.rows.reduce((a, r) => a + r.assets, 0);
    const sumL = ladder.rows.reduce((a, r) => a + r.liabilities, 0);
    lines.push(line("demo.fixed-ladder.conservation", rel(sumA, lockedAssets) <= REL && rel(sumL, lockedLiabs) <= REL,
      `the nine bands hold ${M(sumA)} of assets and ${M(sumL)} of liabilities: every principal dollar of the rate-locked positions, ${M(lockedAssets)} and ${M(lockedLiabs)} of notional (anchor: principal is conserved and nothing is cut at the grid horizon)`));
    const tf = readDemoTargets(ctx.repoRoot, "fixed-ladder");
    lines.push(demoInputsLine(ctx.repoRoot, "fixed-ladder", setupOf("fixed-ladder"), tf, fixed.eve.byScenario.map((s) => s.scenarioId)));
    lines.push(tie("demo.fixed-ladder.rows", "gap.fixedRate: the nine bands' assets, liabilities, gap and cumulative gap, and the uncovered positions", "fixed-ladder", "gap",
      { fixedRate: fixed.gap.fixedRate }, (tf.gap as Record<string, unknown> | undefined) ?? undefined));

    return { lines, observedNotImplemented: [...observed] };
  },
};
