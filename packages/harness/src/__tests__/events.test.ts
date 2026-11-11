import { describe, expect, it } from "vitest";
import { Context, type Plugin } from "../context";
import { PluginFailedError } from "../errors";
import type { WaterfallListener } from "../types";

interface Report { passed: boolean; lines: string[] }

declare module "../types" {
  interface Events {
    "test/observe": (note: string) => void;
    "test/gate": WaterfallListener<{ id: string }, Report>;
    "test/first": (n: number) => string | undefined;
  }
}

describe("emit", () => {
  it("calls listeners in registration order and returns nothing", () => {
    const ctx = new Context();
    const seen: string[] = [];
    ctx.on("test/observe", (note) => { seen.push(`one:${note}`); });
    ctx.on("test/observe", (note) => { seen.push(`two:${note}`); });
    expect(ctx.emit("test/observe", "x")).toBeUndefined();
    expect(seen).toEqual(["one:x", "two:x"]);
  });

  it("honors prepend", () => {
    const ctx = new Context();
    const seen: string[] = [];
    ctx.on("test/observe", () => { seen.push("second"); });
    ctx.on("test/observe", () => { seen.push("first"); }, { prepend: true });
    ctx.emit("test/observe", "x");
    expect(seen).toEqual(["first", "second"]);
  });

  it("stops calling a listener after its dispose", () => {
    const ctx = new Context();
    let calls = 0;
    const off = ctx.on("test/observe", () => { calls += 1; });
    ctx.emit("test/observe", "x");
    off();
    ctx.emit("test/observe", "x");
    expect(calls).toBe(1);
  });
});

describe("waterfall", () => {
  it("returns the seed when no listener is registered", () => {
    const ctx = new Context();
    const out = ctx.waterfall("test/gate", { id: "p1" }, { passed: true, lines: [] });
    expect(out).toEqual({ passed: true, lines: [] });
  });

  it("passes through, mutates and delegates in order", () => {
    const ctx = new Context();
    ctx.on("test/gate", (payload, value, next) => next({ ...value, lines: [...value.lines, `a:${payload.id}`] }));
    ctx.on("test/gate", (_p, value, next) => next({ ...value, lines: [...value.lines, "b"] }));
    const out = ctx.waterfall("test/gate", { id: "p1" }, { passed: true, lines: [] });
    expect(out.lines).toEqual(["a:p1", "b"]);
    expect(out.passed).toBe(true);
  });

  it("lets a listener veto by returning without calling next", () => {
    const ctx = new Context();
    ctx.on("test/gate", (_p, value) => ({ passed: false, lines: [...value.lines, "vetoed"] }));
    ctx.on("test/gate", (_p, value, next) => next({ ...value, lines: [...value.lines, "never"] }));
    const out = ctx.waterfall("test/gate", { id: "p1" }, { passed: true, lines: [] });
    expect(out).toEqual({ passed: false, lines: ["vetoed"] });
  });

  it("can inspect what the rest of the chain produced", () => {
    const ctx = new Context();
    ctx.on("test/gate", (_p, value, next) => {
      const downstream = next(value);
      return { ...downstream, lines: [...downstream.lines, "after"] };
    });
    ctx.on("test/gate", (_p, value, next) => next({ ...value, lines: [...value.lines, "inner"] }));
    const out = ctx.waterfall("test/gate", { id: "p1" }, { passed: true, lines: [] });
    expect(out.lines).toEqual(["inner", "after"]);
  });
});

describe("bail", () => {
  it("returns the first non-undefined result and stops", () => {
    const ctx = new Context();
    const calls: string[] = [];
    ctx.on("test/first", () => { calls.push("one"); return undefined; });
    ctx.on("test/first", (n) => { calls.push("two"); return `n=${n}`; });
    ctx.on("test/first", () => { calls.push("three"); return "unused"; });
    expect(ctx.bail("test/first", 7)).toBe("n=7");
    expect(calls).toEqual(["one", "two"]);
  });

  it("returns undefined when every listener declines", () => {
    const ctx = new Context();
    ctx.on("test/first", () => undefined);
    expect(ctx.bail("test/first", 1)).toBeUndefined();
  });
});

describe("listener ownership", () => {
  it("blames the registering plugin when a listener throws", () => {
    const ctx = new Context();
    const noisy: Plugin = {
      id: "test.noisy",
      apply(c) { c.on("test/observe", () => { throw new Error("bad listener"); }); },
    };
    ctx.mount(noisy, undefined, "row-noisy");
    try {
      ctx.emit("test/observe", "x");
      throw new Error("expected a failure");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFailedError);
      expect((err as PluginFailedError).pluginId).toBe("test.noisy");
      expect((err as PluginFailedError).rowId).toBe("row-noisy");
    }
  });

  it("drops a plugin's listeners when its fiber is disposed", () => {
    const ctx = new Context();
    const seen: string[] = [];
    const quiet: Plugin = {
      id: "test.quiet",
      apply(c) { c.on("test/observe", (note) => { seen.push(note); }); },
    };
    const fiber = ctx.mount(quiet, undefined, "row-quiet");
    ctx.emit("test/observe", "first");
    fiber.dispose();
    ctx.emit("test/observe", "second");
    expect(seen).toEqual(["first"]);
  });
});
