/**
 * Registry refusals. Every seam registry refuses the same two ways, so the two
 * refusals are one pair of classes rather than a bare Error per seam: a caller
 * catching a registration failure can read which seam refused and which ids
 * were live, and a test can assert the class instead of a message substring.
 */

/** Base of every registry refusal. `seam` is the Services key the registry sits behind. */
export class RegistryError extends Error {
  readonly seam: string;
  constructor(seam: string, message: string) {
    super(message);
    this.name = "RegistryError";
    this.seam = seam;
  }
}

/** A second registration under one id. One id, one plugin, on every seam. */
export class DuplicateRegistrationError extends RegistryError {
  readonly id: string;
  constructor(seam: string, id: string) {
    super(seam, `"${id}" is already registered on the "${seam}" seam; one id, one plugin`);
    this.name = "DuplicateRegistrationError";
    this.id = id;
  }
}

/** A lookup for an id no plugin registered. Names every id that IS live, so the miss is diagnosable. */
export class UnknownRegistrationError extends RegistryError {
  readonly id: string;
  readonly registered: string[];
  constructor(seam: string, id: string, registered: string[]) {
    super(
      seam,
      `no "${id}" is registered on the "${seam}" seam; registered ids: [${registered.join(", ")}]`,
    );
    this.name = "UnknownRegistrationError";
    this.id = id;
    this.registered = [...registered];
  }
}

/**
 * A custom metric registration the metrics seam refuses. Four
 * reasons, one class: a malformed id, a collision with one of the four
 * built-in engine metric ids, a second registration of one custom id, and a
 * plugin registering a second custom metric. The id and the reason are both in
 * the message, so the fix is readable without a stack trace.
 */
export class CustomMetricRegistrationError extends RegistryError {
  readonly metricId: string;
  constructor(metricId: string, reason: string) {
    super("metrics", `custom metric "${metricId}" cannot be registered: ${reason}`);
    this.name = "CustomMetricRegistrationError";
    this.metricId = metricId;
  }
}
