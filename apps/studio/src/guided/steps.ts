// apps/studio/src/guided/steps.ts
/**
 * The guided Analysis path's stepper: what each of the nine steps reads, its state
 * (done, needs attention or optional) and, in plain words, what is still missing. Pure: the page loads the inputs.
 *
 * The states come from the workspace's own readiness report (the logic the Overview's Next step card and the launch
 * gate already use), read per item, plus three facts readiness does not hold: whether the guided run setup exists
 * (it is created by answering the New volume step's question, so its existence is the answer), what that setup asks
 * for (one path or stochastic), and which runs it has produced. The server's detail sentence of every item that is not
 * done rides along for the step's Details disclosure; the plain sentence is written here.
 */
import type { ReadinessItem, ReadinessReport, ReadinessState, RunSetup } from "@alm/reader";
import { ANALYSIS_STEPS, hrefFor, type ScreenTarget, type StepId } from "../router";

export type StepState = "done" | "attention" | "optional";

export interface StepStatus {
  id: StepId;
  label: string;
  state: StepState;
  /** What is still missing or worth a look, one plain sentence each; empty when nothing is. */
  missing: string[];
  /** The server's own words for every readiness item behind `missing`, for the Details disclosure. */
  details: string[];
}

/** The run setup slot the guided path builds (one per workspace). */
export const GUIDED_SLOT = "setup-guided";
export const GUIDED_SETUP_NAME = "Guided analysis";

/** A deterministic run of the guided slot: when it was submitted and how it ended. */
export interface GuidedRunFact { runId: string; state: string; submittedAt: string }
/** A stochastic run the guided Run step linked to this workspace (fix round 1, H2), with the setup document it ran. */
export interface LinkedRunFact extends GuidedRunFact { setupDocId: string }

export interface StepInput {
  readiness: ReadinessReport | null;
  /** The guided setup's current document, or null while the slot does not exist. */
  guided: RunSetup | null;
  /** When the guided slot last moved to a new document (its `pinnedAt`); null without a slot. */
  guidedPinnedAt: string | null;
  /** Deterministic runs launched from the guided slot, newest first. */
  deterministic: GuidedRunFact[];
  /** Stochastic runs linked to this workspace by the guided Run step, newest first. */
  stochastic: LinkedRunFact[];
  /** The workspace's newest attached run is the guided slot's newest: its readiness item speaks for it. */
  newestResultIsGuided: boolean;
}

/** Whether the newest done run of the chosen kind was made from what the analysis holds now, and why not. */
export function runCurrency(input: StepInput): { ran: boolean; current: boolean; reason: string | null } {
  const g = input.guided;
  if (g === null) return { ran: false, current: false, reason: null };
  if (g.eve.stochastic !== undefined) {
    const newest = input.stochastic.find((r) => r.state === "done");
    if (newest === undefined) return { ran: false, current: false, reason: null };
    return newest.setupDocId === g.id
      ? { ran: true, current: true, reason: null }
      : { ran: true, current: false, reason: "Your analysis changed after its last stochastic run: run it again to see what you set now." };
  }
  const newest = input.deterministic.find((r) => r.state === "done");
  if (newest === undefined) return { ran: false, current: false, reason: null };
  if (input.guidedPinnedAt !== null && newest.submittedAt < input.guidedPinnedAt) {
    return { ran: true, current: false, reason: "Your analysis changed after its last run (the setup was saved again): run it again to see what you set now." };
  }
  const newestItem = input.readiness?.items.find((i) => i.section === "results" && i.item === "Newest result");
  if (input.newestResultIsGuided && newestItem?.state === "stale") {
    return { ran: true, current: false, reason: "An input changed after the last run (the market, the balance sheet or the behavior models): run it again to see what you set now." };
  }
  return { ran: true, current: true, reason: null };
}

/** Where each step's Advanced screens are: the screens of today's sections it gathers. */
export const ADVANCED_LINKS: Record<StepId, Array<{ label: string; section: ScreenTarget["section"]; screen: string; query?: Record<string, string> }>> = {
  market: [
    { label: "Yield curves", section: "market", screen: "curves" },
    { label: "Curve setups", section: "market", screen: "curve-builder" },
    { label: "Volatility surfaces", section: "market", screen: "vols" },
    { label: "Rate indices", section: "market", screen: "indices" },
  ],
  balance: [
    { label: "Positions and import", section: "balance", screen: "positions" },
    { label: "Chart of accounts", section: "balance", screen: "coa" },
  ],
  behavior: [
    { label: "Assumption sets", section: "assumptions", screen: "sets" },
    { label: "Mapping", section: "assumptions", screen: "mapping" },
    { label: "Prepayment", section: "assumptions", screen: "prepay" },
    { label: "Deposit decay", section: "assumptions", screen: "decay" },
  ],
  "new-volume": [
    { label: "Strategy and targets", section: "balance", screen: "strategy" },
    { label: "New-business templates", section: "balance", screen: "templates" },
  ],
  calibration: [
    { label: "Rate model", section: "market", screen: "rate-model" },
    { label: "Volatility surfaces", section: "market", screen: "vols" },
  ],
  simulation: [{ label: "Run setups", section: "run", screen: "setups" }],
  scenarios: [
    { label: "Scenario library", section: "run", screen: "scenarios" },
    { label: "Custom rate shocks", section: "run", screen: "scenarios", query: { tab: "custom" } },
  ],
  run: [
    { label: "Run setups", section: "run", screen: "setups" },
    { label: "Queue and history", section: "run", screen: "queue" },
  ],
  reports: [
    { label: "Dashboard", section: "results", screen: "dashboard" },
    { label: "Earnings (NII)", section: "results", screen: "nii" },
    { label: "Value (EVE)", section: "results", screen: "eve" },
    { label: "Gap and liquidity", section: "results", screen: "gap" },
    { label: "Compare runs", section: "results", screen: "compare" },
  ],
};

/**
 * The step's Advanced links. `result` (S3f fix round, M4) is the run the step shows, the Reports step's run: a link into
 * Results then opens on that run, not on the workspace's newest one (a demo's, on a learn store).
 */
export function advancedHrefs(ws: string, step: StepId, result: string | null = null): Array<{ label: string; href: string }> {
  return ADVANCED_LINKS[step].map((l) => {
    const query = { ...(l.query ?? {}), ...(result !== null && l.section === "results" ? { result } : {}) };
    return { label: l.label, href: hrefFor({ ws, section: l.section, screen: l.screen, ...(Object.keys(query).length === 0 ? {} : { query }) }) };
  });
}

/** The plain sentence for one readiness item that is not done, by section/item and state. */
const PLAIN: Record<string, Partial<Record<ReadinessState, string>>> = {
  "market/Base snapshot": {
    "not-set": "Choose a market snapshot.",
    error: "The chosen market snapshot cannot be used.",
    warning: "The market snapshot's date is not the workspace date.",
    stale: "The market snapshot changed since it was checked.",
  },
  "market/Curves": { error: "The yield curve does not build.", warning: "The yield curve has a note to check.", stale: "The yield curve changed since it was checked." },
  "market/Rate indices and derived markets": { error: "A rate index your positions name is not in the market.", warning: "A rate index has a note to check." },
  "market/Vol surface": { error: "The volatility surface cannot be used for a stochastic run.", "not-set": "A stochastic run needs a volatility surface." },
  "balance/Positions": {
    "not-set": "Load your balance sheet.",
    error: "The positions file cannot be used.",
    warning: "The balance sheet's date is not the workspace date.",
    stale: "The positions changed since they were checked.",
  },
  "balance/Chart of accounts": { error: "The chart of accounts does not match the positions.", warning: "The chart of accounts has a note to check." },
  "balance/Strategy": { error: "The balance targets cannot be used.", warning: "The balance targets have a note to check." },
  "assumptions/Sets": {
    "not-set": "Choose the behavior models for your families and save them.",
    error: "The saved behavior models do not fit this balance sheet.",
    warning: "The behavior models have a note to check.",
    stale: "The behavior models changed since they were checked.",
  },
  "assumptions/Routing policy": { "not-set": "The workspace has no routing policy.", error: "The routing policy cannot be used." },
  "assumptions/Mapping": { error: "A model is mapped to a family this balance sheet does not hold.", warning: "The model mapping has a note to check." },
  "run/Scenarios": { "not-set": "Choose the rate scenarios.", error: "A chosen scenario cannot be resolved.", warning: "A scenario has a note to check." },
};

const isDone = (s: ReadinessState): boolean => s === "valid";

/** An item counts against a step when it is in trouble, or not set while required. */
function troubled(i: ReadinessItem): boolean {
  if (i.state === "valid" || i.state === "draft") return false;
  if (i.state === "not-set") return i.required;
  return true;
}

function plainOf(i: ReadinessItem): string {
  const key = `${i.section}/${i.item}`;
  return PLAIN[key]?.[i.state] ?? `${i.item}: ${i.state === "not-set" ? "not set" : i.state}.`;
}

function itemsOf(readiness: ReadinessReport | null, keys: string[]): ReadinessItem[] {
  if (readiness === null) return [];
  return keys.map((k) => readiness.items.find((i) => `${i.section}/${i.item}` === k)).filter((i): i is ReadinessItem => i !== undefined);
}

/** A step read from readiness items: attention when any item is troubled, else done once the required ones are valid. */
function fromItems(id: StepId, readiness: ReadinessReport | null, keys: string[], optional = false): Omit<StepStatus, "label"> {
  if (readiness === null) return { id, state: "attention", missing: ["The workspace's readiness could not be read."], details: [] };
  const items = itemsOf(readiness, keys);
  const bad = items.filter(troubled);
  if (bad.length > 0) return { id, state: "attention", missing: bad.map(plainOf), details: bad.map((i) => `${i.item}: ${i.detail}`) };
  const required = items.filter((i) => i.required);
  if (required.length > 0 && !required.every((i) => isDone(i.state))) {
    return { id, state: "attention", missing: required.filter((i) => !isDone(i.state)).map(plainOf), details: [] };
  }
  if (optional && items.every((i) => i.state === "not-set")) return { id, state: "optional", missing: [], details: [] };
  return { id, state: "done", missing: [], details: [] };
}

const NO_SETUP = "Answer the New volume step's question first: that starts your analysis setup.";

/** The nine steps' states, in order. */
export function stepStates(input: StepInput): StepStatus[] {
  const { readiness, guided } = input;
  const launch = readiness?.launchable[GUIDED_SLOT] ?? null;
  const stochastic = guided?.eve.stochastic !== undefined;
  const currency = runCurrency(input);
  const out: Array<Omit<StepStatus, "label">> = [];

  out.push(fromItems("market", readiness, ["market/Base snapshot", "market/Curves", "market/Rate indices and derived markets"]));
  out.push(fromItems("balance", readiness, ["balance/Positions", "balance/Chart of accounts"]));
  out.push(fromItems("behavior", readiness, ["assumptions/Sets", "assumptions/Routing policy", "assumptions/Mapping"]));

  // New volume: the question is answered exactly when the guided setup exists. A balance plan it names must hold.
  if (guided === null) out.push({ id: "new-volume", state: "attention", missing: ["Answer the question: what happens to maturing balances?"], details: [] });
  else {
    const strategy = guided.nii.basis.kind === "custom" ? fromItems("new-volume", readiness, ["balance/Strategy"]) : null;
    out.push(strategy ?? { id: "new-volume", state: "done", missing: [], details: [] });
  }

  // Calibration happens inside a stochastic run today: optional on one path, the vol surface on a stochastic one.
  if (!stochastic) out.push({ id: "calibration", state: "optional", missing: [], details: [] });
  else {
    const vol = fromItems("calibration", readiness, ["market/Vol surface"]);
    out.push({ ...vol, state: vol.state === "attention" ? "attention" : "done" });
  }

  // Simulation: one path unless chosen otherwise; a stochastic choice is a decision made, so done.
  out.push({ id: "simulation", state: stochastic ? "done" : "optional", missing: [], details: [] });

  // Scenarios: saved into the guided setup.
  if (guided === null) out.push({ id: "scenarios", state: "attention", missing: [NO_SETUP], details: [] });
  else if (launch !== null && launch.blocking.includes("run/Scenarios")) {
    out.push({ ...fromItems("scenarios", readiness, ["run/Scenarios"]), state: "attention" });
  } else out.push({ id: "scenarios", state: "done", missing: [], details: [] });

  // Run: the guided slot's own launch gate, then whether it has run.
  if (guided === null) out.push({ id: "run", state: "attention", missing: [NO_SETUP], details: [] });
  else if (launch === null) out.push({ id: "run", state: "attention", missing: ["The launch check for your analysis setup could not be read."], details: [] });
  else if (launch.blocking.length > 0) {
    out.push({ id: "run", state: "attention", missing: [`Fix ${launch.blocking.length === 1 ? "one thing" : `${launch.blocking.length} things`} before the run can start: see the steps marked Needs attention.`], details: launch.blocking });
  } else {
    const acks = launch.acknowledgeable.length;
    const ready = acks > 0 ? `Ready to launch once you confirm ${acks === 1 ? "one note" : `${acks} notes`}.` : "Ready to launch.";
    if (currency.current) out.push({ id: "run", state: "done", missing: [], details: [] });
    else if (currency.ran) out.push({ id: "run", state: "attention", missing: [`Needs a re-run. ${currency.reason}`], details: launch.acknowledgeable });
    else out.push({ id: "run", state: "attention", missing: [ready], details: launch.acknowledgeable });
  }

  // Reports: done only on a run made from what the analysis holds now (M1); an older run still opens, flagged.
  if (currency.current) out.push({ id: "reports", state: "done", missing: [], details: [] });
  else if (currency.ran) out.push({ id: "reports", state: "attention", missing: ["The newest run is from an earlier version of your analysis. Its report still opens here; run it again on the Run step to report on what you set now."], details: [] });
  else out.push({ id: "reports", state: "attention", missing: ["Launch the run first; its reports open here."], details: [] });

  return out.map((s) => ({ ...s, label: ANALYSIS_STEPS.find((x) => x.id === s.id)!.label }));
}

/** The first step that needs attention, or null when none does. Where "Continue" points. */
export function nextStep(states: readonly StepStatus[]): StepId | null {
  return states.find((s) => s.state === "attention")?.id ?? null;
}

export const STATE_LABEL: Record<StepState, string> = { done: "Done", attention: "Needs attention", optional: "Optional" };
