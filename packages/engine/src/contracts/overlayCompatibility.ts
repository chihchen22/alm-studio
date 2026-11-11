/**
 * Which instrument types each built-in overlay kind can drive (D5). The table
 * lives here, in a module with types-only imports, so Studio can read it by
 * path for its family picker without pulling the kernel
 * into a browser bundle. resolveAssumptions re-exports it and its
 * checkOverlayCompatibility stays the one gate that enforces it.
 *
 *  - prepay        -> mortgage (the kernel CPR engine lives on Mortgage), and
 *    the constant-cpr model on fixed-loan as well (overlayInstrumentTypes);
 *  - deposit-beta  -> nmd-b only (the beta S-curve is the NMD-B deposit rate);
 *  - nmd-decay     -> nmd and nmd-b (both NMD books carry the decay kernel);
 *  - cd-rollover   -> fixed-loan (imported CD books still modeled as bullets)
 *    and the W3-A2b "cd" cohort-book arm. On both it remains a
 *    static-runoff no-op that drives only the dynamic new-business module
 *    (applyOverlays.ts); the cd instrument's own renewal logistic is the
 *    kernel's going-concern view, not this overlay.
 *  - commitment-draw -> commitment only (the draw walk lives on the commitment arm)
 *  - loan-client-rate -> mortgage only, because the public kernel client-rate
 *    model is the single-family residential mortgage rate
 */
import type { BuiltinOverlayKind } from "./assumptions";
import type { EngineInstrumentType } from "./position";

export const OVERLAY_INSTRUMENT_COMPATIBILITY: Readonly<
  Record<BuiltinOverlayKind, readonly EngineInstrumentType[]>
> = {
  prepay: ["mortgage"],
  "deposit-beta": ["nmd-b"],
  "nmd-decay": ["nmd", "nmd-b"],
  "cd-rollover": ["fixed-loan", "cd"],
  "commitment-draw": ["commitment"],
  "loan-client-rate": ["mortgage"],
};

/**
 * The one model-level widening of the table. A
 * constant-cpr prepay overlay also drives a level-pay `fixed-loan` (consumer
 * and auto loan books). The four-factor
 * arm stays mortgage only, so the kind-level table above is unchanged.
 */
export const CONSTANT_CPR_EXTRA_INSTRUMENT_TYPES: readonly EngineInstrumentType[] = ["fixed-loan"];

/**
 * The instrument types an overlay of `kind` can drive, given its model when the
 * kind has more than one. Every gate reads this, never the table inline.
 */
export function overlayInstrumentTypes(kind: BuiltinOverlayKind, model?: string): readonly EngineInstrumentType[] {
  const base = OVERLAY_INSTRUMENT_COMPATIBILITY[kind];
  return kind === "prepay" && model === "constant-cpr" ? [...base, ...CONSTANT_CPR_EXTRA_INSTRUMENT_TYPES] : base;
}
