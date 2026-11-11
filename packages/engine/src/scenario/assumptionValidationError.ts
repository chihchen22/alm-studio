/**
 * The bind-time refusal of an AssumptionSet. Its own module so that
 * bindAssumptions.ts and macroBindings.ts (whose MacroMappingError extends it)
 * can import each other without a class reaching an uninitialized base.
 * bindAssumptions.ts re-exports it, so every existing import path holds.
 */

/** Thrown when an AssumptionSet is invalid: its shape, a value the parameter schema refuses, or a whole-family duplicate. */
export class AssumptionValidationError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`invalid assumption set at ${field}: ${detail}`);
    this.name = "AssumptionValidationError";
    this.field = field;
  }
}
