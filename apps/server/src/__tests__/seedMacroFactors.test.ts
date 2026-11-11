// apps/server/src/__tests__/seedMacroFactors.test.ts
/**
 * The seeded macro factors market (macro-demo-v1),
 * proven on a scratch store seeded by the real seedStore(). The store hashes in
 * section A were measured on the unmodified code (Task 1.0) and are never
 * re-pinned: macro-demo-v1 is an addition, and no existing seeded document changes.
 * OSS slice S1 re-pinned the demo run-plan literals once: the demo routing policy's id is now
 * model-map-default-v1; with that id read back as the old one every re-pinned document hashes to its measured
 * literal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";
import { validateMacroFactors } from "@alm/engine/src/macro/macroFactors";

let t: TestPlatform; let store: FileStore;
beforeAll(async () => { t = await bootTestPlatform(); store = new FileStore(t.storeRoot); await seedStore(store, repoRoot()); }, 300_000);
afterAll(() => t.close());

describe("A. no existing seeded document changed (measured on the unmodified code; never re-pin)", () => {
  const PINS: Array<[Parameters<FileStore["getMeta"]>[0], string, string]> = [
    ["market", "market-public-2026-03-31", "6d0501f30b0e59a93bb1294e68d5ed6041d473a264d5790e5da1dbdfa3a60731"],
    ["market", "rate-indices-demo-v1", "347674669bbc746208745bf97c683a81c5da643c5adad33d116a7d3238cc2e00"],
    ["market", "tlp-shock-demo-v1", "abc80918c85cd6753cb9e499b47d4768b072b125cafffc56886d5a6253ad5d0a"],
    ["market", "vol-shock-demo-v1", "f9737f2aae0c8b7d9c86dd3fbd49f280019cd47c6011c571bb206c3ff73e95f6"],
    ["assumption-sets", "demo-behavioral-v1", "7b65f5629022b720de7a79819718a75545a56d06c5d966f963a2f61a058175a2"],
    ["run-plans", "plan-synthetic-2500-v1", "5e2826755621ffc6d9123bc567fded1cbfa09d14d4870cf55a9443c99feafbee"],
    ["run-plans", "plan-synthetic-2500-hedged-v1", "7c652b11735b6880fe79edea963732e4f15a1ea79a21fa088a6eff3d953abab1"],
    ["run-plans", "plan-vanilla-book-v1", "ba2f810982cb33e6f70383fe9de2c1c5b485a430ee4f1b22aaade38968b632d3"],
    ["run-plans", "plan-synthetic-2500-loan-repricing-v1", "199b5e6db5a5892ff6be654db7931a3339f45300111741d39359537a20a45f3d"],
    ["run-plans", "plan-synthetic-lcr-liabilities-v1", "0519ff6678c5e795ff0384406d2d76059fa22a708c5bb3c25d80f5303333b4e5"],
    ["run-plans", "plan-synthetic-2500-indexed-v1", "ef82c01f2c1660b14b8a2098bf2d21427b0d7fd9d2c046d20a5104475310acfc"],
  ];
  for (const [c, id, h] of PINS) it(`${c}/${id}`, () => expect(store.getMeta(c, id).contentHash).toBe(h));
});

describe("B. macro-demo-v1", () => {
  it("carries five series in id order, valid at 2026-03, beside untouched curve and TLP", async () => {
    const base = (await api<Record<string, unknown>>(t.base, "GET", "/api/market/market-public-2026-03-31")).body;
    const m = (await api<Record<string, unknown> & { macroFactors: Array<{ id: string; role: string }> }>(t.base, "GET", "/api/market/macro-demo-v1")).body;
    expect(m.macroFactors.map((s) => `${s.id}:${s.role}`)).toEqual([
      "hpi-down-30:projection", "hpi-fhfa-po:history", "hpi-flat:projection", "hpi-up-15:projection", "unrate:history"]);
    expect(validateMacroFactors(m.macroFactors, "2026-03")).toEqual([]);
    expect(m.tlpNodes).toEqual(base.tlpNodes);
    expect(m.curveQuotes).toEqual(base.curveQuotes);
    expect(m.rateIndices).toBeUndefined();
  });
  // Re-expectation (Studio Piece 7b slice 4): was "no plan binds it in slice 1"; the three macro plans now bind it, and no other plan does.
  it("only the three macro plans bind it", () => {
    const binding = store.listMeta("run-plans")
      .filter((meta) => store.getDocument<{ inputs: { marketSnapshot: string } }>("run-plans", meta.id).doc.inputs.marketSnapshot === "macro-demo-v1")
      .map((meta) => meta.id).sort();
    expect(binding).toEqual(["plan-synthetic-2500-housing-flat-v1", "plan-synthetic-2500-housing-v1", "plan-synthetic-2500-macro-unmapped-v1"]);
  });
});
