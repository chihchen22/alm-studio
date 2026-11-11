/**
 * The custom metric contract (harness Plane 5).
 *
 * The fifth metric slot is a FIXED SCALAR TABLE, not an open payload:
 * per scenario, a map of named numbers, with optional per-family
 * rows. Every custom metric has the same shape, which is what lets a lens, and
 * later the pivot and the viewer, read one without knowing what it computes.
 *
 * ABSENCE IS THE HONESTY RULE. A value the metric cannot observe is LEFT OUT of
 * its row: never 0, never NaN, never null. A reader turns absence into
 * "unobservable" with a reason; a zero would read as a measured number.
 */

/**
 * The id a custom metric registers under, and the id of each of its keys.
 * Lower-case, hyphenated, at most 64 characters, and never one of the four
 * built-in EngineMetricIds; the registry refuses a collision at register time.
 */
export const CUSTOM_METRIC_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** The unit of one key, carried on the envelope so a reader can label the value. */
export type CustomMetricUnit = "currency" | "fraction" | "months" | "count" | "bp";

export interface CustomMetricKey {
  /** Unique within the metric. Matches CUSTOM_METRIC_ID_PATTERN. */
  id: string;
  label: string;
  unit: CustomMetricUnit;
}

export interface CustomMetricFamilyRow {
  familyId: string;
  /** Key id to finite number. A key ABSENT here is unobservable for this family. */
  values: Record<string, number>;
}

export interface CustomMetricScenarioRow {
  scenarioId: string;
  /** Key id to finite number. A key ABSENT here is unobservable for this scenario. */
  values: Record<string, number>;
  /** Optional, in the envelope's family order. Absent when the metric reports no family grain. */
  byFamily?: CustomMetricFamilyRow[];
}

export interface CustomMetricResult {
  metricId: string;
  label: string;
  /** Declared once, in author order. Every key any row carries is declared here. */
  keys: CustomMetricKey[];
  /** One row per scenario of the run, in request scenario order. */
  byScenario: CustomMetricScenarioRow[];
}

/** One broken rule. The walker fails the run on the first of these. */
export interface CustomMetricProblem {
  rule: "C1" | "C2" | "C3" | "C4" | "C5";
  /** The field path the problem names, so the message points at the row. */
  field: string;
  message: string;
}

const UNITS: readonly string[] = ["currency", "fraction", "months", "count", "bp"];

/**
 * Check a returned result against the registered id and the run's scenarios.
 *
 * NEVER THROWS. What it is handed came from third-party code through a typed
 * seam, so every field is checked for TYPE before it is checked for value; a
 * validator that trusted the type would throw where it should report.
 */
export function validateCustomMetricResult(
  result: CustomMetricResult,
  expected: { metricId: string; scenarioIds: string[] },
): CustomMetricProblem[] {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return [{ rule: "C1", field: "", message: "a custom metric result must be an object" }];
  }
  const out: CustomMetricProblem[] = [];
  const r = result as unknown as Record<string, unknown>;

  // C1: identity.
  if (r.metricId !== expected.metricId) {
    out.push({
      rule: "C1",
      field: "metricId",
      message:
        `metricId ${JSON.stringify(r.metricId)} is not the registered id ` +
        `"${expected.metricId}"`,
    });
  }
  if (typeof r.label !== "string" || r.label.length === 0) {
    out.push({ rule: "C1", field: "label", message: "label must be a non-empty string" });
  }

  // C2: the declared keys.
  const declared = new Set<string>();
  if (!Array.isArray(r.keys) || r.keys.length === 0) {
    out.push({ rule: "C2", field: "keys", message: "a custom metric declares at least one key" });
  } else {
    for (const [i, entry] of (r.keys as unknown[]).entries()) {
      const k = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
      if (typeof k.id !== "string" || !CUSTOM_METRIC_ID_PATTERN.test(k.id)) {
        out.push({
          rule: "C2",
          field: `keys[${i}].id`,
          message: `key id ${JSON.stringify(k.id)} must match ${String(CUSTOM_METRIC_ID_PATTERN)}`,
        });
      } else if (declared.has(k.id)) {
        out.push({
          rule: "C2",
          field: `keys[${i}].id`,
          message: `key id "${k.id}" is declared twice`,
        });
      } else {
        declared.add(k.id);
      }
      if (typeof k.label !== "string" || k.label.length === 0) {
        out.push({ rule: "C2", field: `keys[${i}].label`, message: "key label must be a non-empty string" });
      }
      if (typeof k.unit !== "string" || !UNITS.includes(k.unit)) {
        out.push({
          rule: "C2",
          field: `keys[${i}].unit`,
          message: `key unit ${JSON.stringify(k.unit)} must be one of ${UNITS.join(", ")}`,
        });
      }
    }
  }

  // An undeclared-key report is only meaningful against a key list that itself
  // validated. When C2 already failed, `declared` is a known-wrong set, and
  // checking rows against it would bury the real defect under one derived C4
  // per value. The finite-number half of C4 still runs in that case; only the
  // membership half is withheld.
  const keysClean = out.every((p) => p.rule !== "C2");

  // C3: exactly the run's scenarios, in request order, each once.
  if (!Array.isArray(r.byScenario)) {
    out.push({ rule: "C3", field: "byScenario", message: "byScenario must be an array" });
    return out;
  }
  const rows = r.byScenario as unknown[];
  const seen = rows.map((entry) =>
    typeof entry === "object" && entry !== null
      ? (entry as Record<string, unknown>).scenarioId
      : undefined,
  );
  const sameOrder =
    seen.length === expected.scenarioIds.length &&
    seen.every((id, i) => id === expected.scenarioIds[i]);
  if (!sameOrder) {
    out.push({
      rule: "C3",
      field: "byScenario",
      message:
        `byScenario carries [${seen.map((id) => JSON.stringify(id)).join(", ")}]; this run's ` +
        `scenarios, in request order, are [${expected.scenarioIds.map((id) => `"${id}"`).join(", ")}]`,
    });
  }

  // C4 and C5: the rows themselves. Checked even when C3 failed, so one pass
  // reports every broken rule rather than only the first family of them.
  for (const [i, entry] of rows.entries()) {
    const row = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    out.push(...checkValues(declared, keysClean, row.values, `byScenario[${i}]`));
    if (row.byFamily === undefined) continue;
    if (!Array.isArray(row.byFamily)) {
      out.push({
        rule: "C5",
        field: `byScenario[${i}].byFamily`,
        message: "byFamily must be an array when present",
      });
      continue;
    }
    const families = new Set<string>();
    for (const [j, famEntry] of (row.byFamily as unknown[]).entries()) {
      const fam = (typeof famEntry === "object" && famEntry !== null ? famEntry : {}) as Record<
        string,
        unknown
      >;
      const familyId = typeof fam.familyId === "string" ? fam.familyId : "";
      if (familyId === "") {
        out.push({
          rule: "C5",
          field: `byScenario[${i}].byFamily[${j}].familyId`,
          message: "familyId must be a non-empty string",
        });
      } else if (families.has(familyId)) {
        out.push({
          rule: "C5",
          field: `byScenario[${i}].byFamily[${j}].familyId`,
          message: `family "${familyId}" carries two rows in one scenario`,
        });
      } else {
        families.add(familyId);
      }
      out.push(...checkValues(declared, keysClean, fam.values, `byScenario[${i}].byFamily[${j}]`));
    }
  }
  return out;
}

/**
 * Rule C4 over one values map: every key present is declared and every value is
 * finite. A key left OUT is the metric's way of saying it cannot observe that
 * number, so nothing here requires a key.
 */
function checkValues(
  declared: ReadonlySet<string>,
  keysClean: boolean,
  values: unknown,
  where: string,
): CustomMetricProblem[] {
  const out: CustomMetricProblem[] = [];
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    out.push({ rule: "C4", field: `${where}.values`, message: "values must be an object" });
    return out;
  }
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (keysClean && !declared.has(key)) {
      out.push({
        rule: "C4",
        field: `${where}.values[${JSON.stringify(key)}]`,
        message: `key "${key}" is not declared in keys`,
      });
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      out.push({
        rule: "C4",
        field: `${where}.values[${JSON.stringify(key)}]`,
        message:
          `key "${key}" carries ${JSON.stringify(value)}; a value must be a finite number, and a ` +
          `value the metric cannot observe is left out of the map rather than written as 0 or NaN`,
      });
    }
  }
  return out;
}
