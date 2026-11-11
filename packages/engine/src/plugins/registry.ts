/**
 * The shelf every seam registry is built from. One id maps to one value, a
 * second registration refuses, and a registration is REVERSIBLE: register
 * returns the Dispose that removes the entry, so a model plugin can push it
 * through ctx.effect and the entry unwinds with its fiber. A registry whose
 * entries outlive their fiber would make a disposed row's model still
 * resolvable and a remount of that row refuse as a duplicate.
 */
import type { Dispose } from "@alm/harness";
import { DuplicateRegistrationError, UnknownRegistrationError } from "./errors";

export interface KeyedRegistry<T> {
  /**
   * Returns the dispose that removes this entry. Idempotent, and inert once
   * superseded. `ownerPluginId` is the plugin credited in the run log for every
   * number this entry produces; omitted, the entry has no owner to name and
   * providerOf reports undefined rather than a guess.
   */
  register(id: string, value: T, ownerPluginId?: string): Dispose;
  /** Throws UnknownRegistrationError naming the seam, the id, and every live id. */
  get(id: string): T;
  /** The plugin that registered a live id, or undefined. Read by the run log. */
  providerOf(id: string): string | undefined;
  has(id: string): boolean;
  ids(): string[];
  values(): T[];
}

interface Entry<T> {
  value: T;
  owner: string | undefined;
}

export function makeKeyedRegistry<T>(seam: string): KeyedRegistry<T> {
  const byId = new Map<string, Entry<T>>();
  return {
    register(id, value, ownerPluginId) {
      if (byId.has(id)) throw new DuplicateRegistrationError(seam, id);
      const entry: Entry<T> = { value, owner: ownerPluginId };
      byId.set(id, entry);
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        // Identity, not presence, the same check Context.provide's undo makes:
        // a stale dispose must never delete the entry a later plugin put here.
        if (byId.get(id) === entry) byId.delete(id);
      };
    },
    get(id) {
      const entry = byId.get(id);
      if (entry === undefined) throw new UnknownRegistrationError(seam, id, [...byId.keys()]);
      return entry.value;
    },
    providerOf(id) { return byId.get(id)?.owner; },
    has(id) { return byId.has(id); },
    ids() { return [...byId.keys()]; },
    values() { return [...byId.values()].map((e) => e.value); },
  };
}
