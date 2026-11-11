/**
 * The declared-deferred register is load-bearing: `npm run accept` diffs live notImplemented tags against
 * it, so a malformed or self-contradictory register would silently disarm the
 * honesty gate. These tests keep it well-formed in the ordinary suite, not
 * just at battery time.
 */
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegister, validateRegister } from "../register";
import { capabilityChecks } from "../registry";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

describe("declared-deferred register", () => {
  it("parses and validates from disk", () => {
    const reg = loadRegister(REPO_ROOT);
    expect(reg.capabilities.length).toBeGreaterThan(0);
  });

  it("rejects a malformed register loudly", () => {
    expect(() => validateRegister({ capabilities: [] })).toThrow(/schemaVersion/);
    expect(() =>
      validateRegister({
        schemaVersion: "1.0.0",
        updatedAt: "x",
        updatedBy: "x",
        capabilities: [{ id: "a", title: "t", status: "maybe", reason: "r", expectedNotImplementedLayers: [] }],
      }),
    ).toThrow(/status/);
    expect(() =>
      validateRegister({
        schemaVersion: "1.0.0",
        updatedAt: "x",
        updatedBy: "x",
        capabilities: [
          { id: "a", title: "t", status: "declined", reason: "r", expectedNotImplementedLayers: [] },
          { id: "a", title: "t2", status: "declined", reason: "r2", expectedNotImplementedLayers: [] },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it("registry checks and register statuses agree in both directions", () => {
    const reg = loadRegister(REPO_ROOT);
    const registerById = new Map(reg.capabilities.map((c) => [c.id, c]));
    const checkIds = new Set(capabilityChecks.map((c) => c.capabilityId));

    // No duplicate check registrations.
    expect(checkIds.size).toBe(capabilityChecks.length);

    // Every registered check points at a register entry marked shipped.
    for (const check of capabilityChecks) {
      const entry = registerById.get(check.capabilityId);
      expect(entry, `check "${check.capabilityId}" has no register entry`).toBeDefined();
      expect(entry!.status, `check "${check.capabilityId}" registered but status is "${entry!.status}"`).toBe("shipped");
    }

    // Every shipped entry has a registered check: shipped without an anchor
    // assertion is exactly the smoke-check failure mode the battery forbids.
    for (const entry of reg.capabilities) {
      if (entry.status === "shipped") {
        expect(checkIds.has(entry.id), `capability "${entry.id}" declared shipped without an anchor check`).toBe(true);
      }
    }
  });
});
