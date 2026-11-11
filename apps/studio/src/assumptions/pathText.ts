// apps/studio/src/assumptions/pathText.ts
/**
 * A stored path in Studio's one notation, for display only (ALM Studio Polish 3 T3): each all-digit dotted segment is an
 * array index and prints in brackets, so the engine's `params.buckets.0.label` reads `params.buckets[0].label`, as
 * By kind, Edit a set and the shock builder print it. A segment already in brackets is kept, and an empty path
 * stays empty. The engine's AssumptionDelta.path stays dotted (its contract); the AI rationale, the MCP tools and
 * the old viewer keep that notation.
 */
export function pathText(path: string): string {
  return path
    .split(".")
    .map((seg, i) => (/^\d+$/.test(seg) ? `[${seg}]` : i === 0 ? seg : `.${seg}`))
    .join("");
}
