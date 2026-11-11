/**
 * Explain layer (m14): compose the final natural-language answer for one
 * headline movement.
 *
 * The input is m12's structured Explanation, which carries the supported flag,
 * the HeadlineAttribution drawn from the run's AttributionResult, and the
 * already material-filtered, magnitude-sorted DriverContribution citations. This
 * module narrates that decomposition into prose and does nothing else.
 *
 * It READS numbers and never computes them. Every figure it emits is a verbatim
 * field of the attribution decomposition (a contribution amount, the residual,
 * or a headline envelope value), rendered through the same string interpolation
 * the compiler's rationale uses. The materiality filter, the citation order, and
 * the supported/not-supported decision all belong to m12; this layer re-derives
 * none of them, so no arithmetic path exists here (enforced by a source scan).
 *
 * When the attribution cannot support the question, the answer says so plainly
 * rather than manufacturing a driver story.
 */
import type { Explanation } from "@alm/engine";

/** Compose the final natural-language answer for one headline movement. */
export function composeAnswer(explanation: Explanation): string {
  if (!explanation.supported) {
    return composeNotSupported(explanation);
  }
  return composeSupported(explanation);
}

/** Honest decline: the decomposition cannot support a driver-level answer. */
function composeNotSupported(explanation: Explanation): string {
  const h = explanation.attribution;
  if (h === null) {
    return [
      "The attribution decomposition cannot support this question.",
      "No headline movement was decomposed for the requested metric and scenario,",
      "so there is nothing to attribute and no driver-level answer can be given.",
    ].join(" ");
  }
  return [
    `The attribution decomposition cannot support a driver-level explanation of ${h.metric} in scenario "${h.scenarioId}".`,
    `The attributed drivers leave an unexplained residual of ${h.residual} against the movement of ${h.totalDelta} versus base,`,
    "so no honest driver attribution can be given for this movement.",
  ].join(" ");
}

/** Narrate the movement and cite each driver m12 flagged material. */
function composeSupported(explanation: Explanation): string {
  const h = explanation.attribution;
  if (h === null) {
    throw new Error(
      "explain: a supported Explanation must carry its HeadlineAttribution; received supported=true with attribution=null",
    );
  }

  const lines: string[] = [];
  lines.push(
    `In scenario "${h.scenarioId}", ${h.metric} moved ${h.totalDelta} versus base, from ${h.baseValue} to ${h.scenarioValue}.`,
  );

  if (explanation.citations.length === 0) {
    lines.push("No single driver contributes a material amount to the movement.");
  } else {
    lines.push("The movement is attributed to the following cited drivers, largest first:");
    for (const c of explanation.citations) {
      lines.push(`- ${c.familyId} ${c.driver}: ${c.amount}`);
    }
  }

  lines.push(`Unexplained residual: ${h.residual}.`);
  return lines.join("\n");
}
