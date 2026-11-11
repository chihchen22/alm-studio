// apps/studio/src/__tests__/selectorText.test.ts
/**
 * ALM Studio Polish 2 (A5, Section 5.2 M7): one selector text for Edit a set, By kind
 * and Stack. Expected texts are restated here.
 */
import { describe, expect, it } from "vitest";
import { selectorText } from "../assumptions/selectorText";

describe("selectorText", () => {
  it("reads no selector, or an empty one, as whole family, in lower case: it always sits mid-line", () => {
    expect(selectorText(undefined)).toBe("whole family");
    expect(selectorText({})).toBe("whole family");
  });
  it("reads one tag as tag and value", () => {
    expect(selectorText({ tier: "retail" })).toBe("tier: retail");
  });
  it("sorts tags and values, joins values of one tag with or and tags with and, and drops a repeated value", () => {
    expect(selectorText({ tier: ["b", "a"], region: "west" })).toBe("region: west and tier: a or b");
    expect(selectorText({ tier: ["retail", "retail"] })).toBe("tier: retail");
  });
});
