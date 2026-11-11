// apps/studio/src/__tests__/stackModel.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssumptionDiff, AssumptionSet, OverlayBinding } from "@alm/engine";
import { bindingRows, canonicalJson, deltaRows, loadStack, saveStack } from "../assumptions/stackModel";
import { mockFetch } from "./fixtures/run";

afterEach(() => vi.unstubAllGlobals());

const decay = (familyId: string, rate: number | null, selector?: Record<string, string>): OverlayBinding => ({
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

// A diff leaf as the view model prints it (Polish 4 T4): a number is a figure, anything else text.
const fig = (text: string) => ({ kind: "figure", text, exact: text });
const txt = (text: string) => ({ kind: "text", text });
// A side whose binding stores no leaf at the path (Polish 5 Task 6 fix, Polish 6 T1): From on an added row, To on a
// removed row.
const absent = { kind: "absent", text: "Not stored" };

const BAU = set("bau", [decay("dda", 1), beta("mma", 1)]);
const LIQ = set("liq", [decay("dda", 5), decay("mma", 10, { tier: "retail" })]);

describe("bindingRows", () => {
  it("marks the rows a layer supplied and prints an absent selector as whole family", () => {
    const rows = bindingRows(
      [
        { binding: decay("dda", 5), sourceId: "liq" },
        { binding: beta("mma", 1), sourceId: "bau" },
        { binding: decay("mma", 10, { tier: "retail" }), sourceId: "liq" },
      ],
      "bau",
    );
    expect(rows).toEqual([
      { familyId: "dda", kind: "test-decay", selector: "whole family", modelVersion: "v-5", sourceId: "liq", fromLayer: true },
      { familyId: "mma", kind: "test-beta", selector: "whole family", modelVersion: "b-1", sourceId: "bau", fromLayer: false },
      { familyId: "mma", kind: "test-decay", selector: "tier: retail", modelVersion: "v-10", sourceId: "liq", fromLayer: true },
    ]);
  });
});

describe("deltaRows", () => {
  it("labels added, removed and changed by the binding key, not by a null value", () => {
    const base = set("bau", [decay("dda", 1), beta("mma", 1), decay("cd", null)]);
    const candidate = set("cand", [decay("dda", 5), decay("cd", 2), decay("sav", 3, { tier: "retail" })]);
    const diff: AssumptionDiff = {
      baseId: "bau",
      deltas: [
        { familyId: "dda", overlayKind: "registered", path: "params.rate", from: 1, to: 5 },
        { familyId: "mma", overlayKind: "registered", path: "params.v", from: 1, to: null },
        { familyId: "cd", overlayKind: "registered", path: "params.rate", from: null, to: 2 },
        { familyId: "sav", overlayKind: "registered", selector: { tier: "retail" }, path: "params.rate", from: null, to: 3 },
        { familyId: "sav", overlayKind: "registered", selector: { tier: "retail" }, path: "registeredKind", from: null, to: "test-decay" },
      ],
    };
    expect(deltaRows(diff, base, candidate)).toEqual([
      { familyId: "dda", kind: "registered", selector: "whole family", path: "params.rate", change: "changed", from: fig("1"), to: fig("5") },
      { familyId: "mma", kind: "registered", selector: "whole family", path: "params.v", change: "removed", from: fig("1"), to: absent },
      { familyId: "cd", kind: "registered", selector: "whole family", path: "params.rate", change: "changed", from: txt("none"), to: fig("2") },
      { familyId: "sav", kind: "registered", selector: "tier: retail", path: "params.rate", change: "added", from: absent, to: fig("3") },
      { familyId: "sav", kind: "registered", selector: "tier: retail", path: "registeredKind", change: "added", from: absent, to: txt("test-decay") },
    ]);
  });
});

const DIFF: AssumptionDiff = {
  baseId: "bau",
  deltas: [
    { familyId: "dda", overlayKind: "registered", path: "params.rate", from: 1, to: 5 },
    { familyId: "mma", overlayKind: "registered", selector: { tier: "retail" }, path: "params.rate", from: null, to: 10 },
  ],
};

describe("loadStack", () => {
  it("reads the sets, flattens them and diffs the flat set against the base", async () => {
    mockFetch([
      ["/api/assumption-sets/diff", DIFF],
      ["/api/assumption-sets/bau", BAU],
      ["/api/assumption-sets/liq", LIQ],
    ]);
    const r = await loadStack("bau", ["liq"]);
    if (r.kind !== "ok") throw new Error(`expected ok, got ${r.text}`);
    expect(r.base).toEqual(BAU);
    expect(r.flat.set.id).toMatch(/^stack-/);
    expect(r.flat.set.label).toBe("Stack: bau + liq");
    expect(r.flat.rows.map((x) => x.sourceId)).toEqual(["liq", "bau", "liq"]);
    expect(r.diff).toEqual({
      kind: "ok",
      rows: [
        { familyId: "dda", kind: "registered", selector: "whole family", path: "params.rate", change: "changed", from: fig("1"), to: fig("5") },
        { familyId: "mma", kind: "registered", selector: "tier: retail", path: "params.rate", change: "added", from: absent, to: fig("10") },
      ],
    });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const diffCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/assumption-sets/diff"))!;
    expect(JSON.parse(String((diffCall[1] as RequestInit).body))).toEqual({ baseId: "bau", candidate: r.flat.set });
  });

  it("refuses a stored stack as a layer with the stack's own words", async () => {
    mockFetch([
      ["/api/assumption-sets/diff", DIFF],
      ["/api/assumption-sets/bau", BAU],
      ["/api/assumption-sets/stack-0123456789ab", set("stack-0123456789ab", [])],
    ]);
    expect(await loadStack("bau", ["stack-0123456789ab"])).toEqual({
      kind: "refused",
      text: 'stored stack "stack-0123456789ab" cannot be a layer; pick it as the base instead',
    });
  });

  it("refuses when a set cannot be read, carrying the server's words", async () => {
    mockFetch([
      ["/api/assumption-sets/bau", BAU],
      ["/api/assumption-sets/gone", { error: { code: "not-found", message: "no assumption set gone" } }, 404],
    ]);
    expect(await loadStack("bau", ["gone"])).toEqual({ kind: "refused", text: "404: no assumption set gone" });
  });

  it("keeps the flat stack when the diff fails and carries the diff error", async () => {
    mockFetch([
      ["/api/assumption-sets/diff", { error: { code: "internal", message: "diff broke" } }, 500],
      ["/api/assumption-sets/bau", BAU],
      ["/api/assumption-sets/liq", LIQ],
    ]);
    const r = await loadStack("bau", ["liq"]);
    if (r.kind !== "ok") throw new Error(`expected ok, got ${r.text}`);
    expect(r.flat.set.bindings).toEqual([decay("dda", 5), beta("mma", 1), decay("mma", 10, { tier: "retail" })]);
    expect(r.diff).toEqual({ kind: "error", text: "500: diff broke" });
  });
});

const FLAT = set("stack-0123456789ab", [decay("dda", 5), beta("mma", 1)]);

describe("saveStack", () => {
  it("maps 201 to saved", async () => {
    mockFetch([["/api/assumption-sets", { ...FLAT, contentHash: "h1" }, 201]]);
    expect(await saveStack(FLAT)).toEqual({ kind: "saved", id: "stack-0123456789ab" });
  });

  it("maps 409 plus an equal stored set to already-saved", async () => {
    const reordered: OverlayBinding[] = [
      { modelVersion: "v-5", overlay: { params: { rate: 5 }, registeredKind: "test-decay", kind: "registered" }, familyId: "dda" },
      { overlay: { registeredKind: "test-beta", kind: "registered", params: { v: 1 } }, familyId: "mma", modelVersion: "b-1" },
    ];
    mockFetch([
      ["/api/assumption-sets/stack-0123456789ab", { ...FLAT, label: "older label", bindings: reordered, contentHash: "h1" }],
      ["/api/assumption-sets", { error: { code: "conflict", message: "assumption set stack-0123456789ab exists" } }, 409],
    ]);
    expect(await saveStack(FLAT)).toEqual({ kind: "already-saved", id: "stack-0123456789ab" });
  });

  it("maps 409 plus a different stored set to conflict", async () => {
    mockFetch([
      ["/api/assumption-sets/stack-0123456789ab", { ...FLAT, bindings: [decay("dda", 6), beta("mma", 1)], contentHash: "h2" }],
      ["/api/assumption-sets", { error: { code: "conflict", message: "assumption set stack-0123456789ab exists" } }, 409],
    ]);
    expect(await saveStack(FLAT)).toEqual({
      kind: "conflict",
      id: "stack-0123456789ab",
      text: "409: assumption set stack-0123456789ab exists",
    });
  });

  it("maps any other error to refused with the server's message", async () => {
    mockFetch([["/api/assumption-sets", { error: { code: "invalid-assumption-set", message: "binding 0 has no familyId" } }, 422]]);
    expect(await saveStack(FLAT)).toEqual({ kind: "refused", text: "422: binding 0 has no familyId" });
  });
});

describe("canonicalJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
    expect(canonicalJson([{ y: 1, x: 2 }, "s"])).toBe('[{"x":2,"y":1},"s"]');
  });
});
