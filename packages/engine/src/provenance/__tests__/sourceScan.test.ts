import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname, sep } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Determinism guard for the whole engine src tree, not just this module. A clock
 * read or an unseeded draw anywhere in the compute path breaks reproducibility,
 * so the presence of either forbidden token in any non-test source file is a
 * hard failure. Tests are excluded: they legitimately name the tokens (this file
 * does) and exercise error paths.
 */
const FORBIDDEN = ["Date" + ".now", "Math" + ".random"];

const here = dirname(fileURLToPath(import.meta.url));
// src/provenance/__tests__ -> packages/engine/src
const srcRoot = resolve(here, "..", "..");

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...collectSourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("engine source determinism scan", () => {
  const files = collectSourceFiles(srcRoot);

  it("finds source files to scan (the walk is not silently empty)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("contains no clock read or unseeded RNG in any non-test source file", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const token of FORBIDDEN) {
        if (text.includes(token)) {
          offenders.push(`${file.replace(srcRoot + sep, "")}: ${token}`);
        }
      }
    }
    expect(offenders, `forbidden tokens found:\n${offenders.join("\n")}`).toEqual([]);
  });
});
