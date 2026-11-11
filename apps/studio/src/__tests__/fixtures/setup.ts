/**
 * Run setup fixtures for Task E5, written by hand from spec v3.1 Section 5.2 and Section 3.6 step 7 (the
 * Standard ALCO document a blank workspace is created with), not read from the server's `standardAlco.ts`.
 */
import type { ScenarioLibrary } from "@alm/engine";
import type { ReadinessItem, RunSetup, ScenarioSlate, ValidateSetupReply } from "@alm/reader";
import { FLAT_STAGES } from "./stages";

export const STANDARD_ALCO: RunSetup = {
  schemaVersion: "1.0.0",
  id: "rs-standard-alco",
  name: "Standard ALCO",
  gridHorizonMonths: 360,
  inputs: { book: { role: "base" }, market: { role: "base" }, assumptionSetIds: { kind: "block-default" } },
  scenarios: { kind: "library", refs: ["regulatory-grid-v1#S0", "regulatory-grid-v1#S100", "regulatory-grid-v1#S-100", "regulatory-grid-v1#S200", "regulatory-grid-v1#S-200"] },
  plan: {
    planId: null,
    label: "Standard ALCO",
    authoredBy: "person",
    stages: "derived-default",
    reports: [{ id: "r-mgmt", view: "managementView", metrics: ["nii", "eve"] }],
    validationRules: { typeGate: ["T1", "T2", "T3", "T4", "T5"], routingGate: ["R1", "R2", "R3", "R4"] },
  },
  nii: { enabled: true, horizonMonths: 60, reportHorizons: [12, 24, 60], basis: { kind: "flat", termMonths: 60, spreadOverIndexBp: 0 }, path: "single" },
  eve: { enabled: true, discountBasis: "all-in", durationMode: "base-only", valuationDates: "as-of", keyRate: false, channels: false, path: "single" },
  gap: { enabled: true, repricingBuckets: { kind: "monthly" }, fixedRateLadder: false, liquidity: { enabled: true, flows: "principal", interval: { kind: "monthly" } } },
  ftp: { enabled: true },
  instrumentResults: { save: false, coaNodeIds: [] },
  batch: [],
  importedFrom: null,
  supersedes: null,
  note: "",
};

export const RUNOFF_SETUP: RunSetup = { ...STANDARD_ALCO, id: "rs-runoff", name: "Runoff view", nii: { ...STANDARD_ALCO.nii, basis: { kind: "runoff" } } };
export const CUSTOM_SETUP: RunSetup = { ...STANDARD_ALCO, id: "rs-custom", name: "Targets", nii: { ...STANDARD_ALCO.nii, basis: { kind: "custom", balancePlanId: "balance-targets-demo-v1" } } };

export const LIBRARIES: ScenarioLibrary[] = [
  {
    schemaVersion: "1.0.0",
    id: "regulatory-grid-v1",
    label: "Regulatory parallel grid: base, +/-100, +/-200 bp, immediate",
    scenarios: [
      { id: "S0", label: "S0", rateSpec: { kind: "base" } },
      { id: "S100", label: "S100", rateSpec: { kind: "parallel", shockBp: 100 } },
      { id: "S-100", label: "S-100", rateSpec: { kind: "parallel", shockBp: -100 } },
      { id: "S200", label: "S200", rateSpec: { kind: "parallel", shockBp: 200 } },
      { id: "S-200", label: "S-200", rateSpec: { kind: "parallel", shockBp: -200 } },
    ],
  },
  {
    schemaVersion: "1.0.0",
    id: "steepener-v1",
    label: "Steepener: 0 at the front, +100 bp at the long end, pivot 5y",
    scenarios: [{ id: "STEEP100", label: "Steepener +100 long", rateSpec: { kind: "twist", shortBp: 0, longBp: 100, pivotYears: 5 } }],
  },
];

export const SLATES: ScenarioSlate[] = [
  {
    id: "alco-user-slate",
    label: "ALCO user shocks",
    scenarios: [
      { id: "BASE", label: "Base", rateSpec: { kind: "base" } },
      { id: "KN-1-5-10", label: "Knots 1y, 5y, 10y", rateSpec: { kind: "custom", shocks: [{ tenorYears: 1, shockBp: 25 }, { tenorYears: 5, shockBp: 50 }, { tenorYears: 10, shockBp: 75 }] } },
    ],
  } as ScenarioSlate,
];

/** A validation that passed with a warning the server still emits (setupCompile.ts warningsOf, EVE valuation at later dates; slice B2 honours the fixed-rate ladder), the shape the validate route replies. */
export const VALIDATION_WARN: ValidateSetupReply = {
  outcome: "warn",
  basisLabel: "Flat (simple top-up)",
  basisByScenario: { S0: { kind: "flat" }, S100: { kind: "flat" } },
  skippedFamilies: ["swaps", "preferred"],
  reports: {
    type: { passed: true, failures: [], checked: ["T1 st-cashflow"] },
    routing: { passed: true, failures: [], checked: ["R1 st-prepay"] },
    warnings: ["EVE: valuation at later dates is reserved for a later release; Results show present value as of the grid as-of."],
    notImplemented: [],
    readiness: { blocking: [], acknowledgeable: ["run/setup-warnings"] },
  },
  compiledChain: FLAT_STAGES,
  planId: "ws-0123456789-abcdef012345",
  consumed: {},
};

export const ITEMS: ReadinessItem[] = [
  { section: "market", item: "Base snapshot", state: "valid", required: true, detail: "set" },
  { section: "balance", item: "Positions", state: "not-set", required: true, detail: "no book" },
  { section: "run", item: "Run setups", state: "warning", required: true, detail: "validated with warnings" },
];
