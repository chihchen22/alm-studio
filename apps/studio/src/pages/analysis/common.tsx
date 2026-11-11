// apps/studio/src/pages/analysis/common.tsx
/**
 * What every step of the guided Analysis path shares: the context the page hands each step, the one write
 * helper that saves the guided run setup, and the small pieces of view (a Details disclosure, a note, the busy state).
 * Developer detail (ids, routes, hashes, the server's own words) sits behind Details; numbers show in millions with one
 * decimal on screen and at full precision in every export.
 */
import { useEffect, useState, type ReactNode } from "react";
import { getDepositHistory, saveRunSetup, type GuidedRunRow, type ReadinessReport, type RunSetup, type WorkspaceManifest, type WorkspaceRunRow } from "@alm/reader";
import { errText } from "../../errText";
import { readBy } from "../../controls/ByName";
import { GUIDED_SLOT } from "../../guided/steps";
import { guidedSetupBody, nextVersion, withDepositHistory, type MaturingAnswer } from "../../guided/setup";
import { DEFAULT_BY } from "../../guided/start";
import type { StepId } from "../../router";

/** The label a stochastic run the guided Run step submits carries, for people only: runs are found by their link, never by it. */
export const STOCHASTIC_LABEL = "Guided stochastic run";

export interface StepContext {
  ws: string;
  head: WorkspaceManifest;
  readiness: ReadinessReport | null;
  /** The guided setup's current document; null until the New volume step creates it. */
  guided: RunSetup | null;
  /** The workspace's run rows, newest first. */
  runs: WorkspaceRunRow[];
  /** Stochastic runs the guided Run step linked to this workspace (by id), newest first. */
  stochastic: GuidedRunRow[];
  query: Record<string, string>;
  /** Reread the head, its readiness and the step's own loads after a write. */
  refresh: () => void;
  go: (step: StepId, query?: Record<string, string>) => void;
}

/** The name a guided write records: the session's typed name, else the plain default. */
export function byName(): string {
  const typed = typeof window === "undefined" ? "" : readBy().trim();
  return typed === "" ? DEFAULT_BY : typed;
}

/** The guided slot of the head, or null. */
export function guidedSlotOf(head: WorkspaceManifest): WorkspaceManifest["blocks"]["run"]["setups"][number] | null {
  return head.blocks.run.setups.find((s) => s.setupLineageId === GUIDED_SLOT) ?? null;
}

/** Save a new version of the guided setup, or create it from an answer when it does not exist yet. */
export async function saveGuided(ctx: Pick<StepContext, "ws" | "head" | "guided">, edit: (s: Omit<RunSetup, "id">) => Omit<RunSetup, "id">, create?: MaturingAnswer): Promise<RunSetup> {
  // A new analysis's deposits read the shipped public SOFR history when it covers the workspace date.
  const setup = ctx.guided === null
    ? (create === undefined ? null : edit(withDepositHistory(guidedSetupBody(create), await getDepositHistory(), ctx.head.cutoffDate)))
    : nextVersion(ctx.guided, edit);
  if (setup === null) throw new Error("Answer the New volume step's question first: that starts your analysis setup.");
  const reply = await saveRunSetup({ workspaceId: ctx.ws, setupLineageId: GUIDED_SLOT, expectedRevision: ctx.head.revision, by: byName(), setup });
  return reply.setup;
}

/** A busy flag and an error line around one async action. */
export function useAction(): { busy: boolean; error: string | null; done: string | null; run: (label: string, fn: () => Promise<string | void>) => void; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return {
    busy,
    error,
    done,
    clear: () => { setError(null); setDone(null); },
    run: (_label, fn) => {
      setBusy(true);
      setError(null);
      setDone(null);
      fn().then(
        (msg) => { setBusy(false); if (typeof msg === "string") setDone(msg); },
        (e: unknown) => { setBusy(false); setError(errText(e)); },
      );
    },
  };
}

export function ActionLines(props: { busy: boolean; busyText?: string; error: string | null; done: string | null }) {
  return (
    <>
      {props.busy ? <p className="guided-note" role="status">{props.busyText ?? "Working"}</p> : null}
      {props.error !== null ? <p className="guided-bad" role="alert">{props.error}</p> : null}
      {props.done !== null ? <p className="guided-ok" role="status">{props.done}</p> : null}
    </>
  );
}

/**
 * While a step holds edits that are not saved (L9), the browser asks before a reload or a close drops them, and the
 * step shows "Not saved yet" beside its save button.
 */
export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty || typeof window === "undefined") return;
    const onBefore = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, [dirty]);
}

/** Developer detail, folded away. */
export function Details(props: { summary?: string; children: ReactNode }) {
  return (
    <details className="guided-details">
      <summary>{props.summary ?? "Details"}</summary>
      {props.children}
    </details>
  );
}

/** A saved file the browser offers to the viewer, built in the page: a CSV of a table, a template. */
export function downloadText(name: string, text: string, type = "text/csv"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A linked run as the pickers read it. */
export function linkedRunText(r: GuidedRunRow): string {
  return runText({ runId: r.runId, label: r.status?.label, endedAt: r.status?.endedAt });
}

/** The label of a run for a picker: its label, or its id, and when it ended. */
export function runText(r: { runId: string; label?: string; endedAt?: string }): string {
  return `${r.label ?? r.runId}${r.endedAt === undefined ? "" : `, ${r.endedAt.slice(0, 16).replace("T", " ")}`}`;
}
