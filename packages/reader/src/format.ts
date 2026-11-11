/**
 * Formatting only. These turn numbers the engine already computed into strings;
 * they perform no financial arithmetic (scaling a figure to millions and fixing
 * decimals is presentation, not computation).
 */
import type {
  CellRef,
  DimensionPredicate,
  FamilyNII,
  GapBucketRow,
  GateReport,
  PivotMetric,
  PivotResult,
  PivotRow,
  RateSpec,
  RunLogEntry,
  RunResult,
  ScenarioNII,
} from "@alm/engine";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** Full-dollar currency, e.g. $1,234,567. */
export function usd(n: number): string {
  return USD.format(n);
}

/** Compact currency in millions with one decimal, e.g. $1,234.6M. */
export function usdMM(n: number): string {
  const mm = n / 1_000_000;
  const s = mm.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `$${s}M`;
}

/** Signed compact currency in millions, e.g. +$12.3M / -$4.5M. */
export function signedMM(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${usdMM(Math.abs(n))}`;
}

/** Percent from a decimal ratio, e.g. 0.1214 -> 12.14%. */
export function pct(ratio: number, digits = 2): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Signed percent from a decimal ratio, e.g. -0.1214 -> -12.14%. */
export function signedPct(ratio: number, digits = 2): string {
  const sign = ratio > 0 ? "+" : "";
  return `${sign}${pct(ratio, digits)}`;
}

/** Years to two decimals, e.g. -2.57. */
export function years(n: number): string {
  return n.toFixed(2);
}

/**
 * Significant-figure display for diagnostics that live at wildly different
 * magnitudes (KRD residuals ~1e-4y, martingale errors ~1e-11bp, calibration
 * sigma ~1e-2). Round-trips through Number to strip trailing zeros; never
 * renders a nonzero value as "0" (toPrecision preserves the leading digits at
 * any magnitude), which a fixed-decimal format would.
 */
export function sig(n: number, digits = 6): string {
  if (n === 0) return "0";
  if (!Number.isFinite(n)) return String(n);
  return String(Number(n.toPrecision(digits)));
}

/**
 * Distribution-statistic display (dollar-scale Monte Carlo statistics): full
 * dollars with cents for |n| >= 1, significant figures below 1 so a tiny
 * nonzero standard error can never render as "0.00", and "0" only for an
 * exact envelope zero (a degenerate point mass IS zero SE).
 */
export function stat(n: number): string {
  if (n === 0) return "0";
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 1) {
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return String(Number(n.toPrecision(4)));
}

/** Sign class for coloring a delta cell. */
export function signClass(n: number): "pos" | "neg" | "zero" {
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "zero";
}

/** Signed bp shock size, e.g. 100 -> +100, -200 -> -200. */
function signedBp(bp: number): string {
  return `${bp > 0 ? "+" : ""}${bp}`;
}

/**
 * Human label for a scenario, derived from its typed rateSpec rather than from
 * its id. Book authors pick their own id conventions (S-200 in one book, SM200
 * in another); the shock the scenario actually applies is the honest thing to
 * name it by. Falls back to the authored label, then to the id.
 */
export function formatScenarioLabel(
  meta: { id: string; label: string; rateSpec: RateSpec } | undefined,
  id: string,
): string {
  if (!meta) return id;
  const spec = meta.rateSpec;
  if (spec.kind === "base") return "Base";
  if (spec.kind === "parallel") {
    return spec.shockBp === 0 ? "Base" : `${signedBp(spec.shockBp)}bp`;
  }
  if (spec.kind === "twist") {
    return `Twist ${signedBp(spec.shortBp)}/${signedBp(spec.longBp)}bp`;
  }
  if (spec.kind === "custom") {
    // Small vectors name themselves by their knots (the honest label is the
    // shock applied); longer vectors state the knot count and leave the full
    // vector to the scenario detail.
    if (spec.shocks.length <= 4) {
      return `Custom ${spec.shocks.map((s) => `${s.tenorYears}y${signedBp(s.shockBp)}`).join(" / ")}bp`;
    }
    return `Custom (${spec.shocks.length} knots)`;
  }
  return meta.label || id;
}

/**
 * Verbatim scenario-total net at a horizon: the pinned fields for 12/24 (they
 * are identities of byHorizon per the contract, and the pinned slot exists on
 * every envelope), totalNetByHorizon otherwise. Returns undefined — never 0 —
 * when the envelope predates the 1.2.0 field set. A LOOKUP, not arithmetic.
 */
export function scenarioNetAtHorizon(s: ScenarioNII, horizonMonths: number): number | undefined {
  if (horizonMonths === 12) return s.totalNet12;
  if (horizonMonths === 24) return s.totalNet24;
  return s.totalNetByHorizon?.[horizonMonths];
}

/** Verbatim family net at a horizon; same rules as scenarioNetAtHorizon. */
export function familyNetAtHorizon(f: FamilyNII, horizonMonths: number): number | undefined {
  if (horizonMonths === 12) return f.net12;
  if (horizonMonths === 24) return f.net24;
  return f.byHorizon?.[horizonMonths]?.net;
}

const DRIVER_LABELS: Record<string, string> = {
  rate: "Rate",
  volume: "Volume",
  mix: "Mix",
  prepay: "Prepay",
  "deposit-beta": "Deposit beta",
  decay: "Decay",
  "new-business": "New business",
};

export function driverLabel(id: string): string {
  return DRIVER_LABELS[id] ?? id;
}

/**
 * Display form of a binding or stage predicate: keys sorted, each key's values
 * sorted and de-duplicated, scalar and one-element list identical, joined as
 * `key=v1|v2; key2=v3`. This is a DISPLAY string. The engine's canonical key
 * (plan/dimensions.ts canonicalPredicate) is JSON and is not imported here,
 * because the viewer takes engine types only and no engine runtime. The two
 * order the same way by construction, so equal canonical keys give equal labels.
 */
export function predicateLabel(predicate: DimensionPredicate): string {
  return Object.keys(predicate)
    .sort()
    .map((k) => {
      const raw = predicate[k];
      const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      return `${k}=${[...new Set(list)].sort().join("|")}`;
    })
    .join("; ");
}

/** Gate failures as table rows. Detail is verbatim; a plan-wide failure shows a dash for the stage. */
export function gateRows(report: GateReport): Array<{ gate: string; rule: string; stage: string; detail: string }> {
  return report.failures.map((f) => ({ gate: f.gate, rule: f.rule, stage: f.stageId ?? "\u2014", detail: f.detail }));
}

/** One node of the run-log tree. Labels are built from the server's entries verbatim. */
export interface RunLogNode {
  label: string;
  children: RunLogNode[];
}

/**
 * Group a run log for display: what was mounted, where its code came from, what
 * the gates said, which plugin answered for each seam, and what refused. The
 * grouping is presentation; no entry is dropped, merged or reworded.
 */
export function runLogTree(entries: RunLogEntry[]): RunLogNode[] {
  const out: RunLogNode[] = [];
  const profile = entries.filter((e) => e.t === "profile") as Array<Extract<RunLogEntry, { t: "profile" }>>;
  if (profile.length > 0) {
    out.push({
      label: "Profile",
      children: profile.flatMap((p) => [
        { label: `hash ${p.profileHash}`, children: [] },
        ...p.rows.map((r) => ({ label: `${r.id} -> ${r.plugin} (${r.state})`, children: [] })),
      ]),
    });
  }
  const plans = entries.filter((e) => e.t === "plan") as Array<Extract<RunLogEntry, { t: "plan" }>>;
  for (const p of plans) {
    out.push({
      label: p.derived ? "Plan (derived from the request)" : `Plan ${p.planId ?? ""}`.trim(),
      children: [
        {
          label: `${p.stageIds.length} stage${p.stageIds.length === 1 ? "" : "s"}: ${p.stageIds.join(", ")}`,
          children: [],
        },
      ],
    });
  }
  const stages = entries.filter((e) => e.t === "stage") as Array<Extract<RunLogEntry, { t: "stage" }>>;
  if (stages.length > 0) {
    out.push({
      label: "Stages",
      children: stages.map((s) => ({
        label:
          `${s.stageId} (${s.kind}) by ${s.pluginId}` +
          (s.skipped === undefined ? "" : `: skipped, ${s.skipped}`),
        children: [
          ...s.consumed.map((c) => ({
            label: `consumes ${c.type}@${c.scope} from ${c.producerStageId}`,
            children: [],
          })),
          ...s.produced.map((p) => ({ label: `produces ${p.type}@${p.scope}`, children: [] })),
          ...(s.bindings ?? []).map((b) => ({
            label: `applies ${b.assumptionSetId} bindings[${b.bindingIndex}] to ${b.positionsMatched} position(s)`,
            children: [],
          })),
        ],
      })),
    });
  }
  // What each behavioral stage licensed, one leaf per binding, in log
  // order under the stage that applied it. The selector is the canonical
  // predicate string the engine logged; it is shown as logged, never rebuilt.
  const licenses = entries.filter((e) => e.t === "license") as Array<Extract<RunLogEntry, { t: "license" }>>;
  if (licenses.length > 0) {
    const children: RunLogNode[] = [];
    const byStage = new Map<string, RunLogNode>();
    for (const l of licenses) {
      let node = byStage.get(l.stageId);
      if (node === undefined) {
        node = { label: l.stageId, children: [] };
        byStage.set(l.stageId, node);
        children.push(node);
      }
      node.children.push({
        label:
          `${l.assumptionSetId} bindings[${l.bindingIndex}]: ${l.familyId} / ${l.kind} on ` +
          `${l.selector ?? "whole family"}, ${l.positionsMatched} position(s)`,
        children: [],
      });
    }
    out.push({ label: "Licenses", children });
  }
  const catalog = entries.filter((e) => e.t === "catalog") as Array<Extract<RunLogEntry, { t: "catalog" }>>;
  if (catalog.length > 0) {
    out.push({
      label: "Catalog",
      children: catalog.map((c) => ({
        label:
          c.source === "builtin"
            ? `${c.pluginId} (built in)`
            : `${c.pluginId} (${c.source.path}, sha256 ${c.source.sha256})`,
        children: [],
      })),
    });
  }
  const gates = entries.filter((e) => e.t === "gate") as Array<Extract<RunLogEntry, { t: "gate" }>>;
  if (gates.length > 0) {
    out.push({
      label: "Gates",
      children: gates.map((g) => ({
        label: `${g.event} by ${g.listenerPluginId}: ${g.passed ? "pass" : `${g.failures.length} failure(s)`}`,
        children: g.failures.map((f) => ({
          label: `${f.rule}${f.stageId === null ? "" : `@${f.stageId}`}: ${f.detail}`,
          children: [],
        })),
      })),
    });
  }
  const resolves = entries.filter((e) => e.t === "resolve") as Array<Extract<RunLogEntry, { t: "resolve" }>>;
  if (resolves.length > 0) {
    const children: RunLogNode[] = [];
    const byScenario = new Map<string, RunLogNode>();
    for (const r of resolves) {
      const suffix = r.scope.metricId === undefined ? "" : ` (${r.scope.metricId})`;
      const label = `${r.key}: ${r.pluginId}${suffix}`;
      if (r.scope.scenarioId === undefined) {
        children.push({ label, children: [] });
        continue;
      }
      let node = byScenario.get(r.scope.scenarioId);
      if (node === undefined) {
        node = { label: r.scope.scenarioId, children: [] };
        byScenario.set(r.scope.scenarioId, node);
        children.push(node);
      }
      node.children.push({ label, children: [] });
    }
    out.push({ label: "Run", children });
  }
  const refusals = entries.filter((e) => e.t === "refuse") as Array<Extract<RunLogEntry, { t: "refuse" }>>;
  if (refusals.length > 0) {
    out.push({
      label: "Refusals",
      children: refusals.map((r) => ({
        label: `${r.error} ${Object.entries(r.ids).map(([k, v]) => `${k}=${v}`).join(" ")}`.trim(),
        children: [],
      })),
    });
  }
  // An arm this build does not know renders as its own JSON rather than
  // vanishing: a log the viewer silently drops is a log that cannot be audited,
  // and the entry types are additive by contract.
  const known = new Set(["profile", "plan", "stage", "catalog", "gate", "resolve", "refuse", "license"]);
  const other = entries.filter((e) => !known.has((e as { t: string }).t));
  if (other.length > 0) {
    out.push({
      label: "Other entries",
      children: other.map((e) => ({ label: JSON.stringify(e), children: [] })),
    });
  }
  return out;
}

// --- The Views tab's helpers -------------------------------------
//
// The pivot rows come from GET /api/runs/:id/pivot and the cell numbers from
// the stored envelope. Nothing below adds, signs or rounds: each function
// picks fields and lays them out under the headers the metric implies.

/**
 * The seven pivot metrics, in the contract's order. The engine exports its own
 * PIVOT_METRICS from report/pivot.ts; this is a viewer-side mirror of that
 * list, because the viewer takes engine types only and no engine runtime. The
 * test pins the order, and a metric added on the engine side is added here.
 */
export const PIVOT_METRICS: readonly PivotMetric[] = [
  "balance",
  "principal",
  "interest",
  "repricing",
  "gapPrincipal",
  "nii",
  "evePv",
];

/** The contract's own caveat on an evePv row, shown verbatim beside the number. */
export const EVE_PV_CAVEAT = "unsigned gross present value, not EVE";

const NII_HEADERS = ["net12", "net24", "interestIncome12", "interestExpense12"] as const;

/** Metric column headers: bucket index, band label, the four NII fields, or pv. */
export function pivotHeaders(p: PivotResult): string[] {
  switch (p.metric) {
    case "nii":
      return [...NII_HEADERS];
    case "evePv":
      return ["pv"];
    case "repricing":
    case "gapPrincipal":
      return (p.bands ?? []).map((b) => b.label);
    default: {
      const n = p.rows[0]?.series?.length ?? (Array.isArray(p.total) ? p.total.length : 0);
      return Array.from({ length: n }, (_, i) => String(i));
    }
  }
}

/** One pivot row's metric values, aligned with pivotHeaders. */
export function pivotRowValues(p: PivotResult, row: PivotRow): number[] {
  switch (p.metric) {
    case "nii":
      return row.nii === undefined ? [] : [row.nii.net12, row.nii.net24, row.nii.interestIncome12, row.nii.interestExpense12];
    case "evePv":
      return row.value === undefined ? [] : [row.value];
    default:
      return row.series ?? [];
  }
}

/** The served total laid out under the same headers, or undefined when the route sent none. */
export function pivotTotalValues(p: PivotResult): number[] | undefined {
  if (p.total === undefined) return undefined;
  return typeof p.total === "number" ? [p.total] : p.total;
}

export type CellNumbers =
  | { kind: "series"; values: number[] }
  | { kind: "bands"; rows: GapBucketRow[] }
  | { kind: "nii"; net12: number; net24: number; interestIncome12: number; interestExpense12: number }
  | { kind: "pv"; pv: number };

export interface CellDetail {
  /** The cell's dictionary entry, or undefined when the id is not in the envelope. */
  ref: CellRef | undefined;
  /** The cell's stored numbers for the metric on the scenario, or undefined when that arm is absent. */
  numbers: CellNumbers | undefined;
}

/**
 * A cell's reference and its stored numbers for one metric on one scenario,
 * read from the envelope's byCell arms. An absent arm (a dynamic scenario's
 * cashflow and NII arms, per contracts/results.ts ScenarioCashflows.byCell)
 * returns numbers undefined; it never falls back to a family number.
 */
export function cellDetail(result: RunResult, metric: PivotMetric, scenarioId: string, cellId: string): CellDetail {
  const ref = result.cashflows.cells?.find((c) => c.id === cellId);
  return { ref, numbers: cellNumbers(result, metric, scenarioId, cellId) };
}

function cellNumbers(result: RunResult, metric: PivotMetric, scenarioId: string, cellId: string): CellNumbers | undefined {
  switch (metric) {
    case "balance":
    case "principal":
    case "interest": {
      const cell = result.cashflows.byScenario.find((s) => s.scenarioId === scenarioId)?.byCell?.find((c) => c.cellId === cellId);
      return cell === undefined ? undefined : { kind: "series", values: cell.series[metric] };
    }
    case "repricing":
    case "gapPrincipal": {
      const ladders = metric === "repricing" ? result.gap.repricing : result.gap.liquidity;
      const cell = ladders.find((l) => l.scenarioId === scenarioId)?.byCell?.find((c) => c.cellId === cellId);
      return cell === undefined ? undefined : { kind: "bands", rows: cell.rows };
    }
    case "nii": {
      const cell = result.nii.byScenario.find((s) => s.scenarioId === scenarioId)?.byCell?.find((c) => c.cellId === cellId);
      return cell === undefined
        ? undefined
        : { kind: "nii", net12: cell.net12, net24: cell.net24, interestIncome12: cell.interestIncome12, interestExpense12: cell.interestExpense12 };
    }
    case "evePv": {
      const cell = result.eve.byScenario.find((s) => s.scenarioId === scenarioId)?.byCell?.find((c) => c.cellId === cellId);
      return cell === undefined ? undefined : { kind: "pv", pv: cell.pv };
    }
  }
}

/** A cell's numbers laid out under the same headers as its pivot row (a band's value is the row's gap). */
export function cellDetailValues(detail: CellDetail): number[] | undefined {
  const n = detail.numbers;
  if (n === undefined) return undefined;
  switch (n.kind) {
    case "series":
      return n.values;
    case "bands":
      return n.rows.map((r) => r.gap);
    case "nii":
      return [n.net12, n.net24, n.interestIncome12, n.interestExpense12];
    case "pv":
      return [n.pv];
  }
}
