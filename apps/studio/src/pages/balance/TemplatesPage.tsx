// apps/studio/src/pages/balance/TemplatesPage.tsx
/**
 * Balance Sheet > New-business templates: the reserved frame. A template is a set of instrument terms
 * created once, mapped to a chart of account node, with an allocation across several templates. That library is not
 * built; one product per family is, set on the Analysis path's New volume step. A family with no
 * product keeps the Flat basis's 60-month fixed bullet, and node targets are set on Strategy and targets.
 */
import { HarnessFrame } from "../../harness/HarnessFrame";
import { newBusinessInstances, newBusinessMethods } from "../../harness/instances";
import { screenHref } from "../../pageLinks";

export function TemplatesView(props: { ws: string }) {
  const { ws } = props;
  return (
    <>
      <section className="card" aria-label="About new-business templates">
        <div className="card-title">New-business templates</div>
        <p className="card-desc">One product per family is set on the Analysis path's New volume step: fixed or floating, how it repays, its term, the index it is priced off and its spread. A template library mapped to a chart of account node, with the node's new business allocated across several templates (for example half a 30-year fixed loan and half a 5/1 hybrid ARM), arrives in a later release.</p>
        <p className="card-desc">
          A family with no product keeps the Flat basis's 60-month fixed bullet at the par swap rate plus 0 bp, or a balance plan's own pricing per family or chart node on{" "}
          <a href={screenHref({ ws, section: "balance", screen: "strategy" })}>Strategy and targets</a>.
        </p>
      </section>
      <HarnessFrame module="new-business-template" instances={newBusinessInstances()} methods={newBusinessMethods()} selected={null} />
    </>
  );
}

export function TemplatesPage(props: { ws: string }) {
  return <TemplatesView ws={props.ws} />;
}
