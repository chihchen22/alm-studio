// packages/reader/src/headlines.ts
/**
 * The headlines Studio shows (S3a Overview), each with the envelope path its
 * value is read from, and the path reader every Studio panel uses. A path the
 * envelope does not answer reads as "not in this run" with the reason; this
 * module never returns a number the envelope does not hold, and computes none.
 */
import type { RunResult } from "@alm/engine";
import { signedMM, usdMM } from "./format";

export const NOT_IN_RUN = "Not in this run";

export type PathRead = { kind: "value"; value: number } | { kind: "not-in-run"; reason: string };
export type SeriesRead = { kind: "series"; values: number[] } | { kind: "not-in-run"; reason: string };

const NAME = /^[A-Za-z0-9_]+/;
const SELECTOR_KEY = /^([A-Za-z0-9_]+)=/;

interface Segment {
  name: string;
  key?: string;
  want?: string;
}

type Parse = { ok: true; segments: Segment[] } | { ok: false; reason: string };

/**
 * Splits a path on "." outside selectors. A selector value runs to a "]" that
 * is followed by "." or the end of the path; each such "]" is tried in order
 * and the first whose remainder parses wins, so a value may hold "." , "]" or
 * "]." (scenario ids such as "Up 0.5", "S[x]" or "a].b").
 */
function parseFrom(path: string, i: number): Segment[] | null {
  const n = NAME.exec(path.slice(i));
  if (n === null) return null;
  const name = n[0];
  const j = i + name.length;
  const rest = (at: number, seg: Segment): Segment[] | null => {
    if (at === path.length) return [seg];
    if (path[at] !== ".") return null;
    const tail = parseFrom(path, at + 1);
    return tail === null ? null : [seg, ...tail];
  };
  if (path[j] !== "[") return rest(j, { name });
  const k = SELECTOR_KEY.exec(path.slice(j + 1));
  if (k === null) return null;
  const start = j + 1 + k[0].length;
  for (let c = start + 1; c < path.length; c++) {
    if (path[c] === "]" && (c + 1 === path.length || path[c + 1] === ".")) {
      const got = rest(c + 1, { name, key: k[1] as string, want: path.slice(start, c) });
      if (got !== null) return got;
    }
  }
  return null;
}

function parsePath(path: string): Parse {
  const segments = parseFrom(path, 0);
  return segments === null ? { ok: false, reason: `path "${path}" is not readable` } : { ok: true, segments };
}

/**
 * The `[scenarioId=<id>]` selector for a path. Throws when the selector does
 * not parse back to the same id: an empty id, or one such as "a].b[k=c" whose
 * tail reads as a further segment. A present value is never reported as absent.
 */
export function scenarioSelector(scenarioId: string): string {
  const sel = `[scenarioId=${scenarioId}]`;
  const back = scenarioId === "" ? null : parseFrom(`x${sel}.y`, 0);
  if (back === null || back[0]?.want !== scenarioId) {
    throw new Error(`scenario id "${scenarioId}" cannot be written as an envelope path`);
  }
  return sel;
}

type Walk = { ok: true; value: unknown } | { ok: false; reason: string };

function walk(root: unknown, path: string): Walk {
  const parsed = parsePath(path);
  if (!parsed.ok) return parsed;
  let cur: unknown = root;
  let at = "";
  for (const { name, key, want } of parsed.segments) {
    const owner = cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>) : null;
    if (owner === null || !Object.prototype.hasOwnProperty.call(owner, name) || owner[name] === undefined) {
      return { ok: false, reason: `${at === "" ? "the envelope" : at} has no ${name}` };
    }
    cur = owner[name];
    at = at === "" ? name : `${at}.${name}`;
    if (key !== undefined) {
      if (!Array.isArray(cur)) return { ok: false, reason: `${at} is not a list` };
      const hit: unknown = cur.find((e: unknown) => e !== null && typeof e === "object" && (e as Record<string, unknown>)[key] === want);
      if (hit === undefined) return { ok: false, reason: `${at} has no entry with ${key}=${want}` };
      cur = hit;
      at = `${at}[${key}=${want}]`;
    }
  }
  return { ok: true, value: cur };
}

/** The finite number at `path`, or why the envelope does not hold one. */
export function readPath(root: unknown, path: string): PathRead {
  const w = walk(root, path);
  if (!w.ok) return { kind: "not-in-run", reason: w.reason };
  if (typeof w.value !== "number" || !Number.isFinite(w.value)) return { kind: "not-in-run", reason: `${path} is not a number in this run` };
  return { kind: "value", value: w.value };
}

/** The stored list of numbers at `path` (the same array, not a copy), or why there is none. */
export function readSeries(root: unknown, path: string): SeriesRead {
  const w = walk(root, path);
  if (!w.ok) return { kind: "not-in-run", reason: w.reason };
  if (!Array.isArray(w.value) || !w.value.every((v) => typeof v === "number")) {
    return { kind: "not-in-run", reason: `${path} is not a list of numbers in this run` };
  }
  return { kind: "series", values: w.value as number[] };
}

export type HeadlineMetric = "eve" | "nii12" | "nii24";
export type HeadlineFormat = "usdMM" | "signedMM";

export interface Headline {
  id: string;
  metric: HeadlineMetric;
  scenarioId: string;
  label: string;
  envelopePath: string;
  format: HeadlineFormat;
}

const SPEC: Record<HeadlineMetric, { label: string; field: string; block: "eve" | "nii"; format: HeadlineFormat }> = {
  eve: { label: "EVE", field: "eve", block: "eve", format: "usdMM" },
  nii12: { label: "NII 12m", field: "totalNet12", block: "nii", format: "signedMM" },
  nii24: { label: "NII 24m", field: "totalNet24", block: "nii", format: "signedMM" },
};

export function headlineFor(metric: HeadlineMetric, scenarioId: string): Headline {
  const s = SPEC[metric];
  return {
    id: `${metric}:${scenarioId}`,
    metric,
    scenarioId,
    label: s.label,
    envelopePath: `${s.block}.byScenario${scenarioSelector(scenarioId)}.${s.field}`,
    format: s.format,
  };
}

/** Every headline the envelope's own scenario lists name: EVE per eve scenario, then NII 12m and 24m per nii scenario. */
export function headlinesFor(result: RunResult): Headline[] {
  const r = result as Partial<RunResult>;
  const out: Headline[] = [];
  for (const s of r.eve?.byScenario ?? []) out.push(headlineFor("eve", s.scenarioId));
  for (const s of r.nii?.byScenario ?? []) {
    out.push(headlineFor("nii12", s.scenarioId));
    out.push(headlineFor("nii24", s.scenarioId));
  }
  return out;
}

/** The viewer's formatter for the same field: EveTable prints usdMM, NiiTable prints signedMM. */
export function formatHeadline(h: Headline, value: number): string {
  return h.format === "usdMM" ? usdMM(value) : signedMM(value);
}
