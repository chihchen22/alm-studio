/**
 * The FIFO run queue: maxConcurrent 1 by default, submission order,
 * every state transition persisted to status.json and appended to log.ndjson
 * before subscribers hear about it. The store is the system of record; the
 * in-memory structures here are supervision handles, rebuilt at boot.
 *
 * Boot scan: any run found "running" has lost its
 * supervisor (this process was not watching it), so it becomes "interrupted" —
 * terminal, because the platform never silently re-runs compute and never
 * adopts a result it did not supervise. The status detail records whether the
 * recorded pid was still alive at scan time. Any "queued" run re-enqueues in
 * submittedAt order.
 */
import { syncRunToDb } from "../db/ingest";
import type { FileStore } from "../store/store";
import { spawnRun, type RunChildHandle } from "./spawnRun";
import { TERMINAL_STATES, type RunEvent, type RunStatus } from "./types";

export type QueueListener = (runId: string, event: RunEvent) => void;

/** Is a pid alive right now? (signal 0 probe; false on any refusal). */
function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class RunQueue {
  private readonly store: FileStore;
  private readonly repoRoot: string;
  private readonly maxConcurrent: number;
  private readonly waiting: string[] = [];
  private readonly active = new Map<string, RunChildHandle>();
  private readonly listeners = new Set<QueueListener>();

  constructor(store: FileStore, repoRoot: string, maxConcurrent = 1) {
    this.store = store;
    this.repoRoot = repoRoot;
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  /** Subscribe to every run event (SSE fan-out). Returns an unsubscribe. */
  subscribe(listener: QueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private broadcast(runId: string, event: RunEvent): void {
    for (const l of this.listeners) l(runId, event);
  }

  /** Persist an event to the run log, then broadcast it. Log before listeners. */
  private record(runId: string, event: RunEvent): void {
    this.store.appendRunLog(runId, { ...event, at: new Date().toISOString() });
    this.broadcast(runId, event);
  }

  private readStatus(runId: string): RunStatus {
    return this.store.readRunJson<RunStatus>(runId, "status.json");
  }

  private writeStatus(status: RunStatus): void {
    this.store.writeRunJson(status.runId, "status.json", status);
  }

  /**
   * Mirror a run that just became terminal into the platform database, best effort. Called only AFTER the
   * status is written and every listener has heard, and deferred to its own turn of the event loop, so the
   * exit handler, the cancel reply and the next queued run never wait on it. A done run's result.json is
   * hashed there; a failure (a locked database, an input the mirror lacks) is logged on one line and
   * dropped, because the store is the system of record and the next boot sync reconciles the run.
   */
  private mirrorTerminal(runId: string): void {
    setImmediate(() => {
      try {
        syncRunToDb({ store: this.store }, runId);
      } catch (err) {
        const why = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ");
        console.error(`platform: mirror sync failed for run ${runId} (the run is stored; the next boot sync reconciles or refuses): ${why}`);
      }
    });
  }

  private transition(runId: string, mutate: (s: RunStatus) => void): RunStatus {
    const status = this.readStatus(runId);
    mutate(status);
    this.writeStatus(status);
    this.record(runId, {
      t: "status",
      state: status.state,
      at: new Date().toISOString(),
      ...(status.error ? { error: { message: status.error.message } } : {}),
    });
    return status;
  }

  /**
   * Boot scan. Call once at construction time of the server, before accepting
   * requests. Orphaned "running" runs become terminal "interrupted"; "queued"
   * runs re-enqueue in submittedAt order.
   */
  bootScan(): { interrupted: string[]; requeued: string[] } {
    const interrupted: string[] = [];
    const requeuedStatuses: RunStatus[] = [];
    for (const runId of this.store.listRunIds()) {
      if (!this.store.runFileExists(runId, "status.json")) continue;
      const status = this.readStatus(runId);
      if (status.state === "running") {
        const alive = pidAlive(status.pid);
        this.transition(runId, (s) => {
          s.state = "interrupted";
          s.endedAt = new Date().toISOString();
          s.error = {
            message:
              "run supervisor was lost (platform restart while the run was in flight); " +
              "marked interrupted — the platform never silently re-runs compute",
            detail: alive
              ? `recorded pid ${status.pid} was still alive at boot scan; its output is not adopted`
              : `recorded pid ${status.pid} was dead at boot scan`,
          };
        });
        interrupted.push(runId);
        this.mirrorTerminal(runId);
      } else if (status.state === "queued") {
        requeuedStatuses.push(status);
      }
    }
    requeuedStatuses.sort((a, b) =>
      a.submittedAt === b.submittedAt
        ? a.runId.localeCompare(b.runId)
        : a.submittedAt.localeCompare(b.submittedAt),
    );
    const requeued = requeuedStatuses.map((s) => s.runId);
    for (const runId of requeued) this.waiting.push(runId);
    this.pump();
    return { interrupted, requeued };
  }

  /** Number of runs waiting or in flight (health surface). */
  get depth(): number {
    return this.waiting.length + this.active.size;
  }

  /** 0-based position in the waiting line; -1 when not waiting. */
  queuePosition(runId: string): number {
    return this.waiting.indexOf(runId);
  }

  /**
   * Enqueue a run whose request.json and status.json (state "queued") are
   * already on disk. Returns the queue position at submission.
   */
  enqueue(runId: string): number {
    this.waiting.push(runId);
    const position = this.waiting.length - 1;
    this.pump();
    return position;
  }

  /** Cancel: queued -> cancelled; running -> kill + cancelled; terminal -> 409. */
  cancel(runId: string): RunStatus {
    const status = this.readStatus(runId);
    if (TERMINAL_STATES.has(status.state)) {
      throw new ConflictError(
        `run "${runId}" is already terminal (${status.state}) and cannot be cancelled`,
      );
    }
    const waitingIdx = this.waiting.indexOf(runId);
    if (waitingIdx >= 0) this.waiting.splice(waitingIdx, 1);
    const handle = this.active.get(runId);
    if (handle) {
      handle.kill();
      this.active.delete(runId);
    }
    const next = this.transition(runId, (s) => {
      s.state = "cancelled";
      s.endedAt = new Date().toISOString();
      if (s.startedAt) s.elapsedMs = Date.parse(s.endedAt) - Date.parse(s.startedAt);
    });
    this.mirrorTerminal(runId);
    this.pump();
    return next;
  }

  /** Start waiting runs while capacity allows. */
  private pump(): void {
    while (this.active.size < this.maxConcurrent && this.waiting.length > 0) {
      const runId = this.waiting.shift()!;
      this.start(runId);
    }
  }

  private start(runId: string): void {
    const runDir = this.store.paths.runDir(runId);
    const handle = spawnRun(runDir, this.repoRoot, {
      onEvent: (event) => {
        if (event.t === "phase") {
          const status = this.readStatus(runId);
          if (status.state === "running") {
            status.phase = event.phase;
            this.writeStatus(status);
          }
        }
        this.record(runId, event);
      },
      onExit: (outcome) => {
        // A cancel may already have marked the run terminal; the kill-induced
        // exit must not overwrite that.
        this.active.delete(runId);
        const status = this.readStatus(runId);
        if (TERMINAL_STATES.has(status.state)) {
          this.pump();
          return;
        }
        if (outcome.code === 0 && this.store.runFileExists(runId, "result.json")) {
          this.transition(runId, (s) => {
            s.state = "done";
            s.phase = "done";
            s.endedAt = new Date().toISOString();
            if (s.startedAt) s.elapsedMs = Date.parse(s.endedAt) - Date.parse(s.startedAt);
          });
        } else {
          this.transition(runId, (s) => {
            s.state = "error";
            s.endedAt = new Date().toISOString();
            if (s.startedAt) s.elapsedMs = Date.parse(s.endedAt) - Date.parse(s.startedAt);
            s.error = outcome.error ?? {
              message:
                outcome.code === 0
                  ? "run child exited 0 but wrote no result.json"
                  : `run child exited with code ${String(outcome.code)}`,
            };
          });
        }
        this.mirrorTerminal(runId);
        this.pump();
      },
    });
    this.active.set(runId, handle);
    this.transition(runId, (s) => {
      s.state = "running";
      s.startedAt = new Date().toISOString();
      s.pid = handle.pid;
    });
  }

  /** Current state as seen by listings: derive queuePosition live. */
  statusWithPosition(runId: string): RunStatus & { queuePosition?: number } {
    const status = this.readStatus(runId);
    const pos = this.queuePosition(runId);
    return pos >= 0 ? { ...status, queuePosition: pos } : { ...status };
  }
}
