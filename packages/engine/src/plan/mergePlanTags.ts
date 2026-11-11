/**
 * Merge compile-time NotImplemented tags into a finished RunResult.
 *
 * The compiler learns things the run pipeline never sees: a stage the pipeline
 * does not execute, a scenario's ramp timing, a declared balance plan nothing
 * consumed. Those tags are honest only if they reach the envelope, so the
 * caller merges them here. Pure: a new result, the input untouched, the run's
 * own tags first and each plan tag appended once, deduped by layer.
 *
 * Dedupe is by layer, so a tag about ONE item must carry that item's id in its
 * layer ("plan.stage.st-nii", not "plan.stage"). A layer that names a class of
 * items rather than an item silently collapses the second occurrence, which is
 * how a second ramp scenario went unreported in piece 1. Every tag maker in
 * this module follows the rule; the tests pin it.
 */
import type { NotImplemented } from "../contracts/errors";
import type { RunResult } from "../contracts/run";

export function mergePlanTags(result: RunResult, tags: NotImplemented[]): RunResult {
  const seen = new Set(result.notImplemented.map((n) => n.layer));
  const merged = [...result.notImplemented];
  for (const t of tags) {
    if (seen.has(t.layer)) continue;
    seen.add(t.layer);
    merged.push(t);
  }
  return { ...result, notImplemented: merged };
}
