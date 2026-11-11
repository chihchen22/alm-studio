/**
 * The banner an unresolved old address leaves on Workspace Home (spec v3.1 Section 3.3). Studio tests have no DOM, so
 * `window.sessionStorage` is a small fake: written once by App, read once by Home, which clears it. Storage that
 * throws (a private window, blocked site data) shows no banner and breaks nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FORWARD_BANNER_KEY, stashForwardBanner, takeForwardBanner } from "../forwardBanner";

function fakeStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, v); },
  };
}

const g = globalThis as unknown as { window?: unknown };
let before: unknown;
let store: ReturnType<typeof fakeStorage>;
beforeEach(() => {
  before = g.window;
  store = fakeStorage();
  g.window = { sessionStorage: store };
});
afterEach(() => {
  g.window = before;
});

describe("the forward banner", () => {
  it("is stored under studio.forward-banner and read once", () => {
    expect(FORWARD_BANNER_KEY).toBe("studio.forward-banner");
    stashForwardBanner({ oldAddress: "#/plan?book=x", candidates: ["ws-a", "ws-b"] });
    expect(store.map.has("studio.forward-banner")).toBe(true);
    expect(takeForwardBanner()).toEqual({ oldAddress: "#/plan?book=x", candidates: ["ws-a", "ws-b"] });
    expect(takeForwardBanner()).toBeNull();
    expect(store.map.size).toBe(0);
  });
  it("stashing none clears an earlier banner", () => {
    stashForwardBanner({ oldAddress: "#/run", candidates: [] });
    stashForwardBanner(null);
    expect(takeForwardBanner()).toBeNull();
  });
  it("a value that is not a banner reads as none", () => {
    store.setItem("studio.forward-banner", "not json");
    expect(takeForwardBanner()).toBeNull();
    store.setItem("studio.forward-banner", JSON.stringify({ oldAddress: 3 }));
    expect(takeForwardBanner()).toBeNull();
  });
  it("storage that throws shows no banner and breaks nothing", () => {
    g.window = { sessionStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } } };
    expect(() => stashForwardBanner({ oldAddress: "#/x", candidates: [] })).not.toThrow();
    expect(takeForwardBanner()).toBeNull();
  });
});
