/**
 * The cell plan (spec Sections 2.2 and 3).
 *
 * Built ONCE per run, before any scenario is projected. It reads each position's
 * bag through dimensionsOf, the one reader piece 2a established, and only for
 * the dimensions some declared view groups on, so a book with no view pays one
 * array write per position and nothing else.
 *
 * THE IDENTITY PLAN. With no view declared, a cell IS a family: one cell per
 * DECLARED family in declared order, familyCellRange[i] === {i, i+1}, and
 * cellIndexByPosition[p] === the family index the pre-2b code looked up. Every
 * downstream fold then reduces to the code that ran before this piece, which is
 * what makes the byte identity a construction rather than an assertion.
 *
 * CELL ORDER is family-major: the family's declared COA order first, then
 * canonical id ascending. So a family's cells are a contiguous index range,
 * which is what the family roll-up folds over and what keeps the fold's order
 * fixed across runs.
 *
 * THE ADR-010 COMMITMENT ASSERTION lives here (piece 7 final fix) because this
 * is the one walk in a run that sees every position WITH its family definition,
 * once, before any scenario is projected. Both branches below assert it, so the
 * identity plan and the general plan refuse the same book. The rule and what a
 * mismapped book computes instead of throwing are in
 * `commitment/offBalanceSheet.ts`.
 */
import { assertCommitmentMapping } from "../commitment/offBalanceSheet";
import { assertSwapMapping } from "../swap/derivatives";
import type { ProductFamilyDef } from "../contracts/chartOfAccounts";
import {
  DERIVED_DIMENSION_IDS,
  type DimensionId,
  type DimensionTaxonomy,
  type DimensionValue,
} from "../contracts/dimensions";
import type { PortfolioSpec } from "../contracts/position";
import type { CellRef, ViewDef, ViewGroup, ViewResult } from "../contracts/views";
import { ViewDefinitionError } from "../run/executorErrors";
import { dimensionsOf } from "./dimensions";

/** One group of a view, keyed by cell INDEX so the fold never re-resolves an id. */
export interface CellGroup {
  key: Record<DimensionId, DimensionValue>;
  /** Indices into CellPlan.cells, ascending. */
  cellIndexes: number[];
  positionCount: number;
}

/** One declared view's membership. `label` rides here because ViewDef is not on the shelf at assembly. */
export interface ViewMembership {
  viewId: string;
  label: string;
  groupBy: DimensionId[];
  groups: CellGroup[];
}

export interface CellPlan {
  /** Family-major, canonical-id ascending. */
  cells: CellRef[];
  /** cellIndexByPosition[p] is the index into cells of positions[p]. */
  cellIndexByPosition: Int32Array;
  /** For family i in declared order, the half-open cell index range [start, end). */
  familyCellRange: { start: number; end: number }[];
  /** The union of every view's groupBy, sorted. Empty for the identity plan. */
  groupingDimensions: DimensionId[];
  /** Per view, the group membership. Order matches the request's views. */
  views: ViewMembership[];
}

/** Ascending string order, explicit: never localeCompare, whose result is locale-dependent. */
function asc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Keys sorted ascending, values JSON-quoted. A cell pins ONE value per dimension. */
export function canonicalTags(tags: Record<string, string>): string {
  const keys = Object.keys(tags).sort(asc);
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(tags[k]!)}`).join(",")}}`;
}

/** `${familyId}|` plus the canonical tags. A cell with no tags is `${familyId}|`. */
export function cellIdOf(familyId: string, tags: Record<string, string>): string {
  return `${familyId}|${canonicalTags(tags)}`;
}

const DERIVED: ReadonlySet<string> = new Set(DERIVED_DIMENSION_IDS);

/**
 * The derived ids a view may actually group on. behavioralClasses is derived
 * too and rule P2 always refuses it, so P1's message must not offer it: a
 * reader who took that offer would land on the next refusal.
 */
const GROUPABLE_DERIVED: readonly string[] = DERIVED_DIMENSION_IDS.filter(
  (d) => d !== "behavioralClasses",
);

/**
 * P1 and P2: everything decidable from the views and the taxonomy alone, with
 * no position read. Throws the first offence; a caller fixes one at a time.
 */
export function checkViewShapes(
  views: readonly ViewDef[],
  taxonomy: DimensionTaxonomy | undefined,
): void {
  const defs = new Map((taxonomy?.dimensions ?? []).map((d) => [d.id, d]));
  const seenViews = new Set<string>();
  for (const v of views) {
    // A duplicate id is refused HERE rather than at parse: the plan-less path
    // hands a RunRequest's views straight to this function and never sees the
    // parser, so this is the one gate both paths cross.
    if (seenViews.has(v.id)) {
      throw new ViewDefinitionError(
        "P1",
        v.id,
        "<none>",
        "two views in this request carry this id, so it appears twice; the pivot resolves a view " +
          "by id, so a duplicate makes that resolution ambiguous and the first one silently wins",
      );
    }
    seenViews.add(v.id);
    if (v.groupBy.length === 0) {
      throw new ViewDefinitionError("P1", v.id, "<none>", "a view must group by at least one dimension");
    }
    const seen = new Set<string>();
    for (const dim of v.groupBy) {
      if (seen.has(dim)) {
        throw new ViewDefinitionError("P1", v.id, dim, "the dimension is named twice in groupBy");
      }
      seen.add(dim);
      const def = defs.get(dim);
      if (def === undefined && !DERIVED.has(dim)) {
        throw new ViewDefinitionError(
          "P1",
          v.id,
          dim,
          "the book's taxonomy declares no such dimension, and it is not one of the groupable derived ids " +
            `(${GROUPABLE_DERIVED.join(", ")}); a misspelt tag would group the whole book into one bucket. ` +
            "The remaining derived id, behavioralClasses, is multi-valued and rule P2 refuses it.",
        );
      }
      // behavioralClasses is derived multi-valued by construction, so it is
      // refused whether or not a taxonomy declares it.
      if (dim === "behavioralClasses" || def?.multiValued === true) {
        throw new ViewDefinitionError(
          "P2",
          v.id,
          dim,
          "the dimension is multi-valued, so a position carrying two values would belong to two " +
            "groups and the sum over groups would exceed the book; an overlapping report is a " +
            "different object and this piece does not build one",
        );
      }
    }
  }
}

/** The union of every view's groupBy, de-duplicated and sorted. */
function unionGroupBy(views: readonly ViewDef[]): DimensionId[] {
  const out = new Set<DimensionId>();
  for (const v of views) for (const d of v.groupBy) out.add(d);
  return [...out].sort(asc);
}

/**
 * One position's value for a grouped dimension, as a scalar string, or
 * undefined where the bag carries none. Undefined rather than a coerced
 * "undefined" string: a missing tag is rule P3's business, and a cell id built
 * out of the word undefined is the lose-a-position failure wearing a name.
 * A list on a single-valued tag pins its first value; intake rule D4 is what
 * refuses such a book, and this function is not the intake gate.
 */
function pinned(bag: Record<string, unknown>, dim: string): string | undefined {
  const raw = bag[dim];
  const scalar = Array.isArray(raw) ? raw[0] : raw;
  return typeof scalar === "string" && scalar.length > 0 ? scalar : undefined;
}

/** What a bag actually held, for a refusal that names the thing to fix. */
function describeTagValue(v: unknown): string {
  if (v === "") return "an empty string";
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return `the string "${v}"`;
    case "number":
    case "boolean":
    case "bigint":
      return `the ${typeof v} ${String(v)}`;
    default:
      return `a value of type ${typeof v}`;
  }
}

/**
 * P3's detail. Absent is one fix and present-but-unusable is another, so the
 * refusal says which of the two it found rather than calling every case "no
 * value". pinned's test is wider than "is it there", and the message has to
 * carry the same width or it misdescribes a numeric or empty tag.
 */
function unusableTagDetail(raw: unknown): string {
  const noUnset =
    'there is no implicit "(unset)" group; a book that means unset should declare a value that says so';
  const oneString =
    "a cell pins ONE non-empty string per dimension, and intake rules D3 and D4 refuse such a book";
  if (raw === undefined) return `the position carries no value for this tag, and ${noUnset}`;
  if (Array.isArray(raw)) {
    return raw.length === 0
      ? `the position carries an empty list for this tag, and ${noUnset}`
      : `the position carries a list whose first entry is ${describeTagValue(raw[0])}, and ${oneString}`;
  }
  return `the position carries ${describeTagValue(raw)} for this tag, and ${oneString}`;
}

export function buildCellPlan(
  portfolio: PortfolioSpec,
  views: readonly ViewDef[] | undefined,
): CellPlan {
  const families = portfolio.coa.families;
  const positions = portfolio.positions;
  const famIndex = new Map<string, number>();
  for (let i = 0; i < families.length; i++) famIndex.set(families[i]!.id, i);

  const cellIndexByPosition = new Int32Array(positions.length);

  // --- The identity plan: a cell IS a family -------------------------------
  if (views === undefined || views.length === 0) {
    const cells: CellRef[] = families.map((f) => ({
      id: cellIdOf(f.id, {}),
      familyId: f.id,
      tags: {},
      positionCount: 0,
    }));
    for (let p = 0; p < positions.length; p++) {
      const pos = positions[p]!;
      const fi = famIndex.get(pos.familyId);
      if (fi === undefined) {
        throw new Error(
          `buildCellPlan: position "${pos.id}" references unknown family "${pos.familyId}"`,
        );
      }
      assertCommitmentMapping(pos, families[fi]!);
      assertSwapMapping(pos, families[fi]!);
      cellIndexByPosition[p] = fi;
      cells[fi]!.positionCount++;
    }
    return {
      cells,
      cellIndexByPosition,
      familyCellRange: families.map((_, i) => ({ start: i, end: i + 1 })),
      groupingDimensions: [],
      views: [],
    };
  }

  // --- The general plan ----------------------------------------------------
  checkViewShapes(views, portfolio.taxonomy);
  const groupingDimensions = unionGroupBy(views);
  const familyById = new Map<string, ProductFamilyDef>(families.map((f) => [f.id, f]));

  // Pass 1: one bag read per position, one cell key per position.
  interface Draft {
    id: string;
    familyId: string;
    famIdx: number;
    tags: Record<string, string>;
    positionCount: number;
  }
  const drafts = new Map<string, Draft>();
  const keyByPosition: string[] = new Array(positions.length);
  for (let p = 0; p < positions.length; p++) {
    const pos = positions[p]!;
    const family = familyById.get(pos.familyId);
    const fi = famIndex.get(pos.familyId);
    if (family === undefined || fi === undefined) {
      throw new Error(
        `buildCellPlan: position "${pos.id}" references unknown family "${pos.familyId}"`,
      );
    }
    assertCommitmentMapping(pos, family);
    assertSwapMapping(pos, family);
    const bag = dimensionsOf(pos, family, portfolio.taxonomy);
    const tags: Record<string, string> = {};
    for (const dim of groupingDimensions) {
      // P3. The only producer of a cell tag, so there is no path from a missing
      // value to a cell id: a book that means unset declares a value saying so.
      const value = pinned(bag, dim);
      if (value === undefined) {
        const view = views.find((v) => v.groupBy.includes(dim))!;
        throw new ViewDefinitionError("P3", view.id, dim, unusableTagDetail(bag[dim]), pos.id);
      }
      tags[dim] = value;
    }
    const id = cellIdOf(family.id, tags);
    keyByPosition[p] = id;
    const draft = drafts.get(id);
    if (draft === undefined) {
      drafts.set(id, { id, familyId: family.id, famIdx: fi, tags, positionCount: 1 });
    } else {
      draft.positionCount++;
    }
  }

  // Pass 2: order family-major, then canonical id ascending.
  const ordered = [...drafts.values()].sort((a, b) =>
    a.famIdx !== b.famIdx ? a.famIdx - b.famIdx : asc(a.id, b.id),
  );
  const cells: CellRef[] = ordered.map((d) => ({
    id: d.id,
    familyId: d.familyId,
    tags: d.tags,
    positionCount: d.positionCount,
  }));
  const indexById = new Map<string, number>();
  for (let c = 0; c < cells.length; c++) indexById.set(cells[c]!.id, c);
  for (let p = 0; p < positions.length; p++) cellIndexByPosition[p] = indexById.get(keyByPosition[p]!)!;

  // Pass 3: the per-family contiguous range. A family with no positions gets an
  // empty range, and the family fold then produces a zeroed series, which is
  // what an empty family's series is today.
  const familyCellRange: { start: number; end: number }[] = new Array(families.length);
  let cursor = 0;
  for (let i = 0; i < families.length; i++) {
    const start = cursor;
    while (cursor < ordered.length && ordered[cursor]!.famIdx === i) cursor++;
    familyCellRange[i] = { start, end: cursor };
  }

  // Pass 4: per view, group the cells by the projection of their tags onto the
  // view's groupBy. Groups sort by canonical group key ascending; a group's
  // cellIndexes are ascending because the cell array already is.
  const membership: ViewMembership[] = views.map((v) => {
    const byKey = new Map<string, CellGroup>();
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c]!;
      const key: Record<string, string> = {};
      for (const dim of v.groupBy) key[dim] = cell.tags[dim]!;
      const canon = canonicalTags(key);
      const group = byKey.get(canon);
      if (group === undefined) {
        byKey.set(canon, { key, cellIndexes: [c], positionCount: cell.positionCount });
      } else {
        group.cellIndexes.push(c);
        group.positionCount += cell.positionCount;
      }
    }
    const groups = [...byKey.entries()].sort((a, b) => asc(a[0], b[0])).map(([, g]) => g);
    return { viewId: v.id, label: v.label, groupBy: [...v.groupBy], groups };
  });

  // P4, the structural invariant: every position has exactly one cell index and
  // the cell counts sum to the book. It holds by construction; a failure here is
  // a defect in this function and not something a caller can fix, so it throws.
  let total = 0;
  for (const c of cells) total += c.positionCount;
  if (total !== positions.length) {
    throw new Error(
      `buildCellPlan: internal invariant P4 broken, cell position counts sum to ${total} over a book of ${positions.length}`,
    );
  }

  return { cells, cellIndexByPosition, familyCellRange, groupingDimensions, views: membership };
}

/** Project the membership onto the envelope shape: cell ids, no numbers beyond the counts. */
export function toViewResults(plan: CellPlan): ViewResult[] {
  return plan.views.map((v) => ({
    viewId: v.viewId,
    label: v.label,
    groupBy: [...v.groupBy],
    groups: v.groups.map(
      (g): ViewGroup => ({
        key: { ...g.key },
        cellIds: g.cellIndexes.map((i) => plan.cells[i]!.id),
        positionCount: g.positionCount,
      }),
    ),
  }));
}
