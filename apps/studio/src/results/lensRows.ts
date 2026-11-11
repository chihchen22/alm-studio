// apps/studio/src/results/lensRows.ts
/** Lens reading rows (Studio S3a): one row per scenario and constraint, fields as the lenses route returned them. */
import { sig, signedPct, type RunLensesResponse } from "@alm/reader";

export type LensReadingView = RunLensesResponse["lenses"][number];

export interface LensRow {
  scenarioId: string;
  constraintId: string;
  reader: string;
  /** The reader's stored parameters; absent when the constraint carries none. */
  params?: Record<string, string | number>;
  op: string;
  limit: number;
  value: number | null;
  headroom: number | null;
  basis: "fraction" | "absolute" | null;
  status: "pass" | "breach" | "unobservable";
  reason: string | null;
}

export function lensRows(l: LensReadingView): LensRow[] {
  return l.byScenario.flatMap((s) =>
    s.constraints.map((c) => ({
      scenarioId: s.scenarioId,
      constraintId: c.constraintId,
      reader: c.reader,
      ...(c.params !== undefined ? { params: c.params } : {}),
      op: c.op,
      limit: c.limit,
      value: c.value ?? null,
      headroom: c.headroom ?? null,
      basis: c.headroomBasis ?? null,
      status: c.status,
      reason: c.reason ?? null,
    })),
  );
}

/** Headroom as its stored basis says: a fraction of the limit as a percent, an absolute slack as a number. */
export function headroomText(r: LensRow): string {
  if (r.headroom === null) return "";
  return r.basis === "fraction" ? signedPct(r.headroom) : sig(r.headroom);
}

/** The reader's parameters as stored, key=value joined by "; " in stored key order. */
export function paramsText(r: LensRow): string {
  return r.params === undefined ? "" : Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join("; ");
}

export function lensStatusClass(s: LensRow["status"]): string {
  return s === "pass" ? "status status-pass" : s === "breach" ? "status status-breach" : "status status-unobs";
}
