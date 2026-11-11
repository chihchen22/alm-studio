/**
 * Data > Balance sheet > Hierarchies and mapping: the draft model. A hierarchy maps one authored
 * tag a book declares into a tree of named levels. Every rule that decides is the server's; the checks here are
 * convenience checks so a form never posts what it can see is wrong. Nothing here sums, scales or derives a figure.
 * toHierarchy writes the server's canonical form (key order, trimmed labels, map keys in code-unit order), so a
 * draft that equals a stored document compares equal as bytes (isStored).
 */
import { ApiError, type Hierarchy, type HierarchyApplyReply, type HierarchyLevel } from "@alm/reader";
import { reasonOf } from "../errText";

/** A hierarchy being edited. The schema version is added by toHierarchy. */
export type HierarchyDraft = Omit<Hierarchy, "schemaVersion">;

/** Ascending by UTF-16 code unit, the engine's order (never a locale order). */
function asc(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

const has = (m: Record<string, string>, k: string): boolean => Object.prototype.hasOwnProperty.call(m, k);

/** A map built from entries, so a source value named like an Object property stays plain data. */
const mapOf = (entries: Array<[string, string]>): Record<string, string> => Object.fromEntries(entries);

export function emptyDraft(dim: string): HierarchyDraft {
  return { id: "", label: "", kind: "risk", sourceDimension: dim, levels: [{ id: "level-1", label: "Level 1" }], nodes: [], map: {} };
}

export function draftFrom(h: Hierarchy | HierarchyDraft): HierarchyDraft {
  return {
    id: h.id, label: h.label, kind: h.kind, sourceDimension: h.sourceDimension,
    levels: h.levels.map((l) => ({ ...l })), nodes: h.nodes.map((n) => ({ ...n })), map: mapOf(Object.entries(h.map)),
  };
}

/** The canonical document: the server's key order, trimmed labels, empty map entries dropped, map keys sorted by code unit. */
export function toHierarchy(d: HierarchyDraft): Hierarchy {
  const entries = Object.entries(d.map).filter(([, v]) => v !== "").sort((a, b) => asc(a[0], b[0]));
  return {
    schemaVersion: "1.0.0",
    id: d.id,
    label: d.label.trim(),
    kind: d.kind,
    sourceDimension: d.sourceDimension,
    levels: d.levels.map((l) => ({ id: l.id, label: l.label.trim() })),
    nodes: d.nodes.map((n) => ({ id: n.id, parentId: n.parentId, level: n.level })),
    map: mapOf(entries),
  };
}

/** The source values with no leaf yet (an empty entry is none), in the values' own order. */
export function unmappedValues(values: string[], map: Record<string, string>): string[] {
  return values.filter((v) => !has(map, v) || map[v] === "");
}

const lastLevelId = (d: HierarchyDraft): string => d.levels[d.levels.length - 1]!.id;

/** The leaf node ids, in node order: the nodes at the last level by position. */
export function leafIds(d: HierarchyDraft): string[] {
  const last = lastLevelId(d);
  return d.nodes.filter((n) => n.level === last).map((n) => n.id);
}

/** The node ids a node at this level may name as its parent: the level before it by position; none at the first level. */
export function parentChoices(d: HierarchyDraft, level: string): string[] {
  const at = d.levels.findIndex((l) => l.id === level);
  if (at <= 0) return [];
  const above = d.levels[at - 1]!.id;
  return d.nodes.filter((n) => n.level === above && n.id !== "").map((n) => n.id);
}

export function addLevel(d: HierarchyDraft): HierarchyDraft {
  const n = d.levels.length;
  return { ...d, levels: [...d.levels, { id: `level-${n + 1}`, label: `Level ${n + 1}` }] };
}

/** Drop the last level, its nodes and the map entries to them; one level stays. */
export function removeLastLevel(d: HierarchyDraft): HierarchyDraft {
  if (d.levels.length <= 1) return d;
  const last = lastLevelId(d);
  const gone = new Set(d.nodes.filter((n) => n.level === last).map((n) => n.id));
  return {
    ...d,
    levels: d.levels.slice(0, -1),
    nodes: d.nodes.filter((n) => n.level !== last),
    map: mapOf(Object.entries(d.map).filter(([, v]) => !gone.has(v))),
  };
}

/** Rename a level's id (its nodes follow) or relabel it. */
export function editLevel(d: HierarchyDraft, index: number, patch: Partial<HierarchyLevel>): HierarchyDraft {
  const old = d.levels[index];
  if (old === undefined) return d;
  const next: HierarchyLevel = { id: patch.id ?? old.id, label: patch.label ?? old.label };
  return {
    ...d,
    levels: d.levels.map((l, i) => (i === index ? next : l)),
    nodes: next.id === old.id ? d.nodes : d.nodes.map((n) => (n.level === old.id ? { ...n, level: next.id } : n)),
  };
}

export function addNode(d: HierarchyDraft, level: string): HierarchyDraft {
  const parent = parentChoices(d, level)[0] ?? null;
  return { ...d, nodes: [...d.nodes, { id: "", parentId: parent, level }] };
}

/** Remove a node: its children lose their parent, and the map entries to it go. */
export function removeNode(d: HierarchyDraft, index: number): HierarchyDraft {
  const gone = d.nodes[index];
  if (gone === undefined) return d;
  return {
    ...d,
    nodes: d.nodes.filter((_, i) => i !== index).map((n) => (gone.id !== "" && n.parentId === gone.id ? { ...n, parentId: null } : n)),
    map: mapOf(Object.entries(d.map).filter(([, v]) => v !== gone.id)),
  };
}

/** Rename a node: its children's parent and the map values that named it follow. */
export function renameNode(d: HierarchyDraft, index: number, id: string): HierarchyDraft {
  const old = d.nodes[index];
  if (old === undefined || old.id === id) return d;
  return {
    ...d,
    nodes: d.nodes.map((n, i) => (i === index ? { ...n, id } : n.parentId === old.id ? { ...n, parentId: id } : n)),
    map: mapOf(Object.entries(d.map).map(([k, v]): [string, string] => [k, v === old.id ? id : v])),
  };
}

/** Set a node's parent; the empty string is none. */
export function setNodeParent(d: HierarchyDraft, index: number, parentId: string): HierarchyDraft {
  return { ...d, nodes: d.nodes.map((n, i) => (i === index ? { ...n, parentId: parentId === "" ? null : parentId } : n)) };
}

/** Map one source value to a leaf; the empty string unmaps it. */
export function setMapEntry(d: HierarchyDraft, value: string, nodeId: string): HierarchyDraft {
  const rest = Object.entries(d.map).filter(([k]) => k !== value);
  return { ...d, map: mapOf(nodeId === "" ? rest : [...rest, [value, nodeId]]) };
}

/** A new source tag: the tree stays, the map clears (its keys were the old tag's values). */
export function withSourceDimension(d: HierarchyDraft, dim: string): HierarchyDraft {
  return { ...d, sourceDimension: dim, map: {} };
}

const ID_RULE = /^[A-Za-z0-9_-]{1,32}$/;
/** The server's hierarchy id rule: no leading "-" and no "--", so the re-tagged book id names one book and one hierarchy. */
export function isHierarchyId(id: string): boolean {
  return ID_RULE.test(id) && !id.startsWith("-") && !id.includes("--");
}

/** What the form can see is wrong, in order. The server still decides. */
export function checkDraft(d: HierarchyDraft, values: string[]): string[] {
  const out: string[] = [];
  if (d.id === "") out.push("Give the hierarchy an id.");
  else if (!isHierarchyId(d.id)) out.push(`Hierarchy id "${d.id}" must use letters, digits, "_" and "-", at most 32 characters, must not start with "-" and must not contain "--".`);
  if (d.label.trim() === "") out.push("Give the hierarchy a label.");
  d.nodes.forEach((n, i) => { if (n.id === "") out.push(`Node ${i + 1} has no id.`); });
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const n of d.nodes) {
    if (n.id === "") continue;
    if (seen.has(n.id) && !twice.has(n.id)) { twice.add(n.id); out.push(`Node id "${n.id}" is used twice.`); }
    seen.add(n.id);
  }
  for (const l of d.levels) if (!d.nodes.some((n) => n.level === l.id)) out.push(`Add at least one node at level "${l.id}".`);
  const unmapped = unmappedValues(values, d.map);
  if (unmapped.length > 0) out.push(`Unmapped source values: ${unmapped.join(", ")}.`);
  return out;
}

/** Whether the draft is, as canonical bytes, the stored document. */
export function isStored(d: HierarchyDraft, stored: Hierarchy): boolean {
  return JSON.stringify(toHierarchy(d)) === JSON.stringify(stored);
}

/** The source tag as an id fragment: other characters become "-", runs collapse, no leading or trailing "-". */
function fragmentOf(dim: string): string {
  const s = dim.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  return s === "" ? "tag" : s;
}

/**
 * The id the next save takes. A new draft takes <tag>-hierarchy-v1 (cut to 32) when that is free; an edit of a stored
 * hierarchy takes its base plus the first free "-edit-<n>". Every result fits the server's id rule (32 characters, no
 * "--", no leading "-").
 */
export function defaultSaveId(selected: string | null, dim: string, taken: ReadonlySet<string>): string {
  const base = selected === null ? `${fragmentOf(dim)}-hierarchy-v1`.slice(0, 32) : selected.replace(/-edit-\d+$/, "");
  if (selected === null && !taken.has(base)) return base;
  for (let n = 1; ; n++) {
    const suffix = `-edit-${n}`;
    const stem = base.slice(0, 32 - suffix.length).replace(/-+$/, "");
    const id = `${stem}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

/** The tag ids a hierarchy's levels become on a re-tagged book: hierarchy id, dot, level id. */
export function tagIdsOf(hierarchyId: string, levels: HierarchyLevel[]): string[] {
  return levels.map((l) => `${hierarchyId}.${l.id}`);
}

export function saveText(outcome: "created" | "unchanged", id: string): string {
  return outcome === "created" ? `Saved ${id}` : `${id} is already stored with this content`;
}

export function applyText(r: Pick<HierarchyApplyReply, "outcome" | "id" | "tags" | "untaggedPositionIds">): string {
  const head = r.outcome === "created"
    ? `Wrote book ${r.id} with tags ${r.tags.join(", ")}. It is in the file store and, best effort, in the catalog database now, where the Book pill reads it; if that sync failed, the pill lists it after the next server start.`
    : `Book ${r.id} already holds this tagging; nothing was written.`;
  const n = r.untaggedPositionIds.length;
  if (n === 0) return head;
  const who = n === 1 ? "1 position carries" : `${n} positions carry`;
  return `${head} ${who} no value for the source tag and got no hierarchy tag; a view over the new tags will be refused until every position carries a value (P3).`;
}

/** A refused save or apply's list of problems (a 422's detail), else the one reason. */
export function problemsFrom(e: unknown): string[] {
  if (e instanceof ApiError && typeof e.detail === "object" && e.detail !== null) {
    const p = (e.detail as { problems?: unknown }).problems;
    if (Array.isArray(p) && p.length > 0 && p.every((x) => typeof x === "string")) return p as string[];
  }
  return [reasonOf(e)];
}
