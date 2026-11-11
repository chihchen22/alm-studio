// packages/reader/src/niiRows.ts
/**
 * NII rows for Studio's NII tab. The horizon block reads the pinned
 * fields for 12 and 24 months and totalNetByHorizon for any other horizon,
 * the same lookup the viewer's scenarioNetAtHorizon makes; the monthly vector
 * is the stored array. Nothing is summed: the horizon nets are the engine's
 * own partial sums of that vector. The viewer's NiiTable stays inline.
 */
import type { RunResult } from "@alm/engine";
import { readPath, readSeries, scenarioSelector, type PathRead, type SeriesRead } from "./headlines";

export interface NiiCell {
  horizonMonths: number;
  envelopePath: string;
  read: PathRead;
}

export interface NiiHorizonRow {
  scenarioId: string;
  cells: NiiCell[];
}

export interface NiiHorizonTable {
  horizons: number[];
  rows: NiiHorizonRow[];
}

export function niiHorizonPath(scenarioId: string, horizonMonths: number): string {
  const at = `nii.byScenario${scenarioSelector(scenarioId)}`;
  if (horizonMonths === 12) return `${at}.totalNet12`;
  if (horizonMonths === 24) return `${at}.totalNet24`;
  return `${at}.totalNetByHorizon.${horizonMonths}`;
}

export function niiHorizonRows(result: RunResult): NiiHorizonTable {
  const nii = (result as Partial<RunResult>).nii;
  const horizons = nii?.horizonsMonths ?? [];
  return {
    horizons,
    rows: (nii?.byScenario ?? []).map((s) => ({
      scenarioId: s.scenarioId,
      cells: horizons.map((h) => {
        const envelopePath = niiHorizonPath(s.scenarioId, h);
        return { horizonMonths: h, envelopePath, read: readPath(result, envelopePath) };
      }),
    })),
  };
}

/** The scenario-total side-signed net interest per monthly bucket, as stored. */
export function niiMonthlyNet(result: RunResult, scenarioId: string): SeriesRead {
  return readSeries(result, `nii.byScenario${scenarioSelector(scenarioId)}.netMonthly`);
}
