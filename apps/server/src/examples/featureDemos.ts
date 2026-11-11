/**
 * The feature demos on the example bank: one seeded run setup per engine feature, each on
 * Quillfield Bank (examples/mid-size-bank-v1.json, version 1.1), with the assumption sets they name. Both core seed
 * profiles plan these documents (apps/server/scripts/seed-store.ts); GET /api/guided/examples/:id/demos lists them; the
 * Studio's "Feature demos" card opens one by adding its sets to the Example bank workspace and saving the seeded setup
 * into a slot of its own, so the stored document is reused by id and the learner launches it from Run setups.
 *
 * Every demo is the bank's static run-off, the basis the replica ties out: the parallel grid (or the six
 * standardized shocks), the SOFR history as the deposit warm-up, NII over 60 months, risk-free value, both gap ladders
 * by month, FTP on. Each changes one or two settings from that base, named on its row. Every value is a round
 * illustrative number chosen here; none is fitted to data.
 *
 * Pure over the repository: the bindings and the history are read from examples/, the setups go through the run-setups
 * route's own parse gate and id rule, so a stored seed document is byte for byte what a POST of the same body writes.
 */
import type { AssumptionSet, ScenarioDefinition } from "@alm/engine";
import { SRP31_USD } from "@alm/engine/src/scenario/library";
import { CURRENT_MODEL_CONVENTION } from "@alm/engine/src/corrections";
import { exampleAnalysis } from "../http/routes/guided";
import { parseRunSetup } from "../workspaces/runSetupParse";
import { runSetupIdOf } from "../workspaces/standardAlco";
import type { RunSetup } from "../workspaces/types";
import { join } from "node:path";

/** The example book the demos run on. */
export const DEMO_BOOK_ID = "mid-size-bank-v1";

/** The two assumption sets the demos name, both seeded. */
export const DEMO_SET_IDS = {
  illustrative: "quillfield-illustrative-v1",
  constantPrepay: "quillfield-constant-prepay-v1",
} as const;

export type FeatureDemoId = "seg" | "regulatory" | "spread-consistent" | "six-shocks" | "instruments" | "constant-prepay" | "fixed-ladder";

/** One demo: its id, title, the slot it opens in, the sets it needs and its setup. */
export interface FeatureDemo {
  id: FeatureDemoId;
  title: string;
  /** The setup slot the Studio saves it into on the Example bank workspace. */
  lineageId: string;
  setIds: string[];
  setup: RunSetup;
}

/** What GET /api/guided/examples/:id/demos serves per demo. */
export interface FeatureDemoRow {
  /** A FeatureDemoId, or an deposit-form demo id (./depositForms.ts). */
  id: string;
  title: string;
  lineageId: string;
  setupId: string;
  setIds: string[];
  /** True when the store holds the setup and every set (a store seeded before S3b-1 holds none). */
  stored: boolean;
}

/** The parallel grid the guided path uses, by library reference. */
export const PARALLEL_REFS = ["regulatory-grid-v1#S0", "regulatory-grid-v1#S100", "regulatory-grid-v1#S-100", "regulatory-grid-v1#S200", "regulatory-grid-v1#S-200"];

/**
 * The cohort-0 prepayment overlay of the SEG demo: residential mortgages prepay at a flat 6 percent a year under the
 * up shock and 20 percent under the down shock, round values.
 */
export const DEMO_SEG = { enabled: true, shockBp: 25, horizonMonths: 120, niiShockBp: 100, cprOverlay: [{ familyId: "mb-resi-mortgages", upAnnualCpr: 0.06, downAnnualCpr: 0.2 }] };

/** The constant prepayment the constant-prepay set adds: decimals a year, the stress speed the ladder's stress rows read. */
export const DEMO_CONSTANT_CPR: ReadonlyArray<{ familyId: string; annualCpr: number; stressAnnualCpr: number }> = [
  { familyId: "mb-consumer", annualCpr: 0.1, stressAnnualCpr: 0.05 },
  { familyId: "mb-cre-multifamily", annualCpr: 0.06, stressAnnualCpr: 0.03 },
];

/**
 * The liquidity stress opt-in of the constant-prepay demo: the Studio's illustrative starting table (round values,
 * apps/studio/src/rows/setupRows.ts DEFAULT_LIQUIDITY_STRESS, restated here), with the buffer at the bank's cash and
 * securities, $1,250M, and the undrawn face at its undrawn lines, $1,000M.
 */
export const DEMO_LIQUIDITY_STRESS = {
  table: {
    bau: { hysOutflowMonthly: 0.004, wholesaleRenewal: 1, nibOutflowMonthly: 0.001, drawRate: 0 },
    moderate: { hysOutflowMonthly: 0.04, wholesaleRenewal: 0.6, nibOutflowMonthly: 0.008, drawRate: 0.12 },
    severe: { hysOutflowMonthly: 0.08, wholesaleRenewal: 0.2, nibOutflowMonthly: 0.015, drawRate: 0.25 },
  },
  buffer: 1_250_000_000,
  undrawnFace: 1_000_000_000,
};

/** The instrument demo stores every position: the bank chart's four top nodes reach every leaf. */
export const DEMO_INSTRUMENT_NODES = ["mb-assets", "mb-liab-equity", "mb-off-balance", "mb-derivatives"];

/** The six standardized shocks as the engine defines them, inline, after the base scenario. */
function sixShocks(): ScenarioDefinition[] {
  return SRP31_USD.scenarios.map((s) => ({ id: s.id, label: s.label!, rateSpec: s.rateSpec }));
}

/** The two seeded sets: the finished analysis's illustrative bindings, and those plus a constant CPR on two loan families. */
export function featureDemoSets(repoRoot: string): AssumptionSet[] {
  const a = analysisOf(repoRoot);
  const bindings = a.behavior.bindings.map((b) => JSON.parse(JSON.stringify(b)) as AssumptionSet["bindings"][number]);
  return [
    { schemaVersion: "1.0.0", id: DEMO_SET_IDS.illustrative, label: "Quillfield Bank illustrative behavior (round values, not fitted), for the feature demos", bindings },
    {
      schemaVersion: "1.0.0",
      id: DEMO_SET_IDS.constantPrepay,
      label: "Quillfield Bank illustrative behavior plus a constant prepayment on consumer and multifamily loans (round values, not fitted)",
      bindings: [
        ...bindings.map((b) => JSON.parse(JSON.stringify(b)) as AssumptionSet["bindings"][number]),
        ...DEMO_CONSTANT_CPR.map((c) => ({
          familyId: c.familyId,
          overlay: { kind: "prepay" as const, model: "constant-cpr" as const, annualCpr: c.annualCpr, stressAnnualCpr: c.stressAnnualCpr },
          modelVersion: "illustrative-v1",
        })),
      ],
    },
  ];
}

function analysisOf(repoRoot: string) {
  const a = exampleAnalysis(join(repoRoot, "examples"), DEMO_BOOK_ID);
  if (a === null) throw new Error(`feature demos: examples/${DEMO_BOOK_ID}.analysis.json is missing`);
  return a;
}

/** The common base: the bank's static run-off, as the replica ties it out. */
export function baseBody(name: string, setId: string, note: string, warmup: RunSetup["nmdWarmup"]): Omit<RunSetup, "id"> {
  return {
    schemaVersion: "1.0.0",
    name,
    gridHorizonMonths: 360,
    inputs: { book: { role: "base" }, market: { role: "base" }, assumptionSetIds: [setId] },
    scenarios: { kind: "library", refs: [...PARALLEL_REFS] },
    plan: {
      planId: null,
      label: name,
      authoredBy: "person",
      stages: "derived-default",
      reports: [{ id: "r-mgmt", view: "managementView", metrics: ["nii", "eve"] }],
      validationRules: { typeGate: ["T1", "T2", "T3", "T4", "T5"], routingGate: ["R1", "R2", "R3", "R4"] },
    },
    nii: { enabled: true, horizonMonths: 60, reportHorizons: [12, 24, 60], basis: { kind: "runoff" }, path: "single" },
    eve: { enabled: true, discountBasis: "risk-free", durationMode: "base-only", valuationDates: "as-of", keyRate: false, channels: false, path: "single" },
    gap: { enabled: true, repricingBuckets: { kind: "monthly" }, fixedRateLadder: false, liquidity: { enabled: true, flows: "principal", interval: { kind: "monthly" } } },
    ftp: { enabled: true },
    instrumentResults: { save: false, coaNodeIds: [] },
    ...(warmup !== undefined ? { nmdWarmup: warmup } : {}),
    // The seeded demos run the corrections.
    modelConvention: CURRENT_MODEL_CONVENTION,
    batch: [],
    importedFrom: null,
    supersedes: null,
    note,
  };
}

/** Through the run-setups route's parse gate and id rule, so the stored bytes are the ones a POST of this body writes. */
export function canonical(body: Omit<RunSetup, "id">): RunSetup {
  const parsed = parseRunSetup(JSON.parse(JSON.stringify(body)));
  return { id: runSetupIdOf(parsed), ...parsed };
}

/** The seven demos, in card order. Studio slice S3c-1 adds its demos beside these (./depositForms.ts), never into this list. */
export function featureDemos(repoRoot: string): FeatureDemo[] {
  const a = analysisOf(repoRoot);
  const warmup = { kind: "history" as const, series: { ...a.nmdWarmup.series, valuesPct: [...a.nmdWarmup.series.valuesPct] } };
  const IL = DEMO_SET_IDS.illustrative;
  const demo = (id: FeatureDemoId, title: string, setId: string, note: string, edit: (b: Omit<RunSetup, "id">) => Omit<RunSetup, "id">): FeatureDemo => ({
    id,
    title,
    lineageId: `demo-${id}`,
    setIds: [setId],
    setup: canonical(edit(baseBody(`Demo: ${title}`, setId, note, warmup))),
  });
  return [
    demo("seg", "SEG and its knobs", IL, "Feature demo: the SEG block on, its shock at 25 bp, its horizon at 120 months, its NII shock at 100 bp, and a cohort-0 overlay on the residential mortgages (6 percent up, 20 percent down).", (b) => ({
      ...b,
      seg: { ...DEMO_SEG, cprOverlay: DEMO_SEG.cprOverlay.map((o) => ({ ...o })) },
    })),
    demo("regulatory", "The regulatory deposit convention", IL, "Feature demo: every non-maturity deposit on the regulatory convention, a capped core ladder plus a one-month non-core slice.", (b) => ({ ...b, nmdConvention: "regulatory" })),
    demo("spread-consistent", "Spread-consistent discounting", IL, "Feature demo: value discounted on the funding curve plus each loan's own discount spread (Quillfield Bank version 1.1).", (b) => ({
      ...b,
      eve: { ...b.eve, discountBasis: "spread-consistent" },
    })),
    demo("six-shocks", "The six standardized shocks", IL, "Feature demo: the base scenario and the six standardized interest rate shocks: parallel up and down, short rate up and down, steepener and flattener.", (b) => ({
      ...b,
      scenarios: { kind: "plan-scenarios", items: [{ ref: "regulatory-grid-v1#S0" }, ...sixShocks()] },
    })),
    demo("instruments", "Instrument-level results", IL, "Feature demo: one row per position per scenario, saved beside the run.", (b) => ({
      ...b,
      instrumentResults: { save: true, coaNodeIds: [...DEMO_INSTRUMENT_NODES] },
    })),
    demo("constant-prepay", "Constant prepayment and the stress inflow line", DEMO_SET_IDS.constantPrepay, "Feature demo: consumer loans prepay at 10 percent a year (5 percent in stress), multifamily at 6 percent (3 in stress), read by the liquidity stress ladder.", (b) => ({
      ...b,
      liquidityStress: JSON.parse(JSON.stringify(DEMO_LIQUIDITY_STRESS)) as NonNullable<RunSetup["liquidityStress"]>,
    })),
    demo("fixed-ladder", "The fixed-rate gap ladder", IL, "Feature demo: the fixed-rate ladder on, rate-locked principal by the month it is paid.", (b) => ({
      ...b,
      gap: { ...b.gap, fixedRateLadder: true },
    })),
  ];
}
