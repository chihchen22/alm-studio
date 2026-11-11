// apps/studio/src/run/runState.ts
/**
 * The run progress card's state (Studio S3a): a fold over the run's SSE
 * events, forwarded as received. No percent and no estimate: the server sends
 * neither. The reader's classifier passes stderr, error and end frames
 * through as { t: "unknown", raw }, so they are read off `raw` here.
 */
import type { RunEvent, RunState } from "@alm/reader";

export interface RunView {
  runId: string;
  state: RunState | null;
  phase: string | null;
  log: string[];
  stderr: string[];
  errors: string[];
  end: RunState | null;
  /**
   * Set when the event stream failed (for example an unknown run id answers
   * 404, the server is down and EventSource is retrying, or the stream dropped
   * mid-run); absent while it answers.
   * Any event that arrives afterwards clears it.
   */
  streamError?: string;
}

export function initialRunView(runId: string): RunView {
  return { runId, state: null, phase: null, log: [], stderr: [], errors: [], end: null };
}

type Raw = { t?: unknown; line?: unknown; message?: unknown; detail?: unknown; state?: unknown };

function reduceRaw(v: RunView, raw: unknown): RunView {
  const r: Raw = raw !== null && typeof raw === "object" ? (raw as Raw) : {};
  if (r.t === "stderr" && typeof r.line === "string") return { ...v, stderr: [...v.stderr, r.line] };
  if (r.t === "error" && typeof r.message === "string") {
    return { ...v, errors: [...v.errors, typeof r.detail === "string" ? `${r.message}: ${r.detail}` : r.message] };
  }
  if (r.t === "end" && typeof r.state === "string") return { ...v, end: r.state as RunState };
  return { ...v, log: [...v.log, `unrecognized event: ${JSON.stringify(raw)}`] };
}

/**
 * The stream failed: record it. EventSource reports no cause (a 404, an
 * unreachable server and a mid-stream drop all look the same), so the text
 * names examples, not a complete list. The status, log and errors already
 * received stay as they are.
 */
export function streamFailed(v: RunView): RunView {
  return { ...v, streamError: `event stream failed for run ${v.runId}; the cause is not visible to Studio (for example an unknown run id or an unreachable server)` };
}

/** An event arrived, so the stream answers again: clear any recorded failure. */
export function reduceRun(v: RunView, e: RunEvent): RunView {
  const { streamError: _cleared, ...live } = v;
  return reduceEvent(live, e);
}

function reduceEvent(v: RunView, e: RunEvent): RunView {
  switch (e.t) {
    case "phase":
      return { ...v, phase: e.phase };
    case "log":
      return { ...v, log: [...v.log, e.line] };
    case "status": {
      // The persisted log opens with the queued status; seeing it again means
      // the stream reconnected and is replaying, so start over from it.
      if (e.status.state === "queued") return { ...initialRunView(v.runId), state: "queued" };
      const err = e.status.error;
      // The failed status repeats the child's error frame's message (already held as "message" or
      // "message: detail"), so a repeat is not printed a second time.
      const repeat = err !== undefined && v.errors.some((x) => x === err.message || x.startsWith(`${err.message}: `));
      return { ...v, state: e.status.state, errors: err !== undefined && !repeat ? [...v.errors, err.message] : v.errors };
    }
    case "unknown":
      return reduceRaw(v, e.raw);
  }
}

/**
 * A failed run's message as the run card prints it. The runner writes its own entry name in front of the failure
 * ("runnerEntry: SeasoningError: ..."); that is a process detail the analyst cannot act on, so the display drops it.
 * The stored message is unchanged.
 */
export function runErrorLine(message: string): string {
  return message.replace(/^runnerEntry: /, "");
}

/** The end state an event carries, or null for any other event. */
export function endOf(e: RunEvent): RunState | null {
  if (e.t !== "unknown" || e.raw === null || typeof e.raw !== "object") return null;
  const r = e.raw as Raw;
  return r.t === "end" && typeof r.state === "string" ? (r.state as RunState) : null;
}

/**
 * Cancel is offered until the stream ends, while the run is queued, running,
 * or not yet reported. A run that never reported a status over a failed
 * stream is not known to exist, so it offers no Cancel.
 */
export function cancellable(v: RunView): boolean {
  if (v.state === null && v.streamError !== undefined) return false;
  return v.end === null && (v.state === null || v.state === "queued" || v.state === "running");
}
