/**
 * The artifact shelf. One per run, a plain Map keyed on the
 * canonical string of (contract type, scope, producer stage id).
 *
 * The producer is part of the key because two stages may honestly produce one
 * type: the contractual pass and the balance stage both produce Cashflow at
 * scenario scope, the first the static series EVE and gap read and the second
 * the primary series NII reads. That is what the pre-1c pipeline did with two
 * local variables; the graph says it with two edges.
 *
 * The shelf stores values as `unknown`. The contract type name is the PLAN's
 * vocabulary, not a run-time type check: the stage functions own the payload
 * types and each one states them in its own signature.
 */
import type { ArtifactScope, ContractTypeName } from "../contracts/plan";
import { scopeKey } from "../contracts/plan";
import { ArtifactConflictError, ArtifactMissingError } from "./executorErrors";

/** One shelf slot as a reader sees it: the key, never the value. */
export interface ShelfEntry {
  type: ContractTypeName;
  scope: ArtifactScope;
  producerStageId: string;
}

export interface Shelf {
  /** Throws ArtifactConflictError when the key is already held. */
  put(type: ContractTypeName, scope: ArtifactScope, producerStageId: string, value: unknown): void;
  /** Throws ArtifactMissingError when nothing put this key. */
  get<T>(type: ContractTypeName, scope: ArtifactScope, producerStageId: string): T;
  has(type: ContractTypeName, scope: ArtifactScope, producerStageId: string): boolean;
  /** Put order, which is walk order. Callers may not mutate the shelf through it. */
  entries(): readonly ShelfEntry[];
}

/** The canonical key of one artifact slot. Distinct triples give distinct strings. */
export function artifactKey(
  type: ContractTypeName,
  scope: ArtifactScope,
  producerStageId: string,
): string {
  return `${type}|${scopeKey(scope)}|${producerStageId}`;
}

export function makeShelf(): Shelf {
  const values = new Map<string, unknown>();
  const order: ShelfEntry[] = [];
  const owners = new Map<string, string>();
  return {
    put(type, scope, producerStageId, value) {
      const key = artifactKey(type, scope, producerStageId);
      if (values.has(key)) {
        throw new ArtifactConflictError(type, scope, owners.get(key) ?? producerStageId, producerStageId);
      }
      values.set(key, value);
      owners.set(key, producerStageId);
      order.push({ type, scope, producerStageId });
    },
    get<T>(type: ContractTypeName, scope: ArtifactScope, producerStageId: string): T {
      const key = artifactKey(type, scope, producerStageId);
      if (!values.has(key)) {
        throw new ArtifactMissingError(producerStageId, type, scope, "producer");
      }
      return values.get(key) as T;
    },
    has(type, scope, producerStageId) {
      return values.has(artifactKey(type, scope, producerStageId));
    },
    entries() {
      return order;
    },
  };
}
