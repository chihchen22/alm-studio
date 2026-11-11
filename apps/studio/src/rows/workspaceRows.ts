// apps/studio/src/rows/workspaceRows.ts
/**
 * Pure rows behind Workspace Home, New, Overview and Compare (spec v3.1 Sections 2.4, 3.2, 3.5 and 3.6).
 * Nothing here reads the platform: a function takes what a route returned and answers words, a body or an address.
 * The server owns every rule (Production uniqueness, the clone checklist, the supersede order); this module only
 * builds the request the rules accept and prints what came back.
 */
import type {
  BlockName,
  CloneWorkspaceBody,
  CreateWorkspaceBody,
  HistoryChange,
  ReadinessReport,
  ReadinessState,
  SectionId,
  WorkspaceCompareBlock,
  WorkspaceCompareReply,
  WorkspaceCompareVerdict,
  WorkspaceManifest,
  WorkspaceStatus,
  WorkspaceType,
} from "@alm/reader";
import { hrefFor, type Query, type ScreenId } from "../router";
import { ROUTING_POLICY_FOCUS } from "../assumptions/arrivalFocus";
import { plural } from "./plural";
import { READINESS_ESCALATION } from "../shell/ReadinessChip";
import { switcherGroups, TYPE_LABEL, type SwitcherGroup } from "../shell/WorkspaceSwitcher";

// ---------------------------------------------------------------------------
// Grouping, status and readiness
// ---------------------------------------------------------------------------

/** The five types in the order the Home list and the New form print them. */
export const TYPE_ORDER: readonly WorkspaceType[] = Object.freeze(["production", "monthly", "test", "ftp", "stress"] as const);

/**
 * Home's groups, the switcher's rule: Production first, then Monthly by date descending, then Test, FTP and Stress;
 * superseded and archived workspaces under History. Empty groups are left out.
 */
export function groupByType(workspaces: WorkspaceManifest[]): SwitcherGroup[] {
  return switcherGroups(workspaces);
}

const STATUS_WORD: Record<WorkspaceStatus, string> = { active: "Active", locked: "Locked", archived: "Archived", superseded: "Superseded" };

export function statusLabel(status: WorkspaceStatus): string {
  return STATUS_WORD[status];
}

/** The sections a launch reads (server `LAUNCH_SECTIONS`, readiness.ts): Results and Govern do not decide a workspace's overall state. */
const LAUNCH_SECTIONS: readonly SectionId[] = Object.freeze(["market", "balance", "assumptions", "run"] as const);

/** The worst state among the four launch sections, in the escalation order of spec Section 3.5. */
export function overallReadiness(report: ReadinessReport): ReadinessState {
  const states = LAUNCH_SECTIONS.map((s) => report.sections[s]);
  for (const worst of READINESS_ESCALATION) if (states.includes(worst)) return worst;
  return "valid";
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function iso(y: number, monthIndex: number, day: number): string {
  const d = new Date(Date.UTC(y, monthIndex, day));
  return d.toISOString().slice(0, 10);
}

/** The last day of the month before `now`'s month, in UTC: the date a new workspace reports at by default. */
export function lastMonthEnd(now: Date): string {
  return iso(now.getUTCFullYear(), now.getUTCMonth(), 0);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** The last day of the month after the one `date` falls in; `date` itself when it is not a calendar date. */
export function nextMonthEnd(date: string): string {
  if (!isIsoDate(date)) return date;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return iso(y, m + 1, 0);
}

// ---------------------------------------------------------------------------
// The next step (spec Section 3.6 step 3)
// ---------------------------------------------------------------------------

export interface NextStep {
  label: string;
  section: SectionId;
  screen: ScreenId;
  /** The query the step's link adds; only the routing-policy step has one, the focus value that brings its card into view. */
  query?: Query;
}

/** The first unmet required item in this order; `item` is the server's readiness item name. */
const STEPS: ReadonlyArray<{ item: string; label: string; section: SectionId; screen: ScreenId; query?: Query }> = [
  { item: "Positions", label: "Import positions", section: "balance", screen: "positions" },
  { item: "Base snapshot", label: "Attach a stored snapshot", section: "market", screen: "curves" },
  { item: "Sets", label: "Attach an assumption set", section: "assumptions", screen: "sets" },
  { item: "Routing policy", label: "Attach a routing policy", section: "assumptions", screen: "sets", query: { focus: ROUTING_POLICY_FOCUS } },
  { item: "Run setups", label: "Validate the run setup", section: "run", screen: "setups" },
];

const DONE: NextStep = { label: "Launch from Run setups", section: "run", screen: "setups" };

/** A set item and a clash-warned item are met: they launch. Not set, Draft, Error and Stale are not. */
function met(state: ReadinessState | undefined): boolean {
  return state === "valid" || state === "warning";
}

/** With no report read, the first step; with every step met, the launch. */
export function nextStep(readiness: ReadinessReport | null): NextStep {
  for (const s of STEPS) {
    const state = readiness?.items.find((i) => i.item === s.item)?.state;
    if (met(state)) continue;
    const step: NextStep = { label: s.label, section: s.section, screen: s.screen };
    if (s.query !== undefined) step.query = { ...s.query };
    return step;
  }
  return DONE;
}

export function nextStepLabel(readiness: ReadinessReport | null): string {
  return nextStep(readiness).label;
}

// ---------------------------------------------------------------------------
// The create and clone forms
// ---------------------------------------------------------------------------

export const BLOCK_ORDER: readonly BlockName[] = Object.freeze(["market", "positions", "targets", "assumptions", "scenarios", "run"] as const);

export const BLOCK_LABEL: Record<BlockName, string> = {
  market: "Market",
  positions: "Positions",
  targets: "Targets",
  assumptions: "Assumptions",
  scenarios: "Scenarios",
  run: "Run",
};

/** What a copy carries: every block. */
export function copyChecklist(): Record<BlockName, boolean> {
  return { market: true, positions: true, targets: true, assumptions: true, scenarios: true, run: true };
}

/**
 * What a roll-forward carries by default: every block but Targets. A carried balance plan is dated to the old
 * as-of and lowering refuses it on the new book, so it is unticked until the plan is re-authored (Section 2.4).
 */
export function rollForwardChecklist(): Record<BlockName, boolean> {
  return { ...copyChecklist(), targets: false };
}

export type StartMode = "blank" | "copy" | "roll-forward";

export interface WorkspaceForm {
  start: StartMode;
  /** The workspace a copy or roll-forward starts from; "" for a blank one. */
  sourceId: string;
  name: string;
  type: WorkspaceType;
  cutoffDate: string;
  owner: string;
  /** Typed, never verified: the name every mutating route stamps on its history line. */
  by: string;
  blocks: Record<BlockName, boolean>;
}

export const NAME_MAX = 80;

/** A blank workspace, Test preselected, reporting at the last month-end. */
export function newFormDefaults(today: Date): WorkspaceForm {
  return { start: "blank", sourceId: "", name: "", type: "test", cutoffDate: lastMonthEnd(today), owner: "", by: "", blocks: copyChecklist() };
}

/**
 * The form after the start mode changes: the type, the date and the checklist take the mode's defaults, the typed
 * fields stay. A copy keeps the source's cut-off date; a roll-forward defaults to the month after it.
 */
export function withStart(form: WorkspaceForm, start: StartMode, source: WorkspaceManifest | null, today: Date = new Date(), blankCutoff: string | null = null): WorkspaceForm {
  // A blank start takes the newest market snapshot's date when one is known (S2a fix round 1, M2), else the last month-end.
  if (start === "blank" || source === null) {
    return { ...form, start: "blank", sourceId: "", type: "test", cutoffDate: blankCutoff ?? lastMonthEnd(today), blocks: copyChecklist() };
  }
  const base = { ...form, start, sourceId: source.id };
  if (start === "copy") return { ...base, type: "test", cutoffDate: source.cutoffDate, blocks: copyChecklist() };
  return { ...base, type: "monthly", cutoffDate: nextMonthEnd(source.cutoffDate), blocks: rollForwardChecklist() };
}

/**
 * The clone dialog's first state for `source`. A copy defaults to Test and a roll-forward to Monthly (spec Section
 * 2.4). "correct" is a copy typed Production: from a Production month it is the supersede clone of ruling 14.
 */
export function cloneFormFor(source: WorkspaceManifest, mode: "copy" | "roll-forward" | "correct", by = ""): WorkspaceForm {
  const empty = withStart(newFormDefaults(new Date()), mode === "roll-forward" ? "roll-forward" : "copy", source);
  const stem = source.name.length > 0 ? source.name : source.id;
  const form = { ...empty, owner: source.owner, by };
  if (mode === "roll-forward") return { ...form, name: `${stem}, ${empty.cutoffDate}`.slice(0, NAME_MAX) };
  if (mode === "correct") return { ...form, type: "production", name: `${stem} (corrected)`.slice(0, NAME_MAX) };
  return { ...form, name: `${stem} (copy)`.slice(0, NAME_MAX) };
}

/** True when this form, applied to `source`, would be a correction of a Production month: the server then needs `supersedeSource`. */
export function isSupersede(form: WorkspaceForm, source: WorkspaceManifest | null): boolean {
  return form.start === "copy" && form.type === "production" && source !== null && source.type === "production";
}

/** The blocks ticked, in manifest order. */
export function tickedBlocks(blocks: Record<BlockName, boolean>): BlockName[] {
  return BLOCK_ORDER.filter((b) => blocks[b]);
}

export function createBody(form: WorkspaceForm): CreateWorkspaceBody {
  return { name: form.name.trim(), type: form.type, cutoffDate: form.cutoffDate, owner: form.owner.trim(), by: form.by.trim() };
}

/** `expectedRevision` is the source's head revision as loaded; the cut-off date is sent for a roll-forward only. */
export function cloneBody(form: WorkspaceForm, source: WorkspaceManifest): CloneWorkspaceBody {
  const body: CloneWorkspaceBody = {
    expectedRevision: source.revision,
    by: form.by.trim(),
    mode: form.start === "roll-forward" ? "roll-forward" : "copy",
    name: form.name.trim(),
    type: form.type,
    blocks: tickedBlocks(form.blocks),
  };
  if (form.start === "roll-forward") body.cutoffDate = form.cutoffDate;
  if (isSupersede(form, source)) body.supersedeSource = true;
  return body;
}

/** What stops a submit, in words; the server still decides. An empty list means the form can be sent. */
export function formProblems(form: WorkspaceForm, source: WorkspaceManifest | null): string[] {
  const out: string[] = [];
  if (form.name.trim().length === 0) out.push("Name the workspace.");
  else if (form.name.length > NAME_MAX) out.push(`The name is at most ${NAME_MAX} characters.`);
  if (form.start === "blank" && form.owner.trim().length === 0) out.push("Type an owner.");
  if (form.by.trim().length === 0) out.push("Type your name: it is stamped on the history line.");
  if (form.start !== "copy" && !isIsoDate(form.cutoffDate)) out.push("Choose a cut-off date.");
  if (form.start !== "blank" && source === null) out.push("Choose the workspace to start from.");
  if (form.start === "roll-forward" && source !== null && isIsoDate(form.cutoffDate) && !(form.cutoffDate > source.cutoffDate)) {
    out.push(`A roll-forward moves the cut-off date past ${source.cutoffDate}.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overview: the block summary and the history
// ---------------------------------------------------------------------------

export interface BlockSummaryRow {
  block: BlockName;
  label: string;
  text: string;
  section: SectionId;
  screen: ScreenId;
}

/** One line per block of what the head pins, with the screen that edits it. */
export function blockSummary(head: WorkspaceManifest): BlockSummaryRow[] {
  const { market, positions, targets, assumptions, scenarios, run } = head.blocks;
  const awaiting = market.carried.filter((c) => c.status === "awaiting").length;
  const marketText = [
    market.snapshot === null ? "No base snapshot" : market.snapshot.id,
    plural(market.derived.length, "derived market", "derived markets"),
    ...(market.carried.length > 0 ? [`${awaiting} of ${market.carried.length} carried definitions awaiting re-apply`] : []),
  ].join("; ");
  const positionsText = [
    positions.book === null ? "No position book" : positions.book.id,
    ...(positions.retagged.length > 0 ? [plural(positions.retagged.length, "retagged book", "retagged books")] : []),
  ].join("; ");
  const assumptionsText = [
    plural(assumptions.sets.length, "set", "sets"),
    assumptions.defaultSetId === null ? "no default set" : `default ${assumptions.defaultSetId}`,
  ].join("; ");
  return [
    { block: "market", label: BLOCK_LABEL.market, text: marketText, section: "market", screen: "curves" },
    { block: "positions", label: BLOCK_LABEL.positions, text: positionsText, section: "balance", screen: "positions" },
    { block: "targets", label: BLOCK_LABEL.targets, text: plural(targets.balancePlans.length, "balance plan", "balance plans"), section: "balance", screen: "strategy" },
    { block: "assumptions", label: BLOCK_LABEL.assumptions, text: assumptionsText, section: "assumptions", screen: "sets" },
    { block: "scenarios", label: BLOCK_LABEL.scenarios, text: plural(scenarios.slates.length, "authored slate", "authored slates"), section: "run", screen: "scenarios" },
    { block: "run", label: BLOCK_LABEL.run, text: plural(run.setups.length, "run setup", "run setups"), section: "run", screen: "setups" },
  ];
}

const short = (hash: string): string => hash.slice(0, 8);

/** Curve setup labels by document id (cs-...), read from the store for a history (rows/curveSetupLabels.ts). */
export type CurveSetupLabels = ReadonlyMap<string, string>;

/**
 * A curve setup line in words; null for any other change. The server writes each curve setup event
 * as a set-block line on the market block: a new setup is op "add"; an edit-save is op "set" marked `curveSetup:
 * "edit"`; an activate is op "set" with no marker; a return to the platform default is op "remove" marked
 * `curveSetup: "deactivate"`. Workspace Home and Govern history both read it. The line names the setup by its label
 * when `labels` knows one, and by its document id otherwise (no label read, a read that failed, or a blank label).
 */
export function curveSetupChangeText(c: HistoryChange, labels?: CurveSetupLabels): string | null {
  if (c.kind !== "set-block" || c.ref.collection !== "curve-setups") return null;
  const label = labels?.get(c.ref.id);
  const name = label === undefined || label.trim() === "" ? c.ref.id : label;
  if (c.curveSetup === "deactivate") return "Returned to the platform default curve";
  if (c.curveSetup === "edit") return `Saved curve setup ${name}`;
  if (c.op === "add") return `Added curve setup ${name}`;
  if (c.op === "set") return `Made curve setup ${name} active`;
  return null;
}

/**
 * A derived curve save in words; null for any other change. The server writes each save as a
 * set-block line on the market block whose ref is the derived curve document (collection "derived-curves"): op "add"
 * for a new slot, op "set" for an edit, both marked `derivedCurve: "edit"`. One sentence covers both; `by` is the
 * line's typed name. Any other op (none is written today) is not a save and falls to the generic line.
 */
export function derivedCurveChangeText(c: HistoryChange, by?: string): string | null {
  if (c.kind !== "set-block" || c.ref.collection !== "derived-curves" || (c.op !== "add" && c.op !== "set")) return null;
  return by === undefined ? `Derived curve ${c.ref.id} saved.` : `Derived curve ${c.ref.id} saved by ${by}.`;
}

/** One history change as a sentence; `labels` names curve setups (see curveSetupChangeText), `by` is the line's typed name. */
export function describeChange(c: HistoryChange, labels?: CurveSetupLabels, by?: string): string {
  switch (c.kind) {
    case "create":
      return "Created";
    case "set-block": {
      const derived = derivedCurveChangeText(c, by);
      if (derived !== null) return derived;
      const curve = curveSetupChangeText(c, labels);
      if (curve !== null) return curve;
      const what = `${c.ref.collection} ${c.ref.id}`;
      if (c.op === "set") return `Set ${what} in ${c.block}`;
      return c.op === "add" ? `Added ${what} to ${c.block}` : `Removed ${what} from ${c.block}`;
    }
    case "set-default":
      return `Default assumption set is ${c.setId}`;
    case "meta": {
      const parts: string[] = [];
      if (c.name !== undefined) parts.push(`Renamed to ${c.name}`);
      if (c.note !== undefined) parts.push("Note changed");
      return parts.length > 0 ? parts.join("; ") : "Meta changed";
    }
    case "status":
      return `Status ${c.from} to ${c.to}`;
    case "lock":
      return `Locked on approval ${c.approvalId}`;
    case "supersede":
      return `Superseded by ${c.by}`;
    case "re-pin":
      return `Re-pinned ${c.block} ${c.id} from ${short(c.from)} to ${short(c.to)}`;
    case "reapply":
      return c.appliedId !== null ? `Re-applied ${c.definitionKey} as ${c.appliedId}` : `Re-apply of ${c.definitionKey} refused: ${c.refusal ?? "no reason given"}`;
    case "clash":
      return `Cut-off clash: ${c.id} in ${c.block} is dated ${c.documentAsOf}`;
  }
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

const VERDICT_WORD: Record<WorkspaceCompareVerdict, string> = {
  same: "Same",
  changed: "Changed",
  "only-a": "Only in A",
  "only-b": "Only in B",
};

export function verdictLabel(v: WorkspaceCompareVerdict): string {
  return VERDICT_WORD[v];
}

/** One entry tuple of a block (the exact tuple the block hash covers) as a line of words. */
export function tupleText(t: Array<string | null>): string {
  const [kind, ...rest] = t;
  const at = (i: number): string => rest[i] ?? "none";
  switch (kind) {
    case "default":
      return `default set ${at(0)}`;
    case "derived":
      return `derived ${at(0)} (${short(at(1))}), definition ${at(2)}`;
    case "carried":
      return `carried ${at(0)}: ${at(4)}`;
    case "run-setups":
      return `setup ${at(0)} at ${at(1)} (${short(at(2))})`;
    default:
      return `${kind ?? "none"} ${at(0)} (${short(at(1))})`;
  }
}

export interface Drill {
  label: string;
  href: string;
}

export interface CompareRow {
  block: BlockName;
  label: string;
  verdict: WorkspaceCompareVerdict;
  verdictLabel: string;
  /** Entry lists of a changed block, side by side; empty otherwise. */
  a: string[];
  b: string[];
  drills: Drill[];
  /** A drill the page could not offer, and why. */
  absent: string | null;
}

function defaultSetOf(entries: Array<Array<string | null>> | undefined): string | null {
  const hit = entries?.find((t) => t[0] === "default");
  return hit?.[1] ?? null;
}

/**
 * The per-block verdict rows with the drill links of spec Section 2.4: a changed Assumptions block drills into the
 * default sets' diff, a changed Market block into each side's Rate indices, a changed Run block into Results >
 * Compare of the newest done run on each side (`newestDone`; a side with none says so).
 */
export function compareRows(reply: WorkspaceCompareReply, newestDone: { a: string | null; b: string | null }): CompareRow[] {
  const idA = reply.a.id;
  const idB = reply.b.id;
  return BLOCK_ORDER.map((block): CompareRow => {
    const cb: WorkspaceCompareBlock = reply.blocks[block];
    const drills: Drill[] = [];
    let absent: string | null = null;
    if (cb.verdict === "changed") {
      if (block === "assumptions") {
        const dA = defaultSetOf(cb.a);
        const dB = defaultSetOf(cb.b);
        if (dA !== null && dB !== null && dA !== dB) {
          drills.push({ label: `Diff default set ${dB} over ${dA}`, href: hrefFor({ ws: idA, section: "assumptions", screen: "sets", query: { base: dA, layers: dB } }) });
        }
        drills.push({ label: "Assumption sets in A", href: hrefFor({ ws: idA, section: "assumptions", screen: "sets" }) });
        drills.push({ label: "Assumption sets in B", href: hrefFor({ ws: idB, section: "assumptions", screen: "sets" }) });
      } else if (block === "market") {
        drills.push({ label: "Rate indices in A", href: hrefFor({ ws: idA, section: "market", screen: "indices" }) });
        drills.push({ label: "Rate indices in B", href: hrefFor({ ws: idB, section: "market", screen: "indices" }) });
      } else if (block === "run") {
        if (newestDone.a !== null && newestDone.b !== null) {
          drills.push({ label: `Compare runs ${newestDone.a} and ${newestDone.b}`, href: hrefFor({ ws: idA, section: "results", screen: "compare", query: { runs: `${newestDone.a},${newestDone.b}` } }) });
        } else {
          const missing = [newestDone.a === null ? "A" : null, newestDone.b === null ? "B" : null].filter((s): s is string => s !== null);
          absent = `No run comparison: workspace ${missing.join(" and ")} has no done run.`;
        }
      }
    }
    return {
      block,
      label: BLOCK_LABEL[block],
      verdict: cb.verdict,
      verdictLabel: verdictLabel(cb.verdict),
      a: cb.verdict === "changed" ? (cb.a ?? []).map(tupleText) : [],
      b: cb.verdict === "changed" ? (cb.b ?? []).map(tupleText) : [],
      drills,
      absent,
    };
  });
}

export { TYPE_LABEL };
