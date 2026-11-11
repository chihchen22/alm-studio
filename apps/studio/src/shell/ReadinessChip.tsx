/**
 * The readiness chip (spec v3.1 Section 3.5): one of six states, always as a word, so colour is never the only cue.
 * The server computes every state; this component prints one. A section chip is the worst counted state among its
 * items (an optional item that is Not set never counts), which `GET /api/workspaces/:id/readiness` already folds into
 * `sections`, so the Launch gate and the chips agree.
 */
import type { ReadinessState } from "@alm/reader";

/** Worst first: Error, Not set on a required item, Stale, Warning, Draft, Valid. */
export const READINESS_ESCALATION: readonly ReadinessState[] = Object.freeze(["error", "not-set", "stale", "warning", "draft", "valid"] as const);

const WORD: Record<ReadinessState, string> = {
  valid: "Valid",
  "not-set": "Not set",
  draft: "Draft",
  warning: "Warning",
  error: "Error",
  stale: "Stale",
};

export function readinessWord(state: ReadinessState): string {
  return WORD[state];
}

export function ReadinessChip(props: { state: ReadinessState }) {
  return <span className={`status chip-readiness chip-readiness-${props.state}`}>{WORD[props.state]}</span>;
}
