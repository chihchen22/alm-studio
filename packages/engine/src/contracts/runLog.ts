/**
 * The run log. Hard rule: every number in a RunResult traces
 * to an entry here. The log is data, built during compile and run, carried in
 * provenance.runLog, and rendered as a tree on the Plan page. It records which
 * plugin answered for a seam; it never records a number.
 */

/** Where a mounted plugin's code came from. */
export type PluginSource = "builtin" | { path: string; sha256: string };

/** A gate failure as the plan contract defines it, structurally repeated so this file stays data-only. */
export interface RunLogGateFailure {
  gate: "type" | "routing";
  rule: string;
  stageId: string | null;
  detail: string;
}

export type RunLogEntry =
  | {
      t: "profile";
      profileHash: string;
      rows: Array<{ id: string; plugin: string; configHash: string; state: "active" | "disabled" }>;
    }
  | { t: "catalog"; pluginId: string; source: PluginSource }
  | {
      t: "resolve";
      key: string;
      pluginId: string;
      scope: { scenarioId?: string; stageId?: string; metricId?: string };
    }
  | {
      t: "gate";
      event: "plan/type-check" | "plan/route";
      /**
       * The listener that owned the decision: the last plugin to contribute to
       * the report. A chain a policy plugin vetoed names that plugin, because
       * the built-in gate behind it never ran.
       */
      listenerPluginId: string;
      /** Every plugin that contributed to the report, in the order they did. */
      contributors: string[];
      passed: boolean;
      failures: RunLogGateFailure[];
    }
  | {
      t: "plan";
      /** Absent on a derived plan: a default plan is logged, not stored. */
      planId?: string;
      derived: boolean;
      stageIds: string[];
    }
  | {
      t: "stage";
      stageId: string;
      pluginId: string;
      /** The plan's StageKind, repeated structurally so this file stays data-only. */
      kind: string;
      /**
       * One row per resolved EDGE, not per artifact instance: `scope` is the
       * scope KIND the producer writes at ("run", "scenario", "assumptionSet"),
       * so a five-scenario run logs one row per edge rather than five.
       */
      consumed: Array<{ type: string; scope: string; producerStageId: string }>;
      produced: Array<{ type: string; scope: string }>;
      /**
       * Why the stage did no work. "not-executable" is a stage the compile
       * tolerated with no mounted plugin; it puts nothing on the shelf.
       * "no-binding" is a behavioral stage that licenses no binding; it still
       * passes its book through unchanged, so the chain downstream of it reads
       * exactly what it received.
       */
      skipped?: "not-executable" | "no-binding";
      /** The licensed bindings this behavioral stage applied and how many positions each matched. */
      bindings?: Array<{ assumptionSetId: string; bindingIndex: number; positionsMatched: number }>;
    }
  | {
      t: "license";
      stageId: string;
      assumptionSetId: string;
      familyId: string;
      kind: string;
      bindingIndex: number;
      /** Canonical predicate; absent when the binding matches its whole family. */
      selector?: string;
      positionsMatched: number;
    }
  | { t: "refuse"; error: string; ids: Record<string, string> };

/** The runLog seam: append-only during a run, read once at the stamp. */
export interface RunLog {
  append(entry: RunLogEntry): void;
  /** A copy in append order. Callers may not mutate the log through it. */
  entries(): RunLogEntry[];
  /** Drop every entry. Called at the top of a run so a memoized harness does not accumulate. */
  clear(): void;
}
