// apps/studio/src/guided/book.ts
/**
 * The guided Balance sheet step's read of an imported book (S2a spec point 4): totals by side, the asset, liability and
 * equity tie check, the families by their chart-of-accounts labels, and the note when the book's date is not the
 * workspace date. Sums of the book's own notionals: an intake reading, not an engine output, and labelled so.
 *
 * Studio slice S3a-1 fix round (H1): a swap's notional (a "derivative" family) and a commitment's undrawn capacity are
 * off the balance sheet. They stay out of the asset, liability and equity sums, as the import's own statistics leave
 * them out, and are stated on a line of their own.
 */
import type { PortfolioSpec } from "@alm/engine";

export interface FamilyLine {
  familyId: string;
  label: string;
  side: string;
  instrumentType: string;
  positions: number;
  notional: number;
  /** A swap family (side "derivative") or a commitment family: off the balance sheet, in no total (S3a-1 H1). */
  offBalance: boolean;
  /** S3a-1 follow-up: a non-rate-sensitive family, held at book; in the totals, but it takes no new volume. */
  heldAtBook: boolean;
}

/** What the book holds off the balance sheet (S3a-1 H1): swap notional and undrawn committed lines, in dollars. */
export interface OffBalance {
  swapNotional: number;
  undrawn: number;
  /** One plain sentence naming both, or null when the book holds neither. */
  sentence: string | null;
}

export interface BookSummary {
  assets: number;
  liabilities: number;
  /** Equity positions the book carries, summed; 0 when it carries none. */
  equityPositions: number;
  /** Assets less liabilities less equity positions: what an equity plug holds. */
  plug: number;
  /** The book carries an equity node in its chart of accounts with no positions under it: the plug's home. */
  hasEquityNode: boolean;
  tie: { ok: boolean; sentence: string };
  /** Positions whose stated side contradicts their family's side (fix round 1, L7): the check the plug cannot hide. */
  sideMismatches: string[];
  families: FamilyLine[];
  positionCount: number;
  offBalance: OffBalance;
}

const MILLION = 1_000_000;

/** A dollar amount in millions, one decimal: display only; the exact figure is in the export. */
export function inMillions(v: number): string {
  const m = v / MILLION;
  const s = Math.abs(m).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${m < 0 ? "-" : ""}$${s} million`;
}

export function summarizeBook(book: PortfolioSpec): BookSummary {
  const families: FamilyLine[] = book.coa.families.map((f) => ({
    familyId: f.id, label: f.label, side: f.side, instrumentType: f.instrumentType, positions: 0, notional: 0,
    offBalance: f.side === "derivative" || f.instrumentType === "commitment",
    heldAtBook: f.instrumentType === "non-rate-sensitive",
  }));
  let swapNotional = 0;
  let undrawn = 0;
  const byId = new Map(families.map((f) => [f.familyId, f]));
  let assets = 0;
  let liabilities = 0;
  let equityPositions = 0;
  const sideMismatches: string[] = [];
  for (const p of book.positions) {
    const fam = byId.get(p.familyId);
    const n = (p.terms as { notional?: number }).notional ?? 0;
    const side = (p.terms as { side?: string }).side ?? fam?.side ?? "asset";
    if (fam !== undefined && (fam.side === "asset" || fam.side === "liability") && (side === "asset" || side === "liability") && side !== fam.side) sideMismatches.push(p.id);
    if (fam !== undefined) {
      fam.positions += 1;
      fam.notional += n;
    }
    // H1: off the balance sheet, so in no total.
    if (fam?.offBalance === true) {
      if (fam.side === "derivative") swapNotional += n;
      else undrawn += n;
      continue;
    }
    if (fam?.side === "equity") equityPositions += n;
    else if (side === "liability") liabilities += n;
    else assets += n;
  }
  const plug = assets - liabilities - equityPositions;
  const hasEquityNode = book.coa.nodes.some((n) => n.side === "equity");
  let tie: BookSummary["tie"];
  if (Math.abs(plug) < 0.005) tie = { ok: true, sentence: `Assets equal liabilities plus equity: ${inMillions(assets)}.` };
  else if (plug > 0 && hasEquityNode && equityPositions === 0) {
    tie = { ok: true, sentence: `Assets ${inMillions(assets)} = liabilities ${inMillions(liabilities)} + equity ${inMillions(plug)}. Equity is the plug: assets less liabilities.` };
  } else if (plug > 0) {
    tie = { ok: false, sentence: `Assets exceed liabilities and equity by ${inMillions(plug)}, and the chart of accounts has no equity node to hold it. Add an equity line or check the balances.` };
  } else {
    tie = { ok: false, sentence: `Liabilities and equity exceed assets by ${inMillions(-plug)}: equity would be negative. Check the balances and the side of each position.` };
  }
  if (sideMismatches.length > 0) {
    // A plug absorbs any difference, so a position booked on the wrong side would still "tie": name it instead.
    const one = sideMismatches.length === 1;
    const listed = `${sideMismatches.slice(0, 5).join(", ")}${sideMismatches.length > 5 ? ", and more" : ""}`;
    tie = { ok: false, sentence: `${one ? "One position is" : `${sideMismatches.length} positions are`} on the other side from ${one ? "its" : "their"} family (${listed}), so the totals by side cannot be trusted. Check the side column.` };
  }
  const parts = [swapNotional > 0 ? `swap notional ${inMillions(swapNotional)}` : null, undrawn > 0 ? `undrawn committed lines ${inMillions(undrawn)}` : null].filter((x): x is string => x !== null);
  const offBalance: OffBalance = { swapNotional, undrawn, sentence: parts.length === 0 ? null : `Off the balance sheet, and in none of these totals: ${parts.join(" and ")}.` };
  return { assets, liabilities, equityPositions, plug, hasEquityNode, tie, sideMismatches, families, positionCount: book.positions.length, offBalance };
}

/** The note when the book's as-of date is not the workspace's cut-off; null when they match. */
export function dateNote(bookAsOf: string, cutoff: string): string | null {
  if (bookAsOf === cutoff) return null;
  return `The positions are dated ${bookAsOf} and the workspace ${cutoff}. The Run step will ask you to confirm the difference before it launches. To avoid it, use positions dated ${cutoff}, or start a workspace dated ${bookAsOf}.`;
}
