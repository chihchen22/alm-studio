// apps/studio/src/rows/instrumentRows.ts
/**
 * The Single instrument screen's pure parts (ALM Studio A+E Slice 1, Task E6; spec v3.1 Section 5.3 and 6.2).
 * The position query builder, the page window, the drill request, the setup's library refs and the schedule CSV.
 * Nothing here computes a financial number: the CSV is the received rows joined with commas, and the discount
 * factors and row PVs are the engine's own (contract 8). Nothing here writes: the drill stores nothing.
 */
import { CURRENT_MODEL_CONVENTION } from "@alm/engine/src/corrections";
import type {
  InstrumentScenarioProjectionView,
  ListPositionsQuery,
  PositionsPage,
  ProjectInstrumentRequest,
  SetupScenarios,
  WorkspaceManifest,
} from "@alm/reader";

/** The positions read is always bounded: a page is 50 rows, and a client pages by the filtered total. */
export const PAGE_SIZE = 50;

/** The horizon cap of the drill (the grid's 360 months). */
export const MAX_HORIZON_MONTHS = 360;

export interface PositionFilter {
  /** A prefix of the position id, case sensitive: the type-ahead. */
  q?: string;
  familyId?: string;
  coaNodeId?: string;
  instrumentType?: string;
  offset?: number;
}

/** The reader's query for one page: only the filters that are set, always `limit` and `offset`. */
export function positionsRequest(f: PositionFilter): ListPositionsQuery {
  const out: ListPositionsQuery = {};
  if (f.q !== undefined && f.q !== "") out.q = f.q;
  if (f.familyId !== undefined && f.familyId !== "") out.familyId = f.familyId;
  if (f.coaNodeId !== undefined && f.coaNodeId !== "") out.coaNodeId = f.coaNodeId;
  if (f.instrumentType !== undefined && f.instrumentType !== "") out.instrumentType = f.instrumentType;
  out.limit = PAGE_SIZE;
  out.offset = f.offset ?? 0;
  return out;
}

/** The same query as the route reads it, in the route's key order: `q`, `familyId`, `coaNodeId`, `instrumentType`, `limit`, `offset`. */
export function positionsQuery(f: PositionFilter): string {
  const r = positionsRequest(f);
  const params = new URLSearchParams();
  for (const k of ["q", "familyId", "coaNodeId", "instrumentType", "limit", "offset"] as const) {
    const v = r[k];
    if (v !== undefined) params.set(k, String(v));
  }
  return params.toString();
}

export interface PageWindow {
  /** One-based first and last row shown; 0 and 0 on an empty result. */
  from: number;
  to: number;
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
  prevOffset: number;
  nextOffset: number;
}

/** Which rows of the filtered total a page holds, and where the neighbouring pages start. */
export function pageWindow(page: Pick<PositionsPage, "total" | "limit" | "offset"> & { rows: unknown[] }): PageWindow {
  const n = page.rows.length;
  return {
    from: n === 0 ? 0 : page.offset + 1,
    to: page.offset + n,
    total: page.total,
    hasPrev: page.offset > 0,
    hasNext: page.offset + n < page.total,
    prevOffset: Math.max(0, page.offset - page.limit),
    nextOffset: page.offset + page.limit,
  };
}

// --- The form ----------------------------------------------------------------

export type ScenarioArm = "slate" | "shock" | "library";
export type TypedType = "fixed-loan" | "floating-loan";

/** The typed terms of a fixed or a floating loan, as the text the fields hold. */
export interface TypedForm {
  type: TypedType;
  id: string;
  familyId: string;
  side: "asset" | "liability";
  notional: string;
  maturityMonths: string;
  originationOffsetMonths: string;
  amortType: "level-pay" | "bullet";
  coupon: string;
  margin: string;
  resetFrequencyMonths: string;
}

export interface InstrumentForm {
  source: "book" | "typed";
  positionId: string;
  typed: TypedForm;
  marketId: string;
  arm: ScenarioArm;
  slateId: string;
  shockBp: string;
  /** The setup whose library scenarios the library arm reproduces. */
  setupLineageId: string;
  /** "" is none: the drill runs contractual runoff. */
  assumptionSetId: string;
  horizonMonths: string;
  durationBumpBp: string;
}

export const DEFAULT_TYPED: TypedForm = {
  type: "fixed-loan",
  id: "typed-1",
  familyId: "typed",
  side: "asset",
  notional: "1000000",
  maturityMonths: "60",
  originationOffsetMonths: "0",
  amortType: "level-pay",
  coupon: "0.06",
  margin: "0.0125",
  resetFrequencyMonths: "3",
};

/** The market the head names: its base snapshot first, then each derived market by id. */
export function marketOptions(head: WorkspaceManifest): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  const base = head.blocks.market.snapshot;
  if (base !== null) out.push({ id: base.id, label: `${base.id} (base snapshot)` });
  for (const d of head.blocks.market.derived) out.push({ id: d.id, label: `${d.id} (derived)` });
  return out;
}

/** The starting form for a head: its book's position when the address names one, its base snapshot, its first slate. */
export function defaultForm(head: WorkspaceManifest, query: Record<string, string>): InstrumentForm {
  const slates = head.blocks.scenarios.slates;
  const setups = head.blocks.run.setups;
  const wanted = query.setup;
  const setup = setups.find((s) => s.setupLineageId === wanted) ?? setups[0];
  return {
    source: "book",
    positionId: query.position ?? "",
    typed: { ...DEFAULT_TYPED },
    marketId: head.blocks.market.snapshot?.id ?? "",
    arm: slates.length > 0 ? "slate" : "shock",
    slateId: slates[0]?.id ?? "",
    shockBp: "0",
    setupLineageId: setup?.setupLineageId ?? "",
    assumptionSetId: "",
    horizonMonths: String(MAX_HORIZON_MONTHS),
    durationBumpBp: "100",
  };
}

/**
 * The reference list a setup's scenarios reduce to for the drill's `libraryRefs` arm: a library arm's refs, or a
 * plan-scenarios list when every item is a ref. A stored slate, a list with an inline definition and an empty list
 * have none (null).
 */
export function libraryRefsOf(s: SetupScenarios): string[] | null {
  if (s.kind === "library") return s.refs.length > 0 ? [...s.refs] : null;
  if (s.kind === "plan-scenarios") {
    const refs: string[] = [];
    for (const item of s.items) {
      if (!("ref" in item) || typeof item.ref !== "string") return null;
      refs.push(item.ref);
    }
    return refs.length > 0 ? refs : null;
  }
  return null;
}

/** What the library arm can offer for the chosen setup: its refs, or the reason it has none. */
export type LibraryState =
  | { state: "loading" }
  | { state: "none"; reason: string }
  | { state: "refs"; refs: string[]; setupName: string };

/** The library arm's offer for a read setup: its refs when they reduce to a ref list, else the reason in words. */
export function libraryOffer(setupName: string, s: SetupScenarios): LibraryState {
  const refs = libraryRefsOf(s);
  if (refs !== null) return { state: "refs", refs, setupName };
  if (s.kind === "slate") return { state: "none", reason: `The scenarios of ${setupName} are a stored slate; use Workspace slates.` };
  if (s.kind === "plan-scenarios") return { state: "none", reason: `The scenarios of ${setupName} include an inline definition, which the library arm cannot reproduce.` };
  return { state: "none", reason: `${setupName} names no library scenarios.` };
}

/** A whole number within [lo, hi] from a field's text, or null. */
function wholeIn(text: string, lo: number, hi: number): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

/** A finite number from a field's text, or null; an empty field is not zero. */
function finite(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export type DrillRequestResult = { ok: true; body: ProjectInstrumentRequest } | { ok: false; reason: string };

function typedInstrument(t: TypedForm): { ok: true; instrument: ProjectInstrumentRequest["instrument"] } | { ok: false; reason: string } {
  const notional = finite(t.notional);
  if (notional === null) return { ok: false, reason: "Notional must be a number." };
  const maturity = finite(t.maturityMonths);
  if (maturity === null) return { ok: false, reason: "Maturity must be a number of months." };
  const offset = finite(t.originationOffsetMonths);
  if (offset === null) return { ok: false, reason: "Origination offset must be a number of months." };
  if (t.id.trim() === "") return { ok: false, reason: "The typed instrument needs an id." };
  const head = { id: t.id, label: t.id, notional, maturityMonths: maturity, originationOffsetMonths: offset, amortType: t.amortType };
  if (t.type === "fixed-loan") {
    const coupon = finite(t.coupon);
    if (coupon === null) return { ok: false, reason: "Coupon must be a number." };
    return { ok: true, instrument: { terms: { ...head, type: "fixed-loan", coupon }, familyId: t.familyId, side: t.side } };
  }
  const margin = finite(t.margin);
  if (margin === null) return { ok: false, reason: "Margin must be a number." };
  const reset = finite(t.resetFrequencyMonths);
  if (reset === null) return { ok: false, reason: "Reset frequency must be a number of months." };
  return {
    ok: true,
    instrument: { terms: { ...head, type: "floating-loan", indexTenorMonths: 1, margin, resetFrequencyMonths: reset }, familyId: t.familyId, side: t.side },
  };
}

/**
 * The drill request for a form: the position of `bookId`, or the typed terms; the market; one of the three scenario
 * arms; one assumption set or none; horizon and bump. A refusal is a sentence, never a request the route would
 * answer on a default the reader did not choose.
 */
export function drillRequest(
  form: InstrumentForm,
  bookId: string | null,
  libraryRefs: string[] | null,
  modelConvention: "corrected-v1" | "book" = CURRENT_MODEL_CONVENTION,
): DrillRequestResult {
  let instrument: ProjectInstrumentRequest["instrument"];
  if (form.source === "book") {
    if (bookId === null) return { ok: false, reason: "This workspace holds no positions; type the terms instead." };
    if (form.positionId === "") return { ok: false, reason: "Pick a position first." };
    instrument = { portfolioId: bookId, positionId: form.positionId };
  } else {
    const t = typedInstrument(form.typed);
    if (!t.ok) return t;
    instrument = t.instrument;
  }
  if (form.marketId === "") return { ok: false, reason: "This workspace holds no market snapshot." };
  let scenarios: ProjectInstrumentRequest["scenarios"];
  if (form.arm === "slate") {
    if (form.slateId === "") return { ok: false, reason: "This workspace holds no scenario slate; use one parallel shock." };
    scenarios = { scenarioSlateId: form.slateId };
  } else if (form.arm === "shock") {
    const bp = finite(form.shockBp);
    if (bp === null) return { ok: false, reason: "The parallel shock must be a number of basis points." };
    scenarios = { parallelShockBp: bp };
  } else {
    if (libraryRefs === null) return { ok: false, reason: "The chosen setup has no library scenarios to reproduce." };
    scenarios = { libraryRefs: [...libraryRefs] };
  }
  const horizon = wholeIn(form.horizonMonths, 1, MAX_HORIZON_MONTHS);
  if (horizon === null) return { ok: false, reason: `Horizon must be a whole number of months from 1 to ${MAX_HORIZON_MONTHS}.` };
  const bump = finite(form.durationBumpBp);
  if (bump === null || bump <= 0) return { ok: false, reason: "Duration bump must be a number of basis points above zero." };
  return {
    ok: true,
    body: {
      instrument,
      marketId: form.marketId,
      scenarios,
      ...(form.assumptionSetId !== "" ? { assumptionSetId: form.assumptionSetId } : {}),
      horizonMonths: horizon,
      durationBumpBp: bump,
      // The chosen setup's convention, as its run walks the CD book.
      modelConvention,
    },
  };
}

// --- The export --------------------------------------------------------------

/** The header of the instrument-level discounted cash flow export: the engine's schedule columns, in the engine's order. */
export const SCHEDULE_HEADER = "month,pathRate,couponRate,balance,principal,interest,payment,discountFactorAllIn,discountFactorRiskFree,pvAllIn,pvRiskFree";

/** One scenario's net schedule as CSV: the received rows joined with commas, values verbatim, a trailing newline. */
export function scheduleCsv(p: InstrumentScenarioProjectionView): string {
  const lines = p.rows.map((r) =>
    [r.month, r.pathRate, r.couponRate, r.balance, r.principal, r.interest, r.payment, r.discountFactorAllIn, r.discountFactorRiskFree, r.pvAllIn, r.pvRiskFree].join(","),
  );
  return `${[SCHEDULE_HEADER, ...lines].join("\n")}\n`;
}

/** A download link that needs no server and no object URL to revoke. */
export function csvHref(csv: string): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}

/** `<position>-<scenario>-<cut-off>-dcf.csv`, anything but letters, digits, dot and dash made an underscore. */
export function csvFileName(positionId: string, scenarioId: string, cutoffDate: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9.-]/g, "_");
  return `${safe(positionId)}-${safe(scenarioId)}-${safe(cutoffDate)}-dcf.csv`;
}
