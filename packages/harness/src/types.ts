/**
 * The kernel's open type surface. Every entry here is empty on purpose: a
 * consumer package adds its keys by declaration merging, so `ctx.get("curves")`
 * is typed at the call site and a wrong key is a compile error rather than a
 * run-time miss. The kernel itself never knows what a service is.
 */

/** Service shelf. Merged by consumers: `declare module "@alm/harness" { interface Services { curves: CurveService } }`. */
export interface Services {}

/** Every key the shelf can hold. Empty until a consumer merges into Services. */
export type ServiceKey = keyof Services & string;

/** Event table. Merged by consumers the same way Services is. */
export interface Events {}

/** Every event name the kernel can dispatch. */
export type EventName = keyof Events & string;

/** A reversible registration. Calling it twice is a no-op by contract. */
export type Dispose = () => void;

/** JSON a profile row can carry as config. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * A waterfall listener: it receives the payload, the value so far, and `next`.
 * Calling `next(value)` delegates to the rest of the chain and returns what the
 * chain produced; returning without calling `next` owns the decision.
 */
export type WaterfallListener<P, R> = (payload: P, value: R, next: (value: R) => R) => R;

/** The payload type of a merged waterfall event. */
export type WaterfallPayloadOf<L> = L extends (payload: infer P, value: any, next: any) => any ? P : never;

/** The carried value type of a merged waterfall event. */
export type WaterfallResultOf<L> = L extends (payload: any, value: infer R, next: any) => any ? R : never;
