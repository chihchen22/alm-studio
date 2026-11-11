// apps/studio/src/dashboard/dashboardModel.ts
/**
 * The Analyze Dashboard's view model (ALM Studio P1). Every figure is a stored
 * envelope field: eve.byScenario[].eve, .deltaEveVsBase, .deltaEvePct and
 * nii.byScenario[].totalNet12, .totalNet24. "Worst", "lowest" and "first"
 * select among stored values; nothing is added or subtracted here.
 */
import type { RunResult } from "@alm/engine";
import { NOT_IN_RUN, type RunDetail } from "@alm/reader";
import { money, signedMoney, signedRatio } from "../format/figures";
import { scenarioLabeller } from "../format/scenarios";
import { newBusinessNote, newBusinessRead } from "../results/newBusiness";

export interface DashCard {
  key: "eve-base" | "eve-worst" | "nii12" | "stress";
  label: string;
  value: string;
  sub: string;
  field: string | null;
  tone: "neg" | "pos" | null;
  /**
   * The card has no stored figure: `value` is the Not in this run word, or Unobservable when the page could not
   * read what the card needs, printed as a status chip, not a figure; `sub` says why.
   */
  absent: boolean;
}

export interface DashRow {
  scenarioId: string;
  label: string;
  eve: string;
  deltaEve: string;
  deltaTone: "neg" | "pos" | null;
  nii12: string;
  nii24: string;
  /** provenance.scenarioBalancePlanHashes names this scenario: it runs new business under its own balance plan. */
  newBusiness: boolean;
}

export interface DashboardModel {
  cards: DashCard[];
  rows: DashRow[];
  /** One note when provenance names a balance plan (results/newBusiness); null otherwise. */
  newBusinessNote: string | null;
}

interface EveRow { scenarioId: string; eve: number; deltaEveVsBase: number; deltaEvePct: number }
interface NiiRow { scenarioId: string; totalNet12: number; totalNet24: number }

/** Tone of a printed signed figure: it follows the printed sign, so a zero-rounded figure carries no tone. */
const tone = (printed: string): "neg" | "pos" | null => (printed.startsWith("−") ? "neg" : printed.startsWith("+") ? "pos" : null);

function lowest<T>(rows: T[], key: (r: T) => number): T | undefined {
  let best: T | undefined;
  for (const r of rows) if (best === undefined || key(r) < key(best)) best = r;
  return best;
}

/** The plan library whose scenario ids are the regulatory grid; the stress card is the first EVE scenario off it. */
export const GRID_LIBRARY = "regulatory-grid-v1";

/**
 * `gridIds` are the scenario ids of the GRID_LIBRARY entry in /api/plans/library, or null when the library does not
 * hold that entry; the stress card is then Unobservable, since no scenario can be placed off the grid.
 */
export function dashboardModel(result: RunResult, detail: RunDetail, gridIds: readonly string[] | null): DashboardModel {
  const r = result as Partial<RunResult>;
  const eve = ((r.eve?.byScenario ?? []) as unknown as EveRow[]);
  const nii = ((r.nii?.byScenario ?? []) as unknown as NiiRow[]);
  // The label the EVE layer prints for the same scenario (formatted from the stored rateSpec); the id is the fallback.
  const labelOf = scenarioLabeller(detail);
  // The base scenario is the detail's base-rate scenario, whichever blocks the run carries. With several, the
  // one the EVE block holds wins, then the one the NII block holds, then the first.
  const bases = detail.scenarios.filter((s) => s.rateSpec.kind === "base").map((s) => s.id);
  const baseId = bases.find((id) => eve.some((e) => e.scenarioId === id)) ?? bases.find((id) => nii.some((n) => n.scenarioId === id)) ?? bases[0];
  const base = eve.find((e) => e.scenarioId === baseId);
  const worst = lowest(eve.filter((e) => e.scenarioId !== baseId), (e) => e.deltaEveVsBase);
  const niiBase = nii.find((n) => n.scenarioId === baseId);
  const niiLow = lowest(nii, (n) => n.totalNet12);
  const stress = gridIds === null ? undefined : eve.find((e) => e.scenarioId !== baseId && !gridIds.includes(e.scenarioId));

  const cards: DashCard[] = [
    base === undefined
      ? { key: "eve-base", label: "EVE, base", value: NOT_IN_RUN, sub: eve.length === 0 ? "The run carries no EVE block." : "No base-rate scenario in this run.", field: null, tone: null, absent: true }
      : { key: "eve-base", label: "EVE, base", value: money(base.eve), sub: labelOf(base.scenarioId), field: `eve.byScenario[scenarioId=${base.scenarioId}].eve`, tone: null, absent: false },
    worst === undefined
      ? { key: "eve-worst", label: "Worst EVE shock", value: NOT_IN_RUN, sub: eve.length === 0 ? "The run carries no EVE block." : "No shocked scenario in this run.", field: null, tone: null, absent: true }
      : { key: "eve-worst", label: "Worst EVE shock", value: signedMoney(worst.deltaEveVsBase), sub: `${signedRatio(worst.deltaEvePct)} · ${labelOf(worst.scenarioId)}`, field: `eve.byScenario[scenarioId=${worst.scenarioId}].deltaEveVsBase`, tone: tone(signedMoney(worst.deltaEveVsBase)), absent: false },
    niiBase === undefined
      ? { key: "nii12", label: "NII, 12 months", value: NOT_IN_RUN, sub: nii.length === 0 ? "The run carries no NII block." : "No base-rate scenario in this run.", field: null, tone: null, absent: true }
      : { key: "nii12", label: "NII, 12 months", value: money(niiBase.totalNet12), sub: niiLow === undefined ? "" : `Lowest ${money(niiLow.totalNet12)} · ${labelOf(niiLow.scenarioId)}`, field: `nii.byScenario[scenarioId=${niiBase.scenarioId}].totalNet12`, tone: null, absent: false },
    eve.length === 0
      ? { key: "stress", label: "Stress scenario", value: NOT_IN_RUN, sub: "The run carries no EVE block.", field: null, tone: null, absent: true }
      : gridIds === null
      ? { key: "stress", label: "Stress scenario", value: "Unobservable", sub: `${GRID_LIBRARY} is not in /api/plans/library`, field: null, tone: null, absent: true }
      : stress === undefined
      ? { key: "stress", label: "Stress scenario", value: NOT_IN_RUN, sub: "Every scenario besides base is on the regulatory grid.", field: null, tone: null, absent: true }
      : { key: "stress", label: "Stress scenario", value: money(stress.eve), sub: `${labelOf(stress.scenarioId)} · ${signedMoney(stress.deltaEveVsBase)}`, field: `eve.byScenario[scenarioId=${stress.scenarioId}].eve`, tone: null, absent: false },
  ];

  const nb = newBusinessRead(result);
  const ids: string[] = [];
  for (const s of [...eve, ...nii]) if (!ids.includes(s.scenarioId)) ids.push(s.scenarioId);
  const rows = ids.map((id): DashRow => {
    const e = eve.find((x) => x.scenarioId === id);
    const n = nii.find((x) => x.scenarioId === id);
    return {
      scenarioId: id,
      label: labelOf(id),
      eve: e === undefined ? NOT_IN_RUN : money(e.eve),
      deltaEve: e === undefined ? NOT_IN_RUN : signedMoney(e.deltaEveVsBase),
      deltaTone: e === undefined ? null : tone(signedMoney(e.deltaEveVsBase)),
      nii12: n === undefined ? NOT_IN_RUN : money(n.totalNet12),
      nii24: n === undefined ? NOT_IN_RUN : money(n.totalNet24),
      newBusiness: nb?.mapped.includes(id) ?? false,
    };
  });
  return { cards, rows, newBusinessNote: nb === null ? null : newBusinessNote(nb) };
}
