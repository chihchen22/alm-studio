// apps/studio/src/__tests__/tenor.test.ts
/**
 * Studio Polish 1 S5: a tenor under a year prints in whole months when it is one; expected labels restated from the spec.
 * Years print with an uppercase Y, the market convention the stored curve terms use (1M, 1Y, 10Y), so Market and Rates
 * spell a tenor alike (Polish 15 item 3).
 */
import { describe, expect, it } from "vitest";
import { tenorLabel } from "../format/tenor";

describe("tenorLabel", () => {
  it("reads the stored 1M tenor and other whole months under a year as months", () => {
    expect(tenorLabel(0.083333)).toBe("1M");
    expect(tenorLabel(0.25)).toBe("3M");
    expect(tenorLabel(0.5)).toBe("6M");
  });
  it("prints years otherwise, to the reader's significant figures, with an uppercase Y (Polish 15)", () => {
    expect(tenorLabel(30)).toBe("30Y");
    expect(tenorLabel(1)).toBe("1Y");
    expect(tenorLabel(0.1)).toBe("0.1Y");
    expect(tenorLabel(0)).toBe("0Y");
  });
});
