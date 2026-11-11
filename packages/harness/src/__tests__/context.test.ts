import { describe, expect, it } from "vitest";
import { Context, HarnessError, MissingServiceError, ServiceConflictError } from "../index";

declare module "../types" {
  interface Services {
    "test.counter": { n: number };
    "test.other": { label: string };
  }
}

describe("Context service shelf", () => {
  it("provides and reads a service by a typed key", () => {
    const ctx = new Context();
    ctx.provide("test.counter", { n: 1 });
    expect(ctx.has("test.counter")).toBe(true);
    expect(ctx.get("test.counter").n).toBe(1);
  });

  it("throws MissingServiceError naming the key and the caller", () => {
    const ctx = new Context();
    expect(() => ctx.get("test.counter")).toThrow(MissingServiceError);
    try {
      ctx.get("test.counter");
    } catch (err) {
      const e = err as MissingServiceError;
      expect(e.key).toBe("test.counter");
      expect(e.callerPluginId).toBe("<root>");
      expect(e.message).toContain("test.counter");
    }
  });

  it("throws ServiceConflictError naming the key, the holder and the claimant", () => {
    const ctx = new Context();
    ctx.provide("test.counter", { n: 1 });
    expect(() => ctx.provide("test.counter", { n: 2 })).toThrow(ServiceConflictError);
    try {
      ctx.provide("test.counter", { n: 2 });
    } catch (err) {
      const e = err as ServiceConflictError;
      expect(e.key).toBe("test.counter");
      expect(e.holderPluginId).toBe("<root>");
      expect(e.claimantPluginId).toBe("<root>");
      expect(e.message).toContain("test.counter");
      expect(e.message).toContain("<root>");
    }
  });

  it("frees the key when the provider's dispose runs, so a second provide succeeds", () => {
    const ctx = new Context();
    const off = ctx.provide("test.counter", { n: 1 });
    off();
    expect(ctx.has("test.counter")).toBe(false);
    ctx.provide("test.counter", { n: 2 });
    expect(ctx.get("test.counter").n).toBe(2);
  });

  it("runs effect setup once and its dispose on unwind", () => {
    const ctx = new Context();
    const order: string[] = [];
    ctx.effect(() => {
      order.push("setup");
      return () => order.push("teardown");
    });
    expect(order).toEqual(["setup"]);
    ctx.dispose();
    expect(order).toEqual(["setup", "teardown"]);
  });

  it("unwinds registrations in reverse order", () => {
    const ctx = new Context();
    const order: string[] = [];
    ctx.effect(() => () => order.push("first"));
    ctx.effect(() => () => order.push("second"));
    ctx.provide("test.other", { label: "x" });
    ctx.dispose();
    expect(order).toEqual(["second", "first"]);
    expect(ctx.has("test.other")).toBe(false);
  });

  it("refuses a registration after dispose rather than orphaning it", () => {
    const ctx = new Context();
    ctx.dispose();
    expect(() => ctx.provide("test.counter", { n: 1 })).toThrow(HarnessError);
    expect(() => ctx.effect(() => () => undefined)).toThrow(HarnessError);
    expect(ctx.has("test.counter")).toBe(false);
  });

  it("unwinds the whole list even when a teardown throws, then surfaces the cause", () => {
    const ctx = new Context();
    const order: string[] = [];
    ctx.effect(() => () => order.push("first"));
    ctx.effect(() => () => {
      throw new Error("teardown blew up");
    });
    expect(() => ctx.dispose()).toThrow(HarnessError);
    expect(order).toEqual(["first"]);
    try {
      new Context().dispose();
    } catch {
      expect.unreachable("a clean dispose must not throw");
    }
  });

  it("carries every teardown failure on the thrown error", () => {
    const ctx = new Context();
    ctx.effect(() => () => {
      throw new Error("early");
    });
    ctx.effect(() => () => {
      throw new Error("late");
    });
    try {
      ctx.dispose();
      expect.unreachable("dispose must throw when a teardown throws");
    } catch (err) {
      const e = err as HarnessError & { causes: unknown[] };
      expect(e).toBeInstanceOf(HarnessError);
      expect(e.causes).toHaveLength(2);
      expect((e.causes[0] as Error).message).toBe("late");
      expect((e.causes[1] as Error).message).toBe("early");
    }
  });

  it("is idempotent on a second dispose", () => {
    const ctx = new Context();
    let count = 0;
    ctx.effect(() => () => { count += 1; });
    ctx.dispose();
    ctx.dispose();
    expect(count).toBe(1);
  });
});
