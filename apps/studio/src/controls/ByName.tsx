/**
 * The typed name a workspace write carries as `by` (spec v3.1 Section 2.3: typed, never verified, the platform has no
 * sign-in). One field, remembered for the browser session so a second write does not ask again.
 */
import { useState } from "react";

const KEY = "studio.by";

/** The name last typed in this browser session; empty when none, or when storage is blocked. */
export function readBy(): string {
  try {
    return window.sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function writeBy(value: string): void {
  try {
    window.sessionStorage.setItem(KEY, value);
  } catch {
    // Storage blocked: the name stays in state for this page only.
  }
}

/** The typed name and its setter, remembered for the session. */
export function useBy(): [string, (v: string) => void] {
  const [by, setBy] = useState<string>(() => (typeof window === "undefined" ? "" : readBy()));
  return [by, (v: string) => { setBy(v); writeBy(v); }];
}

/** The field itself, props only. A write with no name is refused by the server, so the pages keep their button off until one is typed. */
export function ByField(props: { value: string; onChange(v: string): void; disabled?: boolean }) {
  return (
    <label className="field">
      <span className="field-label">Your name</span>
      <input className="input" aria-label="Your name" disabled={props.disabled} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      <span className="field-help">Typed and recorded with the change, never verified</span>
    </label>
  );
}
