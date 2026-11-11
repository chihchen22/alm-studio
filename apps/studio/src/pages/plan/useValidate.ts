// apps/studio/src/pages/plan/useValidate.ts
/**
 * The validate loop (Studio S2): after each edit, wait, then POST the plan to
 * /api/plans/validate. Only the newest answer paints. A 422 is a shape error
 * the banner shows; any other failure is "validation unavailable", never a pass.
 */
import { useEffect, useMemo, useState } from "react";
import { ApiError, validatePlan, type ValidateResponse } from "@alm/reader";
import type { PlanDoc } from "../../plan/planGraph";
import { reasonOf } from "../../errText";

export const STALE: unique symbol = Symbol("stale");

export function latestOnly<T>(): (p: Promise<T>) => Promise<T | typeof STALE> {
  let seq = 0;
  return (p) => {
    const mine = ++seq;
    return p.then((v) => (mine === seq ? v : STALE));
  };
}

export type ValidateState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; reply: ValidateResponse }
  | { state: "shape"; message: string }
  | { state: "unavailable"; message: string };

/** A failed validate call: a 422 is a shape error, anything else is "unavailable". Neither is a pass. */
export function classify(e: unknown): ValidateState {
  return e instanceof ApiError && e.status === 422
    ? { state: "shape", message: e.message }
    : { state: "unavailable", message: reasonOf(e) };
}

const IDLE: ValidateState = { state: "idle" };
const CHECKING: ValidateState = { state: "checking" };

/** The answer kept by the loop, with the plan object it validated. */
export interface KeptAnswer { plan: PlanDoc | null; v: ValidateState }

/** What the page shows: the kept answer only when it is for this exact plan object, else "checking". */
export function answerFor(plan: PlanDoc | null, kept: KeptAnswer): ValidateState {
  if (plan === null) return IDLE;
  return kept.plan === plan ? kept.v : CHECKING;
}

export function useValidate(plan: PlanDoc | null, delayMs = 300): ValidateState {
  // Each answer is kept with the plan object it validated, so an edit shows
  // "checking" on the very render that carries it, never the previous plan's gates.
  const [s, setS] = useState<KeptAnswer>({ plan: null, v: IDLE });
  const gate = useMemo(() => latestOnly<ValidateState>(), []);
  useEffect(() => {
    if (plan === null) return;
    const timer = setTimeout(() => {
      void gate(
        validatePlan(plan).then((reply): ValidateState => ({ state: "ok", reply }), classify),
      ).then((v) => { if (v !== STALE) setS({ plan, v }); });
    }, delayMs);
    return () => clearTimeout(timer);
  }, [plan, delayMs, gate]);
  return answerFor(plan, s);
}
