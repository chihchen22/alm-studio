// apps/studio/src/results/depositReadouts.ts
/**
 * The deposit readouts core Results shows: each family's weighted average life by
 * scenario (`cashflows.byScenario[].byFamily[].walYears`, which a component decay run restamps on the full runoff),
 * and each deposit family's replicating-portfolio credit (`ftp.byFamily[].replicatingPortfolio`) and scenario credit
 * (`ftp.byFamily[].scenarioCredit`). Every figure is a stored engine value; nothing here derives a number. Pure.
 */
import type { FtpFamilyRow, ReplicatingPortfolioScenarioReading, ReplicatingPortfolioTranche, RunResult } from "@alm/engine";

/** One family's life on one scenario, as stored. */
export interface WalRow {
  familyId: string;
  walYears: number;
}

/** The note layer a component decay run writes when it restamps a family's WAL on the full runoff. */
export const FULL_RUNOFF_LAYER = "cashflows.wal.full-runoff";

/** The engine's own note on a full-runoff WAL, verbatim; null when the run restamps none. */
export function fullRunoffNote(result: RunResult): string | null {
  return result.notImplemented.find((n) => n.layer === FULL_RUNOFF_LAYER)?.reason ?? null;
}

/** The families with a stored WAL on `scenarioId`, in the run's family order; [] when the scenario is not in the run. */
export function walRows(result: RunResult, scenarioId: string): WalRow[] {
  const s = result.cashflows?.byScenario.find((x) => x.scenarioId === scenarioId);
  if (s === undefined) return [];
  return s.byFamily.filter((f) => f.walYears !== undefined).map((f) => ({ familyId: f.familyId, walYears: f.walYears! }));
}

/** One deposit credit as the FTP tab prints it: the base reading of either readout, in one shape. */
export interface CreditRow {
  familyId: string;
  positionId: string;
  construction: string;
  /** Where the life comes from: the straight-line runoff, the balance path, or a cap. */
  lifeSource: "straight-line runoff" | "balance path" | "capped";
  lifeMonths: number;
  beta: number;
  tranches: ReplicatingPortfolioTranche[];
  rateCredit: number;
  liquidityCredit: number;
  totalCredit: number;
  /** The shocked-scenario reading the credit names; null when it runs on the base scenario only. */
  scenarioCurve: "hold-base" | "shift" | null;
}

/** The credit rows of an FTP block, in family order: one per family that carries a readout. */
export function creditRows(byFamily: readonly FtpFamilyRow[]): CreditRow[] {
  const out: CreditRow[] = [];
  for (const f of byFamily) {
    const rp = f.replicatingPortfolio;
    if (rp !== undefined) {
      out.push({
        familyId: f.familyId, positionId: rp.positionId, construction: rp.construction, lifeSource: "straight-line runoff",
        lifeMonths: rp.lifeMonths, beta: rp.beta, tranches: rp.tranches, rateCredit: rp.rateCredit, liquidityCredit: rp.liquidityCredit, totalCredit: rp.totalCredit, scenarioCurve: null,
      });
    }
    const sc = f.scenarioCredit;
    if (sc !== undefined) {
      out.push({
        familyId: f.familyId, positionId: sc.positionId, construction: sc.construction, lifeSource: sc.lifeSource === "capped" ? "capped" : "balance path",
        lifeMonths: sc.lifeMonths, beta: sc.beta, tranches: sc.tranches, rateCredit: sc.rateCredit, liquidityCredit: sc.liquidityCredit, totalCredit: sc.totalCredit, scenarioCurve: sc.scenarioCurve ?? null,
      });
    }
  }
  return out;
}

/** A tranche in words: "overnight 50.9%", "60-month pillar 48.3%", "48-month strip 100.0%". */
export function trancheText(t: ReplicatingPortfolioTranche): string {
  const share = `${(t.weight * 100).toFixed(1)}%`;
  if (t.kind === "overnight") return `overnight ${share}`;
  return t.kind === "pillar" ? `${t.months}-month pillar ${share}` : `${t.months}-month strip ${share}`;
}

/** One family whose credit reads every scenario, with its readings in request order. */
export interface ScenarioCreditTable {
  familyId: string;
  scenarioCurve: "hold-base" | "shift";
  rows: ReplicatingPortfolioScenarioReading[];
}

/** The families whose credit reads every scenario, in family order: [] when none does. */
export function scenarioCreditTables(byFamily: readonly FtpFamilyRow[]): ScenarioCreditTable[] {
  const out: ScenarioCreditTable[] = [];
  for (const f of byFamily) {
    const sc = f.scenarioCredit;
    if (sc === undefined || sc.scenarioCurve === undefined) continue;
    out.push({ familyId: f.familyId, scenarioCurve: sc.scenarioCurve, rows: sc.byScenario });
  }
  return out;
}
