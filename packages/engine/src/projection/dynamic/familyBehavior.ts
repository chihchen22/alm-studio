/**
 * The behavioral model a family's new volume carries.
 *
 * New volume is a new position of the family. Its model is the one the family's bindings and position values give such
 * a position: the family's largest position (by notional, first in book order on a tie) is copied as a prototype,
 * freshly originated (age 0, no cohort offset), and the run's whole assumption set is applied to it through the same
 * overlay chain every position goes through (applyStaticOverlays). A binding on part of the family (a tag selector)
 * reaches the prototype exactly when it reaches that largest position. The model's parameters are then read off the
 * prototype's effective terms:
 *
 *   mortgage        four-factor CPR (cprParams)
 *   fixed-loan      a constant CPR, when a binding wrote the engine-side `prepay` group
 *   nmd             deposit decay (nmdParams), at the family's static deposit rate
 *   nmd-b           deposit decay (nmdParams) and beta repricing (sCurve)
 *
 * Every other case is "none" with a sentence on why: a floating loan, a term deposit, a commitment, a fixed loan with
 * no prepayment binding, and the engine-side forms new volume does not carry yet (a mortgage on a house-price path, a
 * component, linear or full-beta deposit form, a replicating-portfolio credit), whose dated or level drivers have not
 * been checked against a tranche that starts after the cut-off.
 *
 * Pure over its inputs; no kernel file changes.
 */
import type { BetaSCurveParams, MBSParams, NMDParams } from "@alm/kernel";
import { overlayKindOf, type AssumptionSet } from "../../contracts/assumptions";
import type { ProductFamilyDef } from "../../contracts/chartOfAccounts";
import type { MacroTarget } from "../../contracts/macroFactors";
import type {
  EngineFixedLoanTerms,
  EngineMortgageTerms,
  EngineNMDBetaTerms,
  EngineNMDTerms,
  FixedLoanPrepay,
  PortfolioSpec,
  Position,
} from "../../contracts/position";
import type { NewVolumeBehaviorModel, NewVolumeBehaviorNote } from "../../contracts/results";
import type { NewBusinessTemplate } from "../../contracts/scenario";
import { selectorMatchesBag } from "../../plan/dimensions";
import type { BehavioralRegistry } from "../../plugins/services";
import { dimensionsOf } from "../../portfolio/dimensions";
import { applyStaticOverlays } from "../static/applyOverlays";

/** What a family's new volume runs, as the tranche builder reads it. */
export interface FamilyBehavior {
  model: NewVolumeBehaviorModel;
  /** Where the values come from: a binding of the run's assumption set, or the prototype position's own values. */
  source: "assumption-set" | "position" | "none";
  /** The model versions of the bindings that reached the prototype, in binding order; empty on "position" and "none". */
  modelVersions: string[];
  /** The position the prototype copies; null when the family holds none. */
  prototypeId: string | null;
  cprParams?: MBSParams;
  prepay?: FixedLoanPrepay;
  nmd?: { nmdParams: NMDParams; depositRate: number; beta: number };
  nmdB?: { nmdParams: NMDParams; sCurve: BetaSCurveParams };
  /** "none" only: one plain sentence on why the family's new volume carries no model. */
  reason?: string;
  /**
   * Fix round L3: "none" on a deposit family only, the one deposit form new deposits cannot carry yet ("component decay
   * form", "linear decay form", "replicating-portfolio credit", "full beta form"), and the family's label.
   */
  depositForm?: { form: string; familyLabel: string };
  /**
   * The deposit history of a run that named a "history" warmup; a new deposit cohort
   * reads it, followed by the scenario's path, in place of the kernel's own series. Absent, the kernel's series.
   */
  warmupHistory?: readonly number[];
}

/** The overlay kinds that play a guided behavioral role, the ones new volume reads. */
const ROLE_KINDS = new Set(["prepay", "nmd-decay", "deposit-beta"]);

/** The family's largest position by notional, first in book order on a tie; null when it holds none. */
export function largestPosition(portfolio: PortfolioSpec, familyId: string): Position | null {
  let best: Position | null = null;
  for (const p of portfolio.positions) {
    if (p.familyId !== familyId) continue;
    if (best === null || p.terms.notional > best.terms.notional) best = p;
  }
  return best;
}

/** The prototype position: the largest position freshly originated (a mortgage at age 0 and no cohort offset). */
function prototypeOf(largest: Position): Position {
  const t = largest.terms;
  if (t.type === "mortgage") {
    const { prepayMidpointOffsetBp: _offset, ...rest } = t as EngineMortgageTerms;
    void _offset;
    return { ...largest, id: `${largest.familyId}~nb~prototype`, terms: { ...rest, ageMonths: 0 } };
  }
  return { ...largest, id: `${largest.familyId}~nb~prototype` };
}

const none = (prototypeId: string | null, reason: string): FamilyBehavior => ({ model: "none", source: "none", modelVersions: [], prototypeId, reason });

/** A deposit family on a form new deposits cannot carry yet (fix round L3: the one form, by name). */
const unsupportedDeposit = (prototypeId: string, familyLabel: string, form: string): FamilyBehavior => ({
  ...none(prototypeId, `new deposits of ${familyLabel} cannot carry its ${form} yet, so its new volume is the fixed-rate stand-in`),
  depositForm: { form, familyLabel },
});

/**
 * The model the family's new volume carries. `assumptions` is the scenario's set (absent or empty: the positions' own
 * values); `behavioral` and `macroTargets` are the run's, threaded as the projection threads them.
 */
export function familyBehavior(
  portfolio: PortfolioSpec,
  family: Pick<ProductFamilyDef, "id" | "label" | "side" | "instrumentType">,
  assumptions?: AssumptionSet,
  behavioral?: BehavioralRegistry,
  macroTargets?: readonly MacroTarget[],
): FamilyBehavior {
  const largest = largestPosition(portfolio, family.id);
  if (largest === null) return none(null, `${family.label} holds no position, so there is no model to copy`);
  const proto = prototypeOf(largest);
  const book: PortfolioSpec = { ...portfolio, positions: [proto] };
  const applied = assumptions !== undefined && assumptions.bindings.length > 0 ? applyStaticOverlays(book, assumptions, behavioral, macroTargets) : book;
  const terms = applied.positions[0]!.terms;
  // The bindings that reached the prototype, read the way the overlay chain matched them.
  const versions: string[] = [];
  if (assumptions !== undefined) {
    const famDef = portfolio.coa.families.find((f) => f.id === family.id);
    let bag: ReturnType<typeof dimensionsOf> | undefined;
    for (const b of assumptions.bindings) {
      if (b.familyId !== family.id || !ROLE_KINDS.has(overlayKindOf(b.overlay))) continue;
      if (b.selector !== undefined) {
        if (famDef === undefined) continue;
        bag ??= dimensionsOf(proto, famDef, portfolio.taxonomy);
        if (!selectorMatchesBag(b.selector, bag)) continue;
      }
      versions.push(b.modelVersion);
    }
  }
  const source: FamilyBehavior["source"] = versions.length > 0 ? "assumption-set" : "position";
  const base = { source, modelVersions: versions, prototypeId: largest.id };
  switch (terms.type) {
    case "mortgage": {
      const m = terms as EngineMortgageTerms;
      if (m.housing !== undefined) return none(largest.id, `${family.label} prepays on a house-price path, which new volume does not carry yet`);
      return { model: "four-factor-cpr", ...base, cprParams: { ...m.cprParams } };
    }
    case "fixed-loan": {
      const f = terms as EngineFixedLoanTerms;
      if (f.prepay === undefined) {
        return none(largest.id, family.side === "liability"
          ? `${family.label} is term funding with no behavioral model`
          : `${family.label} carries no prepayment model (a constant CPR can be bound under Advanced)`);
      }
      return { model: "constant-cpr", ...base, prepay: { ...f.prepay } };
    }
    case "nmd": {
      const d = terms as EngineNMDTerms;
      // Fix round L3: name the one form the family runs.
      const form = d.componentDecay !== undefined ? "component decay form" : d.linearDecay !== undefined ? "linear decay form" : d.replicatingPortfolio !== undefined ? "replicating-portfolio credit" : null;
      if (form !== null) return unsupportedDeposit(largest.id, family.label, form);
      return { model: "nmd-decay", ...base, nmd: { nmdParams: structuredClone(d.nmdParams), depositRate: d.depositRate, beta: d.beta } };
    }
    case "nmd-b": {
      const d = terms as EngineNMDBetaTerms;
      const form = d.fullBeta !== undefined || d.depositSlotting !== undefined ? "full beta form" : d.replicatingPortfolio !== undefined ? "replicating-portfolio credit" : null;
      if (form !== null) return unsupportedDeposit(largest.id, family.label, form);
      return { model: "nmd-decay-beta", ...base, nmdB: { nmdParams: structuredClone(d.nmdParams), sCurve: { ...d.sCurve } } };
    }
    case "floating-loan":
      return none(largest.id, `${family.label} is floating rate and carries no prepayment model`);
    default:
      return none(largest.id, `${family.label} carries no prepayment, decay or repricing model`);
  }
}

/** The plain name of a model, as the result and the Studio state it. */
export const BEHAVIOR_MODEL_LABEL: Record<NewVolumeBehaviorModel, string> = {
  "four-factor-cpr": "Four-factor CPR prepayment",
  "constant-cpr": "Constant CPR prepayment",
  "nmd-decay": "Deposit decay at the family's own rate",
  "nmd-decay-beta": "Deposit decay with beta repricing",
  none: "No behavioral model",
};

/** The model as it reads inside a sentence. */
const BEHAVIOR_MODEL_PHRASE: Record<NewVolumeBehaviorModel, string> = {
  "four-factor-cpr": "four-factor CPR prepayment",
  "constant-cpr": "a constant CPR prepayment",
  "nmd-decay": "deposit decay at the family's own rate",
  "nmd-decay-beta": "deposit decay with beta repricing",
  none: "no behavioral model",
};

/**
 * Whether a template's tranches run the family's model, in a sentence; null when they do. A prepayment model runs on a
 * fixed-rate level-payment product (the shape the kernel mortgage and the constant-CPR loan amortize); a deposit model
 * on a deposit template.
 */
export function behaviorGap(template: NewBusinessTemplate, b: FamilyBehavior): string | null {
  if (template.behavior !== "family") return "the product carries no behavior: it is contractual";
  const deposit = b.model === "nmd-decay" || b.model === "nmd-decay-beta";
  if (template.rateType === "deposit") {
    if (deposit) return null;
    // Fix round L3: a deposit family on a form new deposits cannot carry gets one plain sentence and its way out.
    if (b.depositForm !== undefined) return `new deposits of ${b.depositForm.familyLabel} cannot carry its ${b.depositForm.form} yet; choose Fixed rate to use the stand-in`;
    return `a deposit product needs a deposit family's decay model, and ${b.model === "none" ? (b.reason ?? "the family carries none") : `this family runs ${BEHAVIOR_MODEL_PHRASE[b.model]}`}`;
  }
  if (b.model === "none") return b.reason ?? "the family carries no behavioral model";
  if (deposit) return "a deposit family's new volume is a deposit product, so its decay runs on a deposit template only";
  if (template.rateType !== "fixed" || template.amortization !== "level-pay") {
    return `the family's prepayment model runs on a fixed-rate level-payment product, and this one is ${template.rateType === "fixed" ? "fixed" : "floating"} with ${template.amortization === "bullet" ? "a bullet" : template.amortization === "linear" ? "equal principal" : "a level payment"}, so its new volume is contractual`;
  }
  return null;
}

/** The note a template's product carries on the result, written only when the template asks for behavior. */
export function behaviorNoteOf(template: NewBusinessTemplate, b: FamilyBehavior): NewVolumeBehaviorNote {
  const gap = behaviorGap(template, b);
  const phrase = BEHAVIOR_MODEL_PHRASE[b.model];
  const from = b.source === "assumption-set" ? `from the saved model (${b.modelVersions.join(", ")})` : b.source === "position" ? "from the family's own position values" : "";
  const note = gap === null
    ? `Each new tranche runs ${phrase} ${from}, aged from the month it is made.`
    : `New volume is contractual: ${gap}.`;
  return {
    model: b.model,
    applied: gap === null,
    source: b.source,
    ...(b.modelVersions.length > 0 ? { modelVersions: [...b.modelVersions] } : {}),
    note,
  };
}
