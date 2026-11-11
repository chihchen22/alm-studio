/**
 * The overlay compatibility table (ALM Studio Piece 4b moved it to a
 * browser-safe contracts module so Studio's family picker can read it). The
 * table is restated here; the resolver's re-export must be the same object, so
 * the run's gate and Studio's picker read one table.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OVERLAY_INSTRUMENT_COMPATIBILITY } from "../overlayCompatibility";
import { OVERLAY_INSTRUMENT_COMPATIBILITY as FROM_RESOLVER } from "../../scenario/resolveAssumptions";

describe("OVERLAY_INSTRUMENT_COMPATIBILITY", () => {
  it("maps each built-in kind to the instrument types it drives", () => {
    expect(OVERLAY_INSTRUMENT_COMPATIBILITY).toEqual({
      prepay: ["mortgage"],
      "deposit-beta": ["nmd-b"],
      "nmd-decay": ["nmd", "nmd-b"],
      "cd-rollover": ["fixed-loan", "cd"],
      "commitment-draw": ["commitment"],
      "loan-client-rate": ["mortgage"],
    });
  });
  it("is the table the resolver enforces, not a copy", () => {
    expect(FROM_RESOLVER).toBe(OVERLAY_INSTRUMENT_COMPATIBILITY);
  });
});

/**
 * Every statement in `src` that loads a module at run time: an `import ... from`
 * or `export ... from` that is not `import type` or `export type`, a bare
 * `import "x"`, and a dynamic `import(`. In source order, trimmed. A test
 * helper (Polish 2 C3): the scan it replaces read lines starting "import " only.
 */
function valueImports(src: string): string[] {
  const found: Array<{ at: number; text: string }> = [];
  const add = (re: RegExp) => { for (const m of src.matchAll(re)) found.push({ at: m.index!, text: m[0].trim() }); };
  add(/^[ \t]*(?:import|export)(?![ \t]+type\b)[ \t]+(?:[\w$*]+(?:[ \t]+as[ \t]+[\w$]+)?(?:[ \t]*,[ \t]*)?)?(?:\{[^}]*\})?[ \t]*from[ \t]*["'][^"']+["']/gm);
  add(/^[ \t]*import[ \t]*["'][^"']+["']/gm);
  add(/\bimport[ \t]*\(/g);
  return found.sort((a, b) => a.at - b.at).map((f) => f.text);
}

describe("the browser-safe contracts modules Studio reads by path (Polish 2 C3)", () => {
  it("finds re-exports, bare and dynamic imports, and passes type-only lines over", () => {
    expect(valueImports('export { x } from "./a";\nimport type { y } from "./b";\nexport * from "./c";\nimport "./d";')).toEqual([
      'export { x } from "./a"',
      'export * from "./c"',
      'import "./d"',
    ]);
    expect(valueImports('import {\n  a,\n  b,\n} from "./e";\nexport type { Z } from "./f";\nconst m = await import("./g");')).toEqual([
      'import {\n  a,\n  b,\n} from "./e"',
      "import(",
    ]);
  });
  it.each(["../overlayCompatibility.ts", "../paramSchema.ts", "../assumptions.ts"])("%s loads no value at run time, so Studio can read it without the kernel", (file) => {
    const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    expect(src).toMatch(/^import type /m);
    expect(valueImports(src)).toEqual([]);
  });
});
