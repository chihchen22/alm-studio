/**
 * The deposit forms and the floater's funding tenor: seven seeded run setups, each a card
 * on Home, beside the seven feature demos of S3b (./featureDemos.ts), whose list and documents this module never
 * touches.
 *
 * Six run on Quillfield's deposit desk (examples/quillfield-deposit-desk-v1.json, version 1.0), a deposits-only sub-book
 * of Quillfield Bank: an operating deposit that runs off in a straight line over 48 months, a savings book on the
 * component decay form, and a money market book on the full beta form. Each deposit is a family of its own, because a
 * credit readout belongs to a family with one deposit. The seventh runs on Quillfield Bank itself, whose floaters carry
 * a funding tenor from version 1.2.
 *
 * The desk's sets bind one form each, so every card shows what its form can show and says what it cannot:
 *
 *   desk-linear-decay       no form bound; the straight-line runoff is the position's own term, so NII, EVE, gap
 *                           and FTP all read it
 *   desk-component-decay    the component decay form on the savings book over the realized SOFR path from April
 *                           2022; NII, EVE and FTP stand aside (the form prices volume on a dated path), each with its
 *                           note, and the card reads the balance, the gap ladders and the full-runoff WAL
 *   desk-full-beta-frozen   the full beta form on the money market book, the regulatory convention (frozen slotting);
 *                           FTP stands aside with its note (the FTP module does not read the form)
 *   desk-full-beta-shocked  the same set, the shocked-level convention (core share at the shocked level)
 *   desk-credit             the replicating-portfolio credit on each deposit, base scenario only (a straight-line
 *                           runoff's credit is read on the base curve)
 *   desk-scenario-credit    the credit on the savings path and on a capped money market life, read at every parallel
 *                           scenario on the scenario's own curve
 *   funding-tenor           Quillfield Bank's common demo base: version 1.2's floaters read FTP at their funding tenor
 *
 * Every value is a round illustrative number chosen here (docs/oss/deposit-desk.md states each), except the SOFR
 * values, which are the shipped public series (examples/sofr-monthly-v1.json). None is
 * fitted to data. Every setup carries the corrected model convention and goes through the run-setups route's
 * own parse gate and id rule (./featureDemos.ts canonical).
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { AssumptionSet, ComponentDecayForm, DepositBetaFullForm, PortfolioSpec, ReplicatingPortfolioForm } from "@alm/engine";
import { depositHistoryOf, DEPOSIT_HISTORY_FILE } from "../http/routes/guided";
import type { RunSetup } from "../workspaces/types";
import { baseBody, canonical, DEMO_BOOK_ID, DEMO_SET_IDS, PARALLEL_REFS } from "./featureDemos";

/** The deposit desk's book id and file (examples/<id>.json). */
export const DESK_BOOK_ID = "quillfield-deposit-desk-v1";

/** The desk's five seeded sets. */
export const DESK_SET_IDS = {
  plain: "quillfield-desk-plain-v1",
  component: "quillfield-desk-component-decay-v1",
  fullBeta: "quillfield-desk-full-beta-v1",
  credit: "quillfield-desk-credit-v1",
  scenarioCredit: "quillfield-desk-scenario-credit-v1",
} as const;

export type DepositFormDemoId =
  | "desk-linear-decay"
  | "desk-component-decay"
  | "desk-full-beta-frozen"
  | "desk-full-beta-shocked"
  | "desk-credit"
  | "desk-scenario-credit"
  | "funding-tenor";

/** One deposit-form demo: the FeatureDemo shape plus the example book it runs on. */
export interface DepositFormDemo {
  id: DepositFormDemoId;
  title: string;
  /** The example book whose workspace the demo opens on. */
  bookId: string;
  lineageId: string;
  setIds: string[];
  setup: RunSetup;
}

/** The desk's three families, one deposit each. */
export const DESK_FAMILIES = { operating: "dd-operating", savings: "dd-savings", mma: "dd-mma" } as const;

/** The realized SOFR window the component decay form reads: April 2022 to March 2026, 48 months; a 12-month benchmark. */
export const DESK_COMPONENT_WINDOW = { firstMonth: "2022-04", lastMonth: "2026-03" } as const;

/**
 * The savings book's component decay form, round values: 2 percent of balances leave each month, survivors grow 0.25
 * percent a month, and each percentage point the month's SOFR sits above its trailing 12-month mean takes 0.5 percent
 * a month off the book. The series is the shipped SOFR history, as stored.
 */
export function deskComponentDecay(repoRoot: string): ComponentDecayForm {
  const series = sofrSeries(repoRoot);
  return {
    retention: 0.98,
    drift: 0.0025,
    coefficientPerPp: -0.005,
    lookbackMonths: 12,
    series,
    window: { ...DESK_COMPONENT_WINDOW },
    beyondWindow: "hold-last",
  };
}

/**
 * The money market book's full beta form, round values: an intercept of 0.10 percent, dampening 0.3 after a rise and
 * 0.1 after a fall, volatility ratio 1, the base state at 3.65 percent (the March 2026 SOFR month of the shipped series)
 * after a fall (rates were cut through late 2025), balances flat.
 */
export const DESK_FULL_FORM: DepositBetaFullForm = {
  alphaPct: 0.1,
  deltaUp: 0.3,
  deltaDown: 0.1,
  volRatio: 1,
  baseShortRatePct: 3.65,
  baseLastMove: "fall",
  balances: "flat",
};

/** The pillar grid every desk credit blends on: one month to ten years. */
export const DESK_PILLARS = [1, 12, 36, 60, 120];

/** The operating deposit's credit: the life-target blend on its straight-line runoff (life 24.5 months), base only. */
export const DESK_CREDIT_LINEAR: ReplicatingPortfolioForm = { construction: "life-target", pillarGridMonths: [...DESK_PILLARS] };
/** The savings book's credit on its own balance path, run off in full. */
export const DESK_CREDIT_SAVINGS: ReplicatingPortfolioForm = { construction: "life-target", pillarGridMonths: [...DESK_PILLARS], life: { source: "balance-path" } };
/** The money market book's credit on a capped life of 60 months (its balances are flat, so it has no runoff of its own). */
export const DESK_CREDIT_MMA: ReplicatingPortfolioForm = { construction: "life-target", pillarGridMonths: [...DESK_PILLARS], life: { source: "capped", months: 60 } };

/** The shipped SOFR series as the component decay form reads it: first month, label and values as stored. */
function sofrSeries(repoRoot: string): ComponentDecayForm["series"] {
  const h = depositHistoryOf(join(repoRoot, "examples"), DEPOSIT_HISTORY_FILE);
  return { firstMonth: h.firstMonth, label: h.nmdWarmup.series.label, valuesPct: [...h.nmdWarmup.series.valuesPct] };
}

/** The desk as the file holds it. */
export function deskBook(repoRoot: string): PortfolioSpec {
  return JSON.parse(readFileSync(join(repoRoot, "examples", `${DESK_BOOK_ID}.json`), "utf8")) as PortfolioSpec;
}

/** A position's own decay parameters, the params an nmd-decay overlay must carry (the forms do not read them). */
function ownDecayParams(book: PortfolioSpec, familyId: string) {
  const p = book.positions.find((x) => x.familyId === familyId);
  if (p === undefined || (p.terms.type !== "nmd" && p.terms.type !== "nmd-b")) throw new Error(`deposit desk: no deposit in family "${familyId}"`);
  return JSON.parse(JSON.stringify(p.terms.nmdParams)) as NonNullable<typeof p.terms.nmdParams>;
}

/** The money market book's own S-curve, the params its deposit-beta overlay carries. */
function ownSCurve(book: PortfolioSpec) {
  const p = book.positions.find((x) => x.familyId === DESK_FAMILIES.mma);
  if (p === undefined || p.terms.type !== "nmd-b") throw new Error("deposit desk: no nmd-b in family dd-mma");
  return { ...p.terms.sCurve };
}

const VERSION = "illustrative-v1";

/** The desk's five sets. Pure over the repository. */
export function depositFormSets(repoRoot: string): AssumptionSet[] {
  const book = deskBook(repoRoot);
  const decay = (familyId: string, extra: Partial<{ componentDecay: ComponentDecayForm; replicatingPortfolio: ReplicatingPortfolioForm }>) => ({
    familyId,
    overlay: { kind: "nmd-decay" as const, params: ownDecayParams(book, familyId), ...extra },
    modelVersion: VERSION,
  });
  const beta = (extra: Partial<{ fullForm: DepositBetaFullForm; replicatingPortfolio: ReplicatingPortfolioForm }>) => ({
    familyId: DESK_FAMILIES.mma,
    overlay: { kind: "deposit-beta" as const, params: ownSCurve(book), ...extra },
    modelVersion: VERSION,
  });
  const cd = deskComponentDecay(repoRoot);
  const set = (id: string, label: string, bindings: AssumptionSet["bindings"]): AssumptionSet => ({ schemaVersion: "1.0.0", id, label, bindings });
  return [
    set(DESK_SET_IDS.plain, "Quillfield deposit desk, each deposit on its own terms (no form bound)", []),
    set(DESK_SET_IDS.component, "Quillfield deposit desk, the savings book on the component decay form over the SOFR path from April 2022 (round values, not fitted)", [
      decay(DESK_FAMILIES.savings, { componentDecay: cd }),
    ]),
    set(DESK_SET_IDS.fullBeta, "Quillfield deposit desk, the money market book on the full beta form (round values, not fitted)", [beta({ fullForm: { ...DESK_FULL_FORM } })]),
    set(DESK_SET_IDS.credit, "Quillfield deposit desk, the replicating-portfolio credit on each deposit, base scenario (round values, not fitted)", [
      decay(DESK_FAMILIES.operating, { replicatingPortfolio: structuredClone(DESK_CREDIT_LINEAR) }),
      decay(DESK_FAMILIES.savings, { componentDecay: deskComponentDecay(repoRoot), replicatingPortfolio: structuredClone(DESK_CREDIT_SAVINGS) }),
      beta({ fullForm: { ...DESK_FULL_FORM }, replicatingPortfolio: structuredClone(DESK_CREDIT_MMA) }),
    ]),
    set(DESK_SET_IDS.scenarioCredit, "Quillfield deposit desk, the credit on the savings path and on a capped money market life, read at every parallel scenario (round values, not fitted)", [
      decay(DESK_FAMILIES.savings, { componentDecay: deskComponentDecay(repoRoot), replicatingPortfolio: { ...structuredClone(DESK_CREDIT_SAVINGS), scenarioCurve: "shift" } }),
      beta({ fullForm: { ...DESK_FULL_FORM }, replicatingPortfolio: { ...structuredClone(DESK_CREDIT_MMA), scenarioCurve: "shift" } }),
    ]),
  ];
}

/** The seven demos, in card order: the desk's six, then the funding tenor on Quillfield Bank. */
export function depositFormDemos(repoRoot: string): DepositFormDemo[] {
  const warmup = { kind: "history" as const, series: (() => {
    const h = depositHistoryOf(join(repoRoot, "examples"), DEPOSIT_HISTORY_FILE).nmdWarmup.series;
    return { ...h, valuesPct: [...h.valuesPct] };
  })() };
  const demo = (id: DepositFormDemoId, title: string, bookId: string, setId: string, note: string, edit: (b: Omit<RunSetup, "id">) => Omit<RunSetup, "id">): DepositFormDemo => ({
    id,
    title,
    bookId,
    lineageId: `demo-${id}`,
    setIds: [setId],
    setup: canonical(edit(baseBody(`Demo: ${title}`, setId, note, warmup))),
  });
  const D = DESK_BOOK_ID;
  const S = DESK_SET_IDS;
  // Every setup keeps NII, EVE, gap and FTP on, as the common base has them: a block a form cannot carry stands aside
  // in the run with the engine's own note, which Results prints, so the setup never hides what the form leaves out.
  return [
    demo("desk-linear-decay", "A straight-line deposit runoff", D, S.plain, "Feature demo: the deposit desk on its own terms; the operating deposits run off in a straight line over 48 months, $6.25 million a month.", (b) => b),
    demo("desk-component-decay", "Component decay on a dated rate path", D, S.component, "Feature demo: the savings book on the component decay form over the realized SOFR path from April 2022 to March 2026; NII, EVE and FTP stand aside, because the form prices volume on a dated path.", (b) => b),
    demo("desk-full-beta-frozen", "The full beta form, frozen slotting", D, S.fullBeta, "Feature demo: the money market book on the full beta form under the regulatory convention, its core share frozen at the base date; FTP stands aside, because it does not read the form.", (b) => ({ ...b, nmdConvention: "regulatory" })),
    demo("desk-full-beta-shocked", "The full beta form, shocked-level slotting", D, S.fullBeta, "Feature demo: the money market book on the full beta form under the shocked-level convention, its core share read at each scenario's shocked rate; FTP stands aside, because it does not read the form.", (b) => ({ ...b, nmdConvention: "shocked-level" })),
    demo("desk-credit", "The replicating-portfolio credit", D, S.credit, "Feature demo: the replicating-portfolio credit on each desk deposit, on the base scenario: the straight-line runoff, the savings path and a capped money market life.", (b) => ({
      ...b,
      scenarios: { kind: "library", refs: [PARALLEL_REFS[0]!] },
    })),
    demo("desk-scenario-credit", "The credit at every scenario", D, S.scenarioCredit, "Feature demo: the credit on the savings path and on a capped money market life, read at every parallel scenario on that scenario's own curve.", (b) => b),
    demo("funding-tenor", "The floater's funding tenor", DEMO_BOOK_ID, DEMO_SET_IDS.illustrative, "Feature demo: Quillfield Bank version 1.2, whose floating loans and floating advance carry a funding tenor, so FTP reads the rate leg at the reset tenor and the liquidity leg at the funding tenor.", (b) => b),
  ];
}
