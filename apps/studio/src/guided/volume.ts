// apps/studio/src/guided/volume.ts
/**
 * The guided New volume step: per family a target path (run off, hold the opening balance, or grow to a balance by a
 * month), the balance plan the targets save as, and the product each family's new volume
 * is: fixed or floating, how it repays, its term, the index it is priced off and its spread. The rows here are what the
 * learner typed; every number drawn (the target path, the growth rate, a product's rate today and its repayment) comes
 * from the server's preview, which runs the engine's own rules (POST /api/workspaces/:id/new-volume-preview). This file
 * restates none of them; the template rule itself is the engine's pure check, imported.
 *
 * A product carries its family's behavioral model (`behavior: "family"`): a loan or
 * mortgage prepays by the family's model where the product can carry it, and a deposit family's product is a new
 * deposit that decays and reprices by the family's model. Which model applies, and what it does to a tranche made
 * today, is the server's preview too.
 */
import type { BalancePlan, NewBusinessAmortization, NewBusinessRateType, NewBusinessTemplate, NewVolumeTemplateSpec } from "@alm/engine";
import type { RunSetup } from "@alm/reader";
import { newVolumeTemplateProblem } from "@alm/engine/src/plan/newVolumeTemplate";

export type TargetKind = "runoff" | "hold" | "grow";

export interface VolumeRow {
  familyId: string;
  label: string;
  /** The family's opening balance: the sum of its positions' notionals. */
  opening: number;
  kind: TargetKind;
  /** Grow only, as typed: the target balance in millions of dollars (L13) and the month it is reached. */
  balance: string;
  month: string;
}

export function newRow(familyId: string, label: string, opening: number): VolumeRow {
  return { familyId, label, opening, kind: "runoff", balance: "", month: "" };
}

/** Millions as typed to whole cents of dollars: 150 is 150,000,000 and 1.25 is 1,250,000. */
export function toDollars(millions: number): number {
  return Math.round(millions * 100_000_000) / 100;
}

const num = (s: string): number | null => (/^-?\d+(\.\d+)?$/.test(s.trim()) ? Number(s.trim()) : null);
const whole = (s: string): number | null => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : null);

/** Every problem with the targets, one sentence each, naming the family. Run-off rows have none. */
export function volumeProblems(rows: readonly VolumeRow[], horizonMonths = 360): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.kind === "runoff") continue;
    if (!(r.opening > 0)) out.push(`${r.label}: the family has no opening balance to hold or grow.`);
    if (r.kind === "grow") {
      const b = num(r.balance);
      const m = whole(r.month);
      if (b === null || !(b > 0)) out.push(`${r.label}: type the target balance in millions of dollars, above zero.`);
      if (m === null || m < 1 || m > horizonMonths) out.push(`${r.label}: type the month as a whole number from 1 to ${horizonMonths}.`);
    }
  }
  return out;
}

/**
 * The balance plan the rows save as; families on run-off are left out, as the plan's own rule says. Each target's
 * pricing (term and spread) is its family's product row, so the plan and the template say the same thing. Call on
 * rows and products with no problem.
 */
export function planOf(meta: { id: string; label: string; asOf: string }, rows: readonly VolumeRow[], products: readonly ProductRow[]): BalancePlan {
  const targets: BalancePlan["targets"] = [];
  for (const r of rows) {
    if (r.kind === "runoff") continue;
    const p = products.find((x) => x.familyId === r.familyId);
    const path = r.kind === "hold" ? [{ month: 1, balance: r.opening }] : [{ month: Number(r.month.trim()), balance: toDollars(Number(r.balance.trim())) }];
    targets.push({ familyId: r.familyId, path, newBusinessPricing: { spreadOverIndexBp: p === undefined ? 0 : Number(p.spreadBp.trim()), termMonths: p === undefined ? 60 : Number(p.termMonths.trim()) } });
  }
  return { schemaVersion: "1.0.0", id: meta.id, label: meta.label, asOf: meta.asOf, targets, unlistedFamilies: "runoff" };
}

/** The plan the rows would save as, for the preview, or null while a row has a problem or nothing is targeted. */
export function draftPlanOf(meta: { asOf: string }, rows: readonly VolumeRow[], products: readonly ProductRow[]): BalancePlan | null {
  if (volumeProblems(rows).length > 0 || productProblems(products).length > 0 || !rows.some((r) => r.kind !== "runoff")) return null;
  return planOf({ id: "bp-preview", label: "Preview", asOf: meta.asOf }, rows, products);
}

/** The rows a stored plan opens as: a one-knot flat path at the opening balance is a hold, any other one knot a grow. */
export function rowsFromPlan(base: readonly VolumeRow[], plan: BalancePlan | null): VolumeRow[] {
  if (plan === null) return base.map((r) => ({ ...r }));
  return base.map((r) => {
    const t = plan.targets.find((x) => x.familyId === r.familyId);
    if (t === undefined || t.path.length !== 1) return { ...r };
    const k = t.path[0]!;
    if (k.month === 1 && k.balance === r.opening) return { ...r, kind: "hold" };
    return { ...r, kind: "grow", balance: String(k.balance / 1_000_000), month: String(k.month) };
  });
}

// ---------------------------------------------------------------------------
// Products: what each family's new volume is
// ---------------------------------------------------------------------------

/** One family's product as typed. `swapTenor` is "term" (priced off the swap rate for its own term) or a month count. */
export interface ProductRow {
  familyId: string;
  label: string;
  rateType: NewBusinessRateType;
  amortization: NewBusinessAmortization;
  termMonths: string;
  spreadBp: string;
  /**
   * Fixed: "matched" (its own matched funding rate, the default, fix round M3), "term" (the swap rate for its own term)
   * or a swap tenor in months. Floating: the index tenor, 1, 3, 6 or 12.
   */
  indexTenor: string;
  /** One plain sentence on where the starting product came from (the family's positions, or today's rule). */
  origin: string;
  /**
   * The product carries its family's behavioral model (`behavior: "family"`). Always true on a deposit product;
   * false on today's rule and on a product saved before S2b-2.
   */
  behavior: boolean;
}

export const RATE_TYPE_LABEL: Record<NewBusinessRateType, string> = { fixed: "Fixed rate", floating: "Floating rate", deposit: "Deposit, its own rate" };
export const AMORTIZATION_LABEL: Record<NewBusinessAmortization, string> = { bullet: "Bullet: all at maturity", "level-pay": "Level payment", linear: "Equal principal each month", decay: "Decays by the family's model" };
/** The fixed swap tenors offered besides the product's own term, in months. */
export const SWAP_TENORS: readonly number[] = [12, 24, 36, 60, 84, 120];
/** The floating index tenors, in months (each is also the reset period). */
export const INDEX_TENORS: readonly number[] = [1, 3, 6, 12];

export const TODAYS_RULE = "Today's rule: a 60-month fixed-rate bullet at the par swap rate.";

/** Today's rule as a product row: a fixed bullet over `termMonths` at `spreadBp`, priced off the swap rate for its term. */
export function todaysRuleRow(familyId: string, label: string, termMonths = 60, spreadBp = 0, origin = TODAYS_RULE): ProductRow {
  return { familyId, label, rateType: "fixed", amortization: "bullet", termMonths: String(termMonths), spreadBp: String(spreadBp), indexTenor: "term", origin, behavior: false };
}

/** The template a row stands for, or null while a field is not a number. */
export function templateOfRow(r: ProductRow): NewVolumeTemplateSpec | null {
  const term = whole(r.termMonths);
  // A deposit product is fixed in shape (decay, the one-month rate, the family's model, no spread); only its term is typed.
  if (r.rateType === "deposit") {
    if (term === null) return null;
    return { familyId: r.familyId, rateType: "deposit", amortization: "decay", indexTenorMonths: 1, behavior: "family", termMonths: term, spreadOverIndexBp: 0 };
  }
  const spread = num(r.spreadBp);
  const matched = r.rateType === "fixed" && r.indexTenor === "matched";
  const tenor = r.indexTenor === "term" || matched ? term : whole(r.indexTenor);
  if (term === null || spread === null || tenor === null) return null;
  const fixedIndex = r.rateType !== "fixed" ? {} : { fixedIndex: matched ? ("matched" as const) : ("swap" as const) };
  return { familyId: r.familyId, rateType: r.rateType, amortization: r.amortization, indexTenorMonths: tenor, ...fixedIndex, ...(r.behavior ? { behavior: "family" as const } : {}), termMonths: term, spreadOverIndexBp: spread };
}

/** Every problem with the products, one sentence each, naming the family; the template rule is the engine's. */
export function productProblems(rows: readonly ProductRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (whole(r.termMonths) === null) { out.push(`${r.label}: type the term in whole months.`); continue; }
    if (r.rateType !== "deposit" && num(r.spreadBp) === null) { out.push(`${r.label}: type the spread in basis points.`); continue; }
    const t = templateOfRow(r);
    if (t === null) { out.push(`${r.label}: choose the index the rate is priced off.`); continue; }
    const problem = newVolumeTemplateProblem(t, t.termMonths);
    if (problem !== null) out.push(`${r.label}: ${problem}.`);
  }
  return out;
}

/** The templates the rows save as. Call on rows with no problem. */
export function templatesOf(rows: readonly ProductRow[]): NewVolumeTemplateSpec[] {
  return rows.map((r) => templateOfRow(r)!).filter((t) => t !== null);
}

/** A family as the preview names it, with the product its own positions suggest. */
export interface ProductFamily {
  familyId: string;
  label: string;
  suggested: { template: NewBusinessTemplate; termMonths: number; basis: string } | null;
  /** Fix round M3: the family's model as the preview reads it; a deposit family with none opens on the stand-in, with the reason. */
  model?: { model: string; reason?: string };
  instrumentType?: string;
}

/** Whether a family's model is one a deposit product carries (fix round M3). */
export const carriesDeposit = (f: { model?: { model: string } } | undefined): boolean => f?.model?.model === "nmd-decay" || f?.model?.model === "nmd-decay-beta";

/**
 * Fix round M3: why a deposit family's new volume is the stand-in, in one plain sentence, when its model is one a
 * deposit product cannot carry; null for any other family.
 */
export function standInReason(f: Pick<ProductFamily, "model" | "instrumentType"> | undefined): string | null {
  if (f === undefined || !DEPOSIT_TYPES.includes(f.instrumentType ?? "") || carriesDeposit(f) || f.model?.reason === undefined) return null;
  const r = f.model.reason;
  return `${r.charAt(0).toUpperCase()}${r.slice(1)}${r.endsWith(".") ? "" : "."}`;
}

/**
 * The product rows the step opens on. A family the setup gives a template opens on it. Without one, a setup that
 * already exists keeps today's rule (at its target's or its basis's term and spread): nothing is chosen for a stored
 * setup. Before any setup exists, each family opens on the product its own positions suggest (carrying the
 * family's behavior, and a new deposit for a deposit family), today's rule where there is none (term deposits,
 * commitments).
 */
export function productRowsFor(families: readonly ProductFamily[], setup: Pick<RunSetup, "nii"> | null, plan: BalancePlan | null): ProductRow[] {
  return families.map((f) => {
    const saved = setup?.nii.templates?.find((t) => t.familyId === f.familyId);
    if (saved !== undefined) {
      const tenor = tenorOf(saved);
      return { familyId: f.familyId, label: f.label, rateType: saved.rateType, amortization: saved.amortization, termMonths: String(saved.termMonths), spreadBp: String(saved.spreadOverIndexBp), indexTenor: tenor, origin: "Saved on your analysis.", behavior: saved.behavior === "family" };
    }
    if (setup !== null) {
      const target = plan?.targets.find((t) => t.familyId === f.familyId);
      const basis = setup.nii.basis;
      const term = target?.newBusinessPricing.termMonths ?? (basis.kind === "flat" ? basis.termMonths : 60);
      const spread = target?.newBusinessPricing.spreadOverIndexBp ?? (basis.kind === "flat" ? basis.spreadOverIndexBp : 0);
      return todaysRuleRow(f.familyId, f.label, term, spread, "Your analysis uses today's rule for this family: a fixed-rate bullet at the par swap rate.");
    }
    const s = f.suggested;
    // Fix round M3: a family suggested nothing opens on today's rule; a deposit family whose form new deposits cannot
    // carry says why, in the model's own sentence.
    if (s === null) return todaysRuleRow(f.familyId, f.label, 60, 0, standInReason(f) ?? TODAYS_RULE);
    const t = s.template;
    const tenor = tenorOf({ ...t, termMonths: s.termMonths });
    return { familyId: f.familyId, label: f.label, rateType: t.rateType, amortization: t.amortization, termMonths: String(s.termMonths), spreadBp: "0", indexTenor: tenor, origin: s.basis, behavior: t.behavior === "family" };
  });
}

/**
 * A row switched to another rate type: a floater starts on the one-month index, a fixed product on its own term. S2b-2:
 * a deposit product decays by the family's model at no spread; leaving it for a loan shape starts on today's bullet,
 * the fixed-rate stand-in, which carries no behavior.
 */
export function withRateType(r: ProductRow, rateType: NewBusinessRateType): ProductRow {
  if (rateType === r.rateType) return r;
  if (rateType === "deposit") return { ...r, rateType, amortization: "decay", indexTenor: "1", spreadBp: "0", behavior: true };
  if (r.rateType === "deposit") return { ...r, rateType, amortization: "bullet", indexTenor: rateType === "floating" ? "1" : "matched", behavior: false };
  return { ...r, rateType, indexTenor: rateType === "floating" ? "1" : "matched" };
}

/** A template's "priced off" as a row holds it: matched (a fixed template's default), the swap for its own term, or a tenor. */
function tenorOf(t: { rateType: NewBusinessRateType; indexTenorMonths: number; termMonths: number; fixedIndex?: "matched" | "swap" }): string {
  if (t.rateType === "deposit") return "1";
  if (t.rateType !== "fixed") return String(t.indexTenorMonths);
  if (t.fixedIndex !== "swap") return "matched";
  return t.indexTenorMonths === t.termMonths ? "term" : String(t.indexTenorMonths);
}

/**
 * What the learner can edit in a set of rows, for "Not saved yet" (fix round M1): the template each row stands for
 * (or its raw fields while one does not read), never the descriptive `origin` text, which changes when a save lands.
 */
export function productsKey(rows: readonly ProductRow[]): string {
  return JSON.stringify(rows.map((r) => templateOfRow(r) ?? { familyId: r.familyId, rateType: r.rateType, amortization: r.amortization, termMonths: r.termMonths, spreadBp: r.spreadBp, indexTenor: r.indexTenor, behavior: r.behavior }));
}

/** Whether the rows hold an edit the analysis does not (fix round M1). */
export function productsDirty(rows: readonly ProductRow[], saved: readonly ProductRow[]): boolean {
  return productsKey(rows) !== productsKey(saved);
}

/** The instrument types whose new volume can be a deposit product; a fixed product there is today's stand-in. */
export const DEPOSIT_TYPES: readonly string[] = ["nmd", "nmd-b"];
/** The visible caveat on a deposit row still on a loan shape (short, the column is narrow) and its full sentence (the row's title). */
export const DEPOSIT_STAND_IN = "Stand-in: no decay or repricing. Choose Deposit.";
export const DEPOSIT_STAND_IN_FULL = "Stand-in: this deposit family's new volume is fixed-rate funding with no decay or repricing. Choose Deposit as its rate, and each new deposit decays and reprices by the family's own model.";

/**
 * Fix round L5: a deposit product's term is a cut-off, not a life. The kernel deposit pays whatever balance is left in
 * its last month, so a short term ends each cohort with a lump outflow and shortens its value.
 */
export const DEPOSIT_TERM_SHORT = "Cut-off: what is left is paid out then.";
export const DEPOSIT_TERM_FULL = "For a deposit the term is a cut-off, not its life: each new deposit decays by the family's model, and whatever balance is left at the cut-off is paid out that month. Keep it at the family's own life (suggested) unless you mean a lump outflow.";

/** The words a product row's behavior reads in: the model the preview says its tranche runs, or contractual. */
export function behaviorWords(row: ProductRow, preview: { behavior?: { applied: boolean; note: string } } | undefined, model: { label: string } | undefined): string {
  if (!row.behavior) return "Contractual: no prepayment, decay or repricing.";
  if (preview?.behavior === undefined) return model === undefined ? "Carries the family's model." : `${model.label}.`;
  return preview.behavior.applied && model !== undefined ? `${model.label}, aged from the month it is made.` : preview.behavior.note;
}
export const SWAP_PRICED_NOTE = "Priced off a swap rate: a fixed product whose schedule does not match that swap earns the gap between the two as margin, even at 0 bp. Matched funding prices it at its own transfer rate.";
