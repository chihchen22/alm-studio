// packages/engine/src/macro/__tests__/callSites.test.ts  (F1, C5, A7)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..", "..");
function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) { const p = join(dir, n);
    if (n === "__tests__" || n === "node_modules") continue;
    if (statSync(p).isDirectory()) files(p, out); else if (n.endsWith(".ts") && !n.endsWith(".test.ts")) out.push(p); }
  return out;
}
function calls(): Array<{ file: string; line: number; secondArg: string | null }> {
  const out: Array<{ file: string; line: number; secondArg: string | null }> = [];
  for (const f of [...files(join(ROOT, "packages/engine/src")), ...files(join(ROOT, "apps/server/src"))]) {
    if (f.endsWith("runtime/instrumentFactory.ts")) continue;
    const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.ES2022, true);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "makeInstrument")
        out.push({ file: relative(ROOT, f), line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, secondArg: n.arguments[1]?.getText(sf) ?? null });
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}
/** Every `name = <initializer>` declaration in a file, by name, as source text (a name declared twice lists both). */
function initializers(file: string): Map<string, string[]> {
  const sf = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.ES2022, true);
  const out = new Map<string, string[]>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
      out.set(n.name.text, [...(out.get(n.name.text) ?? []), n.initializer.getText(sf)]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
describe("makeInstrument call-site pin", () => {
  // Thirteen since the build: the seg block's instrument factory and its constant-balance cash flow loop
  // (run/stages/assemble.ts, two sites) and the server's per-position results pass (jobs/instrumentsPass.ts).
  // Fourteen since slice 4b: the stochastic gap arm's factory (run/stochastic.ts), the projection's own options.
  // Fifteen since teaching slice B2: the fixed-rate ladder's base-path cash flows (run/stages/assemble.ts).
  it("fifteen production calls, by file", () => {
    expect(calls().map((c) => c.file).sort()).toEqual([
      "apps/server/src/intake/validationReport.ts", "apps/server/src/jobs/instrumentsPass.ts", "packages/engine/src/eve/effectiveDuration.ts",
      "packages/engine/src/eve/keyRate.ts", "packages/engine/src/ftp/computeFtp.ts", "packages/engine/src/gap/gapEngine.ts",
      "packages/engine/src/instrument/projectInstrument.ts", "packages/engine/src/instrument/projectInstrument.ts",
      "packages/engine/src/portfolio/aggregate.ts", "packages/engine/src/projection/dynamic/dynamicNewBusiness.ts",
      "packages/engine/src/run/shard/chunk.ts", "packages/engine/src/run/stages/assemble.ts", "packages/engine/src/run/stages/assemble.ts",
      "packages/engine/src/run/stages/assemble.ts", "packages/engine/src/run/stochastic.ts"]);
  });
  it("every run-path site passes macro; the bullet site passes NO_MACRO; intake passes none", () => {
    for (const c of calls()) {
      if (c.file.endsWith("validationReport.ts")) { expect(c.secondArg).toBeNull(); continue; }
      if (c.file.endsWith("dynamicNewBusiness.ts")) { expect(c.secondArg).toBe("{ macro: NO_MACRO }"); continue; }
      if (c.file.endsWith("chunk.ts")) { expect(c.secondArg).toBe("factoryOptions"); continue; }
      // The schema 1.9.0 sites pass a local `factoryOptions`; the pin is that the object they build carries the run's macro.
      if (c.file.endsWith("run/stages/assemble.ts")) {
        expect(c.secondArg, `${c.file}:${c.line}`).toBe("factoryOptions");
        expect(readFileSync(join(ROOT, c.file), "utf8"), c.file).toMatch(/factoryOptions\s*=[^;]*\bmacro:\s*\w+\.macro\b/s);
        continue;
      }
      // The per-position results pass hands each scenario its own options (the run's, plus that scenario's deposit
      // history under nmdWarmup). Post-merge fix: the per-scenario name no longer shadows the run's `factoryOptions`,
      // and the pin reads what is actually passed: every object either branch hands over carries the run's macro.
      if (c.file.endsWith("jobs/instrumentsPass.ts")) {
        expect(c.secondArg, `${c.file}:${c.line}`).toBe("scenarioOptions");
        const init = initializers(c.file);
        expect(init.get("scenarioOptions"), c.file).toEqual(["optionsByScenario[si]"]);
        const perScenario = init.get("optionsByScenario") ?? [];
        expect(perScenario, c.file).toHaveLength(1);
        // The warmup branch builds its own object; the other branch falls back to the run's factoryOptions.
        const built = perScenario[0]!.match(/\{[^{}]*\bnmdWarmup\b[^{}]*\}/g) ?? [];
        expect(built.length, c.file).toBeGreaterThan(0);
        for (const obj of built) expect(obj, c.file).toMatch(/\bmacro:\s*environment\.macro\b/);
        expect(perScenario[0], c.file).toMatch(/[?:]\s*factoryOptions\b/);
        expect(init.get("factoryOptions"), c.file).toHaveLength(1);
        expect(init.get("factoryOptions")![0], c.file).toMatch(/\bmacro:\s*environment\.macro\b/);
        continue;
      }
      expect(c.secondArg, `${c.file}:${c.line}`).toMatch(/\bmacro\b/);
      // Fix round 1 (I2): the threaded value, never the sentinel, at every run-path site.
      expect(c.secondArg, `${c.file}:${c.line}`).not.toMatch(/\bNO_MACRO\b/);
    }
  });
  it("the NO_MACRO sentinel is named outside macro/ only by the fixed-bullet site and intake", () => {
    // Identifiers only (comments are not nodes), so a stage cannot substitute the sentinel for the run's value.
    const named: string[] = [];
    for (const f of [...files(join(ROOT, "packages/engine/src")), ...files(join(ROOT, "apps/server/src"))]) {
      if (f.includes("/macro/")) continue;
      const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.ES2022, true);
      let hit = false;
      const visit = (n: ts.Node): void => { if (ts.isIdentifier(n) && n.text === "NO_MACRO") hit = true; ts.forEachChild(n, visit); };
      visit(sf);
      if (hit) named.push(relative(ROOT, f));
    }
    const allowed = new Set(["packages/engine/src/projection/dynamic/dynamicNewBusiness.ts", "apps/server/src/intake/validationReport.ts"]);
    expect(named.filter((f) => !allowed.has(f))).toEqual([]);
    expect(named).toContain("packages/engine/src/projection/dynamic/dynamicNewBusiness.ts");
  });
  it("runMacroFromWire has one import site outside macro/", () => {
    const hits = [...files(join(ROOT, "packages")), ...files(join(ROOT, "apps"))].filter((f) => !f.includes("/macro/") && /\brunMacroFromWire\b/.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => relative(ROOT, f))).toEqual(["packages/engine/src/run/shard/shardWorker.ts"]);
  });
});
