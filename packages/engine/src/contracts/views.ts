/**
 * Views and cells (harness Plane 1).
 *
 * A VIEW is a reader's declared cut of the book: an ordered tuple of dimension
 * ids to group by. A CELL is the finest grain any declared view can ask about:
 * one product family, pinned to one value of each dimension any view groups on.
 * A view's group is a coarsening of the cell, and so is the family, which is why
 * one sink serves every view and no number is stored twice.
 *
 * Cells exist only where positions do: the cell set is the distinct
 * (family, tag tuple) pairs the book actually carries, never the cross-product
 * of declared values, so the memory cost tracks the book and is bounded above
 * by the position count.
 */
import type { DimensionId, DimensionValue } from "./dimensions";
import type { ProductFamilyId } from "./ids";

/** A reader's declared cut of the book. */
export interface ViewDef {
  /** Stable id, unique within a request. The pivot's handle. */
  id: string;
  label: string;
  /**
   * Dimension ids to group by, in the order a reader reads them. At least one,
   * no repeats. Each must be declared in the book's taxonomy or be one of the
   * derived ids (contracts/dimensions.ts DERIVED_DIMENSION_IDS), and none may
   * be multi-valued. groupBy ORDER is presentation only: it fixes the key order
   * in a rendered row and the sort order of groups, and never decides which
   * positions land together, because the group key is the full tuple either way.
   */
  groupBy: DimensionId[];
}

/** One product family pinned to one value of each grouping dimension. */
export interface CellRef {
  /**
   * Canonical id: `${familyId}|` plus the pinned tags as a JSON object with
   * keys sorted ascending and values JSON-quoted. A cell with no tags is
   * `${familyId}|`. A string, so it survives JSON and keys a map on the read side.
   */
  id: string;
  familyId: ProductFamilyId;
  /** The tags this cell pins. Keys sorted. Empty object when no view is declared. */
  tags: Record<DimensionId, DimensionValue>;
  /** Positions in this cell. Never zero under a general plan: a cell exists because a position is in it. */
  positionCount: number;
}

/** One group of a view: the cells whose tags project onto this key. */
export interface ViewGroup {
  key: Record<DimensionId, DimensionValue>;
  /** Ascending. */
  cellIds: string[];
  positionCount: number;
}

/**
 * One declared view's group membership on the envelope. Carries NO number: a
 * group's value is the sum of its cells' values, which the pivot computes on
 * read. Storing it as well would create two places for one number to be wrong.
 */
export interface ViewResult {
  viewId: string;
  label: string;
  groupBy: DimensionId[];
  groups: ViewGroup[];
}
