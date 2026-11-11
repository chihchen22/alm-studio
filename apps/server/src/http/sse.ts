/**
 * Server-Sent Events for run progress. The endpoint
 * replays the run's persisted event log, then streams live events; a heartbeat
 * comment every 15 seconds keeps proxies open. Terminal runs replay and close.
 *
 * Honesty note: events are forwarded exactly as recorded. Nothing here
 * interpolates progress; a synthetic percent bar would be a small fabrication
 * and the platform does not do those.
 */
import type { ServerResponse } from "node:http";
import type { FileStore } from "../store/store";
import type { RunQueue } from "../jobs/queue";
import { TERMINAL_STATES, type RunStatus } from "../jobs/types";

const HEARTBEAT_MS = 15_000;

function writeEvent(res: ServerResponse, event: unknown): void {
  const t =
    event !== null && typeof event === "object" && typeof (event as { t?: unknown }).t === "string"
      ? (event as { t: string }).t
      : "message";
  res.write(`event: ${t}\ndata: ${JSON.stringify(event)}\n\n`);
}

/**
 * Serve one run's event stream. The caller has already validated the run id.
 */
export function serveRunEvents(
  res: ServerResponse,
  store: FileStore,
  queue: RunQueue,
  runId: string,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  // Replay the persisted log (status transitions and child events, in order).
  for (const event of store.readRunLog(runId)) writeEvent(res, event);

  const status = store.readRunJson<RunStatus>(runId, "status.json");
  if (TERMINAL_STATES.has(status.state)) {
    // Nothing more will ever happen; say so and close.
    writeEvent(res, { t: "end", state: status.state });
    res.end();
    return;
  }

  const unsubscribe = queue.subscribe((id, event) => {
    if (id !== runId) return;
    writeEvent(res, event);
    if (event.t === "status" && TERMINAL_STATES.has(event.state)) {
      writeEvent(res, { t: "end", state: event.state });
      cleanup();
      res.end();
    }
  });

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, HEARTBEAT_MS);
  heartbeat.unref();

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  res.on("close", cleanup);
}
