/**
 * The swap menu (Studio S2, ruling 2026-09-25): the catalog components of
 * the stage's kind plus any mounted plugin of that kind the catalog rows do not
 * already name, each marked "runs" or "catalog only". A component runs when it
 * is a mounted plugin id or an alias of one; nothing else is inferred.
 */
import type { PluginCatalogReply } from "@alm/reader";

export interface MenuItem {
  id: string;
  label: string;
  runs: boolean;
  pluginId: string | null;
  current: boolean;
}

export function resolvePlugin(cat: PluginCatalogReply, component: string): string | null {
  for (const m of cat.mounted) if (m.id === component || m.aliases.includes(component)) return m.id;
  return null;
}

export function componentLabel(cat: PluginCatalogReply, component: string): string {
  return cat.components.find((c) => c.id === component)?.label ?? component;
}

export function menuFor(cat: PluginCatalogReply, kind: string, current: string): MenuItem[] {
  const item = (id: string): MenuItem => {
    const pluginId = resolvePlugin(cat, id);
    return { id, label: componentLabel(cat, id), runs: pluginId !== null, pluginId, current: id === current };
  };
  const fromCatalog = cat.components.filter((c) => c.kind === kind).map((c) => c.id);
  const named = new Set(fromCatalog);
  const fromMounted = cat.mounted
    .filter((m) => m.kind === kind && !named.has(m.id) && !m.aliases.some((a) => named.has(a)))
    .map((m) => m.id);
  const ids = [...fromCatalog, ...fromMounted];
  const ordered = [current, ...ids.filter((id) => id !== current)];
  return ordered.map(item);
}
