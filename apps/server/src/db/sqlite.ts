/**
 * The ONE module allowed to load `node:sqlite`.
 *
 * `node:sqlite` is a Node built-in (verified working on this machine, Node
 * v24.13.0) but still emits an ExperimentalWarning on load. Left alone, that
 * warning pollutes the stdout/stderr of every command that transitively touches
 * the DB layer (platform boot, seed, migrate, tests). The BUILD directive is to
 * handle it deliberately: we suppress EXACTLY that one warning, at load time,
 * before the module is loaded, and nothing else. Every other warning of any
 * kind still prints.
 *
 * Mechanics: `process.emitWarning` is patched with a filter that drops only
 * `ExperimentalWarning`s whose text names SQLite, then `node:sqlite` is loaded
 * via `createRequire` so the load provably happens AFTER the patch (a static
 * `import` would hoist and could evaluate the builtin first). The patch is
 * installed once per process, guarded by a global symbol.
 */
import { createRequire } from "node:module";

const MARKER = Symbol.for("alm.platform.sqliteWarningFilter");
const proc = process as NodeJS.Process & { [MARKER]?: true };

if (proc[MARKER] !== true) {
  proc[MARKER] = true;
  const original = process.emitWarning.bind(process);
  const filtered: typeof process.emitWarning = (warning, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : String(warning?.message ?? "");
    const first = rest[0];
    const type =
      warning instanceof Error
        ? warning.name
        : typeof first === "string"
          ? first
          : ((first as { type?: string } | undefined)?.type ?? "Warning");
    if (type === "ExperimentalWarning" && /sqlite/i.test(text)) return;
    (original as (w: typeof warning, ...r: unknown[]) => void)(warning, ...rest);
  };
  process.emitWarning = filtered;
}

const requireBuiltin = createRequire(import.meta.url);
const sqlite = requireBuiltin("node:sqlite") as typeof import("node:sqlite");

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSyncInstance = InstanceType<typeof sqlite.DatabaseSync>;
export type { StatementSync } from "node:sqlite";
