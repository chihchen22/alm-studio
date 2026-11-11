// apps/studio/src/pages/scenarios/useShockPreview.ts
/**
 * The shock preview loop, after the validate loop: once the form has paused for 300 ms,
 * POST the spec with the plan's market snapshot to /api/scenarios/preview. Each
 * answer is kept with the key of the request it answers, and a key that differs
 * from the form's reads "checking", so an answer for an older form never
 * paints. The action is on only for an "ok" answer to the form as it stands.
 * Studio Polish 1: "checking" carries the last ok reply so the card keeps it
 * drawn (S1); an unavailable answer can be asked again for the same form (S2);
 * a reply the card cannot draw is unavailable, not ok (S3).
 */
import { useEffect, useMemo, useState } from "react";
import type { RateSpec } from "@alm/engine";
import { ApiError, previewRows, previewShock, type ShockPreview } from "@alm/reader";
import { errText, reasonOf } from "../../errText";
import { latestOnly, STALE } from "../plan/useValidate";

export type PreviewState =
  | { state: "idle" }
  | { state: "checking"; last?: ShockPreview }
  | { state: "ok"; reply: ShockPreview }
  | { state: "refused"; message: string }
  | { state: "unavailable"; message: string };

/** The request identity: the snapshot and the spec, serialized. Null when the form holds no spec to preview. */
export function previewKey(marketSnapshot: string, rateSpec: RateSpec | null): string | null {
  return rateSpec === null ? null : JSON.stringify([marketSnapshot, rateSpec]);
}

/**
 * A 4xx refusal as the page prints it: the server's text verbatim (P3 spec
 * Section 5.1 item 4), and, when the engine names a knot by its zero-based
 * path `rateSpec.shocks[N]`, the table row that knot is, since the table
 * numbers its rows from 1 (Studio Polish 1 S4). A label, not a figure.
 */
export function refusalText(message: string): string {
  const m = /rateSpec\.shocks\[(\d+)\]/.exec(message);
  return m === null ? message : `${message} (knot ${Number(m[1]) + 1} in the table)`;
}

/**
 * A failed preview: a 4xx is the server's refusal, shown verbatim; anything else is "unavailable". Neither enables the
 * action. The API's own refusals carry a JSON body, so a 4xx with none (code "http-error": a proxy, a rate limiter, a
 * wrong base path) is the platform failing, not a refusal of the shock, and can be asked again (final review I1).
 */
export function classifyPreview(e: unknown): PreviewState {
  return e instanceof ApiError && e.code !== "http-error" && e.status >= 400 && e.status < 500
    ? { state: "refused", message: refusalText(reasonOf(e)) }
    : { state: "unavailable", message: errText(e) };
}

/**
 * A served reply as a state: ok only when the card can draw every row (Polish 1 S3). A reply that cannot be drawn
 * says so in plain words; the reader's field-level reason is for a developer, not the page (Task 8 fix M3).
 */
export function toPreviewState(reply: ShockPreview): PreviewState {
  try {
    previewRows(reply);
  } catch {
    return { state: "unavailable", message: "The platform sent a preview with missing or unreadable values, so it cannot be drawn." };
  }
  return { state: "ok", reply };
}

/** The answer for `key`, and the last ok reply of any key before it. */
export interface KeptPreview { key: string | null; p: PreviewState; last?: ShockPreview }

const IDLE: PreviewState = { state: "idle" };
const CHECKING: PreviewState = { state: "checking" };

const lastOk = (k: KeptPreview): ShockPreview | undefined => (k.p.state === "ok" ? k.p.reply : k.last);

/** A new answer for `key`, carrying the last ok reply forward. */
export function keep(prev: KeptPreview, key: string, p: PreviewState): KeptPreview {
  const last = lastOk(prev);
  return last === undefined ? { key, p } : { key, p, last };
}

/** What the page shows: idle with no key; the kept answer only when it answers this key; else checking, with the last ok reply if there is one. */
export function previewFor(key: string | null, kept: KeptPreview): PreviewState {
  if (key === null) return IDLE;
  if (kept.key === key) return kept.p;
  const last = lastOk(kept);
  return last === undefined ? CHECKING : { state: "checking", last };
}

/** Check again: the kept answer no longer answers any key, so the form reads checking until the new request lands. */
export function retryPreview(kept: KeptPreview): KeptPreview {
  return { ...kept, key: null };
}

/** Spec Section 5.1 item 5: on only when the form passes its checks and the preview answers this form with "ok". */
export function actionEnabled(formOk: boolean, preview: PreviewState): boolean {
  return formOk && preview.state === "ok";
}

export function useShockPreview(marketSnapshot: string, rateSpec: RateSpec | null, delayMs = 300): { preview: PreviewState; retry(): void } {
  const key = previewKey(marketSnapshot, rateSpec);
  const [kept, setKept] = useState<KeptPreview>({ key: null, p: IDLE });
  // Bumped by Check again, so the same key is requested once more.
  const [attempt, setAttempt] = useState(0);
  const gate = useMemo(() => latestOnly<PreviewState>(), []);
  useEffect(() => {
    if (key === null || rateSpec === null) return;
    const timer = setTimeout(() => {
      void gate(previewShock(marketSnapshot, rateSpec).then(toPreviewState, classifyPreview))
        .then((p) => { if (p !== STALE) setKept((prev) => keep(prev, key, p)); });
    }, delayMs);
    return () => clearTimeout(timer);
    // The key carries the snapshot and the spec; the spec object is new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, delayMs, gate, attempt]);
  return {
    preview: previewFor(key, kept),
    retry: () => { setKept(retryPreview); setAttempt((n) => n + 1); },
  };
}
