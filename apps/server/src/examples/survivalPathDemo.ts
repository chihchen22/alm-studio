/**
 * The survival path on Quillfield Bank: one seeded run setup, a Home card beside the
 * feature demos (./featureDemos.ts) and the deposit forms (./depositForms.ts), whose lists and documents this module
 * never touches.
 *
 * The setup is the bank's common demo base (version 1.3) with the liquidity stress ladder on:
 *
 *   - the buffer left unstated, so the run reads it from the cash and securities tagged hqla-stock, each at its face
 *     less its hqla-level haircut;
 *   - the certificates of deposit (tagged term-deposit) leaving as they pay out, less the bank's renewal share per row;
 *   - the commitment dials read off the undrawn lines (Ubar and U99 on the line): the lines' $1,000M is the amount
 *     undrawn now, the dials' face is it over (1 - Ubar), and the severe row draws their requirement (ruling
 *     2026-11-05);
 *   - the survival path on the severe row for 24 months, with the bank's FHLB borrowing capacity, after its haircut,
 *     counted in the path only.
 *
 * The stress table is round illustrative rates, the severe row set so the path pierces the buffer inside the year.
 * Every bank value is read from the bank file (examples/mid-size-bank-v1.json, its `liquidity` block and the line's
 * `commitmentDials`), the one source of the bank; docs/oss/mid-size-bank.md states each. None is
 * fitted to data. The setup carries the corrected model convention and goes through the
 * run-setups route's own parse gate and id rule (./featureDemos.ts canonical).
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { LiquidityStressOptions, LiquidityStressTable } from "@alm/engine";
import { US_LCR_COMMITMENT_DEMO } from "@alm/engine/src/report/lcr";
import { depositHistoryOf, DEPOSIT_HISTORY_FILE } from "../http/routes/guided";
import type { RunSetup } from "../workspaces/types";
import { baseBody, canonical, DEMO_BOOK_ID, DEMO_SET_IDS } from "./featureDemos";

export type SurvivalPathDemoId = "survival-path";

/** The demo: the shape of a deposit-form demo (./depositForms.ts), on Quillfield Bank. */
export interface SurvivalPathDemo {
  id: SurvivalPathDemoId;
  title: string;
  bookId: string;
  lineageId: string;
  setIds: string[];
  setup: RunSetup;
}

/** What the bank file holds for the liquidity stress (version 1.3). */
export interface BankLiquidity {
  facility: { label: string; capacity: number; haircut: number };
  cdRenewal: Record<"bau" | "moderate" | "severe", number>;
  /** The lines' amount undrawn now and their Ubar and U99 (shares of the commitment face). */
  line: { undrawn: number; expectedUtilization: number; tailUtilization: number };
}

interface BankFile {
  liquidity?: { receivedFacilities?: Array<{ label: string; capacity: number; haircut: number }>; cdRenewal?: BankLiquidity["cdRenewal"] };
  positions: Array<{ id: string; terms: { type: string; notional: number }; commitmentDials?: { expectedUtilization: number; tailUtilization: number } }>;
}

/** The bank file's liquidity values, read as stored. Throws, naming what is missing, on a file without them. */
export function bankLiquidity(repoRoot: string): BankLiquidity {
  const file = JSON.parse(readFileSync(join(repoRoot, "examples", `${DEMO_BOOK_ID}.json`), "utf8")) as BankFile;
  const f = file.liquidity?.receivedFacilities?.[0];
  const cd = file.liquidity?.cdRenewal;
  const line = file.positions.find((p) => p.terms.type === "commitment" && p.commitmentDials !== undefined);
  if (f === undefined || cd === undefined || line === undefined) {
    throw new Error(`survival-path demo: examples/${DEMO_BOOK_ID}.json holds no liquidity block or no line with commitment dials (version 1.3 adds them)`);
  }
  return {
    facility: { label: f.label, capacity: f.capacity, haircut: f.haircut },
    cdRenewal: { bau: cd.bau, moderate: cd.moderate, severe: cd.severe },
    line: { undrawn: line.terms.notional, expectedUtilization: line.commitmentDials!.expectedUtilization, tailUtilization: line.commitmentDials!.tailUtilization },
  };
}

/**
 * The stress table of the demo, round illustrative rates. The bau and moderate rows are the Studio's starting table;
 * the severe row runs the savings and money market pool off at 8 percent a month and the checking pool at 1.5 percent,
 * with a fifth of maturing wholesale funding renewing. Its draw is replaced by the dials' requirement. With the
 * certificates of deposit in the ladder and the buffer read from the tags, the severe row pierces the buffer inside the
 * year (apps/studio/src/rows/setupRows.ts DEFAULT_LIQUIDITY_STRESS holds the same rates).
 */
export const SURVIVAL_DEMO_RATES: Readonly<Record<"bau" | "moderate" | "severe", { hysOutflowMonthly: number; wholesaleRenewal: number; nibOutflowMonthly: number; drawRate: number }>> = {
  bau: { hysOutflowMonthly: 0.004, wholesaleRenewal: 1, nibOutflowMonthly: 0.001, drawRate: 0 },
  moderate: { hysOutflowMonthly: 0.04, wholesaleRenewal: 0.6, nibOutflowMonthly: 0.008, drawRate: 0.12 },
  severe: { hysOutflowMonthly: 0.08, wholesaleRenewal: 0.2, nibOutflowMonthly: 0.015, drawRate: 0.25 },
};

/** The survival path's length on the demo, months. */
export const SURVIVAL_DEMO_MONTHS = 24;

/** The demo's liquidity stress opt-in, every bank value read from the bank file. */
export function survivalDemoStress(repoRoot: string): LiquidityStressOptions {
  const b = bankLiquidity(repoRoot);
  const row = (id: "bau" | "moderate" | "severe") => ({ ...SURVIVAL_DEMO_RATES[id], cdRenewal: b.cdRenewal[id] });
  const table: LiquidityStressTable = { bau: row("bau"), moderate: row("moderate"), severe: row("severe") };
  return {
    table,
    undrawnFace: b.line.undrawn,
    dials: {
      expectedUtilization: b.line.expectedUtilization,
      tailUtilization: b.line.tailUtilization,
      // Round illustrative: a 50 bp funding spread; the LCR factor of a credit line to a non-financial company, 12 CFR
      // 249.32(e)(1)(iii), as the engine's demonstration table states it; one twelfth of the tail draw in 30 days, the
      // even spread's first month.
      fundingSpreadBp: 50,
      lcrFactor: US_LCR_COMMITMENT_DEMO["credit-nonfinancial"]!,
      thirtyDayShare: 1 / 12,
    },
    survivalPath: { horizonMonths: SURVIVAL_DEMO_MONTHS, facility: { ...b.facility } },
  };
}

/** The one demo. Pure over the repository. */
export function survivalPathDemos(repoRoot: string): SurvivalPathDemo[] {
  const h = depositHistoryOf(join(repoRoot, "examples"), DEPOSIT_HISTORY_FILE).nmdWarmup.series;
  const warmup = { kind: "history" as const, series: { ...h, valuesPct: [...h.valuesPct] } };
  const title = "The survival path and the commitment dials";
  const note =
    "Feature demo: the liquidity stress ladder on Quillfield Bank version 1.3, the buffer read from the HQLA tags, the certificates of deposit in the ladder, the severe draw set by the commitment dials on the $1,000 million undrawn now, and the survival path for 24 months with the FHLB borrowing line. The stress rates are round illustrative values.";
  const setup = canonical({ ...baseBody(`Demo: ${title}`, DEMO_SET_IDS.illustrative, note, warmup), liquidityStress: survivalDemoStress(repoRoot) });
  return [{ id: "survival-path", title, bookId: DEMO_BOOK_ID, lineageId: "demo-survival-path", setIds: [DEMO_SET_IDS.illustrative], setup }];
}
