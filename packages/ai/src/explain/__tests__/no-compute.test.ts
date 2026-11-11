import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Remove comments and the literal TEXT of string and template literals, keeping
 * template `${...}` interpolation EXPRESSIONS as code. What remains is the
 * module's executable surface: if any arithmetic operator survives here, the
 * composer computes rather than reads.
 */
function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  type Mode = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  let mode: Mode = "code";
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === "code") {
      if (c === "/" && d === "/") { mode = "line"; i += 2; continue; }
      if (c === "/" && d === "*") { mode = "block"; i += 2; continue; }
      if (c === "'") { mode = "sq"; i += 1; continue; }
      if (c === '"') { mode = "dq"; i += 1; continue; }
      if (c === "`") { mode = "tpl"; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (mode === "line") { if (c === "\n") { mode = "code"; out += c; } i += 1; continue; }
    if (mode === "block") { if (c === "*" && d === "/") { mode = "code"; i += 2; } else { i += 1; } continue; }
    if (mode === "sq") { if (c === "\\") { i += 2; continue; } if (c === "'") { mode = "code"; } i += 1; continue; }
    if (mode === "dq") { if (c === "\\") { i += 2; continue; } if (c === '"') { mode = "code"; } i += 1; continue; }
    // template literal
    if (c === "\\") { i += 2; continue; }
    if (c === "`") { mode = "code"; i += 1; continue; }
    if (c === "$" && d === "{") {
      // Keep the interpolation expression; scan it like any other code.
      out += " ";
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        const e = src[i];
        if (e === "{") { depth += 1; }
        else if (e === "}") { depth -= 1; if (depth === 0) { i += 1; break; } }
        out += e; i += 1;
      }
      out += " ";
      continue;
    }
    i += 1;
  }
  return out;
}

describe("explain composer has no numeric-computation path", () => {
  const path = fileURLToPath(new URL("../compose.ts", import.meta.url));
  const code = stripCommentsAndStrings(readFileSync(path, "utf8"));

  it("uses no arithmetic operator in executable code", () => {
    expect(code).not.toMatch(/[+\-*\/%]/);
  });

  it("calls no numeric-conversion or Math routine", () => {
    expect(code).not.toMatch(/\bMath\s*\./);
    expect(code).not.toMatch(/\.toFixed\b/);
    expect(code).not.toMatch(/\.toPrecision\b/);
    expect(code).not.toMatch(/\bparseInt\b/);
    expect(code).not.toMatch(/\bparseFloat\b/);
    expect(code).not.toMatch(/\bNumber\s*\(/);
  });

  it("the stripper keeps interpolation expressions (self-check)", () => {
    const sample = stripCommentsAndStrings("const s = `x ${a - b} y`;");
    expect(sample).toContain("a - b");
  });
});
