/**
 * SSE subscription over GET /api/runs/:id/events.
 *
 * The event stream is JSON lines forwarded from the run child's stdout:
 * `{ t: "phase", phase }` from the engine's four-phase seam, `{ t: "log", line }`
 * for log lines, plus server-side status transitions. The wrapper parses and
 * forwards events verbatim; it never synthesizes progress (no interpolated
 * percent bars: a progress display that interpolates is a small fabrication).
 * Unknown event kinds are forwarded as `{ t: "unknown" }` with the raw payload
 * so a newer server never renders as silence.
 */
import { runEventsUrl, type RunPhase, type RunState, type RunStatusRecord } from "./client";

export type RunEvent =
  | { t: "phase"; phase: RunPhase }
  | { t: "log"; line: string }
  | { t: "status"; status: Partial<RunStatusRecord> & { state: RunState } }
  | { t: "unknown"; raw: unknown };

export interface RunEventHandlers {
  onEvent: (event: RunEvent) => void;
  /** Fired on stream error (server down, run directory gone). EventSource retries by itself. */
  onError?: (err: Event) => void;
}

/** Exported for Studio S3a: the reducer and the acceptance test classify frames the way the subscription does. */
export function classifyRunEvent(raw: unknown): RunEvent {
  if (typeof raw === "object" && raw !== null && "t" in raw) {
    const e = raw as {
      t: unknown;
      phase?: unknown;
      line?: unknown;
      status?: unknown;
      state?: unknown;
      error?: unknown;
    };
    if (e.t === "phase" && typeof e.phase === "string") {
      return { t: "phase", phase: e.phase as RunPhase };
    }
    if (e.t === "log" && typeof e.line === "string") {
      return { t: "log", line: e.line };
    }
    if (e.t === "status" && typeof e.status === "object" && e.status !== null) {
      return { t: "status", status: e.status as Partial<RunStatusRecord> & { state: RunState } };
    }
    // The server's persisted/live status transitions are FLAT:
    // { t: "status", state, at, error? } (apps/server jobs/types.ts RunEvent).
    // Normalize to the nested shape; the fields are forwarded verbatim.
    if (e.t === "status" && typeof e.state === "string") {
      return {
        t: "status",
        status: {
          state: e.state as RunState,
          ...(typeof e.error === "object" && e.error !== null
            ? { error: e.error as { message: string } }
            : {}),
        },
      };
    }
  }
  return { t: "unknown", raw };
}

/**
 * Server event names on the wire: the server writes NAMED SSE events
 * (`event: <t>` per apps/server/src/http/sse.ts, where <t> is the event's `t`
 * field), and EventSource only delivers named events to addEventListener —
 * onmessage fires solely for unnamed/`message` events. Every name the server
 * emits is subscribed here; an unrecognized payload still surfaces as
 * `{ t: "unknown" }`, never silence.
 */
const SERVER_EVENT_NAMES = ["status", "phase", "log", "stderr", "error", "end", "message"] as const;

/**
 * Subscribe to a run's event stream. Returns an unsubscribe function that
 * closes the EventSource. Heartbeat comments never reach listeners; malformed
 * frames surface as `{ t: "unknown" }` rather than being swallowed.
 */
export function subscribeRunEvents(runId: string, handlers: RunEventHandlers): () => void {
  const source = new EventSource(runEventsUrl(runId));
  const deliver = (msg: MessageEvent<string>): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(msg.data);
    } catch {
      raw = msg.data;
    }
    handlers.onEvent(classifyRunEvent(raw));
  };
  for (const name of SERVER_EVENT_NAMES) source.addEventListener(name, deliver);
  if (handlers.onError) source.onerror = handlers.onError;
  return () => source.close();
}
