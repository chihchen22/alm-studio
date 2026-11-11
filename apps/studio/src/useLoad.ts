/** One async load per deps change. A superseded call's result is dropped; an error is carried, never swallowed. */
import { useEffect, useState } from "react";
import type { ApiError } from "@alm/reader";

export type LoadState<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "error"; error: ApiError | Error };

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): LoadState<T> {
  const [s, setS] = useState<LoadState<T>>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    setS({ state: "loading" });
    load().then(
      (value) => { if (!cancelled) setS({ state: "ok", value }); },
      (e: unknown) => { if (!cancelled) setS({ state: "error", error: e instanceof Error ? e : new Error(String(e)) }); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return s;
}

/**
 * useLoad that keeps showing the last value while a reload runs: a step that rereads
 * after its own write keeps its page, and the sentence that says what the write did, on screen instead of blanking.
 */
export function useKeptLoad<T>(load: () => Promise<T>, deps: unknown[]): LoadState<T> {
  const s = useLoad(load, deps);
  const [kept, setKept] = useState<LoadState<T>>({ state: "loading" });
  useEffect(() => {
    if (s.state !== "loading") setKept(s);
  }, [s]);
  return s.state === "loading" && kept.state === "ok" ? kept : s;
}
