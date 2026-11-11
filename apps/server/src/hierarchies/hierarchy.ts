/**
 * Hierarchy documents (tag route): the contract and the pure rules.
 *
 * A hierarchy maps ONE authored, single-valued tag that a book's taxonomy
 * declares into a tree of named levels. Applying it writes a NEW
 * book whose positions carry one extra tag per level. This module is pure: it
 * parses, validates, checks a hierarchy against a book, and builds the
 * re-tagged book spec. It reads no store, sums no balance and moves no number.
 *
 * Sort order, pinned for every sort here: ascending by UTF-16 code unit
 * (`asc` below). The platform never sorts these strings by locale.
 *
 * Canonical stored form: keys in the order schemaVersion, id, label, kind,
 * sourceDimension, levels, nodes, map; labels trimmed; map keys sorted by asc.
 * A re-save therefore compares canonical bytes, so neither an author's key
 * order nor padding around a label can cause a false conflict.
 *
 * Ids: a hierarchy id has no dot, so `<hierarchy>.<level>` splits at its one
 * dot; it never starts with a hyphen and never holds two in a row, so the last
 * double hyphen in `<book>--<hierarchy>` is always the separator and the
 * re-tagged book id names exactly one (book, hierarchy) pair.
 */
import type { DimensionDef, DimensionTaxonomy, PortfolioSpec, Position } from "@alm/engine";
import { DERIVED_DIMENSION_IDS } from "@alm/engine/src/contracts/dimensions";
import { ID_PATTERN } from "../store/paths";
import { unprocessable } from "../http/errors";

export const HIERARCHY_SCHEMA_VERSION = "1.0.0";
export const HIERARCHY_KINDS = ["risk", "liquidity", "regulatory"] as const;
export type HierarchyKind = (typeof HIERARCHY_KINDS)[number];

export interface HierarchyLevel {
  id: string;
  label: string;
}

export interface HierarchyNode {
  id: string;
  parentId: string | null;
  level: string;
}

export interface Hierarchy {
  schemaVersion: string;
  id: string;
  label: string;
  kind: HierarchyKind;
  sourceDimension: string;
  levels: HierarchyLevel[];
  nodes: HierarchyNode[];
  /** Source value to leaf node id. */
  map: Record<string, string>;
}

/** Code-unit order: a < b ? -1 : a > b ? 1 : 0. The engine's own comparator, restated. */
function asc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const TOP_KEYS = ["schemaVersion", "id", "label", "kind", "sourceDimension", "levels", "nodes", "map"] as const;
const HIERARCHY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const LEVEL_ID_PATTERN = HIERARCHY_ID_PATTERN;
const MAX_LEVELS = 6;
const MAX_NODES = 200;
const MAX_LABEL = 120;
const MAX_LEVEL_LABEL = 80;

/** A hierarchy id: 1 to 32 of letters, digits, underscore, hyphen; no leading hyphen; no double hyphen. */
export function isHierarchyId(s: string): boolean {
  return typeof s === "string" && HIERARCHY_ID_PATTERN.test(s) && !s.startsWith("-") && !s.includes("--");
}

function json(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? "undefined" : s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOnlyKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const k of Object.keys(o)) if (!keys.includes(k)) return false;
  return true;
}

/**
 * Parse an untrusted hierarchy into its canonical form, or throw a 422
 * validation error naming the first shape problem. Shape only: the tree rules
 * live in validateHierarchy, which reports every problem.
 */
export function parseHierarchy(raw: unknown): Hierarchy {
  if (!isPlainObject(raw)) throw unprocessable("hierarchy must be an object");
  for (const k of Object.keys(raw)) {
    if (!(TOP_KEYS as readonly string[]).includes(k)) {
      throw unprocessable(`hierarchy has unknown field ${json(k)}; the fields are ${TOP_KEYS.join(", ")}`);
    }
  }
  if (raw.schemaVersion !== HIERARCHY_SCHEMA_VERSION) {
    throw unprocessable(`hierarchy schemaVersion must be "${HIERARCHY_SCHEMA_VERSION}"; got ${json(raw.schemaVersion)}`);
  }
  const id = raw.id;
  if (typeof id !== "string" || !isHierarchyId(id)) {
    throw unprocessable(
      'hierarchy id must match /^[A-Za-z0-9_-]{1,32}$/, must not start with "-" and must not contain "--" ' +
        `(it becomes part of tag ids and of the re-tagged book id <book>--<hierarchy>); got ${json(id)}`,
    );
  }
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (typeof raw.label !== "string" || label.length < 1 || label.length > MAX_LABEL) {
    throw unprocessable(`hierarchy label must be a string of 1 to ${MAX_LABEL} characters after trimming`);
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !(HIERARCHY_KINDS as readonly string[]).includes(kind)) {
    throw unprocessable(
      `hierarchy kind must be one of ${HIERARCHY_KINDS.join(", ")}; got ${json(kind)} ` +
        "(capital, ledger and planning hierarchies are not built)",
    );
  }
  const sourceDimension = raw.sourceDimension;
  if (typeof sourceDimension !== "string" || sourceDimension.length === 0) {
    throw unprocessable("hierarchy sourceDimension must be a non-empty string");
  }

  const rawLevels = raw.levels;
  if (!Array.isArray(rawLevels) || rawLevels.length < 1 || rawLevels.length > MAX_LEVELS) {
    throw unprocessable(`hierarchy levels must be a list of 1 to ${MAX_LEVELS} { id, label } entries`);
  }
  const levels: HierarchyLevel[] = [];
  for (let i = 0; i < rawLevels.length; i++) {
    const l: unknown = rawLevels[i];
    const lLabel = isPlainObject(l) && typeof l.label === "string" ? l.label.trim() : "";
    if (
      !isPlainObject(l) ||
      !hasOnlyKeys(l, ["id", "label"]) ||
      typeof l.id !== "string" ||
      !LEVEL_ID_PATTERN.test(l.id) ||
      lLabel.length < 1 ||
      lLabel.length > MAX_LEVEL_LABEL
    ) {
      throw unprocessable(
        `level ${i} must be { id, label }: an id matching ${String(LEVEL_ID_PATTERN)} ` +
          `and a label of 1 to ${MAX_LEVEL_LABEL} characters after trimming`,
      );
    }
    levels.push({ id: l.id, label: lLabel });
  }

  const rawNodes = raw.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length < 1 || rawNodes.length > MAX_NODES) {
    throw unprocessable(`hierarchy nodes must be a list of 1 to ${MAX_NODES} { id, parentId, level } entries`);
  }
  const nodes: HierarchyNode[] = [];
  for (let i = 0; i < rawNodes.length; i++) {
    const n: unknown = rawNodes[i];
    if (
      !isPlainObject(n) ||
      !hasOnlyKeys(n, ["id", "parentId", "level"]) ||
      typeof n.id !== "string" ||
      !ID_PATTERN.test(n.id) ||
      !(n.parentId === null || (typeof n.parentId === "string" && ID_PATTERN.test(n.parentId))) ||
      typeof n.level !== "string"
    ) {
      throw unprocessable(
        `node ${i} must be { id, parentId, level }: an id matching ${String(ID_PATTERN)}, ` +
          "parentId a node id or null, level a level id string",
      );
    }
    nodes.push({ id: n.id, parentId: n.parentId as string | null, level: n.level });
  }

  const rawMap = raw.map;
  if (!isPlainObject(rawMap)) {
    throw unprocessable("hierarchy map must be an object of source value to leaf node id");
  }
  const entries: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(rawMap)) {
    if (k.length === 0 || typeof v !== "string") {
      throw unprocessable(`map key ${json(k)} must be a non-empty string naming a node id string`);
    }
    entries.push([k, v]);
  }
  entries.sort((a, b) => asc(a[0], b[0]));
  // fromEntries defines own properties, so a source value named __proto__ stays data.
  const map: Record<string, string> = Object.fromEntries(entries);

  return {
    schemaVersion: HIERARCHY_SCHEMA_VERSION,
    id,
    label,
    kind: kind as HierarchyKind,
    sourceDimension,
    levels,
    nodes,
    map,
  };
}

/** The tag a level writes on a position: `<hierarchyId>.<levelId>`. */
export function tagId(hierarchyId: string, levelId: string): string {
  return `${hierarchyId}.${levelId}`;
}

/** The id of the book that applying a hierarchy writes: `<bookId>--<hierarchyId>`. */
export function retaggedBookId(bookId: string, hierarchyId: string): string {
  return `${bookId}--${hierarchyId}`;
}

/**
 * Every structural problem of a parsed hierarchy, rule by rule (R1 to R13);
 * each rule lists all its problems before the next runs. Level positions are
 * by array position: FIRST is levels[0].id and LAST is levels[levels.length - 1].id,
 * compared by id. A level's index is its first declaration's. Rules R3 to R9
 * walk the first declaration of each node id only, and every lookup by node id
 * resolves to that first declaration.
 */
export function validateHierarchy(h: Hierarchy): string[] {
  const out: string[] = [];
  const first = h.levels[0]?.id;
  const last = h.levels[h.levels.length - 1]?.id;

  // Level index by first declaration; unique level ids in first-declaration order.
  const levelIndex = new Map<string, number>();
  const uniqueLevels: string[] = [];
  for (let i = 0; i < h.levels.length; i++) {
    const lid = h.levels[i]!.id;
    if (levelIndex.has(lid)) continue;
    levelIndex.set(lid, i);
    uniqueLevels.push(lid);
  }
  // First declaration of each node id, in node order.
  const firstNode = new Map<string, HierarchyNode>();
  const firstNodes: HierarchyNode[] = [];
  for (const n of h.nodes) {
    if (firstNode.has(n.id)) continue;
    firstNode.set(n.id, n);
    firstNodes.push(n);
  }
  const levelKnown = (lid: string): boolean => levelIndex.has(lid);

  // R1: a level id declared twice, reported at its second declaration.
  const seenLevels = new Set<string>();
  for (const l of h.levels) {
    if (seenLevels.has(l.id)) out.push(`level "${l.id}" is declared twice`);
    seenLevels.add(l.id);
  }
  // R2: a node id declared twice, reported at its second declaration.
  const seenNodes = new Set<string>();
  for (const n of h.nodes) {
    if (seenNodes.has(n.id)) out.push(`node "${n.id}" is declared twice`);
    seenNodes.add(n.id);
  }
  // R3: a node names a level that is not declared.
  for (const n of firstNodes) {
    if (!levelKnown(n.level)) out.push(`node "${n.id}" names level "${n.level}", which is not declared`);
  }
  // R4: a node names a parent that is not a node.
  for (const n of firstNodes) {
    if (n.parentId !== null && !firstNode.has(n.parentId)) {
      out.push(`node "${n.id}" names parent "${n.parentId}", which is not a node`);
    }
  }
  // R5: a node in or under a parent cycle. The walk stops at null or at a missing parent.
  for (const n of firstNodes) {
    const visited = new Set<string>([n.id]);
    let cur: HierarchyNode = n;
    let cyclic = false;
    for (;;) {
      if (cur.parentId === null) break;
      const next = firstNode.get(cur.parentId);
      if (next === undefined) break;
      if (visited.has(next.id)) {
        cyclic = true;
        break;
      }
      visited.add(next.id);
      cur = next;
    }
    if (cyclic) out.push(`node "${n.id}" is in or under a parent cycle`);
  }
  // R6: a root must be at the first level.
  for (const n of firstNodes) {
    if (n.parentId !== null || !levelKnown(n.level)) continue;
    if (n.level !== first) {
      out.push(
        `node "${n.id}" has no parent, so it must be at the first level "${first}"; it is at "${n.level}"`,
      );
    }
  }
  // R7: a child sits one level below its parent, compared by first-declaration index.
  for (const n of firstNodes) {
    if (n.parentId === null || !levelKnown(n.level)) continue;
    const parent = firstNode.get(n.parentId);
    if (parent === undefined || !levelKnown(parent.level)) continue;
    if (levelIndex.get(n.level)! !== levelIndex.get(parent.level)! + 1) {
      out.push(
        `node "${n.id}" is at level "${n.level}" but its parent "${parent.id}" is at "${parent.level}"; ` +
          "a child sits one level below its parent",
      );
    }
  }
  // R8: every node above the last level needs a child (any first-declared node naming it as parent).
  const parentIds = new Set<string>();
  for (const n of firstNodes) if (n.parentId !== null) parentIds.add(n.parentId);
  for (const n of firstNodes) {
    if (!levelKnown(n.level) || n.level === last) continue;
    if (!parentIds.has(n.id)) {
      out.push(
        `node "${n.id}" at level "${n.level}" has no child; every node above the last level "${last}" needs at least one`,
      );
    }
  }
  // R9: every level holds a node. Unique level ids, in first-declaration order.
  const levelsWithNodes = new Set<string>();
  for (const n of firstNodes) levelsWithNodes.add(n.level);
  for (const lid of uniqueLevels) {
    if (!levelsWithNodes.has(lid)) out.push(`level "${lid}" holds no node`);
  }
  // R10: the map is not empty.
  const mapKeys = Object.keys(h.map).sort(asc);
  if (mapKeys.length === 0) out.push("the map is empty; map at least one source value to a leaf");
  // R11: a map value names a node.
  for (const k of mapKeys) {
    const target = h.map[k]!;
    if (!firstNode.has(target)) out.push(`map value "${k}" names "${target}", which is not a node`);
  }
  // R12: a map value names a leaf, a node at the last level.
  for (const k of mapKeys) {
    const target = firstNode.get(h.map[k]!);
    if (target === undefined || !levelKnown(target.level)) continue;
    if (target.level !== last) {
      out.push(
        `map value "${k}" names "${target.id}", which is at level "${target.level}", ` +
          `not the last level "${last}"; a value maps to a leaf`,
      );
    }
  }
  // R13: a derived id is not an authored tag.
  if ((DERIVED_DIMENSION_IDS as readonly string[]).includes(h.sourceDimension)) {
    out.push(
      `sourceDimension "${h.sourceDimension}" is derived by the engine and is not an authored tag; ` +
        "a hierarchy maps a tag the book declares",
    );
  }
  return out;
}

// --- Against a book ---------------------------------------------------------

export interface SourceDimension {
  id: string;
  label: string;
  eligible: boolean;
  reason: string | null;
  values: string[];
  carried: boolean;
}

export interface HierarchySources {
  bookId: string;
  taxonomyId: string | null;
  dimensions: SourceDimension[];
}

const REASON_DERIVED = "derived from the family by the engine, not an authored tag";
const REASON_MULTI = "multi-valued: a position can carry several values, so it would land on several leaves";

/** The values a book's positions carry for one tag, as strings, in position order. */
function carriedValues(book: PortfolioSpec, dimId: string): { any: boolean; values: string[] } {
  let any = false;
  const values: string[] = [];
  for (const p of book.positions) {
    const bag = p.dimensions;
    if (bag === undefined || !Object.prototype.hasOwnProperty.call(bag, dimId)) continue;
    any = true;
    const v = bag[dimId];
    for (const one of Array.isArray(v) ? v : [v]) if (typeof one === "string") values.push(one);
  }
  return { any, values };
}

/**
 * The tags a book offers as a hierarchy source, one entry per declared
 * dimension in declared order. A closed tag lists its declared values (so the
 * hierarchy fits any later book on the same taxonomy); an open tag lists the
 * values the positions carry, in code-unit order. A derived id or a
 * multi-valued tag is ineligible, with its reason.
 */
export function sourceDimensionsOf(book: PortfolioSpec): HierarchySources {
  const tax = book.taxonomy;
  if (tax === undefined) return { bookId: book.id, taxonomyId: null, dimensions: [] };
  const dimensions: SourceDimension[] = [];
  for (const def of tax.dimensions) {
    const carried = carriedValues(book, def.id);
    const values =
      def.values !== undefined ? [...def.values] : [...new Set(carried.values)].sort(asc);
    let eligible = true;
    let reason: string | null = null;
    if ((DERIVED_DIMENSION_IDS as readonly string[]).includes(def.id)) {
      eligible = false;
      reason = REASON_DERIVED;
    } else if (def.multiValued === true) {
      eligible = false;
      reason = REASON_MULTI;
    }
    dimensions.push({ id: def.id, label: def.label, eligible, reason, values, carried: carried.any });
  }
  return { bookId: book.id, taxonomyId: tax.id, dimensions };
}

export interface BookCheck {
  problems: string[];
  unmapped: string[];
}

/**
 * Whether a structurally valid hierarchy fits a book: the book declares the
 * source tag, it is single-valued, and the map is total over the tag's values.
 * The three book-level refusals short-circuit; coverage is computed only after.
 */
export function checkAgainstBook(h: Hierarchy, book: PortfolioSpec): BookCheck {
  const tax = book.taxonomy;
  if (tax === undefined) {
    return {
      problems: [
        `book "${book.id}" declares no taxonomy, so it carries no authored tag for hierarchy "${h.id}" to map`,
      ],
      unmapped: [],
    };
  }
  const def: DimensionDef | undefined = tax.dimensions.find((d) => d.id === h.sourceDimension);
  if (def === undefined) {
    const tags = tax.dimensions.length === 0 ? "none" : tax.dimensions.map((d) => d.id).join(", ");
    return {
      problems: [`book "${book.id}" does not declare tag "${h.sourceDimension}"; its tags are ${tags}`],
      unmapped: [],
    };
  }
  if (def.multiValued === true) {
    return {
      problems: [
        `tag "${def.id}" on book "${book.id}" is multi-valued; a hierarchy maps a single-valued tag, ` +
          "so each position lands on exactly one leaf",
      ],
      unmapped: [],
    };
  }
  const source = sourceDimensionsOf(book).dimensions.find((d) => d.id === def.id)!;
  const unmapped = source.values.filter((v) => !Object.prototype.hasOwnProperty.call(h.map, v));
  const problems: string[] = [];
  if (unmapped.length > 0) {
    problems.push(
      `${unmapped.length} value(s) of tag "${def.id}" on book "${book.id}" map to no leaf: ${unmapped.join(", ")}`,
    );
  }
  if (def.values !== undefined) {
    for (const k of Object.keys(h.map).sort(asc)) {
      if (!def.values.includes(k)) {
        problems.push(
          `map key "${k}" is not a value of tag "${def.id}" on book "${book.id}" (values: ${def.values.join(", ")})`,
        );
      }
    }
  }
  return { problems, unmapped };
}

// --- Re-tagging -------------------------------------------------------------

/**
 * The book that applying a hierarchy writes. Tags only: each position that
 * carries the source tag gets one extra tag per level, naming its ancestor at
 * that level; every other position is returned as the same object. Terms,
 * family and chart-of-accounts node are never touched, and nothing is summed.
 * Run checkAgainstBook and validateHierarchy first; this assumes a valid pair.
 */
export function retagBook(h: Hierarchy, book: PortfolioSpec): PortfolioSpec {
  const tax = book.taxonomy;
  if (tax === undefined) {
    throw new Error(`book "${book.id}" declares no taxonomy, so hierarchy "${h.id}" has no tag to map`);
  }
  const firstNode = new Map<string, HierarchyNode>();
  for (const n of h.nodes) if (!firstNode.has(n.id)) firstNode.set(n.id, n);

  const levelDefs: DimensionDef[] = h.levels.map((level) => ({
    id: tagId(h.id, level.id),
    label: `${h.label}: ${level.label}`,
    values: h.nodes.filter((n) => n.level === level.id).map((n) => n.id),
  }));
  const taxonomy: DimensionTaxonomy = {
    schemaVersion: tax.schemaVersion,
    id: `${tax.id}--${h.id}`,
    label: `${tax.label}; plus hierarchy ${h.id}`,
    dimensions: [...tax.dimensions, ...levelDefs],
  };

  const positions: Position[] = book.positions.map((p) => {
    const value = p.dimensions?.[h.sourceDimension];
    if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(h.map, value)) return p;
    // Ancestor at each level: walk from the mapped leaf to the root.
    const atLevel = new Map<string, string>();
    const visited = new Set<string>();
    let cur = firstNode.get(h.map[value]!);
    while (cur !== undefined && !visited.has(cur.id)) {
      visited.add(cur.id);
      if (!atLevel.has(cur.level)) atLevel.set(cur.level, cur.id);
      cur = cur.parentId === null ? undefined : firstNode.get(cur.parentId);
    }
    const bag: Record<string, string | string[]> = { ...p.dimensions };
    for (const level of h.levels) {
      const node = atLevel.get(level.id);
      if (node !== undefined) bag[tagId(h.id, level.id)] = node;
    }
    return { ...p, dimensions: bag };
  });

  return {
    ...book,
    id: retaggedBookId(book.id, h.id),
    label: `${book.label}; tagged by hierarchy ${h.id}`,
    taxonomy,
    positions,
  };
}
