/**
 * curveLineOf, the one server helper that names the
 * curve a stored run built on. The stamp wins when the run carries one; a run stored without one
 * reads the setup its stored request pinned, and otherwise curve default version 1, linear in zero.
 * A stamp this server does not read is "unknown", never a throw. Every sentence is restated by hand.
 */
import { describe, expect, it } from "vitest";
import { curveLineOf } from "../curveLine";

const V2 = "Curve: platform default v2, log-linear on discount factor";
const V1 = "Curve: platform default v1, linear in zero";

/** A stored request market: only the keys the helper reads matter. */
const market = (over: Record<string, unknown> = {}) => ({ calibrationDate: "2026-03-31", curveQuotes: [], ...over });
const setupBlock = { id: "seed-log-linear-df", label: "Seed log-linear-df", interpolation: "log-linear-df", inputs: [] };

describe("curveLineOf, a stamped run", () => {
  it("reads the version 2 default", () => {
    expect(curveLineOf({ kind: "default", version: 2 }, market())).toEqual({
      line: V2,
      value: "platform default v2, log-linear on discount factor",
      from: "stamp",
    });
  });

  it("reads the version 1 default, which a market marked curveDefault: 1 stamps", () => {
    expect(curveLineOf({ kind: "default", version: 1 }, market({ curveDefault: 1 }))).toEqual({
      line: V1,
      value: "platform default v1, linear in zero",
      from: "stamp",
    });
  });

  it("names the reason of a fallback to version 1", () => {
    const reason = "quote 3W at 0.0575 years is not within 0.0001 years of a whole month";
    expect(curveLineOf({ kind: "default", version: 1, reason }, market())).toEqual({
      line: "Curve: platform default v1, linear in zero (fallback: quote 3W at 0.0575 years is not within 0.0001 years of a whole month)",
      value: "platform default v1, linear in zero (fallback: quote 3W at 0.0575 years is not within 0.0001 years of a whole month)",
      from: "stamp",
    });
  });

  it("names a setup by the label its stored request carries, then its id", () => {
    expect(curveLineOf({ kind: "setup", id: "seed-log-linear-df" }, market({ curveSetup: setupBlock }))).toEqual({
      line: "Curve: setup Seed log-linear-df (seed-log-linear-df)",
      value: "setup Seed log-linear-df (seed-log-linear-df)",
      from: "stamp",
    });
  });

  it("names a setup by its id alone when the request carries no matching label", () => {
    expect(curveLineOf({ kind: "setup", id: "cs-1" }, market()).line).toBe("Curve: setup cs-1");
    expect(curveLineOf({ kind: "setup", id: "cs-1" }, market({ curveSetup: setupBlock })).line).toBe("Curve: setup cs-1");
    expect(curveLineOf({ kind: "setup", id: "cs-1" }, undefined).line).toBe("Curve: setup cs-1");
  });

  it("reads a stamp it does not know as unknown, and never throws", () => {
    const unknown = { line: "Curve: unknown", value: "unknown", from: "stamp" };
    for (const stamp of [
      { kind: "mystery" },
      { kind: "default", version: 3 },
      { kind: "default", version: "2" },
      { kind: "setup" },
      { kind: "setup", id: 7 },
      { kind: "setup", id: "" },
      { kind: "default", version: 1, reason: 5 },
      null,
      "v2",
      42,
      [],
    ]) {
      expect(curveLineOf(stamp, market()), JSON.stringify(stamp)).toEqual(unknown);
    }
  });
});

describe("curveLineOf, a run stored without a stamp", () => {
  it("reads the setup the stored request pinned", () => {
    expect(curveLineOf(undefined, market({ curveSetup: setupBlock }))).toEqual({
      line: "Curve: setup Seed log-linear-df (seed-log-linear-df)",
      value: "setup Seed log-linear-df (seed-log-linear-df)",
      from: "request-setup",
    });
  });

  it("reads a pinned setup with no readable id by what it is", () => {
    expect(curveLineOf(undefined, market({ curveSetup: { label: "x" } })).line).toBe("Curve: setup, not named in the stored request");
  });

  it("reads version 1, linear in zero, with no setup, with the marker, or with no stored request", () => {
    const v1 = { line: V1, value: "platform default v1, linear in zero", from: "unstamped" };
    expect(curveLineOf(undefined, market())).toEqual(v1);
    expect(curveLineOf(undefined, market({ curveDefault: 1 }))).toEqual(v1);
    expect(curveLineOf(undefined, undefined)).toEqual(v1);
    expect(curveLineOf(undefined, "not a market")).toEqual(v1);
  });
});
