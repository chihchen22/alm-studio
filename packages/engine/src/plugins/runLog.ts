import type { Plugin } from "@alm/harness";
import type { RunLog, RunLogEntry } from "../contracts/runLog";

/** The in-memory append-only log. One buffer per mounted context. */
export function makeRunLog(): RunLog {
  const entries: RunLogEntry[] = [];
  return {
    append(entry) { entries.push(entry); },
    entries() { return [...entries]; },
    clear() { entries.length = 0; },
  };
}

export const runLogPlugin: Plugin = {
  id: "engine.run-log",
  apply(ctx) {
    ctx.provide("runLog", makeRunLog());
  },
};
