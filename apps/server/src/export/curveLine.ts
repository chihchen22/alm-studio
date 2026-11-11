/**
 * The curve line of a stored run. One helper, so the
 * run detail route, both CSV headers, the stochastic summary and readiness say the same words.
 *
 * Read in order:
 *   1. the stamp the run carries (a deterministic RunResult's `provenance.curveDefault`, a stochastic
 *      envelope's `curveDefault`), written since B4 Task 6;
 *   2. for a run stored without one, the `curveSetup` block of the stored request's market: such a run
 *      ran on that setup;
 *   3. otherwise curve default version 1, linear in zero, the only default a run stored before B4 ran on.
 * A stamp this server does not read (an unknown kind, a version other than 1 or 2, a field of the wrong
 * type) reads "unknown"; the helper never throws.
 *
 * The words:
 *   Curve: platform default v2, log-linear on discount factor
 *   Curve: platform default v1, linear in zero
 *   Curve: platform default v1, linear in zero (fallback: <reason>)
 *   Curve: setup <label> (<id>)    or    Curve: setup <id>
 *   Curve: unknown
 * `value` is the line after "Curve: ", the cell a CSV header row carries.
 */
import type { FileStore } from "../store/store";

export interface RunCurveLine {
  /** The sentence a Results page shows, for example "Curve: platform default v2, log-linear on discount factor". */
  line: string;
  /** The line after "Curve: ", as a CSV header cell carries it. */
  value: string;
  /** Where the line was read: the run's own stamp, the setup its stored request pinned, or neither. */
  from: "stamp" | "request-setup" | "unstamped";
}

export const CURVE_DEFAULT_V2_TEXT = "platform default v2, log-linear on discount factor";
export const CURVE_DEFAULT_V1_TEXT = "platform default v1, linear in zero";
const UNKNOWN = "unknown";

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

const lineOf = (value: string, from: RunCurveLine["from"]): RunCurveLine => ({ line: `Curve: ${value}`, value, from });

/** The setup block of a stored request's market, or undefined when it carries none. */
function requestSetupOf(requestMarket: unknown): Record<string, unknown> | null | undefined {
  if (!isRecord(requestMarket) || requestMarket.curveSetup === undefined) return undefined;
  return isRecord(requestMarket.curveSetup) ? requestMarket.curveSetup : null;
}

/** "setup <label> (<id>)" when the request's block is this setup and carries a label; "setup <id>" otherwise. */
function setupText(id: string, block: Record<string, unknown> | null | undefined): string {
  const label = block?.id === id ? block.label : undefined;
  return typeof label === "string" && label !== "" && label !== id ? `setup ${label} (${id})` : `setup ${id}`;
}

/** The text of a stamp, or null for a stamp this server does not read. */
function stampText(stamp: unknown, requestMarket: unknown): string | null {
  if (!isRecord(stamp)) return null;
  if (stamp.kind === "setup") {
    return typeof stamp.id === "string" && stamp.id !== "" ? setupText(stamp.id, requestSetupOf(requestMarket)) : null;
  }
  if (stamp.kind !== "default") return null;
  if (stamp.version === 2) return stamp.reason === undefined ? CURVE_DEFAULT_V2_TEXT : null;
  if (stamp.version !== 1) return null;
  if (stamp.reason === undefined) return CURVE_DEFAULT_V1_TEXT;
  return typeof stamp.reason === "string" ? `${CURVE_DEFAULT_V1_TEXT} (fallback: ${stamp.reason})` : null;
}

/**
 * The curve line from a run's stamp (undefined when the run carries none) and its stored request's
 * market (undefined when there is no stored request). Pure; never throws.
 */
export function curveLineOf(stamp: unknown, requestMarket: unknown): RunCurveLine {
  if (stamp !== undefined) return lineOf(stampText(stamp, requestMarket) ?? UNKNOWN, "stamp");
  const block = requestSetupOf(requestMarket);
  if (block !== undefined) {
    const id = block?.id;
    return lineOf(typeof id === "string" && id !== "" ? setupText(id, block) : "setup, not named in the stored request", "request-setup");
  }
  return lineOf(CURVE_DEFAULT_V1_TEXT, "unstamped");
}

/** The stamp a stored result carries: the stochastic envelope's own field, or the RunResult's provenance field. */
export function stampOfStoredResult(result: unknown): unknown {
  if (!isRecord(result)) return undefined;
  if (result.kind === "stochastic-distribution") return result.curveDefault;
  return isRecord(result.provenance) ? result.provenance.curveDefault : undefined;
}

/** The market of a run's stored request.json, or undefined when the run has none (a half-written or hand-placed run). */
export function storedRequestMarketOf(store: FileStore, runId: string): unknown {
  if (!store.runFileExists(runId, "request.json")) return undefined;
  const stored = store.readRunJson<{ request?: { marketSnapshot?: unknown } }>(runId, "request.json");
  return isRecord(stored) && isRecord(stored.request) ? stored.request.marketSnapshot : undefined;
}

/**
 * The curve line of a stored run from its files: the stamp of result.json (pass the result when the
 * caller has already read it) and the market of request.json. Null when the run has no result.json.
 */
export function storedRunCurveLine(store: FileStore, runId: string, result?: unknown): RunCurveLine | null {
  let stored = result;
  if (stored === undefined) {
    if (!store.runFileExists(runId, "result.json")) return null;
    stored = store.readRunJson<unknown>(runId, "result.json");
  }
  return curveLineOf(stampOfStoredResult(stored), storedRequestMarketOf(store, runId));
}
