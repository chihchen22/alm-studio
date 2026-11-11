/**
 * The kernel context: a shelf of services plus the unwind discipline that makes
 * every registration reversible. Synchronous throughout; the ALM run is one
 * pure function per request and nothing here may make it await.
 *
 * `owner` is the plugin id credited for a registration and blamed in an error.
 * It is "<root>" outside a plugin's apply, and the mounting fiber's plugin id
 * inside one (Task 2 sets it).
 */
import {
  DependentActiveError,
  DisposeFailedError,
  HarnessError,
  MissingServiceError,
  PluginFailedError,
  ServiceConflictError,
  UnmetDependencyError,
} from "./errors";
import type {
  Dispose,
  EventName,
  Events,
  ServiceKey,
  Services,
  WaterfallPayloadOf,
  WaterfallResultOf,
} from "./types";

interface Holder {
  pluginId: string;
  /** The fiber that registered the key, or undefined at root. Identity, not id: */
  /** two rows of one plugin share a pluginId and must still be told apart. */
  fiber: FiberRecord | undefined;
  service: unknown;
}

export const ROOT_OWNER = "<root>";

/** What a plugin tells the type gate about itself. Strings, so the kernel stays dependency-free. */
export interface PluginDeclares {
  kind: string;
  produces: string[];
  consumes?: string[];
}

/**
 * A plugin. `apply` runs exactly once per mount, after every key in `inject` is
 * provided, and registers services, listeners and effects on the context.
 */
export interface Plugin<C = undefined> {
  id: string;
  inject?: readonly ServiceKey[];
  declares?: PluginDeclares;
  apply(ctx: Context, config: C): void;
}

/**
 * One mounted row as a reader sees it: who it is and what it declares. The
 * declaration is the plugin's own `declares`, carried so a producer gate can
 * ask the context what is mounted instead of keeping a list beside it.
 */
export interface PluginDeclaration {
  id: string;
  rowId: string;
  declares?: PluginDeclares;
}

/** One mounted row. */
export interface Fiber {
  readonly rowId: string;
  readonly pluginId: string;
  readonly state: "pending" | "active" | "disposed";
  dispose(): void;
}

/** One registered listener, with the plugin row blamed when it throws. */
interface ListenerRecord {
  fn: (...args: any[]) => unknown;
  pluginId: string;
  rowId: string;
}

interface FiberRecord {
  rowId: string;
  pluginId: string;
  state: "pending" | "active" | "disposed";
  declares: PluginDeclares | undefined;
  inject: string[];
  disposes: Dispose[];
  run: () => void;
  handle: Fiber;
}

export class Context {
  /** Live services by key. */
  private readonly services = new Map<string, Holder>();
  /** Root-level registrations, unwound in reverse by dispose(). */
  private readonly rootDisposes: Dispose[] = [];
  /** Where a registration is recorded right now. */
  protected sink: Dispose[] = this.rootDisposes;
  /** Who is registering right now. */
  protected owner: string = ROOT_OWNER;
  /** Row id of the plugin registering right now. */
  protected ownerRow = ROOT_OWNER;
  /** Listeners by event name, in dispatch order. */
  private readonly listeners = new Map<string, ListenerRecord[]>();
  /** True while dispose() is unwinding the whole tree. */
  protected unwinding = false;
  private disposed = false;
  /** Mounted fibers in mount order. */
  private readonly fibers: FiberRecord[] = [];
  /** The fiber whose apply is running right now, or undefined at root. */
  private current: FiberRecord | undefined;
  /** One collector per apply on the stack: the fibers that apply woke, in wake order. */
  private readonly activationStack: FiberRecord[][] = [];

  /** Register a service. Returns the dispose that frees the key. */
  provide<K extends ServiceKey>(key: K, service: Services[K]): Dispose {
    this.assertLive(`provide service "${key}"`);
    const held = this.services.get(key);
    if (held) throw new ServiceConflictError(key, held.pluginId, this.owner);
    const pluginId = this.owner;
    const holder: Holder = { pluginId, fiber: this.current, service };
    this.services.set(key, holder);
    let live = true;
    const undo: Dispose = () => {
      if (!live) return;
      if (!this.unwinding) {
        const dependent = this.dependentOn(key, holder.fiber);
        if (dependent) throw new DependentActiveError(key, dependent.pluginId);
      }
      live = false;
      if (this.services.get(key) === holder) this.services.delete(key);
    };
    this.sink.push(undo);
    this.wakePending();
    return undo;
  }

  /** Read a service. Throws MissingServiceError naming the key and the caller. */
  get<K extends ServiceKey>(key: K): Services[K] {
    const held = this.services.get(key);
    if (!held) throw new MissingServiceError(key, this.owner);
    return held.service as Services[K];
  }

  has(key: string): boolean {
    return this.services.has(key);
  }

  /** Which plugin provided a live key, or undefined. Read by the run log. */
  providerOf(key: string): string | undefined {
    return this.services.get(key)?.pluginId;
  }

  /** Any reversible registration. The setup runs now; its dispose joins the unwind. */
  effect(setup: () => Dispose): Dispose {
    this.assertLive("register an effect");
    const teardown = setup();
    let live = true;
    const undo: Dispose = () => {
      if (!live) return;
      live = false;
      teardown();
    };
    this.sink.push(undo);
    return undo;
  }

  /** Mount a plugin under a profile row id. Activates now when its needs are met. */
  mount<C>(plugin: Plugin<C>, config: C, rowId: string): Fiber {
    this.assertLive(`mount plugin "${plugin.id}" (row "${rowId}")`);
    const record: FiberRecord = {
      rowId,
      pluginId: plugin.id,
      state: "pending",
      declares: plugin.declares,
      inject: [...(plugin.inject ?? [])],
      disposes: [],
      run: () => plugin.apply(this, config),
      handle: undefined as unknown as Fiber,
    };
    record.handle = {
      rowId,
      pluginId: plugin.id,
      get state() {
        return record.state;
      },
      dispose: () => this.disposeFiber(record),
    };
    this.fibers.push(record);
    if (record.inject.every((k) => this.services.has(k))) this.activate(record);
    return record.handle;
  }

  /** Run a fiber's apply with its own owner and dispose sink. */
  private activate(record: FiberRecord): void {
    const priorOwner = this.owner;
    const priorRow = this.ownerRow;
    const priorSink = this.sink;
    const priorCurrent = this.current;
    this.owner = record.pluginId;
    this.ownerRow = record.rowId;
    this.sink = record.disposes;
    this.current = record;
    record.state = "active";
    const parentWoken = this.activationStack[this.activationStack.length - 1];
    if (parentWoken) parentWoken.push(record);
    const woken: FiberRecord[] = [];
    this.activationStack.push(woken);
    let applied = false;
    try {
      record.run();
      applied = true;
    } catch (cause) {
      this.failUnwind(record, woken);
      throw new PluginFailedError(record.pluginId, record.rowId, cause);
    } finally {
      this.activationStack.pop();
      // A fiber this one woke is also a descendant of whatever woke this one, so
      // the completed list is spliced into the parent's rather than dropped. The
      // record itself went onto the parent's list first, so appending its woken
      // after it keeps the newest-first reversal honest: [.., B, C] unwinds C, B.
      if (applied && parentWoken) parentWoken.push(...woken);
      this.owner = priorOwner;
      this.ownerRow = priorRow;
      this.sink = priorSink;
      this.current = priorCurrent;
    }
  }

  /**
   * Undo a failed activation. A half-applied plugin still registered whatever it
   * got through before it threw, and a `provide` inside that apply may already
   * have woken consumers: those fibers are children of the failed activation, so
   * they go down with it, newest first. This is the context's own cleanup, not a
   * caller pulling a row out from under another, so it bypasses the dependent
   * guard the way `dispose()` does.
   */
  private failUnwind(record: FiberRecord, woken: FiberRecord[]): void {
    const priorUnwinding = this.unwinding;
    this.unwinding = true;
    try {
      for (let i = woken.length - 1; i >= 0; i--) this.disposeQuietly(woken[i]);
      this.disposeQuietly(record);
    } finally {
      this.unwinding = priorUnwinding;
    }
  }

  /** Unwind a fiber during failure cleanup: teardown noise is swallowed, nothing else is. */
  private disposeQuietly(record: FiberRecord): void {
    try {
      this.disposeFiber(record);
    } catch (err) {
      // Anything that is not teardown noise escapes the failure cleanup and
      // replaces the PluginFailedError the caller would otherwise see. Close to
      // unreachable today: the teardown loop wraps every throw in DisposeFailedError,
      // and the dependent pre-check cannot fire while failUnwind holds `unwinding`.
      if (!(err instanceof DisposeFailedError)) throw err;
    }
  }

  /**
   * The plugins of every active fiber, in mount order. Read by a producer gate:
   * what a mounted profile can execute is the mounted rows' own declarations,
   * never a capability list kept beside them.
   */
  mountedPlugins(): PluginDeclaration[] {
    return this.fibers
      .filter((f) => f.state === "active")
      .map((f) => (f.declares === undefined
        ? { id: f.pluginId, rowId: f.rowId }
        : { id: f.pluginId, rowId: f.rowId, declares: f.declares }));
  }

  /** Activate every pending fiber whose keys are now present, in mount order. */
  private wakePending(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const record of this.fibers) {
        if (record.state !== "pending") continue;
        if (!record.inject.every((k) => this.services.has(k))) continue;
        this.activate(record);
        progressed = true;
      }
    }
  }

  /**
   * Unwind one fiber's registrations in reverse. The dependent check runs first,
   * so a refusal leaves the fiber untouched; after it passes, every teardown on
   * the record runs even if one throws, and the failures surface together.
   */
  private disposeFiber(record: FiberRecord): void {
    if (record.state === "disposed") return;
    if (!this.unwinding) {
      for (const [key, holder] of this.services) {
        if (holder.fiber !== record) continue;
        const dependent = this.dependentOn(key, record);
        if (dependent) throw new DependentActiveError(key, dependent.pluginId);
      }
    }
    const causes: unknown[] = [];
    try {
      for (let i = record.disposes.length - 1; i >= 0; i--) {
        try {
          record.disposes[i]();
        } catch (err) {
          causes.push(err);
        }
      }
    } finally {
      record.disposes.length = 0;
      record.state = "disposed";
    }
    if (causes.length > 0) throw new DisposeFailedError(causes);
  }

  /** An active fiber other than `owner` that injects `key`, or undefined. */
  private dependentOn(key: string, owner: FiberRecord | undefined): FiberRecord | undefined {
    return this.fibers.find((f) => f !== owner && f.state === "active" && f.inject.includes(key));
  }

  /**
   * Close the tree. A fiber still pending after the last row is a tree that
   * would run half-mounted, which is a refusal, never a partial run.
   */
  finalize(): void {
    for (const record of this.fibers) {
      if (record.state !== "pending") continue;
      throw new UnmetDependencyError(
        record.pluginId,
        record.inject.filter((k) => !this.services.has(k)),
      );
    }
  }

  /**
   * Unwind every root registration in reverse order. Idempotent. A teardown
   * that throws does not strand the ones registered before it: the whole list
   * runs, then the collected failures surface as one DisposeFailedError.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unwinding = true;
    const causes: unknown[] = [];
    try {
      for (let i = this.fibers.length - 1; i >= 0; i--) {
        try {
          this.disposeFiber(this.fibers[i]);
        } catch (err) {
          if (err instanceof DisposeFailedError) causes.push(...err.causes);
          else causes.push(err);
        }
      }
      for (let i = this.rootDisposes.length - 1; i >= 0; i--) {
        try {
          this.rootDisposes[i]();
        } catch (err) {
          causes.push(err);
        }
      }
    } finally {
      this.rootDisposes.length = 0;
      this.unwinding = false;
    }
    if (causes.length > 0) throw new DisposeFailedError(causes);
  }

  /** Register a listener. Returns the dispose that removes it. */
  on<E extends EventName>(name: E, listener: Events[E], opts: { prepend?: boolean } = {}): Dispose {
    this.assertLive(`listen to event "${name}"`);
    const record: ListenerRecord = {
      fn: listener as unknown as (...args: any[]) => unknown,
      pluginId: this.owner,
      rowId: this.ownerRow,
    };
    const bucket = this.listeners.get(name) ?? [];
    if (opts.prepend === true) bucket.unshift(record);
    else bucket.push(record);
    this.listeners.set(name, bucket);
    let live = true;
    const undo: Dispose = () => {
      if (!live) return;
      live = false;
      const current = this.listeners.get(name);
      if (!current) return;
      const at = current.indexOf(record);
      if (at >= 0) current.splice(at, 1);
    };
    this.sink.push(undo);
    return undo;
  }

  /** Call one listener, blaming its plugin on a throw. */
  private callListener(record: ListenerRecord, args: unknown[]): unknown {
    try {
      return record.fn(...args);
    } catch (cause) {
      if (cause instanceof PluginFailedError) throw cause;
      throw new PluginFailedError(record.pluginId, record.rowId, cause);
    }
  }

  /**
   * Observe-only dispatch: nothing is returned. Listeners run in mount order
   * until one throws, and a throw aborts the rest, rethrown as
   * `PluginFailedError` blaming the plugin. A listener is not isolated from
   * the ones behind it.
   */
  emit<E extends EventName>(name: E, ...args: Events[E] extends (...a: infer A) => unknown ? A : never[]): void {
    for (const record of [...(this.listeners.get(name) ?? [])]) this.callListener(record, args);
  }

  /**
   * Around-middleware dispatch. Each listener gets the payload, the value so
   * far, and `next`. A listener that returns without calling `next` owns the
   * decision and the rest of the chain does not run.
   */
  waterfall<E extends EventName>(
    name: E,
    payload: WaterfallPayloadOf<Events[E]>,
    seed: WaterfallResultOf<Events[E]>,
  ): WaterfallResultOf<Events[E]> {
    const chain = [...(this.listeners.get(name) ?? [])];
    const step = (i: number, value: unknown): unknown => {
      if (i >= chain.length) return value;
      return this.callListener(chain[i], [payload, value, (nextValue: unknown) => step(i + 1, nextValue)]);
    };
    return step(0, seed) as WaterfallResultOf<Events[E]>;
  }

  /** First non-undefined result wins; later listeners do not run. */
  bail<E extends EventName>(name: E, ...args: Events[E] extends (...a: infer A) => unknown ? A : never[]): unknown {
    for (const record of [...(this.listeners.get(name) ?? [])]) {
      const out = this.callListener(record, args);
      if (out !== undefined) return out;
    }
    return undefined;
  }

  /** Refuse a registration on a context that has already unwound. */
  private assertLive(attempt: string): void {
    if (this.disposed) {
      throw new HarnessError(`context is disposed; cannot ${attempt} (a disposed context never unwinds again)`);
    }
  }
}
