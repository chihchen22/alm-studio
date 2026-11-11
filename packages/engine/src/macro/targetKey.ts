// packages/engine/src/macro/targetKey.ts
/**
 * The one identity of a mapped target (mfu2-b): a family and the canonical text
 * of its selector, null for the whole family. The engine's macroTargetKey
 * (runMacro.ts) hashes the selector half of this text; Studio's mappingFor
 * (setEditModel.ts) compares it as is. Both read this module, so the rule for
 * "the same target" has one source. Pure: no node import, so a browser bundle
 * may take it.
 */
import type { DimensionPredicate } from "../contracts/dimensions";
import { canonicalize } from "../runtime/canonicalize";

/** The canonical text of a selector: sorted keys, array order kept, null for none. */
export const macroSelectorText = (selector: DimensionPredicate | undefined): string => canonicalize(selector ?? null);

/** Family, then the selector's canonical text. Two targets are the same target exactly when these are equal. */
export const macroTargetIdentity = (familyId: string, selector: DimensionPredicate | undefined): string =>
  `${familyId}::${macroSelectorText(selector)}`;
