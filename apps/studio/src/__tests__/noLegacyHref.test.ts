// apps/studio/src/__tests__/noLegacyHref.test.ts
// No caller names its target as an old layer id, and the one-argument selectionQuery is gone.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addressQuery, screenHref } from "../pageLinks";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...sources(p));
    } else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("the legacy forms are gone", () => {
  const files = sources(SRC);
  it("no source file calls hrefFor with anything but a screen target object", () => {
    const hits: string[] = [];
    for (const f of files) {
      if (f.endsWith("/router.ts")) continue;
      if (/\bhrefFor\((?!\s*\{)/.test(readFileSync(f, "utf8"))) hits.push(f.slice(SRC.length));
    }
    expect(hits).toEqual([]);
  });
  it("router.ts declares one hrefFor signature and no LayerId target", () => {
    const body = readFileSync(join(SRC, "router.ts"), "utf8");
    expect(body.match(/export function hrefFor\(/g)!.length).toBe(1);
    expect(body).not.toContain("export function hrefFor(target: LayerId");
    expect(body).not.toContain("PRE_WORKSPACE_SELECTION_KEYS");
  });
  it("no source file calls selectionQuery with one argument", () => {
    const hits: string[] = [];
    for (const f of files) {
      const body = readFileSync(f, "utf8");
      if (/selectionQuery\(\s*[A-Za-z_.]+\s*\)/.test(body)) hits.push(f.slice(SRC.length));
    }
    expect(hits).toEqual([]);
  });
});

describe("addressQuery and screenHref", () => {
  it("drops the book and the as-of, which the workspace names", () => {
    expect(addressQuery("assumptions", { book: "b", asOf: "m", base: "demo" })).toEqual({ base: "demo" });
  });
  it("drops the tab key a Results layer carried: the screen is the tab", () => {
    expect(addressQuery("results", { tab: "nii", scenario: "S0" })).toEqual({ scenario: "S0" });
  });
  it("turns the run of a Results address into the picker's result, and keeps a run elsewhere", () => {
    expect(addressQuery("results", { run: "r1", scenario: "S0" })).toEqual({ result: "r1", scenario: "S0" });
    expect(addressQuery("results", { run: "r1", result: "r2" })).toEqual({ result: "r2" });
    expect(addressQuery("run", { run: "r1" })).toEqual({ run: "r1" });
  });
  it("builds a workspace address with the cleaned query", () => {
    expect(screenHref({ ws: "ws-a", section: "balance", screen: "positions" }, { book: "b", groupBy: "side", offset: "50" })).toBe("#/ws/ws-a/balance/positions?groupBy=side&offset=50");
    expect(screenHref({ ws: "ws-a", section: "results", screen: "nii" }, { run: "run-1", scenario: "S0" })).toBe("#/ws/ws-a/results/nii?result=run-1&scenario=S0");
    expect(screenHref({ ws: "ws-a", section: "market", screen: "curves" })).toBe("#/ws/ws-a/market/curves");
  });
});
