/**
 * Shape gate for an untrusted run setup document (Studio A+E spec v3.1 Section 5.2). Same discipline as `parseBalancePlan` (`routes/plans.ts`): every field of
 * `RunSetup` is checked and copied into a fresh object, so no raw TypeError escapes the
 * route, every refusal is a 422 naming the field, and the bytes a document stores depend
 * only on its declared content (an unknown key never reaches the store, so two submissions
 * of the same setup are the same `rs-<16 hex>` document).
 *
 * The plan template's stage list, reports, validation rules, profile, views and scenario
 * entries are the engine's own shapes. They are gated by the engine's `parseRunPlan`, run
 * over a stand-in plan, so a setup can never carry a stage or a report the engine would
 * refuse later.
 *
 * What this gate does NOT do: it never reads the store or the workspace. Whether a slate,
 * a set or a balance plan exists is the compile's question, and a setup written
 * before its inputs are attached is legal by design (an immutable document, MAJOR 4).
 */
import {
  liquidityStressConfigError,
  liquidityStressOptionsOf,
  modelConventionConfigError,
  nmdWarmupConfigError,
  nmdWarmupOf,
  PLAN_SCHEMA_VERSION,
  segSettingsConfigError,
  segSettingsOf,
  PlanShapeError,
  parseRunPlan,
  newVolumeTemplateProblem,
  type NewBusinessTemplate,
  type NewVolumeTemplateSpec,
  type PlanScenarioRef,
} from "@alm/engine";
import { unprocessable } from "../http/errors";
import type {
  EveSettings,
  GapSettings,
  NiiBasis,
  NiiSettings,
  RunSetup,
  SetupInputs,
  SetupPlanTemplate,
  SetupScenarios,
} from "./types";

type Obj = Record<string, unknown>;

export const SETUP_NAME_MAX = 80;
const BATCH_LABEL_MAX = 80;
const NOTE_MAX = 2000;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function bad(field: string, detail: string): never {
  throw unprocessable(`${field}: ${detail}`, { field });
}

function obj(v: unknown, at: string): Obj {
  if (!isObj(v)) return bad(at, "expected an object");
  return v;
}

function str(o: Obj, key: string, at: string, max?: number): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim().length === 0) return bad(`${at}.${key}`, "expected a non-empty string");
  if (max !== undefined && v.length > max) return bad(`${at}.${key}`, `expected at most ${max} characters`);
  return v;
}

function bool(o: Obj, key: string, at: string): boolean {
  const v = o[key];
  if (typeof v !== "boolean") return bad(`${at}.${key}`, "expected true or false");
  return v;
}

function oneOf<T extends string>(o: Obj, key: string, at: string, allowed: readonly T[]): T {
  const v = o[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    return bad(`${at}.${key}`, `expected one of ${allowed.map((a) => `"${a}"`).join(", ")}, got ${JSON.stringify(v)}`);
  }
  return v as T;
}

function posInt(v: unknown, at: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return bad(at, `expected a positive integer, got ${JSON.stringify(v)}`);
  return v;
}

function strList(v: unknown, at: string): string[] {
  if (!Array.isArray(v)) return bad(at, "expected an array of strings");
  return v.map((s, i) => {
    if (typeof s !== "string" || s.length === 0) return bad(`${at}[${i}]`, "expected a non-empty string");
    return s;
  });
}

/** Strictly increasing positive month edges (a bucket or interval ladder), each at most the grid horizon. */
function edges(v: unknown, at: string, gridHorizonMonths: number): number[] {
  if (!Array.isArray(v) || v.length === 0) return bad(at, "expected a non-empty array of month edges");
  const out = v.map((n, i) => {
    const m = posInt(n, `${at}[${i}]`);
    if (m > gridHorizonMonths) return bad(`${at}[${i}]`, `expected at most gridHorizonMonths (${gridHorizonMonths}), got ${m}`);
    return m;
  });
  for (let i = 1; i < out.length; i++) {
    if (out[i]! <= out[i - 1]!) return bad(`${at}[${i}]`, `edges must strictly increase, ${out[i]} follows ${out[i - 1]}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inputs, scenarios, basis
// ---------------------------------------------------------------------------

function assumptionSetIds(v: unknown, at: string): SetupInputs["assumptionSetIds"] {
  if (Array.isArray(v)) {
    if (v.length === 0) return bad(at, `expected a non-empty array of set ids, or { "kind": "block-default" }`);
    const ids = strList(v, at);
    if (new Set(ids).size !== ids.length) return bad(at, "a set id is listed twice");
    return ids;
  }
  if (isObj(v) && v.kind === "block-default") return { kind: "block-default" };
  return bad(at, `expected a non-empty array of set ids, or { "kind": "block-default" }`);
}

function parseInputs(v: unknown): SetupInputs {
  const x = obj(v, "inputs");
  const b = obj(x.book, "inputs.book");
  const book: SetupInputs["book"] =
    oneOf(b, "role", "inputs.book", ["base", "retagged"]) === "base" ? { role: "base" } : { role: "retagged", id: str(b, "id", "inputs.book") };
  const m = obj(x.market, "inputs.market");
  const market: SetupInputs["market"] =
    oneOf(m, "role", "inputs.market", ["base", "derived"]) === "base"
      ? { role: "base" }
      : { role: "derived", definitionKey: str(m, "definitionKey", "inputs.market") };
  return { book, market, assumptionSetIds: assumptionSetIds(x.assumptionSetIds, "inputs.assumptionSetIds") };
}

/** One library reference reads "<library id>#<scenario id>" (`plan/resolveScenarios.ts`). */
function libraryRef(v: unknown, at: string): string {
  if (typeof v !== "string" || v.indexOf("#") <= 0 || v.indexOf("#") === v.length - 1) {
    return bad(at, `expected "<library id>#<scenario id>", got ${JSON.stringify(v)}`);
  }
  return v;
}

/** The engine's own gate runs over the plan-scenarios items and the plan template (see the file header). */
function shapeRefusal(err: PlanShapeError, scenariosAt: string): never {
  // PlanShapeError.field is relative to a RunPlan; a setup nests those parts one level down.
  let field = err.field;
  if (field.startsWith("scenarios")) field = `${scenariosAt}${field.slice("scenarios".length)}`;
  else if (!field.startsWith("plan.")) field = `plan.${field}`;
  return bad(field, err.message.slice(err.field.length + 2));
}

function standIn(parts: Obj, scenarios: unknown[]): ReturnType<typeof parseRunPlan> {
  return parseRunPlan({
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: "setup-stand-in",
    label: "setup-stand-in",
    authoredBy: "person",
    asOf: "1970-01-01",
    grid: { horizonMonths: 1 },
    inputs: { marketSnapshot: "x", positionBook: "x", routingPolicy: "x" },
    stages: [],
    reports: [],
    validationRules: { typeGate: [], routingGate: [] },
    ...parts,
    scenarios,
  });
}

function parseScenarios(v: unknown, at: string): SetupScenarios {
  const x = obj(v, at);
  const kind = oneOf(x, "kind", at, ["library", "slate", "plan-scenarios"]);
  if (kind === "library") {
    if (!Array.isArray(x.refs)) return bad(`${at}.refs`, "expected an array of library references");
    return { kind, refs: x.refs.map((r, i) => libraryRef(r, `${at}.refs[${i}]`)) };
  }
  if (kind === "slate") {
    const slateId = str(x, "slateId", at);
    const include = x.include;
    if (include === "all") return { kind, slateId, include: "all" };
    if (!Array.isArray(include)) return bad(`${at}.include`, `expected "all" or an array of scenario ids`);
    return { kind, slateId, include: strList(include, `${at}.include`) };
  }
  if (!Array.isArray(x.items)) return bad(`${at}.items`, "expected an array of scenario refs and definitions");
  try {
    const plan = standIn({}, x.items);
    return { kind, items: plan.scenarios as PlanScenarioRef[] };
  } catch (err) {
    if (err instanceof PlanShapeError) return shapeRefusal(err, `${at}.items`);
    throw err;
  }
}

function parseBasis(v: unknown, at: string): NiiBasis {
  const x = obj(v, at);
  const kind = oneOf(x, "kind", at, ["flat", "runoff", "custom"]);
  if (kind === "runoff") return { kind };
  if (kind === "custom") return { kind, balancePlanId: str(x, "balancePlanId", at) };
  // S2b-1 lifts Slice 1's pin (ruling 18, the literal 60 and 0) to the plan's own range: the term a whole
  // number of months from 1 to 360 (the grid's cap; the plan parser takes any positive integer), the spread any finite
  // number of basis points. A stored setup at 60 and 0 parses to the same document.
  const termMonths = posInt(x.termMonths, `${at}.termMonths`);
  if (termMonths > MAX_TEMPLATE_TERM) return bad(`${at}.termMonths`, `expected a whole number of months from 1 to ${MAX_TEMPLATE_TERM}, got ${termMonths}`);
  if (typeof x.spreadOverIndexBp !== "number" || !Number.isFinite(x.spreadOverIndexBp)) {
    return bad(`${at}.spreadOverIndexBp`, `expected a finite number of basis points, got ${JSON.stringify(x.spreadOverIndexBp)}`);
  }
  return { kind, termMonths, spreadOverIndexBp: x.spreadOverIndexBp };
}

/** The longest new-volume term a setup may name, in months (the engine's template cap and the grid's). */
const MAX_TEMPLATE_TERM = 360;

/**
 * The new-volume templates: one row per family, each a product the engine runs (its own rule,
 * newVolumeTemplateProblem), with its term and spread. The family ids are checked against the book at compile.
 */
function parseTemplates(v: unknown, at: string): NewVolumeTemplateSpec[] {
  if (!Array.isArray(v)) return bad(at, "expected an array of { familyId, rateType, amortization, indexTenorMonths, termMonths, spreadOverIndexBp }");
  const seen = new Set<string>();
  return v.map((row, i) => {
    const here = `${at}[${i}]`;
    const r = obj(row, here);
    const familyId = str(r, "familyId", here, 64);
    if (seen.has(familyId)) return bad(`${here}.familyId`, `family "${familyId}" has more than one template`);
    seen.add(familyId);
    const rateType = oneOf(r, "rateType", here, ["fixed", "floating", "deposit"]);
    const amortization = oneOf(r, "amortization", here, ["bullet", "level-pay", "linear", "decay"]);
    const indexTenorMonths = posInt(r.indexTenorMonths, `${here}.indexTenorMonths`);
    const termMonths = posInt(r.termMonths, `${here}.termMonths`);
    if (typeof r.spreadOverIndexBp !== "number" || !Number.isFinite(r.spreadOverIndexBp)) {
      return bad(`${here}.spreadOverIndexBp`, `expected a finite number of basis points, got ${JSON.stringify(r.spreadOverIndexBp)}`);
    }
    const template: NewBusinessTemplate = { rateType, amortization, indexTenorMonths };
    if (r.fixedIndex !== undefined) template.fixedIndex = oneOf(r, "fixedIndex", here, ["matched", "swap"] as const);
    // The family's behavior on new volume, left out when absent so an S2b-1 setup keeps its bytes.
    if (r.behavior !== undefined) template.behavior = oneOf(r, "behavior", here, ["family"] as const);
    const problem = newVolumeTemplateProblem(template, termMonths, r.spreadOverIndexBp);
    if (problem !== null) return bad(here, problem);
    return {
      familyId, rateType, amortization, indexTenorMonths,
      ...(template.fixedIndex !== undefined ? { fixedIndex: template.fixedIndex } : {}),
      ...(template.behavior !== undefined ? { behavior: template.behavior } : {}),
      termMonths, spreadOverIndexBp: r.spreadOverIndexBp,
    };
  });
}

// ---------------------------------------------------------------------------
// Plan template
// ---------------------------------------------------------------------------

function parsePlanTemplate(v: unknown): SetupPlanTemplate {
  const x = obj(v, "plan");
  let planId: string | null;
  if (x.planId === null) planId = null;
  else planId = str(x, "planId", "plan", 64);
  const label = str(x, "label", "plan");
  const authoredBy = oneOf(x, "authoredBy", "plan", ["person", "orchestrator"]);
  const out: SetupPlanTemplate = { planId, label, authoredBy, stages: [], reports: [], validationRules: { typeGate: [], routingGate: [] } };
  if (x.note !== undefined) {
    if (typeof x.note !== "string" || x.note.length > NOTE_MAX) return bad("plan.note", `expected a string of at most ${NOTE_MAX} characters`);
    out.note = x.note;
  }
  const derived = x.stages === "derived-default";
  if (!derived && !Array.isArray(x.stages)) return bad("plan.stages", `expected "derived-default" or an array of stages`);
  if (!Array.isArray(x.reports)) return bad("plan.reports", "expected an array");
  const rules = obj(x.validationRules, "plan.validationRules");
  const parts: Obj = {
    label,
    authoredBy,
    stages: derived ? [] : x.stages,
    reports: x.reports,
    validationRules: { typeGate: rules.typeGate, routingGate: rules.routingGate },
    ...(x.profile !== undefined ? { profile: x.profile } : {}),
    ...(x.views !== undefined ? { views: x.views } : {}),
    ...(x.scenarioBalancePlans !== undefined ? { scenarioBalancePlans: x.scenarioBalancePlans } : {}),
  };
  try {
    const parsed = standIn(parts, []);
    out.stages = derived ? "derived-default" : parsed.stages;
    out.reports = parsed.reports;
    out.validationRules = parsed.validationRules;
    if (parsed.profile !== undefined) out.profile = parsed.profile;
    if (parsed.views !== undefined) out.views = parsed.views;
    if (parsed.scenarioBalancePlans !== undefined) out.scenarioBalancePlans = parsed.scenarioBalancePlans;
  } catch (err) {
    if (err instanceof PlanShapeError) return shapeRefusal(err, "scenarios.items");
    throw err;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Measures
// ---------------------------------------------------------------------------

function parseNii(v: unknown, gridHorizonMonths: number): NiiSettings {
  const x = obj(v, "nii");
  const enabled = bool(x, "enabled", "nii");
  const horizonMonths = posInt(x.horizonMonths, "nii.horizonMonths");
  if (horizonMonths < 12 || horizonMonths > gridHorizonMonths) {
    return bad("nii.horizonMonths", `expected between 12 and gridHorizonMonths (${gridHorizonMonths}), got ${horizonMonths}`);
  }
  // Slice three (decision 116): non-empty and strictly ascending as well as within the grid, because the engine reads the list.
  if (!Array.isArray(x.reportHorizons) || x.reportHorizons.length === 0) return bad("nii.reportHorizons", "expected a non-empty array of months");
  const reportHorizons = x.reportHorizons.map((n, i) => {
    const m = posInt(n, `nii.reportHorizons[${i}]`);
    if (m > gridHorizonMonths) return bad(`nii.reportHorizons[${i}]`, `expected at most gridHorizonMonths (${gridHorizonMonths}), got ${m}`);
    return m;
  });
  for (let i = 1; i < reportHorizons.length; i++) {
    if (reportHorizons[i]! <= reportHorizons[i - 1]!) {
      return bad(`nii.reportHorizons[${i}]`, `horizons must be strictly ascending, ${reportHorizons[i]} follows ${reportHorizons[i - 1]}`);
    }
  }
  const basis = parseBasis(x.basis, "nii.basis");
  if (x.path !== "single") return bad("nii.path", `expected "single" (stochastic NII is not built yet), got ${JSON.stringify(x.path)}`);
  const out: NiiSettings = { enabled, horizonMonths, reportHorizons, basis, path: "single" };
  if (x.templates !== undefined) out.templates = parseTemplates(x.templates, "nii.templates");
  return out;
}

function parseEve(v: unknown): EveSettings {
  const x = obj(v, "eve");
  const out: EveSettings = {
    enabled: bool(x, "enabled", "eve"),
    discountBasis: oneOf(x, "discountBasis", "eve", ["all-in", "risk-free", "spread-consistent"]),
    durationMode: oneOf(x, "durationMode", "eve", ["base-only", "per-scenario"]),
    valuationDates: oneOf(x, "valuationDates", "eve", ["as-of", "every-nii-date", "every-12-months", "custom"]),
    keyRate: bool(x, "keyRate", "eve"),
    channels: bool(x, "channels", "eve"),
    path: oneOf(x, "path", "eve", ["single", "stochastic"]),
  };
  if (x.customValuationMonths !== undefined) {
    if (!Array.isArray(x.customValuationMonths)) return bad("eve.customValuationMonths", "expected an array of months");
    out.customValuationMonths = x.customValuationMonths.map((n, i) => {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return bad(`eve.customValuationMonths[${i}]`, `expected a month count of 0 or more, got ${JSON.stringify(n)}`);
      return n;
    });
  }
  if (out.valuationDates === "custom" && (out.customValuationMonths === undefined || out.customValuationMonths.length === 0)) {
    return bad("eve.customValuationMonths", `expected at least one month when valuationDates is "custom"`);
  }
  if (x.stochastic !== undefined) {
    const s = obj(x.stochastic, "eve.stochastic");
    const stochastic: NonNullable<EveSettings["stochastic"]> = { nPaths: posInt(s.nPaths, "eve.stochastic.nPaths") };
    if (s.seed !== undefined) stochastic.seed = str(s, "seed", "eve.stochastic");
    if (s.model !== undefined) {
      if (s.model !== "hull-white-1f" && s.model !== "bgm-lmm-2f") {
        return bad("eve.stochastic.model", `expected "hull-white-1f" or "bgm-lmm-2f", got ${JSON.stringify(s.model)}`);
      }
      stochastic.model = s.model;
    }
    if (s.modelParams !== undefined) {
      const p = obj(s.modelParams, "eve.stochastic.modelParams");
      for (const key of ["a", "sigma"] as const) {
        if (typeof p[key] !== "number" || !Number.isFinite(p[key] as number)) {
          return bad(`eve.stochastic.modelParams.${key}`, "expected a finite number");
        }
      }
      stochastic.modelParams = { a: p.a as number, sigma: p.sigma as number, reason: str(p, "reason", "eve.stochastic.modelParams") };
    }
    // A saved calibration by id, copied only when present, never beside explicit parameters.
    if (s.calibrationId !== undefined) {
      if (typeof s.calibrationId !== "string" || !/^cal-[0-9a-f]{16}$/.test(s.calibrationId)) return bad("eve.stochastic.calibrationId", "expected the id of a saved calibration (cal- and 16 hex digits)");
      if (stochastic.modelParams !== undefined) return bad("eve.stochastic.calibrationId", "a stochastic choice uses a saved calibration or explicit parameters, not both");
      stochastic.calibrationId = s.calibrationId;
    }
    out.stochastic = stochastic;
  }
  // Going-concern EVE beside run-off EVE, copied only when present so an earlier setup keeps its bytes.
  if (x.goingConcern !== undefined) out.goingConcern = bool(x, "goingConcern", "eve");
  // The months going-concern EVE counts, copied only when present; held to the earnings horizon in parseRunSetup.
  if (x.goingConcernSpan !== undefined) out.goingConcernSpan = posInt(x.goingConcernSpan, "eve.goingConcernSpan");
  return out;
}

function parseGap(v: unknown, gridHorizonMonths: number): GapSettings {
  const x = obj(v, "gap");
  const rb = obj(x.repricingBuckets, "gap.repricingBuckets");
  const rbKind = oneOf(rb, "kind", "gap.repricingBuckets", ["monthly", "standard", "custom"]);
  const repricingBuckets: GapSettings["repricingBuckets"] =
    rbKind === "custom" ? { kind: "custom", edgesMonths: edges(rb.edgesMonths, "gap.repricingBuckets.edgesMonths", gridHorizonMonths) } : { kind: rbKind };
  const l = obj(x.liquidity, "gap.liquidity");
  const iv = obj(l.interval, "gap.liquidity.interval");
  const ivKind = oneOf(iv, "kind", "gap.liquidity.interval", ["standard", "monthly", "custom-months", "daily"]);
  const interval: GapSettings["liquidity"]["interval"] =
    ivKind === "custom-months"
      ? { kind: "custom-months", edgesMonths: edges(iv.edgesMonths, "gap.liquidity.interval.edgesMonths", gridHorizonMonths) }
      : { kind: ivKind };
  return {
    enabled: bool(x, "enabled", "gap"),
    repricingBuckets,
    fixedRateLadder: bool(x, "fixedRateLadder", "gap"),
    liquidity: {
      enabled: bool(l, "enabled", "gap.liquidity"),
      flows: oneOf(l, "flows", "gap.liquidity", ["principal", "principal-plus-interest"]),
      interval,
    },
    // Copied only when present, so a setup written before the field keeps its bytes and its id.
    ...(x.nextReset !== undefined ? { nextReset: bool(x, "nextReset", "gap") } : {}),
    // The forecast gap arm, copied only when present.
    ...(x.forecast !== undefined ? { forecast: bool(x, "forecast", "gap") } : {}),
  };
}

// ---------------------------------------------------------------------------
// The schema 1.9.0 fields
// ---------------------------------------------------------------------------

/**
 * `modelConvention`, `nmdConvention`, `nmdWarmup`, `seg` and `liquidityStress`, each copied only when present, so a setup written before
 * them parses to its old bytes. The liquidity stress block is checked by the engine's own gate,
 * the one the run route runs on `engineOptions.liquidityStress`, and copied with its known keys only.
 */
function parseConventionFields(o: Obj): Pick<RunSetup, "nmdConvention" | "nmdWarmup" | "modelConvention" | "seg" | "liquidityStress"> {
  const out: Pick<RunSetup, "nmdConvention" | "nmdWarmup" | "modelConvention" | "seg" | "liquidityStress"> = {};
  // Checked by the engine's own gate; absent stays absent (the original convention).
  // Written first of these fields, right after instrumentResults, where a new setup's body carries it.
  if (o.modelConvention !== undefined) {
    const problem = modelConventionConfigError(o.modelConvention, "modelConvention");
    if (problem !== undefined) throw unprocessable(problem, { field: "modelConvention" });
    out.modelConvention = o.modelConvention as NonNullable<RunSetup["modelConvention"]>;
  }
  if (o.nmdConvention !== undefined) {
    if (o.nmdConvention !== "behavioral" && o.nmdConvention !== "regulatory" && o.nmdConvention !== "shocked-level") {
      return bad("nmdConvention", `expected one of "behavioral", "regulatory", "shocked-level", got ${JSON.stringify(o.nmdConvention)}`);
    }
    out.nmdConvention = o.nmdConvention;
  }
  // Checked by the engine's own shape gate, the one the run route runs, and copied with its known keys only.
  if (o.nmdWarmup !== undefined) {
    const problem = nmdWarmupConfigError(o.nmdWarmup, "nmdWarmup");
    if (problem !== undefined) throw unprocessable(problem, { field: "nmdWarmup" });
    out.nmdWarmup = nmdWarmupOf(o.nmdWarmup as NonNullable<RunSetup["nmdWarmup"]>);
  }
  if (o.seg !== undefined) {
    const s = obj(o.seg, "seg");
    const enabled = bool(s, "enabled", "seg");
    // The knobs, checked by the engine's own gate and copied with their known keys only.
    const { enabled: _enabled, ...knobs } = s;
    const problem = segSettingsConfigError(knobs, "seg");
    if (problem !== undefined) throw unprocessable(problem, { field: "seg" });
    out.seg = { enabled, ...segSettingsOf(knobs) };
  }
  if (o.liquidityStress !== undefined) {
    const problem = liquidityStressConfigError(o.liquidityStress, "liquidityStress");
    if (problem !== undefined) throw unprocessable(problem, { field: "liquidityStress" });
    // The engine's stored copy: known keys only, fixed order; a 1.9.0 opt-in keeps its bytes.
    out.liquidityStress = liquidityStressOptionsOf(o.liquidityStress);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** `rs-<16 hex>`: a stored setup document's id. */
export const RUN_SETUP_ID_PATTERN = /^rs-[0-9a-f]{16}$/;

/**
 * Parse an untrusted run setup into the document minus its id. A caller-supplied `id` is
 * ignored: the id is the hash of the content, computed by the route.
 */
export function parseRunSetup(x: unknown): Omit<RunSetup, "id"> {
  const o = obj(x, "setup");
  if (o.schemaVersion !== "1.0.0") return bad("setup.schemaVersion", `expected "1.0.0", got ${JSON.stringify(o.schemaVersion)}`);
  const name = str(o, "name", "setup", SETUP_NAME_MAX);
  const gridHorizonMonths = posInt(o.gridHorizonMonths, "gridHorizonMonths");
  if (gridHorizonMonths < 12) return bad("gridHorizonMonths", `expected at least 12, got ${gridHorizonMonths}`);
  const inputs = parseInputs(o.inputs);
  const scenarios = parseScenarios(o.scenarios, "scenarios");
  const plan = parsePlanTemplate(o.plan);
  const nii = parseNii(o.nii, gridHorizonMonths);
  const eve = parseEve(o.eve);
  // Ruling 2026-11-03: going-concern EVE counts new volume up to the earnings horizon, never past it.
  if (eve.goingConcernSpan !== undefined && eve.goingConcernSpan > nii.horizonMonths) {
    return bad("eve.goingConcernSpan", `going-concern value counts new volume made within the earnings horizon: at most ${nii.horizonMonths} months, got ${eve.goingConcernSpan}`);
  }
  const gap = parseGap(o.gap, gridHorizonMonths);
  const ftp = obj(o.ftp, "ftp");
  const ir = obj(o.instrumentResults, "instrumentResults");
  const save = bool(ir, "save", "instrumentResults");
  // Absent means every position; a list given with save on must name a node.
  const coaNodeIds = ir.coaNodeIds === undefined ? undefined : strList(ir.coaNodeIds, "instrumentResults.coaNodeIds");
  if (save && coaNodeIds !== undefined && coaNodeIds.length === 0) {
    return bad("instrumentResults.coaNodeIds", "expected at least one chart of account node when save is true");
  }
  const extras = parseConventionFields(o);
  if (!Array.isArray(o.batch)) return bad("batch", "expected an array");
  const seen = new Set<string>();
  const batch = o.batch.map((row, i): RunSetup["batch"][number] => {
    const at = `batch[${i}]`;
    const r = obj(row, at);
    const label = str(r, "label", at, BATCH_LABEL_MAX);
    if (seen.has(label)) return bad(`${at}.label`, `batch label "${label}" is used twice; each row needs its own`);
    seen.add(label);
    return {
      label,
      scenarios: parseScenarios(r.scenarios, `${at}.scenarios`),
      assumptionSetIds: assumptionSetIds(r.assumptionSetIds, `${at}.assumptionSetIds`),
      basis: parseBasis(r.basis, `${at}.basis`),
    };
  });
  let importedFrom: string | null = null;
  if (o.importedFrom !== null && o.importedFrom !== undefined) importedFrom = str(o, "importedFrom", "setup");
  let supersedes: string | null = null;
  if (o.supersedes !== null && o.supersedes !== undefined) {
    supersedes = str(o, "supersedes", "setup");
    if (!RUN_SETUP_ID_PATTERN.test(supersedes)) return bad("supersedes", `expected a run setup id (rs-<16 hex>), got ${JSON.stringify(supersedes)}`);
  }
  const note = o.note === undefined ? "" : o.note;
  if (typeof note !== "string" || note.length > NOTE_MAX) return bad("note", `expected a string of at most ${NOTE_MAX} characters`);

  return {
    schemaVersion: "1.0.0",
    name,
    gridHorizonMonths,
    inputs,
    scenarios,
    plan,
    nii,
    eve,
    gap,
    ftp: { enabled: bool(ftp, "enabled", "ftp") },
    instrumentResults: { save, ...(coaNodeIds !== undefined ? { coaNodeIds } : {}) },
    ...extras,
    batch,
    importedFrom,
    supersedes,
    note,
  };
}
