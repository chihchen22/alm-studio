/**
 * The seven deposit-form demos tied out against the independent Python replica (the rule
 * extended). The targets file `replica/targets/deposit-forms-v1.json` holds each demo's measures in the engine's own
 * result shapes; a line walks the ENGINE value and requires the matching target cell, at 1e-9 relative with the floors
 * of ./replicaDemoTieOut.ts (1e-6 dollars; 1e-12 on rates, credits, weights, betas, lives and fractional months; whole
 * months, counts and bp exact). A missing or non-finite target cell fails, a list of another length fails, and so does
 * a target row or key the engine does not report.
 *
 * What is read and not compared is written here, with the reason, never read from the targets:
 *  - on the two credit demos, the FTP rows of the families that carry no credit, and the dollar series and margins of
 *    every FTP row (the coupon interest, the accrual and their monthly series): the credit demos tie out the credit
 *    itself, its rates, tranches, legs, stock and readings, and the three rates the family row takes from it;
 *  - what ./replicaDemoTieOut.ts already leaves out (labels of the run, durations, chart roll-up rows).
 * The demo ids, the input paths and the scenario ids each demo runs are written here too.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "@alm/engine";
import { DemoTally } from "./replicaDemoTieOut";
import type { CheckLine } from "./types";

export const DESK_TARGETS_PATH = "replica/targets/deposit-forms-v1.json";

export const DESK_DEMO_IDS = ["desk-linear-decay", "desk-component-decay", "desk-full-beta-frozen", "desk-full-beta-shocked", "desk-credit", "desk-scenario-credit", "funding-tenor"] as const;
export type DeskDemoId = (typeof DESK_DEMO_IDS)[number];

const PARALLEL = ["S0", "S100", "S-100", "S200", "S-200"];
/** Each demo's scenarios, as its seeded setup composes them. */
export const DESK_SCENARIOS: Readonly<Record<DeskDemoId, readonly string[]>> = {
  "desk-linear-decay": PARALLEL,
  "desk-component-decay": PARALLEL,
  "desk-full-beta-frozen": PARALLEL,
  "desk-full-beta-shocked": PARALLEL,
  "desk-credit": ["S0"],
  "desk-scenario-credit": PARALLEL,
  "funding-tenor": PARALLEL,
};

/** The input files the targets must name, at these paths (the hashes are checked against the files). */
export const DESK_INPUT_PATHS: Readonly<Record<string, string>> = {
  desk: "examples/quillfield-deposit-desk-v1.json",
  bank: "examples/mid-size-bank-v1.json",
  forms: "replica/inputs/deposit-forms-v1.json",
  demos: "replica/inputs/feature-demos-v1.json",
  regulatory: "replica/inputs/regulatory-convention-v1.json",
  market: "packages/kernel/public/market_public.json",
  sofr: "examples/sofr-monthly-v1.json",
  cdParams: "replica/inputs/cd-illustrative-v3.json",
};

export interface DeskDemoTargets {
  id: DeskDemoId;
  setupId: string;
  bookId: string;
  scenarios: Array<{ id: string; rateSpec: unknown }>;
  [measure: string]: unknown;
}

export interface DeskTargets {
  schemaVersion: string;
  inputs: Record<string, { path: string; sha256: string }>;
  demos: DeskDemoTargets[];
}

export function readDeskTargets(repoRoot: string): DeskTargets {
  return JSON.parse(readFileSync(join(repoRoot, DESK_TARGETS_PATH), "utf8")) as DeskTargets;
}

export const deskDemo = (t: DeskTargets, id: DeskDemoId): DeskDemoTargets | undefined => t.demos.find((d) => d.id === id);

/** The targets' own checks for the demos a line reads: ids in order, setup ids, scenario ids, the input hashes. */
export function deskInputsLine(repoRoot: string, id: string, t: DeskTargets, runs: ReadonlyArray<{ demo: DeskDemoId; setupId: string; result: RunResult }>): CheckLine {
  const inputs = t.inputs ?? {};
  const misplaced = Object.entries(DESK_INPUT_PATHS).filter(([k, path]) => inputs[k]?.path !== path).map(([k]) => k);
  const extra = Object.keys(inputs).filter((k) => !(k in DESK_INPUT_PATHS));
  const stale = Object.entries(DESK_INPUT_PATHS).filter(([k, path]) => createHash("sha256").update(readFileSync(join(repoRoot, path))).digest("hex") !== inputs[k]?.sha256).map(([k]) => k);
  const order = JSON.stringify((t.demos ?? []).map((d) => d.id)) === JSON.stringify(DESK_DEMO_IDS);
  const bad: string[] = [];
  for (const r of runs) {
    const d = deskDemo(t, r.demo);
    const want = DESK_SCENARIOS[r.demo];
    const ran = r.result.cashflows.byScenario.map((s) => s.scenarioId);
    if (d === undefined) { bad.push(`${r.demo}: no targets`); continue; }
    if (d.setupId !== r.setupId) bad.push(`${r.demo}: setup ${d.setupId}, want ${r.setupId}`);
    if (JSON.stringify(d.scenarios.map((s) => s.id)) !== JSON.stringify(want) || JSON.stringify(ran) !== JSON.stringify(want)) bad.push(`${r.demo}: scenarios ${d.scenarios.map((s) => s.id).join(",")}, the engine ran ${ran.join(",")}, want ${want.join(",")}`);
  }
  const ok = order && misplaced.length === 0 && extra.length === 0 && stale.length === 0 && bad.length === 0;
  return {
    id,
    status: ok ? "pass" : "fail",
    detail: ok
      ? `${DESK_TARGETS_PATH} holds the seven deposit-form demos in order; ${runs.map((r) => r.demo).join(", ")} name their seeded setups and the scenarios this check expects (the engine ran the same), and its ${Object.keys(DESK_INPUT_PATHS).length} input files sit at the check's own paths and hash as recorded (anchor: the check's own lists and the files on disk)`
      : `demo order ${order}; inputs not at the check's paths ${misplaced.join(", ") || "none"}, unexpected ${extra.join(", ") || "none"}, stale ${stale.join(", ") || "none"}; ${bad.join(" | ") || "every demo as expected"}`,
  };
}

/** One replica line: walk the engine value under `root` against the target, the paths `pick` holds. */
export function deskTie(id: string, what: string, root: string, engine: unknown, target: unknown, pick: (norm: string) => boolean = () => true): CheckLine {
  const tally = new DemoTally(0);
  tally.walk(root, root, engine, target, pick);
  return tally.line(id, what, DESK_TARGETS_PATH);
}

/** The FTP rows of the families that carry a credit, reduced to what the credit demos tie out (see the header). */
export function creditView(r: RunResult): { byFamily: Array<Record<string, unknown>> } {
  const rows = (r.ftp?.byFamily ?? []).filter((f) => f.replicatingPortfolio !== undefined || f.scenarioCredit !== undefined);
  return {
    byFamily: rows.map((f) => {
      const o: Record<string, unknown> = { familyId: f.familyId, irFtpRate: f.irFtpRate, lpFtpRate: f.lpFtpRate, allInFtpRate: f.allInFtpRate };
      if (f.replicatingPortfolio !== undefined) o.replicatingPortfolio = f.replicatingPortfolio;
      if (f.scenarioCredit !== undefined) o.scenarioCredit = f.scenarioCredit;
      return o;
    }),
  };
}
