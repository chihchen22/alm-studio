/** Govern records (ALM Studio P1): pure shaping of catalog replies, no numbers made. */
import { NOT_IN_RUN, type CatalogRunListItem, type PluginCatalogReply } from "@alm/reader";

export interface InventoryRow {
  id: string;
  label: string;
  kind: string;
  /** The catalog's role, or the empty string when the catalog gives none. */
  role: string;
  /** The catalog's purpose, or the empty string when the catalog gives none. */
  purpose: string;
  /** The stored consumes list, in stored order; empty when the catalog lists none. A list, so the view prints each id whole (Polish 6 T3). */
  consumes: string[];
  /** The stored produces list, as consumes. */
  produces: string[];
  /** True when the component id is a mounted plugin's id or one of its aliases. */
  runs: boolean;
}

/**
 * An id's pieces between its word joints (Polish 6 Task 6 fix I1, ruling): a joint falls after each hyphen, and
 * before a capital that follows a lowercase letter or a digit (Moneyness|Construction, contractual-|cashflow). The
 * view puts a wbr at each joint, so a line breaks there or between ids, never inside a word. A plain scan, not a regex
 * lookbehind, which Safari below 16.4 cannot parse (Polish 7 T1).
 */
export function idPieces(id: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  for (let i = 1; i < id.length; i++) {
    const prev = id[i - 1], ch = id[i];
    const afterHyphen = prev === "-";
    const beforeCapital = ch >= "A" && ch <= "Z" && ((prev >= "a" && prev <= "z") || (prev >= "0" && prev <= "9"));
    if (afterHyphen || beforeCapital) {
      pieces.push(id.slice(start, i));
      start = i;
    }
  }
  pieces.push(id.slice(start));
  return pieces;
}

export function inventoryRows(reply: PluginCatalogReply): InventoryRow[] {
  const mounted = new Set(reply.mounted.flatMap((m) => [m.id, ...m.aliases]));
  return reply.components.map((c) => ({
    id: c.id,
    label: c.label,
    kind: c.kind,
    role: c.role ?? "",
    purpose: c.purpose ?? "",
    consumes: [...c.consumes],
    produces: [...c.produces],
    runs: mounted.has(c.id),
  }));
}

/** Runs newest first by submittedAt; a run with no submittedAt sorts last. The input is not reordered. */
export function auditRows(runs: CatalogRunListItem[]): CatalogRunListItem[] {
  return [...runs].sort((a, b) => {
    const x = a.submittedAt;
    const y = b.submittedAt;
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? 1 : -1;
  });
}

export type AuditField = "submittedAt" | "endedAt" | "engineInputsHash" | "resultContentHash";

const PENDING = new Set(["queued", "running"]);

/** One nullable audit cell: the stored value verbatim, else Unobservable with its reason. */
export function auditCell(row: Pick<CatalogRunListItem, "state" | AuditField>, field: AuditField): string {
  const v = row[field];
  if (v !== null) return v;
  const pending = PENDING.has(row.state);
  switch (field) {
    case "submittedAt": return "Unobservable: no submit time recorded";
    case "endedAt": return pending ? "Unobservable: the run has not ended" : "Unobservable: no end time recorded";
    case "engineInputsHash": return pending ? "Unobservable: the run has not compiled" : "Unobservable: no engine inputs recorded";
    case "resultContentHash":
      if (pending) return "Unobservable: the run has not finished";
      return row.state === "done" ? "Unobservable: no result stored" : `Unobservable: the run ended ${row.state} without a result`;
  }
}

/**
 * How an opened row's plan was read. The run list carries no plan id, so the
 * plan comes from the run's stored provenance only: `skipped` when the row is
 * not done (no result exists to read), `read` with the provenance in hand,
 * `failed` with the load's own error text.
 */
export type PlanRead =
  | { kind: "skipped"; state: string }
  | { kind: "read"; provenance: { planId?: string | null } }
  | { kind: "failed"; error: string };

/** The provenance is read only for a run that ended done; any other state has no result. */
export function planReadable(state: string): boolean {
  return state === "done";
}

/**
 * The plan cell of an opened row. `Not in this run` only when the provenance
 * is in hand and carries no plan id; every path where it was not read is
 * Unobservable with its reason.
 */
export function auditPlan(read: PlanRead): string {
  if (read.kind === "read") return read.provenance.planId ?? `${NOT_IN_RUN}: the run was not submitted from a plan`;
  if (read.kind === "failed") return `Unobservable: ${read.error}`;
  if (PENDING.has(read.state)) return "Unobservable: the run has not finished";
  return `Unobservable: the run ended ${read.state} without a result`;
}
