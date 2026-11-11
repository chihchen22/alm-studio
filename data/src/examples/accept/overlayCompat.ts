/**
 * Acceptance check: overlay-compat-refusal (honesty defect D5).
 *
 * The cured defect: an overlay bound to a family whose instrument type cannot
 * consume it used to be SILENTLY SKIPPED (the run stayed green against the
 * caller's stated intent). Anchor: the
 * module's own documented contract — each formerly-silent site now throws a
 * typed IncompatibleOverlayError naming family, overlay kind, instrument type,
 * and the permitted set. One line per formerly-silent site:
 *
 *   1. deposit-beta bound to a NON-interest-bearing NMD family (type "nmd");
 *   2. prepay bound to a fixed-loan family;
 *   3. nmd-decay bound to a loan family.
 *
 * Plus the sentinel: a compatible binding set still resolves (the refusal did
 * not over-reach).
 */
import { BETA_S_CURVE_DEFAULTS, MBS_DEFAULTS, NMD_DEFAULTS } from "@alm/kernel";
import type { AssumptionSet, ChartOfAccounts } from "@alm/engine";
import {
  IncompatibleOverlayError,
  resolveAssumptions,
} from "@alm/engine/src/scenario/resolveAssumptions";
import { smallCoa } from "./handBooks";
import type { CapabilityCheck, CheckLine } from "./types";

function setOf(bindings: AssumptionSet["bindings"]): AssumptionSet {
  return { schemaVersion: "1.0.0", id: "accept-compat", label: "compat probe", bindings };
}

function refusal(
  id: string,
  coa: ChartOfAccounts,
  set: AssumptionSet,
  wantFamily: string,
  wantKind: string,
  wantType: string,
): CheckLine {
  try {
    resolveAssumptions(set, coa.families);
    return {
      id,
      status: "fail",
      detail: `${wantKind} on a ${wantType} family resolved without error — the D5 silent skip is back`,
    };
  } catch (err) {
    const e = err as IncompatibleOverlayError;
    const ok =
      e instanceof Error &&
      e.name === "IncompatibleOverlayError" &&
      (e as IncompatibleOverlayError).familyId === wantFamily &&
      String((e as IncompatibleOverlayError).overlayKind) === wantKind &&
      String((e as IncompatibleOverlayError).instrumentType) === wantType;
    return {
      id,
      status: ok ? "pass" : "fail",
      detail: ok
        ? `${wantKind} on family "${wantFamily}" (type ${wantType}) throws typed ` +
          `IncompatibleOverlayError naming family/kind/type (anchor: the documented ` +
          `anti-fabrication contract; formerly a silent skip)`
        : `expected IncompatibleOverlayError(${wantFamily}, ${wantKind}, ${wantType}); got ${e?.name}: ${e?.message}`,
    };
  }
}

export const overlayCompatCheck: CapabilityCheck = {
  capabilityId: "overlay-compat-refusal",
  title: "D5: overlay-to-instrument incompatibility throws typed",
  run() {
    const lines: CheckLine[] = [];
    const coa = smallCoa([
      { id: "FIXED", side: "asset", instrumentType: "fixed-loan" },
      { id: "MORT", side: "asset", instrumentType: "mortgage" },
      { id: "DDA", side: "liability", instrumentType: "nmd" },
      { id: "MMA", side: "liability", instrumentType: "nmd-b" },
    ]);

    lines.push(
      refusal(
        "deposit-beta-on-non-ib",
        coa,
        setOf([
          { familyId: "DDA", modelVersion: "v1", overlay: { kind: "deposit-beta", params: BETA_S_CURVE_DEFAULTS } },
        ]),
        "DDA",
        "deposit-beta",
        "nmd",
      ),
      refusal(
        "prepay-on-fixed",
        coa,
        setOf([
          { familyId: "FIXED", modelVersion: "v1", overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS } },
        ]),
        "FIXED",
        "prepay",
        "fixed-loan",
      ),
      refusal(
        "decay-on-loan",
        coa,
        setOf([
          { familyId: "FIXED", modelVersion: "v1", overlay: { kind: "nmd-decay", params: NMD_DEFAULTS } },
        ]),
        "FIXED",
        "nmd-decay",
        "fixed-loan",
      ),
    );

    // Sentinel: a compatible binding still resolves (no over-reach).
    try {
      const resolved = resolveAssumptions(
        setOf([
          { familyId: "MMA", modelVersion: "v1", overlay: { kind: "deposit-beta", params: BETA_S_CURVE_DEFAULTS } },
          { familyId: "DDA", modelVersion: "v1", overlay: { kind: "nmd-decay", params: NMD_DEFAULTS } },
        ]),
        coa.families,
      );
      const n = resolved.overlays.length;
      lines.push({
        id: "compatible-still-resolves",
        status: n === 2 ? "pass" : "fail",
        detail: `compatible bindings (deposit-beta on nmd-b, nmd-decay on nmd) resolve to ${n}/2 overlays — the gate refuses only genuine misbindings`,
      });
    } catch (err) {
      lines.push({
        id: "compatible-still-resolves",
        status: "fail",
        detail: `compatible binding set threw: ${(err as Error).message}`,
      });
    }

    return { lines, observedNotImplemented: [] };
  },
};
