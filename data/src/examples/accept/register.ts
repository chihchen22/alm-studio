/**
 * Loader + validator for data/src/examples/accept/declared-deferred.json, the
 * declared-deferred register: the list of every capability the plan
 * named, with its shipping status, merged with the entries a loaded pack
 * registers beside its checks (./registry.ts). The register is the honesty mechanism of
 * `npm run accept`: an unshipped capability prints SKIPPED with its reason
 * (it never silently vanishes and never prints as a pass), and a shipped one
 * must carry a real anchor assertion in ./registry.ts.
 *
 * A malformed register is a hard failure, not a skip: if the honesty ledger
 * itself cannot be trusted, no verdict built on it can be.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registeredRegisterEntries } from "./registry";
import type { CapabilityStatus, DeclaredDeferredRegister, RegisterEntry } from "./types";

export const REGISTER_RELATIVE_PATH = "data/src/examples/accept/declared-deferred.json";

const VALID_STATUSES: readonly CapabilityStatus[] = ["shipped", "in-window", "stretch", "declined"];

function fail(msg: string): never {
  throw new Error(`declared-deferred register invalid: ${msg}`);
}

/** Validate a parsed register object. Throws with a precise message on any defect. */
export function validateRegister(raw: unknown): DeclaredDeferredRegister {
  if (typeof raw !== "object" || raw === null) fail("root is not an object");
  const reg = raw as Record<string, unknown>;
  if (typeof reg.schemaVersion !== "string") fail("schemaVersion missing or not a string");
  if (typeof reg.updatedAt !== "string") fail("updatedAt missing or not a string");
  if (typeof reg.updatedBy !== "string") fail("updatedBy missing or not a string");
  if (!Array.isArray(reg.capabilities)) fail("capabilities missing or not an array");

  const seen = new Set<string>();
  for (const [i, c] of (reg.capabilities as unknown[]).entries()) {
    if (typeof c !== "object" || c === null) fail(`capabilities[${i}] is not an object`);
    const e = c as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.length === 0) fail(`capabilities[${i}].id missing`);
    if (seen.has(e.id)) fail(`duplicate capability id "${e.id}"`);
    seen.add(e.id);
    if (typeof e.title !== "string" || e.title.length === 0) fail(`capability "${e.id}": title missing`);
    if (!VALID_STATUSES.includes(e.status as CapabilityStatus))
      fail(`capability "${e.id}": status "${String(e.status)}" not one of ${VALID_STATUSES.join("/")}`);
    if (typeof e.reason !== "string" || e.reason.length === 0) fail(`capability "${e.id}": reason missing`);
    if (e.module !== undefined && typeof e.module !== "string")
      fail(`capability "${e.id}": module must be a string when present`);
    if (
      !Array.isArray(e.expectedNotImplementedLayers) ||
      (e.expectedNotImplementedLayers as unknown[]).some((l) => typeof l !== "string")
    )
      fail(`capability "${e.id}": expectedNotImplementedLayers must be a string array`);
  }
  return reg as unknown as DeclaredDeferredRegister;
}

/** Read the register from disk, append the entries a pack registered, and validate the merged list. */
export function loadRegister(repoRoot: string): DeclaredDeferredRegister {
  const path = resolve(repoRoot, REGISTER_RELATIVE_PATH);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    fail(`cannot read ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    fail(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const extra = registeredRegisterEntries();
  if (extra.length > 0 && typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { capabilities?: unknown }).capabilities)) {
    const reg = parsed as { capabilities: unknown[] };
    parsed = { ...reg, capabilities: [...reg.capabilities, ...extra] };
  }
  return validateRegister(parsed);
}

/** Union of expected runtime notImplemented layers across every entry. */
export function expectedNotImplementedUnion(register: DeclaredDeferredRegister): Set<string> {
  const out = new Set<string>();
  for (const c of register.capabilities) for (const l of c.expectedNotImplementedLayers) out.add(l);
  return out;
}

/** Entries by status, preserving file order. */
export function entriesByStatus(
  register: DeclaredDeferredRegister,
  status: CapabilityStatus,
): RegisterEntry[] {
  return register.capabilities.filter((c) => c.status === status);
}
