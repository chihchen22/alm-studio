// apps/studio/src/dashboard/limitUseModel.ts
/**
 * The Dashboard's Limit use card (Controls, limits; read-only first build). One row per lens of
 * GET /api/runs/:id/lenses, in the order the route returned them: the lens label as GET /api/lenses stores it (the
 * lens id when the list does not hold it), the lens's stored roll-up status, and its stored headline headroom with
 * the worst scenario and constraint. The engine sets a lens headline from fraction-basis constraints only, so the
 * headline prints as a percent of the limit. Nothing is scored, added or re-derived here; a lens with no stored
 * headline prints none.
 * S3c fix round (M3): a run whose value (EVE) block carries no scenario (a component decay or a credit run) has no
 * base a lens can read, and the lenses route refuses it as a whole; the card then says so in a plain sentence
 * ("not-applicable") instead of printing the route's 422 text.
 */
import type { LensListItem, RunLensesResponse } from "@alm/reader";
import { errText } from "../errText";
import { signedRatio } from "../format/figures";
import { lensStatusClass } from "../results/lensRows";
import type { LoadState } from "../useLoad";

export type LimitStatus = "pass" | "breach" | "unobservable";

export interface LimitUseRow {
  lensId: string;
  label: string;
  status: LimitStatus;
  /** The status word with its icon, so the status never rests on colour alone. */
  statusText: string;
  statusClass: string;
  /** The stored lens headline as a signed percent of the limit; null when the reading stores none. */
  headroom: string | null;
  /** Where the headline sits, from the stored `worst`; null when the reading stores none. */
  worst: string | null;
}

export type LimitUseModel =
  | { state: "loading" }
  | { state: "error"; text: string }
  | { state: "not-applicable"; text: string }
  | { state: "ok"; rows: LimitUseRow[] };

/** The plain sentence of a run whose value block carries no scenario. */
export const NO_VALUE_BASE =
  "Limits do not apply to this run: every lens reads value (EVE) or earnings (NII) at the base scenario, and this run carries neither, because its deposit form prices volume or transfer rates. Read the limits on a run of the same book that carries them.";

/** True when the run's value block carries no scenario, so no lens has a base to read. */
export function noValueBase(run: { eve?: { byScenario?: readonly unknown[] } } | undefined): boolean {
  return run !== undefined && (run.eve?.byScenario?.length ?? 0) === 0;
}

export interface LimitUseInput {
  readings: RunLensesResponse;
  definitions: LensListItem[];
}

const STATUS_TEXT: Record<LimitStatus, string> = { pass: "✓ Pass", breach: "✕ Breach", unobservable: "Unobservable" };

export function limitUseModel(load: LoadState<LimitUseInput>, run?: { eve?: { byScenario?: readonly unknown[] } }): LimitUseModel {
  if (load.state === "loading") return { state: "loading" };
  // S3c fix round (M3): the run itself says why the lenses refused; the route's 422 text is never shown for it.
  if (load.state === "error") return noValueBase(run) ? { state: "not-applicable", text: NO_VALUE_BASE } : { state: "error", text: errText(load.error) };
  const labels = new Map(load.value.definitions.map((d) => [d.id, d.label]));
  return {
    state: "ok",
    rows: load.value.readings.lenses.map((l) => ({
      lensId: l.lensId,
      label: labels.get(l.lensId) ?? l.lensId,
      status: l.status,
      statusText: STATUS_TEXT[l.status],
      statusClass: lensStatusClass(l.status),
      headroom: l.headline === undefined ? null : `${signedRatio(l.headline, 2)} of limit`,
      worst: l.worst === undefined ? null : `at ${l.worst.scenarioId}, constraint ${l.worst.constraintId}`,
    })),
  };
}
