import { describe, expect, it } from "vitest";
import { applyOverlayToTerms, StaticOverlayError } from "../applyOverlays";
import { EMPTY_DRAW_PATH, type CommitmentTerms } from "../../../commitment";
import type { BehavioralOverlay } from "../../../contracts/assumptions";
import type { PositionTerms } from "../../../contracts/position";
import { OVERLAY_INSTRUMENT_COMPATIBILITY } from "../../../scenario/resolveAssumptions";

const commitment: CommitmentTerms = {
  id: "commit-1",
  type: "commitment",
  notional: 1_000_000,
  maturityMonths: 36,
  originationOffsetMonths: 0,
  amortType: "bullet",
  side: "asset",
  draw: EMPTY_DRAW_PATH,
};

const overlay: BehavioralOverlay = {
  kind: "commitment-draw",
  rampRates: [0.35, 0.15, 0.1],
  steadyRate: 0.02,
};

describe("commitment-draw overlay", () => {
  it("replaces the draw path baked into the terms", () => {
    const out = applyOverlayToTerms(commitment, overlay, "p1") as CommitmentTerms;
    expect(out.draw.rampRates).toEqual([0.35, 0.15, 0.1]);
    expect(out.draw.steadyRate).toBe(0.02);
  });

  it("leaves every other field untouched", () => {
    const out = applyOverlayToTerms(commitment, overlay, "p1") as CommitmentTerms;
    expect(out.notional).toBe(1_000_000);
    expect(out.maturityMonths).toBe(36);
    expect(out.id).toBe("commit-1");
  });

  it("does not mutate the input terms", () => {
    applyOverlayToTerms(commitment, overlay, "p1");
    expect(commitment.draw.rampRates).toEqual([]);
  });

  it("copies the ramp rather than aliasing the overlay's array", () => {
    const mutable: BehavioralOverlay = { kind: "commitment-draw", rampRates: [0.4], steadyRate: 0 };
    const out = applyOverlayToTerms(commitment, mutable, "p1") as CommitmentTerms;
    (mutable as { rampRates: number[] }).rampRates[0] = 0.99;
    expect(out.draw.rampRates).toEqual([0.4]);
  });

  it("throws on a non-commitment position rather than silently doing nothing", () => {
    const notCommitment = { ...commitment, type: "nmd" } as unknown as PositionTerms;
    expect(() => applyOverlayToTerms(notCommitment, overlay, "p1")).toThrow(StaticOverlayError);
    expect(() => applyOverlayToTerms(notCommitment, overlay, "p1")).toThrow(/commitment-draw/);
  });
});

describe("commitment-draw compatibility", () => {
  it("is permitted only on the commitment instrument type", () => {
    expect(OVERLAY_INSTRUMENT_COMPATIBILITY["commitment-draw"]).toEqual(["commitment"]);
  });
});
