import type { FtpResult } from "@alm/engine";

/**
 * The NIM bridge shows a Derivatives column only when the engine
 * stored `derivativesNet12`. The key is absent on every book without a
 * derivative family, so the panel then renders exactly as before; on a hedged
 * book the visible parts (lending, funding, mismatch, derivatives) sum to
 * bridge net.
 */
export function bridgeHasDerivatives(bridge: FtpResult["nimBridge"]): boolean {
  return bridge.derivativesNet12 !== undefined;
}
