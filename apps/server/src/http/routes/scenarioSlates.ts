/**
 * Scenario-slate routes.
 *
 *   GET  /api/scenario-slates     listing
 *   POST /api/scenario-slates     { id, label, scenarios } -> 201 | 422
 *
 * Each scenario is validated through the engine's defineScenario (structural
 * gate, refusals verbatim); slate invariants — exactly one rateSpec of kind
 * "base", unique scenario ids — are enforced here because the engine's run
 * gate would only catch them at minute 40 of a run.
 */
import type { Scenario } from "@alm/engine";
import { defineScenario } from "@alm/engine/src/scenario";
import type { PlatformContext } from "../../context";
import { badRequest, unprocessable } from "../errors";
import { mirrorBestEffort, validated, type Router } from "../router";

export interface ScenarioSlate {
  id: string;
  label: string;
  scenarios: Scenario[];
}

/** How a wrong value is named in a refusal message. */
function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "string") return `the string ${JSON.stringify(v)}`;
  return typeof v;
}

/**
 * Structural pre-gate on one scenario payload. defineScenario
 * validates ids and the rateSpec deeply and refuses typed, but it ASSUMES the
 * spec's shape (an object carrying rateSpec and newBusiness.rules); a
 * hand-authored payload missing one of those fields used to surface a raw
 * JavaScript TypeError ("Cannot read properties of undefined") as the 422
 * message. This gate refuses first, naming the offending field, what was
 * found, and what was expected. It checks SHAPE only: value-level rules (knot
 * ordering, finite shocks, non-empty ids, twist pivots) stay in the engine
 * gate so no rule is duplicated. The one value it does pin is
 * newBusiness.mode, because a misspelled mode would otherwise run silently as
 * static — a wrong number, not an error.
 */
function requireScenarioShape(s: unknown, i: number): void {
  const at = `scenarios[${i}]`;
  if (typeof s !== "object" || s === null || Array.isArray(s)) {
    throw unprocessable(
      `${at}: expected a scenario object { id, label, rateSpec, assumptionSetId, newBusiness }, got ${describeValue(s)}`,
    );
  }
  const sc = s as Record<string, unknown>;
  if (typeof sc.label !== "string") {
    throw unprocessable(`${at}.label: expected a string, got ${describeValue(sc.label)}`);
  }
  if (typeof sc.rateSpec !== "object" || sc.rateSpec === null || Array.isArray(sc.rateSpec)) {
    throw unprocessable(
      `${at}.rateSpec: expected an object { kind: "base" | "parallel" | "twist" | "custom", ... }, got ${describeValue(sc.rateSpec)}`,
    );
  }
  const nb = sc.newBusiness;
  if (typeof nb !== "object" || nb === null || Array.isArray(nb)) {
    throw unprocessable(
      `${at}.newBusiness: expected an object { mode: "static" | "dynamic", rules: [...] }, got ${describeValue(nb)}`,
    );
  }
  const { mode, rules } = nb as { mode?: unknown; rules?: unknown };
  if (mode !== "static" && mode !== "dynamic") {
    throw unprocessable(
      `${at}.newBusiness.mode: expected "static" | "dynamic", got ${describeValue(mode)}`,
    );
  }
  if (!Array.isArray(rules)) {
    throw unprocessable(
      `${at}.newBusiness.rules: expected an array of new-business rules ([] for static runoff), got ${describeValue(rules)}`,
    );
  }
  for (let j = 0; j < rules.length; j++) {
    if (typeof rules[j] !== "object" || rules[j] === null || Array.isArray(rules[j])) {
      throw unprocessable(
        `${at}.newBusiness.rules[${j}]: expected an object { familyId, reinvest, ... }, got ${describeValue(rules[j])}`,
      );
    }
  }
}

export function registerScenarioSlateRoutes(router: Router, ctx: PlatformContext): void {
  router.add("GET", "/api/scenario-slates", () => ({
    kind: "json",
    // Frozen client interface: the listing returns FULL slate objects
    // { id, label, scenarios } — no detail endpoint exists in the frozen
    // table and slates are small.
    value: ctx.store
      .listMeta("scenario-slates")
      .map((meta) => ctx.store.getDocument<ScenarioSlate>("scenario-slates", meta.id).doc),
  }));

  router.add("GET", "/api/scenario-slates/:id", (req) => ({
    kind: "json",
    value: ctx.store.getDocument<ScenarioSlate>("scenario-slates", req.params.id).doc,
  }));

  router.add("POST", "/api/scenario-slates", (req) => {
    const body = req.json<Partial<ScenarioSlate>>();
    if (typeof body.id !== "string") throw badRequest("slate requires a string id");
    if (typeof body.label !== "string") throw badRequest("slate requires a string label");
    if (!Array.isArray(body.scenarios) || body.scenarios.length === 0) {
      throw badRequest("slate requires a non-empty scenarios array");
    }

    const scenarios: Scenario[] = body.scenarios.map((s, i) => {
      requireScenarioShape(s, i);
      return validated(() => defineScenario(s));
    });

    const ids = new Set<string>();
    for (const s of scenarios) {
      if (ids.has(s.id)) {
        throw unprocessable(`slate "${body.id}": duplicate scenario id "${s.id}"; ids must be unique`);
      }
      ids.add(s.id);
    }
    const baseCount = scenarios.filter((s) => s.rateSpec.kind === "base").length;
    if (baseCount !== 1) {
      throw unprocessable(
        `slate "${body.id}": exactly one scenario with rateSpec.kind "base" is required, found ${baseCount}`,
      );
    }

    const slate: ScenarioSlate = { id: body.id, label: body.label, scenarios };
    ctx.store.putDocument("scenario-slates", slate.id, slate, {
      label: slate.label,
      scenarioCount: scenarios.length,
      scenarioIds: scenarios.map((s) => s.id),
    });
    // After the store write: the catalog and lineage reads answer for this document at once (best effort).
    mirrorBestEffort(ctx, "scenario-slates", slate.id);
    return { kind: "json", status: 201, value: slate };
  });
}
