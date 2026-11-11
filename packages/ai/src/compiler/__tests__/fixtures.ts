/**
 * Deterministic fixtures for the assumption compiler.
 *
 * The base assumption set below stands in for a bank's calibrated overlays: an
 * MMA family carrying both a deposit-rate beta and a decay overlay, a Mortgages
 * family carrying a four-factor CPR prepayment overlay, an Investments family
 * carrying a constant-CPR overlay, and a CDs family carrying a rollover rule.
 *
 * `fakeAuthor` is the test stand-in for the LLM authoring seam. In production
 * the MCP client (Claude) authors the candidate AssumptionSet from the
 * instruction; here a fixed instruction -> candidate map keeps the compiler's
 * deterministic core (validate + diff + rationale) testable without a live
 * model. The map only ever mutates the targeted family, mirroring the contract
 * that an instruction touching one family leaves other bindings byte-identical.
 */
import {
  BETA_S_CURVE_DEFAULTS,
  MBS_DEFAULTS,
  BALANCE_SENS_DEFAULTS,
} from "@alm/kernel";
import type { NMDParams } from "@alm/kernel";
import type {
  AssumptionSet,
  CompileAssumptionsInput,
  ProductFamilyDef,
} from "@alm/engine";
import type { CandidateAuthor } from "../compiler";

const NMD_PARAMS: NMDParams = {
  closureSteady: 0.6,
  closureInitial: 1.2,
  closureTauMonths: 18,
  burnoutLambda: 0,
  maxRateDecay: 4.0,
  maxRateGrowth: -1.0,
  logisticK: 0.8,
  logisticMidpoint: 2.5,
  maPeriod: 24,
  regimeAlpha: 1.5,
  balanceSize: 2_000_000,
  sens: { ...BALANCE_SENS_DEFAULTS },
  buckets: [
    { label: "<= $250k", repBalance: 100_000, share: 0.5 },
    { label: "> $250k", repBalance: 800_000, share: 0.5 },
  ],
};

/** Product-family catalogue passed to the compiler. */
export const FAMILIES: ProductFamilyDef[] = [
  { id: "MMA", label: "Money Market", side: "liability", instrumentType: "nmd-b", coaNodeId: "coa-mma" },
  { id: "Mortgages", label: "Mortgages", side: "asset", instrumentType: "mortgage", coaNodeId: "coa-mtg" },
  { id: "Investments", label: "Investments", side: "asset", instrumentType: "mortgage", coaNodeId: "coa-inv" },
  { id: "CDs", label: "Certificates of Deposit", side: "liability", instrumentType: "fixed-loan", coaNodeId: "coa-cd" },
];

/** The calibrated base assumption set (contentHash intentionally absent). */
export const BASE: AssumptionSet = {
  schemaVersion: "1.0.0",
  id: "base",
  label: "Calibrated base",
  bindings: [
    {
      familyId: "MMA",
      modelVersion: "beta-2026.1",
      overlay: { kind: "deposit-beta", params: { ...BETA_S_CURVE_DEFAULTS } },
    },
    {
      familyId: "MMA",
      modelVersion: "decay-2026.1",
      overlay: { kind: "nmd-decay", params: structuredClone(NMD_PARAMS) },
    },
    {
      familyId: "Mortgages",
      modelVersion: "cpr-2026.1",
      overlay: { kind: "prepay", model: "four-factor-cpr", params: { ...MBS_DEFAULTS } },
    },
    {
      familyId: "Investments",
      modelVersion: "cpr-const-2026.1",
      // A fraction, as the kernel reads constant CPR (0.08 means 8%); 8.0 was a percent in a fraction field.
      overlay: { kind: "prepay", model: "constant-cpr", annualCpr: 0.08 },
    },
    {
      familyId: "CDs",
      modelVersion: "cd-2026.1",
      overlay: { kind: "cd-rollover", renewalProbability: 0.6, offeredSpreadBp: 25, termMonths: 12 },
    },
  ],
};

/** A deep, hash-free clone so a test can mutate a candidate freely. */
export function cloneBase(): AssumptionSet {
  return structuredClone(BASE);
}

/** The point bump the fixture author applies for "15 points higher". */
export const BETA_BUMP = 0.15;

/**
 * The deterministic authoring seam used in tests. Each supported instruction
 * maps to a candidate that mutates only the targeted family's overlay. An
 * unrecognized instruction returns the base unchanged (no fabricated edits).
 */
export function fakeAuthor(input: CompileAssumptionsInput): AssumptionSet {
  const candidate = structuredClone(input.base);
  candidate.id = "candidate";
  candidate.label = input.instruction;
  delete candidate.contentHash;

  const raise = candidate.bindings.find(
    (b) => b.familyId === "MMA" && b.overlay.kind === "deposit-beta",
  );
  const halve = candidate.bindings.find(
    (b) => b.familyId === "Mortgages" && b.overlay.kind === "prepay",
  );

  const wantsBeta = /beta/i.test(input.instruction);
  const wantsPrepay = /prepay/i.test(input.instruction);

  if (wantsBeta && raise && raise.overlay.kind === "deposit-beta") {
    raise.overlay.params.betaMin += BETA_BUMP;
    raise.overlay.params.betaMax += BETA_BUMP;
  }
  if (wantsPrepay && halve && halve.overlay.kind === "prepay" && halve.overlay.model === "four-factor-cpr") {
    halve.overlay.params.minCpr /= 2;
    halve.overlay.params.maxCpr /= 2;
  }
  return candidate;
}

/**
 * An author that rebinds the MMA deposit-beta overlay to `badFamilyId`, a family
 * chosen by the caller to be absent from (or wrong-case against) the catalogue.
 * The candidate is otherwise structurally valid: it passes bindAssumptions and
 * fails only the family cross-check, exercising the show-before-run family gate.
 */
export function familyRebindAuthor(badFamilyId: string): CandidateAuthor {
  return (input: CompileAssumptionsInput): AssumptionSet => {
    const candidate = structuredClone(input.base);
    candidate.id = "candidate";
    candidate.label = input.instruction;
    delete candidate.contentHash;
    const beta = candidate.bindings.find(
      (b) => b.familyId === "MMA" && b.overlay.kind === "deposit-beta",
    );
    if (beta) beta.familyId = badFamilyId;
    return candidate;
  };
}

/**
 * An author that rebinds the Mortgages prepay overlay to `badFamilyId` (a known
 * family with an incompatible instrument type in the D5 tests). Structurally
 * valid; exercises the compile-time compatibility gate on the prepay kind.
 */
export function prepayRebindAuthor(badFamilyId: string): CandidateAuthor {
  return (input: CompileAssumptionsInput): AssumptionSet => {
    const candidate = structuredClone(input.base);
    candidate.id = "candidate";
    candidate.label = input.instruction;
    delete candidate.contentHash;
    const prepay = candidate.bindings.find(
      (b) => b.familyId === "Mortgages" && b.overlay.kind === "prepay",
    );
    if (prepay) prepay.familyId = badFamilyId;
    return candidate;
  };
}

/** An author that emits a structurally invalid candidate (non-finite param). */
export function brokenAuthor(input: CompileAssumptionsInput): AssumptionSet {
  const candidate = structuredClone(input.base);
  candidate.id = "broken";
  const beta = candidate.bindings.find((b) => b.overlay.kind === "deposit-beta");
  if (beta && beta.overlay.kind === "deposit-beta") {
    beta.overlay.params.betaMax = Number.POSITIVE_INFINITY;
  }
  return candidate;
}

/** Build a CompileAssumptionsInput around the shared base and family catalogue. */
export function inputFor(instruction: string): CompileAssumptionsInput {
  return { instruction, base: cloneBase(), families: FAMILIES };
}
