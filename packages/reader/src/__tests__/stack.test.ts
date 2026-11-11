import { describe, expect, it } from "vitest";
import type { AssumptionSet, OverlayBinding } from "@alm/engine";
import { bindingKey, flattenStack, isStackId, StackError, stackId, stackLabel } from "../stack";

const decay = (familyId: string, rate: number, selector?: Record<string, string>): OverlayBinding => ({
  familyId,
  overlay: { kind: "registered", registeredKind: "test-decay", params: { rate } },
  modelVersion: `v-${rate}`,
  ...(selector ? { selector } : {}),
});
const beta = (familyId: string, v: number): OverlayBinding => ({
  familyId,
  overlay: { kind: "registered", registeredKind: "test-beta", params: { v } },
  modelVersion: `b-${v}`,
});
const set = (id: string, bindings: OverlayBinding[]): AssumptionSet => ({ schemaVersion: "1.0.0", id, label: id, bindings });

const BASE = set("bau", [decay("dda", 1), beta("mma", 1)]);

describe("flattenStack", () => {
  it("replaces a matching key in place, whole, and appends a new key", async () => {
    const f = await flattenStack(BASE, [set("liq", [decay("dda", 5), decay("mma", 10)])]);
    expect(f.set.bindings).toEqual([decay("dda", 5), beta("mma", 1), decay("mma", 10)]);
    expect(f.rows.map((r) => r.sourceId)).toEqual(["liq", "bau", "liq"]);
    expect(f.set.contentHash).toBeUndefined();
    expect(f.set.schemaVersion).toBe("1.0.0");
  });

  it("keeps a selected binding apart from the unselected one of the same kind", async () => {
    const f = await flattenStack(BASE, [set("seg", [decay("dda", 7, { tier: "retail" })])]);
    expect(f.set.bindings).toEqual([decay("dda", 1), beta("mma", 1), decay("dda", 7, { tier: "retail" })]);
  });

  it("lets the top of three layers win", async () => {
    const f = await flattenStack(BASE, [set("l1", [decay("dda", 2)]), set("l2", [decay("dda", 3)]), set("l3", [decay("dda", 4)])]);
    expect(f.set.bindings[0]).toEqual(decay("dda", 4));
    expect(f.rows[0]!.sourceId).toBe("l3");
  });

  it("names the stack from the base and the ordered layers", async () => {
    const a = await flattenStack(BASE, [set("l1", []), set("l2", [])]);
    const b = await flattenStack(BASE, [set("l1", []), set("l2", [])]);
    const c = await flattenStack(BASE, [set("l2", []), set("l1", [])]);
    expect(a.set.id).toMatch(/^stack-[0-9a-f]{12}$/);
    expect(a.set.id).toBe(b.set.id);
    expect(a.set.id).not.toBe(c.set.id);
    expect(a.set.id).toBe(await stackId("bau", ["l1", "l2"]));
    // Restated, not imported: node:crypto sha256 over JSON.stringify(["bau","l1","l2"]), first 12 hex digits.
    expect(a.set.id).toBe("stack-b5fe4f68d5c8");
    expect(a.set.label).toBe("Stack: bau + l1 + l2");
    expect(stackLabel("bau", [])).toBe("Stack: bau");
  });

  it("refuses a stack as a layer and a set that binds one key twice", async () => {
    await expect(flattenStack(BASE, [set("stack-0123456789ab", [])])).rejects.toBeInstanceOf(StackError);
    await expect(flattenStack(BASE, [set("dup", [decay("dda", 2), decay("dda", 3)])])).rejects.toThrow(/binds dda::test-decay:: twice/);
    expect(isStackId("stack-0123456789ab")).toBe(true);
    expect(isStackId("demo-behavioral-v1")).toBe(false);
  });

  it("keys on the registry kind and the canonical selector", () => {
    expect(bindingKey(decay("dda", 1, { tier: "retail" }))).toBe('dda::test-decay::{"tier":["retail"]}');
    expect(bindingKey(beta("mma", 1))).toBe("mma::test-beta::");
  });
});
