import { describe, expect, it } from "vitest";
import { spreadAt } from "../spreadAt";
const curve = (spreads: { tenorMonths: number; spreadBp: number }[]) => ({ id: "ust-sofr", label: "UST over SOFR", base: "platform-default", spreads });

describe("spreadAt", () => {
  it("reads a grid point exactly, in decimal", () => {
    expect(spreadAt(curve([{ tenorMonths: 3, spreadBp: 12 }, { tenorMonths: 12, spreadBp: 20 }]), 3)).toBe(0.0012);
  });
  it("is linear in tenor months between rows", () => {
    expect(spreadAt(curve([{ tenorMonths: 3, spreadBp: 12 }, { tenorMonths: 12, spreadBp: 30 }]), 6)).toBeCloseTo(0.0018, 15);
  });
  it("is flat before the first and after the last row", () => {
    const c = curve([{ tenorMonths: 3, spreadBp: 12 }, { tenorMonths: 12, spreadBp: 30 }]);
    expect(spreadAt(c, 1)).toBe(0.0012);
    expect(spreadAt(c, 360)).toBe(0.003);
  });
  it("reads a one-row grid flat everywhere", () => {
    const c = curve([{ tenorMonths: 6, spreadBp: -5 }]);
    expect([1, 6, 12].map((n) => spreadAt(c, n))).toEqual([-0.0005, -0.0005, -0.0005]);
  });
  it("reads an interior grid point exactly on a three-row grid", () => {
    const c = curve([{ tenorMonths: 1, spreadBp: 5 }, { tenorMonths: 12, spreadBp: 20 }, { tenorMonths: 60, spreadBp: 44 }]);
    expect(spreadAt(c, 12)).toBe(0.002);
    expect(spreadAt(c, 36)).toBeCloseTo(0.0032, 15);
  });
});
