/**
 * Shipped Studio source holds no regex lookbehind (ALM Studio Polish 7 T1). Safari below 16.4 cannot parse a lookbehind,
 * so a lookbehind in the bundle throws there. Every .ts and .tsx file under apps/studio/src outside __tests__ is read
 * and none may hold a positive or a negative lookbehind; a named group is allowed (Safari 11.1 and up parse it).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("shipped Studio source", () => {
  it("holds no regex lookbehind in any .ts or .tsx file outside __tests__", () => {
    const files = sources(SRC);
    // The walk reaches the source it pins: the id-joint function's home is among the files read.
    expect(files.some((f) => f.endsWith(join("govern", "governModels.ts")))).toBe(true);
    const hits = files.filter((f) => { const t = readFileSync(f, "utf8"); return t.includes("(?<=") || t.includes("(?<!"); });
    expect(hits.map((f) => f.slice(SRC.length))).toEqual([]);
  });
});
