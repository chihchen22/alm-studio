/**
 * Operator-installed plugins. Loading is by an explicit path list, never a
 * directory scan: what runs on this box is a decision someone wrote down. Each
 * file is hashed before it is imported and the hash goes into the run log, so a
 * result names the exact bytes that produced it. Nothing here installs anything
 * from the network.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin, PluginCatalog } from "@alm/harness";
import { BUILTIN_CATALOG, type PluginSource } from "@alm/engine";

/**
 * Every refusal this loader raises, as one class. An operator who mistyped a
 * path, shipped a module that throws on import, or saved half a JSON file gets
 * the same typed failure naming the config and the offending entry, rather
 * than a raw SyntaxError from somewhere inside Node.
 */
export class OperatorPluginConfigError extends Error {
  readonly configPath: string;
  /** The plugins[] entry at fault, when the refusal is about one entry. */
  readonly pluginPath?: string;
  constructor(configPath: string, message: string, pluginPath?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OperatorPluginConfigError";
    this.configPath = configPath;
    if (pluginPath !== undefined) this.pluginPath = pluginPath;
  }
}

/** True for the one read failure that is not an error: the box has no plugin list. */
function isAbsent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** The one config file, relative to the repo root, that both the HTTP process and the runner child read. */
export const PLUGIN_CONFIG_RELATIVE = join("var", "plugins.json");

/** Where the box's plugin list lives, given a root. */
export function pluginConfigPath(root: string): string {
  return join(root, PLUGIN_CONFIG_RELATIVE);
}

export interface OperatorPlugins {
  catalog: PluginCatalog;
  /** Plugin id to where its code came from; every built-in maps to "builtin". */
  sources: Map<string, PluginSource>;
}

interface PluginConfig {
  plugins?: Array<{ path?: unknown }>;
}

/**
 * Read the config, hash and import each listed module, and return a catalog of
 * the built-ins plus what was loaded. A missing file, a module with no default
 * export, a default export with no id, or an id the built-ins already own is a
 * refusal naming the path: a half-loaded catalog would run a plan against a
 * profile nobody declared.
 */
export function loadOperatorPlugins(configPath: string): OperatorPlugins {
  const catalog = new Map(BUILTIN_CATALOG);
  const sources = new Map<string, PluginSource>();
  for (const id of BUILTIN_CATALOG.keys()) sources.set(id, "builtin");

  // An ABSENT config is the ordinary case: the box runs the built-ins only. A
  // config that is there but unreadable or malformed is not: swallowing it
  // would silently run a tree the operator did not ask for, which is the exact
  // failure this file exists to prevent.
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    if (isAbsent(err)) return { catalog, sources };
    throw new OperatorPluginConfigError(
      configPath,
      `${configPath}: the plugin list is there but could not be read: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      undefined,
      { cause: err },
    );
  }
  let config: PluginConfig;
  try {
    config = JSON.parse(text) as PluginConfig;
  } catch (err) {
    throw new OperatorPluginConfigError(
      configPath,
      `${configPath}: the plugin list is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      { cause: err },
    );
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new OperatorPluginConfigError(configPath, `${configPath}: expected an object with a "plugins" array`);
  }
  if (config.plugins !== undefined && !Array.isArray(config.plugins)) {
    throw new OperatorPluginConfigError(configPath, `${configPath}: "plugins" must be an array`);
  }

  // A relative entry is relative to the CONFIG, not to whatever directory the
  // process happens to have been started in: the same list must name the same
  // files from the HTTP process and from the runner child.
  const base = dirname(resolve(configPath));
  for (const entry of config.plugins ?? []) {
    if (typeof entry !== "object" || entry === null || typeof entry.path !== "string" || entry.path.length === 0) {
      throw new OperatorPluginConfigError(configPath, `${configPath}: every plugins[] entry needs a "path" string`);
    }
    const abs = isAbsolute(entry.path) ? entry.path : resolve(base, entry.path);
    let bytes: Buffer;
    try {
      bytes = readFileSync(abs);
    } catch (err) {
      throw new OperatorPluginConfigError(
        configPath,
        `${configPath}: plugin file "${entry.path}" is not readable (resolved to ${abs})`,
        entry.path,
        { cause: err },
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const plugin = importDefault(abs, entry.path, configPath);
    if (catalog.has(plugin.id)) {
      throw new OperatorPluginConfigError(
        configPath,
        `${configPath}: plugin "${plugin.id}" from "${entry.path}" collides with a plugin already in the catalog`,
        entry.path,
      );
    }
    catalog.set(plugin.id, plugin);
    sources.set(plugin.id, { path: entry.path, sha256 });
  }
  return { catalog, sources };
}

/**
 * Import the module's default export and check it looks like a plugin. Node's
 * createRequire loads an .mjs synchronously on this runtime, which the route
 * handlers need: the list is read once at registration, never per request.
 */
function importDefault(abs: string, declaredPath: string, configPath: string): Plugin<any> {
  let mod: { default?: unknown };
  try {
    const req = createRequire(pathToFileURL(abs));
    mod = req(abs) as { default?: unknown };
  } catch (err) {
    // A module that throws while it is being evaluated (a bad import of its
    // own, a top-level assertion) is the operator's plugin failing, not the
    // server failing: name the file, keep the original as the cause.
    throw new OperatorPluginConfigError(
      configPath,
      `${configPath}: plugin file "${declaredPath}" threw while loading: ` +
        `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      declaredPath,
      { cause: err },
    );
  }
  const candidate = mod.default;
  if (typeof candidate !== "object" || candidate === null) {
    throw new OperatorPluginConfigError(
      configPath,
      `${configPath}: plugin file "${declaredPath}" must default-export a Plugin object`,
      declaredPath,
    );
  }
  const plugin = candidate as Plugin<any>;
  if (typeof plugin.id !== "string" || plugin.id.length === 0 || typeof plugin.apply !== "function") {
    throw new OperatorPluginConfigError(
      configPath,
      `${configPath}: plugin file "${declaredPath}" default export needs a non-empty id and an apply function`,
      declaredPath,
    );
  }
  return plugin;
}
