// apps/studio/src/harness/instances.ts
/**
 * The plug-in harness, read-only (spec v3.1 Sections 4.1 and 4.2). One module is a list of instances over what the
 * engine already holds, a menu of methods (the catalog's mounted plugins, its catalog-only components, and a static
 * reserved list that names the piece each waits for), and for each instance its settings, inputs, validation state,
 * used-by and provenance. Nothing here computes a number or writes a document: every instance is a reading of the
 * loaded snapshot, set, catalog or head.
 *
 * "Mounted" is the engine's own answer: a catalog component runs when a mounted plugin carries its id or lists it as
 * an alias (the swap menu's rule, plan/componentMenu.ts). A plugin mounted later appears here with no Studio change.
 * The one exception is the stochastic rate models: they run by request, not
 * as a plan stage, so no plugin mounts them, and the Rate model page marks them mounted from a Studio constant.
 */
import type { AssumptionSet } from "@alm/engine";
import { bindingParts, type CatalogMarketSnapshot, type ReadinessState } from "@alm/reader";
import { leaves } from "../assumptions/byKindModel";
import { selectorText } from "../assumptions/selectorText";

export type HarnessModule =
  | "curve" | "vol-surface" | "rate-model" | "rate-index" | "import-template" | "behavioral" | "new-business-template";

export type HarnessState = ReadinessState;

export interface HarnessMethod {
  id: string;
  label: string;
  /** "mounted": the engine runs it today. "catalog": listed in the catalog and not wired. "reserved": names the piece it waits for. "preview": drawn on a screen, read by no run. */
  availability: "mounted" | "catalog" | "reserved" | "preview";
  piece?: "B" | "C" | "D" | "later";
  note?: string;
  /** Plugin ids that stand for this method (a mounted plugin's aliases). */
  aliases?: string[];
  /** Where the method can be seen, when it lives on another screen. */
  link?: { href: string; text: string };
}

export interface HarnessInstanceView {
  id: string;
  module: HarnessModule;
  name: string;
  methodId: string;
  /** Read-only settings, label and value as text. */
  settings: Array<{ label: string; value: string }>;
  inputs: Array<{ kind: "document" | "instance" | "series"; ref: string }>;
  validation: { state: HarnessState; messages: string[] };
  usedBy: Array<{ kind: "position" | "template" | "instance" | "run-setup" | "scenario"; id: string; count?: number }>;
  provenance: { by: string | null; at: string | null; contentHash: string | null };
}

/** The part of GET /api/catalog/plugins the harness reads. */
export interface CatalogLike {
  components: ReadonlyArray<{ id: string; kind: string; label: string; purpose?: string }>;
  mounted: ReadonlyArray<{ id: string; aliases: readonly string[]; kind: string | null }>;
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

function aliasesOf(cat: CatalogLike, id: string): string[] {
  const hit = cat.mounted.find((m) => m.id === id || m.aliases.includes(id));
  return hit === undefined ? [] : [hit.id, ...hit.aliases].filter((a) => a !== id);
}

const isMounted = (cat: CatalogLike, id: string): boolean => cat.mounted.some((m) => m.id === id || m.aliases.includes(id));

/** The catalog components of one stage kind, then any mounted plugin of that kind the components do not name. */
function componentMethods(cat: CatalogLike, kind: string, skip: readonly string[] = []): HarnessMethod[] {
  const named = cat.components.filter((c) => c.kind === kind && !skip.includes(c.id));
  const out: HarnessMethod[] = named.map((c) => ({ id: c.id, label: c.label, availability: isMounted(cat, c.id) ? "mounted" : "catalog", aliases: aliasesOf(cat, c.id) }));
  const have = new Set(named.map((c) => c.id));
  for (const m of cat.mounted) {
    if (m.kind !== kind || have.has(m.id) || m.aliases.some((a) => have.has(a)) || skip.includes(m.id)) continue;
    out.push({ id: m.id, label: m.id, availability: "mounted", aliases: [...m.aliases] });
  }
  return out;
}

export function curveMethods(cat: CatalogLike): HarnessMethod[] {
  return componentMethods(cat, "curve");
}

export function volMethods(_cat: CatalogLike): HarnessMethod[] {
  return [
    { id: "cap-normal-vols", label: "Short-rate volatility surface, read by Hull-White 1F", availability: "mounted" },
    { id: "swaption-grid", label: "Long-yield volatility surface, read by BGM", availability: "mounted" },
  ];
}

const RATE_PATH = "engine.rate-path";

/** Spec v2 decision 98: the stochastic models are mounted by this constant, not by the plugin catalog. */
export const STOCHASTIC_MODEL_NOTE = "stochastic runs by request from the Workbench or the API, base scenario only; not a plan stage";
const STOCHASTIC_MODELS: HarnessMethod[] = [
  { id: "alm-hull-white", label: "Hull-White 1F", availability: "mounted", note: STOCHASTIC_MODEL_NOTE },
  { id: "alm-bgm-lmm", label: "BGM, shifted-CEV LMM with Rebonato two-factor volatility", availability: "mounted", note: STOCHASTIC_MODEL_NOTE },
];
const SABR = "alm-sabr";

/** `volsHref` is Market > Volatility surfaces, where the SABR smile preview is drawn. */
export function rateModelMethods(cat: CatalogLike, volsHref?: string): HarnessMethod[] {
  const sabr: HarnessMethod = {
    id: SABR, label: "SABR smile", availability: "preview", note: "drawn for one expiry of the short-rate volatility surface; no run reads it",
    ...(volsHref === undefined ? {} : { link: { href: volsHref, text: "Volatility surfaces" } }),
  };
  return [
    { id: RATE_PATH, label: "Deterministic forwards", availability: "mounted" },
    ...STOCHASTIC_MODELS,
    sabr,
    ...componentMethods(cat, "term-structure", [RATE_PATH, SABR, ...STOCHASTIC_MODELS.map((m) => m.id)]),
  ];
}

/** The rate model id a stochastic run stores (absent is Hull-White, decision 80) as the harness names it. */
const MODEL_NAME: Record<string, string> = { "hull-white-1f": "Hull-White 1F", "bgm-lmm-2f": "BGM" };

/** The names of the rate models some stochastic runs used, each once, Hull-White 1F first; an unknown id as itself. */
export function rateModelNamesOf(models: ReadonlyArray<string | undefined>): string[] {
  const rank = (n: string) => (n === "BGM" ? 1 : n === "Hull-White 1F" ? 0 : 2);
  return [...new Set(models.map((m) => MODEL_NAME[m ?? "hull-white-1f"] ?? m!))].sort((x, y) => rank(x) - rank(y));
}

export function rateIndexMethods(): HarnessMethod[] {
  return [{ id: "curve-tenor-basis", label: "Curve tenor plus basis", availability: "mounted" }];
}

export function importMethods(): HarnessMethod[] {
  return [
    { id: "csv", label: "CSV positions", availability: "mounted" },
    { id: "json", label: "JSON positions", availability: "mounted" },
    { id: "workbook", label: "Market workbook", availability: "mounted", note: "uploaded on Market > Yield curves" },
  ];
}

export function behavioralMethods(cat: CatalogLike): HarnessMethod[] {
  return componentMethods(cat, "behavioral");
}

export function newBusinessMethods(): HarnessMethod[] {
  return [{ id: "flat-bullet", label: "Flat basis, 60-month fixed bullet at the par swap rate plus 0 bp", availability: "mounted", note: "the one vehicle this release uses" }];
}

const INSTRUMENT_TYPES: Array<[string, string]> = [
  ["fixed-loan", "Fixed-rate loan"], ["floating-loan", "Floating-rate loan"], ["mortgage", "Mortgage"], ["nmd", "Non-maturity deposit, non-interest bearing"],
  ["nmd-b", "Non-maturity deposit, interest bearing"], ["cd", "Certificate of deposit"], ["commitment", "Commitment"], ["swap", "Interest rate swap"],
];

/** The static reserved list of each module: what is not built, and the piece it waits for. Appended to the menu by the frame. */
const RESERVED: Record<HarnessModule, HarnessMethod[]> = {
  curve: [
    { id: "spread-over-base", label: "Spread over base", availability: "reserved", piece: "B" },
    { id: "quote-type-per-row", label: "Per-row quote type", availability: "reserved", piece: "B" },
  ],
  "vol-surface": [
    { id: "bond-option-vols", label: "Bond-option vols", availability: "reserved", piece: "B" },
    { id: "flat-vol", label: "Flat vol", availability: "reserved", piece: "B" },
  ],
  "rate-model": [],
  "rate-index": [
    { id: "formula", label: "Formula", availability: "reserved", piece: "B" },
    { id: "history-only", label: "History only", availability: "reserved", piece: "B" },
  ],
  "import-template": [
    { id: "excel-positions", label: "Excel positions", availability: "reserved", piece: "C" },
    { id: "sql", label: "SQL", availability: "reserved", piece: "C" },
  ],
  behavioral: [{ id: "lookup-table", label: "Lookup table", availability: "reserved", piece: "C" }],
  "new-business-template": INSTRUMENT_TYPES.map(([id, label]) => ({ id: `template-${id}`, label: `${label} template`, availability: "reserved" as const, piece: "C" as const })),
};

export function reservedMethods(module: HarnessModule): HarnessMethod[] {
  return RESERVED[module];
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

const grouped = (n: number): string => n.toLocaleString("en-US");
const setting = (label: string, value: string) => ({ label, value });

type CurvePoint = CatalogMarketSnapshot["curves"][keyof CatalogMarketSnapshot["curves"]][number];
const tenorOf = (p: CurvePoint): string => p.term ?? `${p.tYears}Y`;

export function curveInstances(
  market: Pick<CatalogMarketSnapshot, "id" | "contentHash" | "asOf" | "curves">,
  ctx: { positions: number | null; setupsOnBase: string[]; baseCurve?: string },
): HarnessInstanceView[] {
  const used = (): HarnessInstanceView["usedBy"] => [
    ...(ctx.positions !== null && ctx.positions > 0 ? [{ kind: "position" as const, id: "positions", count: ctx.positions }] : []),
    ...ctx.setupsOnBase.map((id) => ({ kind: "run-setup" as const, id })),
  ];
  const one = (key: "risk-free" | "term-funding" | "tlp", name: string, methodId: string): HarnessInstanceView => {
    const points = [...(market.curves[key] ?? [])].sort((a, b) => a.tYears - b.tYears);
    const first = points[0];
    const last = points[points.length - 1];
    const overlay = key === "tlp";
    return {
      id: key,
      module: "curve",
      name,
      methodId,
      settings: [
        setting("Quote set", key),
        setting(overlay ? "Nodes" : "Quoted points", grouped(points.length)),
        ...(first === undefined || last === undefined ? [] : [setting("Shortest tenor", tenorOf(first)), setting("Longest tenor", tenorOf(last))]),
        setting("As-of date", market.asOf ?? "none"),
        // The risk-free curve is the market's base curve: named by the curve it builds when the caller read it
        // (market/marketCurve.ts), since a market with no setup now builds platform default v2.
        ...(overlay
          ? [setting("Composition", "additive over the risk-free curve, in zero space")]
          : key === "risk-free" && ctx.baseCurve !== undefined
            ? [setting("Base curve", ctx.baseCurve)]
            : [setting("Interpolation", "linear in zero"), setting("Day count", "ACT/360")]),
      ],
      inputs: [
        { kind: "document", ref: `market/${market.id}` },
        ...(overlay ? [{ kind: "instance" as const, ref: "risk-free" }] : []),
      ],
      validation: points.length > 0
        ? { state: "valid", messages: [] }
        : { state: "not-set", messages: [`The snapshot stores no ${name.toLowerCase()} quotes.`] },
      usedBy: used(),
      provenance: { by: null, at: null, contentHash: market.contentHash },
    };
  };
  return [one("risk-free", "Risk-free", "alm-yield-curve"), one("term-funding", "Term funding", "alm-yield-curve"), one("tlp", "TLP overlay", "alm-tlp-overlay")];
}

export function volInstances(
  market: Pick<CatalogMarketSnapshot, "id" | "contentHash" | "asOf" | "capVolSurface" | "swaptionVolSurface">,
  ctx: { rateModelNames: string[] },
): HarnessInstanceView[] {
  const used = (name: string) => ctx.rateModelNames.filter((n) => n === name).map((id) => ({ kind: "instance" as const, id }));
  const provenance = { by: null, at: null, contentHash: market.contentHash };
  const cap = market.capVolSurface;
  const atm = cap.filter((q) => q.isAtm).length;
  const swap = market.swaptionVolSurface;
  const range = (xs: number[]): string => (xs.length === 0 ? "none" : `${Math.min(...xs)}Y to ${Math.max(...xs)}Y`);
  return [
    {
      id: "cap-normal-vols", module: "vol-surface", name: "Short-rate volatility surface", methodId: "cap-normal-vols",
      settings: [setting("Quotes", grouped(cap.length)), setting("At-the-money quotes", grouped(atm)), setting("Expiries", range(cap.map((q) => q.expiryYears))), setting("Unit", "normal vol, stored as a decimal")],
      inputs: [{ kind: "document", ref: `market/${market.id}` }],
      validation: cap.length === 0
        ? { state: "not-set", messages: ["The snapshot stores no short-rate volatility surface."] }
        : atm === 0 ? { state: "warning", messages: ["The short-rate volatility surface stores no at-the-money column."] } : { state: "valid", messages: [] },
      usedBy: used("Hull-White 1F"), provenance,
    },
    {
      id: "swaption-atm-grid", module: "vol-surface", name: "Long-yield volatility surface", methodId: "swaption-grid",
      settings: [setting("Quotes", grouped(swap.length)), setting("Expiries", range(swap.map((q) => q.expiryYears))), setting("Swap tenors", range(swap.map((q) => q.tenorYears)))],
      inputs: [{ kind: "document", ref: `market/${market.id}` }],
      validation: swap.length === 0 ? { state: "not-set", messages: ["The snapshot stores no long-yield volatility surface."] } : { state: "valid", messages: [] },
      usedBy: used("BGM"), provenance,
    },
  ];
}

export function rateModelInstances(ctx: { stochasticSetups: string[] }): HarnessInstanceView[] {
  const none = { by: null, at: null, contentHash: null };
  return [
    {
      id: "deterministic-forwards", module: "rate-model", name: "Deterministic forwards", methodId: RATE_PATH,
      settings: [setting("Path", "forwards read off the base curve"), setting("Shocks", "each rate scenario applied to the curve")],
      inputs: [{ kind: "instance", ref: "risk-free" }],
      validation: { state: "valid", messages: [] },
      usedBy: [], provenance: none,
    },
    {
      id: "hull-white-1f", module: "rate-model", name: "Hull-White 1F", methodId: "alm-hull-white",
      settings: [setting("Calibration", "the at-the-money column of the short-rate volatility surface"), setting("Scenarios", "base scenario only"), setting("Output", "rate and discount factor paths")],
      inputs: [{ kind: "instance", ref: "risk-free" }, { kind: "instance", ref: "cap-normal-vols" }],
      validation: ctx.stochasticSetups.length === 0
        ? { state: "not-set", messages: ["No run setup asks for a stochastic path."] }
        : { state: "valid", messages: [] },
      usedBy: ctx.stochasticSetups.map((id) => ({ kind: "run-setup" as const, id })),
      provenance: none,
    },
    {
      id: "bgm-lmm-2f", module: "rate-model", name: "BGM", methodId: "alm-bgm-lmm",
      settings: [
        setting("Calibration", "the default subset of the long-yield volatility surface (28 points, at least 8 required); the 10 bp gate is reported, never refused"),
        setting("Volatility", "Rebonato two-factor, shifted-CEV forwards (displacement 0.05, CEV 0.5)"),
        setting("Scenarios", "base scenario only; a volatility-shocked market is refused"),
        setting("Output", "rate and discount factor paths"),
      ],
      inputs: [{ kind: "instance", ref: "risk-free" }, { kind: "instance", ref: "swaption-atm-grid" }],
      validation: { state: "valid", messages: ["Runs by request from the Workbench or the API; no run setup names it."] },
      usedBy: [], provenance: none,
    },
  ];
}

/** A definition ordered after the one it depends on, with its depth. */
export function definitionOrder<T extends { definitionKey: string; parentKey: string | null }>(rows: readonly T[]): Array<T & { level: number }> {
  const keys = new Set(rows.map((r) => r.definitionKey));
  const kids = new Map<string, T[]>();
  const roots: T[] = [];
  for (const r of rows) {
    if (r.parentKey !== null && keys.has(r.parentKey) && r.parentKey !== r.definitionKey) {
      const list = kids.get(r.parentKey) ?? [];
      list.push(r);
      kids.set(r.parentKey, list);
    } else roots.push(r);
  }
  const out: Array<T & { level: number }> = [];
  const seen = new Set<string>();
  const walk = (r: T, level: number) => {
    if (seen.has(r.definitionKey)) return;
    seen.add(r.definitionKey);
    out.push({ ...r, level });
    for (const k of kids.get(r.definitionKey) ?? []) walk(k, level + 1);
  };
  for (const r of roots) walk(r, 0);
  // What no root reaches sits on a cycle: listed once, at the top level, in the order given.
  for (const r of rows) walk(r, 0);
  return out;
}

export function rateIndexInstances(input: {
  indices: Array<{ id: string; label: string; tenorMonths: number; basisBp: number }>;
  carried: Array<{ definitionKey: string; parentKey: string | null; status: "awaiting" | "applied" | "refused"; refusal: string | null }>;
  /** Who reads each index, by index id. */
  readers?: Record<string, string[]>;
}): HarnessInstanceView[] {
  const none = { by: null, at: null, contentHash: null };
  const indices = [...input.indices].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((i): HarnessInstanceView => ({
    id: i.id, module: "rate-index", name: i.id, methodId: "curve-tenor-basis",
    settings: [setting("Label", i.label), setting("Tenor", `${i.tenorMonths} ${i.tenorMonths === 1 ? "month" : "months"}`), setting("Basis", `${i.basisBp} bp`)],
    inputs: [{ kind: "instance", ref: "risk-free" }],
    validation: { state: "valid", messages: [] },
    usedBy: (input.readers?.[i.id] ?? []).map((id) => ({ kind: "position" as const, id })),
    provenance: none,
  }));
  const carried = definitionOrder(input.carried).map((c): HarnessInstanceView => ({
    id: c.definitionKey, module: "rate-index", name: c.definitionKey, methodId: "curve-tenor-basis",
    settings: [setting("Depends on", c.parentKey ?? "the base snapshot"), setting("Status", c.status)],
    inputs: c.parentKey === null ? [{ kind: "document", ref: "market base snapshot" }] : [{ kind: "instance", ref: c.parentKey }],
    validation: c.status === "applied"
      ? { state: "valid", messages: [] }
      : c.status === "refused"
        ? { state: "warning", messages: [c.refusal ?? "The engine refused the definition on the new base."] }
        : { state: "draft", messages: ["Awaiting re-apply on this workspace's base snapshot."] },
    usedBy: [], provenance: none,
  }));
  return [...indices, ...carried];
}

export function importTemplateInstances(ctx: { lastImport: { kind: "csv" | "json" | "workbook"; id: string; at: string } | null }): HarnessInstanceView[] {
  const row = (kind: "csv" | "json" | "workbook", name: string, doc: string): HarnessInstanceView => ({
    id: kind, module: "import-template", name, methodId: kind,
    settings: [setting("Stores", doc), setting("Stamped date", kind === "workbook" ? "the _YYYYMMDD file name suffix, else the as-of field" : "the as-of date of the form or file")],
    inputs: [{ kind: "document", ref: kind === "workbook" ? "a .xlsx workbook" : kind === "csv" ? "a .csv file" : "a .json file" }],
    validation: { state: "valid", messages: [] },
    usedBy: ctx.lastImport !== null && ctx.lastImport.kind === kind ? [{ kind: "instance", id: `last import ${ctx.lastImport.id}` }] : [],
    provenance: { by: null, at: ctx.lastImport !== null && ctx.lastImport.kind === kind ? ctx.lastImport.at : null, contentHash: null },
  });
  return [row("csv", "CSV positions", "a position book"), row("json", "JSON positions", "a position book"), row("workbook", "Market workbook", "a market snapshot")];
}

/** One instance per binding of the set, grouped by overlay kind, then family, then selector. */
export function behavioralInstances(set: Pick<AssumptionSet, "id" | "bindings">, ctx: { setups: string[] }): HarnessInstanceView[] {
  const rows = set.bindings.map((b) => {
    const p = bindingParts(b);
    return { b, kind: p.kind, familyId: b.familyId, selector: selectorText(b.selector), modelVersion: p.modelVersion };
  });
  rows.sort((x, y) => (x.kind !== y.kind ? (x.kind < y.kind ? -1 : 1) : x.familyId !== y.familyId ? (x.familyId < y.familyId ? -1 : 1) : x.selector < y.selector ? -1 : x.selector > y.selector ? 1 : 0));
  return rows.map((r): HarnessInstanceView => ({
    id: `${r.kind}::${r.familyId}::${r.selector}`,
    module: "behavioral",
    name: `${r.kind}: ${r.familyId}, ${r.selector}`,
    methodId: r.kind,
    settings: [setting("Model version", r.modelVersion), ...leaves(r.b.overlay).map((l) => setting(l.path, String(l.value)))],
    inputs: [{ kind: "document", ref: `assumption-sets/${set.id}` }],
    validation: { state: "valid", messages: [] },
    usedBy: ctx.setups.map((id) => ({ kind: "run-setup" as const, id })),
    provenance: { by: null, at: null, contentHash: null },
  }));
}

/** None in Slice 1: the Flat basis's 60-month fixed bullet is shown as the one vehicle in use. */
export function newBusinessInstances(): HarnessInstanceView[] {
  return [];
}
