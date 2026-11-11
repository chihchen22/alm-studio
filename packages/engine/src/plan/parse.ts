/**
 * Shape gates for untrusted plan and policy JSON. Value-level rules live in the
 * gates; this file only guarantees the object has the declared shape so no raw
 * TypeError escapes a route. Every refusal names the field path.
 */
import type { JsonValue, Profile, ProfileRow } from "@alm/harness";
import {
  BEHAVIORAL_CLASS_IDS, CONTRACT_TYPE_NAMES, METRIC_IDS, PLAN_SCHEMA_VERSION, STAGE_KINDS,
  type BalanceBasisFlat, type BehavioralClassId, type NewVolumeTemplateSpec, type ContractTypeName, type MetricId, type PlanStage, type RoutingPolicy, type RunPlan,
} from "../contracts/plan";
import type { NewBusinessRule, NewBusinessTemplate, ScenarioDefinition } from "../contracts/scenario";
import { DEFAULT_NEW_BUSINESS_TERM_MONTHS, newVolumeTemplateProblem } from "./newVolumeTemplate";
import type { ViewDef } from "../contracts/views";

export class PlanShapeError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`${field}: ${detail}`);
    this.name = "PlanShapeError";
    this.field = field;
  }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function str(o: Record<string, unknown>, key: string, at: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) throw new PlanShapeError(`${at}.${key}`, "expected a non-empty string");
  return v;
}
function optStr(o: Record<string, unknown>, key: string, at: string): string | undefined {
  if (o[key] === undefined) return undefined;
  return str(o, key, at);
}
function arr(o: Record<string, unknown>, key: string, at: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new PlanShapeError(`${at}.${key}`, `expected an array, got ${typeof v}`);
  return v;
}
function optArr(o: Record<string, unknown>, key: string, at: string): unknown[] | undefined {
  if (o[key] === undefined) return undefined;
  return arr(o, key, at);
}
function strList(v: unknown[], at: string): string[] {
  return v.map((x, i) => {
    if (typeof x !== "string") throw new PlanShapeError(`${at}[${i}]`, "expected a string");
    return x;
  });
}
function typeNames(v: unknown[], at: string): ContractTypeName[] {
  return strList(v, at).map((t, i) => {
    if (!(CONTRACT_TYPE_NAMES as readonly string[]).includes(t)) {
      throw new PlanShapeError(`${at}[${i}]`, `unknown contract type "${t}"`);
    }
    return t as ContractTypeName;
  });
}
function metricIds(v: unknown[], at: string): MetricId[] {
  return strList(v, at).map((m, i) => {
    if (!(METRIC_IDS as readonly string[]).includes(m)) throw new PlanShapeError(`${at}[${i}]`, `unknown metric "${m}"`);
    return m as MetricId;
  });
}

function parseStage(x: unknown, at: string): PlanStage {
  if (!isObj(x)) throw new PlanShapeError(at, "expected a stage object");
  const kind = str(x, "kind", at);
  if (!(STAGE_KINDS as readonly string[]).includes(kind)) throw new PlanShapeError(`${at}.kind`, `unknown stage kind "${kind}"`);
  const stage: PlanStage = {
    id: str(x, "id", at),
    component: str(x, "component", at),
    kind: kind as PlanStage["kind"],
    consumes: typeNames(arr(x, "consumes", at), `${at}.consumes`),
    produces: typeNames(arr(x, "produces", at), `${at}.produces`),
  };
  const dependsOn = optArr(x, "dependsOn", at);
  if (dependsOn) stage.dependsOn = strList(dependsOn, `${at}.dependsOn`);
  if (x.selector !== undefined) {
    if (!isObj(x.selector)) throw new PlanShapeError(`${at}.selector`, "expected an object");
    const s = x.selector;
    const sel: NonNullable<PlanStage["selector"]> = {};
    if (s.productFamily !== undefined) {
      sel.productFamily = Array.isArray(s.productFamily) ? strList(s.productFamily, `${at}.selector.productFamily`) : str(s, "productFamily", `${at}.selector`);
    }
    if (s.side !== undefined) sel.side = str(s, "side", `${at}.selector`);
    if (s.behavioralClasses !== undefined) {
      const list = Array.isArray(s.behavioralClasses) ? strList(s.behavioralClasses, `${at}.selector.behavioralClasses`) : [str(s, "behavioralClasses", `${at}.selector`)];
      for (const c of list) {
        if (!(BEHAVIORAL_CLASS_IDS as readonly string[]).includes(c)) throw new PlanShapeError(`${at}.selector.behavioralClasses`, `unknown behavioral class "${c}"`);
      }
      sel.behavioralClasses = (Array.isArray(s.behavioralClasses) ? list : list[0]) as BehavioralClassId | BehavioralClassId[];
    }
    if (s.dimensions !== undefined) {
      if (!isObj(s.dimensions)) throw new PlanShapeError(`${at}.selector.dimensions`, "expected an object of tag -> value | value[]");
      const dims: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(s.dimensions)) {
        if (typeof v === "string") {
          if (v.length === 0) throw new PlanShapeError(`${at}.selector.dimensions.${k}`, "expected a non-empty string");
          dims[k] = v;
        } else if (Array.isArray(v)) {
          dims[k] = strList(v, `${at}.selector.dimensions.${k}`);
        } else {
          throw new PlanShapeError(`${at}.selector.dimensions.${k}`, "expected a string or a string list");
        }
      }
      sel.dimensions = dims;
    }
    stage.selector = sel;
  }
  if (x.disposition !== undefined) {
    if (x.disposition !== "M" && x.disposition !== "A") throw new PlanShapeError(`${at}.disposition`, 'expected "M" | "A"');
    stage.disposition = x.disposition;
  }
  if (x.tier !== undefined) {
    if (x.tier !== "Tier 1" && x.tier !== "Tier 2" && x.tier !== "Tier 3") throw new PlanShapeError(`${at}.tier`, 'expected "Tier 1" | "Tier 2" | "Tier 3"');
    stage.tier = x.tier;
  }
  const feeds = optArr(x, "feeds", at);
  if (feeds) stage.feeds = metricIds(feeds, `${at}.feeds`);
  if (x.params !== undefined) {
    if (!isObj(x.params)) throw new PlanShapeError(`${at}.params`, "expected an object");
    for (const [k, v] of Object.entries(x.params)) {
      if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") throw new PlanShapeError(`${at}.params.${k}`, "expected number | string | boolean");
    }
    stage.params = x.params as PlanStage["params"];
  }
  const note = optStr(x, "note", at);
  if (note !== undefined) stage.note = note;
  return stage;
}

function numList(v: unknown[], at: string): number[] {
  return v.map((n, i) => {
    if (typeof n !== "number" || !Number.isFinite(n)) throw new PlanShapeError(`${at}[${i}]`, "expected a finite number");
    return n;
  });
}

const REINVEST_MODES = ["runoff", "flat", "growth"] as const;

/**
 * Shape gate for one new-business rule. Validated field by field rather than
 * cast: this object reaches the projection as executable strategy, so an
 * unknown reinvest mode or a string growth rate must be refused at the door,
 * naming the field (final-review must-fix 4).
 */
function parseNewBusinessRule(x: unknown, at: string): NewBusinessRule {
  if (!isObj(x)) throw new PlanShapeError(at, "expected an object");
  const reinvest = str(x, "reinvest", at);
  if (!(REINVEST_MODES as readonly string[]).includes(reinvest)) {
    throw new PlanShapeError(`${at}.reinvest`, `expected one of [${REINVEST_MODES.join(", ")}], got "${reinvest}"`);
  }
  const rule: NewBusinessRule = {
    familyId: str(x, "familyId", at),
    reinvest: reinvest as NewBusinessRule["reinvest"],
  };
  for (const key of ["monthlyGrowthRate", "spreadOverIndexBp", "termMonths"] as const) {
    const v = x[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new PlanShapeError(`${at}.${key}`, "expected a finite number");
    }
    rule[key] = v;
  }
  if (rule.reinvest === "growth" && rule.monthlyGrowthRate === undefined) {
    throw new PlanShapeError(`${at}.monthlyGrowthRate`, 'required when reinvest is "growth"');
  }
  if (x.template !== undefined) rule.template = parseTemplate(x.template, `${at}.template`, rule.termMonths ?? DEFAULT_NEW_BUSINESS_TERM_MONTHS);
  return rule;
}

/** Shape gate for a new-volume template: the three template fields, checked by the engine's own rule. */
function parseTemplate(x: unknown, at: string, termMonths: number): NewBusinessTemplate {
  if (!isObj(x)) throw new PlanShapeError(at, "expected an object { rateType, amortization, indexTenorMonths }");
  const rateType = str(x, "rateType", at);
  const amortization = str(x, "amortization", at);
  const n = x.indexTenorMonths;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new PlanShapeError(`${at}.indexTenorMonths`, "expected a whole number of months");
  const template = { rateType, amortization, indexTenorMonths: n } as NewBusinessTemplate;
  if (x.fixedIndex !== undefined) template.fixedIndex = x.fixedIndex as NewBusinessTemplate["fixedIndex"];
  // The family's behavior, checked by the same rule.
  if (x.behavior !== undefined) template.behavior = x.behavior as NewBusinessTemplate["behavior"];
  const problem = newVolumeTemplateProblem(template, termMonths);
  if (problem !== null) throw new PlanShapeError(at, problem);
  return template;
}

/** Shape gate for the plan's newVolumeTemplates: one entry per family, each a template with its term and spread. */
function parseNewVolumeTemplates(v: unknown): NewVolumeTemplateSpec[] {
  if (!Array.isArray(v)) throw new PlanShapeError("newVolumeTemplates", "expected an array of { familyId, rateType, amortization, indexTenorMonths, termMonths, spreadOverIndexBp }");
  const seen = new Set<string>();
  return v.map((e, i) => {
    const at = `newVolumeTemplates[${i}]`;
    if (!isObj(e)) throw new PlanShapeError(at, "expected an object");
    const familyId = str(e, "familyId", at);
    if (seen.has(familyId)) throw new PlanShapeError(`${at}.familyId`, `family "${familyId}" has more than one template`);
    seen.add(familyId);
    const termMonths = e.termMonths;
    if (typeof termMonths !== "number" || !Number.isInteger(termMonths)) throw new PlanShapeError(`${at}.termMonths`, "expected a whole number of months");
    const spread = e.spreadOverIndexBp;
    if (typeof spread !== "number" || !Number.isFinite(spread)) throw new PlanShapeError(`${at}.spreadOverIndexBp`, "expected a finite number of basis points");
    const t = parseTemplate(e, at, termMonths);
    const problem = newVolumeTemplateProblem(t, termMonths, spread);
    if (problem !== null) throw new PlanShapeError(at, problem);
    return { familyId, rateType: t.rateType, amortization: t.amortization, indexTenorMonths: t.indexTenorMonths, ...(t.fixedIndex !== undefined ? { fixedIndex: t.fixedIndex } : {}), ...(t.behavior !== undefined ? { behavior: t.behavior } : {}), termMonths, spreadOverIndexBp: spread };
  });
}

/**
 * Shape gate for an inline scenario definition. Value-level rules on the rate
 * spec stay in defineScenario; this only guarantees the declared shape. The
 * rateSpec check runs before the rest so a body with neither reads as a
 * scenario that is missing its rate spec, not as one missing a name. `label` is
 * optional; resolveScenarios defaults it to the id, so nothing downstream sees
 * an absent label.
 */
function parseScenarioDefinition(x: Record<string, unknown>, at: string): ScenarioDefinition {
  const id = str(x, "id", at);
  if (!isObj(x.rateSpec)) throw new PlanShapeError(`${at}.rateSpec`, "expected an object (or a { ref } entry)");
  const def: ScenarioDefinition = { id, rateSpec: x.rateSpec as ScenarioDefinition["rateSpec"] };
  const label = optStr(x, "label", at);
  if (label !== undefined) def.label = label;
  const assumptionSetId = optStr(x, "assumptionSetId", at);
  if (assumptionSetId !== undefined) def.assumptionSetId = assumptionSetId;
  if (x.timing !== undefined) {
    if (!isObj(x.timing)) throw new PlanShapeError(`${at}.timing`, "expected an object");
    const kind = str(x.timing, "kind", `${at}.timing`);
    if (kind !== "immediate" && kind !== "ramp") throw new PlanShapeError(`${at}.timing.kind`, 'expected "immediate" | "ramp"');
    if (kind === "immediate") {
      def.timing = { kind: "immediate" };
    } else {
      const months = x.timing.months;
      if (typeof months !== "number" || !Number.isFinite(months) || months <= 0) {
        throw new PlanShapeError(`${at}.timing.months`, "expected a finite number greater than 0");
      }
      def.timing = { kind: "ramp", months };
    }
  }
  if (x.environment !== undefined) {
    if (!isObj(x.environment)) throw new PlanShapeError(`${at}.environment`, "expected an object");
    const env: ScenarioDefinition["environment"] = {};
    for (const key of ["housePriceIndexPath", "unemploymentPath"] as const) {
      if (x.environment[key] === undefined) continue;
      env[key] = numList(arr(x.environment, key, `${at}.environment`), `${at}.environment.${key}`);
    }
    def.environment = env;
  }
  if (x.newBusiness !== undefined) {
    if (!isObj(x.newBusiness)) throw new PlanShapeError(`${at}.newBusiness`, "expected an object");
    const mode = str(x.newBusiness, "mode", `${at}.newBusiness`);
    if (mode !== "static" && mode !== "dynamic") throw new PlanShapeError(`${at}.newBusiness.mode`, 'expected "static" | "dynamic"');
    def.newBusiness = {
      mode,
      rules: arr(x.newBusiness, "rules", `${at}.newBusiness`).map((r, i) =>
        parseNewBusinessRule(r, `${at}.newBusiness.rules[${i}]`),
      ),
    };
  }
  return def;
}

/** Shape gate for a plan-declared profile. Row semantics are the kernel's; this only fixes the shape. */
function parseProfile(x: unknown, at: string): Profile {
  if (!isObj(x)) throw new PlanShapeError(at, "expected an object");
  const rows = arr(x, "rows", at).map((r, i) => {
    const rowAt = `${at}.rows[${i}]`;
    if (!isObj(r)) throw new PlanShapeError(rowAt, "expected a row object");
    const row: ProfileRow = { id: str(r, "id", rowAt), plugin: str(r, "plugin", rowAt) };
    if (r.config !== undefined) row.config = r.config as JsonValue;
    if (r.disabled !== undefined) {
      if (typeof r.disabled !== "boolean") throw new PlanShapeError(`${rowAt}.disabled`, "expected a boolean");
      row.disabled = r.disabled;
    }
    return row;
  });
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) throw new PlanShapeError(`${at}.rows`, `duplicate row id "${row.id}"`);
    seen.add(row.id);
  }
  return { rows };
}

/** Shape gate for the plan's view list. Semantics (P1 to P3) are the cell plan's job. */
function parseViews(x: unknown, at: string): ViewDef[] {
  if (!Array.isArray(x)) throw new PlanShapeError(at, "expected an array");
  return x.map((raw, i) => {
    const where = `${at}[${i}]`;
    if (!isObj(raw)) throw new PlanShapeError(where, "expected an object");
    const id = str(raw, "id", where);
    const label = str(raw, "label", where);
    if (!Array.isArray(raw.groupBy) || raw.groupBy.length === 0) {
      throw new PlanShapeError(`${where}.groupBy`, "expected a non-empty array of dimension ids");
    }
    const groupBy = raw.groupBy.map((g, j) => {
      if (typeof g !== "string" || g.length === 0) {
        throw new PlanShapeError(`${where}.groupBy[${j}]`, "expected a non-empty string");
      }
      return g;
    });
    return { id, label, groupBy };
  });
}

export function parseRunPlan(x: unknown): RunPlan {
  if (!isObj(x)) throw new PlanShapeError("plan", "expected an object");
  if (x.schemaVersion !== PLAN_SCHEMA_VERSION) throw new PlanShapeError("schemaVersion", `expected "${PLAN_SCHEMA_VERSION}", got ${JSON.stringify(x.schemaVersion)}`);
  const authoredBy = str(x, "authoredBy", "plan");
  if (authoredBy !== "person" && authoredBy !== "orchestrator") throw new PlanShapeError("authoredBy", 'expected "person" | "orchestrator"');
  if (!isObj(x.grid) || typeof x.grid.horizonMonths !== "number") throw new PlanShapeError("grid.horizonMonths", "expected a number");
  if (!isObj(x.inputs)) throw new PlanShapeError("inputs", "expected an object");
  const inputs: RunPlan["inputs"] = {
    marketSnapshot: str(x.inputs, "marketSnapshot", "inputs"),
    positionBook: str(x.inputs, "positionBook", "inputs"),
    routingPolicy: str(x.inputs, "routingPolicy", "inputs"),
  };
  const tax = optStr(x.inputs, "dimensionTaxonomy", "inputs");
  if (tax !== undefined) inputs.dimensionTaxonomy = tax;
  const sets = optArr(x.inputs, "assumptionSets", "inputs");
  if (sets) inputs.assumptionSets = strList(sets, "inputs.assumptionSets");
  const stages = arr(x, "stages", "plan").map((s, i) => parseStage(s, `stages[${i}]`));
  const scenarios = arr(x, "scenarios", "plan").map((s, i) => {
    if (!isObj(s)) throw new PlanShapeError(`scenarios[${i}]`, "expected an object");
    if (typeof s.ref === "string") return { ref: s.ref };
    return parseScenarioDefinition(s, `scenarios[${i}]`);
  });
  const reports = arr(x, "reports", "plan").map((r, i) => {
    if (!isObj(r)) throw new PlanShapeError(`reports[${i}]`, "expected an object");
    const rep: RunPlan["reports"][number] = { id: str(r, "id", `reports[${i}]`), view: str(r, "view", `reports[${i}]`), metrics: metricIds(arr(r, "metrics", `reports[${i}]`), `reports[${i}].metrics`) };
    const note = optStr(r, "note", `reports[${i}]`);
    if (note !== undefined) rep.note = note;
    return rep;
  });
  if (!isObj(x.validationRules)) throw new PlanShapeError("validationRules", "expected an object");
  const plan: RunPlan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: str(x, "planId", "plan"),
    label: str(x, "label", "plan"),
    authoredBy,
    asOf: str(x, "asOf", "plan"),
    grid: { horizonMonths: x.grid.horizonMonths },
    inputs,
    stages,
    scenarios,
    reports,
    validationRules: {
      typeGate: strList(arr(x.validationRules, "typeGate", "validationRules"), "validationRules.typeGate"),
      routingGate: strList(arr(x.validationRules, "routingGate", "validationRules"), "validationRules.routingGate"),
    },
  };
  const note = optStr(x, "note", "plan");
  if (note !== undefined) plan.note = note;
  const bp = optStr(x, "balancePlan", "plan");
  if (bp !== undefined) plan.balancePlan = bp;
  if (x.balanceBasis !== undefined) {
    const b = x.balanceBasis;
    if (!isObj(b) || b.kind !== "flat") throw new PlanShapeError("balanceBasis.kind", 'expected "flat"');
    const out: BalanceBasisFlat = { kind: "flat" };
    if (b.termMonths !== undefined) {
      if (typeof b.termMonths !== "number" || !Number.isInteger(b.termMonths) || b.termMonths < 1) throw new PlanShapeError("balanceBasis.termMonths", "expected a positive integer");
      out.termMonths = b.termMonths;
    }
    if (b.spreadOverIndexBp !== undefined) {
      if (typeof b.spreadOverIndexBp !== "number" || !Number.isFinite(b.spreadOverIndexBp)) throw new PlanShapeError("balanceBasis.spreadOverIndexBp", "expected a finite number");
      out.spreadOverIndexBp = b.spreadOverIndexBp;
    }
    plan.balanceBasis = out;
  }
  if (x.scenarioBalancePlans !== undefined) {
    const m = x.scenarioBalancePlans;
    if (!isObj(m)) throw new PlanShapeError("scenarioBalancePlans", "expected an object mapping scenario id to balance plan id");
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) {
      if (typeof v !== "string" || v.length === 0) throw new PlanShapeError(`scenarioBalancePlans.${k}`, `expected a non-empty balance plan id, got ${JSON.stringify(v)}`);
      out[k] = v;
    }
    plan.scenarioBalancePlans = out;
  }
  if (x.newVolumeTemplates !== undefined) plan.newVolumeTemplates = parseNewVolumeTemplates(x.newVolumeTemplates);
  if (x.profile !== undefined) plan.profile = parseProfile(x.profile, "profile");
  if (x.views !== undefined) plan.views = parseViews(x.views, "views");
  return plan;
}

export function parseRoutingPolicy(x: unknown): RoutingPolicy {
  if (!isObj(x)) throw new PlanShapeError("policy", "expected an object");
  const metrics = arr(x, "metrics", "policy").map((m, i) => {
    if (!isObj(m)) throw new PlanShapeError(`metrics[${i}]`, "expected an object");
    return { id: metricIds([str(m, "id", `metrics[${i}]`)], `metrics[${i}].id`)[0], label: str(m, "label", `metrics[${i}]`), basis: str(m, "basis", `metrics[${i}]`) };
  });
  const classes = arr(x, "classes", "policy").map((c, i) => {
    const at = `classes[${i}]`;
    if (!isObj(c)) throw new PlanShapeError(at, "expected an object");
    const id = str(c, "id", at);
    if (!(BEHAVIORAL_CLASS_IDS as readonly string[]).includes(id)) throw new PlanShapeError(`${at}.id`, `unknown behavioral class "${id}"`);
    if (!isObj(c.routing)) throw new PlanShapeError(`${at}.routing`, "expected an object");
    const routing = {} as RoutingPolicy["classes"][number]["routing"];
    for (const m of METRIC_IDS) {
      const v = c.routing[m];
      if (v !== "M" && v !== "A" && v !== "none") throw new PlanShapeError(`${at}.routing.${m}`, `expected "M" | "A" | "none", got ${JSON.stringify(v)}`);
      routing[m] = v;
    }
    const cls: RoutingPolicy["classes"][number] = { id: id as RoutingPolicy["classes"][number]["id"], label: str(c, "label", at), side: str(c, "side", at), routing };
    const chapter = optStr(c, "chapter", at);
    if (chapter !== undefined) cls.chapter = chapter;
    const rationale = optStr(c, "rationale", at);
    if (rationale !== undefined) cls.rationale = rationale;
    return cls;
  });
  return { schemaVersion: str(x, "schemaVersion", "policy"), id: str(x, "id", "policy"), label: str(x, "label", "policy"), metrics, classes };
}
