import { describe, expect, it } from "vitest";
import { Context, type Plugin } from "../context";
import { DependentActiveError, DisposeFailedError, PluginFailedError, UnmetDependencyError } from "../errors";

declare module "../types" {
  interface Services {
    "test.a": { tag: string };
    "test.b": { tag: string };
    "test.c": { tag: string };
  }
}

const providerA: Plugin = {
  id: "test.provider.a",
  apply(ctx) { ctx.provide("test.a", { tag: "a" }); },
};

const consumerB: Plugin = {
  id: "test.consumer.b",
  inject: ["test.a"],
  apply(ctx) { ctx.provide("test.b", { tag: `b-over-${ctx.get("test.a").tag}` }); },
};

describe("mount and activation", () => {
  it("activates a plugin with no inject immediately", () => {
    const ctx = new Context();
    const fiber = ctx.mount(providerA, undefined, "row-a");
    expect(fiber.state).toBe("active");
    expect(fiber.rowId).toBe("row-a");
    expect(fiber.pluginId).toBe("test.provider.a");
    expect(ctx.get("test.a").tag).toBe("a");
  });

  it("holds a plugin pending until its injected key arrives, then wakes it", () => {
    const ctx = new Context();
    const b = ctx.mount(consumerB, undefined, "row-b");
    expect(b.state).toBe("pending");
    expect(ctx.has("test.b")).toBe(false);
    const a = ctx.mount(providerA, undefined, "row-a");
    expect(a.state).toBe("active");
    expect(b.state).toBe("active");
    expect(ctx.get("test.b").tag).toBe("b-over-a");
  });

  it("activates depth-first: a provide inside apply wakes a pending plugin before apply returns", () => {
    const ctx = new Context();
    const order: string[] = [];
    const watcher: Plugin = {
      id: "test.watcher",
      inject: ["test.a"],
      apply() { order.push("watcher"); },
    };
    const nested: Plugin = {
      id: "test.nested",
      apply(c) {
        order.push("provider-before");
        c.provide("test.a", { tag: "a" });
        order.push("provider-after");
      },
    };
    ctx.mount(watcher, undefined, "row-watch");
    ctx.mount(nested, undefined, "row-nest");
    expect(order).toEqual(["provider-before", "watcher", "provider-after"]);
  });

  it("credits the owning plugin in a service conflict", () => {
    const ctx = new Context();
    ctx.mount(providerA, undefined, "row-a");
    const second: Plugin = { id: "test.provider.a2", apply(c) { c.provide("test.a", { tag: "a2" }); } };
    try {
      ctx.mount(second, undefined, "row-a2");
      throw new Error("expected a failure");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFailedError);
      const e = err as PluginFailedError;
      expect(e.pluginId).toBe("test.provider.a2");
      expect(e.rowId).toBe("row-a2");
      expect(String((e.cause as Error).message)).toContain("test.provider.a");
    }
  });

  it("finalize throws UnmetDependencyError naming the plugin and the missing keys", () => {
    const ctx = new Context();
    ctx.mount(consumerB, undefined, "row-b");
    try {
      ctx.finalize();
      throw new Error("expected a failure");
    } catch (err) {
      expect(err).toBeInstanceOf(UnmetDependencyError);
      const e = err as UnmetDependencyError;
      expect(e.pluginId).toBe("test.consumer.b");
      expect(e.missingKeys).toEqual(["test.a"]);
    }
  });

  it("finalize passes when every fiber is active", () => {
    const ctx = new Context();
    ctx.mount(consumerB, undefined, "row-b");
    ctx.mount(providerA, undefined, "row-a");
    expect(() => ctx.finalize()).not.toThrow();
  });

  it("refuses to dispose a fiber another active fiber injects from", () => {
    const ctx = new Context();
    const a = ctx.mount(providerA, undefined, "row-a");
    ctx.mount(consumerB, undefined, "row-b");
    try {
      a.dispose();
      throw new Error("expected a failure");
    } catch (err) {
      expect(err).toBeInstanceOf(DependentActiveError);
      const e = err as DependentActiveError;
      expect(e.key).toBe("test.a");
      expect(e.dependentPluginId).toBe("test.consumer.b");
    }
  });

  it("disposes the dependent first, then the provider", () => {
    const ctx = new Context();
    const a = ctx.mount(providerA, undefined, "row-a");
    const b = ctx.mount(consumerB, undefined, "row-b");
    b.dispose();
    expect(b.state).toBe("disposed");
    expect(ctx.has("test.b")).toBe(false);
    a.dispose();
    expect(ctx.has("test.a")).toBe(false);
  });

  it("Context.dispose unwinds every fiber in reverse mount order without a dependent error", () => {
    const ctx = new Context();
    const order: string[] = [];
    const tracked = (id: string): Plugin => ({
      id,
      apply(c) { c.effect(() => () => order.push(id)); },
    });
    ctx.mount(tracked("p1"), undefined, "r1");
    ctx.mount(providerA, undefined, "r2");
    ctx.mount(consumerB, undefined, "r3");
    ctx.mount(tracked("p4"), undefined, "r4");
    ctx.dispose();
    expect(order).toEqual(["p4", "p1"]);
    expect(ctx.has("test.a")).toBe(false);
    expect(ctx.has("test.b")).toBe(false);
  });

  it("wraps a throw inside apply as PluginFailedError carrying the cause", () => {
    const ctx = new Context();
    const bad: Plugin = { id: "test.bad", apply() { throw new RangeError("boom"); } };
    try {
      ctx.mount(bad, undefined, "row-bad");
      throw new Error("expected a failure");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFailedError);
      expect((err as PluginFailedError).cause).toBeInstanceOf(RangeError);
      expect((err as PluginFailedError).message).toContain("row-bad");
    }
  });

  it("unwinds what a plugin registered before it threw mid-apply", () => {
    const ctx = new Context();
    const halfApplied: Plugin = {
      id: "test.half",
      apply(c) {
        c.provide("test.c", { tag: "c" });
        throw new RangeError("boom after provide");
      },
    };
    expect(() => ctx.mount(halfApplied, undefined, "row-half")).toThrow(PluginFailedError);
    expect(ctx.has("test.c")).toBe(false);
    const honest: Plugin = { id: "test.honest.c", apply(c) { c.provide("test.c", { tag: "c2" }); } };
    const fiber = ctx.mount(honest, undefined, "row-c");
    expect(fiber.state).toBe("active");
    expect(ctx.get("test.c").tag).toBe("c2");
  });

  it("runs every teardown in a fiber even when one throws, and reports the failures", () => {
    const ctx = new Context();
    const order: string[] = [];
    const twoEffects: Plugin = {
      id: "test.two.effects",
      apply(c) {
        c.effect(() => () => order.push("first"));
        c.effect(() => () => { throw new RangeError("teardown boom"); });
      },
    };
    const fiber = ctx.mount(twoEffects, undefined, "row-two");
    try {
      fiber.dispose();
      throw new Error("expected a failure");
    } catch (err) {
      expect(err).toBeInstanceOf(DisposeFailedError);
      expect((err as DisposeFailedError).causes).toHaveLength(1);
      expect((err as DisposeFailedError).causes[0]).toBeInstanceOf(RangeError);
    }
    expect(order).toEqual(["first"]);
    expect(fiber.state).toBe("disposed");
  });

  it("guards by fiber, not plugin id: two rows of one plugin cannot strand each other", () => {
    const ctx = new Context();
    const selfInjecting: Plugin<"provide" | "consume"> = {
      id: "test.two.rows",
      inject: [],
      apply(c, mode) {
        if (mode === "provide") c.provide("test.a", { tag: "a" });
        else c.get("test.a");
      },
    };
    const row1 = ctx.mount({ ...selfInjecting }, "provide", "row-1");
    const row2 = ctx.mount({ ...selfInjecting, inject: ["test.a"] }, "consume", "row-2");
    expect(row2.state).toBe("active");
    try {
      row1.dispose();
      throw new Error("expected a failure");
    } catch (err) {
      expect(err).toBeInstanceOf(DependentActiveError);
      const e = err as DependentActiveError;
      expect(e.key).toBe("test.a");
      expect(e.dependentPluginId).toBe("test.two.rows");
    }
    expect(row1.state).toBe("active");
    expect(ctx.has("test.a")).toBe(true);
  });
  it("takes the fibers a failed apply woke down with it", () => {
    const ctx = new Context();
    const unwound: string[] = [];
    const watcherB: Plugin = {
      id: "test.consumer.b.watched",
      inject: ["test.a"],
      apply(c) {
        c.provide("test.b", { tag: "b" });
        c.effect(() => () => unwound.push("b"));
      },
    };
    const b = ctx.mount(watcherB, undefined, "row-b");
    expect(b.state).toBe("pending");
    const failingProvider: Plugin = {
      id: "test.provider.a.failing",
      apply(c) {
        c.effect(() => () => unwound.push("a"));
        c.provide("test.a", { tag: "a" });
        throw new RangeError("boom after waking b");
      },
    };
    expect(() => ctx.mount(failingProvider, undefined, "row-a-bad")).toThrow(PluginFailedError);
    // Both fibers unwound: the woken consumer first, then the fiber that failed.
    expect(unwound).toEqual(["b", "a"]);
    expect(b.state).toBe("disposed");
    expect(ctx.has("test.a")).toBe(false);
    expect(ctx.has("test.b")).toBe(false);
    // The failed row left nothing behind, so the honest provider mounts cleanly.
    const honest = ctx.mount(providerA, undefined, "row-a");
    expect(honest.state).toBe("active");
    expect(ctx.get("test.a").tag).toBe("a");
  });
  it("takes a grandchild fiber down too: the woken list survives its own apply", () => {
    const ctx = new Context();
    const unwound: string[] = [];
    const c: Plugin = {
      id: "test.deep.c",
      inject: ["test.b"],
      apply(ctx2) { ctx2.effect(() => () => unwound.push("c")); },
    };
    const b: Plugin = {
      id: "test.deep.b",
      inject: ["test.a"],
      apply(ctx2) {
        ctx2.effect(() => () => unwound.push("b"));
        ctx2.provide("test.b", { tag: "b" });
      },
    };
    const failingA: Plugin = {
      id: "test.deep.a.failing",
      apply(ctx2) {
        ctx2.effect(() => () => unwound.push("a"));
        ctx2.provide("test.a", { tag: "a" });
        throw new RangeError("boom two levels up");
      },
    };
    const fiberC = ctx.mount(c, undefined, "row-c");
    const fiberB = ctx.mount(b, undefined, "row-b");
    expect(fiberB.state).toBe("pending");
    expect(fiberC.state).toBe("pending");
    expect(() => ctx.mount(failingA, undefined, "row-a-bad")).toThrow(PluginFailedError);
    expect(unwound).toEqual(["c", "b", "a"]);
    expect(fiberB.state).toBe("disposed");
    expect(fiberC.state).toBe("disposed");
    expect(ctx.has("test.a")).toBe(false);
    expect(ctx.has("test.b")).toBe(false);
    const freshA = ctx.mount(providerA, undefined, "row-a2");
    const freshB: Plugin = { id: "test.deep.b2", apply(ctx2) { ctx2.provide("test.b", { tag: "b2" }); } };
    const fiberB2 = ctx.mount(freshB, undefined, "row-b2");
    expect(freshA.state).toBe("active");
    expect(fiberB2.state).toBe("active");
  });
});

describe("mountedPlugins", () => {
  it("lists the active rows in mount order, carrying each plugin's declares", () => {
    const ctx = new Context();
    const declaring: Plugin = {
      id: "test.declaring",
      declares: { kind: "metric", produces: ["Thing"], consumes: ["Other"] },
      apply(ctx2) { ctx2.provide("test.c", { tag: "c" }); },
    };
    ctx.mount(providerA, undefined, "row-a");
    ctx.mount(declaring, undefined, "row-d");
    expect(ctx.mountedPlugins()).toEqual([
      { id: "test.provider.a", rowId: "row-a" },
      { id: "test.declaring", rowId: "row-d", declares: { kind: "metric", produces: ["Thing"], consumes: ["Other"] } },
    ]);
  });

  it("drops a row that has been disposed, and never lists a pending one", () => {
    const ctx = new Context();
    const pending: Plugin = { id: "test.pending", inject: ["test.b"], apply() {} };
    const fiber = ctx.mount(providerA, undefined, "row-a");
    ctx.mount(pending, undefined, "row-p");
    expect(ctx.mountedPlugins().map((p) => p.rowId)).toEqual(["row-a"]);
    fiber.dispose();
    expect(ctx.mountedPlugins()).toEqual([]);
  });
});
