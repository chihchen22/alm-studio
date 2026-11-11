import type { ProvenanceRecord } from "@alm/engine";

/**
 * Optional display context beside the provenance record. Loosened for the
 * platform: the fixture archive passes its full GeneratedFrom manifest
 * (a structural superset), while the workbench passes whatever the run-detail
 * store recorded. Every field is optional; an absent field simply does not
 * render, it is never defaulted or invented.
 */
export interface ProvenanceContext {
  positionCount?: number;
  asOf?: string;
  portfolioLabel?: string;
}

/**
 * The governance surface: every field traces the run back to its inputs. All
 * values read verbatim from RunResult.provenance; the optional context adds
 * store-recorded portfolio metadata beside the portfolio id.
 */
export function ProvenancePanel({
  prov,
  gen,
  schemaVersion,
}: {
  prov: ProvenanceRecord;
  gen?: ProvenanceContext;
  schemaVersion: string;
}) {
  const modelKeys = Object.keys(prov.modelVersions).sort();
  const portfolioExtras: string[] = [];
  if (gen?.positionCount !== undefined) {
    portfolioExtras.push(`${gen.positionCount.toLocaleString("en-US")} positions`);
  }
  if (gen?.asOf !== undefined) portfolioExtras.push(`as of ${gen.asOf}`);
  return (
    <section className="panel">
      <h2>Provenance</h2>
      <p className="desc">
        Machine-readable record stamped with the run. Same inputsHash and seed reproduce byte-identical
        results (timestamps excepted).
      </p>
      <dl className="kv">
        <dt>Run id</dt>
        <dd>{prov.runId}</dd>
        <dt>Result schema</dt>
        <dd>{schemaVersion}</dd>
        <dt>Engine version</dt>
        <dd>{prov.engineVersion}</dd>
        <dt>Portfolio</dt>
        <dd>
          {prov.portfolioId}
          {gen?.portfolioLabel ? ` — ${gen.portfolioLabel}` : ""}
          {portfolioExtras.length > 0 ? ` (${portfolioExtras.join(", ")})` : ""}
        </dd>
        <dt>Inputs hash</dt>
        <dd>{prov.inputsHash}</dd>
        <dt>Seed</dt>
        <dd>{prov.seed}</dd>
        <dt>Kernel commit</dt>
        <dd>{prov.kernel.sourceCommit}</dd>
        <dt>Kernel manifest hash</dt>
        <dd>{prov.kernel.provenanceFileHash}</dd>
        <dt>Scenarios</dt>
        <dd>{prov.scenarioIds.join(", ")}</dd>
        <dt>Assumption sets</dt>
        <dd>
          {prov.assumptionSets.map((s) => `${s.id} (${s.hash.slice(0, 12)}...)`).join(", ")}
        </dd>
        <dt>Model versions</dt>
        <dd>{modelKeys.map((k) => `${k}=${prov.modelVersions[k]}`).join(", ")}</dd>
        <dt>Started</dt>
        <dd>{prov.timestamps.startedAt}</dd>
        <dt>Finished</dt>
        <dd>{prov.timestamps.finishedAt}</dd>
      </dl>
    </section>
  );
}
