// packages/engine/src/macro/__tests__/macroBlockDifferential.test.ts
/** A8: a market's macroFactors block, well formed or not, moves no result block of an unmapped run; and an allow-list of readers. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { buildDemoPortfolio, buildDemoRequest } from "../../../../../data/src/demo/request";
import { buildRunResult } from "../../run/orchestrate";
import { resolveDefaultContext } from "../../run/engine";
import { loadMarket } from "../../run/__tests__/fixtures";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..", "..");
let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });

const strip = (r: Record<string, unknown>) => { const { provenance: _p, ...rest } = r; return JSON.stringify(rest); };

describe("A8 differential", () => {
  it("with, without and with a malformed block give identical result blocks; only inputsHash differs", async () => {
    const good = { ...market, macroFactors: [{ id: "hpi-flat", label: "x", kind: "index", role: "projection", unit: "r", firstMonth: "2026-04", values: new Array(360).fill(1), source: { authored: true, note: "n" } }] };
    const bad = { ...market, macroFactors: "not a list" };
    const portfolio = buildDemoPortfolio();
    const TS = { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" }; // the fixtures.ts timestamps shape
    const run = (m: unknown) => buildRunResult(buildDemoRequest(portfolio, m as MarketSnapshot, TS as never), portfolio, resolveDefaultContext()) as unknown as Record<string, unknown> & { provenance: { inputsHash: string } };
    const [a, b, c] = [run(market), run(good), run(bad)];
    expect(strip(b)).toBe(strip(a));
    expect(strip(c)).toBe(strip(a));
    expect(b.provenance.inputsHash).not.toBe(a.provenance.inputsHash);
  }, 300_000);
});

/**
 * The code of a source text for the allow-list count. Import and re-export lines name the contract module by
 * path, and comments name things without reading them, so neither counts: an allow-listed file is held by code.
 * A comment opener only counts at a line start or after whitespace, so a URL or a glob inside a string is kept.
 */
export function body(src: string): string {
  return src
    .replace(/(^|\s)(\/\*[\s\S]*?\*\/|\/\/[^\n]*)/g, "$1")
    .split("\n").filter((l) => !/^\s*(import|export)\b.*\bfrom\s+"/.test(l)).join("\n");
}
describe("A8 allow-list body()", () => {
  it("drops line comments, block comments, import lines and re-export lines, and keeps code and strings", () => {
    const src = [
      'import { x } from "../macroFactors";',
      'export { y } from "./macroFactors";',
      "// macroFactors in a line comment",
      "/** macroFactors in a",
      " * doc comment */",
      "const a = 1; // trailing macroFactors comment",
      "/* block macroFactors */ const b = 2;",
      'const url = "http://example.test/macroFactors";',
      'const glob = "src/**/macroFactors/*.ts";',
      "const c = m.macroFactors;",
    ].join("\n");
    const out = body(src);
    expect(out).toContain("const c = m.macroFactors;");
    expect(out).toContain('"http://example.test/macroFactors"');
    expect(out).toContain('"src/**/macroFactors/*.ts"');
    expect(out).toContain("const a = 1;");
    expect(out).toContain("const b = 2;");
    expect(out.split("macroFactors").length - 1).toBe(3);
    expect(body("// only macroFactors in a comment\n/** and macroFactors here */").includes("macroFactors")).toBe(false);
  });
});

// Exactly the files that name the block today (trimmed 2026-10-09, mfu-2; comments do not count, mfu2-c): a path listed here with no hit would let a future reader pass.
const ALLOWED = new Set([
  "packages/engine/src/contracts/macroFactors.ts",
  "packages/engine/src/macro/macroFactors.ts", "packages/engine/src/macro/runMacro.ts",
  "packages/engine/src/market/deriveMarketSnapshot.ts",
  "apps/studio/src/pages/market/MacroFactorsPage.tsx",
]);
function walk(dir: string, out: string[]): void {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "dist" || n === "__tests__" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx|mts|mjs)$/.test(n)) out.push(p);
  }
}
describe("A8 allow-list", () => {
  it("macroFactors is named only by the contract, validator, derive, resolver and Studio layer, and every allow-listed file names it", () => {
    // All three workspaces: packages/, apps/ and data/ (the run-request builders live in data/).
    const files: string[] = []; walk(join(ROOT, "packages"), files); walk(join(ROOT, "apps"), files); walk(join(ROOT, "data"), files);
    // Power: the walk reached a known source file in each workspace, so a silent skip fails.
    const seen = new Set(files.map((f) => relative(ROOT, f)));
    for (const known of ["data/src/demo/request.ts", "apps/server/scripts/seed-store.ts", "packages/engine/src/market/deriveMarketSnapshot.ts"]) expect(seen.has(known), known).toBe(true);
    const hits = files.filter((f) => body(readFileSync(f, "utf8")).includes("macroFactors")).map((f) => relative(ROOT, f));
    expect(hits.filter((h) => !ALLOWED.has(h))).toEqual([]);
    // Power: every allow-listed file is a hit, so the list carries no slack a new reader could hide behind.
    expect([...ALLOWED].filter((a) => !hits.includes(a))).toEqual([]);
  });
});
