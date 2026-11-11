/**
 * The banner an unresolved old address leaves on Workspace Home (spec v3.1 Section 3.3): the address as typed and the
 * workspaces the evidence named. App writes it once when a forward lands on Home; Home reads it once, which clears it,
 * so a reload does not show it twice. Storage is a convenience: where it is blocked the banner is simply not shown.
 */
import type { ForwardBanner } from "./resolveLegacy";

export const FORWARD_BANNER_KEY = "studio.forward-banner";

export function stashForwardBanner(banner: ForwardBanner | null): void {
  try {
    if (banner === null) window.sessionStorage.removeItem(FORWARD_BANNER_KEY);
    else window.sessionStorage.setItem(FORWARD_BANNER_KEY, JSON.stringify(banner));
  } catch {
    // Storage blocked: no banner.
  }
}

export function takeForwardBanner(): ForwardBanner | null {
  try {
    const raw = window.sessionStorage.getItem(FORWARD_BANNER_KEY);
    if (raw === null) return null;
    window.sessionStorage.removeItem(FORWARD_BANNER_KEY);
    const v = JSON.parse(raw) as Partial<ForwardBanner>;
    if (typeof v.oldAddress !== "string" || !Array.isArray(v.candidates)) return null;
    return { oldAddress: v.oldAddress, candidates: v.candidates.filter((c): c is string => typeof c === "string") };
  } catch {
    return null;
  }
}
