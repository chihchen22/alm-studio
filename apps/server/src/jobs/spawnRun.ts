/**
 * Child-process supervisor for one run. Spawns runnerEntry.mjs on
 * process.execPath (the loader shape proven by the kernel worker bootstrap and
 * by scripts/smoke.ts on this machine), tees the child's JSON-line stdout into
 * the run log, and reports the exit outcome. The HTTP process never computes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { RunEvent } from "./types";

const RUNNER_ENTRY = fileURLToPath(new URL("./runnerEntry.mjs", import.meta.url));

export interface RunChildHandle {
  pid: number | undefined;
  kill(): void;
}

export interface SpawnRunCallbacks {
  /** Every protocol event from the child (phase, log, stderr, error). */
  onEvent(event: RunEvent): void;
  /** Child ended. `error` is set when exit was nonzero or spawn itself failed. */
  onExit(outcome: { code: number | null; error?: { message: string; detail?: string } }): void;
}

/**
 * Spawn the runner for one run directory. Non-blocking: the caller gets a
 * handle immediately and outcomes arrive on the callbacks. Cancellation is
 * process-kill (the child's worker_threads die with it).
 */
export function spawnRun(runDir: string, repoRoot: string, cb: SpawnRunCallbacks): RunChildHandle {
  const child: ChildProcess = spawn(process.execPath, [RUNNER_ENTRY, runDir], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // The last typed error the child reported, used to enrich a nonzero exit.
  let lastError: { message: string; detail?: string } | undefined;

  const feed = (chunkStore: { buf: string }, data: Buffer, isStderr: boolean): void => {
    chunkStore.buf += data.toString("utf8");
    let nl: number;
    while ((nl = chunkStore.buf.indexOf("\n")) >= 0) {
      const line = chunkStore.buf.slice(0, nl).replace(/\r$/, "");
      chunkStore.buf = chunkStore.buf.slice(nl + 1);
      if (line.trim() === "") continue;
      if (isStderr) {
        cb.onEvent({ t: "stderr", line });
        continue;
      }
      let event: RunEvent | null = null;
      try {
        const parsed = JSON.parse(line) as RunEvent;
        if (parsed !== null && typeof parsed === "object" && typeof parsed.t === "string") event = parsed;
      } catch {
        // Not protocol JSON: surface it verbatim as a log line, never dropped.
      }
      if (event === null) event = { t: "log", line };
      if (event.t === "error") lastError = { message: event.message, detail: event.detail };
      cb.onEvent(event);
    }
  };

  const outBuf = { buf: "" };
  const errBuf = { buf: "" };
  child.stdout?.on("data", (d: Buffer) => feed(outBuf, d, false));
  child.stderr?.on("data", (d: Buffer) => feed(errBuf, d, true));

  child.on("error", (err) => {
    // Spawn-level failure (before or outside the exit path).
    lastError = { message: "child spawn failed", detail: err.message };
  });

  child.on("close", (code) => {
    if (code === 0) {
      cb.onExit({ code });
      return;
    }
    cb.onExit({
      code,
      error: lastError ?? {
        message: `run child exited with code ${code === null ? "null (killed)" : code}`,
      },
    });
  });

  return {
    pid: child.pid,
    kill: () => {
      child.kill();
    },
  };
}

/** Resolve the repo root from this file's location (apps/server/src/jobs). */
export function defaultRepoRoot(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
}
