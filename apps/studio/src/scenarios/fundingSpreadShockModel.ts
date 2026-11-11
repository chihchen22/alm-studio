// apps/studio/src/scenarios/fundingSpreadShockModel.ts
/**
 * Data > Scenarios > Funding spread shocks. Pure functions
 * over the page's draft: one base market, a list of ops (add basis points to, or
 * scale, the term liquidity premium nodes, at every node or at one tenor), and
 * the request the two derive routes take. The server derives the snapshot and
 * computes every number the page prints; this file computes none. Types
 * come from the engine with import type only, and the request key is the local
 * sorted-key string of behavioralShockModel, so no hash module reaches the
 * Studio bundle.
 */
import type { DerivedMarketSnapshot, MarketShockOp, MarketShockOpKind } from "@alm/engine";
import { ApiError, pct, type DerivedMarketSaveReply, type MarketDeriveRequest } from "@alm/reader";
import { ENTER_A_NUMBER } from "../assumptions/setEditModel";
import { pageErrText } from "../errText";
import { tenorLabel } from "../format/tenor";
import { screenHref } from "../pageLinks";
import { problemMessages, readValue, type ShockNote } from "./behavioralShockModel";

/** One op row as typed: the node by tenor in years (null for every node except t = 0), the op kind, the value as text. */
export interface FundingOpDraft {
  key: number;
  tYears: number | null;
  op: MarketShockOpKind;
  valueText: string;
}

export interface FundingShockDraft {
  baseId: string | null;
  ops: FundingOpDraft[];
  label: string;
  id: string;
  /** The key the next added op row takes: kept through removals, so React keys follow the row. */
  nextKey: number;
}

export function emptyFundingShockDraft(): FundingShockDraft {
  return { baseId: null, ops: [], label: "", id: "", nextKey: 0 };
}

/** Another base drops the ops: their tenors belong to the old base. */
export function setFundingBase(d: FundingShockDraft, baseId: string | null): FundingShockDraft {
  return { ...d, baseId, ops: [] };
}

export function addFundingOp(d: FundingShockDraft): FundingShockDraft {
  const row: FundingOpDraft = { key: d.nextKey, tYears: null, op: "add", valueText: "" };
  return { ...d, ops: [...d.ops, row], nextKey: d.nextKey + 1 };
}

export function removeFundingOp(d: FundingShockDraft, key: number): FundingShockDraft {
  return { ...d, ops: d.ops.filter((o) => o.key !== key) };
}

export function setFundingOpField(d: FundingShockDraft, key: number, patch: Partial<Omit<FundingOpDraft, "key">>): FundingShockDraft {
  return { ...d, ops: d.ops.map((o) => (o.key === key ? { ...o, ...patch } : o)) };
}

export const FUNDING_OP_CHOICES: ReadonlyArray<{ op: MarketShockOpKind; text: string }> = [
  { op: "add", text: "Add (bp)" },
  { op: "scale", text: "Scale by" },
];

/** The part of a stored market the page reads: its TLP nodes. */
export type FundingBase = Pick<DerivedMarketSnapshot, "tlpNodes">;

/** A spread as a percent to four places. Formatting only. */
export function spreadText(v: number): string {
  return pct(v, 4);
}

export interface NodeChoice { tYears: number | null; text: string }

/** "Every node" first, then one option per stored node above zero with its stored spread. The t = 0 node is pinned and gets none. */
export function nodeChoices(base: FundingBase): NodeChoice[] {
  const nodes = base.tlpNodes.filter((n) => n.tYears > 0).map((n) => ({ tYears: n.tYears, text: `${tenorLabel(n.tYears)}, stored ${spreadText(n.spread)}` }));
  return [{ tYears: null, text: "Every node except t = 0 (pinned at 0)" }, ...nodes];
}

export type FundingShockRequest = { body: MarketDeriveRequest } | { block: string };

/** The request body the two derive routes take, or why there is none yet. target is left out for every node; id and label are trimmed and left out when empty. */
export function fundingRequestOf(d: FundingShockDraft, base: FundingBase | null): FundingShockRequest {
  if (d.baseId === null) return { block: "Pick a base market" };
  if (base === null) return { block: "Reading the base market" };
  if (d.ops.length === 0) return { block: "Add an op" };
  const ops: MarketShockOp[] = [];
  for (const row of d.ops) {
    const v = readValue(row.valueText);
    if (!("value" in v)) return { block: ENTER_A_NUMBER };
    ops.push({ ...(row.tYears === null ? {} : { target: { tYears: row.tYears } }), op: row.op, value: v.value });
  }
  const id = d.id.trim();
  const label = d.label.trim();
  return { body: { baseId: d.baseId, ops, ...(id !== "" ? { id } : {}), ...(label !== "" ? { label } : {}) } };
}

/** What the page says after a preview or a save: the same shape as the Balance shocks note. */
export function fundingSaveNoteOf(result: DerivedMarketSaveReply | unknown): ShockNote {
  if (result instanceof ApiError || result instanceof Error) {
    if (result instanceof ApiError && result.status === 409) return { kind: "conflict", text: pageErrText(result), problems: [], savedId: null };
    if (result instanceof ApiError && result.status === 422) {
      const problems = problemMessages(result.detail);
      return problems.length > 0
        ? { kind: "refused", text: "Refused: every problem is listed.", problems, savedId: null }
        : { kind: "refused", text: pageErrText(result), problems: [], savedId: null };
    }
    return { kind: "error", text: pageErrText(result), problems: [], savedId: null };
  }
  const reply = result as DerivedMarketSaveReply;
  const id = reply.id;
  return reply.outcome === "created"
    ? { kind: "created", text: `Saved as ${id}`, problems: [], savedId: id }
    : { kind: "unchanged", text: `${id} already saved with this content`, problems: [], savedId: id };
}

/** Run setups, where a setup names the saved market. */
export function planLinkFor(ws: string, query: Record<string, string>): string {
  return screenHref({ ws, section: "run", screen: "setups" }, query);
}

/** Market > Yield curves, where a saved derived market is attached to the workspace. */
export function attachLinkFor(ws: string): string {
  return screenHref({ ws, section: "market", screen: "curves" }, {});
}
/** The link text under a saved derived market on Rate indices, Funding spread shocks and Volatility shocks. */
export const ATTACH_SAVED_MARKET = "Attach it on Market > Yield curves, then name it as a run setup's Market";
