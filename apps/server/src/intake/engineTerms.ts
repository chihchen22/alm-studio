/**
 * Intake for the engine-side terms: the three position types the engine builds beside
 * the frozen kernel (a `swap`, a `cd` cohort book and a `commitment`), the two engine-extension terms fields a position
 * may carry itself (`fundingTenorMonths` on a floating loan, `linearDecay` on an nmd deposit) and the `liquidityRole`
 * tag the liquidity stress ladder reads.
 *
 * The kernel's five types keep their GENERATED contract (columnContract.ts); these are stated here by hand because
 * they live in engine sources, not kernel ones, and the engine's own validators (`validateSwapTerms`,
 * `validateCdTerms`, `validateCommitmentTerms`, `linearDecayIssues`) stay the domain authority. Intake adds only what
 * a person importing a file needs on top: every problem named by row and field, never a bare constructor message.
 *
 * Every function here is pure: no store, no market.
 */
import type { Position } from "@alm/engine";
import { LIQUIDITY_ROLES } from "@alm/engine";
import { CdAdapterError, validateCdTerms, type CdTerms } from "@alm/engine/src/cd/terms";
import { CommitmentTermsError, validateCommitmentTerms, type CommitmentTerms } from "@alm/engine/src/commitment/terms";
import { SwapTermsError, validateSwapTerms, type SwapTerms } from "@alm/engine/src/swap/terms";
import { NonRateTermsError, validateNonRateTerms, type NonRateTerms } from "@alm/engine/src/nonRate";
import { checkOverlayParams, componentDecayIssues, fullFormIssues, linearDecayIssues, replicatingPortfolioIssues, type ParamIssue } from "@alm/engine/src/contracts/paramSchema";
import { CD_DEFAULT_PARAMS } from "@alm/kernel";
import type { ColumnSpec } from "./columnContract";

/**
 * The CSV columns of the engine-side types and of the engine-extension scalar a kernel type may carry. A cd cohort
 * book is one row per cohort, rows sharing a position_id: each row's `notional` is the cohort's dollars and its
 * `maturityMonths` the cohort's months to maturity, beside its original `termMonths` and its `contractRate`. A
 * commitment's draw path is `drawRampRates` (fractions joined by "|", month 1 first) and `drawSteadyRate`.
 */
export const ENGINE_CSV_COLUMNS: Record<EngineTermsType, ColumnSpec[]> = {
  swap: [
    { name: "direction", kind: "enum", enumValues: ["pay-fixed", "receive-fixed"], required: true, doc: "The leg the bank pays." },
    { name: "fixedRate", kind: "number", required: true, doc: "Fixed leg coupon, annual decimal." },
    { name: "floatMargin", kind: "number", required: false, doc: "Floating leg margin over the one-month benchmark, annual decimal. Default 0." },
    { name: "resetFrequencyMonths", kind: "number", required: false, doc: "Floating leg reset cadence in months. Default 1." },
  ],
  cd: [
    { name: "termMonths", kind: "number", required: true, doc: "The cohort's original term in months: 1, 2, 3, 6, 9, 12, 18, 24, 36, 48 or 60." },
    { name: "contractRate", kind: "number", required: true, doc: "The cohort's contract rate, annual decimal." },
  ],
  "non-rate-sensitive": [],
  commitment: [
    { name: "drawRampRates", kind: "string", required: false, doc: 'Monthly draw fractions of what is still undrawn, month 1 first, joined by "|". Blank draws nothing in the ramp.' },
    { name: "drawSteadyRate", kind: "number", required: false, doc: "The draw fraction from the month after the ramp onward. Blank is 0." },
  ],
};

/**
 * The engine-extension scalar columns a kernel type may carry on the CSV path: a floater's funding tenor and,
 * Studio slice S3c-1, an nmd deposit's straight-line runoff, whose one number the CSV path writes as the
 * terms' `linearDecay: { horizonMonths }` (LINEAR_DECAY_CSV_COLUMN).
 */
export const KERNEL_EXTRA_CSV_COLUMNS: Record<string, ColumnSpec[]> = {
  "floating-loan": [{ name: "fundingTenorMonths", kind: "number", required: false, doc: "The funding tenor in whole months its liquidity charge is read at. Blank reads the kernel's term rate." }],
  nmd: [{ name: "linearDecayMonths", kind: "number", required: false, doc: "A straight-line runoff over this many whole months, equal to maturityMonths: the balance falls by the same amount every month. Blank runs the deposit's own decay." }],
};

/** The CSV column that carries an nmd's straight-line runoff, and the terms field it fills. */
export const LINEAR_DECAY_CSV_COLUMN = "linearDecayMonths";

/** Every engine-side CSV column name, unique, in a stable order. */
export function engineCsvColumnNames(): string[] {
  const out: string[] = [];
  for (const cols of [...Object.values(ENGINE_CSV_COLUMNS), ...Object.values(KERNEL_EXTRA_CSV_COLUMNS)]) {
    for (const c of cols) if (!out.includes(c.name)) out.push(c.name);
  }
  return out;
}

/** The engine-side position types intake admits, in the order the docs list them. */
export const ENGINE_TERMS_TYPES = ["swap", "cd", "commitment", "non-rate-sensitive"] as const;
export type EngineTermsType = (typeof ENGINE_TERMS_TYPES)[number];

export function isEngineTermsType(t: unknown): t is EngineTermsType {
  return typeof t === "string" && (ENGINE_TERMS_TYPES as readonly string[]).includes(t);
}

/**
 * The type-specific scalar fields of each engine-side type, as JSON terms fields. The shared fields (label, notional,
 * maturityMonths, originationOffsetMonths, amortType, side) come from the kernel's base contract. The object fields
 * (`cohorts` on a cd book, `draw` on a commitment) are checked by `objectFieldErrors`.
 */
export const ENGINE_TERMS_COLUMNS: Record<EngineTermsType, ColumnSpec[]> = {
  swap: [
    { name: "direction", kind: "enum", enumValues: ["pay-fixed", "receive-fixed"], required: true, doc: "The leg the bank pays: pay-fixed pays the fixed leg and receives the floating leg." },
    { name: "fixedRate", kind: "number", required: true, doc: "Fixed leg coupon, annual decimal (0.0375 is 3.75 percent)." },
    { name: "floatMargin", kind: "number", required: false, doc: "Floating leg margin over the one-month benchmark, annual decimal. Default 0." },
    { name: "resetFrequencyMonths", kind: "number", required: false, doc: "Floating leg reset cadence in months. Default 1." },
  ],
  cd: [],
  commitment: [],
  "non-rate-sensitive": [],
};

/** The object fields of each engine-side type (not CSV cells; the CSV path builds them from its own columns). */
export const ENGINE_OBJECT_FIELDS: Record<EngineTermsType, string[]> = { swap: [], cd: ["cohorts"], commitment: ["draw"], "non-rate-sensitive": [] };

/** What a swap, a cd book and a commitment say about `amortType` and `side`, in the order the checks read them. */
const SIDE_RULE: Record<EngineTermsType, "absent" | "asset" | "optional"> = { swap: "absent", cd: "optional", commitment: "asset", "non-rate-sensitive": "optional" };

/** The cd cohort fields, each a required number. */
const COHORT_FIELDS = ["termMonths", "monthsToMaturity", "balance", "contractRate"] as const;

/**
 * Row errors for the object fields and the side and amortization rules of an engine-side type. `push` takes the field
 * (the JSON terms path, for example `cohorts[2].termMonths`) and a sentence.
 */
export function engineFieldErrors(type: EngineTermsType, t: Record<string, unknown>, push: (column: string, message: string) => void): void {
  if (t.amortType !== undefined && t.amortType !== "bullet") {
    push("amortType", `field "amortType" must be "bullet" on ${type} terms, got ${JSON.stringify(t.amortType)}`);
  }
  const rule = SIDE_RULE[type];
  if (rule === "absent" && t.side !== undefined) {
    push("side", `field "side" must be absent on swap terms: a swap's side comes from its family, "derivative"; got ${JSON.stringify(t.side)}`);
  } else if (rule === "asset" && t.side !== "asset") {
    push("side", `field "side" must be "asset" on commitment terms (a line is extended by the bank), got ${JSON.stringify(t.side)}`);
  }
  if (type === "cd") {
    const cohorts = t.cohorts;
    if (!Array.isArray(cohorts) || cohorts.length === 0) {
      push("cohorts", `field "cohorts" must be a non-empty array of { termMonths, monthsToMaturity, balance, contractRate }`);
      return;
    }
    cohorts.forEach((c, i) => {
      if (c === null || typeof c !== "object" || Array.isArray(c)) {
        push(`cohorts[${i}]`, `cohort ${i + 1} must be an object { termMonths, monthsToMaturity, balance, contractRate }`);
        return;
      }
      const row = c as Record<string, unknown>;
      for (const f of COHORT_FIELDS) {
        const v = row[f];
        if (typeof v !== "number" || !Number.isFinite(v)) push(`cohorts[${i}].${f}`, `cohort ${i + 1}: "${f}" must be a finite number, got ${JSON.stringify(v)}`);
      }
      for (const k of Object.keys(row)) {
        if (!(COHORT_FIELDS as readonly string[]).includes(k)) push(`cohorts[${i}].${k}`, `cohort ${i + 1}: "${k}" is not a cohort field (termMonths, monthsToMaturity, balance, contractRate)`);
      }
      if (typeof row.balance === "number" && Number.isFinite(row.balance) && row.balance <= 0) {
        push(`cohorts[${i}].balance`, `cohort ${i + 1}: "balance" must be positive, got ${row.balance}`);
      }
    });
    // Fix round M3: the CSV path's rule on the JSON path. The walk runs at each cohort's balance times the kernel's walk
    // scale and only the output is scaled to the notional, so a notional that is not the cohorts' sum would silently
    // move the walk's balance covariate (cd/terms.ts). Within half a percent, for rounding of the stylized balances.
    // Read only when every cohort's balance is a positive number: a cohort refused above is named once, on its own field.
    const balances = cohorts.map((c) => (c !== null && typeof c === "object" ? (c as { balance?: unknown }).balance : undefined));
    const ok = balances.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0);
    const sum = ok ? (balances as number[]).reduce((acc, x) => acc + x, 0) * CD_WALK_SCALE_DOLLARS : Number.NaN;
    const n = t.notional;
    if (ok && typeof n === "number" && Number.isFinite(n) && n > 0 && Math.abs(n - sum) > CD_NOTIONAL_TOLERANCE * n) {
      push(
        "notional",
        `field "notional" (${n}) must be the cd book's cohorts added up: their balances times the walk scale of $${CD_WALK_SCALE_DOLLARS.toLocaleString("en-US")} a unit come to $${Math.round(sum).toLocaleString("en-US")}`,
      );
    }
  }
  if (type === "commitment") {
    const draw = t.draw;
    if (draw === null || typeof draw !== "object" || Array.isArray(draw)) {
      push("draw", `field "draw" must be an object { rampRates: number[], steadyRate: number }`);
      return;
    }
    const d = draw as Record<string, unknown>;
    if (!Array.isArray(d.rampRates)) push("draw.rampRates", `field "draw.rampRates" must be an array of fractions (it may be empty)`);
    else d.rampRates.forEach((r, i) => {
      if (typeof r !== "number" || !Number.isFinite(r)) push(`draw.rampRates[${i}]`, `draw month ${i + 1} must be a finite fraction, got ${JSON.stringify(r)}`);
    });
    if (typeof d.steadyRate !== "number" || !Number.isFinite(d.steadyRate)) push("draw.steadyRate", `field "draw.steadyRate" must be a finite fraction, got ${JSON.stringify(d.steadyRate)}`);
    for (const k of Object.keys(d)) if (k !== "rampRates" && k !== "steadyRate") push(`draw.${k}`, `"${k}" is not a field of the draw path (rampRates, steadyRate)`);
  }
}

/** The field each engine validator's refusal code is about. */
const CODE_FIELD: Record<string, string> = {
  "swap-terms-notional": "notional",
  "swap-terms-maturity": "maturityMonths",
  "swap-terms-offset": "originationOffsetMonths",
  "swap-terms-amort": "amortType",
  "swap-terms-side": "side",
  "swap-terms-direction": "direction",
  "swap-terms-fixed-rate": "fixedRate",
  "swap-terms-margin": "floatMargin",
  "swap-terms-reset": "resetFrequencyMonths",
  "cd-terms-amort": "amortType",
  "cd-terms-notional": "notional",
  "cd-terms-origination-offset": "originationOffsetMonths",
  "cd-terms-cohorts-empty": "cohorts",
  "cd-terms-maturity": "maturityMonths",
  "cd-terms-term": "termMonths",
  "cd-terms-mtm": "monthsToMaturity",
  "cd-terms-balance": "balance",
  "cd-terms-rate": "contractRate",
  "commitment-terms-notional": "notional",
  "commitment-terms-maturity": "maturityMonths",
  "commitment-terms-offset": "originationOffsetMonths",
  "commitment-terms-draw": "draw",
  "commitment-terms-ramp": "draw.rampRates",
  "commitment-terms-steady": "draw.steadyRate",
  "non-rate-terms-notional": "notional",
  "non-rate-terms-maturity": "maturityMonths",
  "non-rate-terms-offset": "originationOffsetMonths",
  "non-rate-terms-amort": "amortType",
  "non-rate-terms-side": "side",
};

/** The engine's own domain check of an engine-side type, as one row error with its field; null when the terms pass. */
export function engineDomainError(type: EngineTermsType, terms: Record<string, unknown>): { column: string; message: string } | null {
  try {
    if (type === "swap") validateSwapTerms(terms as unknown as SwapTerms);
    else if (type === "cd") validateCdTerms(terms as unknown as CdTerms);
    else if (type === "non-rate-sensitive") validateNonRateTerms(terms as unknown as NonRateTerms);
    else validateCommitmentTerms(terms as unknown as CommitmentTerms);
    return null;
  } catch (err) {
    if (err instanceof SwapTermsError || err instanceof CdAdapterError || err instanceof CommitmentTermsError || err instanceof NonRateTermsError) {
      let column = CODE_FIELD[err.code] ?? "terms";
      const cohort = /cohort\[(\d+)\]/.exec(err.message);
      if (type === "cd" && cohort !== null && (COHORT_FIELDS as readonly string[]).includes(column)) column = `cohorts[${cohort[1]}].${column}`;
      const ramp = /rampRates\[(\d+)\]/.exec(err.message);
      if (column === "draw.rampRates" && ramp !== null) column = `draw.rampRates[${ramp[1]}]`;
      return { column, message: err.message };
    }
    return { column: "terms", message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The two engine-extension terms fields a position may carry itself, each checked on the type that reads it and
 * refused on any other: `fundingTenorMonths` on a floating loan (the funding tenor its liquidity FTP is read
 * at) and `linearDecay` on an nmd deposit (a straight-line runoff). Returns the fields it recognised, so
 * the caller does not warn about them as unread.
 */
export function extensionFieldErrors(termsType: string, t: Record<string, unknown>, push: (column: string, message: string) => void): string[] {
  const known: string[] = [];
  if (t.fundingTenorMonths !== undefined) {
    known.push("fundingTenorMonths");
    const v = t.fundingTenorMonths;
    if (termsType !== "floating-loan") {
      push("fundingTenorMonths", 'field "fundingTenorMonths" applies to floating-loan terms only: it is the funding tenor a floater\'s liquidity charge is read at');
    } else if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      push("fundingTenorMonths", `field "fundingTenorMonths" must be a whole number of months from 1, got ${JSON.stringify(v)}`);
    }
  }
  if (t.linearDecay !== undefined) {
    known.push("linearDecay");
    if (termsType !== "nmd") {
      push("linearDecay", 'field "linearDecay" applies to nmd terms only: it is a straight-line runoff of a non-interest deposit');
    } else {
      for (const issue of linearDecayIssues(t.linearDecay, typeof t.maturityMonths === "number" ? t.maturityMonths : Number.NaN)) {
        push(issue.path, `field "${issue.path}" ${issue.message}`);
      }
    }
  }
  // Fix round (open item 3): the overlay-written groups. Each is read by the engine when a position carries it on the
  // type below, so there it is a checked field (the engine's own validators); on any other type the engine does not
  // read it, and the generic "ignored by the engine" warning stays true and stays as it was.
  const group = (field: string, types: readonly string[], check: (v: unknown) => ParamIssue[], from?: string) => {
    if (t[field] === undefined || !types.includes(termsType)) return;
    known.push(field);
    for (const issue of check(t[field])) {
      const path = from !== undefined && issue.path.startsWith(from) ? field + issue.path.slice(from.length) : issue.path.startsWith(field) ? issue.path : `${field}.${issue.path}`;
      push(path, `field "${path}" ${issue.message}`);
    }
  };
  group("prepay", ["fixed-loan"], (v) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return [{ path: "prepay", label: "Prepayment", message: "must be an object { annualCpr, stressAnnualCpr? }" }];
    const extra = Object.keys(v).filter((k) => k !== "annualCpr" && k !== "stressAnnualCpr").map((k) => ({ path: k, label: "Prepayment", message: "is not a field of the constant prepayment (annualCpr, stressAnnualCpr)" }));
    return [...extra, ...checkOverlayParams({ kind: "prepay", model: "constant-cpr", ...(v as { annualCpr: number }) })];
  });
  group("fullBeta", ["nmd-b"], fullFormIssues, "fullForm");
  group("componentDecay", ["nmd"], componentDecayIssues);
  group("replicatingPortfolio", ["nmd", "nmd-b"], replicatingPortfolioIssues);
  group("depositSlotting", ["nmd-b"], (v) => {
    if (v !== "frozen" && v !== "shocked-level") return [{ path: "depositSlotting", label: "Slotting", message: `must be "frozen" or "shocked-level", got ${JSON.stringify(v)}` }];
    return t.fullBeta === undefined ? [{ path: "depositSlotting", label: "Slotting", message: "applies to a deposit that carries a full beta form (fullBeta)" }] : [];
  });
  return known;
}

/**
 * The liquidity stress ladder reads a position's `liquidityRole` tag. A value outside its six roles would
 * import, and then the ladder would leave the position out without a word: intake refuses it by row and field.
 */
export function liquidityRoleErrors(p: Position, family?: { side: string; instrumentType: string }): string[] {
  const raw = p.dimensions?.liquidityRole;
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  const out = values
    .filter((v) => !(LIQUIDITY_ROLES as readonly string[]).includes(v))
    .map((v) => `liquidityRole ${JSON.stringify(v)} is not one of the ${LIQUIDITY_ROLES.length} roles the liquidity stress ladder reads (${LIQUIDITY_ROLES.join(", ")})`);
  if (out.length > 0 || family === undefined) return out;
  // Fix round L2: a role must fit the position's side. The ladder reads an asset role's principal as an inflow and a
  // liability role's runoff as an outflow; a swap or an undrawn line has no role in it.
  for (const v of values) {
    if (family.side === "derivative" || family.instrumentType === "commitment") {
      out.push(`liquidityRole ${JSON.stringify(v)} does not apply to ${family.side === "derivative" ? "a swap" : "an undrawn commitment"}: the stress ladder reads balance sheet positions only`);
    } else if (family.side === "liability" && (v === "inflow-asset" || v === "hqla-stock")) {
      out.push(`liquidityRole ${JSON.stringify(v)} is an asset role; a liability takes "hys-pool", "nib-pool", "wholesale" or "term-deposit"`);
    } else if (family.side === "asset" && (v === "wholesale" || v === "hys-pool" || v === "nib-pool" || v === "term-deposit")) {
      out.push(`liquidityRole ${JSON.stringify(v)} is a liability role; an asset takes "inflow-asset" or "hqla-stock"`);
    }
  }
  return out;
}

/**
 * The stylized cohort balance a cd cohort of `dollars` carries on the CSV path: dollars over the kernel's walk scale,
 * so the walk runs at the cohort's own dollar size (cd/terms.ts module header). The JSON path states balances itself.
 */
export function cdStylizedBalance(dollars: number): number {
  return dollars / CD_DEFAULT_PARAMS.walkScale;
}

/** The kernel's walk scale, for messages and docs. */
export const CD_WALK_SCALE_DOLLARS: number = CD_DEFAULT_PARAMS.walkScale;

/** Fix round M3: how far a cd book's notional may sit from its cohorts' sum in dollars, as a fraction of the notional. */
export const CD_NOTIONAL_TOLERANCE = 0.005;
