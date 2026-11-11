// packages/engine/src/macro/__tests__/fence.test.ts
/**
 * The macro fence (C10).
 *
 * 1. A direct allow-list of what each macro/ module may import.
 * 2. A transitive walk: from every non-test macro/ module, follow relative
 *    imports and `@alm/kernel` (into the kernel barrel) to every reachable
 *    file. Every reachable kernel `defaults/` file must be on an explicit
 *    allow-list of public-data modules (the two generated H.15 curve grids
 *    today), and no reachable path may name a module outside it. A power
 *    assertion requires the walk to reach each allow-listed module, so the
 *    allow-list is exercised.
 * 3. The two-significant-figure rule on the seven values of the
 *    parameterization of record, restated by hand (housingRecord.ts). Slice 4
 *    extends it to the seeded sets: every seeded assumption set whose binding
 *    carries the housing group (housing-demo-v1 and housing-flat-demo-v1 today)
 *    holds exactly the seven values, each with at most two significant figures.
 *
 * Specifiers are read with ts.preProcessFile, so import, export-from,
 * side-effect and dynamic imports are all seen, and comments are not.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { WANT } from "./housingRecord";

const DIR = fileURLToPath(new URL("..", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const KERNEL_INDEX = join(ROOT, "packages/kernel/src/index.ts");
const ALLOWED = (spec: string) => spec === "@alm/kernel" || spec.startsWith("../contracts/") || spec === "../runtime/contentHash" || spec === "../runtime/canonicalize" || /^\.\/[A-Za-z]+$/.test(spec);
/** Kernel calibrated/ modules a macro module may reach: public data only, each with its reason. */
const CALIBRATED_ALLOWED: Record<string, string> = {
  "packages/kernel/src/math/behavioral/defaults/mmaEveCurvePublic.ts": "public H.15 curves, reached through the barrel's mmaTwoSleeve",
  "packages/kernel/src/math/behavioral/defaults/labCurvePublic.ts": "public H.15 curves, reached through the barrel's cdBook",
};

const specifiersOf = (file: string): string[] =>
  ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles.map((f) => f.fileName);
const macroModules = (): string[] =>
  readdirSync(DIR).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts")).map((n) => join(DIR, n));

/** The file a specifier names, or null when it is a package this walk does not follow. */
function resolveSpec(from: string, spec: string): string | null | "unresolved" {
  if (spec === "@alm/kernel") return KERNEL_INDEX;
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return "unresolved";
}

function reachable(): { files: string[]; unresolved: string[] } {
  const seen = new Set<string>(); const unresolved: string[] = [];
  const queue = macroModules();
  while (queue.length > 0) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const s of specifiersOf(f)) {
      const r = resolveSpec(f, s);
      if (r === "unresolved") unresolved.push(`${relative(ROOT, f)} -> ${s}`);
      else if (r !== null && !seen.has(r)) queue.push(r);
    }
  }
  return { files: [...seen].map((f) => relative(ROOT, f)).sort(), unresolved };
}

describe("macro fence", () => {
  it("macro/ imports only the kernel barrel, contracts, contentHash, canonicalize and itself", () => {
    // Re-expectation (mfu-1, ruling R-b): was at least 4; the unused index.ts barrel was removed, leaving macroFactors, housingMortgage and runMacro.
    expect(macroModules().length).toBeGreaterThanOrEqual(3);
    for (const f of macroModules()) {
      expect(specifiersOf(f).filter((s) => !ALLOWED(s)), f).toEqual([]);
    }
  });
  it("transitively, macro/ reaches no defaults module off the allow-list", () => {
    const { files, unresolved } = reachable();
    expect(unresolved).toEqual([]);
    expect(files).toContain("packages/kernel/src/index.ts");
    // Power: the walk reaches every allow-listed calibrated module, so the allow-list is exercised.
    expect(files).toContain("packages/kernel/src/math/behavioral/defaults/mmaEveCurvePublic.ts");
    expect(files).toContain("packages/kernel/src/math/behavioral/defaults/labCurvePublic.ts");
    expect(files.filter((f) => f.includes("/defaults/") && CALIBRATED_ALLOWED[f] === undefined)).toEqual([]);
    expect(files.filter((f) => /fitted|Pins/.test(f))).toEqual([]);
  });
  it("the seven values of record each carry at most two significant figures", () => {
    for (const v of Object.values(WANT)) expect(Number(v.toPrecision(2))).toBe(v);
  });
  it("every seeded set carrying the housing group holds the record's seven values, each with at most two significant figures", async () => {
    // The seed script by URL, so the engine's typecheck does not compile the server: planSeedDocuments is what the seed writes.
    const seed = (await import(/* @vite-ignore */ pathToFileURL(join(ROOT, "apps/server/scripts/seed-store.ts")).href)) as {
      planSeedDocuments(root: string): Promise<Array<{ collection: string; id: string; doc: { bindings: Array<{ familyId: string; overlay: { housing?: Record<string, number> } }> } }>>;
    };
    const record = WANT;
    const carriers: string[] = [];
    for (const d of (await seed.planSeedDocuments(ROOT)).filter((x) => x.collection === "assumption-sets")) {
      for (const b of d.doc.bindings) {
        const h = b.overlay.housing;
        if (h === undefined) continue;
        carriers.push(`${d.id}:${b.familyId}`);
        expect(h, `${d.id} ${b.familyId}`).toEqual(record);
        for (const v of Object.values(h)) expect(Number(v.toPrecision(2)), `${d.id} ${b.familyId}`).toBe(v);
      }
    }
    // Power: the walk reached both seeded housing sets, both families each.
    expect(carriers.sort()).toEqual(["housing-demo-v1:mbs", "housing-demo-v1:mortgages", "housing-flat-demo-v1:mbs", "housing-flat-demo-v1:mortgages"]);
  }, 300_000);
});
