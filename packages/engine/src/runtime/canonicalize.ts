// packages/engine/src/runtime/canonicalize.ts
/**
 * The canonical serialization contentHash hashes, split out so a browser bundle
 * (Studio, through macro/targetKey) can read it without node:crypto. Moved
 * unchanged from contentHash.ts (mfu2-b); contentHash re-exports it.
 */

/**
 * Serialize a value to a canonical JSON-ish string with sorted object keys.
 * Deterministic and order-independent for object keys; order-preserving for
 * arrays.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";

  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error(`canonicalize: non-finite number ${String(value)} is not hashable`);
    }
    return JSON.stringify(value);
  }
  if (t === "string" || t === "boolean") {
    return JSON.stringify(value);
  }
  if (t === "bigint") {
    return `"${(value as bigint).toString()}n"`;
  }
  if (t === "function" || t === "symbol") {
    throw new Error(`canonicalize: ${t} is not serializable`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  }

  // Plain object: sort keys, drop undefined-valued keys (JSON semantics).
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${parts.join(",")}}`;
}
