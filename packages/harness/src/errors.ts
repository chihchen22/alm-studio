/**
 * Kernel errors. Every one names the ids involved in its message, because a
 * mount failure is read by a person holding a profile row, not a stack trace.
 */

export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessError";
  }
}

/** A second provide on a key another live plugin holds. */
export class ServiceConflictError extends HarnessError {
  readonly key: string;
  readonly holderPluginId: string;
  readonly claimantPluginId: string;
  constructor(key: string, holderPluginId: string, claimantPluginId: string) {
    super(
      `service "${key}" is already provided by plugin "${holderPluginId}"; ` +
        `plugin "${claimantPluginId}" cannot provide it as well (dispose the holder's row first)`,
    );
    this.name = "ServiceConflictError";
    this.key = key;
    this.holderPluginId = holderPluginId;
    this.claimantPluginId = claimantPluginId;
  }
}

/** A get on a key nothing has provided. */
export class MissingServiceError extends HarnessError {
  readonly key: string;
  readonly callerPluginId: string;
  constructor(key: string, callerPluginId: string) {
    super(`service "${key}" is not provided; plugin "${callerPluginId}" asked for it`);
    this.name = "MissingServiceError";
    this.key = key;
    this.callerPluginId = callerPluginId;
  }
}

/**
 * One or more teardowns threw while the context unwound. The unwind still ran
 * to completion; every failure it collected is on `causes`, newest first.
 */
export class DisposeFailedError extends HarnessError {
  readonly causes: unknown[];
  constructor(causes: unknown[]) {
    super(
      `${causes.length} teardown${causes.length === 1 ? "" : "s"} threw while the context unwound; ` +
        `the unwind completed, see the causes array`,
    );
    this.name = "DisposeFailedError";
    this.causes = causes;
  }
}

/** finalize() found a fiber still waiting on keys nothing provided. */
export class UnmetDependencyError extends HarnessError {
  readonly pluginId: string;
  readonly missingKeys: string[];
  constructor(pluginId: string, missingKeys: string[]) {
    super(
      `plugin "${pluginId}" never activated: it injects [${missingKeys.join(", ")}] and no mounted ` +
        `plugin provides ${missingKeys.length === 1 ? "that key" : "those keys"}`,
    );
    this.name = "UnmetDependencyError";
    this.pluginId = pluginId;
    this.missingKeys = missingKeys;
  }
}

/** A single-fiber dispose that would pull a key out from under a live consumer. */
export class DependentActiveError extends HarnessError {
  readonly key: string;
  readonly dependentPluginId: string;
  constructor(key: string, dependentPluginId: string) {
    super(
      `cannot dispose the provider of "${key}": plugin "${dependentPluginId}" is active and injects it; ` +
        `dispose that row first (there is no automatic cascade)`,
    );
    this.name = "DependentActiveError";
    this.key = key;
    this.dependentPluginId = dependentPluginId;
  }
}

/** A plugin threw inside apply or inside a dispatch the kernel drove. */
export class PluginFailedError extends HarnessError {
  readonly pluginId: string;
  readonly rowId: string;
  readonly stageId?: string;
  override readonly cause: unknown;
  constructor(pluginId: string, rowId: string, cause: unknown, stageId?: string) {
    const where = stageId === undefined ? "" : ` at stage "${stageId}"`;
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`plugin "${pluginId}" (row "${rowId}") failed${where}: ${detail}`);
    this.name = "PluginFailedError";
    this.pluginId = pluginId;
    this.rowId = rowId;
    if (stageId !== undefined) this.stageId = stageId;
    this.cause = cause;
  }
}

/** A profile row names a plugin the catalog does not hold. */
export class UnknownPluginError extends HarnessError {
  readonly rowId: string;
  readonly pluginId: string;
  constructor(rowId: string, pluginId: string) {
    super(`profile row "${rowId}" names plugin "${pluginId}", which is not in the catalog`);
    this.name = "UnknownPluginError";
    this.rowId = rowId;
    this.pluginId = pluginId;
  }
}

/** A patch names a row the profile does not have. Nothing is silently ignored. */
export class UnknownRowError extends HarnessError {
  readonly layerLabel: string;
  readonly rowId: string;
  constructor(layerLabel: string, rowId: string) {
    super(`patch layer "${layerLabel}" targets row "${rowId}", which the profile does not have`);
    this.name = "UnknownRowError";
    this.layerLabel = layerLabel;
    this.rowId = rowId;
  }
}

/** Two rows share an id, so a patch could not say which one it meant. */
export class DuplicateRowError extends HarnessError {
  readonly rowId: string;
  constructor(rowId: string) {
    super(`profile has two rows with id "${rowId}"; row ids are unique within a profile`);
    this.name = "DuplicateRowError";
    this.rowId = rowId;
  }
}

/**
 * A value handed to canonicalJson has no canonical JSON form, so it cannot take
 * part in a profile hash. `path` names where it sat, e.g. `rows[0].config.beta`.
 */
export class CanonicalJsonError extends HarnessError {
  readonly path?: string;
  constructor(detail: string, path?: string) {
    const where = path === undefined || path === "" ? "" : ` at ${path}`;
    super(`cannot canonicalize${where}: ${detail}`);
    this.name = "CanonicalJsonError";
    if (path !== undefined) this.path = path;
  }
}

/** A patch carries none of the four shapes, so the layer says nothing the composer can apply. */
export class InvalidPatchError extends HarnessError {
  readonly layerLabel: string;
  constructor(layerLabel: string) {
    super(
      `patch layer "${layerLabel}" holds a patch with none of set, disable, enable or insert; ` +
        `a patch must name exactly one of them`,
    );
    this.name = "InvalidPatchError";
    this.layerLabel = layerLabel;
  }
}
