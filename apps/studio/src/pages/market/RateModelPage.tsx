// apps/studio/src/pages/market/RateModelPage.tsx
/**
 * Market > Rate model: the harness page over the rate paths. Deterministic forwards are the default; Hull-White 1F and
 * BGM are mounted from a Studio constant (stochastic runs by request, base scenario only, not a
 * plan stage); SABR is a surface preview on Volatility surfaces. Beneath it the calibration action:
 * fit Hull-White or BGM on the workspace's snapshot, read the fit against its gate and save it.
 */
import { getPluginCatalog, getWorkspace, listRunSetups } from "@alm/reader";
import { CalibrationPanel } from "../analysis/CalibrationPanel";
import { errText } from "../../errText";
import { HarnessFrame } from "../../harness/HarnessFrame";
import { rateModelInstances, rateModelMethods, type CatalogLike, type HarnessInstanceView, type HarnessMethod } from "../../harness/instances";
import { screenHref } from "../../pageLinks";
import { hrefFor } from "../../router";
import { useLoad } from "../../useLoad";

export function RateModelView(props: { ws: string; instances: HarnessInstanceView[]; methods: HarnessMethod[]; selected: string | null; query?: Record<string, string> }) {
  const { ws } = props;
  return (
    <>
      <section className="card" aria-label="About the rate model">
        <div className="card-title">Rate model</div>
        <p className="card-desc">The rate model is the path a run projects rates along. Deterministic forwards read each scenario off the base curve. Hull-White 1F and BGM draw stochastic paths on the base scenario only: a stochastic run launches from the Analysis path (choose it on the Simulation step) or the API and names its model, Hull-White 1F when it names none. SABR is a surface preview on Volatility surfaces that no run reads. Below, fit a model and save the fit; the Analysis path's Calibration step chooses which saved fit a stochastic run uses.</p>
      </section>
      <HarnessFrame
        module="rate-model" instances={props.instances} methods={props.methods} selected={props.selected}
        hrefOf={(id) => screenHref({ ws, section: "market", screen: "rate-model" }, { ...(props.query ?? {}), instance: id })}
      />
    </>
  );
}

const NO_CATALOG: CatalogLike = { components: [], mounted: [] };

export function RateModelPage(props: { ws: string; query: Record<string, string> }) {
  const { ws, query } = props;
  const load = useLoad(async () => {
    const [catalog, setups, head] = await Promise.all([getPluginCatalog().catch(() => NO_CATALOG), listRunSetups(ws).catch(() => null), getWorkspace(ws).catch(() => null)]);
    return { catalog, marketId: head?.blocks.market.snapshot?.id ?? null, stochastic: setups === null ? [] : setups.setups.filter((s) => s.setup.eve.path === "stochastic").map((s) => s.slot.setupLineageId) };
  }, [ws]);
  if (load.state === "loading") return <div className="card muted">Reading the plugin catalog</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  return (
    <>
      <RateModelView
        ws={ws} query={query}
        instances={rateModelInstances({ stochasticSetups: load.value.stochastic })}
        methods={rateModelMethods(load.value.catalog, hrefFor({ ws, section: "market", screen: "vols" }))}
        selected={query.instance ?? null}
      />
      {/* Calibration as its own action; a guided analysis chooses which saved fit its run uses. */}
      <CalibrationPanel marketId={load.value.marketId} defaultModel="hull-white-1f" />
    </>
  );
}
