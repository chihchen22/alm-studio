/**
 * Stochastic CSV. One provenance header for every CSV read off a
 * stored stochastic envelope, and the single-run summary rendered as
 * one long table, and the stochastic Compare reply rendered as its CSV twin.
 * Rules, as csv.ts:
 *
 *  - No recompute, no rounding: every cell is the engine reply's value
 *    verbatim, numbers rendered by String() at full float precision, through
 *    the shared RFC 4180 cell().
 *  - The envelope carries kind, runId and schemaVersion but no inputsHash and
 *    no engineVersion. The header states that they are not recorded rather
 *    than leaving a blank (which would read as lost data) or inventing a value.
 *    platformRequestHash hashes the submission, not the engine inputs, so it
 *    is not a substitute.
 *  - B4 Task 8: a `# curve` row beside
 *    inputsHash names the curve the run built on, the line export/curveLine.ts
 *    reads from the envelope's curveDefault stamp (0.2.0), else the stored
 *    request's setup, else version 1.
 *  - Slice two: the summary CSV writes `# calibration.parameters` after the
 *    gate rows, the summary's calibration arm as one text ("a=..., sigma=..." for Hull-White, the
 *    six Rebonato values with displacement and CEV for BGM). The compare CSV is unchanged.
 *
 * A distribution here is a statistic of the Monte Carlo path set, never an EVE
 * or an NII.
 */
import {
  calibrationParametersText,
  type StochasticCompare,
  type StochasticDistributionCompare,
  type StochasticRunResult,
  type StochasticRunSummary,
  type StochasticSummaryRow,
} from "@alm/engine";
import { cell } from "./csv";
import type { RunCurveLine } from "./curveLine";

export interface StochasticCsvProvenance {
  kind: string;
  runId: string;
  schemaVersion: string;
  /** The curve line's value (curveLine.ts), for example "platform default v2, log-linear on discount factor". */
  curve: string;
}

const INPUTS_HASH_NOT_RECORDED = "not recorded: the stochastic envelope carries no inputsHash";
const ENGINE_VERSION_NOT_RECORDED = "not recorded: the stochastic envelope carries no engineVersion";

/**
 * The three provenance fields the envelope carries, read verbatim, and the curve line the caller read
 * for the run from its stored files (curveLine.ts storedRunCurveLine).
 */
export function stochasticProvenanceOf(e: StochasticRunResult, curve: RunCurveLine): StochasticCsvProvenance {
  return { kind: e.kind, runId: e.runId, schemaVersion: e.schemaVersion, curve: curve.value };
}

/** Exactly six comment rows; tag is "" for one run, " [A]" or " [B]" for a pair. */
export function stochasticProvenanceRows(tag: string, p: StochasticCsvProvenance): string[] {
  return [
    `# kind${tag},${cell(p.kind)}`,
    `# runId${tag},${cell(p.runId)}`,
    `# schemaVersion${tag},${cell(p.schemaVersion)}`,
    `# inputsHash${tag},${cell(INPUTS_HASH_NOT_RECORDED)}`,
    `# curve${tag},${cell(p.curve)}`,
    `# engineVersion${tag},${cell(ENGINE_VERSION_NOT_RECORDED)}`,
  ];
}

/**
 * The single-run summary as one rectangular table `section,field,p,value`,
 * holding exactly the summary's rows in its order, under the provenance
 * header, the stored calibration gate and the fixed notes.
 */
export function renderStochasticSummaryCsv(
  summary: StochasticRunSummary,
  prov: StochasticCsvProvenance,
  generatedAt: string,
): string {
  const stat = (section: string, r: StochasticSummaryRow): string =>
    `${section},${cell(r.stat)},${cell(r.p)},${cell(r.value)}`;
  const lines: string[] = [
    ...stochasticProvenanceRows("", prov),
    `# generatedAt,${cell(generatedAt)}`,
    `# calibrationGate,${cell(summary.calibrationGate.state)}`,
    `# calibrationGate.text,${cell(summary.calibrationGate.text)}`,
    `# calibration.parameters,${cell(calibrationParametersText(summary.calibration))}`,
    ...summary.notes.map((n) => `# note,${cell(n)}`),
    "section,field,p,value",
    ...summary.context.map((c) => `context,${cell(c.field)},,${cell(c.value)}`),
    ...summary.eveDistribution.rows.map((r) => stat("eveDistribution", r)),
    ...summary.nii12mDistribution.rows.map((r) => stat("nii12mDistribution", r)),
    ...summary.notImplemented.map((n) => `notImplemented,${cell(n.layer)},,${cell(n.reason)}`),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * The stochastic Compare reply as one rectangular table, the reply's
 * twin: both provenance headers, the reply notes and each distribution's
 * standard-error basis and text, then
 * `section,field,p,value [A],value [B],value [derived: B - A],same [derived]`.
 * Every derived cell is the engine's, labelled derived beside both originals;
 * a null standard-error figure renders blank.
 */
export function renderStochasticCompareCsv(
  reply: StochasticCompare,
  provA: StochasticCsvProvenance,
  provB: StochasticCsvProvenance,
  generatedAt: string,
): string {
  const dists: [string, StochasticDistributionCompare][] = [
    ["eveDistribution", reply.eveDistribution],
    ["nii12mDistribution", reply.nii12mDistribution],
  ];
  const lines: string[] = [
    ...stochasticProvenanceRows(" [A]", provA),
    ...stochasticProvenanceRows(" [B]", provB),
    `# generatedAt,${cell(generatedAt)}`,
    ...reply.notes.map((n) => `# note,${cell(n)}`),
    ...dists.flatMap(([name, d]) => [
      `# ${name}.meanDeltaStandardError.basis,${cell(d.meanDeltaStandardError.basis)}`,
      `# ${name}.meanDeltaStandardError.text,${cell(d.meanDeltaStandardError.text)}`,
    ]),
    "section,field,p,value [A],value [B],value [derived: B - A],same [derived]",
    ...reply.context.map((c) => `context,${cell(c.field)},,${cell(c.a)},${cell(c.b)},,${cell(c.same)}`),
    ...dists.flatMap(([name, d]) => [
      ...d.rows.map(
        (r) => `${name},${cell(r.stat)},${cell(r.p)},${cell(r.a)},${cell(r.b)},${cell(r.delta)},`,
      ),
      `${name},meanDeltaStandardError,,,,${cell(d.meanDeltaStandardError.value)},`,
    ]),
  ];
  return `${lines.join("\r\n")}\r\n`;
}
