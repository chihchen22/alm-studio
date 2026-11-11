/**
 * wholeFamilyKey (ALM Studio Polish 2 C1): the
 * one key bindAssumptions and resolveAssumptions use for two whole-family
 * bindings of one kind on one family. Expected keys are restated here.
 */
import { describe, expect, it } from "vitest";
import { wholeFamilyKey, type BehavioralOverlay, type OverlayBinding } from "../assumptions";

const binding = (overlay: unknown, selector?: OverlayBinding["selector"]): OverlayBinding =>
  ({ familyId: "dda", overlay: overlay as BehavioralOverlay, modelVersion: "v", ...(selector !== undefined ? { selector } : {}) });

describe("wholeFamilyKey", () => {
  it("keys a whole-family binding by family and kind, a plugin kind by its registry name", () => {
    expect(wholeFamilyKey(binding({ kind: "nmd-decay", params: {} }))).toBe("dda::nmd-decay");
    expect(wholeFamilyKey(binding({ kind: "registered", registeredKind: "acme-decay", params: {} }))).toBe("dda::acme-decay");
  });
  it("gives no key to a binding with a selector: its overlap depends on the book's positions", () => {
    expect(wholeFamilyKey(binding({ kind: "nmd-decay", params: {} }, { tier: "retail" }))).toBeNull();
  });
  it("gives no key to an empty selector either: the key reads whether a selector is there, not what it holds (Polish 3)", () => {
    expect(wholeFamilyKey(binding({ kind: "nmd-decay", params: {} }, {}))).toBeNull();
  });
});
