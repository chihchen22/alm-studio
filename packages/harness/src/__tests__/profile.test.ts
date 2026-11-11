import { describe, expect, it } from "vitest";
import { Context, type Plugin } from "../context";
import {
  CanonicalJsonError,
  DuplicateRowError,
  InvalidPatchError,
  UnknownPluginError,
  UnknownRowError,
  UnmetDependencyError,
} from "../errors";
import { canonicalJson, composeProfile, mountProfile, profileHash, type Patch, type Profile } from "../profile";

declare module "../types" {
  interface Services {
    "test.one": { value: number };
    "test.two": { value: number };
    "test.three": { value: number };
    "test.absent": { value: number };
  }
}

const base: Profile = {
  rows: [
    { id: "r-one", plugin: "test.p.one", config: { value: 1 } },
    { id: "r-two", plugin: "test.p.two", config: { value: 2 } },
  ],
};

describe("composeProfile", () => {
  it("returns the base unchanged when no layer is applied", () => {
    expect(composeProfile(base, [])).toEqual(base);
  });

  it("does not mutate the base", () => {
    composeProfile(base, [{ label: "L", patches: [{ disable: "r-one" }] }]);
    expect(base.rows[0].disabled).toBeUndefined();
  });

  it("replaces a row's whole config with set", () => {
    const out = composeProfile(base, [{ label: "L", patches: [{ set: { id: "r-one", config: { value: 9 } } }] }]);
    expect(out.rows[0].config).toEqual({ value: 9 });
    expect(out.rows[1].config).toEqual({ value: 2 });
  });

  it("disables and re-enables a row", () => {
    const off = composeProfile(base, [{ label: "L", patches: [{ disable: "r-two" }] }]);
    expect(off.rows[1].disabled).toBe(true);
    const on = composeProfile(off, [{ label: "M", patches: [{ enable: "r-two" }] }]);
    expect(on.rows[1].disabled).toBeUndefined();
  });

  it("refuses a patch that names none of the four shapes", () => {
    try {
      composeProfile(base, [{ label: "bank-policy", patches: [{} as Patch] }]);
      throw new Error("expected a failure");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidPatchError);
      expect((err as InvalidPatchError).layerLabel).toBe("bank-policy");
    }
  });

  it("inserts after a named row and appends when after is absent", () => {
    const after = composeProfile(base, [
      { label: "L", patches: [{ insert: { id: "r-mid", plugin: "test.p.mid" }, after: "r-one" }] },
    ]);
    expect(after.rows.map((r) => r.id)).toEqual(["r-one", "r-mid", "r-two"]);
    const appended = composeProfile(base, [{ label: "L", patches: [{ insert: { id: "r-end", plugin: "test.p.end" } }] }]);
    expect(appended.rows.map((r) => r.id)).toEqual(["r-one", "r-two", "r-end"]);
  });

  it("indexes an inserted row at once, so a later patch in the same layer can target it", () => {
    const out = composeProfile(base, [
      {
        label: "L",
        patches: [
          { insert: { id: "r-new", plugin: "test.p.new", config: { value: 0 } } },
          { set: { id: "r-new", config: { value: 42 } } },
        ],
      },
    ]);
    expect(out.rows[2].config).toEqual({ value: 42 });
  });

  it("throws UnknownRowError naming the layer and the row id", () => {
    try {
      composeProfile(base, [{ label: "bank-policy", patches: [{ disable: "r-nope" }] }]);
      throw new Error("expected a failure");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownRowError);
      expect((err as UnknownRowError).layerLabel).toBe("bank-policy");
      expect((err as UnknownRowError).rowId).toBe("r-nope");
    }
  });

  it("throws DuplicateRowError on a duplicate id in the base and on a colliding insert", () => {
    const dup: Profile = { rows: [{ id: "r-one", plugin: "a" }, { id: "r-one", plugin: "b" }] };
    expect(() => composeProfile(dup, [])).toThrow(DuplicateRowError);
    expect(() =>
      composeProfile(base, [{ label: "L", patches: [{ insert: { id: "r-one", plugin: "x" } }] }]),
    ).toThrow(DuplicateRowError);
  });
});

describe("profileHash", () => {
  it("is stable across config key order", () => {
    const a: Profile = { rows: [{ id: "r", plugin: "p", config: { x: 1, y: 2 } }] };
    const b: Profile = { rows: [{ id: "r", plugin: "p", config: { y: 2, x: 1 } }] };
    expect(profileHash(a)).toBe(profileHash(b));
  });

  it("changes when a row changes and when row order changes", () => {
    const a: Profile = { rows: [{ id: "r", plugin: "p", config: { x: 1 } }] };
    const b: Profile = { rows: [{ id: "r", plugin: "p", config: { x: 2 } }] };
    expect(profileHash(a)).not.toBe(profileHash(b));
    const one: Profile = { rows: [{ id: "a", plugin: "p" }, { id: "b", plugin: "q" }] };
    const two: Profile = { rows: [{ id: "b", plugin: "q" }, { id: "a", plugin: "p" }] };
    expect(profileHash(one)).not.toBe(profileHash(two));
  });

  it("is a 64-character lowercase hex digest", () => {
    expect(profileHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is unchanged by a disable-then-enable round trip", () => {
    const round = composeProfile(base, [
      { label: "L", patches: [{ disable: "r-one" }] },
      { label: "M", patches: [{ enable: "r-one" }] },
    ]);
    expect(profileHash(round)).toBe(profileHash(base));
  });
});

describe("canonicalJson", () => {
  it("refuses a non-finite number with a HarnessError naming the path", () => {
    try {
      canonicalJson({ rows: [{ config: { beta: Number.NaN } }] });
      throw new Error("expected a failure");
    } catch (err) {
      expect(err).toBeInstanceOf(CanonicalJsonError);
      expect((err as CanonicalJsonError).path).toBe("rows[0].config.beta");
      expect((err as CanonicalJsonError).message).toMatch(/non-finite/);
    }
  });
});

describe("mountProfile", () => {
  const pOne: Plugin<{ value: number }> = {
    id: "test.p.one",
    apply(ctx, config) { ctx.provide("test.one", { value: config.value }); },
  };
  const pTwo: Plugin<{ value: number }> = {
    id: "test.p.two",
    inject: ["test.one"],
    apply(ctx, config) { ctx.provide("test.two", { value: config.value + ctx.get("test.one").value }); },
  };
  const catalog = new Map<string, Plugin<any>>([["test.p.one", pOne], ["test.p.two", pTwo]]);

  it("mounts every enabled row and finalizes", () => {
    const ctx = mountProfile(base, catalog);
    expect(ctx).toBeInstanceOf(Context);
    expect(ctx.get("test.two").value).toBe(3);
  });

  it("skips a disabled row, and finalize then refuses the tree that needed it", () => {
    const off = composeProfile(base, [{ label: "L", patches: [{ disable: "r-one" }] }]);
    expect(() => mountProfile(off, catalog)).toThrow(/never activated/);
  });

  it("throws UnknownPluginError naming the row and the plugin", () => {
    const bad: Profile = { rows: [{ id: "r-x", plugin: "test.p.absent" }] };
    try {
      mountProfile(bad, catalog);
      throw new Error("expected a failure");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownPluginError);
      expect((err as UnknownPluginError).rowId).toBe("r-x");
      expect((err as UnknownPluginError).pluginId).toBe("test.p.absent");
    }
  });

  it("validates the whole catalog before mounting anything", () => {
    const applied: string[] = [];
    const pSpy: Plugin<undefined> = {
      id: "test.p.spy",
      apply(ctx) {
        applied.push("spy");
        ctx.provide("test.three", { value: 0 });
      },
    };
    const withSpy = new Map(catalog).set("test.p.spy", pSpy);
    const profile: Profile = {
      rows: [
        { id: "r-spy", plugin: "test.p.spy" },
        { id: "r-one", plugin: "test.p.one", config: { value: 1 } },
        { id: "r-gone", plugin: "test.p.absent" },
      ],
    };
    expect(() => mountProfile(profile, withSpy)).toThrow(UnknownPluginError);
    expect(applied).toEqual([]);
  });

  it("unwinds what it mounted when finalize refuses, and rethrows the original error", () => {
    const torn: string[] = [];
    const pEffect: Plugin<undefined> = {
      id: "test.p.effect",
      apply(ctx) {
        ctx.provide("test.three", { value: 0 });
        ctx.effect(() => () => {
          torn.push("effect");
        });
      },
    };
    const pStranded: Plugin<undefined> = {
      id: "test.p.stranded",
      inject: ["test.absent"],
      apply() {
        throw new Error("must never run");
      },
    };
    const withBoth = new Map<string, Plugin<any>>([
      ["test.p.effect", pEffect],
      ["test.p.stranded", pStranded],
    ]);
    const profile: Profile = {
      rows: [
        { id: "r-effect", plugin: "test.p.effect" },
        { id: "r-stranded", plugin: "test.p.stranded" },
      ],
    };
    expect(() => mountProfile(profile, withBoth)).toThrow(UnmetDependencyError);
    expect(torn).toEqual(["effect"]);
  });

  it("mounts in row order and resolves activation order from inject", () => {
    const reversed: Profile = { rows: [base.rows[1], base.rows[0]] };
    const ctx = mountProfile(reversed, catalog);
    expect(ctx.get("test.two").value).toBe(3);
  });
});
