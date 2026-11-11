/**
 * ALM Studio hash router (Pieces A and E, spec v3.1 Section 3). Every screen lives inside a workspace:
 * #/ws/<ws>/<section>/<screen>[/<slot>]?<query>. One table, SCREENS, generates the section bar, the
 * rail, the addresses and the forwarding of the 42 old layer addresses, the 9 pre-Piece-1 page ids and
 * the 4 bare modules. LAYERS is the frozen record of the old addresses: the forwarding map and the
 * tests read it and nothing renders from it. The one selection that travels is `result`, and only
 * inside Results; page state stays in the query.
 */
import { useEffect, useState } from "react";
import { registeredScreen, registeredScreens } from "./registry";

export type ModuleId = "data" | "model" | "analyze" | "govern";

export const MODULES: ReadonlyArray<{ id: ModuleId; label: string }> = [
  { id: "data", label: "Data" },
  { id: "model", label: "Model" },
  { id: "analyze", label: "Analyze" },
  { id: "govern", label: "Govern" },
];

export type LayerId =
  | "data/balance/book" | "data/balance/coa" | "data/balance/targets" | "data/balance/hierarchies"
  | "data/market/curves" | "data/market/vols" | "data/market/spreads" | "data/market/indices" | "data/market/macro"
  | "data/assumptions/prepay" | "data/assumptions/decay" | "data/assumptions/deposit-repricing"
  | "data/assumptions/renewal-draws" | "data/assumptions/loan-repricing" | "data/assumptions/edit" | "data/assumptions/stacks"
  | "data/scenarios/sets" | "data/scenarios/library" | "data/scenarios/custom" | "data/scenarios/other-shocks" | "data/scenarios/balance-shocks" | "data/scenarios/funding-spread-shocks" | "data/scenarios/volatility-shocks"
  | "model/model/chain" | "model/model/runs"
  | "analyze/overview/dashboard"
  | "analyze/measures/nii" | "analyze/measures/eve" | "analyze/measures/gap" | "analyze/measures/ftp" | "analyze/measures/rates" | "analyze/measures/stochastic"
  | "analyze/explain/attribution" | "analyze/explain/views" | "analyze/explain/metrics" | "analyze/explain/lenses" | "analyze/explain/compare"
  | "govern/records/lineage" | "govern/records/inventory" | "govern/records/audit"
  | "govern/controls/limits" | "govern/controls/approvals";

export interface SoonInfo {
  /** The program piece the layer waits for. */
  piece: number;
  /** What the layer will do, in one sentence, with no digit. */
  will: string;
  /** The engine or platform gap today, in one sentence, with no digit. */
  gap: string;
}

export interface LayerDef {
  id: LayerId;
  module: ModuleId;
  /** Rail group heading. */
  area: string;
  label: string;
  status: "live" | "soon";
  soon?: SoonInfo;
  /** A Results measure layer: the tab id its body renders. */
  tab?: string;
}

const live = { status: "live" } as const;

/** The 42 old layers. Frozen: the forwarding map and the tests read it; nothing renders from it. */
export const LAYERS: readonly LayerDef[] = Object.freeze([
  { id: "data/balance/book", module: "data", area: "Balance sheet", label: "Book and as-of", ...live },
  { id: "data/balance/coa", module: "data", area: "Balance sheet", label: "Chart of accounts", ...live },
  { id: "data/balance/targets", module: "data", area: "Balance sheet", label: "Targets and new business", ...live },
  { id: "data/balance/hierarchies", module: "data", area: "Balance sheet", label: "Hierarchies and mapping", ...live },
  { id: "data/market/curves", module: "data", area: "Market", label: "Yield curves", ...live },
  { id: "data/market/vols", module: "data", area: "Market", label: "Volatilities", ...live },
  { id: "data/market/spreads", module: "data", area: "Market", label: "Spreads and TLP", ...live },
  { id: "data/market/indices", module: "data", area: "Market", label: "Rate indices", ...live },
  { id: "data/market/macro", module: "data", area: "Market", label: "Macro factors", ...live },
  { id: "data/assumptions/prepay", module: "data", area: "Assumptions", label: "Prepayment", ...live },
  { id: "data/assumptions/decay", module: "data", area: "Assumptions", label: "Deposit decay", ...live },
  { id: "data/assumptions/deposit-repricing", module: "data", area: "Assumptions", label: "Deposit repricing", ...live },
  { id: "data/assumptions/renewal-draws", module: "data", area: "Assumptions", label: "Renewal and draws", ...live },
  { id: "data/assumptions/loan-repricing", module: "data", area: "Assumptions", label: "Loan repricing", ...live },
  { id: "data/assumptions/edit", module: "data", area: "Assumptions", label: "Edit a set", ...live },
  { id: "data/assumptions/stacks", module: "data", area: "Assumptions", label: "Assumption stacks", ...live },
  { id: "data/scenarios/sets", module: "data", area: "Scenarios", label: "Scenario sets", ...live },
  { id: "data/scenarios/library", module: "data", area: "Scenarios", label: "Rate shock library", ...live },
  { id: "data/scenarios/custom", module: "data", area: "Scenarios", label: "Custom rate shocks", ...live },
  { id: "data/scenarios/other-shocks", module: "data", area: "Scenarios", label: "Behavioral shocks", ...live },
  { id: "data/scenarios/balance-shocks", module: "data", area: "Scenarios", label: "Balance shocks", ...live },
  { id: "data/scenarios/funding-spread-shocks", module: "data", area: "Scenarios", label: "Funding spread shocks", ...live },
  { id: "data/scenarios/volatility-shocks", module: "data", area: "Scenarios", label: "Volatility shocks", ...live },
  { id: "model/model/chain", module: "model", area: "Model", label: "Model chain", ...live },
  { id: "model/model/runs", module: "model", area: "Model", label: "Runs", ...live },
  { id: "analyze/overview/dashboard", module: "analyze", area: "Overview", label: "Dashboard", ...live, tab: "overview" },
  { id: "analyze/measures/nii", module: "analyze", area: "Measures", label: "Earnings (NII)", ...live, tab: "nii" },
  { id: "analyze/measures/eve", module: "analyze", area: "Measures", label: "Value (EVE)", ...live, tab: "eve" },
  { id: "analyze/measures/gap", module: "analyze", area: "Measures", label: "Gap and liquidity", ...live, tab: "gap" },
  { id: "analyze/measures/ftp", module: "analyze", area: "Measures", label: "FTP", ...live, tab: "ftp" },
  { id: "analyze/measures/rates", module: "analyze", area: "Measures", label: "Rate paths", ...live, tab: "rates" },
  // One stochastic run's stored envelope. No tab: ResultsLayer reads RunResult only.
  { id: "analyze/measures/stochastic", module: "analyze", area: "Measures", label: "Stochastic distributions", ...live },
  { id: "analyze/explain/attribution", module: "analyze", area: "Explain", label: "Attribution", ...live, tab: "attribution" },
  { id: "analyze/explain/views", module: "analyze", area: "Explain", label: "Views", ...live, tab: "views" },
  { id: "analyze/explain/metrics", module: "analyze", area: "Explain", label: "Custom metrics", ...live, tab: "metrics" },
  { id: "analyze/explain/lenses", module: "analyze", area: "Explain", label: "Lenses", ...live, tab: "lenses" },
  { id: "analyze/explain/compare", module: "analyze", area: "Explain", label: "Compare runs", ...live },
  { id: "govern/records/lineage", module: "govern", area: "Records", label: "Versions and lineage", ...live },
  { id: "govern/records/inventory", module: "govern", area: "Records", label: "Model inventory", ...live },
  { id: "govern/records/audit", module: "govern", area: "Records", label: "Run audit log", ...live },
  { id: "govern/controls/limits", module: "govern", area: "Controls", label: "Limits", ...live },
  { id: "govern/controls/approvals", module: "govern", area: "Controls", label: "Approvals and sign-off", ...live },
]);

export const DEFAULT_LAYER: LayerId = "analyze/overview/dashboard";

const BY_ID = new Map<string, LayerDef>(LAYERS.map((l) => [l.id, l]));

export function isLayerId(s: string): s is LayerId {
  return BY_ID.has(s);
}

export function layerDef(id: LayerId): LayerDef {
  return BY_ID.get(id)!;
}

function isModuleId(s: string): s is ModuleId {
  return MODULES.some((m) => m.id === s);
}

export function firstLayerOf(module: ModuleId): LayerId {
  return LAYERS.find((l) => l.module === module)!.id;
}

/** The nine page ids of the pre-Piece-1 router; links written against them still forward. */
export type LegacyPageId = "home" | "balance-sheet" | "market" | "assumptions" | "scenarios" | "plan" | "run" | "results" | "compare";

export const LEGACY_PAGE_IDS: readonly LegacyPageId[] = ["home", "balance-sheet", "market", "assumptions", "scenarios", "plan", "run", "results", "compare"];

const LEGACY: Record<Exclude<LegacyPageId, "results">, LayerId> = {
  home: "analyze/overview/dashboard",
  "balance-sheet": "data/balance/book",
  market: "data/market/curves",
  assumptions: "data/assumptions/stacks",
  scenarios: "data/scenarios/sets",
  plan: "model/model/chain",
  run: "model/model/runs",
  compare: "analyze/explain/compare",
};

function isLegacy(s: string): s is LegacyPageId {
  return s === "results" || Object.hasOwn(LEGACY, s);
}

/** An old page id to its layer; an old Results link picks the layer from its tab. */
function legacyLayer(page: LegacyPageId, query: Record<string, string>): LayerId {
  if (page !== "results") return LEGACY[page];
  const byTab = LAYERS.find((l) => l.tab !== undefined && l.tab === query.tab);
  return byTab?.id ?? DEFAULT_LAYER;
}

function withoutTab(query: Record<string, string>): Record<string, string> {
  const out = { ...query };
  delete out.tab;
  return out;
}

// ---------------------------------------------------------------------------
// The seven sections and their screens (spec v3.1 Section 3.1)
// ---------------------------------------------------------------------------

export type SectionId = "workspace" | "market" | "balance" | "assumptions" | "run" | "results" | "govern";

export const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: "workspace", label: "Workspace" },
  { id: "market", label: "Market" },
  { id: "balance", label: "Balance Sheet" },
  { id: "assumptions", label: "Assumptions" },
  { id: "run", label: "Run" },
  { id: "results", label: "Results" },
  { id: "govern", label: "Govern" },
];

/** The core screens. A pack may register more (registry.ts), so a route's screen is any string the tables hold. */
export type CoreScreenId =
  | "overview"
  | "curves" | "curve-builder" | "derived-curves" | "vols" | "rate-model" | "indices" | "macro"
  | "positions" | "coa" | "hierarchies" | "templates" | "strategy"
  | "prepay" | "decay" | "deposit-repricing" | "renewals-draws" | "loan-client-rate" | "mapping" | "sets"
  | "setups" | "scenarios" | "batches" | "queue" | "instrument"
  | "dashboard" | "nii" | "eve" | "gap" | "ftp" | "seg" | "liquidity" | "instruments" | "rates" | "stochastic" | "attribution" | "views" | "metrics" | "lenses" | "compare"
  | "lineage" | "inventory" | "audit" | "limits" | "approvals";

export type ScreenId = CoreScreenId | (string & {});

export interface ScreenDef {
  section: SectionId;
  screen: ScreenId;
  label: string;
  /** The old layer addresses that forward here. The two retired layers are in RETIRED_LAYERS instead. */
  legacyLayers: LayerId[];
  /** The query a forward from one of `legacyLayers` adds (a tab, an instance); absent means none. */
  legacyQuery?: Partial<Record<LayerId, Record<string, string>>>;
}

function screenRow(
  section: SectionId, id: ScreenId, label: string, legacyLayers: LayerId[] = [], legacyQuery?: ScreenDef["legacyQuery"],
): ScreenDef {
  return legacyQuery === undefined ? { section, screen: id, label, legacyLayers } : { section, screen: id, label, legacyLayers, legacyQuery };
}

export const SCREENS: readonly ScreenDef[] = Object.freeze([
  screenRow("workspace", "overview", "Overview"),
  screenRow("market", "curves", "Yield curves", ["data/market/curves", "data/market/spreads"], { "data/market/spreads": { instance: "tlp" } }),
  screenRow("market", "curve-builder", "Curve setups"),
  screenRow("market", "derived-curves", "Derived curves"),
  screenRow("market", "vols", "Volatility surfaces", ["data/market/vols"]),
  screenRow("market", "rate-model", "Rate model"),
  screenRow("market", "indices", "Rate indices", ["data/market/indices"]),
  screenRow("market", "macro", "Macro factors", ["data/market/macro"]),
  screenRow("balance", "positions", "Positions and import", ["data/balance/book"]),
  screenRow("balance", "coa", "Chart of accounts", ["data/balance/coa"]),
  screenRow("balance", "hierarchies", "Hierarchies and mapping", ["data/balance/hierarchies"]),
  screenRow("balance", "templates", "New-business templates"),
  screenRow("balance", "strategy", "Strategy and targets", ["data/balance/targets"]),
  screenRow("assumptions", "prepay", "Prepayment", ["data/assumptions/prepay"]),
  screenRow("assumptions", "decay", "Deposit decay", ["data/assumptions/decay"]),
  screenRow("assumptions", "deposit-repricing", "Deposit repricing", ["data/assumptions/deposit-repricing"]),
  screenRow("assumptions", "renewals-draws", "Renewal and draws", ["data/assumptions/renewal-draws"]),
  screenRow("assumptions", "loan-client-rate", "Loan client rate", ["data/assumptions/loan-repricing"]),
  screenRow("assumptions", "mapping", "Mapping"),
  screenRow("assumptions", "sets", "Assumption sets", ["data/assumptions/stacks"]),
  screenRow("run", "setups", "Run setups", ["data/scenarios/sets"], { "data/scenarios/sets": { tab: "scenarios" } }),
  screenRow(
    "run", "scenarios", "Scenario library",
    ["data/scenarios/library", "data/scenarios/custom", "data/scenarios/other-shocks", "data/scenarios/balance-shocks", "data/scenarios/funding-spread-shocks", "data/scenarios/volatility-shocks"],
    {
      "data/scenarios/library": { tab: "rate" },
      "data/scenarios/custom": { tab: "custom" },
      "data/scenarios/other-shocks": { tab: "behavioral" },
      "data/scenarios/balance-shocks": { tab: "balance" },
      "data/scenarios/funding-spread-shocks": { tab: "basis" },
      "data/scenarios/volatility-shocks": { tab: "volatility" },
    },
  ),
  screenRow("run", "batches", "Batches"),
  screenRow("run", "queue", "Queue and history", ["model/model/runs"]),
  screenRow("run", "instrument", "Single instrument"),
  screenRow("results", "dashboard", "Dashboard", ["analyze/overview/dashboard"]),
  screenRow("results", "nii", "Earnings (NII)", ["analyze/measures/nii"]),
  screenRow("results", "eve", "Value (EVE)", ["analyze/measures/eve"]),
  screenRow("results", "gap", "Gap and liquidity", ["analyze/measures/gap"]),
  screenRow("results", "ftp", "FTP", ["analyze/measures/ftp"]),
  // The SEG / EBP, Liquidity and Instruments screens are new: no old layer address forwards to them.
  screenRow("results", "seg", "SEG / EBP"),
  screenRow("results", "liquidity", "Liquidity"),
  screenRow("results", "instruments", "Instruments"),
  screenRow("results", "rates", "Rate paths", ["analyze/measures/rates"]),
  screenRow("results", "stochastic", "Stochastic distributions", ["analyze/measures/stochastic"]),
  screenRow("results", "attribution", "Attribution", ["analyze/explain/attribution"]),
  screenRow("results", "views", "Views", ["analyze/explain/views"]),
  screenRow("results", "metrics", "Custom metrics", ["analyze/explain/metrics"]),
  screenRow("results", "lenses", "Lenses", ["analyze/explain/lenses"]),
  screenRow("results", "compare", "Compare runs", ["analyze/explain/compare"]),
  screenRow("govern", "lineage", "Versions and lineage", ["govern/records/lineage"]),
  screenRow("govern", "inventory", "Model inventory", ["govern/records/inventory"]),
  screenRow("govern", "audit", "Run audit log", ["govern/records/audit"]),
  screenRow("govern", "limits", "Limits", ["govern/controls/limits"]),
  screenRow("govern", "approvals", "Approvals and sign-off", ["govern/controls/approvals"]),
]);

/**
 * The two layers with no screen of their own (rows 15 and 24): editing a set lives on each
 * kind page and in Sets, and the chain canvas is a read-only panel under Run setups.
 */
export const RETIRED_LAYERS: Readonly<Partial<Record<LayerId, { section: SectionId; screen: ScreenId }>>> = Object.freeze({
  "data/assumptions/edit": { section: "assumptions", screen: "sets" },
  "model/model/chain": { section: "run", screen: "setups" },
});

export interface ForwardTarget {
  section: SectionId;
  screen: ScreenId;
  /** The query the forward adds to the old address's page state. */
  query: Record<string, string>;
}

const FORWARD = new Map<LayerId, ForwardTarget>();
for (const s of SCREENS) {
  for (const layer of s.legacyLayers) FORWARD.set(layer, { section: s.section, screen: s.screen, query: { ...(s.legacyQuery?.[layer] ?? {}) } });
}
for (const [layer, t] of Object.entries(RETIRED_LAYERS) as Array<[LayerId, { section: SectionId; screen: ScreenId }]>) {
  FORWARD.set(layer, { section: t.section, screen: t.screen, query: {} });
}

/** The screen an old layer address forwards to; every one of the 42 has one. */
export function forwardTarget(layer: LayerId): ForwardTarget {
  const t = FORWARD.get(layer)!;
  return { section: t.section, screen: t.screen, query: { ...t.query } };
}

const SCREEN_BY_KEY = new Map<string, ScreenDef>(SCREENS.map((s) => [`${s.section}/${s.screen}`, s]));

export function isSectionId(s: string): s is SectionId {
  return SECTIONS.some((x) => x.id === s);
}

/** A registered screen as a table row: no old layer forwards to it. */
function registeredRow(section: SectionId, id: ScreenId): ScreenDef | undefined {
  const r = registeredScreen(section, id);
  return r === undefined ? undefined : { section, screen: r.screen, label: r.label, legacyLayers: [] };
}

export function screenDef(section: SectionId, id: ScreenId): ScreenDef {
  return SCREEN_BY_KEY.get(`${section}/${id}`) ?? registeredRow(section, id)!;
}

/** The section's screens in rail order: the core table, with each registered screen after the one it names. */
export function screensOf(section: SectionId): ScreenDef[] {
  const out = SCREENS.filter((s) => s.section === section);
  for (const r of registeredScreens()) {
    if (r.section !== section) continue;
    const row: ScreenDef = { section, screen: r.screen, label: r.label, legacyLayers: [] };
    const at = r.after === undefined ? -1 : out.findIndex((s) => s.screen === r.after);
    if (at < 0) out.push(row);
    else out.splice(at + 1, 0, row);
  }
  return out;
}

export function firstScreenOf(section: SectionId): ScreenId {
  return screensOf(section)[0]!.screen;
}

// ---------------------------------------------------------------------------
// The guided Analysis path
// ---------------------------------------------------------------------------

/**
 * The nine steps of the guided Analysis path, in order. The path lives beside the seven sections above, which the
 * top bar now groups under "Advanced": #/ws/<ws>/analysis/<step>. The step tables (what each step reads, what it
 * links to) are in guided/steps.ts; this list is the address space only.
 */
export const ANALYSIS_STEPS = [
  { id: "market", label: "Market" },
  { id: "balance", label: "Balance sheet" },
  { id: "behavior", label: "Behavior" },
  { id: "new-volume", label: "New volume" },
  { id: "calibration", label: "Calibration" },
  { id: "simulation", label: "Simulation" },
  { id: "scenarios", label: "Scenarios" },
  { id: "run", label: "Run" },
  { id: "reports", label: "Reports" },
] as const;

export type StepId = (typeof ANALYSIS_STEPS)[number]["id"];

export const ANALYSIS_LABEL = "Analysis";

export function isStepId(s: string): s is StepId {
  return ANALYSIS_STEPS.some((x) => x.id === s);
}

export function stepLabel(id: StepId): string {
  return ANALYSIS_STEPS.find((x) => x.id === id)!.label;
}

/** A step of the Analysis path. Page state rides in the query; nothing travels between steps. */
export function analysisHref(ws: string, step: StepId, query: Query = {}): string {
  return withQuery(`#/ws/${encodeURIComponent(ws)}/analysis/${step}`, query);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export type Query = Record<string, string>;

export type Route =
  /** `slot` is a run setup's lineage id, present only on run/setups. */
  | { kind: "screen"; ws: string; section: SectionId; screen: ScreenId; query: Query; slot?: string }
  /** One step of the guided Analysis path. */
  | { kind: "analysis"; ws: string; step: StepId; query: Query }
  /** Workspace Home. `unknown` is the address as typed when it named nothing; the page may say so. */
  | { kind: "home"; query: Query; unknown?: string }
  | { kind: "new"; query: Query }
  | { kind: "compare"; query: Query }
  /** An old address (a layer id, a pre-Piece-1 page id or a bare module). `from` is the hash as typed, for the banner. */
  | { kind: "legacy"; layer: LayerId; query: Query; from: string };

function parseQuery(queryPart: string | undefined): Query {
  const query: Query = {};
  if (queryPart) for (const [k, v] of new URLSearchParams(queryPart)) query[k] = v;
  return query;
}

export function parseHash(hash: string): Route {
  const typed = hash.startsWith("#") ? hash : `#${hash}`;
  const raw = typed.slice(1);
  const [pathPart, queryPart] = raw.split("?", 2);
  const query = parseQuery(queryPart);
  let segs: string[];
  try {
    segs = (pathPart ?? "").split("/").filter((s) => s !== "").map((s) => decodeURIComponent(s));
  } catch {
    // A malformed escape (#/%E0) names no screen.
    return { kind: "home", query, unknown: typed };
  }
  if (segs.length === 0) return { kind: "home", query };
  const first = segs[0]!;
  if (first === "workspaces") {
    if (segs.length === 1) return { kind: "home", query };
    if (segs.length === 2 && segs[1] === "new") return { kind: "new", query };
    if (segs.length === 2 && segs[1] === "compare") return { kind: "compare", query };
    return { kind: "home", query, unknown: typed };
  }
  if (first === "ws") {
    const [, ws, section, id, slot] = segs;
    if (section === "analysis" && ws !== undefined && id !== undefined && segs.length === 4) {
      return isStepId(id) ? { kind: "analysis", ws, step: id, query } : { kind: "home", query, unknown: typed };
    }
    if (segs.length < 4 || segs.length > 5 || ws === undefined || section === undefined || id === undefined) return { kind: "home", query, unknown: typed };
    if (!isSectionId(section) || (!SCREEN_BY_KEY.has(`${section}/${id}`) && registeredScreen(section, id) === undefined)) return { kind: "home", query, unknown: typed };
    if (slot !== undefined && !(section === "run" && id === "setups")) return { kind: "home", query, unknown: typed };
    const route: Route = { kind: "screen", ws, section, screen: id as ScreenId, query };
    if (slot !== undefined) route.slot = slot;
    return route;
  }
  const path = segs.slice(0, 3).join("/");
  if (segs.length === 3 && isLayerId(path)) return { kind: "legacy", layer: path, query, from: typed };
  if (segs.length === 1 && isModuleId(first)) return { kind: "legacy", layer: firstLayerOf(first), query, from: typed };
  if (segs.length === 1 && isLegacy(first)) return { kind: "legacy", layer: legacyLayer(first, query), query: withoutTab(query), from: typed };
  return { kind: "home", query, unknown: typed };
}

export interface ScreenTarget {
  ws: string;
  section: SectionId;
  screen: ScreenId;
  slot?: string;
  query?: Query;
}

function withQuery(path: string, query: Query): string {
  const qs = new URLSearchParams(query).toString();
  return qs ? `${path}?${qs}` : path;
}

/** A workspace address. The result key is written only under Results. */
export function hrefFor(target: ScreenTarget): string {
  const q = { ...(target.query ?? {}) };
  if (target.section !== "results") delete q.result;
  const base = `#/ws/${encodeURIComponent(target.ws)}/${target.section}/${target.screen}`;
  return withQuery(target.slot === undefined ? base : `${base}/${encodeURIComponent(target.slot)}`, q);
}

export function homeHref(query: Query = {}): string {
  return withQuery("#/workspaces", query);
}

export function newWorkspaceHref(): string {
  return "#/workspaces/new";
}

export function compareHref(a: string, b: string): string {
  return withQuery("#/workspaces/compare", { a, b });
}

/** The selection that travels between screens: the result picker's choice, inside Results only. Page state stays behind. */
export const SELECTION_KEYS = ["result"] as const;

/**
 * The query a link carries to another screen: `result` and nothing else, and only when the target is Results.
 * Page state stays behind; the workspace address names the book and the market.
 */
export function selectionQuery(query: Query, targetSection: SectionId): Query {
  const out: Query = {};
  if (targetSection === "results") for (const k of SELECTION_KEYS) if (query[k] !== undefined) out[k] = query[k]!;
  return out;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
