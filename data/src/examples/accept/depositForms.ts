/**
 * Acceptance checks of Studio slice S3c-1 on Quillfield's deposit desk (examples/quillfield-deposit-desk-v1.json)
 * and, for the floater's funding tenor, on Quillfield Bank version 1.2: nmd-b-full-beta-form,
 * nmd-component-decay-dated-path, ftp-replicating-portfolio-credit and ftp-credit-scenario-reading, back in the core
 * register. Each runs the seeded setup in this process exactly as its launch does (./depositFormRuns.ts;
 * apps/server/src/__tests__/s3c1DepositForms.test.ts holds that equality).
 *
 * Two kinds of line:
 *  - an IDENTITY line asserts an independent anchor: a formula restated here from the record,
 *    the book file's own terms, the market file's own quotes, a conservation, or a scope rule.
 *  - a REPLICA line ties a measure out against the independent Python replica's targets
 *    (replica/targets/deposit-forms-v1.json): every cell the engine reports, enumerated from the engine side, at 1e-9
 *    relative with the floors of ./replicaDemoTieOut.ts (./replicaDeskTieOut.ts). Studio slice S3c-2 swapped these in
 *    for the fourteen provisional pins, keeping each pin's id stem; a `<feature>.inputs` line checks the targets
 *    name the demos, their setups and the scenarios this check expects, on the input files as they are.
 *
 * Nothing from outside this repository is read here: the values are the deposit desk's and Quillfield Bank's, round
 * illustrative public values.
 */
import type { PortfolioSpec, RunResult } from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";
import { DESK_COMPONENT_WINDOW, DESK_FULL_FORM, deskComponentDecay } from "../../../../apps/server/src/examples/depositForms";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { depositFormDemos, depositFormSets } from "../../../../apps/server/src/examples/depositForms";
import { exampleBook, runDepositFormDemo } from "./depositFormRuns";
import { creditView, deskDemo, deskInputsLine, deskTie, readDeskTargets, type DeskDemoId } from "./replicaDeskTieOut";
import type { CapabilityCheck, CheckLine } from "./types";

const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
const M = (x: number): string => `${(x / 1e6).toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 })}M`;
const P = (x: number): string => `${(x * 100).toFixed(8)}%`;

function line(id: string, ok: boolean, detail: string): CheckLine {
  return { id, status: ok ? "pass" : "fail", detail };
}

const series = (r: RunResult, s: string, f: string) => r.cashflows.byScenario.find((x) => x.scenarioId === s)!.byFamily.find((x) => x.familyId === f)!;
const famPv = (r: RunResult, s: string, f: string): number => r.eve.byScenario.find((x) => x.scenarioId === s)!.byFamily.find((x) => x.familyId === f)!.pv;
const layers = (...rs: RunResult[]): string[] => [...new Set(rs.flatMap((r) => r.notImplemented.map((n) => n.layer)))];
const scenarioIds = (r: RunResult): string[] => r.cashflows.byScenario.map((s) => s.scenarioId);
/** The parallel shift of the seeded grid's scenarios, percent, by id (regulatory-grid-v1: S0, S100, S-100, S200, S-200). */
const shiftOf = (id: string): number => (id === "S0" ? 0 : Number(id.slice(1)) / 100);

// ---------------------------------------------------------------------------
// The formulas, restated from the record, independent of the engine's modules
// ---------------------------------------------------------------------------

/** The money market book's S-curve, read from the desk file. */
function mmaCurve(book: PortfolioSpec) {
  const p = book.positions.find((x) => x.familyId === "dd-mma")!;
  if (p.terms.type !== "nmd-b") throw new Error("dd-mma is not nmd-b");
  return p.terms.sCurve;
}

/** beta_eff at a shift of the base state, restated: S-curve beta(r) x (1 - delta x v), delta by the last move. */
function betaEff(book: PortfolioSpec, shiftPct: number): number {
  const c = mmaCurve(book);
  const f = DESK_FULL_FORM;
  const r = Math.max(f.baseShortRatePct + shiftPct, 0);
  const rising = shiftPct > 0 ? true : shiftPct < 0 ? false : f.baseLastMove === "rise";
  const beta = c.betaMin + (c.betaMax - c.betaMin) / (1 + Math.exp(-c.k * (r - c.m)));
  return beta * Math.min(Math.max(1 - (rising ? f.deltaUp : f.deltaDown) * f.volRatio, 0), 2);
}

/** The savings book's balance path under a shift, restated from the form's definition on the shipped series, to `months` months. */
function componentPath(repoRoot: string, shiftPct: number, months: number): number[] {
  const f = deskComponentDecay(repoRoot);
  const [fy, fm] = f.series.firstMonth.split("-").map(Number) as [number, number];
  const [wy, wm] = f.window.firstMonth.split("-").map(Number) as [number, number];
  const [ly, lm] = f.window.lastMonth.split("-").map(Number) as [number, number];
  const start = (wy - fy) * 12 + (wm - fm);
  const n = (ly - wy) * 12 + (lm - wm) + 1;
  const x: number[] = [];
  for (let j = 0; j < n; j++) {
    let sum = 0;
    for (let k = start + j - f.lookbackMonths; k < start + j; k++) sum += f.series.valuesPct[k]!;
    x.push(Math.max(0, f.series.valuesPct[start + j]! + shiftPct - sum / f.lookbackMonths));
  }
  const b = [400_000_000];
  for (let t = 1; t <= months; t++) {
    const xs = x[Math.min(t, n) - 1]!;
    b.push(b[t - 1]! * f.retention * (1 + f.drift + f.coefficientPerPp * xs));
  }
  return b;
}

/** The full-runoff WAL of a balance path, in years: every month's principal times its month, over the opening balance. */
function fullRunoffWalYears(path: readonly number[]): number {
  let dollarMonths = 0;
  for (let t = 1; t < path.length; t++) dollarMonths += (path[t - 1]! - path[t]!) * t;
  return dollarMonths / path[0]! / 12;
}

/** Months the WAL restatement runs: far past the 360-month grid, where the remaining balance is below a millionth of a dollar. */
const LONG = 4000;

// ---------------------------------------------------------------------------
// nmd-b-full-beta-form: the desk's frozen and shocked-level demos
// ---------------------------------------------------------------------------

/** The setup id of a seeded deposit-form demo. */
const setupIdOf = (repoRoot: string, id: DeskDemoId): string => depositFormDemos(repoRoot).find((d) => d.id === id)!.setup.id;

/** The replica's input file of the deposit-form setups and sets equals the seed, so the replica reads what the launch runs. */
function deskSeedLine(repoRoot: string): CheckLine {
  const file = JSON.parse(readFileSync(join(repoRoot, "replica", "inputs", "deposit-forms-v1.json"), "utf8")) as { sets: unknown; demos: unknown };
  const seed = { sets: depositFormSets(repoRoot), demos: depositFormDemos(repoRoot).map((d) => ({ id: d.id, bookId: d.bookId, setIds: d.setIds, setup: d.setup })) };
  const same = JSON.stringify({ sets: file.sets, demos: file.demos }) === JSON.stringify(seed);
  return line("desk.inputs.seed", same,
    `replica/inputs/deposit-forms-v1.json holds the seven deposit-form setups and the desk's five sets exactly as the seed builds them (${same}) (anchor: apps/server/src/examples/depositForms.ts, the documents the seed stores)`);
}

export const fullBetaFormCheck: CapabilityCheck = {
  capabilityId: "nmd-b-full-beta-form",
  title: "The full beta form and its frozen and shocked-level slotting, on Quillfield's deposit desk (feature demos)",
  run(ctx) {
    const lines: CheckLine[] = [];
    const book = exampleBook(ctx.repoRoot, "quillfield-deposit-desk-v1");
    const frozen = runDepositFormDemo(ctx.repoRoot, ctx.market, "desk-full-beta-frozen").result;
    const shocked = runDepositFormDemo(ctx.repoRoot, ctx.market, "desk-full-beta-shocked").result;
    const mma = 500_000_000;
    // Identity: the paid rate at the base state is the form's own D* there, restated from the form's definition on the desk file's S-curve.
    const d0 = (DESK_FULL_FORM.alphaPct + betaEff(book, 0) * DESK_FULL_FORM.baseShortRatePct) / 100;
    const got0 = (series(frozen, "S0", "dd-mma").series.interest[0]! * 12) / mma;
    lines.push(line("desk.full-beta.base-paid-rate", rel(got0, d0) <= 1e-12,
      `the money market book's month-1 interest is the base paid rate on $500M: ${P(got0)} against alpha + beta_eff x r = ${P(d0)} restated from the S-curve at ${DESK_FULL_FORM.baseShortRatePct}% after a fall (anchor: the desk file)`));
    // Identity: frozen slotting holds the base core, min(1 - min(beta_eff, 0.5), 0.9), so the non-core leaves in month 1 in every scenario.
    const bFrozen = Math.min(betaEff(book, 0), 0.5);
    const coreFrozen = Math.min(1 - bFrozen, 0.9);
    const frozenOk = scenarioIds(frozen).every((s) => rel(series(frozen, s, "dd-mma").series.principal[0]!, mma * (1 - coreFrozen)) <= 1e-12);
    lines.push(line("desk.full-beta.frozen-core", frozenOk,
      `frozen: every scenario's month-1 principal is the non-core ${M(mma * (1 - coreFrozen))} of the core min(1 - min(beta_eff, 0.50), 0.90) = ${coreFrozen.toFixed(6)}`));
    // Identity: shocked-level reads the core 1 - beta_eff at each scenario's own level.
    const worst = Math.max(...scenarioIds(shocked).map((s) => rel(series(shocked, s, "dd-mma").series.principal[0]!, mma * betaEff(book, shiftOf(s)))));
    lines.push(line("desk.full-beta.shocked-core", worst <= 1e-12,
      `shocked-level: each scenario's month-1 principal is beta_eff at its own level times $500M (base ${M(mma * betaEff(book, 0))}, +100 bp ${M(mma * betaEff(book, 1))}); worst relative ${worst.toExponential(2)} (anchor: the shift read at tenor zero)`));
    // Identity: the two conventions split the other deposits alike, so only the money market family differs.
    const others = ["dd-operating", "dd-savings"];
    const sameOthers = scenarioIds(frozen).every((s) => others.every((f) => JSON.stringify(series(frozen, s, f)) === JSON.stringify(series(shocked, s, f)) && famPv(frozen, s, f) === famPv(shocked, s, f)));
    const mmaMoves = famPv(frozen, "S100", "dd-mma") !== famPv(shocked, "S100", "dd-mma");
    lines.push(line("desk.full-beta.slotting-scope", sameOthers && mmaMoves && JSON.stringify(frozen.parentOf) === JSON.stringify(shocked.parentOf),
      `the operating and savings deposits carry the same regulatory split, cash flows and value in every scenario under both conventions (${sameOthers}), and the money market value differs (${mmaMoves}) (anchor: a deposit without the form takes the frozen arm's split)`));
    lines.push(line("desk.full-beta.blocks", frozen.ftp === undefined && shocked.ftp === undefined && frozen.eve.byScenario.length === 5 && shocked.nii.byScenario.length === 5,
      `FTP stands aside on both runs with its note, and NII and EVE carry the five scenarios`));
    const eveOf = (r: RunResult, s: string) => r.eve.byScenario.find((x) => x.scenarioId === s)!.eve;
    // The replica lines, under the pin stems.
    const t = readDeskTargets(ctx.repoRoot);
    const tf = deskDemo(t, "desk-full-beta-frozen");
    const ts = deskDemo(t, "desk-full-beta-shocked");
    lines.push(deskInputsLine(ctx.repoRoot, "desk.full-beta.inputs", t, [
      { demo: "desk-full-beta-frozen", setupId: setupIdOf(ctx.repoRoot, "desk-full-beta-frozen"), result: frozen },
      { demo: "desk-full-beta-shocked", setupId: setupIdOf(ctx.repoRoot, "desk-full-beta-shocked"), result: shocked },
    ]));
    lines.push(deskTie("desk.full-beta.frozen-eve-base", `frozen: the desk's EVE by family and in total, every scenario (base ${M(eveOf(frozen, "S0"))}, money market at +100 bp ${M(famPv(frozen, "S100", "dd-mma"))})`, "eve", frozen.eve, tf?.eve));
    lines.push(deskTie("desk.full-beta.frozen-mma-pv-up100", "frozen: the projection by family, the money market book's slotted EVE book (ten core rungs and the non-core slice at the base-state paid rate) and the other deposits' regulatory children, every scenario", "cashflows", frozen.cashflows, tf?.cashflows));
    lines.push(deskTie("desk.full-beta.frozen-nii", "frozen: run-off NII by month, family and horizon (12, 24 and 60 months), every scenario", "nii", frozen.nii, tf?.nii));
    lines.push(deskTie("desk.full-beta.shocked-eve-base", `shocked-level: the desk's EVE by family and in total, every scenario (base ${M(eveOf(shocked, "S0"))}, money market at +100 bp ${M(famPv(shocked, "S100", "dd-mma"))})`, "eve", shocked.eve, ts?.eve));
    lines.push(deskTie("desk.full-beta.shocked-mma-pv-up100", "shocked-level: the projection by family, the money market core read at each scenario's level, every scenario", "cashflows", shocked.cashflows, ts?.cashflows));
    lines.push(deskTie("desk.full-beta.shocked-nii12-base", `shocked-level: run-off NII by month, family and horizon, every scenario (base 12 months ${M(shocked.nii.byScenario.find((s) => s.scenarioId === "S0")!.totalNet12)})`, "nii", shocked.nii, ts?.nii));
    lines.push(deskTie("desk.full-beta.parent-of", "both conventions: the child-to-parent map of the operating and savings deposits' regulatory split (22 children)", "parentOf", { frozen: frozen.parentOf, shocked: shocked.parentOf }, { frozen: tf?.parentOf, shocked: ts?.parentOf }));
    return { lines, observedNotImplemented: layers(frozen, shocked) };
  },
};

// ---------------------------------------------------------------------------
// nmd-component-decay-dated-path: the desk's component decay demo
// ---------------------------------------------------------------------------

export const componentDecayCheck: CapabilityCheck = {
  capabilityId: "nmd-component-decay-dated-path",
  title: "Component decay on the shipped SOFR path and its full-runoff WAL, on Quillfield's deposit desk (feature demo)",
  run(ctx) {
    const lines: CheckLine[] = [];
    const r = runDepositFormDemo(ctx.repoRoot, ctx.market, "desk-component-decay").result;
    // Identity: the savings balance path is the product restated here on the shipped series, every month of the grid.
    let worst = 0;
    for (const s of scenarioIds(r)) {
      const want = componentPath(ctx.repoRoot, shiftOf(s), 360);
      const got = series(r, s, "dd-savings").series.balance;
      for (let t = 0; t < got.length; t++) worst = Math.max(worst, rel(got[t]!, want[t]!));
    }
    lines.push(line("desk.component.balance-path", worst <= 1e-9,
      `the savings balance at the start of every month of the grid, every scenario, is B0 x prod R (1 + mu0 + phi x_s) on SOFR ${DESK_COMPONENT_WINDOW.firstMonth} to ${DESK_COMPONENT_WINDOW.lastMonth}, the trailing 12-month mean on realized months, the shift on the window only and the driver held after it; worst relative ${worst.toExponential(2)} (anchor: restated on examples/sofr-monthly-v1.json)`));
    // Identity: the family WAL is the full runoff's, restated by summing the path far past the grid.
    let walWorst = 0;
    for (const s of scenarioIds(r)) walWorst = Math.max(walWorst, rel(series(r, s, "dd-savings").walYears!, fullRunoffWalYears(componentPath(ctx.repoRoot, shiftOf(s), LONG))));
    lines.push(line("desk.component.full-runoff-wal", walWorst <= 1e-9,
      `the savings family's WAL is the full runoff's, every principal dollar times its month over the opening balance, summed to month ${LONG}: base ${series(r, "S0", "dd-savings").walYears!.toFixed(9)} years; worst relative ${walWorst.toExponential(2)} (anchor: the tail summed rather than closed)`));
    // Identity: a family without the form keeps its in-horizon WAL, the operating runoff's (48 + 1) / 2 months.
    const op = series(r, "S0", "dd-operating").walYears!;
    lines.push(line("desk.component.others-in-horizon", rel(op, 24.5 / 12) <= 1e-12, `the operating family's WAL stays its straight-line runoff's (48 + 1) / 2 = 24.5 months: ${op * 12} months`));
    lines.push(line("desk.component.blocks", r.nii.byScenario.length === 0 && r.eve.byScenario.length === 0 && r.ftp === undefined,
      `NII and EVE carry no scenario and FTP stands aside, each with its note (${layers(r).join(", ")})`));
    // The replica lines, under the pin stems.
    const t = readDeskTargets(ctx.repoRoot);
    const tc = deskDemo(t, "desk-component-decay");
    lines.push(deskInputsLine(ctx.repoRoot, "desk.component.inputs", t, [{ demo: "desk-component-decay", setupId: setupIdOf(ctx.repoRoot, "desk-component-decay"), result: r }]));
    lines.push(deskTie("desk.component.wal-base", `every family's WAL in every scenario, the savings family's on the full runoff (base ${series(r, "S0", "dd-savings").walYears!.toFixed(9)} years, +100 bp ${series(r, "S100", "dd-savings").walYears!.toFixed(9)})`, "cashflows", r.cashflows, tc?.cashflows, (n) => n.endsWith(".walYears")));
    lines.push(deskTie("desk.component.wal-up100", "the projection by family, balance, principal and interest by month, every scenario: the savings book's dated-path decay under each shift", "cashflows", r.cashflows, tc?.cashflows, (n) => !n.endsWith(".walYears")));
    return { lines, observedNotImplemented: layers(r) };
  },
};

// ---------------------------------------------------------------------------
// ftp-replicating-portfolio-credit: the straight-line runoff, the desk's credit demo and the floater's funding tenor
// ---------------------------------------------------------------------------

/** The market's term liquidity premium quote at a tenor in months, read from the snapshot's own nodes; null when none. */
function tlpQuote(market: MarketSnapshot, months: number): number | null {
  const n = market.tlpNodes.find((x) => Math.abs(x.tYears - months / 12) < 1e-9);
  return n === undefined ? null : n.spread;
}

export const replicatingPortfolioCheck: CapabilityCheck = {
  capabilityId: "ftp-replicating-portfolio-credit",
  title: "The straight-line runoff, the replicating-portfolio credit on each desk deposit, and the floater's funding tenor on Quillfield Bank version 1.2 (feature demos)",
  run(ctx) {
    const lines: CheckLine[] = [];
    const plain = runDepositFormDemo(ctx.repoRoot, ctx.market, "desk-linear-decay").result;
    // Identity: the straight line, from the desk file's terms: $300M over 48 months, $6.25M a month, then nothing.
    const op = series(plain, "S0", "dd-operating").series;
    const lineOk = op.principal.every((x, k) => Math.abs(x - (k < 48 ? 6_250_000 : 0)) <= 1e-6) && op.balance.every((b, k) => Math.abs(b - 300_000_000 * Math.max(0, 1 - k / 48)) <= 1e-6);
    lines.push(line("desk.linear.runoff", lineOk && scenarioIds(plain).every((s) => JSON.stringify(series(plain, s, "dd-operating").series.principal) === JSON.stringify(op.principal)),
      `the operating deposits pay $6.25M of principal in each of months 1 to 48 and nothing after, B(t) = $300M x (1 - t / 48), in every scenario (anchor: the desk file)`));
    const credit = runDepositFormDemo(ctx.repoRoot, ctx.market, "desk-credit").result;
    const fam = (f: string) => credit.ftp!.byFamily.find((x) => x.familyId === f)!;
    const rp = fam("dd-operating").replicatingPortfolio!;
    // Identity: life (n + 1) / 2 and the life-target blend whose life is the deposit's.
    const blendLife = rp.tranches.filter((t) => t.kind === "pillar").reduce((a, t) => a + t.weight * (t.months + 1) / 2, 0) / Math.max(1e-12, rp.tranches.filter((t) => t.kind === "pillar").reduce((a, t) => a + t.weight, 0));
    const weights = rp.tranches.reduce((a, t) => a + t.weight, 0);
    lines.push(line("desk.credit.life-target", rp.lifeMonths === 24.5 && rel(blendLife, 24.5) <= 1e-12 && rel(weights, 1) <= 1e-12 && rp.beta === 0,
      `the operating credit reads life (48 + 1) / 2 = ${rp.lifeMonths} months; its pillars ${rp.tranches.map((t) => `${t.months}M x ${t.weight}`).join(", ")} blend to a life of ${blendLife} months and weigh ${weights} in all; beta ${rp.beta}, the deposit's own`));
    // Identity: each credit's total is its rate and liquidity legs, and the rate leg is its tranches' weighted rate.
    const rows = ["dd-operating", "dd-savings", "dd-mma"].map((f) => {
      const x = fam(f);
      const r = x.replicatingPortfolio ?? x.scenarioCredit!;
      const rate = r.tranches.reduce((a, t) => a + t.weight * t.rate, 0);
      return { f, ok: rel(r.totalCredit, r.rateCredit + r.liquidityCredit) <= 1e-12 && rel(rate, r.rateCredit) <= 1e-12 && x.irFtpRate === r.rateCredit && x.lpFtpRate === r.liquidityCredit && x.allInFtpRate === r.totalCredit, total: r.totalCredit };
    });
    lines.push(line("desk.credit.legs", rows.every((r) => r.ok),
      `on each of the three deposits the total credit is the rate leg plus the liquidity leg, the rate leg is the tranches' weighted rate, and the family's IR, LP and all-in rates are those three (${rows.map((r) => `${r.f} ${P(r.total)}`).join(", ")})`));
    // The replica lines, under the pin stems: each credit family's row, whole.
    const t = readDeskTargets(ctx.repoRoot);
    const tl = deskDemo(t, "desk-linear-decay");
    const tcr = deskDemo(t, "desk-credit");
    const view = creditView(credit);
    const one = (f: string) => ({ byFamily: view.byFamily.filter((x) => x.familyId === f) });
    const tOne = (f: string) => ({ byFamily: ((tcr?.ftp as { byFamily?: Array<{ familyId: string }> } | undefined)?.byFamily ?? []).filter((x) => x.familyId === f) });
    lines.push(deskTie("desk.linear.eve", "the plain desk's EVE by family and in total, every scenario (the operating deposits' straight line, savings and money market on their own terms)", "eve", plain.eve, tl?.eve));
    lines.push(deskTie("desk.linear.nii", "the plain desk's run-off NII by month, family and horizon, every scenario", "nii", plain.nii, tl?.nii));
    lines.push(deskTie("desk.linear.gap", "the plain desk's repricing and liquidity ladders, nine bands and 360 months, every scenario: the liquidity ladder the straight-line card names, $6.25M a month for 48 months", "gap", plain.gap, tl?.gap));
    lines.push(deskTie("desk.linear.ftp", "the plain desk's FTP: every family row with its monthly series, the book and the NIM bridge, on the base scenario", "ftp", plain.ftp, tl?.ftp));
    lines.push(deskTie("desk.linear.cashflows","the plain desk's projection by family and each family's WAL (the operating deposits' 24.5 months), every scenario", "cashflows", plain.cashflows, tl?.cashflows));
    lines.push(deskTie("desk.credit.operating-total", `the operating deposits' credit, whole: the three rates, the life, the tranches, the stock and the readings (total ${P(rows[0]!.total)})`, "ftp", one("dd-operating"), tOne("dd-operating")));
    lines.push(deskTie("desk.credit.savings-total", `the savings book's credit on its balance path, whole: the three rates, the life, the tranches and the liquidity legs (total ${P(rows[1]!.total)})`, "ftp", one("dd-savings"), tOne("dd-savings")));
    lines.push(deskTie("desk.credit.mma-total", `the money market book's credit on its capped life, whole, the paid rate included (total ${P(rows[2]!.total)})`, "ftp", one("dd-mma"), tOne("dd-mma")));
    // Every credit family the engine reports is held: a family the check would otherwise skip fails here.
    lines.push(line("desk.credit.families", view.byFamily.map((x) => x.familyId).join() === "dd-operating,dd-savings,dd-mma",
      `the credit run reports a credit on exactly the desk's three families, ${view.byFamily.map((x) => x.familyId).join(", ")} (anchor: the credit set binds one on each)`));
    // The floater's funding tenor (Quillfield Bank version 1.2): version 1.1 is the same file with the tenors taken out.
    const v12 = exampleBook(ctx.repoRoot, "mid-size-bank-v1");
    const v11: PortfolioSpec = { ...v12, positions: v12.positions.map((p) => {
      if (p.terms.type !== "floating-loan") return p;
      const { fundingTenorMonths: _t, ...terms } = p.terms as typeof p.terms & { fundingTenorMonths?: number };
      return { ...p, terms: terms as typeof p.terms };
    }) };
    const tenored = v12.positions.filter((p) => p.terms.type === "floating-loan" && (p.terms as { fundingTenorMonths?: number }).fundingTenorMonths !== undefined);
    const families = [...new Set(tenored.map((p) => p.familyId))];
    const a = runDepositFormDemo(ctx.repoRoot, ctx.market, "funding-tenor", { book: v11 }).result;
    const b = runDepositFormDemo(ctx.repoRoot, ctx.market, "funding-tenor").result;
    const strip = (r: RunResult) => { const { ftp: _f, provenance: _p, ...rest } = r; return JSON.stringify(rest); };
    const ftpRest = (r: RunResult) => JSON.stringify({ ...r.ftp!, byFamily: r.ftp!.byFamily.filter((f) => !families.includes(f.familyId)), book: null, nimBridge: null });
    const moved = families.filter((f) => JSON.stringify(a.ftp!.byFamily.find((x) => x.familyId === f)) !== JSON.stringify(b.ftp!.byFamily.find((x) => x.familyId === f)));
    lines.push(line("quillfield.funding-tenor.scope", strip(a) === strip(b) && ftpRest(a) === ftpRest(b) && moved.length === families.length,
      `version 1.1 against version 1.2: every block but FTP bit for bit (${strip(a) === strip(b)}), every FTP family row but the ${families.length} floater families bit for bit (${ftpRest(a) === ftpRest(b)}), and each of those moves: ${moved.join(", ")} (anchor: the tenor read by the FTP block only)`));
    // Identity: each tenored family's liquidity leg is the market's own premium at each position's funding tenor, notional-weighted.
    const legRows = families.map((f) => {
      const ps = tenored.filter((p) => p.familyId === f);
      const quotes = ps.map((p) => tlpQuote(ctx.market, (p.terms as { fundingTenorMonths: number }).fundingTenorMonths));
      const want = quotes.every((q) => q !== null) ? ps.reduce((s, p, i) => s + p.terms.notional * quotes[i]!, 0) / ps.reduce((s, p) => s + p.terms.notional, 0) : Number.NaN;
      const got = b.ftp!.byFamily.find((x) => x.familyId === f)!.lpFtpRate!;
      return { f, got, want, ok: rel(got, want) <= 1e-9 };
    });
    lines.push(line("quillfield.funding-tenor.liquidity-leg", legRows.every((r) => r.ok),
      `each tenored family's LP FTP is the market's term liquidity premium quote at its positions' funding tenors, notional-weighted: ${legRows.map((r) => `${r.f} ${P(r.got)} (quotes ${P(r.want)})`).join(", ")} (anchor: the market file's tlp_nodes)`));
    const allIn = (r: RunResult, f: string) => r.ftp!.byFamily.find((x) => x.familyId === f)!.allInFtpRate!;
    const tft = deskDemo(t, "funding-tenor");
    const tftp = (tft?.ftp ?? {}) as Record<string, unknown>;
    lines.push(deskInputsLine(ctx.repoRoot, "desk.credit.inputs", t, [
      { demo: "desk-linear-decay", setupId: setupIdOf(ctx.repoRoot, "desk-linear-decay"), result: plain },
      { demo: "desk-credit", setupId: setupIdOf(ctx.repoRoot, "desk-credit"), result: credit },
      { demo: "funding-tenor", setupId: setupIdOf(ctx.repoRoot, "funding-tenor"), result: b },
    ]));
    lines.push(deskSeedLine(ctx.repoRoot));
    lines.push(deskTie("quillfield.funding-tenor.ci-all-in", `version 1.2: FTP of every family with its monthly series, the four floater families on their funding tenors (C&I floating all-in ${P(allIn(b, "mb-ci-floating"))})`, "ftp", { byFamily: b.ftp!.byFamily }, { byFamily: tftp.byFamily }));
    lines.push(deskTie("quillfield.funding-tenor.heloc-all-in", `version 1.2: the book roll-up, the NIM bridge and the base scenario the FTP block reads (home equity all-in ${P(allIn(b, "mb-heloc"))})`, "ftp", { ...b.ftp!, byFamily: undefined }, { ...tftp, byFamily: undefined }));
    return { lines, observedNotImplemented: layers(plain, credit, a, b) };
  },
};

// ---------------------------------------------------------------------------
// ftp-credit-scenario-reading: the desk's scenario credit demo
// ---------------------------------------------------------------------------

export const creditScenarioCheck: CapabilityCheck = {
  capabilityId: "ftp-credit-scenario-reading",
  title: "The credit on the savings path and on a capped money market life, read at every parallel scenario, on Quillfield's deposit desk (feature demo)",
  run(ctx) {
    const lines: CheckLine[] = [];
    const book = exampleBook(ctx.repoRoot, "quillfield-deposit-desk-v1");
    const r = runDepositFormDemo(ctx.repoRoot, ctx.market, "desk-scenario-credit").result;
    const fam = (f: string) => r.ftp!.byFamily.find((x) => x.familyId === f)!.scenarioCredit!;
    const sav = fam("dd-savings");
    const mma = fam("dd-mma");
    const ids = scenarioIds(r);
    // Identity: the base reading comes first and is the top level.
    const baseOk = [sav, mma].every((c) => c.byScenario.map((x) => x.scenarioId).join() === ids.join() && c.byScenario[0]!.totalCredit === c.totalCredit && c.byScenario[0]!.lifeMonths === c.lifeMonths && c.byScenario[0]!.beta === c.beta);
    lines.push(line("desk.scenario-credit.base-first", baseOk, `both credits read the run's ${ids.length} scenarios in request order, the base first and equal to the top-level reading`));
    // Identity: every reading's legs add up.
    const sums = [sav, mma].every((c) => c.byScenario.every((x) => rel(x.tranches.reduce((a, t) => a + t.weight, 0), 1) <= 1e-12 && rel(x.tranches.reduce((a, t) => a + t.weight * t.rate, 0), x.rateCredit) <= 1e-12 && rel(x.liquidityLegs.reduce((a, l) => a + l.weight * l.premium, 0), x.liquidityCredit) <= 1e-12 && rel(x.totalCredit, x.rateCredit + x.liquidityCredit) <= 1e-12));
    lines.push(line("desk.scenario-credit.legs", sums, "at every scenario the tranche weights sum to 1, the rate leg is their weighted rate, the liquidity leg is its ladder's weighted premium, and the total is the two legs"));
    // Identity: the money market beta is beta_eff at each scenario's own level, restated from the form's definition; its life the 60-month cap.
    const betaWorst = Math.max(...mma.byScenario.map((x) => rel(x.beta, betaEff(book, shiftOf(x.scenarioId)))));
    lines.push(line("desk.scenario-credit.mma-beta", betaWorst <= 1e-12 && mma.byScenario.every((x) => x.lifeMonths === 60),
      `the money market credit reads beta_eff at each scenario's level (base ${betaEff(book, 0).toFixed(9)}, +100 bp ${betaEff(book, 1).toFixed(9)}; worst relative ${betaWorst.toExponential(2)}) and its 60-month cap at every scenario`));
    // Identity: the savings life is its balance path's full-runoff life, restated, at every scenario.
    const lifeWorst = Math.max(...sav.byScenario.map((x) => rel(x.lifeMonths, 12 * fullRunoffWalYears(componentPath(ctx.repoRoot, shiftOf(x.scenarioId), LONG)))));
    lines.push(line("desk.scenario-credit.savings-life", lifeWorst <= 1e-9,
      `the savings credit reads the full-runoff life of the balance path each scenario projects (base ${sav.lifeMonths.toFixed(6)} months, +100 bp ${sav.byScenario[1]!.lifeMonths.toFixed(6)}); worst relative ${lifeWorst.toExponential(2)} against the path restated from the form's definition `));
    // The replica lines, under the pin stems: each credit read at every scenario, whole.
    const t = readDeskTargets(ctx.repoRoot);
    const tsc = deskDemo(t, "desk-scenario-credit");
    const view = creditView(r);
    const one = (f: string) => ({ byFamily: view.byFamily.filter((x) => x.familyId === f) });
    const tOne = (f: string) => ({ byFamily: ((tsc?.ftp as { byFamily?: Array<{ familyId: string }> } | undefined)?.byFamily ?? []).filter((x) => x.familyId === f) });
    lines.push(deskInputsLine(ctx.repoRoot, "desk.scenario-credit.inputs", t, [{ demo: "desk-scenario-credit", setupId: setupIdOf(ctx.repoRoot, "desk-scenario-credit"), result: r }]));
    lines.push(deskTie("desk.scenario-credit.savings-total-up100", `the savings credit at every scenario on its own shifted curve and balance path, whole (+100 bp ${P(sav.byScenario.find((x) => x.scenarioId === "S100")!.totalCredit)})`, "ftp", one("dd-savings"), tOne("dd-savings")));
    lines.push(deskTie("desk.scenario-credit.mma-total-up100", `the money market credit at every scenario on its own shifted curve, capped life and level's beta, whole (+100 bp ${P(mma.byScenario.find((x) => x.scenarioId === "S100")!.totalCredit)})`, "ftp", one("dd-mma"), tOne("dd-mma")));
    lines.push(line("desk.scenario-credit.families", view.byFamily.map((x) => x.familyId).join() === "dd-savings,dd-mma",
      `the scenario credit run reports a credit on exactly the savings and money market families, ${view.byFamily.map((x) => x.familyId).join(", ")} (anchor: the scenario credit set binds those two)`));
    return { lines, observedNotImplemented: layers(r) };
  },
};
