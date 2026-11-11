// apps/studio/src/pages/assumptions/AssumptionReasons.tsx
/**
 * Why the workspace's assumptions read Error or Warning, on the screen where the sets are: the readiness items of the assumptions section that are not fine, each in the server's own words, and the
 * way to fix it on the Analysis path. Before it the reason was only on Overview. Nothing renders when all is fine.
 */
import { getReadiness, type ReadinessItem } from "@alm/reader";
import { analysisHref } from "../../router";
import { useLoad } from "../../useLoad";

export function AssumptionReasonsView(props: { ws: string; items: ReadinessItem[] }) {
  const bad = props.items.filter((i) => i.section === "assumptions" && (i.state === "error" || i.state === "warning"));
  if (bad.length === 0) return null;
  return (
    <section className="card ws-notice" role="status" aria-label="Why the assumptions need attention">
      <div className="card-title">Why the assumptions need attention</div>
      <ul className="list">{bad.map((i) => <li key={i.item}>{`${i.item} (${i.state}): ${i.detail}`}</li>)}</ul>
      <p className="card-desc">The Analysis path's Behavior step writes a set from this workspace's own families: <a href={analysisHref(props.ws, "behavior")}>open the Behavior step</a>.</p>
    </section>
  );
}

export function AssumptionReasons(props: { ws: string }) {
  const load = useLoad(() => getReadiness(props.ws), [props.ws]);
  if (load.state !== "ok") return null;
  return <AssumptionReasonsView ws={props.ws} items={load.value.items} />;
}
