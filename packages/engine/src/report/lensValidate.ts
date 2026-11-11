/**
 * Lens validation (rules V1 to V5). The ONLY validator: the
 * seed runs it before a write, and both read routes run it again on the stored
 * document, so a hand-edited store file cannot produce a reading.
 *
 * It never throws. What it is handed on the route is parsed JSON cast to
 * LensDefinition, so every field is checked for TYPE before it is checked for
 * value; a validator that trusted the cast would throw where it should report.
 */
import { GAP_BAND_LABELS } from "../gap/bands";
import { CUSTOM_METRIC_ID_PATTERN } from "../contracts/customMetric";
import {
  LENS_ID_PATTERN,
  LENS_READER_IDS,
  type LensDefinition,
  type LensReaderId,
} from "../contracts/lens";

export interface LensProblem {
  rule: "V1" | "V2" | "V3" | "V4" | "V5";
  /** The constraint the problem names; absent for a lens-level problem. */
  constraintId?: string;
  /** The field or parameter key the problem names. */
  field: string;
  message: string;
}

const OBJECTIVES: ReadonlySet<string> = new Set(["liquidity", "rate", "capital", "strategy"]);
const OPS: ReadonlySet<string> = new Set(["atMost", "atLeast"]);

/**
 * One check per parameter: it returns a message TAIL when the value is wrong
 * and undefined when it is fine, and the caller prefixes the constraint and the
 * key. Piece 3b turned the plain key list into this table so a new reader
 * declares its own domain in one line instead of adding a branch to an
 * if-chain; every existing message is unchanged, character for character.
 */
type ParamCheck = (value: unknown) => string | undefined;

const positiveInteger: ParamCheck = (value) =>
  typeof value !== "number" || !Number.isInteger(value) || value <= 0
    ? `${JSON.stringify(value)} must be a positive integer`
    : undefined;

const oneOf =
  (allowed: readonly string[]): ParamCheck =>
  (value) =>
    typeof value !== "string" || !allowed.includes(value)
      ? `${JSON.stringify(value)} must be one of ${allowed.join(", ")}`
      : undefined;

const matching =
  (pattern: RegExp): ParamCheck =>
  (value) =>
    typeof value !== "string" || !pattern.test(value)
      ? `${JSON.stringify(value)} must match ${String(pattern)}`
      : undefined;

/** The parameter each reader takes, and the domain of each. A reader taking none declares {}. */
const READER_PARAMS: Readonly<Record<LensReaderId, Readonly<Record<string, ParamCheck>>>> = {
  deltaEvePct: {},
  deltaNiiPct: { horizonMonths: positiveInteger },
  cumulativeLiquidityGap: { band: oneOf(GAP_BAND_LABELS) },
  shortfallCount: {},
  capitalRatio: {},
  customValue: {
    metricId: matching(CUSTOM_METRIC_ID_PATTERN),
    key: matching(CUSTOM_METRIC_ID_PATTERN),
  },
};

export function validateLens(def: LensDefinition): LensProblem[] {
  // The document itself is parsed JSON, so it may not be an object at all. Every
  // field check below is a property access, which would throw on null.
  if (typeof def !== "object" || def === null || Array.isArray(def)) {
    return [{ rule: "V1", field: "", message: "a lens document must be a JSON object" }];
  }
  const out: LensProblem[] = [];
  const d = def as unknown as Record<string, unknown>;

  if (typeof d.id !== "string" || !LENS_ID_PATTERN.test(d.id)) {
    out.push({
      rule: "V1",
      field: "id",
      message: `lens id ${JSON.stringify(d.id)} must match ${String(LENS_ID_PATTERN)}`,
    });
  }
  if (typeof d.label !== "string" || d.label.length === 0) {
    out.push({ rule: "V1", field: "label", message: "lens label must be a non-empty string" });
  }
  if (typeof d.objective !== "string" || !OBJECTIVES.has(d.objective)) {
    out.push({
      rule: "V1",
      field: "objective",
      message:
        `lens objective ${JSON.stringify(d.objective)} must be one of ` +
        `liquidity, rate, capital, strategy`,
    });
  }

  if (!Array.isArray(d.constraints) || d.constraints.length === 0) {
    out.push({
      rule: "V2",
      field: "constraints",
      message: "a lens states at least one constraint",
    });
    return out;
  }

  const seen = new Set<string>();
  for (const entry of d.constraints as unknown[]) {
    const c = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const cid = typeof c.id === "string" ? c.id : "";
    if (typeof c.id !== "string" || !LENS_ID_PATTERN.test(c.id)) {
      out.push({
        rule: "V2",
        field: "id",
        message: `constraint id ${JSON.stringify(c.id)} must match ${String(LENS_ID_PATTERN)}`,
      });
    } else if (seen.has(cid)) {
      out.push({
        rule: "V2",
        constraintId: cid,
        field: "id",
        message: `constraint id "${cid}" is declared twice in this lens`,
      });
    }
    seen.add(cid);

    if (typeof c.reader !== "string" || !(LENS_READER_IDS as readonly string[]).includes(c.reader)) {
      out.push({
        rule: "V3",
        constraintId: cid,
        field: "reader",
        message:
          `constraint "${cid}" names reader ${JSON.stringify(c.reader)}, which is not one of ` +
          `${LENS_READER_IDS.join(", ")}`,
      });
    } else {
      out.push(...validateParams(cid, c.reader as LensReaderId, c.params));
    }

    if (typeof c.limit !== "number" || !Number.isFinite(c.limit)) {
      out.push({
        rule: "V5",
        constraintId: cid,
        field: "limit",
        message: `constraint "${cid}" limit ${JSON.stringify(c.limit)} must be a finite number`,
      });
    }
    if (typeof c.op !== "string" || !OPS.has(c.op)) {
      out.push({
        rule: "V5",
        constraintId: cid,
        field: "op",
        message: `constraint "${cid}" op ${JSON.stringify(c.op)} must be "atMost" or "atLeast"`,
      });
    }
  }
  return out;
}

/**
 * Rule V4: the parameter bag matches the reader's shape EXACTLY. A required key
 * missing, an unknown key present, or a value of the wrong type or outside the
 * reader's domain is one problem naming the constraint and the key.
 *
 * horizonMonths is checked as a positive integer and no further: the run's
 * actual horizon list is known only at read time, so a horizon the run did not
 * compute is an unobservable reason, not a validation problem.
 */
function validateParams(
  constraintId: string,
  reader: LensReaderId,
  params: unknown,
): LensProblem[] {
  const out: LensProblem[] = [];
  const checks = READER_PARAMS[reader];
  const required = Object.keys(checks);
  if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
    out.push({
      rule: "V4",
      constraintId,
      field: "params",
      message: `constraint "${constraintId}" params must be an object when present`,
    });
    return out;
  }
  const bag = (params ?? {}) as Record<string, unknown>;

  for (const key of Object.keys(bag)) {
    if (required.includes(key)) continue;
    out.push({
      rule: "V4",
      constraintId,
      field: `params.${key}`,
      message:
        `constraint "${constraintId}" reader "${reader}" ` +
        `${required.length === 0 ? "takes no parameter" : `takes only ${required.join(", ")}`}; ` +
        `"${key}" is unknown`,
    });
  }

  for (const key of required) {
    if (!(key in bag)) {
      out.push({
        rule: "V4",
        constraintId,
        field: `params.${key}`,
        message: `constraint "${constraintId}" reader "${reader}" requires parameter "${key}"`,
      });
      continue;
    }
    const message = checks[key]!(bag[key]);
    if (message !== undefined) {
      out.push({
        rule: "V4",
        constraintId,
        field: `params.${key}`,
        message: `constraint "${constraintId}" ${key} ${message}`,
      });
    }
  }
  return out;
}
