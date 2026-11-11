/**
 * Plain-language rationale for the show-before-run step.
 *
 * The rationale is built ONLY from the instruction and the computed diff. It
 * echoes the instruction verbatim and enumerates the concrete param moves. It
 * states no economic conclusion the compiler cannot support and, by
 * construction, contains no balance-sheet figure: only run() produces numbers.
 */
import type { AssumptionDiff } from "@alm/engine";

function show(value: number | string | boolean | null): string {
  return value === null ? "unset" : String(value);
}

/** Render a deterministic account of what an instruction changed. */
export function buildRationale(instruction: string, diff: AssumptionDiff): string {
  const header = `Instruction: "${instruction}"`;
  if (diff.deltas.length === 0) {
    return `${header}\nNo overlay parameter changed versus the base; the assumption set is unchanged.`;
  }
  const count = diff.deltas.length;
  const noun = count === 1 ? "change" : "changes";
  const lines = diff.deltas.map(
    (d) => `- ${d.familyId} / ${d.overlayKind}: ${d.path} ${show(d.from)} -> ${show(d.to)}`,
  );
  return [
    header,
    `Compiled ${count} overlay parameter ${noun} versus base "${diff.baseId}", authored as data and shown before any run:`,
    ...lines,
    "No balance-sheet figure is computed at compile time; only run() produces numbers.",
  ].join("\n");
}
