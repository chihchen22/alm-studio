// packages/engine/src/macro/__tests__/targetKey.test.ts
/**
 * mfu2-b: one shared identity for a mapped target. The engine's macroTargetKey
 * and Studio's mapsTarget both read macroTargetIdentity, so the two cannot
 * drift. The engine key is unchanged: its hash values are pinned here as
 * SHA-256 of the canonical selector text, computed outside the repo
 * (printf with shasum -a 256) and restated by hand.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DimensionPredicate } from "../../contracts/dimensions";
import { macroTargetKey } from "../runMacro";
import { macroTargetIdentity } from "../targetKey";

const HASH_NULL = "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"; // sha256 of: null
const HASH_RETAIL = "a751c75f0dd3266d8c625a2c4875a379b9adf14df64be7ba8815a9187370a986"; // sha256 of: {"tier":"retail"}
const HASH_GEO = "1eb079fc124c5b37a7450722e487a0b8a5b6a509f69531b1963a5c3f7b83843b"; // sha256 of: {"geo":["a","b"]}

describe("macroTargetKey is unchanged (no hash moves)", () => {
  it("no selector hashes the text null; a selector hashes its sorted-key JSON", () => {
    expect(macroTargetKey("mbs", undefined)).toBe(`mbs::${HASH_NULL}`);
    expect(macroTargetKey("mortgages", { tier: "retail" })).toBe(`mortgages::${HASH_RETAIL}`);
    expect(macroTargetKey("mbs", { geo: ["a", "b"] })).toBe(`mbs::${HASH_GEO}`);
  });
});

describe("macroTargetIdentity is the text the engine key hashes", () => {
  it("family, then the canonical selector text (null for no selector)", () => {
    expect(macroTargetIdentity("mbs", undefined)).toBe("mbs::null");
    expect(macroTargetIdentity("mortgages", { tier: "retail" })).toBe('mortgages::{"tier":"retail"}');
    expect(macroTargetIdentity("mbs", { geo: ["a", "b"] })).toBe('mbs::{"geo":["a","b"]}');
  });
  it("agrees with the engine key on equality, both ways, over a table of pairs", () => {
    const sels: Array<DimensionPredicate | undefined> = [undefined, {}, { tier: "retail" }, { tier: ["retail"] }, { tier: "retail", geo: "us" }, { geo: "us", tier: "retail" }, { geo: ["a", "b"] }, { geo: ["b", "a"] }];
    for (const fa of ["mbs", "mortgages"]) for (const fb of ["mbs", "mortgages"]) for (const a of sels) for (const b of sels) {
      expect(macroTargetIdentity(fa, a) === macroTargetIdentity(fb, b), `${fa} ${JSON.stringify(a)} vs ${fb} ${JSON.stringify(b)}`)
        .toBe(macroTargetKey(fa, a) === macroTargetKey(fb, b));
    }
  });
  it("key order does not matter, an empty selector is not the whole family, and a one-element list is not its scalar (the engine's rule)", () => {
    expect(macroTargetIdentity("m", { geo: "us", tier: "retail" })).toBe(macroTargetIdentity("m", { tier: "retail", geo: "us" }));
    expect(macroTargetIdentity("m", {})).not.toBe(macroTargetIdentity("m", undefined));
    expect(macroTargetIdentity("m", { tier: ["retail"] })).not.toBe(macroTargetIdentity("m", { tier: "retail" }));
  });
});

describe("browser safety: the pure key modules stay out of node", () => {
  const files = ["../../runtime/canonicalize.ts", "../targetKey.ts"];
  for (const f of files) {
    it(`${f} imports neither a node: module nor runtime/contentHash`, () => {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      const imports = [...src.matchAll(/^(?:import|export)\s+[^;]*?\s+from\s+"([^"]+)";/gm)].map((m) => m[1]!);
      for (const from of imports) {
        expect(from.startsWith("node:"), `${f} imports ${from}`).toBe(false);
        expect(from, `${f} imports ${from}`).not.toContain("runtime/contentHash");
        expect(from, `${f} imports ${from}`).not.toBe("./contentHash");
      }
      expect(src).not.toMatch(/require\(\s*"node:/);
    });
  }
  it("the scan sees imports: targetKey.ts has at least one, so an empty match cannot pass", () => {
    const src = readFileSync(new URL("../targetKey.ts", import.meta.url), "utf8");
    expect([...src.matchAll(/^import\s+[^;]*?\s+from\s+"([^"]+)";/gm)].length).toBeGreaterThan(0);
  });
});
