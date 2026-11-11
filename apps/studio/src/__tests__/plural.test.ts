import { describe, expect, it } from "vitest";
import { plural, pluralNoun } from "../rows/plural";

describe("plural (Studio Part 2 m8)", () => {
  it("one takes the singular; zero and many take the plural", () => {
    expect(plural(0, "set", "sets")).toBe("0 sets");
    expect(plural(1, "set", "sets")).toBe("1 set");
    expect(plural(2, "set", "sets")).toBe("2 sets");
    expect(plural(1, "derived market", "derived markets")).toBe("1 derived market");
  });
  it("the noun alone follows the same rule", () => {
    expect(pluralNoun(1, "done run", "done runs")).toBe("done run");
    expect(pluralNoun(0, "done run", "done runs")).toBe("done runs");
  });
});
