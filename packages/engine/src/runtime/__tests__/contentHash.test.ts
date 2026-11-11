import { describe, it, expect } from "vitest";
import { contentHash, canonicalize } from "../contentHash";

describe("contentHash", () => {
  it("is byte-identical for structurally-equal inputs", () => {
    const a = { id: "p1", notional: 1000, coupon: 0.05 };
    const b = { id: "p1", notional: 1000, coupon: 0.05 };
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("is independent of object key insertion order", () => {
    const a = { id: "p1", notional: 1000, coupon: 0.05 };
    const b = { coupon: 0.05, id: "p1", notional: 1000 };
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("is key-order independent at every nesting level", () => {
    const a = { outer: { x: 1, y: 2 }, list: [{ a: 1, b: 2 }] };
    const b = { list: [{ b: 2, a: 1 }], outer: { y: 2, x: 1 } };
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("treats an explicit-undefined property and a missing property alike", () => {
    const a = { id: "p1", side: undefined };
    const b = { id: "p1" };
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("differs when any field value differs", () => {
    const base = { id: "p1", notional: 1000, coupon: 0.05 };
    expect(contentHash({ ...base, coupon: 0.06 })).not.toBe(contentHash(base));
    expect(contentHash({ ...base, notional: 1001 })).not.toBe(contentHash(base));
    expect(contentHash({ ...base, id: "p2" })).not.toBe(contentHash(base));
  });

  it("differs when a field is added", () => {
    const base = { id: "p1" };
    expect(contentHash({ id: "p1", extra: 0 })).not.toBe(contentHash(base));
  });

  it("respects array order (arrays are ordered data, not key sets)", () => {
    expect(contentHash([1, 2, 3])).not.toBe(contentHash([3, 2, 1]));
  });

  it("returns a 64-char lowercase hex sha-256 digest", () => {
    const h = contentHash({ id: "p1" });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic across repeated calls", () => {
    const obj = { a: [1, 2], b: { c: 3 } };
    expect(contentHash(obj)).toBe(contentHash(obj));
  });

  it("rejects non-finite numbers rather than silently coercing them", () => {
    expect(() => contentHash({ x: NaN })).toThrow(/finite/i);
    expect(() => contentHash({ x: Infinity })).toThrow(/finite/i);
  });
});

describe("canonicalize", () => {
  it("produces an order-independent canonical string", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
});
