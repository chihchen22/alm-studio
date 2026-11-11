/**
 * The one context object route handlers close over: the store (system of
 * record), the workspace directory beside it, the run queue (supervision), the
 * resolved config, and the boot seed report's stale and retired findings.
 */
import type { PlatformConfig } from "./config";
import type { FileStore } from "./store/store";
import type { RunQueue } from "./jobs/queue";
import type { WorkspaceStore } from "./workspaces/workspaceStore";
import type { RetiredDocument, StaleDocument } from "../scripts/seed-store";

export interface PlatformContext {
  store: FileStore;
  /** The workspace head-plus-history directory under the store root (Studio A+E Section 2.3). */
  workspaces: WorkspaceStore;
  queue: RunQueue;
  config: PlatformConfig;
  /** The boot seed report's stale and retired findings; empty lists when none was passed. */
  seedReport: { stale: StaleDocument[]; retired: RetiredDocument[] };
}
