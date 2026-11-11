/**
 * Capability-check registry (W1-V1 scaffold; W3-V2 owns the imports).
 *
 * Convention: a module that ships a capability adds accept/<capability>.ts
 * exporting a CapabilityCheck, imports it here, and in the SAME commit flips
 * the capability's status to "shipped" in accept/declared-deferred.json.
 * A pack registers its own checks with their register entries through
 * registerCapabilityChecks; the battery reads allCapabilityChecks().
 * The driver enforces both directions: a "shipped" entry with no check fails,
 * and a registered check for a non-"shipped" entry fails. Nothing ships
 * silently and nothing skips silently.
 *
 * W3-V2 registration (2026-08-03): one check per capability that actually
 * shipped in the platform-v2 window, in shipping order. Each check asserts the
 * capability's INDEPENDENT ANCHOR from — a
 * hand computation, a kernel identity, a degeneracy limit, or a byte-parity
 * proof — never merely that code ran.
 */
import type { CapabilityCheck, RegisterEntry } from "./types";
import { kernelGateCheck } from "./kernelGate";
import { overlayCompatCheck } from "./overlayCompat";
import { floaterBandingCheck } from "./floaterBanding";
import { nmdbSplitCheck } from "./nmdbSplit";
import { shortfallsCheck } from "./shortfalls";
import { platformLoopCheck } from "./platformLoop";
import { intakeCheck } from "./intake";
import { workbenchUiCheck } from "./workbenchUi";
import { ftpCheck } from "./ftp";
import { cdCompetingRiskCheck } from "./cd";
import { seasoningCheck } from "./seasoning";
import { stochasticCheck } from "./stochastic";
import { keyRateCheck } from "./keyRate";
import { customVectorCheck } from "./customVector";
import { niiCheck } from "./nii";
import { databaseCheck } from "./database";
import { catalogCheck } from "./catalog";
import { indexHistoryCheck } from "./indexHistory";
import { replicaTieOutCheck } from "./replicaTieOut";
import { featureDemosCheck, perPositionCheck, segEarCheck } from "./featureDemos";
import { componentDecayCheck, creditScenarioCheck, fullBetaFormCheck, replicatingPortfolioCheck } from "./depositForms";
import { survivalPathCheck } from "./survivalPath";

export const capabilityChecks: CapabilityCheck[] = [
  // Wave 1 — honesty backlog and the platform skeleton.
  kernelGateCheck,
  overlayCompatCheck,
  floaterBandingCheck,
  nmdbSplitCheck,
  shortfallsCheck,
  platformLoopCheck,
  intakeCheck,
  workbenchUiCheck,
  // Wave 2 — analytics and the engine seam.
  ftpCheck,
  cdCompetingRiskCheck,
  seasoningCheck,
  stochasticCheck,
  // Wave 3 — analytics land; the database.
  keyRateCheck,
  customVectorCheck,
  niiCheck,
  databaseCheck,
  // Wave 6 — closeout: the standing W3-P9 catalog step executed.
  catalogCheck,
  // The index history store, flipped to shipped in the same commit.
  indexHistoryCheck,
  // The example bank tied out against the independent Python replica, flipped to shipped in the same commit.
  replicaTieOutCheck,
  // The example bank's feature demos; seg-ear and per-position-drilldown back in the core register.
  segEarCheck,
  perPositionCheck,
  featureDemosCheck,
  // The four deposit and FTP capabilities back in the core register, on Quillfield's deposit desk.
  fullBetaFormCheck,
  componentDecayCheck,
  replicatingPortfolioCheck,
  creditScenarioCheck,
  // The survival path, the commitment dials and the two liquidity tags, on Quillfield Bank version 1.3.
  survivalPathCheck,
];

const packChecks: CapabilityCheck[] = [];
const packEntries: RegisterEntry[] = [];

/** A pack's checks and the register entries they anchor, added once at load. */
export function registerCapabilityChecks(checks: readonly CapabilityCheck[], entries: readonly RegisterEntry[]): void {
  for (const c of checks) {
    if (capabilityChecks.some((x) => x.capabilityId === c.capabilityId) || packChecks.some((x) => x.capabilityId === c.capabilityId)) {
      throw new Error(`acceptance check "${c.capabilityId}" is already registered`);
    }
    packChecks.push(c);
  }
  packEntries.push(...entries);
}

/** The core checks, then a pack's, in registration order. */
export const allCapabilityChecks = (): CapabilityCheck[] => [...capabilityChecks, ...packChecks];

/** The register entries a pack added; the register loader appends them (./register.ts). */
export const registeredRegisterEntries = (): readonly RegisterEntry[] => packEntries;
