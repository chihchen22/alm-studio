/**
 * Piece 8 (ruling T8a): the NIM bridge shows a Derivatives column
 * only when the engine stored derivativesNet12. Expected values are restated
 * from the fixture literals, never read back from the helper.
 */
import { describe, expect, it } from "vitest";
import type { FtpResult } from "@alm/engine";
import { bridgeHasDerivatives } from "../ftpBridge";

type Bridge = FtpResult["nimBridge"];
const bridge = (extra: Partial<Bridge> = {}): Bridge => ({
  horizonMonths: 12,
  lendingMargin12: 30,
  fundingMargin12: 20,
  mismatchCenter12: -5,
  bridgeNet12: 45,
  niiNet12: 45,
  ...extra,
});

describe("bridgeHasDerivatives", () => {
  it("is false when the bridge carries no derivativesNet12", () => {
    expect(bridgeHasDerivatives(bridge())).toBe(false);
  });
  it("is true when it carries one, a 0 included", () => {
    expect(bridgeHasDerivatives(bridge({ derivativesNet12: 0 }))).toBe(true);
    expect(bridgeHasDerivatives(bridge({ derivativesNet12: -7, bridgeNet12: 38, niiNet12: 38 }))).toBe(true);
  });
});
