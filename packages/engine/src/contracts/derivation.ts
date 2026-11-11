/**
 * Behavioral-shock derivation contract.
 *
 * Types only, importing one type, so Studio and the reader client can name them
 * by path without pulling the derivation (and its node:crypto hash) into a
 * bundle. The function that produces them is deriveAssumptionSet, in
 * scenario/deriveAssumptionSet.ts.
 *
 * Values are in the unit the parameter is stored in (paramSchema.ts); no op
 * converts a unit.
 */
import type { DimensionPredicate } from "./dimensions";

/**
 * Names one binding of a base set by the key the stack merge uses: family,
 * registry kind (prepay, nmd-decay, deposit-beta, cd-rollover, commitment-draw,
 * loan-client-rate) and selector. It must match exactly one binding.
 */
export interface BindingAddress {
  familyId: string;
  kind: string;
  selector?: DimensionPredicate;
}

/** add: old + value; scale: old * value; set: value. */
export type DerivationOpKind = "add" | "scale" | "set";

/** One change to one number parameter of one binding. */
export interface DerivationOp {
  target: BindingAddress;
  /** A declared number field of the binding's schema, dotted from the overlay (`params.minCpr`). */
  path: string;
  op: DerivationOpKind;
  /** In the field's stored unit; for scale, a dimensionless factor of at least 0. */
  value: number;
}

/** The record a derived set carries: its immediate base and the ops applied, normalized. */
export interface DerivedFrom {
  baseId: string;
  baseContentHash: string;
  ops: DerivationOp[];
}

/** One (binding, path) touched, with the value before and after, computed in the engine. */
export interface DerivationChange {
  bindingIndex: number;
  familyId: string;
  kind: string;
  selector?: DimensionPredicate;
  path: string;
  label: string;
  unit: string;
  from: number;
  to: number;
  /** Indices into the op list, in order, of the ops that touched this path. */
  ops: number[];
}

/** One refusal: where it sits (`ops[2]`, `bindings[0].overlay.params.maxCpr`, `set`) and why. */
export interface DerivationProblem {
  at: string;
  message: string;
}
