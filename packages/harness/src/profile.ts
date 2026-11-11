/**
 * A run tree as data. Rows are mounted in order and the kernel resolves the
 * true activation order from `inject`, so a profile is a declaration of what is
 * present, never a boot list.
 *
 * composeProfile is pure: it copies the base, applies each layer's patches in
 * order, and refuses anything it cannot apply. profileHash is the identity a
 * result carries in provenance, so it hashes canonical JSON with sorted keys
 * and no dependency on how the object was built.
 */
import { createHash } from "node:crypto";
import type { Plugin } from "./context";
import { Context } from "./context";
import {
  CanonicalJsonError,
  DisposeFailedError,
  DuplicateRowError,
  InvalidPatchError,
  UnknownPluginError,
  UnknownRowError,
} from "./errors";
import type { JsonValue } from "./types";

export interface ProfileRow {
  id: string;
  plugin: string;
  config?: JsonValue;
  disabled?: boolean;
}

export interface Profile {
  rows: ProfileRow[];
}

export type Patch =
  | { set: { id: string; config: JsonValue } }
  | { disable: string }
  | { enable: string }
  | { insert: ProfileRow; after?: string };

export interface PatchLayer {
  label: string;
  patches: Patch[];
}

/** Plugin id to plugin. The engine ships BUILTIN_CATALOG; a server may extend it. */
export type PluginCatalog = ReadonlyMap<string, Plugin<any>>;

/**
 * Sorted-key JSON. Arrays keep their order; undefined-valued keys drop, as JSON
 * does. `path` is carried only to name the offending spot in a refusal.
 */
export function canonicalJson(value: unknown, path = ""): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((v, i) => canonicalJson(v, `${path}[${i}]`)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k], path === "" ? k : `${path}.${k}`)}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new CanonicalJsonError(`non-finite number ${String(value)} is not hashable`, path);
  }
  return JSON.stringify(value);
}

function copyRow(row: ProfileRow): ProfileRow {
  const out: ProfileRow = { id: row.id, plugin: row.plugin };
  if (row.config !== undefined) out.config = JSON.parse(JSON.stringify(row.config)) as JsonValue;
  if (row.disabled !== undefined) out.disabled = row.disabled;
  return out;
}

/** Apply patch layers in order over a copy of the base. Pure. */
export function composeProfile(base: Profile, layers: PatchLayer[]): Profile {
  const rows = base.rows.map(copyRow);
  const index = new Map<string, ProfileRow>();
  for (const row of rows) {
    if (index.has(row.id)) throw new DuplicateRowError(row.id);
    index.set(row.id, row);
  }
  for (const layer of layers) {
    for (const patch of layer.patches) {
      if ("set" in patch) {
        const row = index.get(patch.set.id);
        if (!row) throw new UnknownRowError(layer.label, patch.set.id);
        row.config = JSON.parse(JSON.stringify(patch.set.config)) as JsonValue;
        continue;
      }
      if ("disable" in patch) {
        const row = index.get(patch.disable);
        if (!row) throw new UnknownRowError(layer.label, patch.disable);
        row.disabled = true;
        continue;
      }
      if ("enable" in patch) {
        const row = index.get(patch.enable);
        if (!row) throw new UnknownRowError(layer.label, patch.enable);
        // The key is removed, not set false: a row disabled then enabled must
        // canonicalize back to the untouched row, because profileHash is the
        // provenance identity of a run and a round trip is not a new profile.
        delete row.disabled;
        continue;
      }
      if (!("insert" in patch)) throw new InvalidPatchError(layer.label);
      const fresh = copyRow(patch.insert);
      if (index.has(fresh.id)) throw new DuplicateRowError(fresh.id);
      if (patch.after === undefined) {
        rows.push(fresh);
      } else {
        const at = rows.findIndex((r) => r.id === patch.after);
        if (at < 0) throw new UnknownRowError(layer.label, patch.after);
        rows.splice(at + 1, 0, fresh);
      }
      index.set(fresh.id, fresh);
    }
  }
  return { rows };
}

/** SHA-256 (lowercase hex) over the canonical profile. */
export function profileHash(profile: Profile): string {
  return createHash("sha256").update(canonicalJson(profile)).digest("hex");
}

/**
 * Mount every enabled row over the catalog, in row order, then finalize. Every
 * enabled row's plugin is looked up first, so a row naming an absent plugin
 * refuses with nothing mounted; a fiber still pending at finalize refuses
 * rather than running a half-mounted tree. Any refusal unwinds whatever did
 * mount and propagates as itself, so no caller is handed a live partial tree.
 */
export function mountProfile(profile: Profile, catalog: PluginCatalog): Context {
  const enabled = profile.rows.filter((row) => row.disabled !== true);
  for (const row of enabled) {
    if (!catalog.has(row.plugin)) throw new UnknownPluginError(row.id, row.plugin);
  }
  const ctx = new Context();
  try {
    for (const row of enabled) {
      // The pre-pass proved the key is there, so the non-null assertion is the
      // lookup's own invariant rather than a guess about the catalog.
      ctx.mount(catalog.get(row.plugin)!, row.config, row.id);
    }
    ctx.finalize();
  } catch (err) {
    // The caller sees the original refusal, never a teardown's noise on top of
    // it. Anything the unwind throws that is not teardown noise does escape, as
    // it does in the context's own failure cleanup.
    try {
      ctx.dispose();
    } catch (cleanupErr) {
      if (!(cleanupErr instanceof DisposeFailedError)) throw cleanupErr;
    }
    throw err;
  }
  return ctx;
}
