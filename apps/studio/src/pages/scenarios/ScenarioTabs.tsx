// apps/studio/src/pages/scenarios/ScenarioTabs.tsx
/**
 * The visible tab bar of Run > Scenario library, and the visible way from Volatility surfaces to the volatility shock
 * page. The six pages existed behind `?tab=` addresses with no control that reached
 * them; these links are that control. Nothing here changes a page.
 */
import { hrefFor } from "../../router";

export const SCENARIO_TABS: ReadonlyArray<{ tab: string; label: string }> = [
  { tab: "rate", label: "Rate shock library" },
  { tab: "custom", label: "Custom rate shocks" },
  { tab: "behavioral", label: "Behavioral shocks" },
  { tab: "balance", label: "Balance shocks" },
  { tab: "basis", label: "Funding spread shocks" },
  { tab: "volatility", label: "Volatility shocks" },
];

export function ScenarioTabs(props: { ws: string; current: string }) {
  return (
    <nav className="tabs" aria-label="Scenario library pages">
      {SCENARIO_TABS.map((t) => (
        <a key={t.tab} className="tab" href={hrefFor({ ws: props.ws, section: "run", screen: "scenarios", query: t.tab === "rate" ? {} : { tab: t.tab } })} aria-selected={t.tab === props.current ? "true" : "false"}>
          {t.label}
        </a>
      ))}
    </nav>
  );
}

export function VolShockLink(props: { ws: string }) {
  return (
    <section className="card" aria-label="Change a surface">
      <div className="card-title">Change a surface</div>
      <p className="card-desc">Scale or shift the short-rate (cap) or long-yield (swaption) volatilities, at every expiry or one at a time. The result is saved as a market of its own; the snapshot stays as it is.</p>
      <p><a className="btn" href={hrefFor({ ws: props.ws, section: "run", screen: "scenarios", query: { tab: "volatility" } })}>Scale or shift a volatility surface</a></p>
    </section>
  );
}
