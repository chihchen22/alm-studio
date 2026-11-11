#!/usr/bin/env node
/**
 * Run a script of the optional extension folder by its path inside the folder, or say plainly that the folder is
 * not present.
 *
 *   node scripts/companion-run.mjs <path-in-pack> [args...]
 *
 * The root npm scripts that run pack content keep their names and go through here. A .mjs script runs on Node; anything else runs through tsx. The exit code is the script's own,
 * or 1 when the folder is absent.
 *
 * Node built-ins only.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [rel, ...args] = process.argv.slice(2);
if (rel === undefined) {
  process.stderr.write("usage: node scripts/companion-run.mjs <path-in-pack> [args...]\n");
  process.exit(2);
}
const file = join(REPO_ROOT, "companion", rel);
if (!existsSync(file)) {
  process.stderr.write(`extension folder not present: this checkout does not hold the script this command runs (${rel}).\n`);
  process.exit(1);
}
const tsxCli = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const argv = file.endsWith(".mjs") ? [file, ...args] : [tsxCli, file, ...args];
const r = spawnSync(process.execPath, argv, { cwd: REPO_ROOT, stdio: "inherit" });
process.exit(r.status ?? 1);
