/**
 * The "Standard ALCO" run setup every blank workspace is created with (Studio A+E
 * spec v3.1 Section 3.6 step 7): NII on a 60-month window over a Flat balance
 * sheet, the workspace's default assumption set, EVE at the grid as-of on the
 * all-in basis, the regulatory grid library reference, one path, monthly gap
 * buckets, instrument-level results off.
 *
 * The document holds no workspace-specific value, so identical content is the
 * same document: `rs-<16 hex of contentHash(document with id removed)>`
 * (Section 2.10). `wsId` is accepted so callers read as "the setup this
 * workspace is created with"; it does not enter the bytes.
 */
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import { CURRENT_MODEL_CONVENTION } from "@alm/engine/src/corrections";
import type { RunSetup } from "./types";

/** The five scenarios of the shipped regulatory grid, by library reference. */
export const STANDARD_ALCO_SCENARIO_REFS: readonly string[] = [
  "regulatory-grid-v1#S0",
  "regulatory-grid-v1#S100",
  "regulatory-grid-v1#S-100",
  "regulatory-grid-v1#S200",
  "regulatory-grid-v1#S-200",
];

export const STANDARD_ALCO_NAME = "Standard ALCO";

export function runSetupIdOf(doc: Omit<RunSetup, "id">): string {
  return `rs-${contentHash(doc).slice(0, 16)}`;
}

export function standardAlcoSetup(_wsId: string): RunSetup {
  const body: Omit<RunSetup, "id"> = {
    schemaVersion: "1.0.0",
    name: STANDARD_ALCO_NAME,
    gridHorizonMonths: 360,
    inputs: { book: { role: "base" }, market: { role: "base" }, assumptionSetIds: { kind: "block-default" } },
    scenarios: { kind: "library", refs: [...STANDARD_ALCO_SCENARIO_REFS] },
    plan: {
      planId: null,
      label: STANDARD_ALCO_NAME,
      authoredBy: "person",
      stages: "derived-default",
      reports: [{ id: "r-mgmt", view: "managementView", metrics: ["nii", "eve"] }],
      validationRules: {
        typeGate: ["T1", "T2", "T3", "T4", "T5"],
        routingGate: ["R1", "R2", "R3", "R4"],
      },
    },
    nii: {
      enabled: true,
      horizonMonths: 60,
      reportHorizons: [12, 24, 60],
      basis: { kind: "flat", termMonths: 60, spreadOverIndexBp: 0 },
      path: "single",
    },
    eve: {
      enabled: true,
      discountBasis: "all-in",
      durationMode: "base-only",
      valuationDates: "as-of",
      keyRate: false,
      channels: false,
      path: "single",
    },
    gap: {
      enabled: true,
      repricingBuckets: { kind: "monthly" },
      fixedRateLadder: false,
      liquidity: { enabled: true, flows: "principal", interval: { kind: "monthly" } },
    },
    ftp: { enabled: true },
    instrumentResults: { save: false, coaNodeIds: [] },
    // A new setup carries the corrections.
    modelConvention: CURRENT_MODEL_CONVENTION,
    batch: [],
    importedFrom: null,
    supersedes: null,
    note: "",
  };
  return { id: runSetupIdOf(body), ...body };
}
