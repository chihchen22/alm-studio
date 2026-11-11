// apps/studio/src/pages/run/RunPage.tsx
/**
 * Run route (Studio S3a). #/run lists stored plans and past runs;
 * #/run?plan=<id> opens the confirm sheet; #/run?run=<id> follows one run over
 * its event stream. A run always runs a stored plan through POST /api/plans/run.
 * Inside a workspace (a head is passed) that route would bypass the workspace's launch gate and lock, so no plan
 * launches here: the plan list says it is the whole store, an address naming a plan gets a notice pointing at Run >
 * Run setups, and past runs are the workspace's attached runs (final review M2).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { cancelRun, subscribeRunEvents, type RunPlanMeta, type WorkspaceManifest } from "@alm/reader";
import { errText } from "../../errText";
import { paint } from "../../plan/gatePaint";
import { screenHref } from "../../pageLinks";
import { confirmModel } from "../../run/confirm";
import { omitKeys, pastRunRows, progressHref, runPageMode } from "../../run/runList";
import { endOf, initialRunView, reduceRun, streamFailed, type RunView } from "../../run/runState";
import { useLoad } from "../../useLoad";
import { confirmFor, loadConfirm, loadRunPage, submitStoredPlan, type ConfirmAnswer, type SubmitOutcome } from "./runActions";
import { ConfirmView, PastRunsCard, PlansCard, ProgressView, QueueLaunchNotice } from "./RunViews";

/**
 * One run's view over its SSE stream. The server replays the whole log on
 * every connect and EventSource reconnects after a close, so the stream is
 * closed on the end event; the reducer restarts from a replayed queued status.
 */
export function useRunView(runId: string): RunView {
  const [view, setView] = useState<RunView>(() => initialRunView(runId));
  useEffect(() => {
    setView(initialRunView(runId));
    let close: () => void = () => {};
    close = subscribeRunEvents(runId, {
      onEvent: (e) => {
        setView((prev) => reduceRun(prev, e));
        if (endOf(e) !== null) close();
      },
      // A 404 (unknown run id) or a server that is down: say so rather than wait in silence.
      onError: () => setView((prev) => streamFailed(prev)),
    });
    return () => close();
  }, [runId]);
  return view;
}

function Progress(props: { ws: string; runId: string; query: Record<string, string>; endedAt: string | undefined; onEnd(): void }) {
  const view = useRunView(props.runId);
  const [cancelMsg, setCancelMsg] = useState<string | null>(null);
  const { onEnd } = props;
  useEffect(() => { if (view.end !== null) onEnd(); }, [view.end, onEnd]);
  const onCancel = () => {
    cancelRun(props.runId).then(
      () => setCancelMsg("Cancel sent; the status changes when the server confirms it."),
      (e: unknown) => setCancelMsg(errText(e)),
    );
  };
  return <ProgressView ws={props.ws} view={view} query={props.query} cancelMsg={cancelMsg} onCancel={onCancel} endedAt={props.endedAt} />;
}

function ConfirmSheet(props: { ws: string; planId: string; plans: RunPlanMeta[]; query: Record<string, string> }) {
  // The answer carries the plan id it was asked for; the sheet shows it only for that id.
  const load = useLoad(
    () => loadConfirm(props.planId, props.plans).then((data): ConfirmAnswer => ({ planId: props.planId, data })),
    [props.planId],
  );
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  const data = confirmFor(props.planId, load.state === "ok" ? load.value : null);
  if (data === null) return <div className="card muted">Checking plan {props.planId}</div>;
  const model = confirmModel(data.plan, data.seeded, data.v);
  const gates = paint(data.plan.stages.map((s) => s.id), data.v.state === "ok" ? data.v.reply : null).gates;
  const onRun = () => {
    setBusy(true);
    setOutcome(null);
    void submitStoredPlan(data.plan).then((o) => {
      // A reply that lands after the sheet closed or moved to another plan changes nothing on screen.
      if (!mounted.current) return;
      setBusy(false);
      if (o.kind === "submitted") window.location.hash = progressHref(props.ws, props.query, o.runId);
      else setOutcome(o);
    });
  };
  return (
    <ConfirmView
      model={model}
      v={data.v}
      gates={gates}
      busy={busy}
      outcome={outcome}
      closeHref={screenHref({ ws: props.ws, section: "run", screen: "queue" }, omitKeys(props.query, ["plan"]))}
      onRun={onRun}
    />
  );
}

/** `head` is passed inside a workspace (null when it could not be read); left out, the page is the old store-wide queue. */
export function RunPage(props: { ws: string; query: Record<string, string>; head?: WorkspaceManifest | null }) {
  const mode = runPageMode(props.query);
  const framed = props.head !== undefined;
  const [refresh, setRefresh] = useState(0);
  const bump = useCallback(() => setRefresh((n) => n + 1), []);
  const follow = mode.kind === "progress" ? mode.runId : undefined;
  const load = useLoad(() => loadRunPage(framed ? props.ws : undefined, follow), [refresh, framed, props.ws, follow]);
  return (
    <>
      {mode.kind === "progress" ? (
        // The page reloads when the stream ends (bump), so it then carries the stored endedAt, read off the run's
        // own record when the run is not in the workspace's list.
        <Progress key={mode.runId} ws={props.ws} runId={mode.runId} query={props.query} endedAt={load.state === "ok" ? load.value.endedAt : undefined} onEnd={bump} />
      ) : null}
      {load.state === "loading" ? <div className="card muted">Reading the plan store and the run list</div> : null}
      {load.state === "error" ? <div className="card" role="alert">{errText(load.error)}</div> : null}
      {mode.kind === "confirm" && framed ? <QueueLaunchNotice ws={props.ws} planId={mode.planId} /> : null}
      {load.state === "ok" && mode.kind === "confirm" && !framed ? <ConfirmSheet key={mode.planId} ws={props.ws} planId={mode.planId} plans={load.value.plans} query={props.query} /> : null}
      {load.state === "ok" ? (
        <>
          <PlansCard ws={props.ws} plans={load.value.plans} query={props.query} launch={!framed} />
          <PastRunsCard ws={props.ws} rows={pastRunRows(load.value.runs)} query={props.query} scoped={framed} />
        </>
      ) : null}
    </>
  );
}
