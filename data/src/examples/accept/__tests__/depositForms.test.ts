/**
 * The deposit form checks on Quillfield's deposit desk and the floater's funding tenor.
 *
 *  - Every line passes on this build, no provisional line is left, and each of the fourteen pin stems is a replica
 *    line on replica/targets/deposit-forms-v1.json.
 *  - The replica comparison fails on edited targets: a credit and a life moved by two parts in a billion, a dropped
 *    tranche, an added key, a shortened list, a cent of slotted principal where none is paid, and an input repointed
 *    at another file.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { depositFormDemos } from "../../../../../apps/server/src/examples/depositForms";
import { componentDecayCheck, creditScenarioCheck, fullBetaFormCheck, replicatingPortfolioCheck } from "../depositForms";
import { runDepositFormDemo } from "../depositFormRuns";
import { creditView, deskDemo, deskInputsLine, deskTie, readDeskTargets } from "../replicaDeskTieOut";
import type { CheckLine } from "../types";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarketSnapshot(resolve(REPO_ROOT, "packages/kernel/public/market_public.json"));
});

const STEMS = [
  "desk.full-beta.frozen-eve-base", "desk.full-beta.frozen-mma-pv-up100", "desk.full-beta.shocked-eve-base", "desk.full-beta.shocked-mma-pv-up100",
  "desk.full-beta.shocked-nii12-base", "desk.component.wal-base", "desk.component.wal-up100", "desk.credit.operating-total", "desk.credit.savings-total",
  "desk.credit.mma-total", "quillfield.funding-tenor.ci-all-in", "quillfield.funding-tenor.heloc-all-in", "desk.scenario-credit.savings-total-up100",
  "desk.scenario-credit.mma-total-up100",
];

const pass = (l: CheckLine) => l.status === "pass";

describe("the deposit form checks", () => {
  it("pass on this build, every line, each of the fourteen former pin stems a replica line and no provisional line left", async () => {
    const all: CheckLine[] = [];
    for (const c of [fullBetaFormCheck, componentDecayCheck, replicatingPortfolioCheck, creditScenarioCheck]) all.push(...(await c.run({ repoRoot: REPO_ROOT, market })).lines);
    expect(all.filter((l) => l.status !== "pass").map((l) => `${l.id}: ${l.detail}`)).toEqual([]);
    expect(all.filter((l) => l.id.endsWith(".provisional"))).toEqual([]);
    for (const s of STEMS) expect(all.find((l) => l.id === s)?.detail, s).toContain("Python replica's targets");
  }, 300_000);

  describe("the replica comparison refuses edited targets", () => {
    const t = () => structuredClone(readDeskTargets(REPO_ROOT));
    const ftpOf = (x: ReturnType<typeof t>, id: "desk-credit" | "desk-scenario-credit") => deskDemo(x, id)!.ftp as { byFamily: Array<Record<string, any>> };

    it("passes on the committed targets and fails on a credit moved by two parts in a billion, a dropped tranche or an added key", () => {
      const r = runDepositFormDemo(REPO_ROOT, market, "desk-credit").result;
      const e = creditView(r);
      expect(pass(deskTie("x", "x", "ftp", e, ftpOf(t(), "desk-credit")))).toBe(true);
      const a = t();
      const op = ftpOf(a, "desk-credit").byFamily.find((f) => f.familyId === "dd-operating")!;
      op.replicatingPortfolio.totalCredit *= 1 + 2e-9;
      expect(pass(deskTie("x", "x", "ftp", e, ftpOf(a, "desk-credit")))).toBe(false);
      const b = t();
      ftpOf(b, "desk-credit").byFamily.find((f) => f.familyId === "dd-mma")!.scenarioCredit.tranches.pop();
      expect(pass(deskTie("x", "x", "ftp", e, ftpOf(b, "desk-credit")))).toBe(false);
      const c = t();
      ftpOf(c, "desk-credit").byFamily.find((f) => f.familyId === "dd-savings")!.scenarioCredit.excluded = true;
      expect(pass(deskTie("x", "x", "ftp", e, ftpOf(c, "desk-credit")))).toBe(false);
    });

    it("fails on a shortened stock list and on a scenario's life moved by two parts in a billion", () => {
      const r = runDepositFormDemo(REPO_ROOT, market, "desk-credit").result;
      const a = t();
      ftpOf(a, "desk-credit").byFamily.find((f) => f.familyId === "dd-operating")!.replicatingPortfolio.stock.portfolio.pop();
      expect(pass(deskTie("x", "x", "ftp", creditView(r), ftpOf(a, "desk-credit")))).toBe(false);
      const s = runDepositFormDemo(REPO_ROOT, market, "desk-scenario-credit").result;
      const b = t();
      ftpOf(b, "desk-scenario-credit").byFamily.find((f) => f.familyId === "dd-mma")!.scenarioCredit.byScenario[1].lifeMonths *= 1 + 2e-9;
      expect(pass(deskTie("x", "x", "ftp", creditView(s), ftpOf(b, "desk-scenario-credit")))).toBe(false);
    });

    it("fails on a cent of slotted principal in a month that pays none", () => {
      const r = runDepositFormDemo(REPO_ROOT, market, "desk-full-beta-shocked").result;
      const a = t();
      const cf = deskDemo(a, "desk-full-beta-shocked")!.cashflows as { byScenario: Array<{ byFamily: Array<{ familyId: string; series: { principal: number[] } }> }> };
      cf.byScenario[1]!.byFamily.find((f) => f.familyId === "dd-mma")!.series.principal[4]! += 0.01;
      expect(pass(deskTie("x", "x", "cashflows", r.cashflows, cf))).toBe(false);
    });

    it("fails on a cent added to an empty liquidity ladder cell (the desk holds no assets), and on a shortened monthly ladder (review M1)", () => {
      const r = runDepositFormDemo(REPO_ROOT, market, "desk-linear-decay").result;
      expect(pass(deskTie("x", "x", "gap", r.gap, deskDemo(t(), "desk-linear-decay")!.gap))).toBe(true);
      type Gap = { liquidity: Array<{ rows: Array<{ assets: number }>; userBuckets: { rows: unknown[] } }> };
      const a = t();
      (deskDemo(a, "desk-linear-decay")!.gap as Gap).liquidity[0]!.rows[0]!.assets += 0.01;
      expect(pass(deskTie("x", "x", "gap", r.gap, deskDemo(a, "desk-linear-decay")!.gap))).toBe(false);
      const b = t();
      (deskDemo(b, "desk-linear-decay")!.gap as Gap).liquidity[2]!.userBuckets.rows.pop();
      expect(pass(deskTie("x", "x", "gap", r.gap, deskDemo(b, "desk-linear-decay")!.gap))).toBe(false);
    });

    it("fails the inputs line when the targets point an input at another file, even with that file's hash", () => {
      const r = runDepositFormDemo(REPO_ROOT, market, "desk-credit").result;
      const setupId = depositFormDemos(REPO_ROOT).find((d) => d.id === "desk-credit")!.setup.id;
      const runs = [{ demo: "desk-credit" as const, setupId, result: r }];
      expect(pass(deskInputsLine(REPO_ROOT, "x", readDeskTargets(REPO_ROOT), runs))).toBe(true);
      const a = t();
      const path = "examples/example-book-v1.json";
      a.inputs.desk = { path, sha256: createHash("sha256").update(readFileSync(resolve(REPO_ROOT, path))).digest("hex") };
      expect(pass(deskInputsLine(REPO_ROOT, "x", a, runs))).toBe(false);
    });
  });
});
