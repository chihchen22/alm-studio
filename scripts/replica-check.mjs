#!/usr/bin/env node
/**
 * `npm run replica:check`: re-run the Python replica with the interpreter named by ALM_PYTHON and
 * fail when its fresh output differs from the committed targets (replica/targets/quillfield-v1.json) by a single byte.
 *
 *   ALM_PYTHON=/path/to/python3.12 npm run replica:check
 *
 * The interpreter needs Python 3.12 and numpy (replica/requirements.txt). `npm run accept` never runs this: the core
 * accept check compares the engine with the committed targets and reads no Python. Node built-ins only.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.ALM_PYTHON;
if (python === undefined || python.trim() === "") {
  process.stdout.write("replica:check FAIL: set ALM_PYTHON to a Python 3.12 interpreter with numpy (replica/requirements.txt)\n");
  process.exit(1);
}
// -I: isolated mode, so nothing on the user site path or the working directory shadows the replica imports; -B: no bytecode files.
const r = spawnSync(python, ["-I", "-B", join(ROOT, "replica", "run.py"), "--check"], { cwd: ROOT, encoding: "utf8" });
if (r.error) {
  process.stdout.write(`replica:check FAIL: could not start ${python}: ${r.error.message}\n`);
  process.exit(1);
}
process.stdout.write(r.stdout ?? "");
process.stderr.write(r.stderr ?? "");
process.exit(r.status === 0 ? 0 : 1);
