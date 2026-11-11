/**
 * Attach a stored document to a workspace block (final review M1, spec v3.1 Section 3.6 first run). Pure functions:
 * the bodies POST /api/workspaces/:id/blocks takes, at the head revision the page read, and the stored choices each
 * screen offers. The server applies its own rules to every write (the clash rule, the derived-market rule, the
 * launch-slate rule); nothing here refuses anything.
 */
import type { BalancePlanListItem, MarketListItem, PortfolioListItem, ScenarioSlate, SetBlockBody, WorkspaceManifest } from "@alm/reader";
import { plural } from "../rows/plural";

export interface StoredOption {
  id: string;
  label: string;
}

/**
 * Why a block write cannot be made on this workspace, in words; null when it can. Mirrors the server's write refusal.
 * `change` names what the control changes, as "its routing policy" or "its position book".
 */
export function writeBlock(head: WorkspaceManifest, change: string): string | null {
  if (head.status === "locked" || head.lock !== null) return `This workspace is locked by its sign-off. Clone it to change ${change}.`;
  if (head.status === "archived") return "This workspace is archived and read-only.";
  if (head.status === "superseded") return "This workspace was superseded and is read-only.";
  return null;
}

/** Balance Sheet > Positions: set the workspace's position book from a stored one. */
export function positionsSetBody(head: WorkspaceManifest, id: string, by: string): SetBlockBody {
  return { expectedRevision: head.revision, by, block: "positions", op: "set", ref: { collection: "portfolios", id } };
}

/** Market > Yield curves: set the workspace's base snapshot. */
export function marketSetBody(head: WorkspaceManifest, id: string, by: string): SetBlockBody {
  return { expectedRevision: head.revision, by, block: "market", op: "set", ref: { collection: "market", id } };
}

/** Balance Sheet > Strategy: add a stored balance plan to the targets block. */
export function targetsAddBody(head: WorkspaceManifest, id: string, by: string): SetBlockBody {
  return { expectedRevision: head.revision, by, block: "targets", op: "add", ref: { collection: "plans", id } };
}

/** Run > Scenario library: add a stored slate to the scenarios block. */
export function slateAddBody(head: WorkspaceManifest, id: string, by: string): SetBlockBody {
  return { expectedRevision: head.revision, by, block: "scenarios", op: "add", ref: { collection: "scenario-slates", id } };
}

/** The write that follows a plan saved on Strategy: the targets add, or the sentence saying why none is sent (no typed name). */
export function planSavedWrite(head: WorkspaceManifest, id: string, by: string): SetBlockBody | string {
  if (by.trim() === "") return `Saved ${id} in the store. Type your name and attach it below to add it to this workspace.`;
  return targetsAddBody(head, id, by.trim());
}

/** The base snapshots of GET /api/market: a derived market is never a base, so it is left out. */
export function baseSnapshotOptions(list: MarketListItem[]): StoredOption[] {
  return list
    .filter((m) => m.derivedFromMarketId === undefined)
    .map((m) => ({ id: m.id, label: m.label !== undefined && m.label !== "" ? (m.calibrationDate !== undefined ? `${m.label} (${m.calibrationDate})` : m.label) : m.calibrationDate ?? m.id }));
}

/** Market > Yield curves: add a stored derived market to the market block. */
export function marketAddBody(head: WorkspaceManifest, id: string, by: string): SetBlockBody {
  return { expectedRevision: head.revision, by, block: "market", op: "add", ref: { collection: "market", id } };
}

/**
 * The stored derived markets the market block can take: derived from the block's base snapshot or from a derived
 * market the block already holds (the server's parent rule, rules.ts:354-367), and not already held. None while the
 * block has no snapshot, which the server would refuse.
 */
export function derivedMarketOptions(list: MarketListItem[], head: WorkspaceManifest): StoredOption[] {
  const m = head.blocks.market;
  if (m.snapshot === null) return [];
  const bases = new Set<string>([m.snapshot.id, ...m.derived.map((d) => d.id)]);
  const held = new Set<string>(m.derived.map((d) => d.id));
  return list
    .filter((x) => x.derivedFromMarketId !== undefined && bases.has(x.derivedFromMarketId) && !held.has(x.id))
    .map((x) => ({ id: x.id, label: x.label ?? "" }));
}

/**
 * The stored books a position book can be set from. A retagged copy (an id holding `--`) is added on its own path
 * and the server refuses it as the book, so it is left out.
 */
export function bookOptions(list: PortfolioListItem[]): StoredOption[] {
  return list
    .filter((b) => !b.id.includes("--"))
    .map((b) => ({ id: b.id, label: `${b.id} (${b.asOf}, ${plural(b.positionCount, "position", "positions")})` }));
}

/** The stored balance plans, labelled as the store lists them. */
export function balancePlanOptions(list: BalancePlanListItem[]): StoredOption[] {
  return list.map((p) => ({ id: p.id, label: p.asOf !== "" ? `${p.label} (${p.asOf})` : p.label }));
}

/**
 * The analyst's slates: a plan run's launch slate (the server writes it as id `plan-<planId>`, label `Scenarios of
 * plan <planId>`, and refuses it in a scenarios block) is left out.
 */
export function authoredSlateOptions(slates: ScenarioSlate[]): StoredOption[] {
  const launch = (s: ScenarioSlate): boolean => s.id.startsWith("plan-") && s.label === `Scenarios of plan ${s.id.slice("plan-".length)}`;
  return slates.filter((s) => !launch(s)).map((s) => ({ id: s.id, label: s.label }));
}
