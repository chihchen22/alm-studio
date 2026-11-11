/**
 * The guided New volume step's preview. Read-only: nothing here writes the store.
 *
 *   POST /api/workspaces/:id/new-volume-preview   { templates?, plan?, months? } -> NewVolumePreview
 *
 * Per family of the workspace's book: the template the family's own positions suggest (the engine's
 * suggestedTemplate), the product a given template would mint today (a 100-unit tranche at month 0 on the base path
 * of the curve the workspace's deterministic run uses, the active curve setup applied), and, for a balance plan given
 * in the body (saved or not), the target balance path the engine's lowering and the sweep's own target rule aim at.
 * The Studio draws these and restates no rule of its own. A template or plan the engine refuses comes back as a
 * sentence in `problems`, never a 500.
 *
 * Per family, the behavioral model its new volume would carry (the engine's familyBehavior, on the
 * workspace's default assumption set, the one the guided run reads), and for a behavioral template the model its
 * tranche runs, with its CPR by month (a loan) or the balance left by month (a deposit, already in `months`).
 */
import type { AssumptionSet, BalancePlan, NewVolumeTemplateSpec, PortfolioSpec } from "@alm/engine";
import { lowerBalancePlan, newVolumeTemplateProblem, openingBalances } from "@alm/engine";
import { buildScenarioRatePath } from "@alm/engine/src/projection/static";
import { tlpOfSnapshot } from "@alm/engine/src/run/stages/curve";
import {
  BEHAVIOR_MODEL_LABEL, behaviorGap, familyBehavior, previewTemplate, reinvestmentTarget, suggestedTemplate, type SuggestedTemplate, type TemplatePreview,
} from "@alm/engine/src/projection/dynamic";
import type { NewVolumeBehaviorModel } from "@alm/engine/src/contracts/results";
import type { MarketSnapshot } from "@alm/kernel";
import type { PlatformContext } from "../../context";
import { buildBaseCurveNamed, curvePinOf, readActiveCurveSetup } from "../../workspaces/curveSetupSlot";
import { badRequest, unprocessable } from "../errors";
import type { Router } from "../router";

/** The deposit forms the run refuses on any dynamic scenario (component decay, full beta, replicating portfolio). */
const RUN_OFF_ONLY_FORMS: readonly string[] = ["component decay form", "full beta form", "replicating-portfolio credit"];

/** The months the target path covers when the body names none, and the most it may name. */
export const PREVIEW_MONTHS_DEFAULT = 60;
const PREVIEW_MONTHS_MAX = 360;

export interface NewVolumeFamilyPreview {
  familyId: string;
  label: string;
  side: string;
  instrumentType: string;
  /** The family's opening balance: the sum of its positions' notionals. */
  opening: number;
  /** The template the family's own positions suggest; null for deposits, commitments and swaps (today's rule). */
  suggested: SuggestedTemplate | null;
  /** The product the body's template for this family mints today; absent when the body names none for it. */
  preview?: TemplatePreview;
  /** The target balance by month 0..months from the body's plan; absent when the plan has no target for the family. */
  target?: { balance: number[]; monthlyGrowthRate: number | null; annualGrowthPct: number | null };
  /**
   * The behavioral model a new position of the family runs (the family's effective model), whatever product is
   * chosen; `reason` says why a family has none.
   */
  model: { model: NewVolumeBehaviorModel; label: string; source: "assumption-set" | "position" | "none"; modelVersions: string[]; reason?: string };
}

export interface NewVolumePreview {
  /** The calibration date of the curve the preview reads. */
  calibrationDate: string;
  /** Today's rule, drawn for comparison: a 60-month fixed bullet at the par swap rate (0 bp). */
  todayRule: TemplatePreview;
  families: NewVolumeFamilyPreview[];
  /** Sentences for what the engine refused (a template, the plan); empty when nothing was. */
  problems: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The preview for one book on one market. Pure over its inputs. */
export function newVolumePreview(
  book: PortfolioSpec,
  snapshot: MarketSnapshot,
  templates: readonly NewVolumeTemplateSpec[],
  plan: BalancePlan | null,
  months: number,
  /** The workspace's default assumption set, the one the guided run reads; null when none is saved. */
  assumptions: AssumptionSet | null = null,
): NewVolumePreview {
  const curve = buildBaseCurveNamed(snapshot);
  // The run's own term liquidity premium curve: a matched fixed product prices off it (fix round M3).
  const tlp = tlpOfSnapshot(snapshot);
  const path = buildScenarioRatePath(curve, { id: "preview", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: "preview", newBusiness: { mode: "static", rules: [] } }, 2 * PREVIEW_MONTHS_MAX);
  const problems: string[] = [];
  const opening = openingBalances(book);
  const byFamily = new Map(templates.map((t) => [t.familyId, t] as const));
  let targets = new Map<string, { reinvest: "flat" | "growth" | "runoff"; g: number }>();
  if (plan !== null) {
    try {
      const rules = lowerBalancePlan(plan, opening, PREVIEW_MONTHS_MAX, book.asOf, book.coa);
      targets = new Map(rules.map((r) => [r.familyId, { reinvest: r.reinvest, g: r.monthlyGrowthRate ?? 0 }] as const));
    } catch (e) {
      problems.push(`The targets cannot run as they stand: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const families: NewVolumeFamilyPreview[] = [];
  for (const fam of book.coa.families) {
    const own = book.positions.filter((p) => p.familyId === fam.id);
    if (own.length === 0 || (fam.side !== "asset" && fam.side !== "liability")) continue;
    // S3a-1 follow-up: a non-rate-sensitive family is held at book and takes no new volume, so it has no product.
    if (fam.instrumentType === "non-rate-sensitive") continue;
    const b0 = opening.get(fam.id) ?? 0;
    let behavior: ReturnType<typeof familyBehavior>;
    try {
      // Fix round L1: the run applies the set's macro mapping to new volume (resolveRunMacro maps exactly the base set's
      // macroBindings, or refuses the run), so the preview threads the same targets explicitly. A plugin's registered
      // behavioral kind needs the run's harness, which the preview does not mount: such a family reads "cannot be
      // previewed" here and runs its model at launch.
      behavior = familyBehavior(book, fam, assumptions ?? undefined, undefined, assumptions?.macroBindings ?? []);
    } catch (e) {
      behavior = { model: "none", source: "none", modelVersions: [], prototypeId: null, reason: `the saved models cannot be previewed for new volume here (${e instanceof Error ? e.message : String(e)})` };
    }
    const row: NewVolumeFamilyPreview = {
      // Fix round M3: the suggestion reads the family's model, so a deposit family on a form new deposits cannot carry
      // opens on today's fixed-rate stand-in, with the model's reason beside it.
      familyId: fam.id, label: fam.label, side: fam.side, instrumentType: fam.instrumentType, opening: b0, suggested: suggestedTemplate(fam, book.positions, behavior),
      model: { model: behavior.model, label: BEHAVIOR_MODEL_LABEL[behavior.model], source: behavior.source, modelVersions: [...behavior.modelVersions], ...(behavior.reason !== undefined ? { reason: behavior.reason } : {}) },
    };
    // Fix round M3: the component decay form, the full beta form and a replicating-portfolio credit run on run-off
    // scenarios only (the run refuses any dynamic scenario while one is bound), so no plan that replaces or targets
    // balances can run on such a set, whatever product is chosen. Said here, where the answer is chosen.
    if (behavior.depositForm !== undefined && RUN_OFF_ONLY_FORMS.includes(behavior.depositForm.form)) {
      problems.push(`${fam.label}: its ${behavior.depositForm.form} runs on run-off only, so balances cannot be replaced or follow targets while it is bound; choose "They run off", or bind another deposit model on the Behavior step.`);
    }
    const t = byFamily.get(fam.id);
    if (t !== undefined) {
      const problem = newVolumeTemplateProblem(t, t.termMonths, t.spreadOverIndexBp);
      if (problem !== null) problems.push(`${fam.label}: ${problem}.`);
      else if (t.rateType === "deposit" && behavior.model !== "nmd-decay" && behavior.model !== "nmd-decay-beta") {
        problems.push(`${fam.label}: ${behaviorGap(t, behavior) ?? "a deposit product needs a deposit family's decay model"}.`);
      } else row.preview = previewTemplate(t.termMonths, t.spreadOverIndexBp, t, path, tlp, behavior);
    }
    const target = targets.get(fam.id);
    if (target !== undefined && target.reinvest !== "runoff") {
      const balance: number[] = [];
      for (let k = 0; k <= months; k++) balance.push(reinvestmentTarget(target.reinvest, b0, target.g, k) as number);
      const growth = target.reinvest === "growth" ? target.g : null;
      row.target = { balance, monthlyGrowthRate: growth, annualGrowthPct: growth === null ? null : (Math.pow(1 + growth, 12) - 1) * 100 };
    }
    families.push(row);
  }
  return {
    calibrationDate: snapshot.calibrationDate,
    todayRule: previewTemplate(60, 0, { rateType: "fixed", amortization: "bullet", indexTenorMonths: 60, fixedIndex: "swap" }, path, tlp),
    families,
    problems,
  };
}

export function registerNewVolumePreviewRoute(router: Router, ctx: PlatformContext): void {
  router.add("POST", "/api/workspaces/:id/new-volume-preview", (req) => {
    const id = req.params.id ?? "";
    const head = ctx.workspaces.head(id);
    const body = req.json<unknown>();
    if (!isObj(body)) throw badRequest("the body is an object { templates?, plan?, months? }");
    const months = body.months === undefined ? PREVIEW_MONTHS_DEFAULT : body.months;
    if (typeof months !== "number" || !Number.isInteger(months) || months < 1 || months > PREVIEW_MONTHS_MAX) {
      throw badRequest(`"months" is a whole number from 1 to ${PREVIEW_MONTHS_MAX}`);
    }
    if (body.templates !== undefined && !Array.isArray(body.templates)) throw badRequest(`"templates" is an array of { familyId, rateType, amortization, indexTenorMonths, termMonths, spreadOverIndexBp }`);
    const templates = (body.templates ?? []) as NewVolumeTemplateSpec[];
    for (const [i, t] of templates.entries()) {
      if (!isObj(t) || typeof t.familyId !== "string" || typeof t.termMonths !== "number" || typeof t.spreadOverIndexBp !== "number" || typeof t.indexTenorMonths !== "number") {
        throw badRequest(`templates[${i}] needs familyId, rateType, amortization, indexTenorMonths, termMonths and spreadOverIndexBp`);
      }
    }
    if (body.plan !== undefined && body.plan !== null && !isObj(body.plan)) throw badRequest(`"plan" is a balance plan object`);
    const bookRef = head.blocks.positions.book;
    const marketRef = head.blocks.market.snapshot;
    if (bookRef === null || bookRef === undefined) throw unprocessable(`workspace "${id}" has no balance sheet yet`);
    if (marketRef === null || marketRef === undefined) throw unprocessable(`workspace "${id}" has no market snapshot yet`);
    const book = ctx.store.getDocument<PortfolioSpec>("portfolios", bookRef.id).doc;
    let snapshot = ctx.store.getDocument<MarketSnapshot>("market", marketRef.id).doc;
    // The curve the workspace's deterministic run reads: the active curve setup applied, as the launch pins it.
    const active = readActiveCurveSetup(ctx.store, head.blocks.market);
    if (active !== null) {
      const derived = curvePinOf(snapshot, marketRef.id, active.block);
      if (derived !== null) snapshot = derived.snapshot;
    }
    // The workspace's default assumption set, the one the guided run binds; a missing document reads as none.
    const setId = head.blocks.assumptions.defaultSetId;
    let assumptions: AssumptionSet | null = null;
    if (setId !== null && setId !== undefined) {
      try {
        assumptions = ctx.store.getDocument<AssumptionSet>("assumption-sets", setId).doc;
      } catch {
        assumptions = null;
      }
    }
    return { kind: "json", value: newVolumePreview(book, snapshot, templates, (body.plan as BalancePlan | undefined) ?? null, months, assumptions) };
  });
}
