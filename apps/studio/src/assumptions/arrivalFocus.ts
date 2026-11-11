/**
 * Assumptions > Assumption sets, reached from Overview's Next step: the hash router has no in-page anchor, so the link
 * carries `focus=routing-policy` in the screen's query and the page brings the Routing policy card into view. Pure but
 * for the media query: the card hands in its elements, so a test hands in mocks.
 */

/** The `focus` query value of the routing-policy next step. */
export const ROUTING_POLICY_FOCUS = "routing-policy";

export interface Arrival {
  /** The screen query's `focus` value. */
  focus: string | undefined;
  /** False while the stored policies are read: the select is off until they arrive, so focus waits for them. */
  ready: boolean;
  /** Set once the card has been brought into view; the page keeps it, so a card remounted on the same visit does not move again. */
  done: { current: boolean };
}

export interface ArrivalTargets {
  card: { scrollIntoView(options: ScrollIntoViewOptions): void };
  select: { disabled: boolean; focus(options: FocusOptions): void };
  heading: { focus(options: FocusOptions): void };
}

/**
 * On the first ready render of an arrival with the routing-policy focus value: scroll the card to the top of the view
 * (smoothly unless reduced motion is asked for) and move focus to its select, or to its heading while the select is
 * off. Focus does not scroll a second time. True when it acted.
 */
export function focusOnArrival(arrival: Arrival, t: ArrivalTargets, reduceMotion: boolean): boolean {
  if (arrival.focus !== ROUTING_POLICY_FOCUS || !arrival.ready || arrival.done.current) return false;
  arrival.done.current = true;
  // "auto" is the instant jump: no stylesheet sets scroll-behavior.
  t.card.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  (t.select.disabled ? t.heading : t.select).focus({ preventScroll: true });
  return true;
}

/** The viewer's reduced-motion setting; false where there is no media query to ask. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
