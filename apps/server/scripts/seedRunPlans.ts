/**
 * The demo run plans the seed writes to the run-plans store (Studio S2), one
 * per demo book, plus a fourth on the synthetic book and a fifth
 * on the liability book. They are the documents the plan
 * builder opens.
 *
 * The two synthetic plans carry the demo chain from
 * data/src/__tests__/demoPlanParity.test.ts (prepay on mortgages and mbs,
 * decay on dda, beta on mma: the four bindings demo-behavioral-v1 makes, so R4
 * is met) plus an FTP stage on engine.metric.ftp. st-decay selects dda AND mma:
 * a stage applies only the bindings it licenses, so under the demo set mma gets
 * no decay and no number moves, while a set that binds mma nmd-decay
 * (liquidity-stress-demo-v1, or a stack carrying it) has a licensee. The vanilla plan is the
 * no-behavior graph planRoutes.test.ts runs. Each validates clean against the
 * seeded store; seedRunPlans.test.ts holds that.
 *
 * The fourth plan, plan-synthetic-2500-loan-repricing-v1, is the first
 * synthetic plan on the loan repricing set, with one added st-client-rate
 * stage (flat carry, mortgages). The stage feeds no metric: nothing reads the
 * client rate yet, so its numbers equal plan-synthetic-2500-v1's and the stage
 * shows only in the rate document.
 *
 * The fifth plan, plan-synthetic-lcr-liabilities-v1, is the vanilla contractual
 * graph on the seeded liability book, with no view declared: the person adds
 * views on the Plan page, through its Book picker and Views card.
 *
 * The sixth plan, plan-synthetic-2500-indexed-v1, is the
 * demo behavioral chain on the indexed book, bound to the demonstration rate
 * indices market. It was the first seeded plan to name a market other than the
 * public pack, because a floater that names an index is refused on a market
 * that does not carry it.
 *
 * The seventh to ninth plans are the demo behavioral chain
 * on the synthetic book, bound to the macro factors market: unmapped (the demo
 * set), and under the two housing sets mapped to hpi-down-30 and to hpi-flat.
 * Illustrative values; the house-price effect is read on Compare, run against
 * the unmapped plan.
 *
 * Key order here is the order the Studio shows and round-trips. Do not run
 * these objects through parseRunPlan before storing them.
 */
import type { RunPlan } from "@alm/engine";

interface SeedRefs {
  market: string;
  routingPolicy: string;
  syntheticPortfolio: string;
  hedgedPortfolio: string;
  lcrLiabilityPortfolio: string;
  /** The synthetic book with three floaters naming a rate index. */
  indexedPortfolio: string;
  /** The public market carrying the three demonstration indices. */
  rateIndexMarket: string;
  vanillaPortfolio: string;
  demoAssumptions: string;
  vanillaAssumptions: string;
  loanRepricingAssumptions: string;
  /** The public market carrying the macro factors block. */
  macroMarket: string;
  /** The demo set with the house-price response, mapped to hpi-down-30 and to hpi-flat. */
  housingAssumptions: string;
  housingFlatAssumptions: string;
}

const SCENARIOS = ["S0", "S100", "S-100", "S200", "S-200"].map((s) => ({ ref: `regulatory-grid-v1#${s}` }));

function behavioralPlan(refs: SeedRefs, book: string, label: string): RunPlan {
  return {
    schemaVersion: "1.4.0",
    planId: `plan-${book}`,
    label,
    authoredBy: "person",
    asOf: "2026-03-31",
    grid: { horizonMonths: 360 },
    inputs: { marketSnapshot: refs.market, positionBook: book, routingPolicy: refs.routingPolicy, assumptionSets: [refs.demoAssumptions] },
    stages: [
      { id: "st-curve", component: "alm-yield-curve", kind: "curve", consumes: ["MarketSnapshot"], produces: ["ZeroCurve"], params: { dayCount: "ACT/360" } },
      { id: "st-tlp", component: "alm-tlp-overlay", kind: "curve", consumes: ["ZeroCurve", "MarketSnapshot"], produces: ["FundingCurve"], params: { dayCount: "ACT/360" }, dependsOn: ["st-curve"] },
      { id: "st-term", component: "engine.rate-path", kind: "term-structure", consumes: ["ZeroCurve"], produces: ["RatePath", "DiscountFactorPath"], dependsOn: ["st-curve"] },
      { id: "st-prepay", component: "alm-mortgage-prepayment", kind: "behavioral", consumes: ["Position", "RatePath"], produces: ["Position"], dependsOn: ["st-term"], selector: { productFamily: ["mortgages", "mbs"], behavioralClasses: "prepayment" }, disposition: "M", tier: "Tier 1", feeds: ["nii", "eve", "ir-gap"] },
      { id: "st-decay", component: "alm-deposit-decay", kind: "behavioral", consumes: ["Position", "RatePath"], produces: ["Position"], dependsOn: ["st-prepay", "st-term"], selector: { productFamily: ["dda", "mma"], behavioralClasses: "decay" }, disposition: "M", tier: "Tier 1", feeds: ["eve", "ir-gap", "liq-gap"] },
      { id: "st-beta", component: "alm-deposit-beta", kind: "behavioral", consumes: ["Position", "RatePath"], produces: ["Position"], dependsOn: ["st-decay", "st-term"], selector: { productFamily: "mma", behavioralClasses: "deposit-beta" }, disposition: "M", tier: "Tier 1", feeds: ["nii", "eve"] },
      { id: "st-cashflow", component: "engine.contractual", kind: "contractual-cashflow", consumes: ["Position", "RatePath"], produces: ["Cashflow", "RepricingSchedule"], dependsOn: ["st-beta", "st-term"] },
      { id: "st-nii", component: "alm-nii", kind: "metric", consumes: ["Cashflow"], produces: ["NiiResult"], dependsOn: ["st-cashflow"] },
      { id: "st-eve", component: "alm-eve", kind: "metric", consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position"], produces: ["EveResult"], dependsOn: ["st-cashflow", "st-curve", "st-tlp", "st-beta"] },
      { id: "st-gap", component: "alm-gap-analytics", kind: "metric", consumes: ["Cashflow", "RepricingSchedule", "Position"], produces: ["GapResult"], dependsOn: ["st-cashflow", "st-beta"] },
      { id: "st-ftp", component: "engine.metric.ftp", kind: "metric", consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position", "NiiResult", "RatePath"], produces: ["FtpResult"], dependsOn: ["st-curve", "st-tlp", "st-term", "st-cashflow", "st-nii", "st-beta"] },
    ],
    scenarios: SCENARIOS,
    reports: [{ id: "r-mgmt", view: "managementView", metrics: ["nii", "eve"] }],
    validationRules: { typeGate: ["T1", "T2", "T3", "T4", "T5", "T6"], routingGate: ["R1", "R2", "R3", "R4"] },
  };
}

/**
 * The synthetic plan on the loan repricing set. The graph is
 * behavioralPlan's, with st-client-rate added after st-beta and st-term and the
 * four stages that depended on st-beta depending on st-client-rate in its place.
 */
function loanRepricingPlan(refs: SeedRefs): RunPlan {
  const base = behavioralPlan(refs, refs.syntheticPortfolio, "Synthetic book, loan repricing (demonstration)");
  const clientRate: RunPlan["stages"][number] = {
    id: "st-client-rate",
    component: "engine.loan-client-rate",
    kind: "behavioral",
    consumes: ["Position", "RatePath"],
    produces: ["Position"],
    dependsOn: ["st-beta", "st-term"],
    selector: { productFamily: "mortgages", behavioralClasses: "client-rate-asset" },
    disposition: "M",
    tier: "Tier 2",
    feeds: [],
  };
  const stages: RunPlan["stages"] = [];
  for (const st of base.stages) {
    if (st.id === "st-cashflow") stages.push(clientRate);
    stages.push(st.dependsOn?.includes("st-beta") ? { ...st, dependsOn: st.dependsOn.map((d) => (d === "st-beta" ? "st-client-rate" : d)) } : st);
  }
  return {
    ...base,
    planId: "plan-synthetic-2500-loan-repricing-v1",
    inputs: { ...base.inputs, assumptionSets: [refs.loanRepricingAssumptions] },
    stages,
  };
}

/** The no-behavior contractual graph on one book, on the empty assumption set. */
function contractualPlan(refs: SeedRefs, book: string, label: string): RunPlan {
  return {
    schemaVersion: "1.4.0",
    planId: `plan-${book}`,
    label,
    authoredBy: "person",
    asOf: "2026-03-31",
    grid: { horizonMonths: 360 },
    inputs: { marketSnapshot: refs.market, positionBook: book, routingPolicy: refs.routingPolicy, assumptionSets: [refs.vanillaAssumptions] },
    stages: [
      { id: "st-curve", component: "alm-yield-curve", kind: "curve", consumes: ["MarketSnapshot"], produces: ["ZeroCurve"], params: { dayCount: "ACT/360" } },
      { id: "st-tlp", component: "alm-tlp-overlay", kind: "curve", consumes: ["ZeroCurve", "MarketSnapshot"], produces: ["FundingCurve"], params: { dayCount: "ACT/360" }, dependsOn: ["st-curve"] },
      { id: "st-term", component: "engine.rate-path", kind: "term-structure", consumes: ["ZeroCurve"], produces: ["RatePath", "DiscountFactorPath"], dependsOn: ["st-curve"] },
      { id: "st-cashflow", component: "engine.contractual", kind: "contractual-cashflow", consumes: ["Position", "RatePath"], produces: ["Cashflow", "RepricingSchedule"], dependsOn: ["st-term"] },
      { id: "st-nii", component: "alm-nii", kind: "metric", consumes: ["Cashflow"], produces: ["NiiResult"], dependsOn: ["st-cashflow"] },
      { id: "st-eve", component: "alm-eve", kind: "metric", consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position"], produces: ["EveResult"], dependsOn: ["st-curve", "st-tlp", "st-cashflow"] },
      { id: "st-gap", component: "alm-gap-analytics", kind: "metric", consumes: ["Cashflow", "RepricingSchedule", "Position"], produces: ["GapResult"], dependsOn: ["st-cashflow"] },
      { id: "st-ftp", component: "engine.metric.ftp", kind: "metric", consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position", "NiiResult", "RatePath"], produces: ["FtpResult"], dependsOn: ["st-curve", "st-tlp", "st-term", "st-cashflow", "st-nii"] },
    ],
    scenarios: SCENARIOS,
    reports: [{ id: "r-mgmt", view: "managementView", metrics: ["nii", "eve"] }],
    validationRules: { typeGate: ["T1", "T2", "T3", "T4", "T5"], routingGate: ["R1", "R2", "R3", "R4"] },
  };
}

/**
 * The behavioral chain on the indexed book, run on the rate
 * indices market. Only the book, the market and the plan id and label differ
 * from the synthetic plan, so a comparison against it isolates the indices.
 * behavioralPlan derives the plan id from the book: plan-synthetic-2500-indexed-v1.
 */
function indexedPlan(refs: SeedRefs): RunPlan {
  const base = behavioralPlan(
    refs,
    refs.indexedPortfolio,
    "Synthetic book, three indexed floaters on the demonstration rate indices market (demonstration)",
  );
  return { ...base, inputs: { ...base.inputs, marketSnapshot: refs.rateIndexMarket } };
}

/**
 * The behavioral chain on the synthetic book, run on the macro
 * factors market under one set. Only the market, the set and the plan id and
 * label differ from the synthetic plan, so the unmapped plan on the same market
 * is the run a mapped plan is read against on Compare.
 */
function macroPlan(refs: SeedRefs, planId: string, set: string, label: string): RunPlan {
  const base = behavioralPlan(refs, refs.syntheticPortfolio, label);
  return { ...base, planId, inputs: { ...base.inputs, marketSnapshot: refs.macroMarket, assumptionSets: [set] } };
}

export function buildSeedRunPlans(refs: SeedRefs): RunPlan[] {
  return [
    behavioralPlan(refs, refs.syntheticPortfolio, "Synthetic 2,500-position book, behavioral chain, regulatory grid"),
    behavioralPlan(refs, refs.hedgedPortfolio, "Synthetic hedged book, behavioral chain, regulatory grid"),
    contractualPlan(refs, refs.vanillaPortfolio, "Vanilla book, contractual only, regulatory grid"),
    loanRepricingPlan(refs),
    contractualPlan(refs, refs.lcrLiabilityPortfolio, "Synthetic liability book, contractual only, regulatory grid"),
    indexedPlan(refs),
    macroPlan(refs, "plan-synthetic-2500-macro-unmapped-v1", refs.demoAssumptions, "Synthetic book, demo set on the macro factors market, no mapping (demonstration)"),
    macroPlan(refs, "plan-synthetic-2500-housing-v1", refs.housingAssumptions, "Synthetic book, house-price response on hpi-down-30 (illustrative)"),
    macroPlan(refs, "plan-synthetic-2500-housing-flat-v1", refs.housingFlatAssumptions, "Synthetic book, house-price response on hpi-flat (illustrative)"),
  ];
}
