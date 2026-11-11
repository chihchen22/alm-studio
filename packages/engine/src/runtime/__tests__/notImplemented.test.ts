import { describe, it, expect } from "vitest";
import { NOT_IMPLEMENTED } from "../../contracts/errors";
import {
  makeNotImplemented,
  isNotImplemented,
  NotImplementedError,
} from "../notImplemented";

describe("makeNotImplemented / isNotImplemented", () => {
  it("builds a tagged NotImplemented carrying layer and reason", () => {
    const ni = makeNotImplemented("attribution.new-business", "not wired for prototype");
    expect(ni._tag).toBe(NOT_IMPLEMENTED);
    expect(ni.layer).toBe("attribution.new-business");
    expect(ni.reason).toBe("not wired for prototype");
  });

  it("narrows a union to NotImplemented", () => {
    const slot: number | ReturnType<typeof makeNotImplemented> = makeNotImplemented(
      "eve.duration",
      "rejected",
    );
    if (isNotImplemented(slot)) {
      // Inside the guard the tag is accessible without a cast.
      expect(slot.layer).toBe("eve.duration");
    } else {
      throw new Error("guard should have narrowed to NotImplemented");
    }
  });

  it("rejects values that are not the tag", () => {
    expect(isNotImplemented(42)).toBe(false);
    expect(isNotImplemented(null)).toBe(false);
    expect(isNotImplemented(undefined)).toBe(false);
    expect(isNotImplemented("not-implemented")).toBe(false);
    expect(isNotImplemented({})).toBe(false);
    expect(isNotImplemented({ _tag: "other", layer: "x", reason: "y" })).toBe(false);
    expect(isNotImplemented(new NotImplementedError("x", "y"))).toBe(false);
  });
});

describe("NotImplementedError", () => {
  it("is an Error carrying layer and reason", () => {
    const err = new NotImplementedError("run.dynamic", "reinvestment rules absent");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NotImplementedError");
    expect(err.layer).toBe("run.dynamic");
    expect(err.reason).toBe("reinvestment rules absent");
    expect(err.message).toContain("run.dynamic");
    expect(err.message).toContain("reinvestment rules absent");
  });
});
